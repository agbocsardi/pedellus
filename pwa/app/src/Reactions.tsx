import { useEffect, useRef, useState } from "react";
import type { Connection } from "./conn";
import { REACTIONS, type Reaction, type ThreadId } from "./protocol";
import type { Store } from "./store";

/** The neutral "add a reaction" mark; small next to a message rather than a toolbar. */
const REACT_ICON = "M12 5v14M5 12h14";

/**
 * Owner reactions on one message (protocol v2, Reactions): a quiet button, a six-emoji palette and
 * the badge for the reaction the gateway has actually stored.
 *
 * The palette opens as a card under the message instead of a floating overlay, so it never depends
 * on a scroll position, is never clipped by the message list and never moves the page. The badge
 * only follows the durable `reaction` event: a tap shows nothing until the gateway confirms it
 * (no optimistic state), and tapping the emoji already shown clears the reaction.
 */
export function Reactions({ store, conn, thread, messageId, role }: {
  store: Store; conn: Connection; thread: ThreadId; messageId: string; role: "user" | "assistant";
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement | null>(null);
  const current = store.reaction(thread, messageId);

  useEffect(() => {
    if (!open) return;
    const pointer = (event: Event) => {
      if (wrap.current && event.target instanceof Node && !wrap.current.contains(event.target)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  // An archived or unconfirmed thread cannot be written to, so there is nothing to offer.
  if (!store.canWrite(thread)) return null;

  const choose = (emoji: Reaction) => {
    conn.react(thread, messageId, current === emoji ? null : emoji);
    setOpen(false);
  };
  return (
    <span className="reactions" data-role={role} ref={wrap}>
      {current != null && <span className="reaction-badge" role="img" aria-label={`Reacted ${current}`}>{current}</span>}
      <button type="button" className="reaction-trigger" aria-label="React to this message"
        aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d={REACT_ICON} fill="none" stroke="currentColor" strokeWidth={2}
            strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <span className="reaction-palette" role="group" aria-label="Reactions">
          {REACTIONS.map((emoji) => (
            <button key={emoji} type="button" className="reaction-choice" aria-pressed={current === emoji}
              aria-label={current === emoji ? `Clear your ${emoji} reaction` : `React with ${emoji}`}
              onClick={() => choose(emoji)}>{emoji}</button>
          ))}
        </span>
      )}
    </span>
  );
}
