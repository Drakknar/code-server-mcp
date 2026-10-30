const fs = require("fs");
const http = require("http");
const path = require("path");
const { config } = require("./config");
const docker = require("./docker");
const files = require("./files");
const editors = require("./editors");

function health() {
  return new Promise((resolve) => {
    const req = http.get(config.healthUrl, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const h = JSON.parse(body);
          // "alive" = a browser was connected recently, "expired" = idle; both mean the server answers.
          resolve({ reachable: true, status: h.status, lastHeartbeat: h.lastHeartbeat ? new Date(h.lastHeartbeat).toISOString() : undefined });
        } catch {
          resolve({ reachable: true, http: res.statusCode });
        }
      });
    });
    req.on("error", (e) => resolve({ reachable: false, error: e.message }));
    req.setTimeout(4000, () => req.destroy(new Error("timeout")));
  });
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(files.toLocal(p), "utf-8"));
  } catch {
    return null;
  }
}

function extensions() {
  const list = readJson(`${config.homeDir}/extensions/extensions.json`) || [];
  return list.filter((e) => e && e.identifier).map((e) => `${e.identifier.id}@${e.version}`).sort();
}

let versionCache;

async function version() {
  if (versionCache && Date.now() - versionCache.at < 300000) {
    return versionCache.value;
  }

  const r = await docker.exec([config.codeServerBin, "--version"], { timeoutMs: 20000 });
  const value = r.exitCode === 0 ? r.output.trim().split("\n")[0] : null;
  versionCache = { at: Date.now(), value };
  return value;
}

// coder.json keeps the newest release code-server saw at its last update check, which can be older than
// the running version (image updated since), so only a newer one counts.
function newer(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);

  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) {
      return (pa[i] || 0) > (pb[i] || 0);
    }
  }

  return false;
}

function usage(s) {
  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
  const sysDelta = s.cpu_stats.system_cpu_usage - (s.precpu_stats.system_cpu_usage || 0);
  const cpus = s.cpu_stats.online_cpus || 1;
  const m = s.memory_stats || {};
  const cache = (m.stats && (m.stats.inactive_file ?? m.stats.total_inactive_file)) || 0;
  const mib = (b) => Math.round(b / 1048576);
  return {
    cpu_percent: sysDelta > 0 ? Math.round((cpuDelta / sysDelta) * cpus * 1000) / 10 : 0,
    memory_mib: m.usage ? mib(m.usage - cache) : null,
    memory_limit_mib: m.limit ? mib(m.limit) : null,
    pids: s.pids_stats ? s.pids_stats.current : null,
  };
}

async function status() {
  const info = await docker.inspect();
  const st = info.State;
  const running = st.Running;
  const [stats, hc, ver] = running ? await Promise.all([docker.stats().then(usage).catch((e) => ({ error: e.message })), health(), version().catch(() => null)]) : [null, null, null];
  const coder = readJson(`${config.homeDir}/data/coder.json`);
  const latest = coder && coder.update && coder.update.version;
  const current = ver && ver.split(" ")[0];
  const envDefault = (info.Config.Env || []).find((e) => e.startsWith("DEFAULT_WORKSPACE="));
  const lastFolder = coder && coder.query && coder.query.folder;
  const wins = editors.windows();

  return {
    container: config.container,
    state: st.Status,
    running,
    started: st.StartedAt,
    ...(st.Health ? { docker_health: st.Health.Status } : {}),
    restart_count: info.RestartCount,
    image: info.Config.Image,
    version: ver,
    ...(latest && current ? { update_available: newer(latest, current), ...(newer(latest, current) ? { latest_known_version: latest } : {}) } : {}),
    web: hc,
    resources: stats,
    // What a bare URL opens: the last folder opened in the browser, else DEFAULT_WORKSPACE.
    default_workspace: envDefault ? envDefault.slice("DEFAULT_WORKSPACE=".length) : null,
    ...(lastFolder ? { last_opened_folder: lastFolder } : {}),
    mcp_workspace: config.workspaceDir,
    windows_open: wins.filter((w) => w.live).length,
    companion: wins.length ? "reporting" : "no state yet (install_companion, then reload the code-server tab)",
    extensions: extensions(),
  };
}

async function logs({ lines = 100, since_minutes }) {
  const since = since_minutes ? Math.floor(Date.now() / 1000 - since_minutes * 60) : undefined;
  const text = (await docker.logs(Math.min(lines, 2000), since)).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  return { container: config.container, lines: text.trim().split("\n").filter(Boolean) };
}

// The newest companion/*.vsix by the version in its name (numerically: 0.10.0 is newer than 0.9.0).
function bundledVsix(d = path.join(__dirname, "..", "companion")) {
  const ver = (n) => (/-(\d+(?:\.\d+)*)\.vsix$/.exec(n) || [null, "0"])[1];
  const v = fs
    .readdirSync(d)
    .filter((n) => n.endsWith(".vsix"))
    .sort((a, b) => (newer(ver(a), ver(b)) ? 1 : newer(ver(b), ver(a)) ? -1 : a.localeCompare(b)))
    .pop();
  return v ? path.join(d, v) : null;
}

module.exports = { status, logs, health, bundledVsix, newer };
