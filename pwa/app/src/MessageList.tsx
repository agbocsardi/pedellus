import { memo, useEffect, useRef, useSyncExternalStore, type HTMLAttributes, type ReactNode, type RefObject } from "react";
import { Streamdown } from "streamdown";
import { ActivitySteps } from "./ActivitySteps";
import { AttachmentList, messageViews, pendingViews, type AttachmentView } from "./Attachments";
import { Avatar } from "./Avatar";
import { clock, isRunning, presence, suggestedTitle } from "./chat-shared";
import type { Connection } from "./conn";
import { LoginCard } from "./LoginCard";
import {
  MAIN_THREAD, parseActivitySteps,
  type DurableEvent, type MessageEvent, type ThreadInfo, type ThreadOrigin,
} from "./protocol";
import { QuestionCard } from "./Question";
import { Reactions } from "./Reactions";
import type { Sheet } from "./Sheets";
import type { Outgoing, OutgoingState, Store } from "./store";
import { ThreadSignals } from "./ThreadList";
import { Icon, REMOVE_ICON } from "./ui";
import { useAnchoredScroll } from "./useAnchoredScroll";

type Row = { kind: "ev"; ev: DurableEvent; text?: string; partial?: boolean } | { kind: "pending"; m: Outgoing };

function forkAction(target: EventTarget | null, thread: string): Sheet | undefined {
  if (!(target instanceof Element) || target.closest("a, button, input, summary")) return;
  const data = target.closest<HTMLElement>("[data-message-id]")?.dataset;
  if (data?.messageId) return { kind: "message", title: data.threadTitle ?? "", from: { thread, messageId: data.messageId } };
}

/**
 * The open thread's conversation. It renders only when something in this thread changes (the
 * store's `threadSnapshot`) or a prop does, so typing in the composer or traffic in another thread
 * never re-renders the message trees or re-runs the scroll effects. Callback props must be stable.
 */
