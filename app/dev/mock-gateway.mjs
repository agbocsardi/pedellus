#!/usr/bin/env node
// Development mock of the durable-nanobot gateway's /v1 surface, speaking
// protocol v1 (../../protocol/v1.md) so the app can be exercised end to end
// without the real gateway. Pairs with a printed one-time code, echoes user
// messages, streams a fake preview, then settles with a markdown answer.
//
// State is in memory: restarting the mock resets cursors (the app survives
// that — it re-plays from its stored cursor, or from scratch if the store is
// gone).
import { createHash, randomBytes, randomInt } from "node:crypto";
import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8791);
const FRAME_BYTES = 262_144;
const SEND_TEXT_CHARS = 16_000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REPLAY_BATCH = 500;
const LABEL_RE = /^.{1,40}$/s;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // [A-Z2-9] minus I, O

const pairCode =
  process.argv[2] ||
  Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
const pairExpires = Date.now() + 10 * 60 * 1000;
let pairUsed = false;
console.log(`pair code (single use, 10 min): ${pairCode}`);

/** token -> device label */
const tokens = new Map();
/** send key -> text (idempotency for at least the mock's lifetime) */
const admitted = new Map();
/** token -> highest acked cursor */
const acks = new Map();
/** all durable events, cursor ascending */
const events = [];
let cursor = 0;
let status = { state: "idle", label: undefined };
/** live streams: { ws, token, helloed } */
const sockets = new Set();
const rateFailures = [];

const iso = () => new Date().toISOString();

function isDurable(ev) {
  return ev.event === "message" || ev.event === "settled" || ev.event === "divider";
}

function broadcast(ev) {
  if (isDurable(ev)) {
    ev.cursor = ++cursor;
    events.push(ev);
  }
  const frame = JSON.stringify(ev);
  for (const s of sockets) {
    if (s.ws.readyState === s.ws.OPEN) s.ws.send(frame);
  }
}

function notice(text) {
  broadcast({ type: "event", event: "message", id: `n${cursor + 1}`, role: "notice", text, at: iso() });
}

// -- fake agent turns -------------------------------------------------------

let runningTurn = null;
const turnQueue = [];

function answerFor(key) {
  const asked = admitted.get(key) ?? "…";
  const short = asked.length > 60 ? asked.slice(0, 60) + "…" : asked;
  return [
    `Sure — here is a mock answer to **${short}**.`,
    "",
    "The plan, briefly:",
    "",
    "1. receive your message over the stream",
    "2. stream this answer back as a `preview`",
    "3. settle the turn with a durable `message`",
    "",
    "A code block, to check horizontal scroll and the copy button:",
    "",
    "```js",
    "function durable() {",
    '  return "cursor-based, at-least-once, acked";',
    "}",
    "```",
    "",
    "> Everything after this point is filler so the stream visibly ticks: the quick brown fox jumps over the lazy dog while five wizards quench a very long sentence indeed.",
  ].join("\n");
}

function startTurn() {
  const key = turnQueue.shift();
  if (!key) {
    runningTurn = null;
    return;
  }
  const text = answerFor(key);
  const words = text.split(/(?<=\s)/); // keep separators
  runningTurn = { key, timers: [] };
  const at = (ms, fn) => runningTurn.timers.push(setTimeout(fn, ms));
  const alive = () => runningTurn?.key === key;

  broadcast({ type: "event", event: "status", state: "queued" });
  at(300, () => {
    if (!alive()) return;
    broadcast({ type: "event", event: "status", state: "thinking" });
  });
  for (let n = 1; n <= words.length; n++) {
    at(600 + n * 90, () => {
      if (!alive()) return;
      broadcast({
        type: "event",
        event: "preview",
        key,
        text: words.slice(0, n).join(""),
      });
    });
  }
  at(600 + words.length * 90 + 200, () => {
    if (!alive()) return;
    broadcast({
      type: "event",
      event: "message",
      id: `a-${key}`,
      role: "assistant",
      text,
      at: iso(),
      key,
    });
    broadcast({ type: "event", event: "settled", key, outcome: "answered" });
    broadcast({ type: "event", event: "status", state: "idle" });
    runningTurn = null;
    if (turnQueue.length) startTurn();
  });
}

function enqueueTurn(key) {
  turnQueue.push(key);
  if (!runningTurn) startTurn();
}

// -- HTTP: pairing ----------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on("data", (d) => {
      size += d.length;
      if (size > 4096) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      parts.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/v1/pair" || req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end('{"error":"bad_request"}');
    return;
  }
  const { code, label } = body ?? {};
  if (
    typeof code !== "string" ||
    typeof label !== "string" ||
    !LABEL_RE.test(label.trim())
  ) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end('{"error":"bad_request"}');
    return;
  }
  // rate limit: more than 5 failures per minute across all clients
  const now = Date.now();
  while (rateFailures.length && rateFailures[0] < now - 60_000) rateFailures.shift();
  const codeOk =
    !pairUsed && Date.now() < pairExpires && code.trim().toUpperCase() === pairCode;
  if (!codeOk) {
    rateFailures.push(now);
    const code = rateFailures.length > 5 ? 429 : 401;
    res.writeHead(code, { "content-type": "application/json" });
    res.end(code === 429 ? '{"error":"rate_limited"}' : '{"error":"invalid_code"}');
    return;
  }
  pairUsed = true;
  const token = randomBytes(32).toString("hex");
  const device = label.trim();
  tokens.set(token, device);
  // Secure omitted: this is plain HTTP on loopback in development.
  res.setHeader(
    "Set-Cookie",
    `durable_device=${token}; Path=/v1; HttpOnly; SameSite=Strict`,
  );
  res.writeHead(204).end();
  console.log(`paired device "${device}"`);
});

