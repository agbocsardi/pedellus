import { MAIN_THREAD, type ThreadInfo } from "./protocol";
import type { Store } from "./store";
import { openThreads } from "./ThreadList";

/** The row stays one short line on a 320px phone; the thread sheet lists the rest. */
const MAX_BUBBLES = 5;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * A badgeless thread's face is the first user-perceived character of its title (an emoji stays
 * whole) and its caption the title, without that character when it is not a letter or digit.
 */
function badgeless(title: string) {
  const text = title.trim();
  for (const { segment } of graphemes.segment(text)) {
    const rest = text.slice(segment.length).trim();
    return { face: segment, caption: /^[\p{L}\p{N}]/u.test(segment) || !rest ? text : rest };
  }
  return { face: "?", caption: title };
}

function Bubble({ store, thread }: { store: Store; thread: ThreadInfo }) {
  const main = thread.id === MAIN_THREAD;
  const title = main ? "Main" : thread.title;
  const state = store.status(thread.id).state;
  // Same reading as ThreadSignals: anything but idle is running, except an error.
  const signal = state === "idle" ? undefined : state === "error" ? "Error" : "Running";
  const unread = store.isUnread(thread.id);
  const shown = main ? { face: "🏠", caption: "Main" }
    : thread.badge ? { face: thread.badge.emoji, caption: thread.badge.verb } : badgeless(thread.title);
  return (
    <button className="thread-bubble" data-signal={signal?.toLowerCase()}
      aria-label={[title, unread && "Unread", signal].filter(Boolean).join(", ")}
      onClick={() => store.selectThread(thread.id)}>
      <span className="thread-bubble-face" aria-hidden="true">
        {shown.face}
        {unread && <span className="thread-bubble-dot" />}
      </span>
      <span className="thread-bubble-caption" aria-hidden="true">{shown.caption}</span>
    </button>
  );
}

/**
 * Phone-only quick switch above the composer: Main, then the open side threads by newest activity,
 * without the one on screen. The thread sheet stays the full list (search, archive, new thread).
 */
export function ThreadBubbles({ store }: { store: Store }) {
  // Only confirmed, writable threads: an unconfirmed or placeholder record would open read-only.
  const threads = openThreads(store).filter((t) => t.id !== store.openThread && store.canWrite(t.id)).slice(0, MAX_BUBBLES);
  if (!threads.length) return null;
  return (
    <nav className="thread-bubbles" aria-label="Recent threads">
      {threads.map((t) => <Bubble key={t.id} store={store} thread={t} />)}
    </nav>
  );
}
