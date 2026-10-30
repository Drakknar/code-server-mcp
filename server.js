const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { config, StepError } = require("./lib/config");
const docker = require("./lib/docker");
const files = require("./lib/files");
const editors = require("./lib/editors");
const status = require("./lib/status");

const INFO = { name: "code-server", version: "0.3.1" };
const MAX_BODY_BYTES = 32 * 1024 * 1024;

// MCP_TOKEN = every tool; MCP_READ_TOKEN (optional) = read-only tools. No MCP_TOKEN = everything refused,
// because run_command is a shell in the code-server container.
function access(header) {
  const got = crypto.createHash("sha256").update(String(header || "")).digest();
  const is = (token) => token && crypto.timingSafeEqual(crypto.createHash("sha256").update(`Bearer ${token}`).digest(), got);

  if (!config.mcpToken) {
    return null;
  }

  return is(config.mcpToken) ? "full" : is(config.mcpReadToken) ? "read" : null;
}

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function wrap(fn) {
  return async (args) => {
    try {
      return ok(await fn(args || {}));
    } catch (e) {
      if (!(e instanceof StepError)) {
        console.error(e);
      }

      return { content: [{ type: "text", text: e instanceof StepError || e.code ? e.message : "Unexpected error (see the MCP container log)" }], isError: true };
    }
  };
}

function clip(text, max) {
  if (Buffer.byteLength(text) <= max) {
    return { text, truncated: false };
  }

  const half = Math.floor(max / 2);
  const head = files.cutBytes(text, half);
  const tail = files.cutBytes(text, half, true);
  const cut = Buffer.byteLength(text) - Buffer.byteLength(head) - Buffer.byteLength(tail);
  return { text: `${head}\n\n… [${cut} bytes cut] …\n\n${tail}`, truncated: true };
}

function warnUnsaved(result) {
  return editors.unsaved().has(result.path)
    ? { ...result, warning: "This file has unsaved changes in an open code-server editor: the editor will show a conflict when the user saves. Tell the user." }
    : result;
}

async function runCommand({ command, cwd, timeout_seconds = 60 }) {
  const dir = cwd ? files.containerPath(cwd) : config.workspaceDir;
  const t = Math.max(1, Math.min(600, timeout_seconds));
  const started = Date.now();
  const r = await docker.exec(["timeout", "-k", "5", String(t), "bash", "-c", command], {
    user: config.execUser,
    workdir: dir,
    env: [`HOME=${config.homeDir}`, "TERM=dumb"],
    timeoutMs: (t + 15) * 1000,
    maxBytes: Math.floor(config.maxOutputBytes / 2), // only head + tail are kept while the command runs
  });
  const out = r.truncated ? { text: r.output, truncated: true } : clip(r.output, config.maxOutputBytes);
  return {
    exit_code: r.exitCode,
    ...(r.exitCode === 124 || r.exitCode === 137 ? { timed_out: true } : {}),
    cwd: dir,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    output: out.text,
    ...(out.truncated ? { truncated: true } : {}),
  };
}

async function installCompanion() {
  const vsix = status.bundledVsix();

  if (!vsix) {
    throw new StepError("No .vsix in /app/companion: build it first (companion/build.ps1)");
  }

  const target = `${config.companionDir}/${path.basename(vsix)}`;
  files.mkdirs(files.toLocal(config.companionDir));
  fs.copyFileSync(vsix, files.toLocal(target));
  files.chown(files.toLocal(target));
  const r = await docker.exec(
    [config.codeServerBin, "--user-data-dir", `${config.homeDir}/data`, "--extensions-dir", `${config.homeDir}/extensions`, "--install-extension", target, "--force"],
    { user: config.execUser, env: [`HOME=${config.homeDir}`], timeoutMs: 120000 },
  );

  if (r.exitCode !== 0) {
    throw new StepError(`Install failed (${r.exitCode}): ${r.output.trim().slice(-800)}`);
  }

  return { installed: path.basename(vsix), output: r.output.trim().slice(-800), next: "Open windows pick it up after a reload (F1 → Developer: Reload Window) or a new tab." };
}

const pathArg = (what) => z.string().describe(`${what}: absolute as code-server sees it (under ${files.rootNames}) or relative to the workspace (${config.workspaceDir})`);

