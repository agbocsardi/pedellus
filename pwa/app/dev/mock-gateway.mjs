#!/usr/bin/env node
// Development mock of the durable-nanobot gateway's /v1 surface, speaking
// protocol v2 (../../protocol/v2.md). Pairs with a printed one-time code
// and has independent fake agent turns per thread. State is in memory,
// including throwaway VAPID keys: pushes are really sent (with web-push) to
// the stored subscription whenever an answer or notice is produced for a
// device without an open stream. NO_PUSH=1 makes push look unconfigured.
import { randomBytes, randomInt } from "node:crypto";
import http from "node:http";
import { generateVAPIDKeys, sendNotification, setVapidDetails } from "web-push";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8791);
const AGENT_NAME = process.env.AGENT_NAME?.trim() || "Durable";
if ([...AGENT_NAME].length > 40) throw new Error("AGENT_NAME must be at most 40 characters");
const FRAME_BYTES = 262_144;
const SEND_TEXT_CHARS = 16_000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REPLAY_BATCH = 500;
const IDLE_ARCHIVE_MS = Number(process.env.IDLE_ARCHIVE_MS ?? 14 * 24 * 60 * 60 * 1000);
// Push is on by default, with throwaway VAPID keys made at start. Set NO_PUSH=1
// to make `push.key`/`push.subscribe` answer `unsupported`, like a gateway
// without push configured.
const PUSH = process.env.NO_PUSH !== "1";
const PUSH_ENDPOINT_MAX = 2_048;
const PUSH_P256DH_MAX = 128;
const PUSH_AUTH_MAX = 64;
const PUSH_UNREAD_CAP = 99;
const B64URL = /^[A-Za-z0-9_-]+$/;
const LABEL_RE = /^[^\p{Cc}\u2028\u2029]{1,40}$/u;
const TITLE_RE = /^[^\p{Cc}\u2028\u2029]{1,80}$/u;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // [A-Z2-9] minus I, O

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
/** token -> { endpoint, keys }; one subscription per device */
const subscriptions = new Map();
/** device tokens whose push send is in flight */
const pushing = new Set();
const vapid = PUSH ? generateVAPIDKeys() : null;
if (vapid) setVapidDetails("mailto:mock@durable.invalid", vapid.publicKey, vapid.privateKey);
/** all durable events, cursor ascending */
const events = [];
let cursor = 0;
const threads = new Map();
const created = new Map(); // create key -> thread id
const MAX_OPEN_THREADS = 50;
/** hello.commands, in menu order (stands in for the gateway's command catalogue) */
const COMMANDS = [
  { name: "new", summary: "Start a fresh context in this thread", usage: "Usage: /new" },
  { name: "abort", summary: "Stop the running turn", usage: "Usage: /abort" },
  { name: "status", summary: "Show what the agent is doing", usage: "Usage: /status" },
  { name: "model", args: "[preset]", summary: "Show or switch the model preset", usage: "Usage: /model [fast|smart|deep]" },
  { name: "digest", summary: "Summarise recent activity", usage: "Usage: /digest" },
  { name: "compact", summary: "Compact the context to free space", usage: "Usage: /compact" },
  { name: "help", summary: "List the available commands", usage: "Usage: /help" },
];
/** hello.presets, in config order; each thread starts on DEFAULT_PRESET */
const PRESETS = [
  { name: "fast", label: "Fast", model: "anthropic/claude-haiku-5-5", thinking: "off" },
  { name: "smart", label: "Smart", model: "anthropic/claude-sonnet-5-5", thinking: "low" },
  { name: "deep", label: "Deep", model: "anthropic/claude-opus-5-5", thinking: "high" },
];
const DEFAULT_PRESET = "smart";
/** live streams: { ws, token, helloed } */
const sockets = new Set();
const rateFailures = [];

const iso = () => new Date().toISOString();

function addThread(id, title, origin) {
  const at = iso();
  const thread = { info: { id, title, archived: false, origin, createdAt: at, lastAt: at }, state: "idle", running: null, queue: [], preset: DEFAULT_PRESET };
  threads.set(id, thread);
  return thread;
}
const main = addThread("main", "Main");
const full = () => [...threads.values()].filter((t) => t !== main && !t.info.archived).length >= MAX_OPEN_THREADS;

