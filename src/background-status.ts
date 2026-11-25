/**
 * Concise, read-only background summary for the existing `/status` surfaces.
 *
 * The snapshot is metadata only: this conversation's own live workers and scheduled jobs, whether one
 * workspace-global memory-digestion run is live and whose it is, and one gateway-wide count of live
 * work that a whole-gateway restart would interrupt. It starts nothing, changes nothing, calls no
 * model and holds no transcript, prompt, tool argument, host path or credential. The host fills it
 * from foundations it already owns; the renderer is fixed text so the CLI and the Telegram owner see
 * the same words.
 *
 * The agent remains the manager of this work. This is a report, not a dashboard, a queue view or a
 * recovery interface.
 */

import type { Context } from "@earendil-works/chord";
import type { ConversationId, Harness, TaskId } from "@earendil-works/pi-durable";
import type { CronJobView } from "./automation/cron.js";
import type { MemoryDigestStatus } from "./history/memory-digest.js";
import type { WorkerView } from "./workers/worker-task.js";

export const BACKGROUND_STATUS_LIMITS = Object.freeze({
  /** Rows of live workers and of executing cron runs rendered; every read is bounded separately. */
  rows: 4,
  /** Characters kept from one worker task description or cron job name. */
  nameChars: 80,
  /** Characters of the whole rendered block, so a channel notice keeps its own bound. */
  totalChars: 600,
});

/**
 * One native task state as the status may report it: `parked` means Durable holds the task blocked
 * because no installed definition can take it, so it is not executing even though it is unfinished.
 */
export type BackgroundTaskState = "pending" | "running" | "waiting" | "sleeping" | "completing" | "parked";

/** One live worker of this conversation; the task description is the spawning agent's own text. */
export interface BackgroundWorker {
  readonly taskId: number;
  readonly status: BackgroundTaskState;
  readonly task: string;
  readonly workspace: "shared" | "worktree";
}

export interface BackgroundWorkers {
  /** Unfinished workers that are executing or queued, whether or not each is listed below. */
  readonly live: number;
  /** Unfinished workers Durable holds parked, so nothing will run without a native retry. */
  readonly parked: number;
  /**
   * Live workers whose own turn is executing or finishing. Optional so an older host that did not
   * distinguish these states still renders; absent means "not classified", never zero.
   */
  readonly running?: number;
  /** Live workers natively waiting for another task, such as a child they started. */
  readonly waiting?: number;
  /** Live workers admitted but not started yet, including a native retry backoff. */
  readonly queued?: number;
  readonly items: readonly BackgroundWorker[];
}

/** One cron run that is executing right now. */
export interface BackgroundCronRun {
  readonly name: string;
  readonly status: BackgroundTaskState;
}

export interface BackgroundCron {
  /** Jobs with a future occurrence armed by their own timer. */
  readonly scheduled: number;
  /** Earliest armed occurrence, or null when nothing is scheduled. */
  readonly nextAtMs: number | null;
  readonly running: { readonly total: number; readonly items: readonly BackgroundCronRun[] };
  /** Runs admitted but not executing (queued, or waiting between phases). */
  readonly pending: number;
  /** Jobs whose native timer, run or target is parked or blocked; never reported as healthy. */
  readonly parked: number;
}

/** One workspace-global digestion run and whether it belongs to the conversation being read. */
export interface BackgroundDigest {
  readonly live: "none" | "own" | "shared";
  /** True when Durable holds that live run parked, so it is not executing. */
  readonly parked: boolean;
}

/**
 * Live work that decides whether a whole-gateway `/restart` would interrupt something. Counts only:
 * no task, conversation or transcript detail. It is gateway-wide, not this conversation's own work.
 * A sleeping native timer is an armed schedule, not active work: it is never counted here.
 */
export interface BackgroundActiveWork {
  /** Unfinished tasks executing, queued to execute, waiting for live work, or still finishing. */
  readonly interrupting: number;
}

export interface BackgroundStatus {
  readonly workers: BackgroundWorkers;
  readonly cron: BackgroundCron;
  readonly digest: BackgroundDigest;
  /** Gateway-wide active work; a whole-gateway restart is refused while it is non-zero. */
  readonly active: BackgroundActiveWork;
}

