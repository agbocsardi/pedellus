import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import { activitySteps, type Connection } from "./conn";
import type { AgentStatus, Outgoing, OutgoingState, Store } from "./store";
import { LIMITS, MAIN_THREAD, type CommandInfo, type DurableEvent, type MessageEvent, type PresetInfo, type ThreadInfo, type ThreadOrigin } from "./protocol";
import { disablePush, enablePush, hasPushSubscription, pushPermission, requestPushPermission, pushSupported, subscribedServerKey, clearAppBadge, type PushPermission } from "./push";
import { Avatar, type AvatarState } from "./Avatar";
import { ActivitySteps } from "./ActivitySteps";

const FINE_POINTER = matchMedia("(pointer: fine)").matches;
/** From here the thread list is a sidebar and the chat sits beside it. */
const WIDE = "(min-width: 900px)";

type Row = { kind: "ev"; ev: DurableEvent; text?: string; partial?: boolean } | { kind: "pending"; m: Outgoing };
type Tone = "ok" | "run" | "warn" | "bad";
type Sheet = { kind: "list" | "menu" | "tools" | "confirm-new" | "model" } | { kind: "rename"; title: string }
  | { kind: "create"; title: string; from?: ThreadOrigin }
  | { kind: "message"; title: string; from: ThreadOrigin };
const LIST_ICON = "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01";
const TITLE_CONTROL = /[\p{Cc}\u2028\u2029]/u;
const BELL_ICON = "M18 14v-3.5a6 6 0 1 0-12 0V14l-2 3.5h16L18 14M10 21h4";
const WRENCH_ICON = "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9l-3.8 3.8Z";
/** A DOM `MessageEvent`; the protocol's `MessageEvent` shadows the global in this file. */
type SwMessage = Event & { origin: string; source: MessageEventSource | null; data?: unknown };

type CommandState = { online: boolean; writable: boolean; running: boolean };
const ready = (s: CommandState) => s.online && s.writable;
/** The toolbox lists `hello.commands`; this is only for before a gateway has sent one. */
const FALLBACK_COMMANDS: CommandInfo[] = [
  { name: "new", summary: "Start a fresh context in this thread", usage: "Usage: /new" },
  { name: "status", summary: "Ask the agent what it is doing", usage: "Usage: /status" },
  { name: "abort", summary: "Stop the running turn", usage: "Usage: /abort" },
];
/** Local rules on top of the gateway's list. */
const canRun = (c: CommandInfo, s: CommandState) => ready(s) && (c.name !== "abort" || s.running);
const CONFIRM = new Set(["new"]); // leaves a visible divider
const COMMAND_ICONS: Record<string, string> = {
  new: "M12 5v14M5 12h14",
  status: "M3 12h4l3-8 4 16 3-8h4",
  abort: "M6 6l12 12M18 6 6 18",
  model: "M8 8h8v8H8zM10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3",
  digest: "M5 6h14M5 12h14M5 18h9",
  compact: "M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5",
  help: "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
};
const COMMAND_ICON = "M15 4 9 20";
const CHECK_ICON = "M5 12.5 10 17 19 7";
const presetName = (p: PresetInfo) => p.label ?? p.name;
const ARGS_MAX = 1000;
/** A picked preset that the gateway accepts but never confirms stops pulsing after this. */
const MODEL_PENDING_MS = 15_000;
/** `/name` or `/name args` in the composer is a command, never a message. */
const SLASH = /^\/([a-z0-9_-]*)(?:\s([\s\S]*))?$/i;

function suggestedTitle(text: string) {
  return text.replace(/[\p{Cc}\s]+/gu, " ").trim().slice(0, LIMITS.threadTitleChars)
    .replace(/[\uD800-\uDBFF]$/u, "").trimEnd();
}

function forkAction(target: EventTarget | null, thread: string): Sheet | undefined {
  if (!(target instanceof Element) || target.closest("a, button, input, summary")) return;
  const data = target.closest<HTMLElement>("[data-message-id]")?.dataset;
  if (data?.messageId) return { kind: "message", title: data.threadTitle ?? "", from: { thread, messageId: data.messageId } };
}

function archivedLabel(t: ThreadInfo | undefined) {
  return t?.archivedReason ? `Archived · ${t.archivedReason}` : "Archived";
}

