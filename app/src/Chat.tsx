import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useSyncExternalStore } from "react";
import { Streamdown } from "streamdown";
import type { Connection } from "./conn";
import type { AgentStatus, Outgoing, OutgoingState, Store } from "./store";
import type { DurableEvent } from "./protocol";

const DELIV: Record<OutgoingState, string> = {
  queued: "queued",
  sent: "sent",
  admitted: "✓",
  answered: "✓✓",
  failed: "not sent",
  aborted: "aborted",
};

const FINE_POINTER = matchMedia("(pointer: fine)").matches;

type Row = { kind: "ev"; ev: DurableEvent } | { kind: "pending"; m: Outgoing };

function pill(store: Store): { text: string; kind: "ok" | "run" | "warn" | "bad" } {
  switch (store.connState) {
    case "offline":
      return { text: "Offline", kind: "bad" };
    case "connecting":
      return { text: "Reconnecting…", kind: "warn" };
    case "replaying":
      return { text: "Catching up…", kind: "warn" };
  }
  const s: AgentStatus = store.status;
  switch (s.state) {
    case "idle":
      return { text: "Ready", kind: "ok" };
    case "queued":
      return { text: "Queued", kind: "run" };
    case "thinking":
      return { text: "Thinking", kind: "run" };
    case "tool":
      return { text: s.label || "Working", kind: "run" };
    case "error":
      return { text: "Error", kind: "bad" };
  }
}

function isRunning(state: AgentStatus["state"]): boolean {
  return state === "queued" || state === "thinking" || state === "tool";
}

export function Chat({ store, conn }: { store: Store; conn: Connection }) {
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [text, setText] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const running = isRunning(store.status.state);
  const p = pill(store);

  const rows: Row[] = store.events.map((ev) => ({ kind: "ev", ev }));
  for (const m of store.outbox.values()) {
    if ((m.state === "queued" || m.state === "sent" || m.state === "failed") && !store.hasEcho(m.key)) {
      rows.push({ kind: "pending", m });
    }
  }

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

  async function submit() {
    if (running) {
      conn.control("abort");
      return;
    }
    const t = text.trim();
    if (!t) return;
    setText("");
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

  return (
    <div className="app">
      <header className="top">
        <div className="who">
          <div className="mark small" aria-hidden="true" />
          <h1>Durable</h1>
        </div>
        <span className="pill" data-kind={p.kind}>
          <i aria-hidden="true" />
          {p.text}
        </span>
        <div className="menu">
          <button
            className="icon-btn"
            aria-label="Thread menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            ⋯
          </button>
          {menuOpen && (
            <>
              <button
                className="menu-backdrop"
                aria-hidden="true"
                onClick={() => setMenuOpen(false)}
              />
              <div className="menu-pop" role="menu">
                <button
                  role="menuitem"
                  onClick={() => {
                    conn.control("new");
                    setMenuOpen(false);
                  }}
                >
                  New thread
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    conn.control("status");
                    setMenuOpen(false);
                  }}
                >
                  Status
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      <div
        className="messages"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
      >
        {rows.length === 0 && !running && (
          <div className="empty dim">Say something to your agent.</div>
        )}
        {rows.map((r) =>
          r.kind === "ev" ? <EventRow key={`e${r.ev.cursor}`} ev={r.ev} store={store} /> : (
            <UserBubble key={`p${r.m.key}`} text={r.m.text} state={r.m.state} />
          ),
        )}
        {store.preview ? (
          <div className="msg assistant streaming">
            <Streamdown>{store.preview.text}</Streamdown>
          </div>
        ) : running ? (
          <div className="msg assistant streaming">
            <span className="typing" aria-label="working">…</span>
          </div>
        ) : null}
      </div>

      <footer className="composer">
        <textarea
          ref={taRef}
          value={text}
          rows={1}
          placeholder={running ? "The agent is working…" : "Message"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          enterKeyHint={FINE_POINTER ? "send" : "enter"}
        />
        <button
          className={running ? "send stop" : "send"}
          aria-label={running ? "Stop" : "Send"}
          onClick={() => void submit()}
        >
          {running ? "■" : "↑"}
        </button>
      </footer>
    </div>
  );
}

function EventRow({ ev, store }: { ev: DurableEvent; store: Store }) {
  if (ev.event === "divider") {
    return (
      <div className="divider" role="separator">
        <span>new thread</span>
      </div>
    );
  }
  if (ev.event !== "message") return null; // settled only drives delivery state
  if (ev.role === "notice") return <div className="notice">{ev.text}</div>;
  if (ev.role === "user") {
    const state = ev.key ? store.outbox.get(ev.key)?.state : undefined;
    return <UserBubble text={ev.text} state={state} />;
  }
  return (
    <div className="msg assistant">
      <Streamdown>{ev.text}</Streamdown>
    </div>
  );
}

function UserBubble({ text, state }: { text: string; state?: OutgoingState }) {
  return (
    <div className="row user">
      <div className="bubble">{text}</div>
      {state && (
        <span className={state === "failed" || state === "aborted" ? "deliv bad" : "deliv"}>
          {DELIV[state]}
        </span>
      )}
    </div>
  );
}
