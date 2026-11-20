import { useEffect, useRef, useState } from "react";
import type { Connection } from "./conn";
import type { Store } from "./store";
import { LIMITS, type TaskInfo } from "./protocol";

type TaskState = TaskInfo["state"];
type Outcome = "cancelled" | "finished" | "unknown";

const STATE_LABEL: Record<TaskState, string> = {
  running: "Running",
  queued: "Queued",
  scheduled: "Scheduled",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Work the gateway can still cancel; a terminal row keeps its result only. */
const ACTIVE = new Set<TaskState>(["running", "queued", "scheduled"]);

const WORKER_ICON = "M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-5 5 5 5 0 0 1-5-5V7M12 16v5";
const CRON_ICON = "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0";

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1_000],
];

/** "in 5 minutes" / "2 hours ago"; a date instead of "in 3 months" for far-away times. */
function relative(iso: string | undefined): string {
  if (iso === undefined) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const delta = at - Date.now();
  if (Math.abs(delta) >= 7 * 86_400_000) return new Date(at).toLocaleDateString();
  for (const [unit, ms] of UNITS) {
    if (Math.abs(delta) >= ms || unit === "second") return RELATIVE.format(Math.round(delta / ms), unit);
  }
  return "";
}

function when(task: TaskInfo): string {
  const next = relative(task.nextAt);
  if (next) return `Next ${next}`;
  const last = relative(task.lastAt);
  if (last) return `Last ${last}`;
  // A live worker has neither yet; its start time is still the useful relative fact.
  const started = relative(task.createdAt);
  return started ? `Started ${started}` : "";
}

function bounded(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value !== "" ? [...value].slice(0, max).join("") : undefined;
}

const iso = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined;

/** Only well-formed rows from the gateway reach the sheet; anything else is dropped unfocused. */
function parseTasks(raw: unknown): TaskInfo[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.flatMap((value): TaskInfo[] => {
    if (!value || typeof value !== "object") return [];
    const task = value as Record<string, unknown>;
    const title = bounded(task.title, LIMITS.taskTitleChars);
    const detail = bounded(task.detail, LIMITS.taskDetailChars);
    const createdAt = iso(task.createdAt);
    if (typeof task.id !== "string" || task.id === "" || task.id.length > 96) return [];
    if (task.kind !== "worker" && task.kind !== "cron") return [];
    if (typeof task.state !== "string" || !(task.state in STATE_LABEL)) return [];
    if (title === undefined || createdAt === undefined) return [];
    const nextAt = iso(task.nextAt);
    const lastAt = iso(task.lastAt);
    return [{
      id: task.id, kind: task.kind, title, state: task.state as TaskState, createdAt,
      ...(nextAt === undefined ? {} : { nextAt }),
      ...(lastAt === undefined ? {} : { lastAt }),
      ...(detail === undefined ? {} : { detail }),
    }];
  }).slice(0, LIMITS.maxListedTasks);
}

/** What the owner is told after one cancellation: the outcome, as it came back. */
function receipt(outcome: Outcome): string {
  switch (outcome) {
    case "cancelled": return "Cancelled.";
    case "finished": return "It had already finished; nothing was cancelled.";
    case "unknown": return "No such task in this thread; nothing was changed.";
  }
}

/**
 * The Tasks sheet: this thread's own workers and scheduled jobs (protocol v2, Tasks).
 *
 * There is no task event stream, so the list is fetched when the sheet opens and again after any
 * durable event in this thread while it stays open (the store's newest cursor is the trigger).
 * Cancelling asks here first, one task at a time; the row shows "Cancelling…" until the gateway
 * answers and then reports exactly what came back.
 */
export function TasksSheet({ store, conn, thread, online, archived }: {
  store: Store; conn: Connection; thread: string; online: boolean; archived: boolean;
}) {
  const [tasks, setTasks] = useState<TaskInfo[] | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<string | undefined>(undefined);
  const [refresh, setRefresh] = useState(0);
  const sequence = useRef(0);
  // Any durable event in this thread (a reply, a notice, a divider) refreshes the view.
  const newest = store.events.get(thread)?.at(-1)?.cursor ?? 0;

  useEffect(() => {
    const run = ++sequence.current;
    void (async () => {
      const res = await conn.tasks(thread);
      if (run !== sequence.current) return;
      if (!res) {
        setError("Reconnect to load this thread's tasks.");
        return;
      }
      if (!res.ok) {
        setError(res.error === "unsupported"
          ? "This gateway does not offer the Tasks view."
          : "Could not load this thread's tasks.");
        return;
      }
      const listed = parseTasks(res.tasks);
      if (listed === undefined) {
        setError("The gateway sent an unreadable task list.");
        return;
      }
      setTasks(listed);
      setError("");
    })();
  }, [conn, thread, newest, online, refresh]);

  async function cancel(task: TaskInfo) {
    if (pending !== undefined) return;
    setPending(task.id);
    setConfirming(undefined);
    setNote("");
    try {
      const res = await conn.cancelTask(thread, task.id);
      if (!res) setNote("No reply from the gateway. Check the connection, then refresh.");
      else if (!res.ok) setNote(res.error === "unsupported"
        ? "This gateway does not support cancelling tasks."
        : "The gateway refused the cancellation. Nothing was changed.");
      else if (res.outcome === "cancelled" || res.outcome === "finished" || res.outcome === "unknown") {
        setNote(receipt(res.outcome));
      } else setNote("The gateway did not report an outcome. Refresh to see the task's state.");
    } finally {
      setPending(undefined);
      setRefresh((value) => value + 1);
    }
  }

  if (error) return <p className="sheet-help" role="alert">{error}</p>;
  if (tasks === null) return <p className="sheet-help" role="status">Loading tasks…</p>;
  if (tasks.length === 0) {
    return <>
      <p className="sheet-help">No background tasks in this thread.</p>
      {note && <p className="sheet-help" role="status">{note}</p>}
    </>;
  }
  return <>
    <h2 className="sheet-heading">Tasks</h2>
    <div className="task-list">
      {tasks.map((task) => {
        const active = ACTIVE.has(task.state);
        const time = when(task);
        const busy = pending === task.id;
        return (
          <div key={task.id} className="task-row" data-state={task.state}>
            <span className="task-kind" data-kind={task.kind} aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d={task.kind === "worker" ? WORKER_ICON : CRON_ICON} fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div className="task-text">
              <b>{task.title}</b>
              <small className="task-meta">
                <span className="task-state" data-state={task.state}>{STATE_LABEL[task.state]}</span>
                {time && <span>{time}</span>}
              </small>
              {task.detail && <small className="task-detail">{task.detail}</small>}
            </div>
            {active && (archived
              ? <span className="task-note">Restore to cancel</span>
              : busy
                ? <span className="task-note" role="status">Cancelling…</span>
                : confirming === task.id
                  ? <span className="task-confirm">
                    <button className="task-keep" onClick={() => setConfirming(undefined)}>Keep</button>
                    <button className="task-do" onClick={() => void cancel(task)}>Cancel task</button>
                  </span>
                  : <button className="task-cancel" disabled={!online || pending !== undefined}
                    aria-label={`Cancel ${task.title}`}
                    onClick={() => { setNote(""); setConfirming(task.id); }}>
                    Cancel
                  </button>)}
            {busy && confirming !== task.id && <span className="task-note" role="status">Cancelling…</span>}
          </div>
        );
      })}
    </div>
    {note && <p className="sheet-help" role="status">{note}</p>}
  </>;
}