function isDurable(ev) {
  return ev.event === "message" || ev.event === "settled" || ev.event === "divider" || ev.event === "thread";
}

function broadcast(ev) {
  if (isDurable(ev)) {
    ev.cursor = ++cursor;
    events.push(ev);
    // A new answer or notice is the only thing worth waking a sleeping
    // device for. A split message wakes once, on its first part.
    if (ev.event === "message" && (ev.role === "assistant" || ev.role === "notice") && !ev.part?.i) {
      void pushDevices(ev.thread);
    }
  }
  const frame = JSON.stringify(ev);
  for (const s of sockets) {
    if (s.helloed && s.ws.readyState === s.ws.OPEN) s.ws.send(frame);
  }
}

function emit(thread, event, fields = {}) {
  if (event === "status") thread.state = fields.state;
  if (fields.at) thread.info.lastAt = fields.at;
  broadcast({ type: "event", event, thread: thread.info.id, ...fields });
}

function threadChanged(thread) {
  // Keep a snapshot in replay, not a pointer to mutable metadata.
  broadcast({ type: "event", event: "thread", thread: { ...thread.info } });
}

function archiveIdle() {
  for (const t of threads.values()) {
    if (t === main || t.info.archived || t.running || t.queue.length) continue;
    if (Date.now() - Date.parse(t.info.lastAt) < IDLE_ARCHIVE_MS) continue;
    t.info.archived = true;
    t.info.archivedReason = "idle";
    threadChanged(t);
  }
}
if (IDLE_ARCHIVE_MS > 0) setInterval(archiveIdle, Math.min(IDLE_ARCHIVE_MS, 1000)).unref();

function notice(thread, text) {
  emit(thread, "message", { id: `n${cursor + 1}`, role: "notice", text, at: iso() });
}

// -- Web Push ---------------------------------------------------------------

/** A device with a hello'd, open stream gets no push. */
function streamOpen(token) {
  for (const s of sockets) {
    if (s.token === token && s.helloed && s.ws.readyState === s.ws.OPEN) return true;
  }
  return false;
}

/** Durable assistant/notice messages above this device's acked cursor. */
function unreadFor(token) {
  const acked = acks.get(token) ?? 0;
  let n = 0;
  for (const ev of events) {
    if (ev.cursor <= acked || ev.event !== "message") continue;
    if (ev.role !== "assistant" && ev.role !== "notice") continue;
    if (ev.part && ev.part.i !== 0) continue;
    n++;
  }
  return Math.min(n, PUSH_UNREAD_CAP);
}

/** Topic header: a newer push for one thread replaces an undelivered older one. */
const topicFor = (thread) => Buffer.from(thread, "utf8").toString("base64url").slice(0, 32);

/** Content-free payload, never message text (protocol v2, Notifications). */
async function pushDevices(thread) {
  if (!PUSH) return;
  for (const [token, sub] of subscriptions) {
    if (pushing.has(token) || streamOpen(token)) continue;
    const payload = { v: 2, thread, unread: unreadFor(token) };
    const device = tokens.get(token) ?? "device";
    pushing.add(token);
    console.log(`push → "${device}": thread ${thread}, unread ${payload.unread}`);
    try {
      await sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), {
        TTL: 24 * 60 * 60,
        urgency: "normal",
        topic: topicFor(thread),
      });
    } catch (err) {
      const status = err?.statusCode;
      if (status === 404 || status === 410) {
        // The push service dropped this subscription; forget it.
        subscriptions.delete(token);
        console.log(`push subscription gone (${status}); removed "${device}"`);
      } else {
        console.log(`push failed for "${device}": ${status ?? err?.message ?? "unknown error"}`);
      }
    } finally {
      pushing.delete(token);
    }
  }
}

// -- fake agent turns -------------------------------------------------------

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

