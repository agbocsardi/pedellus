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
  taskTitleChars: 120,
  taskDetailChars: 200,
  uploadIdPattern: /^f_[A-Za-z0-9_-]{22}$/,
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
export type ThreadInfo = {
  id: ThreadId; title: string; archived: boolean; archivedReason?: "manual" | "idle";
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

export type Response =
  | ({ type: "res"; id: string; ok: true } & Partial<HelloResult & SendResult & ThreadsResult & ThreadCreateResult & PushKeyResult & AnswerResult & TasksResult & TaskCancelResult>)
  | { type: "res"; id: string; ok: false; error: ErrorCode };

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
