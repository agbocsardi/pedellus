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

import type { Context } from "@earendil-works/chord";
import type { BackgroundActiveWork } from "./background-status.js";

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
 * Fixed refusal when a restart would interrupt live work. It names no task, chat, conversation or
 * transcript. A command receipt may already have been sent, but no teardown or restart occurred.
 */
export const RESTART_BUSY_MESSAGE =
  "Gateway restart refused: live work would be interrupted, so nothing was restarted and the gateway " +
  "keeps serving. Wait for that work to finish (it is counted in /status), or cancel it through its " +
  "existing controls where available, then retry /restart.";

/** A known no-effect host refusal: live work is active, so no teardown started. */
export class RestartBusyError extends Error {
  override name = "RestartBusyError";
  constructor() {
    super(RESTART_BUSY_MESSAGE);
  }
}

export interface RestartCoordinator {
  /**
   * Ask for this gateway's process replacement. A busy refusal happens before the acknowledgement and
   * before any teardown, so a refused request never claims a restart; a call after an accepted
   * request is refused too, and never acknowledges or tears down again.
   */
  request(acknowledge?: () => Promise<void>): Promise<void>;
  /** True once a restart was accepted: the host replaces the process after its own teardown returns. */
  accepted(): boolean;
}

/**
 * The one host-side gate behind every owner `/restart` surface (the local CLI and Telegram).
 *
 * The inspection and the teardown are separate operations: a task admitted after the check but
 * before the acknowledgement/teardown is not protected by it. No drain, lock, scheduling pause or
 * confirmation step is added here; the window is the acknowledgement round trip, and the alternative
 * facilities for closing it do not exist in Durable today.
 */
export function createRestartCoordinator(options: {
  readonly activeWork: (context: Context) => Promise<BackgroundActiveWork>;
  /** Host owner context for the read-only inspection. */
  readonly context: Context;
  /** Stop this gateway's own surfaces; only called after an accepted, acknowledged request. */
  readonly teardown: () => void;
}): RestartCoordinator {
  let requested = false;
  let checking = false;
  return {
    accepted: () => requested,
    async request(acknowledge) {
      if (requested || checking) throw new Error("gateway restart is already in progress");
      checking = true;
      try {
        if ((await options.activeWork(options.context)).interrupting > 0) throw new RestartBusyError();
        requested = true;
      } finally { checking = false; }
      try { await acknowledge?.(); }
      finally { options.teardown(); }
    },
  };
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
