// All settings come from the container's environment.
const path = require("path");
const env = process.env;

// Normalized ("/a/./b/../c/" = "/a/c"), so a path setting can't silently fail to match; "/" becomes "".
const dir = (value) => {
  const v = String(value).trim();
  return v ? path.posix.normalize(v).replace(/\/+$/, "") : "";
};
const list = (value) => String(value).split(",").map(dir).filter(Boolean);
const workspaceDir = dir(env.WORKSPACE_DIR || "/config/workspace");
// Settings entries that were ignored (logged at start-up).
const invalid = [];

// EXTRA_ROOTS: both sides must be absolute and not "/" (an empty root path would contain every path).
function extraRoots(value) {
  const out = [];

  for (const r of String(value).split(",").map((x) => x.trim()).filter(Boolean)) {
    const eq = r.indexOf("=");
    const p = dir(eq < 0 ? r : r.slice(0, eq));
    const local = dir(eq < 0 ? r : r.slice(eq + 1));

    // The local side is this container's own path (on Linux the same check; the tests run on Windows too).
    if (!p.startsWith("/") || !path.isAbsolute(local)) {
      invalid.push(`EXTRA_ROOTS entry "${r}" ignored: both paths must be absolute and not /`);
      continue;
    }

    out.push({ path: p, local });
  }

  return out;
}

// READ_PATHS / WRITE_PATHS / DENY_PATHS entries must be absolute: a relative one would never match.
function absList(name, value) {
  return list(value).filter((p) => p.startsWith("/") || (invalid.push(`${name} entry "${p}" ignored: not an absolute path`), false));
}

const config = {
  port: Number(env.PORT || 8080),
  mcpToken: env.MCP_TOKEN || "",
  mcpReadToken: env.MCP_READ_TOKEN || "", // optional: read-only tools only

  container: env.CODE_SERVER_CONTAINER || "code-server",
  // code-server's /config as the user sees it, and where this container mounts the same folder.
  homeDir: dir(env.CODE_SERVER_HOME || "/config"),
  mountDir: dir(env.CODE_SERVER_MOUNT || "/config"),
  // More folders code-server mounts besides /config, e.g. /projects: "path" when this container mounts it at the
  // same path, or "path=local" when elsewhere.
  extraRoots: extraRoots(env.EXTRA_ROOTS || ""),
  workspaceDir,
  readPaths: absList("READ_PATHS", env.READ_PATHS || `${workspaceDir},/config/data/User/settings.json,/config/data/User/keybindings.json,/config/data/User/snippets`),
  writePaths: absList("WRITE_PATHS", env.WRITE_PATHS || workspaceDir),
  // Never readable or writable through the file tools, even inside an allowed path.
  denyPaths: absList("DENY_PATHS", env.DENY_PATHS || "/config/.ssh,/config/.config/code-server,/config/.claude.json,/config/.claude/.credentials.json"),

  ownerUid: Number(env.OWNER_UID || 99),
  ownerGid: Number(env.OWNER_GID || 100),
  execUser: env.EXEC_USER || "abc",

  healthUrl: env.HEALTH_URL || "http://code-server:8443/healthz",
  codeServerBin: env.CODE_SERVER_BIN || "/app/code-server/bin/code-server",
  companionDir: dir(env.COMPANION_DIR || "/config/.code-server-mcp"),

  // Names the read-only token can't read, list or search (any path component; "a/b" = consecutive components;
  // * and ? wildcards; case-insensitive). The full token is not limited by these. Set but empty = off.
  readTokenDenyNames: String(env.READ_TOKEN_DENY_NAMES ?? ".env,.env.*,*.pem,*.key,id_rsa,id_ed25519,id_ecdsa,id_dsa,.git/config")
    .split(",")
    .map((x) => x.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean),

  backupDir: env.BACKUP_DIR || "/data/backups",
  // Backup folders older than this many days are removed (0 = keep all).
  backupKeepDays: Number(env.BACKUP_KEEP_DAYS ?? 30),
  dockerSocket: env.DOCKER_SOCKET || "/var/run/docker.sock",
  dockerHost: env.DOCKER_HOST_URL || "", // tests: http://127.0.0.1:port instead of the socket

  maxReadBytes: Number(env.MAX_READ_BYTES || 400000),
  maxOutputBytes: Number(env.MAX_OUTPUT_BYTES || 60000),
  invalid,
};

class StepError extends Error {}

module.exports = { config, StepError };
