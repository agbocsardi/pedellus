/**
 * Host-owned workspace selection for one worker task.
 *
 * `shared` is the configured workspace itself, used in place: concurrent writers see each other's
 * changes. `worktree` is a fresh `git worktree` checkout of the configured repository at its current
 * commit, so a serious coding task gets an isolated tree without copying or locking the owner's
 * working state.
 *
 * This module runs the platform `git` executable as an argv array, never a shell string, with a
 * bounded timeout. It only ever derives a branch and a directory from the Durable task ID; a model
 * cannot name a host path. It does not merge, rebase, stash, commit, clean or remove anything: the
 * worktree and its branch are the task's workspace and provenance, and cancellation leaves both.
 *
 * The repository must be the configured workspace root itself (the full repository scope), because a
 * `git worktree` of a subdirectory would check out sibling paths the configured workspace never
 * authorized. A dirty tracked tree is refused rather than stashed or committed: the worktree would
 * otherwise silently run a different revision than the owner sees.
 */
import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { WORKER_LIMITS, type WorkerWorkspaceMode } from "./limits.js";

export interface WorkerWorkspaceInfo {
  readonly mode: WorkerWorkspaceMode;
  /** Canonical directory this task's tools and shell operate in. */
  readonly path: string;
  /** Task branch, worktree mode only. */
  readonly branch?: string;
  /** Commit the checkout started from, worktree mode only. */
  readonly baseCommit?: string;
}

export interface WorkerWorkspaceOptions {
  /** Canonical configured workspace root; must be the repository root for worktree mode. */
  readonly repositoryRoot: string;
  /** Host directory holding worker checkouts; derived, never model-supplied. */
  readonly worktreesRoot: string;
  /** Git executable name or absolute path. */
  readonly gitPath?: string;
}

