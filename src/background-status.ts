/**
 * Concise, read-only background summary for the existing `/status` surfaces.
 *
 * The snapshot is metadata only: this conversation's own live workers and scheduled jobs, plus
 * whether one workspace-global memory-digestion run is live and whose it is. It starts nothing,
 * changes nothing, calls no model and holds no transcript, prompt, tool argument, host path or
 * credential. The host fills it from foundations it already owns; the renderer is fixed text so the
 * CLI and the Telegram owner see the same words.
 *
 * The agent remains the manager of this work. This is a report, not a dashboard, a queue view or a
 * recovery interface.
 */

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
 * (restart limit, or no definition can take it) so it is not executing even though it is unfinished.
 */
export type BackgroundTaskState = "pending" | "running" | "waiting" | "sleeping" | "completing" | "parked";

/** One live worker of this conversation; the task description is the spawning agent's own text. */
export interface BackgroundWorker {
  readonly taskId: number;
  readonly status: BackgroundTaskState;
  /**
   * Present only when `status` is `parked`: true when the block is a restart limit, the one reason a
   * native retry can clear. Every other blocked reason is reported without promising a retry.
   */
  readonly retryable?: boolean;
  readonly task: string;
  readonly workspace: "shared" | "worktree";
}

export interface BackgroundWorkers {
  /** Unfinished workers that are executing or queued, whether or not each is listed below. */
  readonly live: number;
  /** Unfinished workers Durable holds parked, so nothing will run without a native retry. */
  readonly parked: number;
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

export interface BackgroundStatus {
  readonly workers: BackgroundWorkers;
  readonly cron: BackgroundCron;
  readonly digest: BackgroundDigest;
}

/** An empty snapshot: nothing runs, nothing is scheduled, no digest is live. */
export function emptyBackgroundStatus(): BackgroundStatus {
  return {
    workers: { live: 0, parked: 0, items: [] },
    cron: { scheduled: 0, nextAtMs: null, running: { total: 0, items: [] }, pending: 0, parked: 0 },
    digest: { live: "none", parked: false },
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

function stateWord(status: BackgroundTaskState, retryable?: boolean): string {
  switch (status) {
    case "pending": return "queued";
    case "running": return "running";
    case "waiting": return "waiting for another task";
    case "sleeping": return "sleeping until due";
    case "completing": return "finishing";
    // Only a restart-limit block is cleared by a native retry; any other blocked reason is stated
    // as it is, without promising work that no retry can resume.
    case "parked": return retryable === true ? "parked, blocked until a native retry" : "parked, blocked";
  }
}

/**
 * Fixed lines appended to an existing `/status`. `undefined` means the host could not read the
 * snapshot, so nothing is added and no claim is made. An idle conversation prints one line.
 */
export function renderBackgroundStatus(status: BackgroundStatus | undefined): string[] {
  if (status === undefined) return [];
  const { workers, cron, digest } = status;
  const summary: string[] = [];
  if (workers.live > 0) summary.push(plural(workers.live, "live worker", "live workers"));
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
    ...workers.items.map((worker) => `  worker ${worker.taskId} (${stateWord(worker.status, worker.retryable)}): ${worker.task} — ` +
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
