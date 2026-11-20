import { useEffect, useRef, useState } from "react";
import type { Connection } from "./conn";
import { REACTIONS, type Reaction, type ThreadId } from "./protocol";
import type { Store } from "./store";

/** A smiley with a plus: "react", not the plain plus that reads as "add an attachment". */
const REACT_ICON = (
  <>
    <circle cx="9.5" cy="12.5" r="6.5" fill="none" stroke="currentColor" strokeWidth={2} />
    <path d="M6.9 14.1a3.3 3.3 0 0 0 5.2 0" fill="none" stroke="currentColor" strokeWidth={1.7}
      strokeLinecap="round" />
    <path d="M7.5 10.4h.01M11.5 10.4h.01" fill="none" stroke="currentColor" strokeWidth={2.4}
      strokeLinecap="round" />
    <path d="M19 5.5v5M16.5 8h5" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" />
  </>
);

/**
 * Owner reactions on one message (protocol v2, Reactions): a quiet button in the message's own
 * control row, a six-emoji palette and the badge for the reaction the gateway has actually stored.
 *
 * The palette opens inline in that row instead of as a floating overlay, so it never depends on a
 * scroll position, is never clipped by the message list and never moves the page. The badge only
 * follows the durable `reaction` event: a tap shows nothing until the gateway confirms it (no
 * optimistic state), and tapping the emoji already shown clears the reaction.
 */
export function Reactions({ store, conn, thread, messageId }: {
  store: Store; conn: Connection; thread: ThreadId; messageId: string;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement | null>(null);
  const palette = useRef<HTMLSpanElement | null>(null);
  const current = store.reaction(thread, messageId);

  useEffect(() => {
    if (!open) return;
    // Focus the group, never an emoji: a ring on one emoji reads as a pre-selected reaction.
    // `preventScroll` keeps the page still, and the palette is then revealed inside the message
    // list itself, so a palette opened on the last message is never left under the composer.
    palette.current?.focus({ preventScroll: true });
    palette.current?.scrollIntoView({ block: "nearest" });
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
    <span className="reactions" ref={wrap}>
      {current != null && <span className="reaction-badge" role="img" aria-label={`Reacted ${current}`}>{current}</span>}
      <button type="button" className="reaction-trigger" aria-label="React to this message"
        aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <svg viewBox="0 0 24 24" aria-hidden="true">{REACT_ICON}</svg>
      </button>
      {open && (
        <span className="reaction-palette" role="group" aria-label="Reactions" tabIndex={-1} ref={palette}>
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