export const MessageList = memo(function MessageList({
  store, conn, thread, covered, wide, pinned, onSheet, onRetry, onError, onOpenArtifact, openArtifactId,
}: {
  store: Store; conn: Connection; thread: string;
  /** A sheet is open over the list. */
  covered: boolean;
  wide: boolean;
  pinned: RefObject<boolean>;
  onSheet: (sheet: Sheet, trigger?: HTMLElement) => void;
  onRetry: (text: string, key: string) => void;
  onError: (message: string) => void;
  onOpenArtifact: (file: AttachmentView) => void;
  openArtifactId?: string;
}) {
  useSyncExternalStore(store.subscribe, () => store.threadSnapshot(thread));
  const scroller = useRef<HTMLDivElement>(null);
  const jumpCursor = useRef<number | undefined>(undefined);
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);

  const main = thread === MAIN_THREAD;
  const info = store.threads.get(thread);
  const title = main ? store.agentName : info?.title ?? "New thread";
  const archived = !!info?.archived;
  const writable = store.canWrite(thread);
  const running = !archived && isRunning(store.status(thread).state);
  const canRetry = writable && !running;
  const liveActivity = store.activity(thread);
  // A live MCP login offer for this thread; memory-only, so a reload drops it.
  const login = store.login(thread);
  const p = presence(store, thread);
  const latest = store.latestViewable(thread);
  const origin = info?.origin;
  const forks = new Map<string, ThreadInfo[]>();
  for (const t of store.threads.values()) {
    if (t.origin?.thread !== thread) continue;
    const children = forks.get(t.origin.messageId) ?? [];
    children.push(t);
    forks.set(t.origin.messageId, children);
  }

  // A split message is one row: its parts are joined in `i` order here, and a message whose other
  // parts have not arrived yet is marked incomplete.
  const rows: Row[] = [];
  const splitSeen = new Set<string>();
  // A question changes state through further events for the same id; only the latest is shown.
  const latestQuestion = new Map<string, number>();
  const events = store.events.get(thread) ?? [];
  for (const ev of events) {
    if (ev.event === "question") latestQuestion.set(ev.id, ev.cursor);
  }
  for (const ev of events) {
    if (ev.event === "question" && latestQuestion.get(ev.id) !== ev.cursor) continue;
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

  const onScroll = useAnchoredScroll({
    scroller, thread, covered, wide, pinned, jumpCursor,
    atBottom: () => store.markViewed(thread, latest),
  });

  function cancelPress() {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  }
  useEffect(() => cancelPress, []);

  const discard = (key: string) => {
    void store.discardOutgoing(key).catch(() => onError("Could not discard this queued message."));
  };

  return (
    <div
      className="messages"
      ref={scroller}
      onScroll={(e) => {
        cancelPress();
        onScroll(e.currentTarget);
      }}
      onContextMenu={(e) => {
        const action = forkAction(e.target, thread);
        if (!action) return;
        e.preventDefault();
        cancelPress();
        onSheet(action);
      }}
      onPointerDown={(e) => {
        cancelPress();
        if (e.button !== 0 || !e.isPrimary) return;
        const action = forkAction(e.target, thread);
        if (!action) return;
        press.current = { x: e.clientX, y: e.clientY, timer: setTimeout(() => {
          press.current = null;
          onSheet(action);
        }, 550) };
      }}
      onPointerMove={(e) => {
        const at = press.current;
        if (at && Math.hypot(e.clientX - at.x, e.clientY - at.y) > 10) cancelPress();
      }}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onPointerLeave={cancelPress}
    >
      {origin && <OriginCard store={store} origin={origin} onJump={(cursor) => {
        jumpCursor.current = cursor;
        store.selectThread(origin.thread);
      }} />}
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
            store={store} conn={conn} thread={thread} last={i === lastUser}
            forks={r.ev.event === "message" ? forks.get(r.ev.id) : undefined}
            onActions={(ev, button) => onSheet({ kind: "message", title: suggestedTitle(ev.text),
              from: { thread: ev.thread, messageId: ev.id } }, button)}
            onOpenArtifact={onOpenArtifact} openArtifactId={openArtifactId}
            onRetry={canRetry ? (m) => onRetry(m.text, m.key) : undefined} />
        ) : (
          <UserBubble key={`p${r.m.key}`} text={r.m.text} state={r.m.state} at={r.m.at} last={i === lastUser}
            onRetry={canRetry && r.m.state === "failed" ? () => onRetry(r.m.text, r.m.key) : undefined}
            held={!writable ? archived ? "Held until restored" : "Thread unavailable" : undefined}
            files={pendingViews(r.m)}
            note={r.m.note}
            onDiscard={!writable || r.m.state === "failed" ? () => discard(r.m.key) : undefined} />
        ),
      )}
      {login !== undefined && (
        <div className="msg login-card-wrap">
          <LoginCard login={login} />
        </div>
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
  );
});

/** Where a side thread started; it follows its source thread, which this list does not. */
function OriginCard({ store, origin, onJump }: {
  store: Store; origin: ThreadOrigin; onJump: (cursor: number | undefined) => void;
}) {
  useSyncExternalStore(store.subscribe, () => store.threadSnapshot(origin.thread));
  const source = store.threads.get(origin.thread);
  const sourceMessage = store.events.get(origin.thread)?.find((ev): ev is MessageEvent =>
    ev.event === "message" && ev.id === origin.messageId);
  const sourceTitle = origin.thread === MAIN_THREAD ? "Main" : source?.title ?? "another thread";
  return (
    <div className="msg origin-card-wrap">
      <button className="origin-card" onClick={() => onJump(sourceMessage?.cursor)}>
        <b>Started from {sourceTitle}</b>
        <span>{sourceMessage?.text.slice(0, 220).trim() || "Original message not cached."}
          {(sourceMessage?.text.length ?? 0) > 220 ? "…" : ""}</span>
      </button>
    </div>
  );
}

/** Markdown is the expensive part of a row; it re-renders only when its text changes. */
const MessageBody = memo(function MessageBody({ text }: { text: string }) {
  return <Streamdown mode="static">{text}</Streamdown>;
});

