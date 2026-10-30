const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

// Each code-server window has its own extension host: every window writes state-<session>.json in
// DIR and claims open requests from DIR/requests by renaming them (only one rename wins).
const DIR = process.env.CODE_SERVER_MCP_DIR || path.join(process.env.HOME || "/config", ".code-server-mcp");
const REQUESTS = path.join(DIR, "requests");
const RESPONSES = path.join(DIR, "responses");
const session = vscode.env.sessionId.replace(/[^\w-]/g, "").slice(0, 40);
const stateFile = path.join(DIR, `state-${session}.json`);

const filePath = (uri) => (uri && (uri.scheme === "file" || uri.scheme === "vscode-remote") ? uri.path : null);

function tabInfo(tab) {
  const input = tab.input || {};
  const uri = input.uri || input.modified || input.notebookUri;
  const kind = input instanceof vscode.TabInputTextDiff ? "diff" : input instanceof vscode.TabInputTerminal ? "terminal" : input instanceof vscode.TabInputWebview ? "webview" : input instanceof vscode.TabInputNotebook ? "notebook" : uri ? "text" : "other";
  return { label: tab.label, path: filePath(uri), ...(uri && !filePath(uri) ? { uri: uri.toString() } : {}), kind, active: tab.isActive, dirty: tab.isDirty, pinned: tab.isPinned, preview: tab.isPreview };
}

function problems() {
  const items = [];
  let errors = 0;
  let warnings = 0;

  for (const [uri, diags] of vscode.languages.getDiagnostics()) {
    for (const d of diags) {
      if (d.severity === vscode.DiagnosticSeverity.Error) {
        errors++;
      } else if (d.severity === vscode.DiagnosticSeverity.Warning) {
        warnings++;
      } else {
        continue;
      }

      if (items.length < 150) {
        items.push({ path: filePath(uri) || uri.toString(), line: d.range.start.line + 1, severity: d.severity === 0 ? "error" : "warning", message: d.message.slice(0, 300), source: d.source || undefined });
      }
    }
  }

  return { errors, warnings, items };
}

function snapshot() {
  const ed = vscode.window.activeTextEditor;
  const sel = ed && ed.selection;
  return {
    session,
    version: 1,
    updatedAt: new Date().toISOString(),
    focused: vscode.window.state.focused,
    workspaceFolders: (vscode.workspace.workspaceFolders || []).map((f) => filePath(f.uri) || f.uri.toString()),
    activeEditor: ed
      ? {
          path: filePath(ed.document.uri),
          label: path.basename(ed.document.uri.path),
          languageId: ed.document.languageId,
          dirty: ed.document.isDirty,
          lineCount: ed.document.lineCount,
          cursor: { line: sel.active.line + 1, column: sel.active.character + 1 },
          ...(sel.isEmpty ? {} : { selection: { start: sel.start.line + 1, end: sel.end.line + 1, text: ed.document.getText(sel).slice(0, 4000) } }),
          visibleLines: ed.visibleRanges.map((r) => [r.start.line + 1, r.end.line + 1]),
        }
      : null,
    tabGroups: vscode.window.tabGroups.all.map((g) => ({ column: g.viewColumn, active: g.isActive, tabs: g.tabs.map(tabInfo) })),
    unsaved: vscode.workspace.textDocuments.filter((d) => d.isDirty).map((d) => filePath(d.uri) || d.uri.toString()),
    terminals: vscode.window.terminals.map((t) => t.name),
    problems: problems(),
  };
}

function writeState() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot(), null, 1));
    fs.renameSync(tmp, stateFile);
  } catch (e) {
    console.error("code-server-mcp companion: state write failed", e);
  }
}

let timer;
const schedule = (ms = 400) => {
  clearTimeout(timer);
  timer = setTimeout(writeState, ms);
};

async function handle(req) {
  if (req.action !== "open") {
    throw new Error(`Unknown action ${req.action}`);
  }

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(req.path));
  const line = Math.max(0, Math.min(doc.lineCount - 1, (req.line || 1) - 1));
  const endLine = req.end_line ? Math.max(line, Math.min(doc.lineCount - 1, req.end_line - 1)) : line;
  const range = new vscode.Range(line, 0, endLine, req.end_line ? doc.lineAt(endLine).text.length : 0);
  await vscode.window.showTextDocument(doc, { preview: req.preview !== false, selection: range, viewColumn: vscode.ViewColumn.Active });
  return { opened: req.path, line: line + 1 };
}

// Focused windows claim at once; others only after 2 s, so a request reaches the window being looked at.
async function poll() {
  let names;

  try {
    names = fs.readdirSync(REQUESTS).filter((n) => n.endsWith(".json"));
  } catch {
    return;
  }

  for (const n of names) {
    const src = path.join(REQUESTS, n);
    let age;

    try {
      age = Date.now() - fs.statSync(src).mtimeMs;
    } catch {
      continue;
    }

    if (!vscode.window.state.focused && age < 2000) {
      continue;
    }

    const claimed = `${src}.${session}`;

    try {
      fs.renameSync(src, claimed);
    } catch {
      continue; // another window was faster
    }

    let res;

    try {
      const req = JSON.parse(fs.readFileSync(claimed, "utf-8"));
      res = { id: req.id, ok: true, session, focused: vscode.window.state.focused, ...(await handle(req)) };
    } catch (e) {
      res = { id: n.replace(/\.json$/, ""), ok: false, session, error: String(e.message || e) };
    }

    try {
      fs.mkdirSync(RESPONSES, { recursive: true });
      fs.writeFileSync(path.join(RESPONSES, n), JSON.stringify(res));
      fs.unlinkSync(claimed);
    } catch (e) {
      console.error("code-server-mcp companion: response write failed", e);
    }
  }
}

function activate(context) {
  const w = vscode.window;
  const ws = vscode.workspace;
  const subs = [
    w.tabGroups.onDidChangeTabs(() => schedule()),
    w.tabGroups.onDidChangeTabGroups(() => schedule()),
    w.onDidChangeActiveTextEditor(() => schedule()),
    w.onDidChangeTextEditorSelection(() => schedule(1000)),
    w.onDidChangeWindowState(() => schedule()),
    w.onDidOpenTerminal(() => schedule()),
    w.onDidCloseTerminal(() => schedule()),
    vscode.languages.onDidChangeDiagnostics(() => schedule(1500)),
    ws.onDidSaveTextDocument(() => schedule()),
    ws.onDidChangeTextDocument((e) => e.document.isDirty && schedule(1500)),
    ws.onDidChangeWorkspaceFolders(() => schedule()),
  ];
  const heartbeat = setInterval(writeState, 15000);
  const poller = setInterval(() => poll().catch(() => {}), 1000);
  context.subscriptions.push(...subs, { dispose: () => (clearInterval(heartbeat), clearInterval(poller), clearTimeout(timer)) });
  writeState();
}

function deactivate() {
  try {
    fs.unlinkSync(stateFile);
  } catch {
    // already gone
  }
}

module.exports = { activate, deactivate };
