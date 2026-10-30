const http = require("http");
const { config, StepError } = require("./config");

// Minimal Docker Engine API client: inspect, stats, logs, exec and restart of one container.
// sink (optional) receives the response body chunk by chunk instead of it being buffered.
function call(method, path, body, timeoutMs = 60000, sink) {
  return new Promise((resolve, reject) => {
    const u = config.dockerHost && new URL(config.dockerHost);
    const target = u ? { host: u.hostname, port: u.port } : { socketPath: config.dockerSocket };
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      { ...target, method, path, headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {} },
      (res) => {
        const chunks = [];
        res.on("data", (c) => (sink ? sink.push(c) : chunks.push(c)));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", (e) => reject(new StepError(`Docker API unreachable: ${e.message}`)));
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${timeoutMs / 1000} s`)));
    req.end(payload);
  });
}

// Exec and log output is multiplexed: 8-byte frame headers (stream type + length) before each chunk.
// Frames are joined before decoding, so a multi-byte character split across two frames stays intact.
function demux(buf) {
  const parts = [];
  let i = 0;

  while (i + 8 <= buf.length && buf[i] <= 2 && buf[i + 1] === 0) {
    const len = buf.readUInt32BE(i + 4);
    parts.push(buf.subarray(i + 8, i + 8 + len));
    i += 8 + len;
  }

  return (i === 0 ? buf : Buffer.concat(parts)).toString("utf-8");
}

// Streaming demux that keeps only the first and last max bytes of the output, so a command printing
// gigabytes (yes, cat of a big file) can't exhaust this container's memory. Same framing rules as demux().
function boundedDemux(max) {
  const head = [];
  const tail = [];
  let headLen = 0;
  let tailLen = 0;
  let cut = 0;
  let pending = Buffer.alloc(0);
  let left = 0;
  let raw = null;

  const keep = (b) => {
    if (headLen < max) {
      const h = b.subarray(0, max - headLen);
      head.push(h);
      headLen += h.length;
      b = b.subarray(h.length);
    }

    if (b.length) {
      tail.push(b);
      tailLen += b.length;

      while (tailLen > max) {
        const over = Math.min(tailLen - max, tail[0].length);
        tail[0] = tail[0].subarray(over);
        tailLen -= over;
        cut += over;

        if (!tail[0].length) {
          tail.shift();
        }
      }
    }
  };

  return {
    push(chunk) {
      if (raw === null) {
        pending = Buffer.concat([pending, chunk]);

        if (pending.length < 8) {
          return;
        }

        raw = !(pending[0] <= 2 && pending[1] === 0);
        chunk = pending;
        pending = Buffer.alloc(0);
      }

      if (raw) {
        return keep(chunk);
      }

      while (chunk.length) {
        if (left) {
          const part = chunk.subarray(0, left);
          keep(part);
          left -= part.length;
          chunk = chunk.subarray(part.length);
          continue;
        }

        const take = 8 - pending.length;
        pending = Buffer.concat([pending, chunk.subarray(0, take)]);
        chunk = chunk.subarray(take);

        if (pending.length === 8) {
          left = pending.readUInt32BE(4);
          pending = Buffer.alloc(0);
        }
      }
    },
    // { text, cut }: cut = bytes dropped from the middle; then text is head + marker + tail.
    result() {
      if (raw === null) {
        keep(pending);
      }

      if (!cut) {
        return { text: Buffer.concat([...head, ...tail]).toString("utf-8"), cut: 0 };
      }

      const h = Buffer.concat(head).toString("utf-8").replace(/\uFFFD+$/, "");
      const t = Buffer.concat(tail).toString("utf-8").replace(/^\uFFFD+/, "");
      return { text: `${h}\n\n… [${cut} bytes cut] …\n\n${t}`, cut };
    },
  };
}

function ok(r, what, expected = (s) => s < 300) {
  if (!expected(r.status)) {
    throw new StepError(`${what} failed (${r.status}): ${r.body.toString().slice(0, 300)}`);
  }

  return r;
}

const json = (r, what) => JSON.parse(ok(r, what).body);

const name = () => encodeURIComponent(config.container);

async function inspect() {
  const r = await call("GET", `/containers/${name()}/json`);

  if (r.status === 404) {
    throw new StepError(`Container ${config.container} not found`);
  }

  return json(r, "Docker inspect");
}

async function stats() {
  return json(await call("GET", `/containers/${name()}/stats?stream=false`), "Docker stats");
}

async function logs(lines, since) {
  const q = `stdout=1&stderr=1&timestamps=1&tail=${lines}${since ? `&since=${since}` : ""}`;
  return demux(ok(await call("GET", `/containers/${name()}/logs?${q}`), "Docker logs").body);
}

// maxBytes: output kept from the start and from the end (default 1 MB each); truncated = the middle was cut.
async function exec(cmd, { user, workdir, env, timeoutMs, maxBytes = 1048576 } = {}) {
  const created = await call("POST", `/containers/${name()}/exec`, {
    AttachStdout: true,
    AttachStderr: true,
    Cmd: cmd,
    ...(user ? { User: user } : {}),
    ...(workdir ? { WorkingDir: workdir } : {}),
    ...(env ? { Env: env } : {}),
  });
  const { Id } = json(ok(created, `Docker exec in ${config.container}`, (s) => s === 201), "Docker exec");
  const out = boundedDemux(maxBytes);
  const started = await call("POST", `/exec/${Id}/start`, { Detach: false, Tty: false }, timeoutMs || 60000, out);

  if (started.status >= 300) {
    throw new StepError(`Docker exec start failed (${started.status}): ${out.result().text.slice(0, 300)}`);
  }

  const info = json(await call("GET", `/exec/${Id}/json`), "Docker exec inspect");
  const { text, cut } = out.result();
  return { exitCode: info.ExitCode, output: text, ...(cut ? { truncated: true } : {}) };
}

async function restart() {
  ok(await call("POST", `/containers/${name()}/restart?t=10`, undefined, 90000), `Restarting ${config.container}`, (s) => s === 204);
}

module.exports = { call, demux, boundedDemux, inspect, stats, logs, exec, restart };
