import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { Streamdown } from "streamdown";
import type { Connection } from "./conn";
import type { AgentStatus, Outgoing, OutgoingState, Store } from "./store";
import { LIMITS, type DurableEvent } from "./protocol";
import { Avatar, type AvatarState } from "./Avatar";

const FINE_POINTER = matchMedia("(pointer: fine)").matches;

type Row = { kind: "ev"; ev: DurableEvent } | { kind: "pending"; m: Outgoing };
type Tone = "ok" | "run" | "warn" | "bad";

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
  const s: AgentStatus = store.status;
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
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [text, setText] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const running = isRunning(store.status.state);
  const p = presence(store);

  const rows: Row[] = store.events.map((ev) => ({ kind: "ev", ev }));
  for (const m of store.outbox.values()) {
    if ((m.state === "queued" || m.state === "sent" || m.state === "failed") && !store.hasEcho(m.key)) {
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

  // Stay glued to the bottom while the user is already there (streams,
  // previews and new events all push without yanking the view otherwise).
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }, [text]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [menuOpen]);

  async function submit() {
    if (running) {
      conn.control("abort");
      return;
    }
    const t = text.trim();
    if (!t || t.length > LIMITS.sendTextChars) return;
    setText("");
    pinned.current = true;
    const m = await store.createOutgoing(t);
    conn.sendOutgoing(m);
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
    conn.control(c);
    setMenuOpen(false);
  }

  return (
    <div className="app">
      <header className="top">
        <div className="who">
          <div className="avatar-slot">
            <Avatar state={p.avatar} />
          </div>
          <div className="who-text">
            <h1>Durable</h1>
            <p className="presence" data-tone={p.tone} aria-live="polite">
              {p.text}
            </p>
          </div>
        </div>
        <button
          className="icon-btn"
          aria-label="Thread menu"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(true)}
        >
          <Icon d="M6 12h.01M12 12h.01M18 12h.01" bold />
        </button>
      </header>

      <div
        className="messages"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
      >
        {empty && !running && !store.preview && (
          <div className="empty">
            <div className="avatar-slot big">
              <Avatar state={p.avatar} />
            </div>
            <h2>Durable</h2>
            <p>One ongoing thread with your agent. Ask anything to get started.</p>
          </div>
        )}
        {rows.map((r, i) =>
          r.kind === "ev" ? (
            <EventRow key={`e${r.ev.cursor}`} ev={r.ev} store={store} last={i === lastUser} />
          ) : (
            <UserBubble key={`p${r.m.key}`} text={r.m.text} state={r.m.state} at={r.m.at} last={i === lastUser} />
          ),
        )}
        {store.preview ? (
          <div className="msg assistant streaming" aria-busy="true">
            <Streamdown>{store.preview.text}</Streamdown>
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
        <div className="capsule">
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
        </div>
      </footer>

      {menuOpen && (
        <div className="sheet-layer">
          <button className="sheet-backdrop" aria-label="Close menu" onClick={() => setMenuOpen(false)} />
          <div className="sheet" role="menu" aria-label="Thread menu">
            <div className="sheet-grip" aria-hidden="true" />
            <SheetItem
              icon="M12 5v14M5 12h14"
              title="New thread"
              sub="Start fresh; earlier messages stay above a divider"
              onClick={() => command("new")}
            />
            <SheetItem
              icon="M3 12h4l3-8 4 16 3-8h4"
              title="Status"
              sub="Ask the agent what it is doing"
              onClick={() => command("status")}
            />
            <button className="sheet-cancel" onClick={() => setMenuOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SheetItem(props: { icon: string; title: string; sub: string; onClick: () => void }) {
  return (
    <button role="menuitem" className="sheet-item" onClick={props.onClick}>
      <span className="sheet-icon">
        <Icon d={props.icon} />
      </span>
      <span>
        <b>{props.title}</b>
        <small>{props.sub}</small>
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

function EventRow({ ev, store, last }: { ev: DurableEvent; store: Store; last: boolean }) {
  if (ev.event === "divider") {
    const t = clock(ev.at);
    return (
      <div className="divider" role="separator">
        <span>New thread{t && ` · ${t}`}</span>
      </div>
    );
  }
  if (ev.event !== "message") return null; // settled only drives delivery state
  if (ev.role === "notice") return <div className="notice">{ev.text}</div>;
  if (ev.role === "user") {
    const state = ev.key ? store.outbox.get(ev.key)?.state : undefined;
    return <UserBubble text={ev.text} state={state} at={ev.at} last={last} />;
  }
  return (
    <div className="msg assistant">
      <Streamdown>{ev.text}</Streamdown>
    </div>
  );
}

const DELIV: Record<OutgoingState, { label: string; icon: ReactNode }> = {
  queued: { label: "Waiting to send", icon: <Icon d="M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0" /> },
  sent: { label: "Sent", icon: <Icon d="M5 12.5 10 17 19 7" /> },
  admitted: { label: "Delivered", icon: <Icon d="M2 12.5 7 17 16 7M12 16l1 1 9-10" /> },
  answered: { label: "Answered", icon: <Icon d="M2 12.5 7 17 16 7M12 16l1 1 9-10" /> },
  failed: { label: "Not sent", icon: <Icon d="M12 8v5M12 16.5v.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0" /> },
  aborted: { label: "Stopped", icon: <Icon d="M6 6l12 12M18 6 6 18" /> },
};

function UserBubble(props: { text: string; state?: OutgoingState; at?: string | number; last: boolean }) {
  const { state } = props;
  const show = state && (props.last || state === "queued" || state === "sent" || state === "failed");
  const d = state && DELIV[state];
  return (
    <div className="row user">
      <div className="bubble">{props.text}</div>
      {show && d && (
        <span className="deliv" data-state={state}>
          {state === "admitted" || state === "answered" || state === "sent" ? clock(props.at) : d.label}
          <span className="deliv-icon" role="img" aria-label={d.label}>
            {d.icon}
          </span>
        </span>
      )}
    </div>
  );
}
