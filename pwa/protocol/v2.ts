// Wire protocol v2 shapes (v1 + threads). Normative text: ./v2.md
export const PROTOCOL_VERSION = 2;

export const LIMITS = {
  frameBytes: 262_144,
  sendTextChars: 16_000,
  idPattern: /^[A-Za-z0-9_-]{1,64}$/,
  replayBatch: 500,
  pingIntervalMs: 25_000,
  pingTimeoutMs: 10_000,
  threadTitleChars: 80,
  /** `ThreadInfo.badge.emoji` and `.verb`: short display text, no controls. */
  threadBadgeEmojiChars: 8,
  threadBadgeVerbChars: 32,
  maxOpenThreads: 50,
  /** Archived threads in a `threads` reply, newest activity first; not a storage cap. */
  maxListedArchivedThreads: 200,
  threadIdPattern: /^(main|t_[A-Za-z0-9_-]{1,40})$/,
  /** One-time pairing code: `PAIR_ALPHABET`, single use, ten minutes. */
  pairCodeChars: 8,
  pairTtlMs: 10 * 60_000,
  /** Device label: printable, 1–40 characters. */
  labelMinChars: 1,
  labelMaxChars: 40,
  /** `hello.agent`, the gateway's display name: 1–40 printable characters. */
  agentNameMaxChars: 40,
  /** `control.args`: the text after the command name. */
  controlArgsChars: 1_000,
  /** A split `message` has at most this many parts (see v2.md, Long messages). */
  maxMessageParts: 64,
  /** `push.subscribe` bounds. */
  pushEndpointChars: 2_048,
  pushP256dhChars: 128,
  pushAuthChars: 64,
  /** `unread` in a push payload is capped here. */
  pushUnreadCap: 99,
  /** Files (see v2.md, Files). */
  uploadBytes: 20 * 1024 * 1024,
  uploadNameChars: 120,
  uploadsPerMinute: 30,
  maxAttachments: 10,
  /** An agent artifact (.html/.svg) the app renders in a sandboxed frame. */
  artifactBytes: 2 * 1024 * 1024,
  /** Owner questions (ASK_USER.md bounds): prompt, option label, option description. */
  questionPromptChars: 500,
  questionLabelChars: 60,
  questionDescriptionChars: 200,
  questionIdPattern: /^[0-9a-f]{10}$/,
  /** Tasks view: entries per reply, title and detail length. */
  maxListedTasks: 50,
  /** Shortcuts `POST /v1/ask`: how long it waits for the answer, and its per-token rate. */
  askWaitMs: 25_000,
  asksPerMinute: 10,
  /** Activity: tool steps kept per turn, tool name length. */
  maxActivitySteps: 50,
  activityToolChars: 64,
  activityStepIdChars: 64,
  taskTitleChars: 120,
  taskDetailChars: 200,
  /** `TaskInfo.id` and `task.cancel.task`: one namespaced id (`w:` worker, `c:` scheduled job). */
  taskIdPattern: /^[wc]:[A-Za-z0-9_-]{1,80}$/,
  uploadIdPattern: /^f_[A-Za-z0-9_-]{22}$/,
  /** `hello.presets`: at most this many entries; `name` and `model` printable, no whitespace. */
  maxPresets: 50,
  presetNameChars: 80,
  presetModelChars: 240,
  /** `PresetInfo.label` and `.thinking`: short display text. */
  presetLabelChars: 40,
  /** `CommandInfo.name`. */
  commandNamePattern: /^[a-z][a-z0-9_-]{0,22}$/,
} as const;

/** `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`: no `I`/`O`, case-insensitive input. */
export const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const CLOSE = {
  unauthorized: 4401,
  protocol: 4400,
  version: 4426,
  replaced: 4409,
} as const;

