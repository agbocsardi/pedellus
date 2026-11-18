import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import type { Connection } from "./conn";
import type { AgentStatus, Outgoing, OutgoingState, Store } from "./store";
import { LIMITS, MAIN_THREAD, type DurableEvent, type MessageEvent, type ThreadInfo, type ThreadOrigin } from "./protocol";
import { Avatar, type AvatarState } from "./Avatar";

const FINE_POINTER = matchMedia("(pointer: fine)").matches;

type Row = { kind: "ev"; ev: DurableEvent } | { kind: "pending"; m: Outgoing };
type Tone = "ok" | "run" | "warn" | "bad";
type Sheet = { kind: "list" | "menu" } | { kind: "rename"; title: string }
  | { kind: "create"; title: string; from?: ThreadOrigin }
  | { kind: "message"; title: string; from: ThreadOrigin };
const LIST_ICON = "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01";
const TITLE_CONTROL = /[\p{Cc}\u2028\u2029]/u;

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

const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
function clock(at: string | number | undefined): string {
  if (at === undefined) return "";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : TIME.format(d);
}

export function Chat({ store, conn }: { store: Store; conn: Connection }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const savingMessage = useRef(false);
  const jumpCursor = useRef<number | undefined>(undefined);
  const pinned = useRef(true);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);

  const thread = store.openThread;
  const main = thread === MAIN_THREAD;
  const info = store.threads.get(thread);
  const title = main ? "Durable" : info?.title ?? "New thread";
  const archived = !!info?.archived;
  const text = drafts[thread] ?? "";
  const setText = (value: string) => setDrafts((prev) => ({ ...prev, [thread]: value }));
  const online = store.connState === "open";
  const running = !archived && isRunning(store.status(thread).state);
  const preview = archived ? undefined : store.preview(thread);
  const p = presence(store);
  const latest = store.latestViewable(thread);
  const origin = info?.origin;
  const source = store.threads.get(origin?.thread ?? MAIN_THREAD);
  const sourceMessage = origin && store.events.get(origin.thread)?.find((ev): ev is MessageEvent =>
    ev.event === "message" && ev.id === origin.messageId);
  const sourceTitle = origin?.thread === MAIN_THREAD ? "Main" : source?.title ?? "another thread";
  const back = source ?? store.threads.get(MAIN_THREAD)!;
  const canRetry = !archived && !running;
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

  const rows: Row[] = (store.events.get(thread) ?? []).map((ev) => ({ kind: "ev", ev }));
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

  useLayoutEffect(() => { pinned.current = true; }, [thread]);
  useEffect(() => cancelPress, []);

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
  useEffect(() => {
    const view = () => {
      const el = scroller.current;
      if (!el || sheet || document.hidden) return;
      if (pinned.current) el.scrollTop = el.scrollHeight;
      markAtBottom(el);
    };
    document.addEventListener("visibilitychange", view);
    return () => document.removeEventListener("visibilitychange", view);
  });
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }, [text, thread, archived]);

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
    if (store.threads.get(thread)?.archived) return;
    if (running) {
      conn.control(thread, "abort");
      return;
    }
    const t = text.trim();
    if (!t || t.length > LIMITS.sendTextChars) return;
    await queueMessage(t);
  }

  async function queueMessage(value: string, retryKey?: string) {
    if (savingMessage.current || store.threads.get(thread)?.archived) return;
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

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // On phones Enter makes a newline; send is the button. On desktop Enter
    // sends and Shift+Enter makes a newline.
    if (e.key === "Enter" && !e.shiftKey && FINE_POINTER) {
      e.preventDefault();
      void submit();
    }
  }

  function command(c: "new" | "status") {
    conn.control(thread, c);
    setSheet(null);
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
        setSheet({ kind: "list" });
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

  useEffect(() => { setSheet(null); setError(""); }, [thread]);

  return (
    <div className="app">
      <header className="top">
        {!main && <button className="thread-back" onClick={() => store.selectThread(back.id)}
          aria-label={`Back to ${back.id === MAIN_THREAD ? "Main" : back.title}`}>
          <span aria-hidden="true">‹</span><span>{back.id === MAIN_THREAD ? "Main" : back.title}</span>
        </button>}
        <div className="who">
          <div className="avatar-slot">
            <Avatar state={p.avatar} />
          </div>
          <div className="who-text">
            <h1><button className="thread-switch" aria-label={`${title}, open threads`} aria-haspopup="dialog"
              aria-expanded={sheet?.kind === "list"} onClick={(e) => show({ kind: "list" }, e.currentTarget)}>
              <span className="switch-title">{title}</span><span aria-hidden="true">▾</span>
              {hasOtherActivity && <span className="thread-dot" role="img" aria-label="Activity in another thread" />}
            </button></h1>
            <p className="presence" data-tone={p.tone} aria-live="polite">
              {p.text}
            </p>
          </div>
        </div>
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
        {!origin && empty && !running && !preview && (
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
            <EventRow key={`e${r.ev.cursor}`} ev={r.ev} store={store} last={i === lastUser}
              forks={r.ev.event === "message" ? forks.get(r.ev.id) : undefined}
              onActions={(ev, button) => show({ kind: "message", title: suggestedTitle(ev.text),
                from: { thread: ev.thread, messageId: ev.id } }, button)}
              onRetry={canRetry ? (m) => void queueMessage(m.text, m.key) : undefined} />
          ) : (
            <UserBubble key={`p${r.m.key}`} text={r.m.text} state={r.m.state} at={r.m.at} last={i === lastUser}
              onRetry={canRetry && r.m.state === "failed" ? () => void queueMessage(r.m.text, r.m.key) : undefined}
              held={archived} />
          ),
        )}
        {preview ? (
          <div className="msg assistant streaming" aria-busy="true">
            <Streamdown>{preview.text}</Streamdown>
          </div>
        ) : running ? (
          <div className="typing" role="status" aria-label={p.text}>
            <i />
            <i />
            <i />
          </div>
        ) : null}
      </div>

      <footer className="composer">
        {!sheet && (error || forkError) && <p className="error-text" role="alert">{error || forkError}</p>}
        {archived ? (
          <p className="archived-hint">{archivedLabel(info)} · {online
            ? <button disabled={busy} onClick={() => void toggleArchive()}>Restore to reply</button>
            : "Reconnect to restore"}</p>
        ) : <div className="capsule">
          <textarea
            ref={taRef}
            value={text}
            rows={1}
            maxLength={LIMITS.sendTextChars}
            placeholder={running ? "Durable is working…" : "Message Durable"}
            aria-label="Message"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            enterKeyHint={FINE_POINTER ? "send" : "enter"}
          />
          <button
            className={running ? "send stop" : "send"}
            aria-label={running ? "Stop" : "Send"}
            data-ready={running || text.trim() !== "" ? "" : undefined}
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
            sheet.kind === "rename" ? "Rename thread" : "New thread"}
          dismiss={() => { setError(""); setSheet(null); }}>
            <div className="sheet-grip" aria-hidden="true" />
            {sheet.kind === "list" && <ThreadList store={store} conn={conn} online={online} onNew={() => show({ kind: "create", title: "" })}
              onSelect={(id) => { setSheet(null); store.selectThread(id); }} />}
            {sheet.kind === "menu" && <>
              {!archived && <>
                <SheetItem icon="M12 5v14M5 12h14" title="New context"
                  sub="Start fresh; earlier messages stay above a divider" disabled={!online} onClick={() => command("new")} />
                <SheetItem icon="M3 12h4l3-8 4 16 3-8h4" title="Status"
                  sub="Ask the agent what it is doing" disabled={!online} onClick={() => command("status")} />
              </>}
              {!main && <>
                <SheetItem icon="M4 20h4L20 8l-4-4L4 16v4Z" title="Rename thread" disabled={!online || busy}
                  onClick={() => show({ kind: "rename", title })} />
                <SheetItem icon="M4 9h16v11H4zM3 4h18v5H3zM10 13h4" title={archived ? "Restore thread" : "Archive thread"}
                  sub={archived ? "Make this thread writable again" : "Keep the history, but stop new messages"}
                  disabled={!online || busy} onClick={() => void toggleArchive()} />
              </>}
              {!online && <p className="sheet-help">Reconnect to use these controls.</p>}
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
  const query = input.trim();
  useEffect(() => {
    if (!query || !online || TITLE_CONTROL.test(query)) return;
    const timer = setTimeout(() => conn.searchThreads(query), 250);
    return () => clearTimeout(timer);
  }, [conn, online, query]);

  const main = store.threads.get(MAIN_THREAD)!;
  const side = [...store.threads.values()].filter((t) => t.id !== MAIN_THREAD)
    .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
  const archived = side.filter((t) => t.archived);
  const results = query ? store.searchThreads(query) : [];
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
    {query ? (
      results.length ? results.map(({ thread, snippet }) => row(thread, snippet)) : <p className="sheet-help">No matching threads.</p>
    ) : <>
      <SheetItem icon="M12 5v14M5 12h14" title="New thread" sub="Start an empty conversation" onClick={onNew} />
      {[...store.creates.values()].map((c) => <p className="sheet-help" key={c.key}>
        {c.title || "New thread"} · {c.failed ? "Could not create" : "Waits for connection"}
      </p>)}
      {row(main)}
      {side.filter((t) => !t.archived).map((t) => row(t))}
      {archived.length > 0 && <details className="thread-archive">
        <summary>Archived ({archived.length}){archived.some((t) => store.isUnread(t.id)) &&
          <span className="thread-dot" role="img" aria-label="Unread" />}</summary>
        {archived.map((t) => row(t))}
      </details>}
    </>}
  </>;
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

function SheetItem(props: { icon: string; title: string; sub?: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button className="sheet-item" disabled={props.disabled} onClick={props.onClick}>
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

function EventRow({ ev, store, last, forks, onActions, onRetry }: {
  ev: DurableEvent; store: Store; last: boolean; forks?: ThreadInfo[];
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
  const outgoing = ev.key ? store.outgoing(ev.thread, ev.key) : undefined;
  const anchor = Number.isSafeInteger(ev.cursor) && ev.cursor > 0 && ev.role !== "notice"
    ? { "data-message-id": ev.id, "data-message-cursor": ev.cursor, "data-thread-title": suggestedTitle(ev.text), tabIndex: -1 }
    : undefined;
  return <>
    {ev.role === "notice" ? <div className="notice">{ev.text}</div> : ev.role === "user" ? (
      <UserBubble text={ev.text} anchor={anchor} state={outgoing?.state} at={ev.at} last={last}
        onRetry={onRetry && outgoing?.state === "failed" ? () => onRetry(outgoing) : undefined} />
    ) : (
      <div className="msg assistant" {...anchor}>
        <Streamdown>{ev.text}</Streamdown>
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
  text: string; anchor?: React.HTMLAttributes<HTMLDivElement>; state?: OutgoingState; at?: string | number;
  last: boolean; onRetry?: () => void; held?: boolean;
}) {
  const { state } = props;
  const show = state && (props.last || state === "queued" || state === "sent" || state === "failed");
  const d = state && DELIV[state];
  return (
    <div className="row user">
      <div className="bubble" {...props.anchor}>{props.text}</div>
      {show && d && (
        <span className="deliv" data-state={state}>
          {props.held && (state === "queued" || state === "sent") ? "Held until restored"
            : state === "admitted" || state === "answered" || state === "sent" ? clock(props.at) : d.label}
          {props.onRetry && <button className="retry-message" onClick={props.onRetry}>Retry</button>}
          <span className="deliv-icon" role="img" aria-label={d.label}>
            {d.icon}
          </span>
        </span>
      )}
    </div>
  );
}
