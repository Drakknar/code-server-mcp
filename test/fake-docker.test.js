// Test of code-server-mcp: fake /config + /projects trees and a fake Docker API, with the real MCP client.
// Run anywhere with Node 20+: node test/fake-docker.test.js (Windows: junctions instead of symlinks, no admin needed).
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");
const APP = process.env.APP || path.join(__dirname, "..");
const ROOT = path.join(os.tmpdir(), "code-server-mcp-test");
for (const j of ["projects/escape", "config/workspace/plink"]) try { fs.unlinkSync(path.join(ROOT, j)); } catch {} // junctions first (rmSync -r trips on them on Windows)
fs.rmSync(ROOT, { recursive: true, force: true });
const home = path.join(ROOT, "config");
const projects = path.join(ROOT, "projects");
const put = (base, p, c) => (fs.mkdirSync(path.dirname(path.join(base, p)), { recursive: true }), fs.writeFileSync(path.join(base, p), c));
const mk = (p, c) => put(home, p, c);
const pmk = (p, c) => put(projects, p, c);
pmk("proj/main.py", "def hello():\n    print('hi')\n\nhello()\n");
pmk("proj/node_modules/x/index.js", "secret_in_deps\n");
pmk("notes.md", "# Notes\nTODO one\nTODO two\n");
put(projects, "latin1.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])); // not UTF-8
const fifo = process.platform !== "win32" && !require("child_process").spawnSync("mkfifo", [path.join(projects, "proj/pipe")]).status;
mk("workspace/old.txt", "old workspace\n");
put(ROOT, "outside/secret.txt", "outside");
fs.symlinkSync(path.join(ROOT, "outside"), path.join(projects, "escape"), "junction");
fs.symlinkSync(path.join(projects, "proj"), path.join(home, "workspace/plink"), "junction");
mk(".ssh/id_rsa", "PRIVATE");
mk("data/User/settings.json", '{"a":1}');
mk("data/coder.json", '{"update":{"version":"4.141.0"}}');
mk("extensions/extensions.json", JSON.stringify([{ identifier: { id: "ms-python.python" }, version: "2026.4.0" }]));
mk(".code-server-mcp/state-abc.json", JSON.stringify({ session: "abc", updatedAt: new Date().toISOString(), focused: true, workspaceFolders: ["/projects"], activeEditor: { path: "/projects/notes.md", cursor: { line: 2, column: 1 }, selection: { start: 2, end: 2, text: "SELECTED_MARK" } }, tabGroups: [], unsaved: ["/projects/notes.md"], terminals: ["bash"], problems: { errors: 1, warnings: 0, items: [{ path: "/projects/proj/main.py", line: 2, severity: "error", message: "x" }] } }));
// Secrets the read-only token must not reach (READ_TOKEN_DENY_NAMES defaults)
for (const f of ["proj/.git-credentials", "proj/.netrc", "proj/app.db", "proj/.aws/credentials", "proj/.env", "proj/.env.example", "proj/certs/server.pem", "proj/.ssh/id_ed25519", "proj/repo/.git/config"]) pmk(f, "SECRET_MARK\n");
pmk("proj/.ssh/id_ed25519.pub", "ssh-ed25519 PUBLIC_MARK\n");
const fileLinks = process.platform !== "win32";
if (fileLinks) fs.symlinkSync(path.join(projects, "proj/.env"), path.join(projects, "proj/envlink"));
pmk("redos/a.txt", `${"a".repeat(40)}!\n`);
fs.utimesSync(path.join(ROOT, "outside"), new Date("2001-01-01"), new Date("2001-01-01"));

// Fake Docker
const frame = (s) => { const b = Buffer.from(s); const h = Buffer.alloc(8); h[0] = 1; h.writeUInt32BE(b.length, 4); return Buffer.concat([h, b]); };
let lastExec;
const dockerSrv = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const u = req.url;
    if (u.startsWith("/containers/code-server/json")) return res.end(JSON.stringify({ State: { Status: "running", Running: true, StartedAt: "2026-10-17T00:00:00Z" }, RestartCount: 0, Config: { Image: "lscr.io/linuxserver/code-server", Env: ["PUID=99", "DEFAULT_WORKSPACE=/projects"] } }));
    if (u.startsWith("/containers/code-server/stats")) return res.end(JSON.stringify({ cpu_stats: { cpu_usage: { total_usage: 2000 }, system_cpu_usage: 20000, online_cpus: 4 }, precpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 10000 }, memory_stats: { usage: 300 * 1048576, limit: 8192 * 1048576, stats: { inactive_file: 100 * 1048576 } }, pids_stats: { current: 42 } }));
    if (u.startsWith("/containers/code-server/logs")) return res.end(Buffer.concat([frame("2026-10-17T01:00:00Z \x1b[32m[info]\x1b[0m started\n"), frame("2026-10-17T01:00:01Z hello\n"), frame("2026-10-17T01:00:02Z PGPASSWORD fakelogvalue1\n")]));
    if (u === "/containers/code-server/exec") { lastExec = JSON.parse(body); res.statusCode = 201; return res.end(JSON.stringify({ Id: "e1" })); }
    if (u === "/exec/e1/start" && lastExec.Cmd.join(" ").includes("bigout")) { for (let i = 0; i < 300; i++) res.write(frame("line " + i + " " + "z".repeat(10000) + "\n")); return res.end(frame("LAST\n")); }
    if (u === "/exec/e1/start") return res.end(lastExec.Cmd.includes("--version") ? frame("4.141.0 abc123 with Code 1.105.0\n") : frame("ran: " + lastExec.Cmd.join(" ") + "\n"));
    if (u === "/exec/e1/json") return res.end(JSON.stringify({ ExitCode: 0 }));
    if (u.startsWith("/containers/code-server/restart")) { res.statusCode = 204; return res.end(); }
    res.statusCode = 404; res.end("nope " + u);
  });
});
const healthSrv = http.createServer((q, r) => r.end(JSON.stringify({ status: "alive", lastHeartbeat: Date.now() })));