export type ErrorCode = "bad_request" | "too_large" | "unsupported" | "not_ready" | "internal";
export type ControlCommand = string;
export type CommandInfo = { name: string; args?: string; summary: string; usage: string };
export type PresetInfo = { name: string; label?: string; model: string; thinking?: string };
export const MAIN_THREAD = "main";
export type ThreadId = string;
export type ThreadOrigin = { thread: ThreadId; messageId: string };
/** A side thread's short display badge, picked by the gateway's classifier from fixed lists. */
export type ThreadBadge = { emoji: string; verb: string };
export type ThreadInfo = {
  id: ThreadId; title: string; archived: boolean; archivedReason?: "manual" | "idle";
  /** Absent until the gateway classifies the thread; `main` is never badged. */
  badge?: ThreadBadge;
  origin?: ThreadOrigin; createdAt: string; lastAt: string;
};

export type Request =
  | { type: "req"; id: string; op: "hello"; v: 2; cursor: number | null }
  | { type: "req"; id: string; op: "send"; key: string; text: string; thread?: ThreadId; attachments?: string[] }
  | { type: "req"; id: string; op: "ack"; cursor: number }
  | { type: "req"; id: string; op: "control"; command: ControlCommand; args?: string; thread?: ThreadId }
  | { type: "req"; id: string; op: "ping" }
  | { type: "req"; id: string; op: "threads"; query?: string }
  | { type: "req"; id: string; op: "thread.create"; key: string; title?: string; from?: ThreadOrigin }
  | { type: "req"; id: string; op: "thread.rename"; thread: ThreadId; title: string }
  | { type: "req"; id: string; op: "thread.archive"; thread: ThreadId; archived: boolean }
  | { type: "req"; id: string; op: "push.key" }
  | { type: "req"; id: string; op: "push.subscribe"; subscription: PushSubscriptionInfo }
  | { type: "req"; id: string; op: "push.unsubscribe" }
  | { type: "req"; id: string; op: "answer"; thread: ThreadId; question: string; option: QuestionOptionId }
  | { type: "req"; id: string; op: "react"; thread?: ThreadId; message: string; emoji: Reaction | null }
  | { type: "req"; id: string; op: "tasks"; thread?: ThreadId }
  | { type: "req"; id: string; op: "task.cancel"; thread?: ThreadId; task: string };

export type PushSubscriptionInfo = { endpoint: string; keys: { p256dh: string; auth: string } };
export type PushKeyResult = { key: string };
/** Content-free Web Push payload; never message text. */
export type PushPayload = { v: 2; thread: ThreadId; unread: number };

export type HelloResult = { v: 2; device: string; head: number | null; agent: string; commands: CommandInfo[]; presets: PresetInfo[]; uploads: boolean };
export type SendResult = { duplicate: boolean };
export type ThreadsResult = { threads: ThreadInfo[] };
export type ThreadCreateResult = { thread: ThreadId; duplicate: boolean };

export type ErrorResponse = { type: "res"; id: string; ok: false; error: ErrorCode };
/** Any reply, without knowing its request; prefer `ResponseMap[op]`, which is exact per op. */
export type Response =
  | ({ type: "res"; id: string; ok: true } & Partial<HelloResult & SendResult & ThreadsResult & ThreadCreateResult & PushKeyResult & AnswerResult & TasksResult & TaskCancelResult>)
  | ErrorResponse;

export type MessageEvent = {
  type: "event"; event: "message"; cursor: number; thread: ThreadId; id: string;
  role: "user" | "assistant" | "notice"; text: string; at: string; key?: string;
  /** Files sent with this message (first part only when split). */
  attachments?: AttachmentInfo[];
  /** Assistant only: the turn's tool steps (first part only when split). */
  steps?: ActivityStep[];
  omitted?: number;
  /** Present only on a split message: part `i` (from 0) of `n`. */
  part?: { i: number; n: number };
};
export type SettledEvent = {
  type: "event"; event: "settled"; cursor: number; thread: ThreadId; key: string;
  outcome: "answered" | "failed" | "aborted";
};
export type DividerEvent = { type: "event"; event: "divider"; cursor: number; thread: ThreadId; at: string; reason: "new" | "idle" };
export type PreviewEvent = { type: "event"; event: "preview"; thread: ThreadId; key: string; text: string };
export type StatusEvent = {
  type: "event"; event: "status"; thread: ThreadId;
  state: "idle" | "queued" | "thinking" | "tool" | "error"; label?: string;
};

