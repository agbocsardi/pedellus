/**
 * The app channel's Tasks view: one app thread's own background work, mapped to the protocol's
 * bounded `TaskInfo` (APP.md, "Tasks").
 *
 * The view is display-only and derives from exactly the records the model-facing tools read:
 * `worker list` and `cron list` scoped to the thread's mapped conversation. Nothing here reads a
 * transcript, calls a model, changes a record or widens authority. A title is a bounded one-line
 * label, a detail is a bounded line of derived status; no prompt body, worker output, credential or
 * host path is copied into the view.
 */
import { LIMITS, type TaskInfo } from "./generated/protocol-v2.js";
import { cronScheduleText } from "../automation/cron-schedule.js";
import type { CronJobStatus, CronJobView } from "../automation/cron.js";
import type { WorkerStatus, WorkerView } from "../workers/worker-task.js";
import { clampCodeUnits, plainLabel } from "../history/entry-view.js";

/** Task ids are namespaced so one `task` string is unambiguous across the two sources. */
export const WORKER_TASK_PREFIX = "w:";
export const CRON_TASK_PREFIX = "c:";

export type AppTaskOutcome = "cancelled" | "finished" | "unknown";
export type AppTaskList = { readonly tasks: readonly TaskInfo[] };
/** The outcome and the bounded label the receipt names, when the task was found. */
export type AppTaskCancelResult = { readonly outcome: AppTaskOutcome; readonly title?: string };

export const workerTaskId = (taskId: number): string => `${WORKER_TASK_PREFIX}${taskId}`;
export const cronTaskId = (jobId: string): string => `${CRON_TASK_PREFIX}${jobId}`;

/** A one-line field: controls stripped, whitespace collapsed, cut at `max` with an ellipsis. */
function boundedLine(value: string, max: number): string {
  const clean = plainLabel(value);
  if (clean.length <= max) return clean;
  return `${clampCodeUnits(clean, max - 1)}…`;
}

function iso(ms: number | null | undefined): string | undefined {
  return ms === null || ms === undefined ? undefined : new Date(ms).toISOString();
}

const WORKER_STATES: Readonly<Record<WorkerStatus, TaskInfo["state"]>> = {
  queued: "queued",
  running: "running",
  completed: "done",
  // An interrupted task (`orphaned`), a faulted one or an absent native record did not succeed, and
  // the protocol has no separate state for them.
  failed: "failed",
  aborted: "cancelled",
  orphaned: "failed",
  faulted: "failed",
  missing: "failed",
};

const CRON_STATES: Readonly<Record<CronJobStatus, TaskInfo["state"]>> = {
  pending: "queued",
  queued: "queued",
  running: "running",
  waiting: "queued",
  sleeping: "queued",
  completing: "running",
  scheduled: "scheduled",
  completed: "done",
  stopped: "done",
  aborted: "cancelled",
  cancelled: "cancelled",
  failed: "failed",
  faulted: "failed",
  orphaned: "failed",
  parked: "failed",
  missing: "failed",
};

/** One retained worker as the Tasks view shows it. */
export function workerTask(view: WorkerView): TaskInfo {
  const mode = view.workspaceMode === "worktree" ? "isolated worktree" : "shared workspace";
  const tail = view.status === "completed"
    ? "finished"
    : view.status === "aborted"
      ? "cancelled"
      : view.status === "orphaned"
        ? "interrupted by a restart"
        : view.status === "failed" || view.status === "faulted" || view.status === "missing"
          ? "failed"
          : undefined;
  const lastAt = iso(view.finishedAtMs);
  return {
    id: workerTaskId(view.taskId),
    kind: "worker",
    title: boundedLine(view.prompt.trim() === "" ? "background worker" : view.prompt, LIMITS.taskTitleChars),
    state: WORKER_STATES[view.status],
    createdAt: new Date(view.createdAtMs).toISOString(),
    ...(lastAt === undefined ? {} : { lastAt }),
    detail: boundedLine(tail === undefined ? mode : `${mode} · ${tail}`, LIMITS.taskDetailChars),
  };
}

/** One scheduled job as the Tasks view shows it. */
export function cronTask(view: CronJobView): TaskInfo {
  const job = view.job;
  const schedule = cronScheduleText(job.schedule);
  const notes: string[] = [];
  if (job.lastOutcome !== null) notes.push(`last run ${job.lastOutcome.status}`);
  if (job.lastSkip !== null) notes.push("last run skipped");
  if (job.lastFault !== null) notes.push("a failure is recorded");
  if (view.deliveryFault !== null) notes.push("delivery is failing");
  const times = [job.lastOutcome?.finishedAtMs, job.lastSkip?.skippedAtMs, job.lastFault?.recordedAtMs]
    .filter((value): value is number => typeof value === "number");
  const lastAt = iso(times.length === 0 ? undefined : Math.max(...times));
  const nextAt = iso(view.nextAtMs);
  return {
    id: cronTaskId(job.id),
    kind: "cron",
    title: boundedLine(job.name.trim() === "" ? schedule : job.name, LIMITS.taskTitleChars),
    state: CRON_STATES[view.status],
    createdAt: new Date(job.createdAtMs).toISOString(),
    ...(nextAt === undefined ? {} : { nextAt }),
    ...(lastAt === undefined ? {} : { lastAt }),
    detail: boundedLine([schedule, ...notes].join(" · "), LIMITS.taskDetailChars),
  };
}

/**
 * The whole view: this thread's workers and jobs, newest first, at most `LIMITS.maxListedTasks`.
 * Ties keep a stable order so a repeated read of unchanged records lists the same rows.
 */
export function selectTasks(workers: readonly WorkerView[], jobs: readonly CronJobView[]): TaskInfo[] {
  const entries = [
    ...workers.map((view) => ({ createdAtMs: view.createdAtMs, task: workerTask(view) })),
    ...jobs.map((view) => ({ createdAtMs: view.job.createdAtMs, task: cronTask(view) })),
  ];
  entries.sort((left, right) => right.createdAtMs - left.createdAtMs);
  return entries.slice(0, LIMITS.maxListedTasks).map((entry) => entry.task);
}

/** The durable receipt text for one cancellation; always says what actually happened. */
export function taskCancelReceipt(result: AppTaskCancelResult): string {
  const what = result.title === undefined ? "the task" : `task “${result.title}”`;
  switch (result.outcome) {
    case "cancelled":
      return `Cancelled ${what}.`;
    case "finished":
      return `Task${result.title === undefined ? "" : ` “${result.title}”`} had already finished; nothing was cancelled.`;
    case "unknown":
      return "No such task in this thread; nothing was changed.";
  }
}