(async () => {
  await new Promise((r) => dockerSrv.listen(0, r));
  await new Promise((r) => healthSrv.listen(0, r));
  Object.assign(process.env, {
    CODE_SERVER_MOUNT: home, DOCKER_HOST_URL: `http://127.0.0.1:${dockerSrv.address().port}`, HEALTH_URL: `http://127.0.0.1:${healthSrv.address().port}/healthz`,
    MCP_TOKEN: "full-tok", MCP_READ_TOKEN: "read-tok", BACKUP_DIR: path.join(ROOT, "backups"),
    EXTRA_ROOTS: `/projects=${projects}/,/missing=${path.join(ROOT, "not-mounted")},,=/x,relative=/y`, WORKSPACE_DIR: "/projects", WRITE_PATHS: "/projects,/config/workspace",
  });
  const { httpServer } = require(APP + "/server.js");
  await new Promise((r) => httpServer.listen(0, r));
  const url = new URL(`http://127.0.0.1:${httpServer.address().port}/mcp`);
  const { Client } = require(APP + "/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js");
  const { StreamableHTTPClientTransport } = require(APP + "/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/streamableHttp.js");
  const connect = async (tok) => { const c = new Client({ name: "t", version: "1" }); await c.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${tok}` } } })); return c; };
  const call = async (c, name, args = {}) => { const r = await c.callTool({ name, arguments: args }); return r.isError ? { ERR: r.content[0].text } : r.structuredContent; };

  // auth
  const bad = await fetch(url, { method: "POST", headers: { Authorization: "Bearer nope", "Content-Type": "application/json" }, body: "{}" });
  assert.strictEqual(bad.status, 401);
  const ro = await connect("read-tok");
  const roTools = (await ro.listTools()).tools.map((t) => t.name);
  assert(!roTools.includes("run_command") && roTools.includes("read_file"), roTools.join());
  const c = await connect("full-tok");
  console.log("tools:", (await c.listTools()).tools.map((t) => t.name).join(", "));

  const st = await call(c, "status");
  console.log("status:", JSON.stringify(st));
  assert.strictEqual(st.version.split(" ")[0], "4.141.0"); assert.strictEqual(st.update_available, false); assert(!st.latest_known_version);
  assert.strictEqual(st.default_workspace, "/projects"); assert.strictEqual(st.mcp_workspace, "/projects"); assert.strictEqual(st.resources.memory_mib, 200); assert.strictEqual(st.windows_open, 1);
  const lg = await call(c, "logs", { lines: 5 }); assert(lg.lines[0].includes("[info] started"), JSON.stringify(lg));
  assert(!JSON.stringify(lg).includes("fakelogvalue1"), "logs are filtered");

  const ls = await call(c, "list_files", { depth: 3 });
  const paths = ls.entries.map((e) => e.path);
  assert(paths.includes("/projects/proj/main.py") && !paths.some((p) => p.includes("node_modules/x")), paths.join());
  assert((await call(c, "read_file", { path: "proj/main.py", start_line: 2, end_line: 2 })).content === "    print('hi')");
  assert((await call(c, "read_file", { path: "/config/.ssh/id_rsa" })).ERR.includes("protected"));
  assert((await call(c, "read_file", { path: "../config/.ssh/id_rsa" })).ERR.includes("protected"));
  assert((await call(c, "read_file", { path: "/etc/passwd" })).ERR.includes("inside /projects"));
  assert((await call(c, "read_file", { path: "/projectsX/a" })).ERR.includes("must be inside"));
  assert((await call(c, "read_file", { path: "escape/secret.txt" })).ERR.includes("leads outside"), "junction out of /projects");
  assert((await call(c, "write_file", { path: "escape/new.txt", content: "x" })).ERR.includes("leads outside"));
  assert.strictEqual((await call(c, "read_file", { path: "/config/workspace/plink/main.py", start_line: 1, end_line: 1 })).content, "def hello():", "junction /config -> /projects resolves");
  assert((await call(c, "read_file", { path: "/missing/x" })).ERR.includes("leads outside"), "unmounted root");
  assert.strictEqual((await call(c, "read_file", { path: "/config/workspace/old.txt" })).content, "old workspace\n");
  assert((await call(c, "read_file", { path: "/config/data/User/settings.json" })).content === '{"a":1}');
  assert((await call(c, "read_file", { path: "/config/data/coder.json" })).ERR.includes("Not readable"));
  const sr = await call(c, "search_files", { query: "todo" }); assert.strictEqual(sr.matches, 2, JSON.stringify(sr));
  assert.strictEqual((await call(c, "search_files", { query: "secret_in_deps" })).matches, 0);
  assert.strictEqual((await call(c, "search_files", { query: "print", glob: "*.py" })).matches, 1);
  assert.strictEqual((await call(c, "search_files", { query: "pr.nt\\(", regex: true, glob: "proj/**/*.py" })).matches, 1);
  if (fifo) {
    assert((await call(c, "read_file", { path: "proj/pipe" })).ERR.includes("not a regular file"), "a FIFO must not block the server");
    assert.strictEqual((await call(c, "search_files", { query: "hello", path: "proj" })).matches, 2);
    assert((await call(c, "write_file", { path: "proj/pipe", content: "x" })).ERR.includes("not a regular file"));
  }

  // write / edit
  const w = await call(c, "write_file", { path: "new/dir/a.txt", content: "one\ntwo\n" }); assert(w.created && !w.backup, JSON.stringify(w)); assert(fs.existsSync(path.join(projects, "new/dir/a.txt")));
  assert((await call(c, "write_file", { path: "/config/workspace/b.txt", content: "b" })).created);
  assert((await call(c, "write_file", { path: "/config/data/User/settings.json", content: "x" })).ERR.includes("Not writable"));
  const e1 = await call(c, "edit_file", { path: "notes.md", old_string: "TODO", new_string: "DONE" }); assert(e1.ERR.includes("2 times"));
  const e2 = await call(c, "edit_file", { path: "notes.md", old_string: "TODO two", new_string: "DONE $& two" });
  assert(e2.backup && e2.warning && e2.first_line === 3, JSON.stringify(e2));
  assert.strictEqual(fs.readFileSync(path.join(projects, "notes.md"), "utf-8"), "# Notes\nTODO one\nDONE $& two\n");
  assert((await call(c, "edit_file", { path: "latin1.txt", old_string: "caf", new_string: "CAF" })).ERR.includes("not valid UTF-8"));
  assert.deepStrictEqual([...fs.readFileSync(path.join(projects, "latin1.txt"))], [0x63, 0x61, 0x66, 0xe9, 0x0a]);
  const parallel = await Promise.all([1, 2, 3].map((i) => call(c, "edit_file", { path: "new/dir/a.txt", old_string: "one", new_string: `one${i}`, replace_all: true })));
  const par = fs.readFileSync(path.join(projects, "new/dir/a.txt"), "utf-8");
  assert(/^one[123]{3}\ntwo\n$/.test(par) && new Set(par.slice(3, 6)).size === 3, par + JSON.stringify(parallel));

  // editors / commands / restart
  const oe = await call(c, "open_editors"); assert.strictEqual(oe.windows[0].problems.errors, 1);
  assert.strictEqual(oe.windows[0].activeEditor.selection.text, "SELECTED_MARK");
  const oeRo = await call(ro, "open_editors");
  assert.strictEqual(oeRo.windows[0].activeEditor.selection.end, 2);
  assert(!JSON.stringify(oeRo).includes("SELECTED_MARK"), "the read token doesn't see selected text");
  if (fileLinks) {
    put(ROOT, "outside/state.json", JSON.stringify({ session: "PLANTED_MARK", updatedAt: new Date().toISOString() }));
    fs.symlinkSync(path.join(ROOT, "outside/state.json"), path.join(home, ".code-server-mcp/state-planted.json"));
    assert(!JSON.stringify(await call(c, "open_editors")).includes("PLANTED_MARK"), "a planted state link isn't followed");
    fs.rmSync(path.join(home, ".code-server-mcp/state-planted.json"));
  }
  const rc = await call(c, "run_command", { command: "git status", timeout_seconds: 5 });
  assert(rc.output.includes("timeout -k 5 5 bash -c git status") && rc.cwd === "/projects" && lastExec.WorkingDir === "/projects", JSON.stringify(rc));
  assert.strictEqual(lastExec.User, "abc");
  const big = await call(c, "run_command", { command: "bigout" });
  assert(big.truncated && Buffer.byteLength(big.output) < 61000 && big.output.startsWith("line 0 ") && big.output.endsWith("LAST\n"), big.output.length);
  const plan = await call(c, "restart_code_server"); assert(plan.plan && plan.unsaved.length === 1, JSON.stringify(plan));
  assert.strictEqual((await call(c, "restart_code_server", { apply: true })).restarted, "code-server");
  assert((await call(ro, "run_command", { command: "id" })).ERR || true);
  // a link planted where the companion goes is replaced, its target left alone
  const plantedVsix = fileLinks && require(APP + "/lib/status.js").bundledVsix();
  if (plantedVsix) {
    put(ROOT, "outside/planted-target", "UNTOUCHED");
    fs.symlinkSync(path.join(ROOT, "outside/planted-target"), path.join(home, ".code-server-mcp", path.basename(plantedVsix)));
  }
  const inst = await call(c, "install_companion"); assert(inst.installed.endsWith(".vsix") && fs.existsSync(path.join(home, ".code-server-mcp", inst.installed)), JSON.stringify(inst));
  if (plantedVsix) {
    assert.strictEqual(fs.readFileSync(path.join(ROOT, "outside/planted-target"), "utf-8"), "UNTOUCHED");
    assert(!fs.lstatSync(path.join(home, ".code-server-mcp", inst.installed)).isSymbolicLink());
  }

  // open_in_editor: a fake companion answers
  const reqDir = path.join(home, ".code-server-mcp/requests");
  const fake = setInterval(() => { for (const n of fs.existsSync(reqDir) ? fs.readdirSync(reqDir) : []) { const q = JSON.parse(fs.readFileSync(path.join(reqDir, n))); fs.unlinkSync(path.join(reqDir, n)); fs.mkdirSync(path.join(home, ".code-server-mcp/responses"), { recursive: true }); fs.writeFileSync(path.join(home, ".code-server-mcp/responses", n), JSON.stringify({ id: q.id, ok: true, line: q.line, session: "abc", focused: true })); } }, 100);
  const op = await call(c, "open_in_editor", { path: "proj/main.py", line: 2 }); clearInterval(fake);
  assert.strictEqual(op.line, 2, JSON.stringify(op));

  // coder.json: older cached release = no update, newer = update
  mk("data/coder.json", '{"update":{"version":"4.140.9"},"query":{"folder":"/config/workspace"}}');
  const s2 = await call(c, "status"); assert(s2.update_available === false && s2.last_opened_folder === "/config/workspace", JSON.stringify(s2));
  mk("data/coder.json", '{"update":{"version":"4.141.10"}}');
  const s3 = await call(c, "status"); assert(s3.update_available === true && s3.latest_known_version === "4.141.10", JSON.stringify(s3));

  // read-only token: secrets by name are hidden, the full token keeps access
  const roErr = async (p) => ((await call(ro, "read_file", { path: p })).ERR || "").includes("read-only token");
  for (const p of ["proj/.git-credentials", "proj/.netrc", "proj/app.db", "proj/.aws/credentials", "proj/.env", "proj/.env.example", "proj/certs/server.pem", "proj/.ssh/id_ed25519", "proj/repo/.git/config", "/config/workspace/plink/.env"]) assert(await roErr(p), p);
  if (fileLinks) assert(await roErr("proj/envlink"), "a symlink to .env");
  assert.strictEqual((await call(ro, "read_file", { path: "proj/.ssh/id_ed25519.pub" })).content, "ssh-ed25519 PUBLIC_MARK\n");
  assert.strictEqual((await call(c, "read_file", { path: "proj/.env" })).content, "SECRET_MARK\n");
  const roLs = (await call(ro, "list_files", { path: "proj", depth: 3 })).entries.map((e) => e.path);
  assert(roLs.includes("/projects/proj/.ssh/id_ed25519.pub") && !roLs.some((p) => /\.env|\.pem|id_ed25519$/.test(p)), roLs.join());
  assert(!(await call(ro, "list_files", { path: "proj/repo/.git" })).entries.some((e) => e.path.endsWith("/config")));
  assert((await call(c, "list_files", { path: "proj", depth: 3 })).entries.some((e) => e.path === "/projects/proj/.env"));
  assert.strictEqual((await call(ro, "search_files", { query: "SECRET_MARK" })).matches, 0);
  assert.strictEqual((await call(ro, "search_files", { query: "PUBLIC_MARK" })).matches, 1);
  assert.strictEqual((await call(c, "search_files", { query: "SECRET_MARK", path: "proj" })).matches, 8); // .git is never searched, symlinks are skipped
  assert(((await call(ro, "open_in_editor", { path: "proj/.env" })).ERR || "").includes("read-only token"));
  const cfgOff = require("child_process").spawnSync(process.execPath, ["-e", `console.log(require(${JSON.stringify(APP + "/lib/config.js")}).config.readTokenDenyNames.length)`], { env: { ...process.env, READ_TOKEN_DENY_NAMES: "" } });
  assert.strictEqual(String(cfgOff.stdout).trim(), "0", "an empty READ_TOKEN_DENY_NAMES turns the list off");

  // regex search: a catastrophically backtracking pattern fails fast; the budget counts only matching time
  const t0 = Date.now();
  const redos = await call(c, "search_files", { query: "(a+)+$", regex: true, path: "redos" });
  assert(redos.ERR && redos.ERR.includes("took more than") && Date.now() - t0 < 10000, JSON.stringify(redos));
  const { regexMatcher } = require(APP + "/lib/files.js");
  const findAll = regexMatcher(/a.*z/i, 300);
  assert.deepStrictEqual(findAll(["abz", "nope"]), [0]);
  await new Promise((r) => setTimeout(r, 400));
  assert.deepStrictEqual(findAll(["xaz"]), [0], "waiting between files doesn't use up the budget");

  // read_file past the end / inverted range
  assert((await call(c, "read_file", { path: "proj/main.py", start_line: 100 })).ERR.includes("past the end"));
  assert((await call(c, "read_file", { path: "proj/main.py", start_line: 3, end_line: 2 })).ERR.includes("before start_line"));

  // list_files: a symlink shows its own date, not its target's (outside the roots)
  const esc = (await call(c, "list_files", { depth: 1 })).entries.find((e) => e.path === "/projects/escape");
  assert(esc && esc.type === "symlink" && esc.size === undefined && !esc.modified.startsWith("2001"), JSON.stringify(esc));

  // one lock per real file: two names of the same file share it
  const filesLib = require(APP + "/lib/files.js");
  assert.strictEqual(filesLib.lockKey("/config/workspace/plink/main.py"), filesLib.lockKey("/projects/proj/main.py"));

  // companion answers that came too late are pruned
  const resDir = path.join(home, ".code-server-mcp/responses");
  fs.mkdirSync(resDir, { recursive: true });
  fs.writeFileSync(path.join(resDir, "late.json"), "{}");
  fs.writeFileSync(path.join(resDir, "fresh.json"), "{}");
  const hourAgo = new Date(Date.now() - 3600000);
  fs.utimesSync(path.join(resDir, "late.json"), hourAgo, hourAgo);
  await call(c, "open_editors");
  assert(!fs.existsSync(path.join(resDir, "late.json")) && fs.existsSync(path.join(resDir, "fresh.json")));

  // companion version: numeric compare
  const vsixDir = path.join(ROOT, "vsix");
  for (const v of ["0.9.0", "0.10.0", "0.2.5"]) put(vsixDir, `c-${v}.vsix`, "x");
  assert.strictEqual(path.basename(require(APP + "/lib/status.js").bundledVsix(vsixDir)), "c-0.10.0.vsix");

  // backups older than BACKUP_KEEP_DAYS (30) are removed, by the time in the folder name; other folders stay
  const bdir = path.join(ROOT, "backups");
  const stamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, "-");
  const later = Date.now() + 2 * 3600000; // past the once-an-hour limit
  const oldB = stamp(later - 40 * 86400000), newB = stamp(later - 86400000);
  for (const d of [oldB, newB, "keep-me"]) put(bdir, `${d}/projects/x.txt`, "x");
  assert.deepStrictEqual(filesLib.pruneBackups(later), [oldB]);
  assert(fs.existsSync(path.join(bdir, newB)) && fs.existsSync(path.join(bdir, "keep-me")) && !fs.existsSync(path.join(bdir, oldB)));
  assert.deepStrictEqual(filesLib.pruneBackups(later + 1000), [], "at most once an hour");

  console.log("ALL OK");
  process.exit(0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