function EventRow({ ev, text, partial, store, conn, thread, last, forks, onActions, onRetry, onOpenArtifact, openArtifactId }: {
  ev: DurableEvent; text?: string; partial?: boolean; store: Store; conn: Connection; thread: string;
  last: boolean; forks?: ThreadInfo[];
  onActions: (ev: MessageEvent, button: HTMLButtonElement) => void;
  onRetry?: (m: Outgoing) => void;
  onOpenArtifact: (file: AttachmentView) => void;
  openArtifactId?: string;
}) {
  if (ev.event === "question") return <QuestionCard ev={ev} store={store} conn={conn} />;
  if (ev.event === "divider") {
    const t = clock(ev.at);
    return (
      <div className={ev.reason === "idle" ? "divider idle" : "divider"} role="separator">
        <span>{ev.reason === "idle" ? "Idle compact" : "New context"}{t && ` · ${t}`}</span>
      </div>
    );
  }
  if (ev.event !== "message") return null; // settled only drives delivery state
  const body = text ?? ev.text;
  // Stored events come from IndexedDB too; render only well-formed steps.
  const steps = ev.role === "assistant" ? parseActivitySteps(ev.steps) : [];
  const incomplete = partial ? <span className="msg-partial">Incomplete</span> : null;
  const outgoing = ev.key ? store.outgoing(ev.thread, ev.key) : undefined;
  const spentFiles = outgoing?.state === "failed" && !!outgoing.attachments?.length && store.hasEcho(ev.thread, ev.key!);
  const anchor = Number.isSafeInteger(ev.cursor) && ev.cursor > 0 && ev.role !== "notice"
    ? { "data-message-id": ev.id, "data-message-cursor": ev.cursor, "data-thread-title": suggestedTitle(ev.text), tabIndex: -1 }
    : undefined;
  return <>
    {ev.role === "notice" ? <div className="notice">{body}{incomplete}</div> : ev.role === "user" ? (
      <UserBubble text={body} partial={partial} anchor={anchor} state={outgoing?.state} at={ev.at} last={last}
        files={messageViews(ev.attachments)}
        // Uploads are consumed by an admitted send, so a failed turn with files cannot be retried as is.
        note={spentFiles ? "Files are sent once. Attach them again to retry" : undefined}
        onRetry={onRetry && outgoing?.state === "failed" && !spentFiles ? () => onRetry(outgoing) : undefined} />
    ) : (
      <div className="msg assistant" {...anchor}>
        <MessageBody text={body} />
        {steps.length > 0 && <ActivitySteps steps={steps} omitted={typeof ev.omitted === "number" ? ev.omitted : undefined} />}
        <AttachmentList files={messageViews(ev.attachments)} onOpenArtifact={onOpenArtifact}
          openArtifactId={openArtifactId} />
        {incomplete}
      </div>
    )}
    {(anchor || !!forks?.length) && <div className="msg fork-links" data-role={ev.role}>
      {anchor && <button className="message-actions" aria-label="Message actions" aria-haspopup="dialog"
        onClick={(e) => onActions(ev, e.currentTarget)}>⋯</button>}
      {/* One control row per message: the reaction control sits beside ⋯, not on its own line. */}
      {anchor && (ev.role === "user" || ev.role === "assistant") &&
        <Reactions store={store} conn={conn} thread={thread} messageId={ev.id} />}
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
  aborted: { label: "Stopped", icon: <Icon d={REMOVE_ICON} /> },
};

function UserBubble(props: {
  text: string; partial?: boolean; anchor?: HTMLAttributes<HTMLDivElement>; state?: OutgoingState;
  at?: string | number; last: boolean; onRetry?: () => void; onDiscard?: () => void; held?: string;
  files?: AttachmentView[]; note?: string;
}) {
  const { state } = props;
  const show = state && (props.last || state === "queued" || state === "sent" || state === "failed");
  const d = state && DELIV[state];
  return (
    <div className="row user">
      <div className="bubble" data-files={props.files?.length ? "" : undefined} {...props.anchor}>
        {props.files && <AttachmentList files={props.files} />}
        {props.text && <span className="bubble-text">{props.text}</span>}
        {props.partial && <span className="msg-partial">Incomplete</span>}
      </div>
      {show && d && (
        <span className="deliv" data-state={state}>
          {props.held && (state === "queued" || state === "sent") ? props.held
            : state === "admitted" || state === "answered" || state === "sent" ? clock(props.at) : d.label}
          {props.note && state === "failed" && <span className="deliv-note"> · {props.note}</span>}
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