/** An empty snapshot: nothing runs, nothing is scheduled, no digest is live, nothing is active. */
export function emptyBackgroundStatus(): BackgroundStatus {
  return {
    workers: { live: 0, parked: 0, running: 0, waiting: 0, queued: 0, items: [] },
    cron: { scheduled: 0, nextAtMs: null, running: { total: 0, items: [] }, pending: 0, parked: 0 },
    digest: { live: "none", parked: false },
    active: { interrupting: 0 },
  };
}

/** Collapse one host-supplied description to a bounded single line for display. */
export function backgroundLabel(text: string): string {
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\s+/gu, " ").trim();
  return clean.length <= BACKGROUND_STATUS_LIMITS.nameChars
    ? clean
    : `${clean.slice(0, BACKGROUND_STATUS_LIMITS.nameChars)}…`;
}

const OMITTED_ROW = "  … further background detail omitted";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function stateWord(status: BackgroundTaskState): string {
  switch (status) {
    case "pending": return "queued";
    case "running": return "running";
    case "waiting": return "waiting for another task";
    case "sleeping": return "sleeping until due";
    case "completing": return "finishing";
    // Durable parks a task whose definition no installed version can take. No native retry can
    // resume it, so the wording promises none.
    case "parked": return "parked, blocked";
  }
}

/**
 * Fixed lines appended to an existing `/status`. `undefined` means the host could not read the
 * snapshot, so nothing is added and no claim is made. An idle conversation prints one line; a
 * blocked restart adds one fixed `Restart:` line with its count.
 */
export function renderBackgroundStatus(status: BackgroundStatus | undefined): string[] {
  if (status === undefined) return [];
  const { workers, cron, digest } = status;
  // An older host has no such field; then nothing is claimed about a restart.
  const interrupting = status.active?.interrupting ?? 0;
  const summary: string[] = [];
  if (workers.live > 0) {
    // Distinguish executing work from queued and natively waiting work in the one headline, so a
    // chat with a run waiting on background work does not read as if the model were generating.
    const states: string[] = [];
    if ((workers.running ?? 0) > 0) states.push(`${workers.running} running`);
    if ((workers.waiting ?? 0) > 0) states.push(`${workers.waiting} waiting`);
    if ((workers.queued ?? 0) > 0) states.push(`${workers.queued} queued`);
    summary.push(plural(workers.live, "live worker", "live workers") +
      (states.length === 0 ? "" : ` (${states.join(", ")})`));
  }
  if (workers.parked > 0) summary.push(plural(workers.parked, "parked worker", "parked workers"));
  if (cron.running.total > 0) summary.push(plural(cron.running.total, "cron run", "cron runs") + " executing");
  if (cron.pending > 0) summary.push(plural(cron.pending, "cron run", "cron runs") + " queued");
  if (cron.parked > 0) summary.push(plural(cron.parked, "parked cron job", "parked cron jobs"));
  if (digest.live === "own") summary.push(`digest ${digest.parked ? "run parked" : "running"} in this chat`);
  if (digest.live === "shared") {
    summary.push(`digest ${digest.parked ? "run parked" : "running"} for another chat ` +
      "(one run at a time; the workspace is shared)");
  }
  const headline = `Background: ${summary.length === 0 ? "idle" : summary.join(", ")}`;
  const workersTotal = workers.live + workers.parked;
  const due = isoTime(cron.nextAtMs);
  const rows = [
    // The operator-visible half of the `/restart` gate: fixed words and a count, no identifiers.
    ...(interrupting > 0
      ? [`Restart: blocked by ${plural(interrupting, "active task", "active tasks")} gateway-wide; ` +
        "finish or abort that work first"]
      : []),
    ...workers.items.map((worker) => `  worker ${worker.taskId} (${stateWord(worker.status)}): ${worker.task} — ` +
      (worker.workspace === "worktree" ? "isolated worktree" : "shared workspace")),
    ...(workersTotal > workers.items.length
      ? [`  … ${plural(workersTotal - workers.items.length, "unfinished worker", "unfinished workers")} not shown`]
      : []),
    ...cron.running.items.map((run) => `  cron "${run.name}" (${stateWord(run.status)})`),
    ...(cron.running.total > cron.running.items.length
      ? [`  … ${plural(cron.running.total - cron.running.items.length, "executing cron run", "executing cron runs")} not shown`]
      : []),
    ...(cron.scheduled > 0
      ? [`Cron: ${plural(cron.scheduled, "scheduled job", "scheduled jobs")}` +
        (due === undefined ? "" : `, next due ${due}`)]
      : []),
  ];
  const lines = [headline];
  let used = headline.length;
  for (const row of rows) {
    // Reserve the omission note up front, so a cut block still states that it was cut.
    if (used + row.length + 1 + OMITTED_ROW.length + 1 > BACKGROUND_STATUS_LIMITS.totalChars) {
      lines.push(OMITTED_ROW);
      break;
    }
    lines.push(row);
    used += row.length + 1;
  }
  return lines;
}