function startTurn(thread) {
  const key = thread.queue.shift();
  if (!key) return;
  const text = answerFor(key);
  const words = text.split(/(?<=\s)/); // keep separators
  const turn = thread.running = { key, timers: [] };
  const at = (ms, fn) => turn.timers.push(setTimeout(fn, ms));

  emit(thread, "status", { state: "queued" });
  at(300, () => emit(thread, "status", { state: "thinking" }));
  for (let n = 1; n <= words.length; n++) {
    at(600 + n * 90, () => emit(thread, "preview", { key, text: words.slice(0, n).join("") }));
  }
  at(600 + words.length * 90 + 200, () => {
    emit(thread, "message", { id: `a-${key}`, role: "assistant", text, at: iso(), key });
    emit(thread, "settled", { key, outcome: "answered" });
    emit(thread, "status", { state: "idle" });
    thread.running = null;
    startTurn(thread);
  });
}

function abortTurn(thread) {
  if (!thread.running) return;
  for (const timer of thread.running.timers) clearTimeout(timer);
  emit(thread, "settled", { key: thread.running.key, outcome: "aborted" });
  emit(thread, "status", { state: "idle" });
  thread.running = null;
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
    `durable_device=${token}; Path=/v1; HttpOnly; SameSite=Strict; Max-Age=34560000`,
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
  const data = JSON.stringify({ type: "res", id, ok, ...extra });
  ws.send(Buffer.byteLength(data) <= FRAME_BYTES
    ? data
    : JSON.stringify({ type: "res", id, ok: false, error: "too_large" }));
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
    const thread = threads.get(frame.thread === undefined ? "main" : frame.thread);
    const invalid = () => reply(ws, frame.id, false, { error: "bad_request" });
    switch (frame.op) {
      case "hello": {
        if (frame.v !== 2) {
          ws.close(4426);
          return;
        }
        if (frame.cursor !== null && !Number.isInteger(frame.cursor)) {
          ws.close(4400);
          return;
        }
        conn.helloed = true;
        reply(ws, frame.id, true, { v: 2, device, head: cursor || null, agent: AGENT_NAME, commands: COMMANDS, presets: PRESETS });
        // replay: oldest first, one bounded batch; the client re-hellos
        // with its new cursor if the batch was full
        const from = frame.cursor ?? 0;
        for (const ev of events.filter((e) => e.cursor > from).slice(0, REPLAY_BATCH)) {
          ws.send(JSON.stringify(ev));
        }
        for (const t of threads.values()) {
          if (t === main || t.state !== "idle") {
            ws.send(JSON.stringify({ type: "event", event: "status", thread: t.info.id, state: t.state }));
          }
        }
        for (const t of threads.values()) {
          ws.send(JSON.stringify({ type: "event", event: "model", thread: t.info.id, preset: t.preset }));
        }
        break;
      }
      case "threads": {
        const { query } = frame;
        if (query !== undefined && (typeof query !== "string" || !TITLE_RE.test(query))) return invalid();
        const list = [...threads.values()].map((t) => t.info).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
        let archived = 0;
        reply(ws, frame.id, true, { threads: query === undefined
          ? list.filter((t) => !t.archived || archived++ < 200)
          : list.filter((t) => t.title.toLowerCase().includes(query.toLowerCase())).slice(0, 200) });
        break;
      }
      case "thread.create": {
        const { key, title = "New thread", from } = frame;
        if (typeof key !== "string" || !ID_RE.test(key) || typeof title !== "string" || !TITLE_RE.test(title)) return invalid();
        const existing = created.get(key);
        if (existing) return reply(ws, frame.id, true, { thread: existing, duplicate: true });
        if (full()) return invalid();
        let origin;
        if (from !== undefined) {
          if (!from || typeof from.messageId !== "string" || !threads.has(from.thread)) return invalid();
          const anchor = events.find((e) => e.event === "message" && e.thread === from.thread &&
            e.id === from.messageId && (e.role === "user" || e.role === "assistant"));
          if (!anchor) return invalid();
          origin = { thread: from.thread, messageId: from.messageId };
        }
        const id = `t_${randomBytes(12).toString("hex")}`;
        const added = addThread(id, title, origin);
        created.set(key, id);
        reply(ws, frame.id, true, { thread: id, duplicate: false });
        threadChanged(added);
        emit(added, "model", { preset: added.preset });
        break;
      }
      case "thread.rename": {
        if (!thread || thread === main || typeof frame.title !== "string" || !TITLE_RE.test(frame.title)) return invalid();
        thread.info.title = frame.title;
        reply(ws, frame.id, true);
        threadChanged(thread);
        break;
      }
      case "thread.archive": {
        const { archived } = frame;
        if (!thread || thread === main || typeof archived !== "boolean" || (!archived && thread.info.archived && full())) return invalid();
        if (archived) {
          abortTurn(thread);
          for (const key of thread.queue.splice(0)) emit(thread, "settled", { key, outcome: "aborted" });
        }
        thread.info.archived = archived;
        if (archived) thread.info.archivedReason = "manual";
        else {
          delete thread.info.archivedReason;
          thread.info.lastAt = iso();
        }
        reply(ws, frame.id, true);
        threadChanged(thread);
        break;
      }
      case "send": {
        const { key, text } = frame;
        if (!thread || thread.info.archived || typeof key !== "string" || !ID_RE.test(key) || typeof text !== "string") return invalid();
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
        emit(thread, "message", { id: `u-${key}`, role: "user", text, at: iso(), key });
        thread.queue.push(key);
        if (!thread.running) startTurn(thread);
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
        const args = frame.args === undefined ? "" : frame.args;
        if (!COMMANDS.some((c) => c.name === cmd)) return reply(ws, frame.id, false, { error: "unsupported" });
        if (!thread || thread.info.archived || typeof args !== "string" || args.length > 1000) return invalid();
        reply(ws, frame.id, true);
        const a = args.trim();
        if (cmd === "abort") {
          if (thread.running) {
            abortTurn(thread);
            notice(thread, "Turn aborted.");
            startTurn(thread);
          } else {
            notice(thread, "Nothing is running.");
          }
        } else if (cmd === "new") {
          emit(thread, "divider", { at: iso(), reason: "new" });
          notice(thread, "New context started.");
        } else if (cmd === "model") {
          if (!a) notice(thread, `Model: ${thread.preset}. Presets: ${PRESETS.map((p) => p.name).join(", ")}.`);
          else if (PRESETS.some((p) => p.name === a)) {
            thread.preset = a;
            notice(thread, `Model set to ${a}.`);
            emit(thread, "model", { preset: a });
          } else notice(thread, COMMANDS.find((c) => c.name === "model").usage);
        } else if (cmd === "digest") {
          notice(thread, `Digest: ${events.filter((e) => e.thread === thread.info.id).length} events in this thread, ${threads.size} threads.`);
        } else if (cmd === "compact") {
          notice(thread, "Context compacted: older turns summarised.");
        } else if (cmd === "help") {
          notice(thread, COMMANDS.map((c) => `/${c.name}${c.args ? ` ${c.args}` : ""} — ${c.summary}`).join("\n"));
        } else {
          notice(thread, thread.running ? `Running: turn for ${thread.running.key}.` : "Idle.");
        }
        break;
      }
      case "ping": {
        reply(ws, frame.id, true);
        break;
      }
      case "push.key": {
        if (!PUSH || !vapid) return reply(ws, frame.id, false, { error: "unsupported" });
        reply(ws, frame.id, true, { key: vapid.publicKey });
        break;
      }
      case "push.subscribe": {
        if (!PUSH) return reply(ws, frame.id, false, { error: "unsupported" });
        const sub = frame.subscription;
        const key = sub?.keys;
        const ok = !!sub && typeof sub === "object"
          && typeof sub.endpoint === "string" && /^https:\/\//.test(sub.endpoint)
          && sub.endpoint.length <= PUSH_ENDPOINT_MAX
          && !!key && typeof key === "object"
          && typeof key.p256dh === "string" && key.p256dh.length <= PUSH_P256DH_MAX && B64URL.test(key.p256dh)
          && typeof key.auth === "string" && key.auth.length <= PUSH_AUTH_MAX && B64URL.test(key.auth);
        if (!ok) return invalid();
        // One subscription per device; a new one replaces the old.
        subscriptions.set(token, { endpoint: sub.endpoint, keys: { p256dh: key.p256dh, auth: key.auth } });
        reply(ws, frame.id, true);
        console.log(`push subscription set for "${device}"`);
        break;
      }
      case "push.unsubscribe": {
        if (!PUSH) return reply(ws, frame.id, false, { error: "unsupported" });
        subscriptions.delete(token); // idempotent
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
  if (!PUSH) console.log("push: disabled (NO_PUSH=1)");
});
