/**
 * Full-process replacement for the gateway's `/restart` control.
 *
 * A restart must load new code and a re-read configuration, so closing and reopening the Harness
 * inside the same Node process is not a restart. POSIX `execve` through Node's experimental
 * `process.execve` (absent on Windows and IBM i) replaces this process image and keeps the
 * foreground stdio descriptors. That is the only mechanism used: no shell respawn, supervisor,
 * service manager or replacement loop. Everything else (open handles, timers, the store lock) is
 * discarded by the system, so the gateway must finish its own graceful teardown first.
 */

export type RestartPlan = {
  /** This process's own Node executable. */
  readonly file: string;
  /** This process's own argv, unchanged: the same script, subcommand and `--config <path>`. */
  readonly args: readonly string[];
  /** This process's current environment. Nothing is re-read from disk or discovered. */
  readonly env: NodeJS.ProcessEnv;
};

/** Fixed diagnostic for a restart that could not replace the process; carries no path, argv or env. */
export const RESTART_FAILURE_DIAGNOSTIC =
  "durable-nanobot: process restart failed; this gateway has stopped and must be started again " +
  "(diagnostic details suppressed)";

/** Whether this platform and Node runtime can replace the current process image. */
export function restartSupported(): boolean {
  return typeof process.execve === "function";
}

/**
 * The plan for this exact process: the same executable, the same argv and the current environment.
 * No program, argument or credential source comes from configuration, a model or a chat message.
 */
export function restartPlan(): RestartPlan {
  return {
    file: process.execPath,
    args: [...process.argv],
    env: { ...process.env },
  };
}

/**
 * Replace this process with the same program and configuration. A successful call never returns;
 * a platform refusal or a rejected plan throws so the caller reports a stopped state instead of
 * pretending the restart happened.
 */
export function replaceProcess(plan: RestartPlan): never {
  const execve = process.execve;
  if (execve === undefined) throw new Error("process.execve is unavailable on this platform");
  return execve(plan.file, plan.args, plan.env);
}
