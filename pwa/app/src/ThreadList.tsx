import { useEffect, useState } from "react";
import type { Connection } from "./conn";
import { LIMITS, MAIN_THREAD, type ThreadInfo } from "./protocol";
import type { Store } from "./store";
import { PLUS_ICON, SheetItem } from "./ui";

/** A search that the gateway's `threads {query}` would only echo back as unreadable. */
const QUERY_CONTROL = /[\p{Cc}\u2028\u2029]/u;

export function archivedLabel(t: ThreadInfo | undefined) {
  return t?.archivedReason ? `Archived · ${t.archivedReason}` : "Archived";
}

/** Main first, then open side threads, newest activity first: the sidebar order
 * and the order Alt+↑/↓ steps through. */
export function openThreads(store: Store): ThreadInfo[] {
  const main = store.threads.get(MAIN_THREAD);
  const side = [...store.threads.values()].filter((t) => t.id !== MAIN_THREAD && !t.archived)
    .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
  return main ? [main, ...side] : side;
}

export function ThreadSignals({ store, thread }: { store: Store; thread: string }) {
  const state = store.status(thread).state;
  return <>
    {state !== "idle" && <small className="thread-running">{state === "error" ? "Error" : "Running"}</small>}
    {store.isUnread(thread) && <span className="thread-dot" role="img" aria-label="Unread" />}
  </>;
}

export function ThreadList({ store, conn, online, onNew, onSelect }: {
  store: Store; conn: Connection; online: boolean; onNew: () => void; onSelect: (thread: string) => void;
}) {
  const [input, setInput] = useState("");
  const query = input.trim() ? input : "";
  const [remote, setRemote] = useState<{ query: string; ids: ReadonlySet<string> }>();
  useEffect(() => {
    if (!query || !online || QUERY_CONTROL.test(query)) return;
    let current = true;
    const timer = setTimeout(() => conn.searchThreads(query, (ids) => {
      if (current) setRemote({ query, ids });
    }), 250);
    return () => { current = false; clearTimeout(timer); };
  }, [conn, online, query]);

  const side = [...store.threads.values()].filter((t) => t.id !== MAIN_THREAD)
    .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
  const open = openThreads(store);
  const archived = side.filter((t) => t.archived);
  const results = query ? store.searchThreads(query, remote?.query === query ? remote.ids : undefined) : [];
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
    <div className="thread-list-body">
      {query ? (
        results.length ? results.map(({ thread, snippet }) => row(thread, snippet)) : <p className="sheet-help">No matching threads.</p>
      ) : <>
        <SheetItem icon={PLUS_ICON} title="New thread" sub="Start an empty conversation" onClick={onNew} />
        {[...store.creates.values()].map((c) => <p className="sheet-help" key={c.key}>
          {c.title || "New thread"} · {c.failed ? "Could not create" : "Waits for connection"}
        </p>)}
        {open.map((t) => row(t))}
        {archived.length > 0 && <details className="thread-archive">
          <summary>Archived ({archived.length}){archived.some((t) => store.isUnread(t.id)) &&
            <span className="thread-dot" role="img" aria-label="Unread" />}</summary>
          {archived.map((t) => row(t))}
        </details>}
      </>}
    </div>
  </>;
}