export type ThreadEvent = { type: "event"; event: "thread"; cursor: number; thread: ThreadInfo };

export type QuestionOptionId = "a" | "b" | "c" | "d";
export type QuestionOption = { id: QuestionOptionId; label: string; description?: string };
export type QuestionEvent = {
  type: "event"; event: "question"; cursor: number; thread: ThreadId; id: string; prompt: string;
  options: QuestionOption[]; expiresAt: string;
  state: "open" | "answered" | "expired" | "cancelled" | "unknown"; answer?: QuestionOptionId;
};
export type AnswerResult = { accepted: boolean };

/** The owner's reaction palette (protocol v2, Reactions). */
export const REACTIONS = ["👍", "👎", "❤️", "😂", "🤔", "🎉"] as const;
export type Reaction = (typeof REACTIONS)[number];
export type ReactionEvent = {
  type: "event"; event: "reaction"; cursor: number; thread: ThreadId; message: string; by: "owner"; emoji: Reaction | null;
};

export type TaskInfo = {
  id: string; kind: "worker" | "cron"; title: string;
  state: "running" | "queued" | "scheduled" | "done" | "failed" | "cancelled";
  createdAt: string; nextAt?: string; lastAt?: string; detail?: string;
};
export type TasksResult = { tasks: TaskInfo[] };
export type TaskCancelResult = { outcome: "cancelled" | "finished" | "unknown" };

export type ActivityStep = {
  id: string; tool: string; state: "running" | "done" | "failed"; startedAt: string; endedAt?: string;
};
export type ActivityEvent = {
  type: "event"; event: "activity"; thread: ThreadId; key: string; steps: ActivityStep[]; omitted?: number;
};

export type LoginEvent = { type: "event"; event: "login"; thread: ThreadId; server: string; url: string; expiresAt: string };

export type ModelEvent = { type: "event"; event: "model"; thread: ThreadId; preset: string | null };

export type DurableEvent = MessageEvent | SettledEvent | DividerEvent | ThreadEvent | QuestionEvent | ReactionEvent;
export type Event = DurableEvent | PreviewEvent | StatusEvent | ModelEvent | ActivityEvent | LoginEvent;
export type ServerFrame = Response | Event;

export type AttachmentInfo = { id: string; name: string; type: string; size: number; kind: "image" | "audio" | "file" | "artifact" };
export type UploadResult = { id: string };
export type UploadError = "bad_request" | "unsupported" | "unauthorized" | "too_large" | "rate_limited";

export type AskRequest = { text: string; thread?: ThreadId; key?: string };
export type AskResult =
  | { outcome: "answered"; text: string }
  | { outcome: "failed" | "aborted" }
  | { outcome: "pending"; key: string };

export type PairRequest = { code: string; label: string };
export type PairError = "bad_request" | "invalid_code" | "rate_limited";

type NoResult = Record<never, never>;
/** Each request's `ok: true` result fields (v2.md, Requests). */
export interface ResultMap {
  hello: HelloResult; send: SendResult; ack: NoResult; control: NoResult; ping: NoResult;
  threads: ThreadsResult; "thread.create": ThreadCreateResult; "thread.rename": NoResult; "thread.archive": NoResult;
  "push.key": PushKeyResult; "push.subscribe": NoResult; "push.unsubscribe": NoResult;
  answer: AnswerResult; react: NoResult; tasks: TasksResult; "task.cancel": TaskCancelResult;
}
/** The reply to one request op. Fields are as the gateway sends them; a client still checks them. */
export type ResponseMap = {
  [Op in Request["op"]]: ({ type: "res"; id: string; ok: true } & ResultMap[Op]) | ErrorResponse;
};

