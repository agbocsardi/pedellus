#!/usr/bin/env node
// Development mock of the pedellus gateway's /v1 surface, speaking
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
const AGENT_NAME = process.env.AGENT_NAME?.trim() || "Pedellus";
if ([...AGENT_NAME].length > 40) throw new Error("AGENT_NAME must be at most 40 characters");
const FRAME_BYTES = 262_144;
const SEND_TEXT_CHARS = 16_000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REPLAY_BATCH = 500;
const MAX_MESSAGE_PARTS = 64;
const IDLE_ARCHIVE_MS = Number(process.env.IDLE_ARCHIVE_MS ?? 14 * 24 * 60 * 60 * 1000);
// Push is on by default, with throwaway VAPID keys made at start. Set NO_PUSH=1
// to make `push.key`/`push.subscribe` answer `unsupported`, like a gateway
// without push configured.
const PUSH = process.env.NO_PUSH !== "1";
const PUSH_ENDPOINT_MAX = 2_048;
const PUSH_P256DH_MAX = 128;
const PUSH_AUTH_MAX = 64;
const PUSH_UNREAD_CAP = 99;
// One device's send is abandoned after this, so a push service that never
// answers cannot hold that device in flight.
const PUSH_TIMEOUT_MS = Number(process.env.PUSH_TIMEOUT_MS ?? 10_000);
const B64URL = /^[A-Za-z0-9_-]+$/;
const LABEL_RE = /^[^\p{Cc}\u2028\u2029]{1,40}$/u;
const TITLE_RE = /^[^\p{Cc}\u2028\u2029]{1,80}$/u;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // [A-Z2-9] minus I, O
// Files (protocol v2, Files). The app enforces the same bounds before sending.
const UPLOAD_BYTES = 20 * 1024 * 1024;
const UPLOAD_NAME_CHARS = 120;
const UPLOADS_PER_MINUTE = 30;
const MAX_ATTACHMENTS = 10;
const UPLOAD_ID_RE = /^f_[A-Za-z0-9_-]{22}$/;
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
/** NO_UPLOADS=1 stands in for a gateway without media storage configured. */
const UPLOADS = process.env.NO_UPLOADS !== "1";
const MIME_RE = /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+_-]+$/;
// v2.md, Agent files and artifacts: the header the real gateway sends for `?view=artifact`.
const ARTIFACT_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; " +
  "frame-ancestors 'self'";

const pairCode =
  process.argv[2] ||
  Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
const pairExpires = Date.now() + 10 * 60 * 1000;
let pairUsed = false;
console.log(`pair code (single use, 10 min): ${pairCode}`);

/** token -> device label */
const tokens = new Map();
/** send key -> { text, attachments } (idempotency for at least the mock's lifetime) */
const admitted = new Map();
/** upload id -> { token, name, type, size, bytes, at, used }; memory only */
const files = new Map();
/** device token -> upload timestamps in the last minute */
const uploadTimes = new Map();
/** token -> highest acked cursor */
const acks = new Map();
/** `${thread}:${id}` -> open owner question, for the mock's `answer` */
const questions = new Map();
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
  const thread = {
    info: { id, title, archived: false, origin, createdAt: at, lastAt: at },
    state: "idle", running: null, queue: [], preset: DEFAULT_PRESET, tasks: [],
  };
  threads.set(id, thread);
  return thread;
}

/** Fake background work for the Tasks view; no task event stream, the app refetches. */
let fakeTaskId = 0;
const TASK_ID_RE = /^[wc]:[A-Za-z0-9_-]{1,80}$/;
const TASK_ACTIVE = new Set(["running", "queued", "scheduled"]);

function addFakeTasks(thread) {
  const now = Date.now();
  thread.tasks.push({
    id: `w:${++fakeTaskId}`,
    kind: "worker",
    title: "Check the deploy log for failed jobs",
    state: "running",
    createdAt: iso(),
    detail: "shared workspace",
  });
  thread.tasks.push({
    id: `c:cron-${randomBytes(8).toString("hex")}`,
    kind: "cron",
    title: "Standup reminder",
    state: "scheduled",
    createdAt: new Date(now + 60_000).toISOString(),
    nextAt: new Date(now + 3_600_000).toISOString(),
    detail: "every hour",
  });
}

