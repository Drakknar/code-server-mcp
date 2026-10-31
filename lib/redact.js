// Applications print secrets into logs and notifications. This hides the usual shapes; it can't catch everything.
const MASK = "[hidden]";
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const STRONG = "pass(?:word|wd|phrase)?|pwd|secret";
const ANY = `${STRONG}|token|api[_-]?key|apikey|auth[_-]?key|private[_-]?key|credential|cookie|session[_-]?id`;

const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  // Whole header values: every cookie, and any Authorization scheme.
  [/\b((?:set-)?cookie["']?\s*[:=]\s*)[^\r\n]*/gi, `$1${MASK}`],
  [/\b((?:proxy-)?authorization\\?["']?\s*[:=]\s*)[^\r\n]*/gi, `$1${MASK}`],
  [/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]+)?/g, MASK],
  [/\b(sk|gh[pousr]|xox[abprs]|glpat)[-_][A-Za-z0-9_-]{10,}/g, MASK],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, MASK],
  // A password in a URL may hold "/": everything up to the last "@" before a space or quote.
  [/(:\/\/[^\s/:@"']*:)[^\s"']+@/g, `$1${MASK}@`],
  // Command line flags: --password x, --api-token=x
  [new RegExp(`(--?[\\w-]*(?:${ANY})[\\w-]*(?:\\s+|=))("[^"]*"|'[^']*'|\\S+)`, "gi"), `$1${MASK}`],
  // Environment-style names followed by a space: PGPASSWORD x. Capitals only, so ordinary prose is left alone.
  [/\b([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY)[A-Z0-9_]*\s+)(?!\[hidden\])\S+/g, `$1${MASK}`],
  // JSON inside a string: \"password\":\"x\"
  [new RegExp(`([\\w.-]*(?:${ANY})[\\w.-]*\\\\"\\s*:\\s*\\\\")(?:[^"\\\\]|\\\\(?!"))*`, "gi"), `$1${MASK}`],
  // key=value, key: value and "key": "value", when the key names a secret. The key may have a prefix or suffix.
  // After a password-like key an unquoted value runs to the end of the line, since it may hold spaces.
  [new RegExp(`([\\w.-]*(?:${STRONG})[\\w.-]*["']?\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\r\\n,;&]+)`, "gi"), `$1${MASK}`],
  [new RegExp(`([\\w.-]*(?:${ANY})[\\w.-]*["']?\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s,;&]+)`, "gi"), `$1${MASK}`],
  // Query parameters and header-like values with long random-looking content.
  [/\b[a-f0-9]{32,}\b/gi, MASK],
  [/\b(?=[A-Za-z0-9+/_-]*[0-9])(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])[A-Za-z0-9+/_-]{40,}={0,2}/g, MASK],
];

function redact(text) {
  // Colour codes go first: they can sit between a key and its "=".
  return RULES.reduce((out, [pattern, to]) => out.replace(pattern, to), String(text ?? "").replace(ANSI, ""));
}

module.exports = { redact };