// -- Field validators shared by the gateway and the app (pure, no dependencies) ----------------

/** Bidirectional overrides and isolates: never in a label, name or title. */
const BIDI = /[\u202a-\u202e\u2066-\u2069]/u;
/**
 * Code points U+0020–U+007E and U+00A0–U+FFFF: no C0/C1 controls or DEL, and nothing outside
 * the Basic Multilingual Plane (so no emoji such as U+1F600). Other format characters (e.g.
 * U+200B) and U+2028/U+2029 are not excluded by this class; the gateway has always accepted them.
 */
const PRINTABLE = /^[\x20-\x7e\u00a0-\uffff]+$/u;

export function validThreadId(value: unknown): value is ThreadId {
  return typeof value === "string" && LIMITS.threadIdPattern.test(value);
}

/**
 * A thread title: 1–80 code points, not blank, and no character of Unicode category C (controls,
 * format characters such as ZWJ, private use, unassigned, lone surrogates) or Zl/Zp. Emoji are
 * allowed unless they need a joiner or variation selector of category Cf.
 */
export function validThreadTitle(value: unknown): value is string {
  return typeof value === "string" && Array.from(value).length <= LIMITS.threadTitleChars &&
    value.trim() !== "" && !/[\p{C}\p{Zl}\p{Zp}]/u.test(value);
}

/**
 * A device label: 1–40 UTF-16 units of `PRINTABLE` (BMP only, no C0/C1 controls), no bidi
 * override or isolate, and no leading or trailing whitespace.
 */
export function validDeviceLabel(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < LIMITS.labelMinChars || value.length > LIMITS.labelMaxChars) return false;
  // Spaces are fine inside a label ("Gergo's iPhone"), never at either end.
  if (value.trim() !== value) return false;
  return PRINTABLE.test(value) && !BIDI.test(value);
}

/**
 * `hello.agent`, the gateway's display name: 1–40 UTF-16 units of `PRINTABLE` (BMP only, no C0/C1
 * controls), no bidi override or isolate, not blank; inner and outer spaces are allowed.
 */
export function validAgentName(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.length > LIMITS.agentNameMaxChars || value.trim() === "") return false;
  return PRINTABLE.test(value) && !BIDI.test(value);
}

/** One pairing code as typed: upper-cased, anything outside `PAIR_ALPHABET` dropped, bounded. */
export function normalizePairCode(input: string): string {
  return [...input.toUpperCase()].filter((c) => PAIR_ALPHABET.includes(c)).join("").slice(0, LIMITS.pairCodeChars);
}

export function validPairCode(value: unknown): value is string {
  return typeof value === "string" && value.length === LIMITS.pairCodeChars &&
    [...value].every((c) => PAIR_ALPHABET.includes(c));
}

/**
 * A preset `name` or `model`: 1–`max` UTF-16 units, with no whitespace (`\s`), no C0 or C1
 * control character or DEL (U+0000–U+001F, U+007F–U+009F, e.g. U+0085) and no bidi control.
 */
export function validPresetToken(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    !/[\u0000-\u001f\u007f-\u009f\s]/u.test(value) && !BIDI.test(value);
}

/**
 * `hello.presets` as a client reads it: well-formed, uniquely named entries within the bounds the
 * gateway projects them with; `undefined` when the field is absent or not a list.
 */
export function parsePresets(raw: unknown): PresetInfo[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const text = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" &&
    v.length <= LIMITS.presetLabelChars && !/[\p{Cc}]/u.test(v);
  const out: PresetInfo[] = [];
  for (const p of raw) {
    if (out.length >= LIMITS.maxPresets) break;
    if (!p || typeof p !== "object") continue;
    const { name, label, model, thinking } = p as Record<string, unknown>;
    if (!validPresetToken(name, LIMITS.presetNameChars) || seen.has(name) ||
        !validPresetToken(model, LIMITS.presetModelChars) ||
        (label !== undefined && !text(label)) || (thinking !== undefined && !text(thinking))) continue;
    seen.add(name);
    out.push({ name, model, ...(label ? { label } : {}), ...(thinking ? { thinking } : {}) });
  }
  return out;
}