function registerTools(server, level) {
  const read = { readOnlyHint: true };
  // The read-only token can't reach READ_TOKEN_DENY_NAMES (.env, keys, .git/config…).
  const opts = { hideSecrets: level !== "full" };

  server.registerTool(
    "status",
    {
      title: "code-server status",
      description: "State of the code-server (VS Code in the browser) container: running/started, version and whether an update is known, web health (alive = a browser is connected, expired = idle), CPU/RAM, open browser windows and installed extensions.",
      annotations: read,
    },
    wrap(() => status.status()),
  );

  server.registerTool(
    "logs",
    {
      title: "code-server container log",
      description: "Last lines of the code-server container log (start-up, extension host errors, crashes).",
      inputSchema: { lines: z.number().int().min(1).max(2000).optional().describe("Lines from the end (default 100)"), since_minutes: z.number().positive().optional().describe("Only lines from the last N minutes") },
      annotations: read,
    },
    wrap((a) => status.logs(a)),
  );

  server.registerTool(
    "open_editors",
    {
      title: "Open editors in code-server",
      description: "What the user has open in code-server right now, per browser window: workspace folders, tabs (path, active, unsaved, pinned), the active file with cursor line and selected text, unsaved files, terminals and the Problems list (errors/warnings). Needs the companion extension (install_companion).",
      inputSchema: { include_problems: z.boolean().optional().describe("Include each problem, not only the counts (default true)"), include_stale: z.boolean().optional().describe("Also windows that closed, with their last state") },
      annotations: read,
    },
    wrap((a) => editors.openEditors(a)),
  );

  server.registerTool(
    "list_files",
    {
      title: "List workspace files",
      description: "List files and folders (type, size, modified) under a path in the code-server workspace. .git, node_modules and similar folders are shown but not entered.",
      inputSchema: { path: pathArg("Folder").optional(), depth: z.number().int().min(1).max(8).optional().describe("Folder levels (default 2)"), show_hidden: z.boolean().optional(), max_entries: z.number().int().min(1).max(5000).optional() },
      annotations: read,
    },
    wrap((a) => files.listFiles(a, opts)),
  );

  server.registerTool(
    "read_file",
    {
      title: "Read a file",
      description: "Read a text file from the code-server workspace, whole or a line range. Long files are cut; the result says where to continue.",
      inputSchema: { path: pathArg("File"), start_line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional(), line_numbers: z.boolean().optional().describe("Prefix each line with its number") },
      annotations: read,
    },
    wrap((a) => files.readFile(a, opts)),
  );

  server.registerTool(
    "search_files",
    {
      title: "Search in files",
      description: "Search text (or a regex) in the files under a path in the workspace; returns file, line and the matching line. Skips binary files, .git and node_modules.",
      inputSchema: {
        query: z.string().min(1),
        path: pathArg("Folder or file to search").optional(),
        regex: z.boolean().optional().describe("query is a JavaScript regex"),
        case_sensitive: z.boolean().optional(),
        glob: z.string().optional().describe("Only files matching, e.g. *.py or src/**/*.ts"),
        max_results: z.number().int().min(1).max(1000).optional(),
      },
      annotations: read,
    },
    wrap((a) => files.searchFiles(a, opts)),
  );

  server.registerTool(
    "open_in_editor",
    {
      title: "Show a file in code-server",
      description: "Open a file in the user's code-server window (the focused one), scrolled to a line or with a line range selected, so the user sees what you are talking about. Changes nothing on disk.",
      inputSchema: { path: pathArg("File"), line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional().describe("Select line..end_line"), preview: z.boolean().optional().describe("Preview tab (replaced by the next one), default true") },
    },
    wrap((a) => editors.openInEditor(a, opts)),
  );

  if (level !== "full") {
    return;
  }

  server.registerTool(
    "write_file",
    {
      title: "Write a file",
      description: "Create a file or replace its whole content in the code-server workspace (missing folders are created). The previous version is backed up. For a change inside an existing file prefer edit_file.",
      inputSchema: { path: pathArg("File"), content: z.string(), create_dirs: z.boolean().optional().describe("Create missing folders (default true)") },
      annotations: { destructiveHint: true },
    },
    wrap(async (a) => warnUnsaved(await files.writeFile(a))),
  );

  server.registerTool(
    "edit_file",
    {
      title: "Edit a file",
      description: "Replace an exact piece of text in a workspace file (read it first and copy old_string exactly, whitespace included; it must be unique unless replace_all). The previous version is backed up.",
      inputSchema: { path: pathArg("File"), old_string: z.string().min(1), new_string: z.string(), replace_all: z.boolean().optional() },
      annotations: { destructiveHint: true },
    },
    wrap(async (a) => warnUnsaved(await files.editFile(a))),
  );

  server.registerTool(
    "run_command",
    {
      title: "Run a shell command",
      description:
        `Run a bash command inside the code-server container as its normal user (same environment as the code-server terminal: git, python, the workspace at ${config.workspaceDir}). Returns exit code and combined output. Use it for git, builds, tests, package installs and file moves/deletes. Before anything destructive or hard to undo (rm -r, git reset/push --force, overwriting many files) say what you will run and wait for the user's OK. Not interactive: commands that wait for input hang until the timeout.`,
      inputSchema: {
        command: z.string().min(1),
        cwd: z.string().optional().describe(`Working folder (default ${config.workspaceDir})`),
        timeout_seconds: z.number().int().min(1).max(600).optional().describe("Kill after N seconds (default 60)"),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    wrap((a) => runCommand(a)),
  );

  server.registerTool(
    "restart_code_server",
    {
      title: "Restart code-server",
      description: "Restart the code-server container (open browser tabs reconnect, terminals and unsaved-but-not-hot-exited work may be lost). Without apply: true it only reports what is open; ask the user, then call again with apply: true.",
      inputSchema: { apply: z.boolean().optional() },
      annotations: { destructiveHint: true },
    },
    wrap(async ({ apply }) => {
      const open = editors.openEditors({ include_problems: false }).windows;

      if (!apply) {
        return {
          plan: `restart container ${config.container}`,
          open_windows: open.length,
          unsaved: [...new Set(open.flatMap((w) => w.unsaved || []))],
          terminals: open.flatMap((w) => w.terminals || []),
          next: "Confirm with the user, then call again with apply: true",
        };
      }

      await docker.restart();
      return { restarted: config.container };
    }),
  );

  server.registerTool(
    "install_companion",
    {
      title: "Install the companion extension",
      description: "Install (or update) the small companion extension in code-server that open_editors and open_in_editor need. Afterwards the user reloads the code-server tab.",
      annotations: { idempotentHint: true },
    },
    wrap(() => installCompanion()),
  );
}

function send(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const httpServer = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0].replace(/\/+$/, "") || "/";

  if (url === "/health") {
    return send(res, 200, { ok: true });
  }

  if (url !== "/mcp" && url !== "/") {
    return send(res, 404, { error: "not found" });
  }

  const level = access(req.headers.authorization);

  if (!level) {
    return send(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  }

  // Collect Buffers (not strings) so multi-byte characters split across chunks stay intact.
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > MAX_BODY_BYTES) {
      res.setHeader("Connection", "close"); // the rest of the body is not read
      return send(res, 413, { jsonrpc: "2.0", error: { code: -32600, message: "Request body too large" }, id: null });
    }

    chunks.push(chunk);
  }

  let body;

  try {
    body = size ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : undefined;
  } catch {
    return send(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  }

  // Stateless Streamable HTTP: a fresh server and transport per request.
  const server = new McpServer(INFO);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    registerTools(server, level);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    console.error(e);

    if (!res.headersSent) {
      send(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

if (require.main === module) {
  httpServer.listen(config.port, () => {
    console.log(`${INFO.name} MCP ${INFO.version} on :${config.port}/mcp; container ${config.container}, roots ${files.rootNames}, workspace ${config.workspaceDir}, writable ${config.writePaths.join(", ")}`);

    if (!config.mcpToken) {
      console.log("MCP_TOKEN is not set: every /mcp request is refused (401).");
    }

    for (const msg of config.invalid) {
      console.log(msg);
    }

    for (const r of config.extraRoots) {
      if (!fs.existsSync(r.local)) {
        console.log(`EXTRA_ROOTS: ${r.path} is not mounted at ${r.local}: its files can't be reached.`);
      }
    }

    try {
      files.containerPath(config.workspaceDir);
    } catch {
      console.log(`WORKSPACE_DIR ${config.workspaceDir} is outside ${files.rootNames}: relative paths will be refused.`);
    }
  });
}

module.exports = { registerTools, httpServer, runCommand };
