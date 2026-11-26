import { useCallback, useLayoutEffect, useRef } from "react";
import type { AvatarState } from "./Avatar";
import { type CommandInfo, type PresetInfo, type ThreadId } from "./protocol";
import type { AgentStatus, Store } from "./store";

export const FINE_POINTER = matchMedia("(pointer: fine)").matches;

export type Tone = "ok" | "run" | "warn" | "bad";

export function isRunning(state: AgentStatus["state"]): boolean {
  return state === "queued" || state === "thinking" || state === "tool";
}

/** One place maps connection + agent status to the header line and avatar. */
export function presence(store: Store, thread: ThreadId): { text: string; tone: Tone; avatar: AvatarState } {
  switch (store.connState) {
    case "offline":
      return { text: "Offline", tone: "bad", avatar: "offline" };
    case "connecting":
      return { text: "Reconnecting…", tone: "warn", avatar: "offline" };
    case "replaying":
      return { text: "Catching up…", tone: "warn", avatar: "thinking" };
  }
  const s = store.status(thread);
  switch (s.state) {
    case "idle":
      return { text: "Online", tone: "ok", avatar: "idle" };
    case "queued":
      return { text: "Queued", tone: "run", avatar: "queued" };
    case "thinking":
      return { text: "Thinking…", tone: "run", avatar: "thinking" };
    case "tool":
      return { text: s.label ? `Using ${s.label}` : "Working…", tone: "run", avatar: "tool" };
    case "error":
      return { text: "Something went wrong", tone: "bad", avatar: "error" };
  }
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
export function clock(at: string | number | undefined): string {
  if (at === undefined) return "";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : TIME.format(d);
}

export type CommandState = { online: boolean; writable: boolean; running: boolean };
export const ready = (s: CommandState) => s.online && s.writable;
/** The toolbox lists `hello.commands`; this is only for before a gateway has sent one. */
export const FALLBACK_COMMANDS: CommandInfo[] = [
  { name: "new", summary: "Start a fresh context in this thread", usage: "Usage: /new" },
  { name: "status", summary: "Ask the agent what it is doing", usage: "Usage: /status" },
  { name: "abort", summary: "Stop the running turn", usage: "Usage: /abort" },
];
/** Local rules on top of the gateway's list. */
export const canRun = (c: CommandInfo, s: CommandState) => ready(s) && (c.name !== "abort" || s.running);
/** Commands that leave a visible divider ask first. */
export const CONFIRM = new Set(["new"]);
/** `/name` or `/name args` in the composer is a command, never a message. */
export const SLASH = /^\/([a-z0-9_-]*)(?:\s([\s\S]*))?$/i;
export const presetName = (p: PresetInfo) => p.label ?? p.name;

/**
 * A function whose identity never changes but which always runs the latest render's `fn`, so a
 * memoized child can take it as a prop. Call it from event handlers, never during render.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => { ref.current = fn; });
  return useCallback((...args: A) => ref.current(...args), []);
}