const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const isCursor = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const isText = (v: unknown): v is string => typeof v === "string";
const isId = (v: unknown): v is string => typeof v === "string" && v !== "";
const oneOf = <T extends string>(v: unknown, values: readonly T[]): v is T =>
  typeof v === "string" && (values as readonly string[]).includes(v);
const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

/** Well-formed `ActivityStep`s, bounded by `maxActivitySteps`/`activityToolChars`; the rest dropped. */
export function parseActivitySteps(raw: unknown): ActivityStep[] {
  if (!Array.isArray(raw)) return [];
  const out: ActivityStep[] = [];
  for (const item of raw.slice(0, LIMITS.maxActivitySteps)) {
    const step = record(item);
    if (!step) continue;
    const { id, tool, state, startedAt, endedAt } = step;
    if (!isId(id) || !isId(tool) || !oneOf(state, ["running", "done", "failed"] as const) || !isIso(startedAt)) continue;
    out.push({
      id: id.slice(0, LIMITS.activityStepIdChars), tool: tool.slice(0, LIMITS.activityToolChars), state, startedAt,
      ...(isIso(endedAt) ? { endedAt } : {}),
    });
  }
  return out;
}

const ATTACHMENT_KINDS = ["image", "audio", "file", "artifact"] as const;

function parseAttachments(raw: unknown): AttachmentInfo[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.slice(0, LIMITS.maxAttachments).flatMap((item): AttachmentInfo[] => {
    const f = record(item);
    if (!f || !isText(f.id) || !LIMITS.uploadIdPattern.test(f.id) || !isText(f.name) || !isText(f.type) ||
        typeof f.size !== "number" || !Number.isSafeInteger(f.size) || f.size < 0 || !oneOf(f.kind, ATTACHMENT_KINDS)) return [];
    return [{ id: f.id, name: f.name, type: f.type, size: f.size, kind: f.kind }];
  });
  return out.length ? out : undefined;
}

/** One well-formed `ThreadInfo` (a `thread` event or a `threads` reply entry), or `undefined`. */
export function parseThreadInfo(raw: unknown): ThreadInfo | undefined {
  const t = record(raw);
  if (!t || !validThreadId(t.id) || !isText(t.title) || typeof t.archived !== "boolean" ||
      !isText(t.createdAt) || !isText(t.lastAt)) return undefined;
  const origin = record(t.origin);
  if (t.origin !== undefined && (!origin || !validThreadId(origin.thread) || !isId(origin.messageId))) return undefined;
  if (t.archivedReason !== undefined && !oneOf(t.archivedReason, ["manual", "idle"] as const)) return undefined;
  if (t.badge !== undefined && !validThreadBadge(t.badge)) return undefined;
  const badge = t.badge as ThreadBadge | undefined;
  return {
    id: t.id, title: t.title, archived: t.archived, createdAt: t.createdAt, lastAt: t.lastAt,
    ...(t.archivedReason === undefined ? {} : { archivedReason: t.archivedReason }),
    ...(badge === undefined ? {} : { badge: { emoji: badge.emoji, verb: badge.verb } }),
    ...(origin ? { origin: { thread: origin.thread as ThreadId, messageId: origin.messageId as string } } : {}),
  };
}

/** One badge field: 1–`max` code points, not blank, no control or format character. */
function badgeText(value: unknown, max: number): value is string {
  if (typeof value !== "string") return false;
  const length = Array.from(value).length;
  return length > 0 && length <= max && !/[\p{C}\p{Zl}\p{Zp}]/u.test(value);
}

/** A `ThreadInfo.badge`: exactly an emoji and a verb within their bounds. */
export function validThreadBadge(value: unknown): value is ThreadBadge {
  const badge = record(value);
  return badge !== undefined && badgeText(badge.emoji, LIMITS.threadBadgeEmojiChars) &&
    badgeText(badge.verb, LIMITS.threadBadgeVerbChars);
}