/** One place maps connection + agent status to the header line and avatar. */
function presence(store: Store): { text: string; tone: Tone; avatar: AvatarState } {
  switch (store.connState) {
    case "offline":
      return { text: "Offline", tone: "bad", avatar: "offline" };
    case "connecting":
      return { text: "Reconnecting…", tone: "warn", avatar: "offline" };
    case "replaying":
      return { text: "Catching up…", tone: "warn", avatar: "thinking" };
  }
  const s = store.status(store.openThread);
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

function isRunning(state: AgentStatus["state"]): boolean {
  return state === "queued" || state === "thinking" || state === "tool";
}

/** Main first, then open side threads, newest activity first: the sidebar order
 * and the order Alt+↑/↓ steps through. */
function openThreads(store: Store): ThreadInfo[] {
  const main = store.threads.get(MAIN_THREAD);
  const side = [...store.threads.values()].filter((t) => t.id !== MAIN_THREAD && !t.archived)
    .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
  return main ? [main, ...side] : side;
}

function useWideLayout() {
  const [wide, setWide] = useState(() => matchMedia(WIDE).matches);
  useEffect(() => {
    const mq = matchMedia(WIDE);
    const sync = () => setWide(mq.matches);
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return wide;
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
function clock(at: string | number | undefined): string {
  if (at === undefined) return "";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : TIME.format(d);
}

export function Chat({ store, conn }: { store: Store; conn: Connection }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const wide = useWideLayout();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [slashPick, setSlashPick] = useState(0);
  const [slashHidden, setSlashHidden] = useState(false);
  const wrenchRef = useRef<HTMLButtonElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const savingMessage = useRef(false);
  const jumpCursor = useRef<number | undefined>(undefined);
  const pinned = useRef(true);
  const taRef = useRef<HTMLTextAreaElement>(null);
  /** The message at the top of the list, so a layout switch can restore it. */
  const anchor = useRef<{ cursor: string; offset: number; width: number } | null>(null);
  const layoutWidth = useRef(0);
  const reflowedAt = useRef(0);
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);

  const thread = store.openThread;
  const main = thread === MAIN_THREAD;
  const info = store.threads.get(thread);
  const agentName = store.agentName;
  const title = main ? agentName : info?.title ?? "New thread";
  const archived = !!info?.archived;
  const writable = store.canWrite(thread);
  const text = drafts[thread] ?? "";
  const setText = (value: string) => setDrafts((prev) => ({ ...prev, [thread]: value }));
  const online = store.connState === "open";
  const running = !archived && isRunning(store.status(thread).state);
  const liveActivity = store.activity(thread);
  const p = presence(store);
  const latest = store.latestViewable(thread);
  const origin = info?.origin;
  const source = store.threads.get(origin?.thread ?? MAIN_THREAD);
  const sourceMessage = origin && store.events.get(origin.thread)?.find((ev): ev is MessageEvent =>
    ev.event === "message" && ev.id === origin.messageId);
  const sourceTitle = origin?.thread === MAIN_THREAD ? "Main" : source?.title ?? "another thread";
  const back = source ?? store.threads.get(MAIN_THREAD)!;
  const canRetry = writable && !running;
  const cmdState: CommandState = { online, writable, running };
  const commands = store.commands ?? FALLBACK_COMMANDS;
  const slash = SLASH.exec(text);
  const typed = slash?.[1].toLowerCase() ?? "";
  const args = slash?.[2]; // undefined until a space follows the name
  const matches = !slash ? [] : args === undefined ? commands.filter((c) => c.name.startsWith(typed))
    : commands.filter((c) => c.name === typed);
  const picked: CommandInfo | undefined = matches[args === undefined ? Math.min(slashPick, matches.length - 1) : 0];
  const argsTooLong = (args?.trim().length ?? 0) > ARGS_MAX;
  const slashOpen = !!slash && writable && !sheet && !slashHidden;
  const presets = store.presets ?? [];
  const model = store.model(thread);
  const pendingModel = store.pendingModel(thread);
  const shown = pendingModel ?? model;
  const chipText = shown === null ? "custom" : shown === undefined ? "model"
    : presetName(presets.find((p) => p.name === shown) ?? { name: shown, model: "" });
  const forkError = store.forkRejected ? "Could not start a side thread from that message." : "";
  const forks = new Map<string, ThreadInfo[]>();
  let hasOtherActivity = false;
  for (const t of store.threads.values()) {
    if (t.id !== thread && (store.isUnread(t.id) || isRunning(store.status(t.id).state))) hasOtherActivity = true;
    if (t.origin?.thread === thread) {
      const children = forks.get(t.origin.messageId) ?? [];
      children.push(t);
      forks.set(t.origin.messageId, children);
    }
  }

  // A split message is one row: its parts are joined in `i` order here, and a message whose other
  // parts have not arrived yet is marked incomplete.
  const rows: Row[] = [];
  const splitSeen = new Set<string>();
  for (const ev of store.events.get(thread) ?? []) {
    if (ev.event === "message" && ev.part !== undefined) {
      if (splitSeen.has(ev.id)) continue;
      splitSeen.add(ev.id);
      const split = store.splitMessage(thread, ev.id);
      rows.push({ kind: "ev", ev, text: split?.text, partial: !split?.complete });
      continue;
    }
    rows.push({ kind: "ev", ev });
  }
  for (const m of store.outbox.values()) {
    if (m.thread === thread && (m.state === "queued" || m.state === "sent" || m.state === "failed") && !store.hasEcho(thread, m.key)) {
      rows.push({ kind: "pending", m });
    }
  }
  // Delivery state is shown on the latest user message (and on any that is
  // still in flight or failed), like a messaging app's receipt.
  let lastUser = -1;
  rows.forEach((r, i) => {
    if (r.kind === "pending" || (r.ev.event === "message" && r.ev.role === "user")) lastUser = i;
  });
  const empty = !rows.some((r) => r.kind === "pending" || r.ev.event === "message");

  function markAtBottom(el: HTMLDivElement) {
    if (!sheet && !document.hidden && el.scrollHeight - el.scrollTop - el.clientHeight <= 2) {
      store.markViewed(thread, latest);
    }
  }

  /** The message under the top edge and how far it is pushed up out of view. */
  function rememberTop(el: HTMLDivElement) {
    // A reflowing column fires scroll events too. Keep the anchor taken before
    // the switch, or the restore would target the already-moved position.
    if (el.clientWidth !== layoutWidth.current) {
      layoutWidth.current = el.clientWidth;
      reflowedAt.current = performance.now();
      return;
    }
    if (performance.now() - reflowedAt.current < 250) return;
    const box = el.getBoundingClientRect();
    // Children are in flow order, so binary search the first one still visible.
    let lo = 0;
    let hi = el.children.length - 1;
    let i = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (el.children[mid].getBoundingClientRect().bottom > box.top + 1) {
        i = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    anchor.current = null;
    for (let n = i; n >= 0 && n < el.children.length && n < i + 4; n++) {
      const row = el.children[n];
      const node = row.matches("[data-message-cursor]") ? row : row.querySelector("[data-message-cursor]");
      if (node) {
        anchor.current = { cursor: (node as HTMLElement).dataset.messageCursor!, offset: node.getBoundingClientRect().top - box.top, width: el.clientWidth };
        return;
      }
    }
  }

  useLayoutEffect(() => { pinned.current = true; anchor.current = null; }, [thread]);
  useEffect(() => cancelPress, []);
  // Clear an unconfirmed pick after a while; a `model` event clears it sooner.
  useEffect(() => {
    if (!pendingModel) return;
    const timer = setTimeout(() => store.setPendingModel(thread, undefined), MODEL_PENDING_MS);
    return () => clearTimeout(timer);
  }, [store, thread, pendingModel]);
  // Leaving a thread drops its pending pick, so it does not pulse again on return.
  useEffect(() => () => {
    if (store.pendingModel(thread)) store.setPendingModel(thread, undefined);
  }, [store, thread]);

  // Follow new content only if already at the bottom. A modal covers the
  // conversation, so don't mark it viewed (or follow) until dismissed.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || sheet || document.hidden) return;
    if (jumpCursor.current !== undefined) {
      const target = el.querySelector<HTMLElement>(`[data-message-cursor="${jumpCursor.current}"]`);
      jumpCursor.current = undefined;
      if (target) {
        pinned.current = false;
        target.scrollIntoView({ block: "center" });
        target.focus({ preventScroll: true });
        return;
      }
    }
    if (pinned.current) el.scrollTop = el.scrollHeight;
    markAtBottom(el);
  });
  const followBottom = useEffectEvent(() => {
    const el = scroller.current;
    if (!el || sheet || document.hidden) return;
    if (pinned.current) el.scrollTop = el.scrollHeight;
    markAtBottom(el);
  });
  useLayoutEffect(() => {
    const el = scroller.current;
    const a = anchor.current;
    if (!el || !a || pinned.current || a.width === el.clientWidth) return;
    const node = el.querySelector<HTMLElement>(`[data-message-cursor="${a.cursor}"]`);
    // Phone ↔ wide reflows the column; keep the message that was at the top
    // where it was. Browsers only anchor across a container resize sometimes.
    if (!node) return;
    el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - a.offset;
    a.width = el.clientWidth;
    layoutWidth.current = el.clientWidth;
    reflowedAt.current = performance.now();
  }, [wide]);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const view = () => followBottom();
    const observer = new ResizeObserver(view);
    observer.observe(el);
    document.addEventListener("visibilitychange", view);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", view);
    };
  }, []);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }, [text, thread, writable]);

  function cancelPress() {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  }

  function show(next: Sheet, trigger?: HTMLElement) {
    if (!sheet) opener.current = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    taRef.current?.blur();
    store.clearForkRejection();
    setError("");
    setSheet(next);
  }

  async function submit() {
    if (!store.canWrite(thread)) return;
    if (running) {
      conn.control(thread, "abort");
      return;
    }
    if (slash) {
      runSlash();
      return;
    }
    const t = text.trim();
    if (!t || t.length > LIMITS.sendTextChars) return;
    await queueMessage(t);
  }

  async function queueMessage(value: string, retryKey?: string) {
    if (savingMessage.current || !store.canWrite(thread)) return;
    savingMessage.current = true;
    setError("");
    try {
      const m = await store.createOutgoing(thread, value, retryKey);
      if (!retryKey) setDrafts((prev) => prev[thread] === text ? { ...prev, [thread]: "" } : prev);
      pinned.current = true;
      conn.sendOutgoing(m);
    } catch {
      setError("Can’t save offline on this device.");
    } finally {
      savingMessage.current = false;
    }
  }

  async function discardMessage(key: string) {
    try {
      await store.discardOutgoing(key);
    } catch {
      setError("Could not discard this queued message.");
    }
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (slashOpen && (e.key === "ArrowDown" || e.key === "ArrowUp") && args === undefined && matches.length) {
      e.preventDefault();
      const i = matches.indexOf(picked!) + (e.key === "ArrowDown" ? 1 : -1);
      setSlashPick((i + matches.length) % matches.length);
      return;
    }
    if (slashOpen && e.key === "Escape") {
      e.preventDefault();
      setSlashHidden(true);
      return;
    }
    if (slash && e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      runSlash();
      return;
    }
    // On phones Enter makes a newline; send is the button. On desktop Enter
    // sends and Shift+Enter makes a newline.
    if (e.key === "Enter" && !e.shiftKey && FINE_POINTER) {
      e.preventDefault();
      void submit();
    }
  }

  function command(c: string, args?: string) {
    conn.control(thread, c, args);
    setSheet(null);
  }

  /** Enter or send with `/…` in the composer: never a chat message. */
  function runSlash() {
    setSlashHidden(false); // an unknown name shows its hint again
    // A bare `/` only opens the list; it never runs the first command.
    if (picked && typed !== "") runCommand(picked, args);
  }

  /** `args` is the text after `/name `; undefined when picked from a list. */
  function runCommand(c: CommandInfo, args?: string) {
    // Every path (Enter, send button, tapping a list row) passes through here.
    if (!canRun(c, cmdState) || (args?.trim().length ?? 0) > ARGS_MAX) return;
    if (c.args && args === undefined) {
      // Commands with arguments go through the composer, with usage shown.
      setText(`/${c.name} `);
      setSlashPick(0);
      setSlashHidden(false);
      if (sheet) {
        setSheet(null);
        // On touch, the tap into the field opens the keyboard (strategy F);
        // a programmatic focus here would let iOS scroll the page.
        if (FINE_POINTER) requestAnimationFrame(() => taRef.current?.focus());
      }
      return;
    }
    if (SLASH.test(text)) setText("");
    // From the `/` menu the field still has focus; return it to the wrench
    // after the confirm sheet, not to the field (which would re-trigger iOS).
    if (CONFIRM.has(c.name)) show({ kind: "confirm-new" }, sheet ? undefined : wrenchRef.current ?? undefined);
    else command(c.name, args?.trim() || undefined);
  }

  async function saveTitle(value: string) {
    const name = value.trim();
    if (busy || name.length > LIMITS.threadTitleChars || TITLE_CONTROL.test(name)) return;
    setBusy(true);
    setError("");
    try {
      if (sheet?.kind === "rename") {
        if (!name) return;
        if (!(await conn.rename(thread, name))?.ok) {
          setError("Could not rename this thread. Check the connection and try again.");
          return;
        }
        setSheet(null);
      } else {
        const count = [...store.threads.values()].filter((t) => t.id !== MAIN_THREAD && !t.archived).length;
        if (count >= LIMITS.maxOpenThreads) {
          setError("Archive a side thread before creating another.");
          return;
        }
        const create = await store.queueCreate(name || undefined, sheet?.kind === "create" ? sheet.from : undefined);
        setSheet(wide ? null : { kind: "list" });
        conn.sendCreate(create, online ? thread : undefined);
      }
    } catch {
      setError("Can’t save offline on this device.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleArchive() {
    if (busy || !online) return;
    setBusy(true);
    setError("");
    try {
      const res = await conn.archive(thread, !archived);
      if (res?.ok) setSheet(null);
      else setError(archived && res?.ok === false && res.error === "bad_request"
        ? "Could not restore this thread. The open thread limit may have been reached."
        : "Could not change archive status. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { setSheet(null); setError(""); setSlashHidden(false); }, [thread]);

  // A notification tap deep-links here: `/?thread=<id>` on a cold start, or a
  // postMessage from the service worker into the window it focused.
  useEffect(() => {
    const open = (id: string | undefined) => {
      if (!id || !store.threads.has(id)) return false;
      store.selectThread(id);
      return true;
    };
    const param = new URLSearchParams(location.search).get("thread") ?? undefined;
    if (param && open(param)) history.replaceState(null, "", location.pathname);
    // Only this origin's active service worker may steer navigation; a frame
    // or another origin posting the same shape is ignored.
    const onMessage = (e: Event) => {
      const { origin, source, data } = e as SwMessage;
      if (origin !== location.origin) return;
      const sw = navigator.serviceWorker.controller;
      if (sw && source !== sw) return;
      const message = data as { type?: string; thread?: string } | undefined;
      if (message?.type === "open-thread") open(message.thread);
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", onMessage);
  }, [store, store.connState]);

  // v2: the badge clears only once the app is visible and has acked
  // everything, so the replay must have arrived and the gateway must hold an
  // `ack` for the newest cursor. An unacked message keeps the badge.
  useEffect(() => {
    const acked = () => store.replayReady && store.cursor !== null
      && store.ackedCursor !== null && store.ackedCursor >= store.cursor;
    const clear = () => {
      if (!document.hidden && acked()) clearAppBadge();
    };
    clear();
    document.addEventListener("visibilitychange", clear);
    return () => document.removeEventListener("visibilitychange", clear);
  }, [store, store.replayReady, store.cursor, store.ackedCursor]);

  // The sidebar carries the thread list on wide screens, so a list sheet left
  // open across the switch closes instead of listing every thread twice.
  useEffect(() => {
    if (wide) setSheet((s) => (s?.kind === "list" ? null : s));
  }, [wide]);

  // Wide-layout keys only. Escape closes an open sheet, Ctrl/Cmd+K focuses the
  // thread search, Alt+↑/↓ steps through the visible threads; the composer
  // keeps its own Enter/Shift+Enter handling (see onKeyDown).
  const shortcut = useEffectEvent((e: KeyboardEvent) => {
    // An IME composition owns its keys (Esc cancels the composition, not the sheet).
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") {
      if (!sheet) return;
      e.preventDefault();
      setError("");
      setSheet(null);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
      // Behind another open sheet the sidebar search is not reachable; leave the sheet in charge.
      if (sheet && sheet.kind !== "list") return;
      e.preventDefault();
      document.querySelector<HTMLInputElement>(sheet?.kind === "list" ? ".sheet-layer .thread-search" : ".sidebar .thread-search")?.focus();
      return;
    }
    const field = e.target instanceof HTMLElement && e.target.matches("input, textarea, select, [contenteditable]");
    if (field || e.ctrlKey || e.metaKey || sheet) return;
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    const ids = openThreads(store).map((t) => t.id);
    const i = ids.indexOf(thread);
    if (i < 0) return;
    const next = ids[(i + (e.key === "ArrowDown" ? 1 : -1) + ids.length) % ids.length];
    e.preventDefault();
    if (next !== thread) store.selectThread(next);
  });
  // Keep the open thread visible in the sidebar when it changes (or the layout turns wide).
  useEffect(() => {
    if (!wide) return;
    document.querySelector('.sidebar .thread-row[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [wide, thread]);
  useEffect(() => {
    if (!wide) return;
    const onKey = (e: KeyboardEvent) => shortcut(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wide]);

  return (
    <div className="app" data-wide={wide ? "" : undefined}>
      {wide && <aside className="sidebar" aria-label="Threads">
        <ThreadList store={store} conn={conn} online={online} onNew={() => show({ kind: "create", title: "" })}
          onSelect={(id) => store.selectThread(id)} />
      </aside>}
      <header className="top">
        {!main && !wide && <button className="thread-back" onClick={() => store.selectThread(back.id)}
          aria-label={`Back to ${back.id === MAIN_THREAD ? "Main" : back.title}`}>
          <span aria-hidden="true">‹</span><span>{back.id === MAIN_THREAD ? "Main" : back.title}</span>
        </button>}
        <div className="who">
          <div className="avatar-slot">
            <Avatar state={p.avatar} />
          </div>
          <div className="who-text">
            <h1>{wide
              ? <span className="switch-static">
                <span className="switch-title">{title}</span>
                {hasOtherActivity && <span className="thread-dot" role="img" aria-label="Activity in another thread" />}
              </span>
              : <button className="thread-switch" aria-label={`${title}, open threads`} aria-haspopup="dialog"
                aria-expanded={sheet?.kind === "list"} onClick={(e) => show({ kind: "list" }, e.currentTarget)}>
                <span className="switch-title">{title}</span><span aria-hidden="true">▾</span>
                {hasOtherActivity && <span className="thread-dot" role="img" aria-label="Activity in another thread" />}
              </button>}</h1>
            <p className="presence" data-tone={p.tone} aria-live="polite">
              {p.text}
            </p>
          </div>
        </div>
        {presets.length > 0 && <button className="model-chip" disabled={!ready(cmdState)}
          aria-label={`Model: ${chipText}${pendingModel ? ", switching" : ""}`} aria-haspopup="dialog"
          aria-expanded={sheet?.kind === "model"} data-pending={pendingModel ? "" : undefined}
          onClick={(e) => show({ kind: "model" }, e.currentTarget)}>
          <span className="model-chip-text">{chipText}</span><span aria-hidden="true">▾</span>
        </button>}
        <button
          className="icon-btn"
          aria-label="Thread menu"
          aria-haspopup="dialog"
          aria-expanded={sheet?.kind === "menu"}
          onClick={(e) => show({ kind: "menu" }, e.currentTarget)}
        >
          <Icon d="M6 12h.01M12 12h.01M18 12h.01" bold />
        </button>
      </header>

      <div
        className="messages"
        ref={scroller}
        onScroll={(e) => {
          cancelPress();
          const el = e.currentTarget;
          if (sheet || document.hidden) return;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
          if (pinned.current) markAtBottom(el);
          rememberTop(el);
        }}
        onContextMenu={(e) => {
          const action = forkAction(e.target, thread);
          if (!action) return;
          e.preventDefault();
          cancelPress();
          show(action);
        }}
        onPointerDown={(e) => {
          cancelPress();
          if (e.button !== 0 || !e.isPrimary) return;
          const action = forkAction(e.target, thread);
          if (!action) return;
          press.current = { x: e.clientX, y: e.clientY, timer: setTimeout(() => {
            press.current = null;
            show(action);
          }, 550) };
        }}
        onPointerMove={(e) => {
          const p = press.current;
          if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) cancelPress();
        }}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        onPointerLeave={cancelPress}
      >
        {origin && <div className="msg origin-card-wrap">
          <button className="origin-card" onClick={() => {
            jumpCursor.current = sourceMessage?.cursor;
            store.selectThread(origin.thread);
          }}>
            <b>Started from {sourceTitle}</b>
            <span>{sourceMessage?.text.slice(0, 220).trim() || "Original message not cached."}
              {(sourceMessage?.text.length ?? 0) > 220 ? "…" : ""}</span>
          </button>
        </div>}
        {!origin && empty && !running && (
          <div className="empty">
            <div className="avatar-slot big">
              <Avatar state={p.avatar} />
            </div>
            <h2>{title}</h2>
            <p>{archived ? "No messages in this thread." : main
              ? "One ongoing thread with your agent. Ask anything to get started."
              : "A fresh conversation with your agent."}</p>
          </div>
        )}
        {rows.map((r, i) =>
          r.kind === "ev" ? (
            <EventRow key={`e${r.ev.cursor}`} ev={r.ev} text={r.text} partial={r.partial}
              store={store} last={i === lastUser}
              forks={r.ev.event === "message" ? forks.get(r.ev.id) : undefined}
              onActions={(ev, button) => show({ kind: "message", title: suggestedTitle(ev.text),
                from: { thread: ev.thread, messageId: ev.id } }, button)}
              onRetry={canRetry ? (m) => void queueMessage(m.text, m.key) : undefined} />
          ) : (
            <UserBubble key={`p${r.m.key}`} text={r.m.text} state={r.m.state} at={r.m.at} last={i === lastUser}
              onRetry={canRetry && r.m.state === "failed" ? () => void queueMessage(r.m.text, r.m.key) : undefined}
              held={!writable ? archived ? "Held until restored" : "Thread unavailable" : undefined}
              onDiscard={!writable || r.m.state === "failed" ? () => void discardMessage(r.m.key) : undefined} />
          ),
        )}
        {running && (
          <div className="typing" role="status" aria-label={p.text}>
            <i />
            <i />
            <i />
          </div>
        )}
        {running && liveActivity !== undefined && liveActivity.steps.length > 0 && (
          <div className="msg activity-live">
            <ActivitySteps live steps={liveActivity.steps} omitted={liveActivity.omitted} />
          </div>
        )}
      </div>

      <footer className="composer">
        {!sheet && (error || forkError) && <p className="error-text" role="alert">{error || forkError}</p>}
        {slashOpen && <div className="slash-list" aria-label="Commands" role="group">
          {matches.map((c) => <CommandItem key={c.name} c={c} state={cmdState} active={c === picked}
            onClick={() => runCommand(c, args)} keepFocus />)}
          {!picked ? <p className="sheet-help" role="status">Unknown command /{typed}</p>
            : args !== undefined && <p className="slash-usage" role="status">{argsTooLong
              ? `Arguments are limited to ${ARGS_MAX} characters.` : picked.usage}</p>}
          {!online && <p className="sheet-help">Reconnect to use commands.</p>}
        </div>}
        {archived ? (
          <p className="archived-hint">{archivedLabel(info)} · {online
            ? <button disabled={busy} onClick={() => void toggleArchive()}>Restore to reply</button>
            : "Reconnect to restore"}</p>
        ) : !writable ? <p className="archived-hint">Read-only until thread details are available.</p> : <div className="capsule">
          <button ref={wrenchRef} className="wrench" aria-label="Commands" aria-haspopup="dialog"
            aria-expanded={sheet?.kind === "tools"}
            onClick={(e) => show({ kind: "tools" }, e.currentTarget)}>
            <Icon d={WRENCH_ICON} />
          </button>
          <textarea
            ref={taRef}
            value={text}
            rows={1}
            maxLength={LIMITS.sendTextChars}
            placeholder={running ? `${agentName} is working…` : `Message ${agentName}`}
            aria-label="Message"
            onChange={(e) => { setText(e.target.value); setSlashPick(0); setSlashHidden(false); }}
            onKeyDown={onKeyDown}
            enterKeyHint={FINE_POINTER ? "send" : "enter"}
          />
          <button
            className={running ? "send stop" : "send"}
            aria-label={running ? "Stop" : "Send"}
            data-ready={running || (slash ? !!picked && canRun(picked, cmdState) && !argsTooLong : text.trim() !== "") ? "" : undefined}
            onClick={() => void submit()}
          >
            {running ? (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
              </svg>
            ) : (
              <Icon d="M12 19V5M5.5 11.5 12 5l6.5 6.5" bold />
            )}
          </button>
        </div>}
      </footer>

      {sheet && (
        <Modal opener={opener.current} panel={sheet.kind} title={sheet.kind === "list" ? "Threads" :
          sheet.kind === "menu" ? "Thread menu" : sheet.kind === "message" ? "Message actions" :
            sheet.kind === "tools" ? "Commands" : sheet.kind === "model" ? "Model" : sheet.kind === "confirm-new" ? "New context" :
            sheet.kind === "rename" ? "Rename thread" : "New thread"}
          dismiss={() => { setError(""); setSheet(null); }}>
            <div className="sheet-grip" aria-hidden="true" />
            {sheet.kind === "list" && !wide && <ThreadList store={store} conn={conn} online={online} onNew={() => show({ kind: "create", title: "" })}
              onSelect={(id) => { setSheet(null); store.selectThread(id); }} />}
            {sheet.kind === "menu" && <>
              {writable && <>
                {commands.some((c) => c.name === "new") && <SheetItem icon="M12 5v14M5 12h14" title="New context"
                  sub="Start fresh; earlier messages stay above a divider" disabled={!online} onClick={() => show({ kind: "confirm-new" })} />}
                {commands.some((c) => c.name === "status") && <SheetItem icon="M3 12h4l3-8 4 16 3-8h4" title="Status"
                  sub="Ask the agent what it is doing" disabled={!online} onClick={() => command("status")} />}
              </>}
              <NotificationsItem store={store} conn={conn} online={online} />
              {!main && (writable || archived) && <>
                <SheetItem icon="M4 20h4L20 8l-4-4L4 16v4Z" title="Rename thread" disabled={!online || busy}
                  onClick={() => show({ kind: "rename", title })} />
                <SheetItem icon="M4 9h16v11H4zM3 4h18v5H3zM10 13h4" title={archived ? "Restore thread" : "Archive thread"}
                  sub={archived ? "Make this thread writable again" : "Keep the history, but stop new messages"}
                  disabled={!online || busy} onClick={() => void toggleArchive()} />
              </>}
              {!online && <p className="sheet-help">Reconnect to use these controls.</p>}
              {!writable && !archived && <p className="sheet-help">Thread details are not available.</p>}
            </>}
            {sheet.kind === "tools" && <>
              <h2 className="sheet-heading">Commands</h2>
              {commands.map((c) => <CommandItem key={c.name} c={c} state={cmdState} onClick={() => runCommand(c)} />)}
              {!online && <p className="sheet-help">Reconnect to use commands.</p>}
            </>}
            {sheet.kind === "model" && <>
              <h2 className="sheet-heading">Model</h2>
              {presets.map((p) => {
                const current = p.name === model;
                return <button key={p.name} className="sheet-item preset-item" disabled={!ready(cmdState)}
                  aria-current={current || undefined} onClick={() => {
                    if (!current || pendingModel) conn.selectPreset(thread, p.name);
                    setSheet(null);
                  }}>
                  <span className="preset-text">
                    <b>{presetName(p)}</b>
                    <small><span className="preset-model">{p.model}</span>{p.thinking && <span className="nowrap"> · thinking {p.thinking}</span>}</small>
                  </span>
                  {p.name === pendingModel ? <small className="preset-pending">Switching…</small>
                    : current && <span className="preset-check" role="img" aria-label="Current"><Icon d={CHECK_ICON} bold /></span>}
                </button>;
              })}
              {model === null && <p className="sheet-help">This thread uses a custom model.</p>}
              {!online && <p className="sheet-help">Reconnect to switch models.</p>}
            </>}
            {sheet.kind === "confirm-new" && <>
              <h2 className="sheet-heading">Start a new context?</h2>
              <p className="sheet-help">The agent starts fresh. Earlier messages stay above a divider.</p>
              <button className="primary confirm" disabled={!ready(cmdState)} onClick={() => command("new")}>
                Start new context
              </button>
            </>}
            {sheet.kind === "message" && <SheetItem icon={LIST_ICON} title="Start side thread from here"
              sub="Fork the conversation at this message"
              onClick={() => show({ kind: "create", title: sheet.title, from: sheet.from })} />}
            {(sheet.kind === "create" || sheet.kind === "rename") && (
              <ThreadTitleForm key={sheet.kind} kind={sheet.kind} initial={sheet.title} busy={busy} online={online} save={saveTitle} />
            )}
            {(error || forkError) && <p className="error-text" role="alert">{error || forkError}</p>}
            <button className="sheet-cancel" onClick={() => { setError(""); setSheet(null); }}>
              {sheet.kind === "list" ? "Done" : "Cancel"}
            </button>
        </Modal>
      )}
    </div>
  );
}

function Modal({ title, panel, opener, dismiss, children }: {
  title: string; panel: Sheet["kind"]; opener: HTMLElement | null; dismiss: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => {
      dialog.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [opener]);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const selector = panel === "list" ? ".thread-search" : panel === "create" || panel === "rename" ? "#thread-title" : ".sheet-item:not(:disabled)";
    (dialog.querySelector<HTMLElement>(selector) ?? dialog.querySelector<HTMLElement>(".sheet-cancel"))?.focus();
  }, [panel]);
  return (
    <dialog ref={ref} className="sheet-layer" aria-label={title}
      onCancel={(e) => { e.preventDefault(); dismiss(); }}
      onClick={(e) => { if (e.target === e.currentTarget) dismiss(); }}>
      <div className="sheet">{children}</div>
    </dialog>
  );
}

function ThreadSignals({ store, thread }: { store: Store; thread: string }) {
  const state = store.status(thread).state;
  return <>
    {state !== "idle" && <small className="thread-running">{state === "error" ? "Error" : "Running"}</small>}
    {store.isUnread(thread) && <span className="thread-dot" role="img" aria-label="Unread" />}
  </>;
}

function ThreadList({ store, conn, online, onNew, onSelect }: {
  store: Store; conn: Connection; online: boolean; onNew: () => void; onSelect: (thread: string) => void;
}) {
  const [input, setInput] = useState("");
  const query = input.trim() ? input : "";
  const [remote, setRemote] = useState<{ query: string; ids: ReadonlySet<string> }>();
  useEffect(() => {
    if (!query || !online || TITLE_CONTROL.test(query)) return;
    let current = true;
    const timer = setTimeout(() => conn.searchThreads(query, (ids) => {
      if (current) setRemote({ query, ids });
    }), 250);
    return () => { current = false; clearTimeout(timer); };
  }, [conn, online, query]);

  const side = [...store.threads.values()].filter((t) => t.id !== MAIN_THREAD)
    .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
  const open = openThreads(store);
  const archived = side.filter((t) => t.archived);
  const results = query ? store.searchThreads(query, remote?.query === query ? remote.ids : undefined) : [];
  const row = (t: ThreadInfo, snippet?: string) => (
    <button key={t.id} className="sheet-item thread-row" aria-current={store.openThread === t.id ? "true" : undefined}
      onClick={() => onSelect(t.id)}>
      <span className="thread-name">
        <b>{t.id === MAIN_THREAD ? "Main" : t.title}</b>
        {t.archived && <small>{archivedLabel(t)}</small>}
        {snippet && <small className="thread-snippet">{snippet}</small>}
      </span>
      <ThreadSignals store={store} thread={t.id} />
    </button>
  );
  return <>
    <h2 className="sheet-heading">Threads</h2>
    <input className="thread-search" type="search" aria-label="Search threads" placeholder="Search titles and messages"
      maxLength={LIMITS.threadTitleChars} value={input} onChange={(e) => setInput(e.target.value)} />
    {store.threadListUnavailable && <p className="sheet-help">Could not refresh the thread list. Showing known threads.</p>}
    <div className="thread-list-body">
      {query ? (
        results.length ? results.map(({ thread, snippet }) => row(thread, snippet)) : <p className="sheet-help">No matching threads.</p>
      ) : <>
        <SheetItem icon="M12 5v14M5 12h14" title="New thread" sub="Start an empty conversation" onClick={onNew} />
        {[...store.creates.values()].map((c) => <p className="sheet-help" key={c.key}>
          {c.title || "New thread"} · {c.failed ? "Could not create" : "Waits for connection"}
        </p>)}
        {open.map((t) => row(t))}
        {archived.length > 0 && <details className="thread-archive">
          <summary>Archived ({archived.length}){archived.some((t) => store.isUnread(t.id)) &&
            <span className="thread-dot" role="img" aria-label="Unread" />}</summary>
          {archived.map((t) => row(t))}
        </details>}
      </>}
    </div>
  </>;
}

/**
 * Push is a device setting, so it lives in the thread menu. It asks for
 * permission only on a tap and hides itself once the gateway answers
 * `unsupported` (protocol v2, "Notifications (Web Push)").
 */
function NotificationsItem({ store, conn, online }: { store: Store; conn: Connection; online: boolean }) {
  const [permission, setPermission] = useState<PushPermission>(pushPermission);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  // Learn the gateway's answer while the menu is open, so an unconfigured
  // gateway never shows the row. Opening the menu never asks for permission.
  // A rotated VAPID key rebuilds the browser subscription, but only for a
  // device the owner already turned notifications on for.
  useEffect(() => {
    if (!pushSupported()) return;
    void (async () => {
      // A cleared store must not claim "on" when the browser dropped it.
      if (store.push.endpoint && !(await hasPushSubscription())) {
        await store.setPush({ endpoint: undefined, key: undefined });
      }
      const res = await conn.pushKey();
      if (!res) return; // offline: nothing to compare against yet
      if (!res.ok) {
        if (res.error === "unsupported") await store.setPush({ gatewayUnsupported: true });
        return;
      }
      if (typeof res.key !== "string" || res.key === "") return;
      // One form for comparing: base64url alphabet, no padding (a gateway sending plain base64
      // must not cause a resubscribe on every menu open).
      const gatewayKey = res.key.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      // Compare against the key the store last saw before overwriting it.
      const rotated = store.push.key !== undefined && store.push.key !== gatewayKey;
      await store.setPush({ gatewayUnsupported: false, key: gatewayKey });
      if (!store.push.endpoint) return;
      if (!rotated && await subscribedServerKey() === gatewayKey) return;
      // The gateway's key changed under a live subscription: rebuild it on the
      // new key rather than leaving pushes the gateway cannot address.
      setBusy(true);
      try {
        const renewed = await subscribe(store, conn, gatewayKey);
        setPermission(renewed.permission);
        if (renewed.note) {
          // The old subscription is gone; say so instead of claiming "on".
          await store.setPush({ endpoint: undefined });
          setNote(renewed.note);
        } else {
          setNote("Notifications renewed for this device.");
        }
      } finally {
        setBusy(false);
      }
    })();
  }, [store, conn]);
  if (store.push.gatewayUnsupported) return null;
  const on = !!store.push.endpoint;

  async function toggle() {
    if (busy || permission === "denied" || permission === "unsupported") return;
    setBusy(true);
    setNote("");
    try {
      if (store.push.endpoint) {
        // Offline the gateway cannot drop the subscription, so nothing here is
        // "off" until it says so; the browser side is kept in step after.
        if (!online) {
          setNote("Reconnect to turn notifications off.");
          return;
        }
        const off = await conn.pushUnsubscribe();
        if (!off?.ok) {
          setNote(off
            ? "The gateway did not confirm that notifications are off. Try again."
            : "Reconnect to turn notifications off.");
          return;
        }
        await disablePush();
        await store.setPush({ endpoint: undefined, key: undefined });
        setNote("Notifications are off.");
        return;
      }
      if (!online) {
        setNote("Reconnect to turn notifications on.");
        return;
      }
      // Permission first: the prompt must come straight off the tap.
      const granted = await requestPushPermission();
      setPermission(granted);
      if (granted !== "granted") {
        setNote(granted === "denied"
          ? "Notifications are blocked for this app. Allow them in browser settings, then try again."
          : granted === "unsupported"
            ? "This browser cannot receive notifications. On iPhone, open the installed home-screen app."
            : "Notifications were not allowed. Tap again to ask.");
        return;
      }
      const key = await conn.pushKey();
      if (!key) {
        setNote("Reconnect to turn notifications on.");
        return;
      }
      if (!key.ok) {
        if (key.error === "unsupported") await store.setPush({ gatewayUnsupported: true });
        else setNote("Could not reach notifications on this gateway. Try again.");
        return;
      }
      if (!key.key) {
        setNote("The gateway did not send a notification key. Try again.");
        return;
      }
      const result = await subscribe(store, conn, key.key);
      setPermission(result.permission);
      setNote(result.note ?? "Notifications are on for this device.");
    } finally {
      setBusy(false);
    }
  }

  const blocked = permission === "unsupported" || permission === "denied";
  const sub = permission === "unsupported"
    ? "Not available in this browser. On iPhone, add the app to the home screen first"
    : permission === "denied"
      ? "Blocked. Allow notifications for this app in your browser settings"
      : on ? (online ? "On for new messages. Tap to turn off" : "On for new messages. Reconnect to turn off")
      : online ? "Off. Tap to turn on" : "Off. Reconnect to turn on";
  return <>
    <SheetItem icon={BELL_ICON} title="Notifications" sub={sub} blocked={blocked}
      disabled={busy || blocked} onClick={() => void toggle()} />
    {/* A blocked or unsupported row explains itself; a note would only repeat it. */}
    {note && !blocked && <p className="sheet-help" role="status">{note}</p>}
  </>;
}

/**
 * Browser subscribe with the gateway's key, then `push.subscribe`. Permission
 * must be granted already; nothing here prompts. On failure nothing stays half
 * on: the browser subscription is dropped and `push.subscribe` is never sent.
 */
async function subscribe(store: Store, conn: Connection, key: string): Promise<{
  permission: PushPermission; note?: string;
}> {
  const attempt = await enablePush(key);
  const permission = pushPermission();
  if (attempt.kind !== "subscribed") {
    return { permission, note: attempt.kind === "denied"
      ? "Notifications are blocked for this app. Allow them in browser settings, then try again."
      : "Could not subscribe this device. Try again." };
  }
  const saved = await conn.pushSubscribe(attempt.subscription);
  if (!saved?.ok) {
    await disablePush();
    if (saved?.error === "unsupported") await store.setPush({ gatewayUnsupported: true });
    return { permission, note: saved
      ? "The gateway did not accept this device. Try again."
      : "Reconnect to finish turning notifications on, then try again." };
  }
  await store.setPush({ endpoint: attempt.subscription.endpoint, key });
  return { permission };
}

function ThreadTitleForm({ kind, initial, busy, online, save }: {
  kind: "create" | "rename"; initial: string; busy: boolean; online: boolean; save: (title: string) => void;
}) {
  const [title, setTitle] = useState(initial);
  const create = kind === "create";
  return <form className="thread-form" onSubmit={(e) => { e.preventDefault(); save(title); }}>
    <h2 className="sheet-heading">{create ? "New thread" : "Rename thread"}</h2>
    <label htmlFor="thread-title">{create ? "Title (optional)" : "Title"}</label>
    <input id="thread-title" value={title} onChange={(e) => setTitle(e.target.value)}
      maxLength={LIMITS.threadTitleChars} placeholder="New thread" />
    {!online && <p className="sheet-help">{create ? "This thread will sync when you reconnect." : "Reconnect to rename this thread."}</p>}
    <button className="primary" disabled={busy || TITLE_CONTROL.test(title) || (!create && (!online || !title.trim()))}>
      {create ? "Create thread" : "Save title"}
    </button>
  </form>;
}

function SheetItem(props: { icon: string; title: string; sub?: string; disabled?: boolean; blocked?: boolean; onClick: () => void }) {
  return (
    <button className={props.blocked ? "sheet-item is-blocked" : "sheet-item"} disabled={props.disabled} onClick={props.onClick}>
      <span className="sheet-icon">
        <Icon d={props.icon} />
      </span>
      <span>
        <b>{props.title}</b>
        {props.sub && <small>{props.sub}</small>}
      </span>
    </button>
  );
}

function CommandItem({ c, state, active, keepFocus, onClick }: {
  c: CommandInfo; state: CommandState; active?: boolean; keepFocus?: boolean; onClick: () => void;
}) {
  return (
    <button className="sheet-item command-item" disabled={!canRun(c, state)} aria-current={active || undefined}
      tabIndex={keepFocus ? -1 : undefined} onPointerDown={keepFocus ? (e) => e.preventDefault() : undefined} onClick={onClick}>
      <span className="sheet-icon"><Icon d={COMMAND_ICONS[c.name] ?? COMMAND_ICON} /></span>
      <span>
        <b>/{c.name}{c.args && <span className="command-args"> {c.args}</span>}</b>
        <small>{c.summary}</small>
      </span>
    </button>
  );
}

function Icon({ d, bold }: { d: string; bold?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth={bold ? 2.6 : 2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EventRow({ ev, text, partial, store, last, forks, onActions, onRetry }: {
  ev: DurableEvent; text?: string; partial?: boolean; store: Store; last: boolean; forks?: ThreadInfo[];
  onActions: (ev: MessageEvent, button: HTMLButtonElement) => void;
  onRetry?: (m: Outgoing) => void;
}) {
  if (ev.event === "divider") {
    const t = clock(ev.at);
    return (
      <div className="divider" role="separator">
        <span>New context{t && ` · ${t}`}</span>
      </div>
    );
  }
  if (ev.event !== "message") return null; // settled only drives delivery state
  const body = text ?? ev.text;
  // Stored events come from IndexedDB too; render only well-formed steps.
  const steps = ev.role === "assistant" ? activitySteps(ev.steps) : [];
  const incomplete = partial ? <span className="msg-partial">Incomplete</span> : null;
  const outgoing = ev.key ? store.outgoing(ev.thread, ev.key) : undefined;
  const anchor = Number.isSafeInteger(ev.cursor) && ev.cursor > 0 && ev.role !== "notice"
    ? { "data-message-id": ev.id, "data-message-cursor": ev.cursor, "data-thread-title": suggestedTitle(ev.text), tabIndex: -1 }
    : undefined;
  return <>
    {ev.role === "notice" ? <div className="notice">{body}{incomplete}</div> : ev.role === "user" ? (
      <UserBubble text={body} partial={partial} anchor={anchor} state={outgoing?.state} at={ev.at} last={last}
        onRetry={onRetry && outgoing?.state === "failed" ? () => onRetry(outgoing) : undefined} />
    ) : (
      <div className="msg assistant" {...anchor}>
        <Streamdown mode="static">{body}</Streamdown>
        {steps.length > 0 && <ActivitySteps steps={steps} omitted={typeof ev.omitted === "number" ? ev.omitted : undefined} />}
        {incomplete}
      </div>
    )}
    {(anchor || !!forks?.length) && <div className="msg fork-links" data-role={ev.role}>
      {anchor && <button className="message-actions" aria-label="Message actions" aria-haspopup="dialog"
        onClick={(e) => onActions(ev, e.currentTarget)}>⋯</button>}
      {forks?.map((t) => <button key={t.id} className="fork-chip" onClick={() => store.selectThread(t.id)}>
        <span aria-hidden="true">↳</span><span className="fork-title">{t.title}</span>
        <ThreadSignals store={store} thread={t.id} />
      </button>)}
    </div>}
  </>;
}

const DELIV: Record<OutgoingState, { label: string; icon: ReactNode }> = {
  queued: { label: "Waiting to send", icon: <Icon d="M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0" /> },
  sent: { label: "Sent", icon: <Icon d="M5 12.5 10 17 19 7" /> },
  admitted: { label: "Delivered", icon: <Icon d="M2 12.5 7 17 16 7M12 16l1 1 9-10" /> },
  answered: { label: "Answered", icon: <Icon d="M2 12.5 7 17 16 7M12 16l1 1 9-10" /> },
  failed: { label: "Not sent", icon: <Icon d="M12 8v5M12 16.5v.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0" /> },
  aborted: { label: "Stopped", icon: <Icon d="M6 6l12 12M18 6 6 18" /> },
};

function UserBubble(props: {
  text: string; partial?: boolean; anchor?: React.HTMLAttributes<HTMLDivElement>; state?: OutgoingState;
  at?: string | number; last: boolean; onRetry?: () => void; onDiscard?: () => void; held?: string;
}) {
  const { state } = props;
  const show = state && (props.last || state === "queued" || state === "sent" || state === "failed");
  const d = state && DELIV[state];
  return (
    <div className="row user">
      <div className="bubble" {...props.anchor}>
        {props.text}
        {props.partial && <span className="msg-partial">Incomplete</span>}
      </div>
      {show && d && (
        <span className="deliv" data-state={state}>
          {props.held && (state === "queued" || state === "sent") ? props.held
            : state === "admitted" || state === "answered" || state === "sent" ? clock(props.at) : d.label}
          {props.onRetry && <button className="retry-message" onClick={props.onRetry}>Retry</button>}
          {props.onDiscard && <button className="retry-message" onClick={props.onDiscard}>Discard</button>}
          <span className="deliv-icon" role="img" aria-label={d.label}>
            {d.icon}
          </span>
        </span>
      )}
    </div>
  );
}