/** This thread's own tasks, newest first; never another thread's. */
function tasksFor(thread) {
  if (!thread) return [];
  return [...thread.tasks]
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, 50);
}
const main = addThread("main", "Main");
const full = () => [...threads.values()].filter((t) => t !== main && !t.info.archived).length >= MAX_OPEN_THREADS;

/** The owner's reaction palette (protocol v2, Reactions). */
const REACTIONS = ["👍", "👎", "❤️", "😂", "🤔", "🎉"];

function isDurable(ev) {
  return ev.event === "message" || ev.event === "settled" || ev.event === "divider" ||
    ev.event === "reaction" || ev.event === "thread" || ev.event === "question";
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

/** Six escaped bytes per UTF-16 unit is the worst case, so this keeps every part frame small. */
const PART_CHARS = 24_000;

/** Split one long text into parts, never between the halves of a surrogate pair (v2.md). */
function splitText(text) {
  const parts = [];
  let index = 0;
  while (index < text.length && parts.length < MAX_MESSAGE_PARTS) {
    let end = Math.min(text.length, index + PART_CHARS);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    parts.push(text.slice(index, end));
    index = end;
  }
  return parts;
}

/** Emit one durable `message`, as its parts when it is too long for a single frame. */
function emitMessage(thread, { text, ...fields }) {
  const parts = splitText(text);
  if (parts.length < 2) {
    emit(thread, "message", { ...fields, text });
    return;
  }
  // Steps live on the first part only, like the gateway's split messages.
  const { steps, omitted, ...rest } = fields;
  parts.forEach((part, i) => emit(thread, "message", i === 0
    ? { ...fields, text: part, part: { i, n: parts.length } }
    : { ...rest, text: part, part: { i, n: parts.length } }));
}

/**
 * Three fake tool steps for a "use tools" turn, one of them failing, so the app's collapsed line,
 * step list and step detail have something real to render. They are non-durable, like the
 * gateway's `activity` events; the final answer carries the same bounded list.
 */
function toolSteps(base) {
  const at = (ms) => new Date(base + ms).toISOString();
  const step = (id, tool, state, started, ended) => ({
    id, tool, state, startedAt: at(started), ...(ended === undefined ? {} : { endedAt: at(ended) }),
  });
  return [
    () => [step("s1", "read", "running", 300)],
    () => [step("s1", "read", "done", 300, 640), step("s2", "bash", "running", 660)],
    () => [
      step("s1", "read", "done", 300, 640),
      step("s2", "bash", "failed", 660, 980),
      step("s3", "web_search", "running", 990),
    ],
    () => [
      step("s1", "read", "done", 300, 640),
      step("s2", "bash", "failed", 660, 980),
      step("s3", "web_search", "done", 990, 1330),
    ],
  ];
}

function startTurn(thread) {
  const key = thread.queue.shift();
  if (!key) return;
  const asked = admitted.get(key)?.text ?? "";
  const text = answerFor(key);
  // Stream a bounded number of preview ticks, whatever the answer's length.
  const width = Math.max(1, Math.ceil(text.length / 40));
  const chunks = text.match(new RegExp(`[\\s\\S]{1,${width}}`, "g")) ?? [""];
  const turn = thread.running = { key, timers: [] };
  const at = (ms, fn) => turn.timers.push(setTimeout(fn, ms));

  emit(thread, "status", { state: "queued" });
  at(300, () => emit(thread, "status", { state: "thinking" }));
  const artifact = /make artifact/i.test(asked) ? sendArtifact("downloads.html", "text/html", ARTIFACT_HTML) : undefined;
  const tools = /use tools/i.test(asked) ? toolSteps(Date.now()) : undefined;
  if (tools) {
    const labels = ["read", "bash", "web_search"];
    tools.forEach((steps, index) => at(320 + index * 340, () => {
      emit(thread, "status", { state: "tool", label: labels[Math.min(index, 2)] });
      broadcast({ type: "event", event: "activity", thread: thread.info.id, key, steps: steps() });
    }));
  }
  for (let n = 1; n <= chunks.length; n++) {
    at(600 + n * 90, () => emit(thread, "preview", { key, text: chunks.slice(0, n).join("") }));
  }
  at(600 + chunks.length * 90 + 200, () => {
    emitMessage(thread, {
      id: `a-${key}`, role: "assistant", text, at: iso(), key,
      ...(artifact === undefined ? {} : { attachments: [artifact] }),
      ...(tools === undefined ? {} : { steps: tools[3]() }),
    });
    emit(thread, "settled", { key, outcome: "answered" });
    emit(thread, "status", { state: "idle" });
    thread.running = null;
    startTurn(thread);
  });
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

/**
 * One device. Runs beside the others (not after them) and is bounded by its own
 * socket timeout, so a hung endpoint delays nobody and frees its in-flight flag.
 */
async function pushOne(token, sub, thread) {
  pushing.add(token);
  const payload = { v: 2, thread, unread: unreadFor(token) };
  const device = tokens.get(token) ?? "device";
  console.log(`push → "${device}": thread ${thread}, unread ${payload.unread}`);
  try {
    await sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), {
      TTL: 24 * 60 * 60,
      urgency: "normal",
      topic: topicFor(thread),
      timeout: PUSH_TIMEOUT_MS,
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

/** Content-free payload, never message text (protocol v2, Notifications). */
async function pushDevices(thread) {
  if (!PUSH) return;
  const sends = [];
  for (const [token, sub] of subscriptions) {
    if (pushing.has(token) || streamOpen(token)) continue;
    sends.push(pushOne(token, sub, thread));
  }
  await Promise.allSettled(sends);
}

// -- fake agent turns -------------------------------------------------------

/** A long answer for the mock: multi-byte text and emoji, several parts big. */
function longAnswer(asked) {
  const unit = 'Absatz mit Grüßen, 🙂👋🏽 Emoji, "Zitat" und Umlauten — 日本語.';
  const rows = [`A deliberately long answer to **${asked.slice(0, 40)}**, sent as parts.`, ""];
  while (rows.join("\n").length < 160_000) rows.push(`${rows.length}. ${unit}`);
  return rows.join("\n");
}

/**
 * A small interactive chart the "agent" made: one artifact (.html) sent as a durable
 * assistant message attachment (v2.md, Agent files and artifacts). It needs no network
 * and no same-origin access, so the sandboxed frame is all it gets.
 */
const ARTIFACT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Weekly downloads</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 14px; font: 14px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #f7f6f3; color: #22211e; }
  @media (prefers-color-scheme: dark) { body { background: #212422; color: #eae8e2; } }
  h1 { margin: 0 0 2px; font-size: 15px; font-weight: 600; }
  p.sub { margin: 0 0 10px; font-size: 12px; opacity: 0.65; }
  .bars { display: flex; align-items: flex-end; gap: 6px; height: 120px; }
  .bar { flex: 1; display: flex; align-items: flex-end; height: 100%; }
  .bar span { width: 100%; border-radius: 4px 4px 0 0; background: #0e7a6a; transition: height 0.18s ease; }
  @media (prefers-color-scheme: dark) { .bar span { background: #4fbfa9; } }
  .days { display: flex; gap: 6px; margin-top: 4px; font-size: 10px; opacity: 0.6; }
  .days span { flex: 1; text-align: center; }
  .row { display: flex; gap: 8px; margin-top: 12px; }
  button { flex: 1; min-height: 32px; border: 1px solid currentColor; border-radius: 8px;
    background: none; color: inherit; font: inherit; opacity: 0.8; }
  button[aria-pressed="true"] { opacity: 1; font-weight: 600; border-width: 2px; }
</style>
</head>
<body>
<h1>Weekly downloads</h1>
<p class="sub" id="caption">This month</p>
<div class="bars" id="bars"></div>
<div class="days" id="days"></div>
<div class="row">
  <button data-set="0" aria-pressed="true">This month</button>
  <button data-set="1" aria-pressed="false">Last month</button>
</div>
<script>
  var days = ["M", "T", "W", "T", "F", "S", "S"];
  var sets = [[12, 18, 9, 24, 30, 21, 35], [8, 14, 22, 11, 19, 27, 16]];
  var bars = document.getElementById("bars");
  var labels = document.getElementById("days");
  var caption = document.getElementById("caption");
  days.forEach(function (day) {
    var cell = document.createElement("span");
    cell.textContent = day;
    labels.appendChild(cell);
  });
  sets[0].forEach(function () {
    bars.appendChild(document.createElement("div")).className = "bar";
  });
  function draw(set) {
    var max = Math.max.apply(null, sets[set]);
    Array.prototype.forEach.call(bars.children, function (bar, i) {
      var fill = bar.firstChild || bar.appendChild(document.createElement("span"));
      fill.style.height = Math.round((sets[set][i] / max) * 100) + "%";
    });
    caption.textContent = set === 0 ? "This month" : "Last month";
  }
  Array.prototype.forEach.call(document.querySelectorAll("button"), function (button) {
    button.addEventListener("click", function () {
      Array.prototype.forEach.call(document.querySelectorAll("button"), function (other) {
        other.setAttribute("aria-pressed", String(other === button));
      });
      draw(Number(button.dataset.set));
    });
  });
  draw(0);
</script>
</body>
</html>
`;

/** Store one artifact in memory and describe it as an `AttachmentInfo` of kind "artifact". */
function sendArtifact(name, type, body) {
  const bytes = Buffer.from(body, "utf8");
  const id = `f_${randomBytes(16).toString("base64url")}`;
  // No owner token: v2.md lets any paired device fetch a referenced file.
  files.set(id, { token: null, name, type, size: bytes.length, bytes, at: Date.now(), used: true, artifact: true });
  return { id, name, type, size: bytes.length, kind: "artifact" };
}

function answerFor(key) {
  const sent = admitted.get(key);
  const asked = sent?.text ?? "…";
  // A voice note on its own: the mock cannot transcribe it, so say it was heard.
  if (!asked.trim() && sent?.attachments?.some((f) => f.kind === "audio")) return "(heard a voice note)";
  // Ask for "use tools" to get three activity steps before the answer.
  if (/use tools/i.test(asked)) return "Used three mock tools, and one of them failed.";
  // Ask for "make artifact" to get the card, the viewer and the sandboxed frame.
  if (/make artifact/i.test(asked)) {
    return "Made it an artifact: **downloads.html** runs only inside the sandboxed frame, " +
      "with no network, no cookie and no access to this app.";
  }
  // Ask for "a long answer" to exercise a split durable message.
  if (/long answer/i.test(asked)) return longAnswer(asked);
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

function abortTurn(thread) {
  if (!thread.running) return;
  for (const timer of thread.running.timers) clearTimeout(timer);
  emit(thread, "settled", { key: thread.running.key, outcome: "aborted" });
  emit(thread, "status", { state: "idle" });
  thread.running = null;
}

// -- HTTP: pairing ----------------------------------------------------------

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const kindOf = (type) =>
  type.startsWith("image/") ? "image" : type.startsWith("audio/") ? "audio" : "file";

/** Unreferenced uploads are discarded after 24 h (v2.md, Files). */
function pruneUploads() {
  const now = Date.now();
  for (const [id, file] of files) {
    if (!file.used && now - file.at > UPLOAD_TTL_MS) files.delete(id);
  }
}
if (UPLOADS) setInterval(pruneUploads, 60_000).unref();

/** `X-Filename` is percent-encoded UTF-8; 1–120 characters after decoding. */
function uploadName(req) {
  const raw = req.headers["x-filename"];
  if (typeof raw !== "string") return null;
  let name;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  const chars = [...name].length;
  return chars >= 1 && chars <= UPLOAD_NAME_CHARS ? name : null;
}

function mediaType(req) {
  const raw = req.headers["content-type"];
  const type = typeof raw === "string" ? raw.split(";")[0].trim().toLowerCase() : "";
  return type.length <= 100 && MIME_RE.test(type) ? type : null;
}

/** Raw request bytes, capped; rejects with `tooLarge` instead of buffering past it. */
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (d) => {
      size += d.length;
      if (size > limit) {
        const err = new Error("too_large");
        err.tooLarge = true;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function disposition(file) {
  // v2.md: inline for image/* except SVG (it is scriptable) and for audio/*.
  if ((file.type.startsWith("image/") && file.type !== "image/svg+xml") || file.type.startsWith("audio/")) {
    return "inline";
  }
  const ascii = file.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`;
}

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

async function pair(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "bad_request" });
    return;
  }
  const { code, label } = body ?? {};
  if (
    typeof code !== "string" ||
    typeof label !== "string" ||
    !LABEL_RE.test(label.trim())
  ) {
    json(res, 400, { error: "bad_request" });
    return;
  }
  // rate limit: more than 5 failures per minute across all clients
  const now = Date.now();
  while (rateFailures.length && rateFailures[0] < now - 60_000) rateFailures.shift();
  const codeOk =
    !pairUsed && Date.now() < pairExpires && code.trim().toUpperCase() === pairCode;
  if (!codeOk) {
    rateFailures.push(now);
    const status = rateFailures.length > 5 ? 429 : 401;
    json(res, status, { error: status === 429 ? "rate_limited" : "invalid_code" });
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
}

/** `POST /v1/upload`: raw bytes, cookie-authenticated, memory only. */
async function upload(req, res) {
  if (!UPLOADS) return json(res, 400, { error: "unsupported" });
  const token = cookieToken(req);
  if (!token || !tokens.has(token)) return json(res, 401, { error: "unauthorized" });
  const now = Date.now();
  const recent = (uploadTimes.get(token) ?? []).filter((at) => at > now - 60_000);
  uploadTimes.set(token, recent);
  if (recent.length >= UPLOADS_PER_MINUTE) return json(res, 429, { error: "rate_limited" });
  const name = uploadName(req);
  const type = mediaType(req);
  if (!name || !type) return json(res, 400, { error: "bad_request" });
  if (Number(req.headers["content-length"]) > UPLOAD_BYTES) return json(res, 413, { error: "too_large" });
  let bytes;
  try {
    bytes = await readRaw(req, UPLOAD_BYTES);
  } catch (err) {
    return json(res, err?.tooLarge ? 413 : 400, { error: err?.tooLarge ? "too_large" : "bad_request" });
  }
  recent.push(now);
  pruneUploads();
  const id = `f_${randomBytes(16).toString("base64url")}`;
  files.set(id, { token, name, type, size: bytes.length, bytes, at: now, used: false });
  json(res, 201, { id });
}

/** `GET /v1/files/<id>`: only files a durable message references. */
function download(req, res, url) {
  const token = cookieToken(req);
  if (!token || !tokens.has(token)) return json(res, 401, { error: "unauthorized" });
  const id = url.pathname.slice("/v1/files/".length);
  const file = UPLOAD_ID_RE.test(id) ? files.get(id) : undefined;
  if (!file || !file.used) return json(res, 404, { error: "bad_request" });
  // `?view=artifact` is the only way an artifact is ever rendered; without it the
  // bytes download like any other document (v2.md, Agent files and artifacts).
  const asArtifact = file.artifact === true && url.searchParams.get("view") === "artifact";
  res.writeHead(200, {
    "Content-Type": file.type,
    "Content-Length": file.size,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": asArtifact ? ARTIFACT_CSP : "sandbox",
    "Cache-Control": "private, max-age=31536000, immutable",
    "Content-Disposition": asArtifact ? "inline" : disposition(file),
  });
  res.end(file.bytes);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/v1/pair" && req.method === "POST") return await pair(req, res);
    if (url.pathname === "/v1/upload" && req.method === "POST") return await upload(req, res);
    if (url.pathname.startsWith("/v1/files/") && req.method === "GET") return download(req, res, url);
  } catch (err) {
    console.error("request failed", err?.message ?? "unknown");
  }
  res.writeHead(404).end();
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
        reply(ws, frame.id, true, { v: 2, device, head: cursor || null, agent: AGENT_NAME, commands: COMMANDS, presets: PRESETS, uploads: UPLOADS });
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
        const { key, text, attachments } = frame;
        if (!thread || thread.info.archived || typeof key !== "string" || !ID_RE.test(key) || typeof text !== "string") return invalid();
        if (text.length > SEND_TEXT_CHARS) {
          reply(ws, frame.id, false, { error: "too_large" });
          return;
        }
        // A repeated key stays `duplicate` whatever it is carrying now
        // (v2.md, "Attach"), so this check comes before the ids are consumed.
        if (admitted.has(key)) {
          reply(ws, frame.id, true, { duplicate: true });
          return;
        }
        let info;
        if (attachments !== undefined) {
          if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS) return invalid();
          pruneUploads();
          const seen = new Set();
          for (const id of attachments) {
            if (typeof id !== "string" || !UPLOAD_ID_RE.test(id) || seen.has(id)) return invalid();
            seen.add(id);
            const file = files.get(id);
            // Unknown, foreign, expired or already used: the whole send fails.
            if (!file || file.token !== token || file.used) return invalid();
          }
          info = attachments.map((id) => {
            const file = files.get(id);
            file.used = true;
            return { id, name: file.name, type: file.type, size: file.size, kind: kindOf(file.type) };
          });
        }
        admitted.set(key, { text, attachments: info ?? [] });
        reply(ws, frame.id, true, { duplicate: false });
        // Dev affordance: "mcp login" offers a fake one-time authorization URL as a non-durable
        // `login` frame, the same shape the gateway's app login surface sends. It is never stored.
        if (/mcp login/i.test(text)) {
          emit(thread, "login", {
            server: "mock-remote",
            url: "https://example.com/oauth/authorize?state=mock-login&code=mock-login",
            expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          });
        }
        // Dev affordance: a message asking to start work seeds the Tasks sheet with one worker and
        // one scheduled job in this thread.
        if (/start task/i.test(text) && thread.tasks.length === 0) addFakeTasks(thread);
        emit(thread, "message", {
          id: `u-${key}`, role: "user", text, at: iso(), key,
          ...(info?.length ? { attachments: info } : {}),
        });
        // "ask me …" exercises the owner-question card: an open question ends the turn and the
        // owner's tap (see `answer`) or a typed message does the rest.
        if (/\bask me\b/i.test(text)) {
          const id = randomBytes(5).toString("hex");
          const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
          const options = [
            { id: "a", label: "Deploy now", description: "publish the current build" },
            { id: "b", label: "Wait", description: "keep the current build running" },
          ];
          questions.set(`${thread.info.id}:${id}`, { id, prompt: "Deploy the current build now?", options, expiresAt, state: "open" });
          emit(thread, "question", { id, prompt: "Deploy the current build now?", options, expiresAt, state: "open" });
          emit(thread, "settled", { key, outcome: "answered" });
          break;
        }
        thread.queue.push(key);
        if (!thread.running) startTurn(thread);
        break;
      }
      case "react": {
        const { message, emoji } = frame;
        if (!thread || thread.info.archived || typeof message !== "string") return invalid();
        if (emoji !== null && !REACTIONS.includes(emoji)) return invalid();
        // The target must be a durable message of this thread, like the real gateway requires.
        if (!events.some((e) => e.event === "message" && e.thread === thread.info.id && e.id === message)) return invalid();
        reply(ws, frame.id, true);
        emit(thread, "reaction", { message, by: "owner", emoji });
        break;
      }
      case "answer": {
        // One owner question from the mock: the send that contained "ask me" opened it.
        const { question, option } = frame;
        if (!thread || thread.info.archived || typeof question !== "string" || !/^[0-9a-f]{10}$/.test(question) ||
            !["a", "b", "c", "d"].includes(option)) return invalid();
        const found = questions.get(`${thread.info.id}:${question}`);
        if (!found || found.state !== "open") {
          reply(ws, frame.id, true, { accepted: false });
          notice(thread, "This question is no longer open.");
          break;
        }
        found.state = "answered";
        reply(ws, frame.id, true, { accepted: true });
        // The state change is the answered event; then the chosen option starts one follow-up turn.
        emit(thread, "question", {
          id: found.id, prompt: found.prompt, options: found.options,
          expiresAt: found.expiresAt, state: "answered", answer: option,
        });
        const label = found.options.find((candidate) => candidate.id === option)?.label ?? option;
        emitMessage(thread, {
          id: `q-answer-${found.id}`, role: "assistant", at: iso(),
          text: `Noted — you chose **${label}**. The mock gateway has no real turn behind this answer.`,
        });
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
      case "tasks": {
        if (frame.thread !== undefined && typeof frame.thread !== "string") return invalid();
        reply(ws, frame.id, true, { tasks: tasksFor(thread) });
        break;
      }
      case "task.cancel": {
        const id = frame.task;
        if (typeof id !== "string" || !TASK_ID_RE.test(id)) return invalid();
        const task = thread?.tasks.find((entry) => entry.id === id);
        if (!task) {
          reply(ws, frame.id, true, { outcome: "unknown" });
          if (thread) notice(thread, "No such task in this thread; nothing was changed.");
          break;
        }
        if (!TASK_ACTIVE.has(task.state)) {
          reply(ws, frame.id, true, { outcome: "finished" });
          notice(thread, `Task "${task.title}" had already finished; nothing was cancelled.`);
          break;
        }
        task.state = "cancelled";
        task.lastAt = iso();
        reply(ws, frame.id, true, { outcome: "cancelled" });
        notice(thread, `Cancelled task "${task.title}".`);
        break;
      }
      case "history": {
        reply(ws, frame.id, false, { error: "unsupported" });
        break;
      }
      default: {
        ws.close(4400); // unknown op is a protocol violation
      }
    }
  });
}

// DEMO_THREADS=1 seeds side threads for the phone's thread bubbles: badged and not, unread (they
// have a message this device has not seen), one running (a turn that never ends until aborted),
// one empty and one archived, all in the past so the order is fixed. Main gets a short exchange.
if (process.env.DEMO_THREADS === "1") {
  const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
  const say = (thread, role, text, min) => emit(thread, "message", { id: `d${cursor + 1}`, role, text, at: ago(min) });
  say(main, "user", "Plan this week's groceries around two dinners with guests.", 50);
  say(main, "assistant", "Here is a list by aisle, with the two guest dinners first.", 49);
  const demo = [
    { title: "🪪 Check", badge: { emoji: "🪪", verb: "Check" }, min: 2, ask: "Do I need an appointment to pick up my driver's license?" },
    { title: "Flights to Lisbon", badge: { emoji: "✈️", verb: "Book" }, min: 5, ask: "Find flights to Lisbon for the long weekend.", running: true },
    { title: "Tax receipts 2026", min: 12, ask: "Which receipts do I keep for the 2026 tax return?" },
    { title: "🚲 Bike repair", min: 30 },
    { title: "Phone plans", badge: { emoji: "🧾", verb: "Compare" }, min: 90 },
    { title: "New thread", min: 180 },
    { title: "Trip notes", badge: { emoji: "🗺️", verb: "Plan" }, min: 600, archived: true },
  ];
  demo.forEach(({ title, badge, min, ask, running, archived }, i) => {
    const t = addThread(`t_demo${i}`, title);
    Object.assign(t.info, { createdAt: ago(min + 1), lastAt: ago(min), ...(badge ? { badge } : {}) });
    if (archived) Object.assign(t.info, { archived: true, archivedReason: "idle" });
    threadChanged(t);
    if (ask) say(t, "user", ask, min);
    if (!running) return;
    t.running = { key: "demo-running", timers: [] };
    t.state = "tool";
  });
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock gateway on http://127.0.0.1:${PORT} (pair code ${pairCode})`);
  if (!PUSH) console.log("push: disabled (NO_PUSH=1)");
});