/** Absolute instant of one armed occurrence; a value the format cannot represent is omitted. */
function isoTime(ms: number | null): string | undefined {
  if (ms === null || !Number.isSafeInteger(ms) || Math.abs(ms) > 8.64e15) return undefined;
  return new Date(ms).toISOString();
}

/* ------------------------------------------------------------------------ */
/* Host readers                                                              */
/* ------------------------------------------------------------------------ */

/** A native task state that is executing work right now; pending, waiting and sleeping are not. */
function executingState(value: string | undefined): BackgroundTaskState | undefined {
  return value === "running" || value === "completing" ? value : undefined;
}

/** The one native read both readers use: live task records and their scheduler state. */
export interface BackgroundInspector {
  inspect(context: Context): Promise<{
    readonly tasks: readonly { readonly record: { readonly id: unknown }; readonly state: { readonly kind: string; readonly reason?: string } }[];
  }>;
}

/**
 * One read of the native task inspection. Sleeping is an armed timer and blocked is parked work,
 * so neither is work a replacement could interrupt; everything else is unfinished work it would
 * cut into. Nothing is written, aborted or retried here.
 */
export async function readActiveWork(harness: BackgroundInspector, context: Context): Promise<BackgroundActiveWork> {
  let interrupting = 0;
  for (const task of (await harness.inspect(context)).tasks) {
    if (task.state.kind === "sleeping" || task.state.kind === "blocked") continue;
    interrupting += 1;
  }
  return { interrupting };
}

/** What the status reader needs for one already-authorized mapped chat conversation. */
export interface BackgroundStatusSources {
  readonly harness: BackgroundInspector & Pick<Harness, "getTask">;
  readonly conversationId: ConversationId;
  /** Present only when workers are enabled and this conversation may spawn them. */
  readonly workers?: { list(): Promise<readonly WorkerView[]>; readonly taskKind: string };
  /** Present only when cron is enabled and this conversation is a cron owner. */
  readonly cron?: { list(): Promise<readonly CronJobView[]> };
  readonly digest: { status(): Promise<Pick<MemoryDigestStatus, "liveTaskId" | "liveConversationId">> };
}

/**
 * One bounded snapshot per read, never a claim of atomicity across the parts: each foundation is
 * read once, in order, and nothing is written. The caller decides authorization first: a root,
 * state, fork or task-owned conversation reads `emptyBackgroundStatus()` instead of calling this.
 */
