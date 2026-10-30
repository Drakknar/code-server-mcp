const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { config, StepError } = require("./config");

// Paths are given as code-server sees them (/config/..., /projects/...) or relative to the workspace; this
// container reaches /config at config.mountDir and each extra root at its local path.
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", ".cache", ".npm", ".mypy_cache", ".pytest_cache"]);

const MAX_FILE_BYTES = 50 * 1048576; // read_file / edit_file
const MAX_SEARCH_FILE_BYTES = 2000000;
const MAX_SCANNED = 20000;
// Matching time a regex search may use in total (reading files doesn't count): a catastrophically backtracking
// pattern can't freeze the server.
const REGEX_BUDGET_MS = 3000;

const within = (p, root) => p === root || p.startsWith(root + "/");

// Longest first, so a root nested in another one wins.
const ROOTS = [{ path: config.homeDir, local: config.mountDir }, ...config.extraRoots].sort((a, b) => b.path.length - a.path.length);
const rootNames = ROOTS.map((r) => r.path).join(", ");
const rootOf = (p) => ROOTS.find((r) => within(p, r.path));

function containerPath(input) {
  const raw = String(input || "").trim();

  if (raw.includes("\0")) {
    throw new StepError("Invalid path");
  }

  const p = path.posix.normalize(path.posix.isAbsolute(raw) ? raw : path.posix.join(config.workspaceDir, raw || ".")).replace(/\/+$/, "") || "/";

  if (!rootOf(p)) {
    throw new StepError(`Path must be inside ${rootNames}: ${p}`);
  }

  return p;
}

function toLocal(p) {
  const root = rootOf(p);
  return path.join(root.local, ...p.slice(root.path.length).split("/").filter(Boolean));
}

const realRoots = new Map();

// The real (symlink-free) local folder of a root; a root that isn't mounted yet is retried next time.
function realRoot(root) {
  if (!realRoots.has(root)) {
    try {
      realRoots.set(root, fs.realpathSync(root.local));
    } catch {
      return null;
    }
  }

  return realRoots.get(root);
}

function toContainer(local) {
  let best = null;

  for (const root of ROOTS) {
    const real = realRoot(root);

    if (!real) {
      continue;
    }

    const rel = path.relative(real, local);

    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      continue;
    }

    // The deepest real root wins (a mount inside another mount).
    if (!best || real.length > best.real.length) {
      best = { real, path: rel ? `${root.path}/${rel.split(path.sep).join("/")}` : root.path };
    }
  }

  return best && best.path;
}

// Resolve symlinks of the deepest existing ancestor, so a link can't lead outside the allowed paths.
function realContainerPath(p) {
  let local = toLocal(p);
  const rest = [];

  while (!fs.existsSync(local)) {
    const parent = path.dirname(local);

    if (parent === local) {
      break;
    }

    rest.unshift(path.basename(local));
    local = parent;
  }

  const real = toContainer(fs.realpathSync(local));

  if (!real) {
    throw new StepError(`Path leads outside ${rootNames}: ${p}`);
  }

  return rest.length ? `${real}/${rest.join("/")}` : real;
}