const QUESTION_OPTION_IDS = ["a", "b", "c", "d"] as const;

/**
 * One durable server event (`message`, `settled`, `divider`, `reaction`, `question`, `thread`), or
 * `undefined` when a required field is missing or malformed. Malformed optional fields are dropped
 * rather than refusing the event. The result holds only known fields, so it is safe to persist.
 */
export function parseDurableEvent(raw: unknown): DurableEvent | undefined {
  const f = record(raw);
  if (!f || f.type !== "event" || !isCursor(f.cursor)) return undefined;
  const cursor = f.cursor;
  if (f.event === "thread") {
    const thread = parseThreadInfo(f.thread);
    return thread && { type: "event", event: "thread", cursor, thread };
  }
  if (!validThreadId(f.thread)) return undefined;
  const thread = f.thread;
  switch (f.event) {
    case "message": {
      if (!isId(f.id) || !oneOf(f.role, ["user", "assistant", "notice"] as const) || !isText(f.text) || !isText(f.at)) return;
      const part = record(f.part);
      const validPart = part && Number.isSafeInteger(part.n) && Number.isSafeInteger(part.i) &&
        (part.i as number) >= 0 && (part.i as number) < (part.n as number) && (part.n as number) <= LIMITS.maxMessageParts;
      if (f.part !== undefined && !validPart) return undefined;
      const attachments = parseAttachments(f.attachments);
      const steps = f.role === "assistant" ? parseActivitySteps(f.steps) : [];
      const omitted = typeof f.omitted === "number" && Number.isSafeInteger(f.omitted) && f.omitted > 0 ? f.omitted : undefined;
      return {
        type: "event", event: "message", cursor, thread, id: f.id, role: f.role, text: f.text, at: f.at,
        ...(isText(f.key) ? { key: f.key } : {}),
        ...(attachments ? { attachments } : {}),
        ...(steps.length ? { steps } : {}),
        ...(steps.length && omitted !== undefined ? { omitted } : {}),
        ...(validPart ? { part: { i: part.i as number, n: part.n as number } } : {}),
      };
    }
    case "settled":
      if (!isText(f.key) || !oneOf(f.outcome, ["answered", "failed", "aborted"] as const)) return;
      return { type: "event", event: "settled", cursor, thread, key: f.key, outcome: f.outcome };
    case "divider":
      if (!isText(f.at) || !oneOf(f.reason, ["new", "idle"] as const)) return;
      return { type: "event", event: "divider", cursor, thread, at: f.at, reason: f.reason };
    case "reaction":
      if (!isId(f.message) || f.by !== "owner" || (f.emoji !== null && !oneOf(f.emoji, REACTIONS))) return;
      return { type: "event", event: "reaction", cursor, thread, message: f.message, by: "owner", emoji: f.emoji };
    case "question": {
      if (!isText(f.id) || !LIMITS.questionIdPattern.test(f.id) || !isText(f.prompt) || !isText(f.expiresAt) ||
          !oneOf(f.state, ["open", "answered", "expired", "cancelled", "unknown"] as const) || !Array.isArray(f.options)) return;
      const options: QuestionOption[] = [];
      for (const item of f.options) {
        const o = record(item);
        if (!o || !oneOf(o.id, QUESTION_OPTION_IDS) || !isText(o.label)) return undefined;
        options.push({ id: o.id, label: o.label, ...(isText(o.description) ? { description: o.description } : {}) });
      }
      if (options.length === 0) return undefined;
      return {
        type: "event", event: "question", cursor, thread, id: f.id, prompt: f.prompt, options, expiresAt: f.expiresAt,
        state: f.state, ...(oneOf(f.answer, QUESTION_OPTION_IDS) ? { answer: f.answer } : {}),
      };
    }
  }
  return undefined;
}
