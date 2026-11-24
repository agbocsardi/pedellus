import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { ArtifactViewer, type AttachmentView } from "./Attachments";
import { Avatar } from "./Avatar";
import {
  CONFIRM, FALLBACK_COMMANDS, FINE_POINTER, canRun, isRunning, presence, presetName, ready, useStableCallback,
  type CommandState,
} from "./chat-shared";
import { Composer, type ComposerHandle } from "./Composer";
import type { Connection } from "./conn";
import { MessageList } from "./MessageList";
import { LIMITS, MAIN_THREAD, type CommandInfo } from "./protocol";
import { clearAppBadge } from "./push";
import { badTitle, SheetHost, type Sheet } from "./Sheets";
import type { Store } from "./store";
import { openThreads, ThreadList } from "./ThreadList";
import { Icon } from "./ui";

/** From here the thread list is a sidebar and the chat sits beside it. */
const WIDE = "(min-width: 900px)";
/** A picked preset that the gateway accepts but never confirms stops pulsing after this. */
const MODEL_PENDING_MS = 15_000;
/** A DOM `MessageEvent`; the protocol's `MessageEvent` would shadow the global name. */
type SwMessage = Event & { origin: string; source: MessageEventSource | null; data?: unknown };

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

/**
 * The chat screen: header, sidebar, sheets and the artifact viewer, around the message list and
 * the composer. It re-renders on any store change; the message list only on its own thread's.
 */
export function Chat({ store, conn }: { store: Store; conn: Connection }) {
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  /** The artifact in the full-screen viewer, if one is open. */
  const [artifact, setArtifact] = useState<AttachmentView | null>(null);
  const wide = useWideLayout();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const wrenchRef = useRef<HTMLButtonElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const opener = useRef<HTMLElement | null>(null);
  /** The list follows new content while pinned; a send pins it. */
  const pinned = useRef(true);

  const thread = store.openThread;
  const main = thread === MAIN_THREAD;
  const info = store.threads.get(thread);
  const title = main ? store.agentName : info?.title ?? "New thread";
  const archived = !!info?.archived;
  const writable = store.canWrite(thread);
  const online = store.connState === "open";
  const running = !archived && isRunning(store.status(thread).state);
  const p = presence(store, thread);
  const source = store.threads.get(info?.origin?.thread ?? MAIN_THREAD);
  const back = source ?? store.threads.get(MAIN_THREAD)!;
  const cmdState: CommandState = { online, writable, running };
  const commands = store.commands ?? FALLBACK_COMMANDS;
  const presets = store.presets ?? [];
  const model = store.model(thread);
  const pendingModel = store.pendingModel(thread);
  const shown = pendingModel ?? model;
  const chipText = shown === null ? "custom" : shown === undefined ? "model"
    : presetName(presets.find((p) => p.name === shown) ?? { name: shown, model: "" });
  const forkError = store.forkRejected ? "Could not start a side thread from that message." : "";
  let hasOtherActivity = false;
  for (const t of store.threads.values()) {
    if (t.id !== thread && (store.isUnread(t.id) || isRunning(store.status(t.id).state))) {
      hasOtherActivity = true;
      break;
    }
  }

  // The viewer belongs to one message of one thread; a thread switch closes it.
  useEffect(() => { setArtifact(null); }, [thread]);
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

  const show = useStableCallback((next: Sheet, trigger?: HTMLElement) => {
    if (!sheet) opener.current = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    composer.current?.blur();
    store.clearForkRejection();
    setError("");
    setSheet(next);
  });
  const retry = useStableCallback((text: string, key: string) => composer.current?.retry(text, key));
  const dismiss = () => {
    setError("");
    setSheet(null);
  };

  function command(c: string, args?: string) {
    conn.control(thread, c, args);
    setSheet(null);
  }

  /** `args` is the text after `/name `; undefined when picked from a list. */
  function runCommand(c: CommandInfo, args?: string) {
    // Every path (Enter, send button, tapping a list row) passes through here.
    if (!canRun(c, cmdState) || (args?.trim().length ?? 0) > LIMITS.controlArgsChars) return;
    if (c.args && args === undefined) {
      // Commands with arguments go through the composer, with usage shown.
      composer.current?.fill(`/${c.name} `);
      if (sheet) {
        setSheet(null);
        // On touch, the tap into the field opens the keyboard (strategy F);
        // a programmatic focus here would let iOS scroll the page.
        if (FINE_POINTER) requestAnimationFrame(() => composer.current?.focus());
      }
      return;
    }
    composer.current?.clearSlash();
    // From the `/` menu the field still has focus; return it to the wrench
    // after the confirm sheet, not to the field (which would re-trigger iOS).
    if (CONFIRM.has(c.name)) show({ kind: "confirm-new" }, sheet ? undefined : wrenchRef.current ?? undefined);
    else command(c.name, args?.trim() || undefined);
  }

  async function saveTitle(value: string) {
    const name = value.trim();
    if (busy || badTitle(name)) return;
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
    } catch (err) {
      setError(err instanceof DOMException && err.name === "QuotaExceededError"
        ? "Not enough storage on this device for these files."
        : "Can’t save offline on this device.");
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

  useEffect(() => { setSheet(null); setError(""); }, [thread]);

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
  // keeps its own Enter/Shift+Enter handling.
  const shortcut = useEffectEvent((e: KeyboardEvent) => {
    // An IME composition owns its keys (Esc cancels the composition, not the sheet).
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") {
      if (!sheet) return;
      e.preventDefault();
      dismiss();
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

      <MessageList store={store} conn={conn} thread={thread} covered={!!sheet} wide={wide} pinned={pinned}
        onSheet={show} onRetry={retry} onError={setError} onOpenArtifact={setArtifact} openArtifactId={artifact?.id} />

      <Composer ref={composer} store={store} conn={conn} thread={thread} info={info} online={online}
        writable={writable} running={running} sheetOpen={!!sheet} toolsOpen={sheet?.kind === "tools"}
        error={error} forkError={forkError} setError={setError} busy={busy} pinned={pinned} wrenchRef={wrenchRef}
        commands={commands} cmdState={cmdState} onTools={(trigger) => show({ kind: "tools" }, trigger)}
        onRunCommand={runCommand} onRestore={() => void toggleArchive()} />

      {sheet && <SheetHost sheet={sheet} opener={opener.current} store={store} conn={conn} thread={thread}
        wide={wide} online={online} writable={writable} archived={archived} main={main} title={title} busy={busy}
        error={error || forkError} commands={commands} cmdState={cmdState} presets={presets} model={model}
        pendingModel={pendingModel} dismiss={dismiss} show={show}
        select={(id) => { setSheet(null); store.selectThread(id); }}
        command={command} runCommand={(c) => runCommand(c)} toggleArchive={() => void toggleArchive()}
        saveTitle={(value) => void saveTitle(value)} />}

      {artifact && <ArtifactViewer file={artifact} onClose={() => setArtifact(null)} />}
    </div>
  );
}