// -- WebSocket: the stream ---------------------------------------------------

const wss = new WebSocketServer({ noServer: true, maxPayload: FRAME_BYTES });

function cookieToken(req) {
  const cookies = req.headers.cookie ?? "";
  const m = /(?:^|;\s*)durable_device=([0-9a-f]+)/.exec(cookies);
  return m?.[1] ?? null;
}

server.on("upgrade", (req, socket, head) => {
  // The gateway always completes the upgrade, then closes with 44xx so the
  // browser can tell auth failure from network failure.
  const token = cookieToken(req);
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (!token || !tokens.has(token)) {
      ws.close(4401);
      return;
    }
    onStream(ws, token);
  });
});

function reply(ws, id, ok, extra = {}) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type: "res", id, ok, ...extra }));
}

function onStream(ws, token) {
  const device = tokens.get(token);
  // Same device, newer stream: the older one yields.
  for (const s of sockets) {
    if (s.token === token && s.ws.readyState === s.ws.OPEN) s.ws.close(4409);
  }
  const conn = { ws, token, helloed: false };
  sockets.add(conn);
  console.log(`stream open: ${device}`);
  ws.on("close", () => {
    sockets.delete(conn);
    console.log(`stream closed: ${device}`);
  });
  ws.on("error", () => {});
  ws.on("message", (data, isBinary) => {
    if (isBinary || data.length > FRAME_BYTES) {
      ws.close(4400);
      return;
    }
    let frame;
    try {
      frame = JSON.parse(data.toString("utf8"));
    } catch {
      ws.close(4400);
      return;
    }
    if (frame?.type !== "req" || typeof frame.id !== "string" || !ID_RE.test(frame.id)) {
      ws.close(4400);
      return;
    }
    if (frame.op !== "hello" && !conn.helloed) {
      ws.close(4400); // hello must come first
      return;
    }
    switch (frame.op) {
      case "hello": {
        if (frame.v !== 1) {
          ws.close(4426);
          return;
        }
        if (frame.cursor !== null && !Number.isInteger(frame.cursor)) {
          ws.close(4400);
          return;
        }
        conn.helloed = true;
        reply(ws, frame.id, true, { v: 1, device, head: cursor || null });
        // replay: oldest first, one bounded batch; the client re-hellos
        // with its new cursor if the batch was full
        const from = frame.cursor ?? 0;
        for (const ev of events.filter((e) => e.cursor > from).slice(0, REPLAY_BATCH)) {
          ws.send(JSON.stringify(ev));
        }
        ws.send(JSON.stringify({ type: "event", event: "status", ...status }));
        break;
      }
      case "send": {
        const { key, text } = frame;
        if (typeof key !== "string" || !ID_RE.test(key) || typeof text !== "string") {
          reply(ws, frame.id, false, { error: "bad_request" });
          return;
        }
        if (text.length > SEND_TEXT_CHARS) {
          reply(ws, frame.id, false, { error: "too_large" });
          return;
        }
        if (admitted.has(key)) {
          reply(ws, frame.id, true, { duplicate: true });
          return;
        }
        admitted.set(key, text);
        reply(ws, frame.id, true, { duplicate: false });
        broadcast({
          type: "event",
          event: "message",
          id: `u-${key}`,
          role: "user",
          text,
          at: iso(),
          key,
        });
        enqueueTurn(key);
        break;
      }
      case "ack": {
        if (!Number.isInteger(frame.cursor) || frame.cursor < 0) {
          reply(ws, frame.id, false, { error: "bad_request" });
          return;
        }
        acks.set(token, Math.max(acks.get(token) ?? 0, frame.cursor)); // never decreases
        reply(ws, frame.id, true);
        break;
      }
      case "control": {
        const cmd = frame.command;
        if (cmd !== "new" && cmd !== "abort" && cmd !== "status") {
          reply(ws, frame.id, false, { error: "bad_request" });
          return;
        }
        reply(ws, frame.id, true);
        if (cmd === "abort") {
          if (runningTurn) {
            const key = runningTurn.key;
            for (const t of runningTurn.timers) clearTimeout(t);
            runningTurn = null;
            broadcast({ type: "event", event: "settled", key, outcome: "aborted" });
            broadcast({ type: "event", event: "status", state: "idle" });
            notice("Turn aborted.");
            if (turnQueue.length) startTurn();
          } else {
            notice("Nothing is running.");
          }
        } else if (cmd === "new") {
          broadcast({ type: "event", event: "divider", at: iso(), reason: "new" });
          notice("New thread started.");
        } else {
          notice(
            runningTurn
              ? `Running: turn for ${runningTurn.key}.`
              : `Idle. ${admitted.size} admitted message(s), ack at ${acks.get(token) ?? 0}.`,
          );
        }
        break;
      }
      case "ping": {
        reply(ws, frame.id, true);
        break;
      }
      case "history":
      case "tasks": {
        reply(ws, frame.id, false, { error: "unsupported" });
        break;
      }
      default: {
        ws.close(4400); // unknown op is a protocol violation
      }
    }
  });
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock gateway on http://127.0.0.1:${PORT} (pair code ${pairCode})`);
});