// READ_TOKEN_DENY_NAMES as lists of component patterns ("a/b" -> [/^a$/, /^b$/]).
const secretPatterns = config.readTokenDenyNames.map((n) =>
  n.split("/").filter(Boolean).map((c) => new RegExp(`^${c.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i")),
);

// Whether a container path has a component (or run of components) named like a secret: .env, *.pem, .git/config…
function isSecret(p) {
  const parts = p.split("/").filter(Boolean);
  return secretPatterns.some((pat) => {
    for (let i = 0; i + pat.length <= parts.length; i++) {
      if (pat.every((re, j) => re.test(parts[i + j]))) {
        return true;
      }
    }

    return false;
  });
}

// opts.hideSecrets: the read-only token, which can't reach READ_TOKEN_DENY_NAMES.
function check(input, roots, what, opts = {}) {
  const p = containerPath(input);

  for (const q of new Set([p, realContainerPath(p)])) {
    if (config.denyPaths.some((d) => within(q, d))) {
      throw new StepError(`Not allowed (protected path): ${p}`);
    }

    if (opts.hideSecrets && isSecret(q)) {
      throw new StepError(`Not allowed with the read-only token (secrets file): ${p}`);
    }

    if (!roots.some((r) => within(q, r))) {
      throw new StepError(`Not ${what}: ${p} (allowed: ${roots.join(", ")})`);
    }
  }

  return { path: p, local: toLocal(p) };
}

const readable = (input, opts) => check(input, [...config.readPaths, ...config.writePaths], "readable", opts);
const writable = (input) => check(input, config.writePaths, "writable");

function stat(local) {
  try {
    return fs.statSync(local);
  } catch {
    return null;
  }
}

function lstat(local) {
  try {
    return fs.lstatSync(local);
  } catch {
    return null;
  }
}

// First max bytes of text, never splitting a multi-byte character.
function cutBytes(text, max, fromEnd = false) {
  const buf = Buffer.from(text);

  if (buf.length <= max) {
    return text;
  }

  const part = fromEnd ? buf.subarray(buf.length - max) : buf.subarray(0, max);
  return part.toString("utf-8").replace(fromEnd ? /^\uFFFD+/ : /\uFFFD+$/, "");
}

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

function listFiles({ path: input, depth = 2, show_hidden = true, max_entries = 400 }, opts = {}) {
  const { path: root, local } = readable(input, opts);
  const st = stat(local);

  if (!st) {
    throw new StepError(`Not found: ${root}`);
  }

  if (!st.isDirectory()) {
    return { path: root, entries: [{ path: root, type: "file", size: st.size, modified: st.mtime.toISOString() }] };
  }

  const entries = [];
  let truncated = false;

  const walk = (dir, cdir, level) => {
    let names;

    try {
      names = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    } catch (e) {
      entries.push({ path: cdir, error: e.code || e.message });
      return;
    }

    for (const d of names) {
      if (entries.length >= max_entries) {
        truncated = true;
        return;
      }

      if (!show_hidden && d.name.startsWith(".")) {
        continue;
      }

      const cp = `${cdir}/${d.name}`;

      if (config.denyPaths.some((x) => within(cp, x)) || (opts.hideSecrets && isSecret(cp))) {
        continue;
      }

      const lp = path.join(dir, d.name);
      const type = d.isSymbolicLink() ? "symlink" : d.isDirectory() ? "dir" : "file";
      // A symlink's own date, not its target's: the target may be outside the allowed paths.
      const s = type === "symlink" ? lstat(lp) : stat(lp);
      const entry = { path: cp, type, ...(s && type === "file" ? { size: s.size } : {}), ...(s ? { modified: s.mtime.toISOString() } : {}) };

      if (type === "dir" && SKIP_DIRS.has(d.name)) {
        entry.skipped = "not listed (dependency/VCS folder)";
      }

      entries.push(entry);

      if (type === "dir" && !entry.skipped && level < depth) {
        walk(lp, cp, level + 1);
      }
    }
  };

  walk(local, root, 1);
  return { path: root, depth, entries, ...(truncated ? { truncated: true, hint: "Raise max_entries or list a subfolder" } : {}) };
}

function readFile({ path: input, start_line, end_line, line_numbers = false }, opts = {}) {
  const { path: p, local } = readable(input, opts);
  const st = stat(local);

  if (!st) {
    throw new StepError(`Not found: ${p}`);
  }

  if (st.isDirectory()) {
    throw new StepError(`${p} is a folder: use list_files`);
  }

  if (!st.isFile()) {
    throw new StepError(`${p} is not a regular file (FIFO, socket or device)`); // reading a FIFO would block the server
  }

  if (st.size > MAX_FILE_BYTES) {
    throw new StepError(`${p} is ${Math.round(st.size / 1048576)} MB: too big to read whole, use run_command (head, tail, sed -n)`);
  }

  const buf = fs.readFileSync(local);

  if (isBinary(buf)) {
    return { path: p, size: st.size, binary: true, content: null };
  }

  const lines = buf.toString("utf-8").split("\n");
  const start = Math.max(1, start_line || 1);

  if (start > lines.length) {
    throw new StepError(`start_line ${start} is past the end of ${p} (${lines.length} lines)`);
  }

  if (end_line && end_line < start) {
    throw new StepError(`end_line ${end_line} is before start_line ${start}`);
  }

  let end = Math.min(lines.length, end_line || lines.length);
  const out = [];
  let bytes = 0;
  let lineCut = false;

  for (let i = start; i <= end; i++) {
    let line = line_numbers ? `${String(i).padStart(5)}  ${lines[i - 1]}` : lines[i - 1];
    bytes += Buffer.byteLength(line) + 1;

    if (bytes > config.maxReadBytes) {
      // A first line over the limit is cut instead of returned empty (paging would never move on).
      if (out.length) {
        end = i - 1;
        break;
      }

      line = cutBytes(line, config.maxReadBytes);
      lineCut = true;
      end = i;
    }

    out.push(line);

    if (lineCut) {
      break;
    }
  }

  const truncated = end < Math.min(lines.length, end_line || lines.length);
  return {
    path: p,
    size: st.size,
    modified: st.mtime.toISOString(),
    total_lines: lines.length,
    start_line: start,
    end_line: end,
    ...(lineCut ? { line_cut: `Line ${end} is longer than ${config.maxReadBytes} bytes: only its start is shown` } : {}),
    ...(truncated ? { truncated: true, hint: `Read on with start_line: ${end + 1}` } : {}),
    content: out.join("\n"),
  };
}

function globRegex(glob) {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
  return new RegExp(glob.includes("/") ? `^${re}$` : `(^|/)${re}$`, "i");
}

// Runs re over texts inside a vm context, so a timeout can interrupt it.
const REGEX_SCAN = new vm.Script("out = []; for (let i = 0; i < texts.length; i++) { if (re.test(texts[i])) out.push(i); }");

// findAll(texts) -> indexes of the texts re matches. Only time spent matching counts against budgetMs, shared by
// all calls of one search.
function regexMatcher(re, budgetMs = REGEX_BUDGET_MS) {
  const sandbox = vm.createContext({ re, texts: [], out: [] });
  let leftMs = budgetMs;

  return (texts) => {
    sandbox.texts = texts;
    const start = Date.now();

    try {
      REGEX_SCAN.runInContext(sandbox, { timeout: Math.max(1, leftMs) });
    } catch (e) {
      if (e.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
        throw new StepError(
          `The regex took more than ${budgetMs / 1000} s to match (it may backtrack heavily, e.g. nested quantifiers like (a+)+): simplify it, search a subfolder or use glob`,
        );
      }

      throw e;
    } finally {
      leftMs -= Date.now() - start;
      sandbox.texts = [];
    }

    return Array.from(sandbox.out);
  };
}

function searchFiles({ query, path: input, regex = false, case_sensitive = false, glob, max_results = 100 }, opts = {}) {
  const { path: root, local } = readable(input, opts);
  let re;

  try {
    re = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), case_sensitive ? "" : "i");
  } catch (e) {
    throw new StepError(`Invalid regex: ${e.message}`);
  }

  // A plain-text query can't backtrack: matched directly, without the vm round trip.
  const findAll = regex ? regexMatcher(re, opts.regexBudgetMs) : (texts) => texts.flatMap((t, i) => (re.test(t) ? [i] : []));

  const only = glob ? globRegex(glob) : null;
  const results = [];
  let scanned = 0;
  let truncated = false;

  const scan = (lp, cp) => {
    const s = stat(lp);

    if (!s || !s.isFile() || s.size > MAX_SEARCH_FILE_BYTES) {
      return;
    }

    const buf = fs.readFileSync(lp);

    if (isBinary(buf)) {
      return;
    }

    const lines = buf.toString("utf-8").split("\n");

    for (const i of findAll(lines)) {
      results.push({ path: cp, line: i + 1, text: lines[i].trim().slice(0, 300) });
      truncated = results.length >= max_results;

      if (truncated) {
        break;
      }
    }
  };

  const walk = (dir, cdir) => {
    let names;

    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const d of names) {
      if (truncated) {
        return;
      }

      const cp = `${cdir}/${d.name}`;
      const lp = path.join(dir, d.name);

      if (config.denyPaths.some((x) => within(cp, x)) || d.isSymbolicLink() || (opts.hideSecrets && isSecret(cp))) {
        continue;
      }

      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) {
          walk(lp, cp);
        }

        continue;
      }

      if (only && !only.test(cp.slice(root.length + 1))) {
        continue;
      }

      if (++scanned > MAX_SCANNED) {
        truncated = true;
        return;
      }

      scan(lp, cp);
    }
  };

  const st = stat(local);

  if (!st) {
    throw new StepError(`Not found: ${root}`);
  }

  if (st.isDirectory()) {
    walk(local, root);
  } else {
    scan(local, root);
  }

  return { query, path: root, matches: results.length, results, ...(truncated ? { truncated: true, ...(scanned > MAX_SCANNED ? { hint: `Stopped after ${MAX_SCANNED} files: search a subfolder or use glob` } : {}) } : {}) };
}

// Backup folders are named by backup() from an ISO time: 2026-10-24T08-25-37-959Z.
const BACKUP_STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;
let lastBackupPrune = 0;

// Removes backup folders older than BACKUP_KEEP_DAYS (by the time in their name; other folders are left alone).
// At most once an hour, never fails a write.
function pruneBackups(now = Date.now()) {
  const days = config.backupKeepDays;

  if (!(days > 0) || now - lastBackupPrune < 3600000) {
    return [];
  }

  lastBackupPrune = now;
  const removed = [];

  try {
    for (const name of fs.readdirSync(config.backupDir)) {
      const m = BACKUP_STAMP.exec(name);

      if (m && now - Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) > days * 86400000) {
        fs.rmSync(path.join(config.backupDir, name), { recursive: true, force: true });
        removed.push(name);
      }
    }
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error(`Backup cleanup: ${e.message}`);
    }
  }

  return removed;
}

function backup(p, local) {
  if (!fs.existsSync(local)) {
    return null;
  }

  pruneBackups();

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(config.backupDir, stamp, ...p.split("/").filter(Boolean));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(local, dest);
  return dest;
}

function chown(local, uid = config.ownerUid, gid = config.ownerGid) {
  try {
    fs.chownSync(local, uid, gid);
  } catch {
    // Not root (tests on another machine): keep the current owner.
  }
}

function mkdirs(dir) {
  const missing = [];

  for (let d = dir; !fs.existsSync(d); d = path.dirname(d)) {
    missing.unshift(d);
  }

  for (const d of missing) {
    fs.mkdirSync(d);
    chown(d);
  }

  return missing.length;
}

// Write via a temp file + rename; new files get code-server's owner, existing ones keep owner and mode.
// A symlink is written through (its target is replaced), not turned into a regular file.
function save(p, local, content) {
  const old = stat(local);

  if (old && old.isDirectory()) {
    throw new StepError(`${p} is a folder`);
  }

  if (old && !old.isFile()) {
    throw new StepError(`${p} is not a regular file (FIFO, socket or device)`);
  }

  if (!old && fs.lstatSync(local, { throwIfNoEntry: false })) {
    throw new StepError(`${p} is a broken symlink: fix or remove it with run_command`);
  }

  const target = old ? fs.realpathSync(local) : local;
  const saved = backup(p, target);
  const tmp = `${target}.mcp-${process.pid}-${Date.now()}.tmp`;

  try {
    fs.writeFileSync(tmp, content);
    fs.chmodSync(tmp, old ? old.mode & 0o7777 : 0o664); // explicit, so the umask doesn't apply
    chown(tmp, old ? old.uid : config.ownerUid, old ? old.gid : config.ownerGid);
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }

  return { path: p, bytes: Buffer.byteLength(content), created: !old, ...(saved ? { backup: saved } : {}) };
}

const locks = new Map();

// The lock key: where the path really leads, so two names for one file (a symlink, a link between roots) share it.
function lockKey(p) {
  try {
    return realContainerPath(p);
  } catch {
    return p;
  }
}

// One change at a time per file, so two edits can't overwrite each other.
function locked(key, fn) {
  const next = (locks.get(key) || Promise.resolve()).then(fn);
  const tail = next.catch(() => {});
  locks.set(key, tail);
  tail.then(() => locks.get(key) === tail && locks.delete(key));
  return next;
}

function writeFile({ path: input, content, create_dirs = true }) {
  const { path: p, local } = writable(input);
  return locked(lockKey(p), () => {
    if (!fs.existsSync(path.dirname(local))) {
      if (!create_dirs) {
        throw new StepError(`Folder missing: ${path.posix.dirname(p)}`);
      }

      mkdirs(path.dirname(local));
    }

    return save(p, local, content);
  });
}

function editFile({ path: input, old_string, new_string, replace_all = false }) {
  const { path: p, local } = writable(input);
  return locked(lockKey(p), () => {
    const st = stat(local);

    if (!st) {
      throw new StepError(`Not found: ${p} (use write_file to create it)`);
    }

    if (!st.isFile()) {
      throw new StepError(`${p} is not a regular file`);
    }

    if (st.size > MAX_FILE_BYTES) {
      throw new StepError(`${p} is too big to edit here: use run_command`);
    }

    const buf = fs.readFileSync(local);
    const text = buf.toString("utf-8");

    // Decoding replaces invalid bytes with U+FFFD: saving would silently corrupt every non-UTF-8 character.
    if (isBinary(buf) || !Buffer.from(text, "utf-8").equals(buf)) {
      throw new StepError(`${p} is binary or not valid UTF-8: edit_file would corrupt it, use run_command`);
    }
    const parts = text.split(old_string);
    const count = parts.length - 1;

    if (count === 0) {
      throw new StepError("old_string not found: read the file again and copy the text exactly (whitespace included)");
    }

    if (count > 1 && !replace_all) {
      throw new StepError(`old_string occurs ${count} times: add surrounding lines to make it unique, or set replace_all`);
    }

    const firstLine = text.slice(0, text.indexOf(old_string)).split("\n").length;
    const result = save(p, local, replace_all ? parts.join(new_string) : text.replace(old_string, () => new_string));
    return { ...result, replacements: replace_all ? count : 1, first_line: firstLine };
  });
}

module.exports = { rootNames, cutBytes, containerPath, toLocal, readable, writable, listFiles, readFile, searchFiles, writeFile, editFile, mkdirs, chown, isSecret, pruneBackups, regexMatcher, lockKey };
