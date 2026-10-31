/**
 * Bounds of the background-worker slice. They are deliberately small: a worker is an ordinary model
 * run that owns a conversation, so unbounded spawning would be both spend and concurrency without a
 * queue, retry or scheduling framework behind it.
 */
export const WORKER_LIMITS = Object.freeze({
  /** Live workers per spawning conversation when config omits `maxConcurrent`. */
  defaultConcurrent: 2,
  /** Config ceiling for `workers.maxConcurrent`. */
  maxConcurrent: 4,
  /** Task prompt characters accepted at launch; a longer request is refused, not truncated. */
  maxPromptChars: 8_000,
  /** Characters of the committed answer kept in the worker record and the internal result event. */
  maxResultChars: 4_000,
  /** Characters of a failure or cancellation reason kept in the record and the event. */
  maxErrorChars: 500,
  /** Worker records retained per spawning conversation, oldest notified terminal first. */
  retainedRecords: 32,
  /** Characters of the spawning agent's task prompt echoed in the internal result event. */
  maxEchoPromptChars: 400,
  /** Transcript entries read and shown per page when `transcript` omits `limit`. */
  transcriptDefaultLimit: 20,
  /** Hard per-call transcript entry cap; a page is one native descending entry scan. */
  transcriptMaxLimit: 20,
  /** Characters retained from one transcript tool-call argument list before quoting. */
  transcriptToolArgumentChars: 800,
  /** Characters retained from one transcript entry body before quoting. */
  transcriptEntryChars: 1_200,
  /** Overall rendered transcript byte budget, below the tool's 64 KiB output limiter. */
  transcriptOutputBytes: 48 * 1024,
  /** Bytes reserved in the transcript render for the omission note. */
  transcriptOmissionReserveBytes: 256,
  /** Bytes reserved for the transcript's displayed/omitted row count line. */
  transcriptRowCountReserveBytes: 512,
  /** Characters of the worker task echoed in the transcript header. */
  transcriptTaskChars: 400,
  /** Host command timeout for one git worktree operation. */
  gitTimeoutMs: 30_000,
  /** Bytes of git stderr kept in a failure message. */
  maxGitErrorChars: 400,
});

/** Workspace chosen by the spawning agent for one worker task. Never defaulted silently. */
export const WORKER_WORKSPACE_MODES = ["shared", "worktree"] as const;

export type WorkerWorkspaceMode = (typeof WORKER_WORKSPACE_MODES)[number];
