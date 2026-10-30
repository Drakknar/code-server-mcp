# code-server MCP

MCP server (Streamable HTTP, stateless, `POST /mcp`) for a [code-server](https://github.com/coder/code-server) container, meant to be used through an MCP gateway such as LiteLLM.

Image: `ghcr.io/drakknar/code-server-mcp`, port 8080. Mounts: `/data` (backups), code-server's own `/config` and any workspace folders (same paths inside both containers), `/var/run/docker.sock`. Set `HEALTH_URL` to code-server's `/healthz`.

## Tools

| Tool | Token | What it does |
|---|---|---|
| `status` | read | container state, start time, restarts, version + `update_available` (only when `data/coder.json`'s last-seen release is newer than the running one), `default_workspace` (code-server's `DEFAULT_WORKSPACE`), `last_opened_folder` (what a bare URL reopens), `/healthz` (alive = browser connected, expired = idle), CPU/RAM/pids, open windows, extensions |
| `logs` | read | container log tail (`lines`, `since_minutes`), ANSI stripped |
| `open_editors` | read | per browser window: workspace folders, tab groups/tabs, active file + cursor + selection, unsaved files, terminals, Problems |
| `list_files` / `read_file` / `search_files` | read | workspace files (`.git`, `node_modules`… not entered); a `regex: true` search stops with an error after 3 s of matching (catastrophic backtracking) |
| `open_in_editor` | read | shows a file/line range in the focused code-server window |
| `write_file` / `edit_file` | full | create/replace, or exact unique replacement; backup to `/data/backups/<time>/…` (folders older than `BACKUP_KEEP_DAYS`, default 30, are removed; `0` = keep all); owner 99:100; per-file lock; warns when the file has unsaved changes in an editor |
| `run_command` | full | `bash -c` in code-server as `abc`, cwd default `WORKSPACE_DIR`, `timeout` 1-600 s, output cut to 60 KB (head + tail) |
| `restart_code_server` | full | plan (open windows, unsaved files, terminals), restart only with `apply: true` |
| `install_companion` | full | installs `companion/*.vsix` with code-server's CLI (`--force`) |

Auth: `MCP_TOKEN` = all tools, `MCP_READ_TOKEN` (optional) = read tools only; without `MCP_TOKEN` every request gets 401. With the read token, `list_files`/`read_file`/`search_files`/`open_in_editor` also hide paths with a component named in `READ_TOKEN_DENY_NAMES` (comma-separated, `*`/`?` wildcards, case-insensitive, `a/b` = consecutive components; default `.env,.env.*,*.pem,*.key,id_rsa,id_ed25519,id_ecdsa,id_dsa,.git/config`, so `id_*.pub` stays readable; set but empty = off). The full token is not limited by it.

Paths: as code-server sees them (`/config/...`, `/projects/...`) or relative to `WORKSPACE_DIR` (default `/config/workspace`). Roots: `/config` (at `CODE_SERVER_MOUNT`) plus `EXTRA_ROOTS` (comma-separated, `path` when mounted at the same path here, `path=local` otherwise); the start-up log warns about a root that isn't mounted, a `WORKSPACE_DIR` outside the roots, and ignored entries (an `EXTRA_ROOTS` side that is relative or `/`, a relative `READ_PATHS`/`WRITE_PATHS`/`DENY_PATHS` entry); path settings are normalized (`/a/../b/` = `/b`). Readable: `READ_PATHS` (default `WORKSPACE_DIR`, `data/User/settings.json`, `keybindings.json`, `snippets`) + `WRITE_PATHS` (default `WORKSPACE_DIR`). `DENY_PATHS` always refused (`.ssh`, `.config/code-server`, `.claude.json`, `.claude/.credentials.json`). Symlinks are resolved before the check. `run_command` is not limited by these: it is a shell.

## Companion extension

code-server keeps tabs/recent files in the browser (IndexedDB), not on the server, so `companion/` adds a tiny extension (runs in the server-side extension host). Each window writes `/config/.code-server-mcp/state-<session>.json` (debounced on changes + every 15 s; older than 45 s = closed window, removed after a day) and polls `requests/` every second for `open` requests, claimed by rename (focused window first, others after 2 s), answer in `responses/`.

Change it: edit `companion/src/`, bump the version in `companion/src/package.json`, run `companion/build.ps1` (PowerShell 7), or `companion/build.sh`, then call `install_companion` and reload the code-server tab.

## Tests

`node test/fake-docker.test.js` (Node 20+, any OS): fake `/config` + `/projects` trees in the temp folder, fake Docker API, real MCP client. Covers all tools, auth levels, path guards (protected paths, links out of a root, link between roots, unmounted root), parallel edits and the update check.
