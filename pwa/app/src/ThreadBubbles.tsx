import { MAIN_THREAD, type ThreadInfo } from "./protocol";
import type { Store } from "./store";
import { openThreads } from "./ThreadList";

/** The row stays one short line on a 320px phone; the thread sheet lists the rest. */
const MAX_BUBBLES = 5;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A badgeless thread's face: the first user-perceived character of its title (an emoji stays whole). */
function initial(title: string) {
  for (const { segment } of graphemes.segment(title.trim())) return segment;
  return "?";
}

function Bubble({ store, thread }: { store: Store; thread: ThreadInfo }) {
  const main = thread.id === MAIN_THREAD;
  const title = main ? "Main" : thread.title;
  const state = store.status(thread.id).state;
  // Same reading as ThreadSignals: anything but idle is running, except an error.
  const signal = state === "idle" ? undefined : state === "error" ? "Error" : "Running";
  const unread = store.isUnread(thread.id);
  return (
    <button className="bubble" data-signal={signal?.toLowerCase()}
      aria-label={[title, unread && "Unread", signal].filter(Boolean).join(", ")}
      onClick={() => store.selectThread(thread.id)}>
      <span className="bubble-face" aria-hidden="true">
        {main ? "🏠" : thread.badge?.emoji ?? initial(thread.title)}
        {unread && <span className="bubble-dot" />}
      </span>
      <span className="bubble-caption" aria-hidden="true">{main ? "Main" : thread.badge?.verb ?? thread.title}</span>
    </button>
  );
}

/**
 * Phone-only quick switch above the composer: Main, then the open side threads by newest activity,
 * without the one on screen. The thread sheet stays the full list (search, archive, new thread).
 */
export function ThreadBubbles({ store }: { store: Store }) {
  const threads = openThreads(store).filter((t) => t.id !== store.openThread).slice(0, MAX_BUBBLES);
  if (!threads.length) return null;
  return (
    <nav className="bubbles" aria-label="Recent threads">
      {threads.map((t) => <Bubble key={t.id} store={store} thread={t} />)}
    </nav>
  );
}
