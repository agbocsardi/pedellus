// Wire protocol v1 shapes. Normative text: ./v1.md
export const PROTOCOL_VERSION = 1;

export const LIMITS = {
  frameBytes: 262_144,
  sendTextChars: 16_000,
  idPattern: /^[A-Za-z0-9_-]{1,64}$/,
  replayBatch: 500,
  pingIntervalMs: 25_000,
  pingTimeoutMs: 10_000,
} as const;

export const CLOSE = {
  unauthorized: 4401,
  protocol: 4400,
  version: 4426,
  replaced: 4409,
} as const;

export type ErrorCode = "bad_request" | "too_large" | "unsupported" | "not_ready" | "internal";
export type ControlCommand = "new" | "abort" | "status";

export type Request =
  | { type: "req"; id: string; op: "hello"; v: 1; cursor: number | null }
  | { type: "req"; id: string; op: "send"; key: string; text: string }
  | { type: "req"; id: string; op: "ack"; cursor: number }
  | { type: "req"; id: string; op: "control"; command: ControlCommand }
  | { type: "req"; id: string; op: "ping" };

export type HelloResult = { v: 1; device: string; head: number | null };
export type SendResult = { duplicate: boolean };

export type Response =
  | ({ type: "res"; id: string; ok: true } & Partial<HelloResult & SendResult>)
  | { type: "res"; id: string; ok: false; error: ErrorCode };

export type MessageEvent = {
  type: "event"; event: "message"; cursor: number; id: string;
  role: "user" | "assistant" | "notice"; text: string; at: string; key?: string;
};
export type SettledEvent = {
  type: "event"; event: "settled"; cursor: number; key: string;
  outcome: "answered" | "failed" | "aborted";
};
export type DividerEvent = { type: "event"; event: "divider"; cursor: number; at: string; reason: "new" };
export type PreviewEvent = { type: "event"; event: "preview"; key: string; text: string };
export type StatusEvent = {
  type: "event"; event: "status";
  state: "idle" | "queued" | "thinking" | "tool" | "error"; label?: string;
};

export type DurableEvent = MessageEvent | SettledEvent | DividerEvent;
export type Event = DurableEvent | PreviewEvent | StatusEvent;
export type ServerFrame = Response | Event;

export type PairRequest = { code: string; label: string };
export type PairError = "bad_request" | "invalid_code" | "rate_limited";
