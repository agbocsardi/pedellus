import { useEffect, useState } from "react";
import type { Connection } from "./conn";
import type { QuestionEvent } from "./protocol";
import type { Store } from "./store";

/**
 * One owner question as a card in the thread. The gateway's durable `question` event is the only
 * state: a tap sends `answer` and the card stays disabled until the `answered` event arrives, so it
 * never claims an answer optimistically. Non-open cards are read-only with their final state.
 */
export function QuestionCard({ ev, store, conn }: { ev: QuestionEvent; store: Store; conn: Connection }) {
  const [sending, setSending] = useState(false);
  // The expiry line is minute-grained; one tick per half minute keeps it honest without a timer
  // per second. Only open cards show it.
  const [, tick] = useState(0);
  useEffect(() => {
    if (ev.state !== "open") return;
    const timer = setInterval(() => tick((value) => value + 1), 30_000);
    return () => clearInterval(timer);
  }, [ev.state]);

  const writable = store.connState === "open" && store.canWrite(ev.thread);
  const chosen = ev.answer === undefined ? undefined : ev.options.find((option) => option.id === ev.answer);
  const final = ev.state === "answered"
    ? <>✓ Answered{chosen === undefined ? "" : <>: <b>{chosen.label}</b></>}</>
    : ev.state === "expired" ? "Expired"
      : ev.state === "cancelled" ? "Cancelled"
        : ev.state === "unknown" ? "Delivery unknown"
          : undefined;

  const answer = (option: string) => {
    if (sending) return;
    setSending(true);
    void conn.answer(ev.thread, ev.id, option as QuestionEvent["options"][number]["id"]).then((accepted) => {
      // Accepted taps wait for the durable `answered` event; a refusal (already answered, expired,
      // cancelled, foreign) releases the card so the gateway's notice and the real state show.
      if (!accepted) setSending(false);
    }, () => setSending(false));
  };

  return (
    <div className="question msg" data-state={ev.state}>
      <div className="question-head">
        <span className="question-kicker">Question</span>
        {ev.state === "open" && <span className="question-clock">{expiryLabel(ev.expiresAt)}</span>}
      </div>
      <p className="question-prompt" id={`q-${ev.id}`}>{ev.prompt}</p>
      {ev.state === "open" ? (
        <>
          <div className="question-options" role="group" aria-labelledby={`q-${ev.id}`}>
            {ev.options.map((option) => (
              <button key={option.id} className="question-option" disabled={sending || !writable}
                onClick={() => answer(option.id)}>
                <span className="question-label">{option.label}</span>
                {option.description !== undefined && <span className="question-description">{option.description}</span>}
              </button>
            ))}
          </div>
          {sending ? <p className="question-status" role="status">Sending answer…</p>
            : !writable && <p className="question-status">Reconnect to answer.</p>}
        </>
      ) : (
        <p className="question-final" data-state={ev.state}>{final}</p>
      )}
    </div>
  );
}

/** A whole-minute countdown for the card's answer window; the gateway enforces the real deadline. */
function expiryLabel(expiresAt: string): string {
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return "";
  const left = at - Date.now();
  if (left <= 0) return "Expired";
  const minutes = Math.ceil(left / 60_000);
  return minutes <= 1 ? "expires in under a minute" : `expires in ${minutes} min`;
}
