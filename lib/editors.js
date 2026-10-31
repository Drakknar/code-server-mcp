const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { config, StepError } = require("./config");
const files = require("./files");

// The companion extension (companion/) writes one state file per open code-server window.
const LIVE_MS = 45000;
const dir = () => files.toLocal(config.companionDir);

function windows() {
  let names = [];

  try {
    names = fs.readdirSync(dir()).filter((n) => /^state-[\w-]+\.json$/.test(n));
  } catch {
    return [];
  }

  const out = [];

  for (const n of names) {
    try {
      const s = JSON.parse(files.readNoFollow(path.join(dir(), n)));
      const age = Date.now() - Date.parse(s.updatedAt);
      out.push({ ...s, file: n, live: age < LIVE_MS, ageSeconds: Math.round(age / 1000) });
    } catch {
      // being rewritten or corrupt: skip
    }
  }

  return out.sort((a, b) => Number(b.live) - Number(a.live) || Number(b.focused) - Number(a.focused) || a.ageSeconds - b.ageSeconds);
}

const RESPONSE_MAX_AGE_MS = 600000;

// Stale files of closed windows (no deactivate when the browser tab just closes) are removed after a day, and
// answers that came after openInEditor stopped waiting (8 s) after 10 minutes.
function prune(list, now = Date.now()) {
  for (const w of list) {
    if (w.ageSeconds > 86400) {
      fs.rmSync(path.join(dir(), w.file), { force: true });
    }
  }

  const resDir = path.join(dir(), "responses");
  let names = [];

  try {
    names = fs.readdirSync(resDir);
  } catch {
    return;
  }

  for (const n of names) {
    try {
      const f = path.join(resDir, n);

      if (now - fs.lstatSync(f).mtimeMs > RESPONSE_MAX_AGE_MS) {
        fs.rmSync(f, { force: true });
      }
    } catch {
      // removed meanwhile
    }
  }
}

// The selection can be anything the user highlights, secrets too: only the full token sees its text.
function withoutSelectionText(w) {
  if (!w.activeEditor?.selection) {
    return w;
  }

  const { text, ...selection } = w.activeEditor.selection;
  return { ...w, activeEditor: { ...w.activeEditor, selection } };
}

function openEditors({ include_problems = true, include_stale = false } = {}, { selectionText = true } = {}) {
  const all = windows();
  prune(all);
  const list = all.filter((w) => w.live || include_stale);

  if (!list.length) {
    return {
      windows: [],
      note: all.length
        ? "No code-server window is open right now (the last one closed or went to sleep). Use include_stale for its last state."
        : "No state from the companion extension: open code-server in a browser, and if it still stays empty run install_companion.",
    };
  }

  return {
    windows: list.map((w) => {
      const { version, file, problems: raw, ...rest } = selectionText ? w : withoutSelectionText(w);
      const problems = raw || { errors: 0, warnings: 0, items: [] };
      return { ...rest, problems: include_problems ? problems : { errors: problems.errors, warnings: problems.warnings } };
    }),
  };
}

// Paths with unsaved changes in an open window: writing them would conflict with the editor.
function unsaved() {
  return new Set(windows().filter((w) => w.live).flatMap((w) => w.unsaved || []));
}

async function openInEditor({ path: input, line, end_line, preview = true }, opts = {}) {
  const { path: p, local } = files.readable(input, opts);

  if (!fs.existsSync(local) || !fs.statSync(local).isFile()) {
    throw new StepError(`Not a file: ${p}`);
  }

  const wins = windows();
  prune(wins);

  if (!wins.some((w) => w.live)) {
    throw new StepError("No code-server window is open (or the companion extension isn't installed): nothing can show the file");
  }

  const id = crypto.randomUUID();
  const reqDir = path.join(dir(), "requests");
  const resFile = path.join(dir(), "responses", `${id}.json`);
  files.mkdirs(reqDir);
  const reqFile = path.join(reqDir, `${id}.json`);
  // Written under another name and renamed, so the companion never claims a half-written request.
  const tmp = `${reqFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ id, action: "open", path: p, line, end_line, preview }));
  files.chown(tmp);
  fs.renameSync(tmp, reqFile);

  for (let waited = 0; waited < 8000; waited += 250) {
    await new Promise((r) => setTimeout(r, 250));
    let res;

    try {
      res = JSON.parse(files.readNoFollow(resFile));
    } catch {
      continue; // not there yet, or still being written
    }

    fs.rmSync(resFile, { force: true });

    if (!res.ok) {
      throw new StepError(`code-server could not open ${p}: ${res.error}`);
    }

    return { opened: p, line: res.line, window: res.session, focused_window: res.focused };
  }

  fs.rmSync(reqFile, { force: true });
  throw new StepError("No window answered within 8 s (browser tab asleep or companion not running)");
}

module.exports = { openEditors, unsaved, openInEditor, windows, prune };
