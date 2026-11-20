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
  | { type: "req"; id: string; op: "send"; key: string; text: string; thread?: ThreadId }
  | { type: "req"; id: string; op: "ack"; cursor: number }
  | { type: "req"; id: string; op: "control"; command: ControlCommand; args?: string; thread?: ThreadId }
  | { type: "req"; id: string; op: "ping" }
  | { type: "req"; id: string; op: "threads"; query?: string }
  | { type: "req"; id: string; op: "thread.create"; key: string; title?: string; from?: ThreadOrigin }
  | { type: "req"; id: string; op: "thread.rename"; thread: ThreadId; title: string }
  | { type: "req"; id: string; op: "thread.archive"; thread: ThreadId; archived: boolean };

export type HelloResult = { v: 2; device: string; head: number | null; agent: string; commands: CommandInfo[]; presets: PresetInfo[] };
export type SendResult = { duplicate: boolean };
export type ThreadsResult = { threads: ThreadInfo[] };
export type ThreadCreateResult = { thread: ThreadId; duplicate: boolean };

export type Response =
  | ({ type: "res"; id: string; ok: true } & Partial<HelloResult & SendResult & ThreadsResult & ThreadCreateResult>)
  | { type: "res"; id: string; ok: false; error: ErrorCode };

export type MessageEvent = {
  type: "event"; event: "message"; cursor: number; thread: ThreadId; id: string;
  role: "user" | "assistant" | "notice"; text: string; at: string; key?: string;
};
export type SettledEvent = {
  type: "event"; event: "settled"; cursor: number; thread: ThreadId; key: string;
  outcome: "answered" | "failed" | "aborted";
};
export type DividerEvent = { type: "event"; event: "divider"; cursor: number; thread: ThreadId; at: string; reason: "new" };
export type PreviewEvent = { type: "event"; event: "preview"; thread: ThreadId; key: string; text: string };
export type StatusEvent = {
  type: "event"; event: "status"; thread: ThreadId;
  state: "idle" | "queued" | "thinking" | "tool" | "error"; label?: string;
};

export type ThreadEvent = { type: "event"; event: "thread"; cursor: number; thread: ThreadInfo };

export type ModelEvent = { type: "event"; event: "model"; thread: ThreadId; preset: string | null };

export type DurableEvent = MessageEvent | SettledEvent | DividerEvent | ThreadEvent;
export type Event = DurableEvent | PreviewEvent | StatusEvent | ModelEvent;
export type ServerFrame = Response | Event;

export type PairRequest = { code: string; label: string };
export type PairError = "bad_request" | "invalid_code" | "rate_limited";