export interface WorkerWorkspace {
  /**
   * Why worktree mode cannot start here, or `undefined` when it can. Read-only; used to fail a request
   * immediately instead of admitting a task that cannot run.
   */
  precheck(): Promise<string | undefined>;
  /** Choose and prepare this task's workspace. Idempotent for a pristine retry, never replacing state. */
  open(taskId: number, mode: WorkerWorkspaceMode): Promise<WorkerWorkspaceInfo>;
  /**
   * Verify a persisted workspace still belongs to this task, without creating or replacing anything.
   * Returns a failure description, or `undefined` when it is usable.
   */
  verify(taskId: number, info: WorkerWorkspaceInfo): Promise<string | undefined>;
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function boundedMessage(value: string, max: number): string {
  const clean = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

export function workerBranchName(taskId: number): string {
  return `nanobot/worker-${taskId}`;
}

export function createWorkerWorkspace(options: WorkerWorkspaceOptions): WorkerWorkspace {
  const gitPath = options.gitPath ?? "git";
  const repositoryRoot = resolve(options.repositoryRoot);
  const worktreesRoot = resolve(options.worktreesRoot);
  if (inside(repositoryRoot, worktreesRoot)) {
    throw new Error("Worker worktrees must live outside the configured workspace");
  }

  const git = async (args: readonly string[], cwd: string): Promise<string> => {
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((settle) => {
      execFile(gitPath, [...args], {
        cwd,
        timeout: WORKER_LIMITS.gitTimeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      }, (error, stdout, stderr) => {
        const code = error === null
          ? 0
          : typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : 1;
        settle({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    });
    if (result.code !== 0) {
      const detail = boundedMessage(result.stderr !== "" ? result.stderr : result.stdout, WORKER_LIMITS.maxGitErrorChars);
      throw new Error(`git ${args[0]} failed${detail === "" ? "" : `: ${detail}`}`);
    }
    return result.stdout.trim();
  };

  const precheck = async (): Promise<string | undefined> => {
    try {
      const insideWorkTree = await git(["rev-parse", "--is-inside-work-tree"], repositoryRoot);
      if (insideWorkTree !== "true") {
        return "workspace mode worktree requires the configured workspace to be a git work tree";
      }
    } catch (error) {
      return "workspace mode worktree requires the configured workspace to be a git work tree: " +
        `${error instanceof Error ? error.message : String(error)}`;
    }
    let topLevel: string;
    try {
      topLevel = resolve(await git(["rev-parse", "--show-toplevel"], repositoryRoot));
    } catch (error) {
      return `workspace mode worktree is unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (topLevel !== repositoryRoot) {
      return "workspace mode worktree requires the configured workspace to be the repository root, " +
        `but the repository root is ${topLevel}`;
    }
    let status: string;
    try {
      status = await git(["status", "--porcelain=v1", "--untracked-files=no"], repositoryRoot);
    } catch (error) {
      return `workspace mode worktree could not read the repository state: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (status !== "") {
      return "workspace mode worktree requires a clean base, but the configured workspace has uncommitted " +
        "tracked changes; commit or use workspace mode shared, which runs in place";
    }
    return undefined;
  };

  const taskPath = (taskId: number): string => resolve(worktreesRoot, `worker-${taskId}`);

  const verifyAt = async (taskId: number, path: string, branch: string): Promise<string | undefined> => {
    let stats;
    try {
      stats = await lstat(path);
    } catch {
      return `worker worktree ${path} for task ${taskId} is missing; refusing to recreate or replace it`;
    }
    if (!stats.isDirectory()) {
      return `worker worktree path ${path} for task ${taskId} is not a directory; refusing to replace it`;
    }
    let topLevel: string;
    try {
      topLevel = resolve(await git(["rev-parse", "--show-toplevel"], path));
    } catch (error) {
      return `worker worktree ${path} for task ${taskId} is no longer a git work tree: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (topLevel !== path) {
      return `worker worktree identity changed: ${path} resolves to repository ${topLevel}`;
    }
    let current: string;
    try {
      current = await git(["rev-parse", "--abbrev-ref", "HEAD"], path);
    } catch (error) {
      return `worker worktree ${path} for task ${taskId} has no branch: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (current !== branch) {
      return `worker worktree ${path} for task ${taskId} is on branch ${current}, not ${branch}; refusing to reuse it`;
    }
    return undefined;
  };

  return {
    precheck,

    async open(taskId, mode) {
      if (mode === "shared") return { mode, path: repositoryRoot };
      const problem = await precheck();
      if (problem !== undefined) throw new Error(problem);
      const branch = workerBranchName(taskId);
      const path = taskPath(taskId);
      const baseCommit = await git(["rev-parse", "HEAD"], repositoryRoot);
      if (!/^[0-9a-f]{7,64}$/i.test(baseCommit)) {
        throw new Error("git rev-parse HEAD did not return a commit hash; refusing to create a worktree");
      }
      let existing = true;
      try {
        await lstat(path);
      } catch {
        existing = false;
      }
      if (existing) {
        // Only a pristine checkout of the current commit is a safe retry: nothing ran yet.
        const mismatch = await verifyAt(taskId, path, branch);
        if (mismatch !== undefined) throw new Error(mismatch);
        const checkout = await git(["rev-parse", "HEAD"], path);
        if (checkout !== baseCommit) {
          throw new Error(
            `worker worktree ${path} for task ${taskId} already exists at ${checkout}, not ${baseCommit}; ` +
            "refusing to replace it",
          );
        }
        return { mode, path, branch, baseCommit };
      }
      await git(["worktree", "add", "-b", branch, path, baseCommit], repositoryRoot);
      const mismatch = await verifyAt(taskId, path, branch);
      if (mismatch !== undefined) throw new Error(mismatch);
      return { mode, path, branch, baseCommit };
    },

    async verify(taskId, info) {
      if (info.mode === "shared") {
        // A relocated configuration must not let an old task keep writing a workspace that is no
        // longer the configured one; fail truthfully instead of silently reusing the stale path.
        return resolve(info.path) === repositoryRoot
          ? undefined
          : `worker task ${taskId} was prepared for shared workspace ${info.path}, not the configured ` +
            `workspace ${repositoryRoot}; refusing to reuse it`;
      }
      return verifyAt(taskId, info.path, info.branch ?? workerBranchName(taskId));
    },
  };
}