export async function readBackgroundStatus(sources: BackgroundStatusSources, context: Context): Promise<BackgroundStatus> {
  const { harness, conversationId } = sources;
  // Restart is process-wide, so its count is read for the whole store, not for this chat alone.
  const active = await readActiveWork(harness, context);
  // A native task record keeps its last state when Durable parks it, so "unfinished" is not the
  // same as "will run": only the live-work inspection reports blocked tasks. It is read lazily,
  // once, and only when something unfinished actually needs classifying.
  let blockedTasks: Map<number, string> | undefined;
  const blockedNow = async (): Promise<Map<number, string>> => {
    if (blockedTasks !== undefined) return blockedTasks;
    const blocked = new Map<number, string>();
    for (const task of (await harness.inspect(context)).tasks) {
      // A blocked task has no installed definition that can run it, so it is reported parked.
      if (task.state.kind === "blocked") blocked.set(Number(task.record.id), task.state.reason ?? "");
    }
    blockedTasks = blocked;
    return blocked;
  };
  // Workers: this conversation's retained records, re-checked against the native task record so a
  // stale pointer or a record naming someone else's task is never reported as live work.
  const workerItems: BackgroundWorker[] = [];
  let liveWorkers = 0;
  let parkedWorkers = 0;
  let runningWorkers = 0;
  let waitingWorkers = 0;
  let queuedWorkers = 0;
  if (sources.workers !== undefined) {
    for (const view of await sources.workers.list()) {
      if (view.status !== "queued" && view.status !== "running") continue;
      const task = await harness.getTask(view.taskId as TaskId, context);
      if (task === undefined || task.kind !== sources.workers.taskKind || task.conversationId !== conversationId) continue;
      const state = task.state.status;
      if (state === "terminal") continue;
      const blockReason = (await blockedNow()).get(view.taskId);
      if (blockReason === undefined) {
        liveWorkers += 1;
        // Count only what the native state establishes: a waiting worker is not generating, and
        // a queued one has not started. A parked worker is reported separately below.
        if (state === "running" || state === "completing") runningWorkers += 1;
        else if (state === "waiting") waitingWorkers += 1;
        else if (state === "pending" || state === "sleeping") queuedWorkers += 1;
      } else parkedWorkers += 1;
      if (workerItems.length >= BACKGROUND_STATUS_LIMITS.rows) continue;
      workerItems.push({
        taskId: view.taskId,
        status: blockReason === undefined ? state : "parked",
        task: backgroundLabel(view.prompt),
        workspace: view.workspaceMode,
      });
    }
  }
  // Cron: this conversation's own jobs, read through the same derived view the cron tool uses, so
  // the native timer/run/target states decide what is executing, queued, parked or merely armed.
  const runningItems: BackgroundCronRun[] = [];
  let runningTotal = 0;
  let scheduled = 0;
  let nextAtMs: number | null = null;
  let pendingCron = 0;
  let parked = 0;
  if (sources.cron !== undefined) {
    for (const view of await sources.cron.list()) {
      // `parked` is a task no installed definition can take and `missing` is an absent record.
      // Either way the job cannot execute, so it is never folded into the healthy count.
      if (view.status === "parked" || view.status === "missing") parked += 1;
      if (view.nextAtMs !== null) {
        scheduled += 1;
        nextAtMs = nextAtMs === null ? view.nextAtMs : Math.min(nextAtMs, view.nextAtMs);
      }
      const execution = view.execution?.status;
      const executing = executingState(execution) ?? executingState(view.target?.status);
      if (executing !== undefined) {
        runningTotal += 1;
        if (runningItems.length < BACKGROUND_STATUS_LIMITS.rows) {
          runningItems.push({ name: backgroundLabel(view.job.name), status: executing });
        }
        continue;
      }
      if (execution === "pending" || execution === "waiting" || execution === "sleeping") pendingCron += 1;
    }
  }
  // One workspace-global digest run at a time: its origin decides whether this chat owns it.
  const digestStatus = await sources.digest.status();
  const digestLive: BackgroundDigest["live"] = digestStatus.liveTaskId === null
    ? "none"
    : digestStatus.liveConversationId === conversationId ? "own" : "shared";
  const digestParked = digestStatus.liveTaskId !== null && (await blockedNow()).has(digestStatus.liveTaskId);
  return {
    workers: {
      live: liveWorkers,
      parked: parkedWorkers,
      running: runningWorkers,
      waiting: waitingWorkers,
      queued: queuedWorkers,
      items: workerItems,
    },
    cron: {
      scheduled,
      nextAtMs,
      running: { total: runningTotal, items: runningItems },
      pending: pendingCron,
      parked,
    },
    digest: { live: digestLive, parked: digestParked },
    active,
  };
}
