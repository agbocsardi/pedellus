import type { Context } from "@earendil-works/chord";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ToolEnvironments } from "../tools/index.js";

/**
 * Guarded tool environments of worktree workers, one set per checkout root. A root's environments
 * are created on its first tool call and closed (child processes stopped, scratch space released)
 * as soon as the last live worker in that checkout ends, instead of living until the gateway closes.
 */
export function createWorkerEnvironmentPool(
  create: (root: string) => ToolEnvironments,
  report: (error: unknown) => void,
) {
  const pool = new Map<string, ToolEnvironments>();
  const closing = new Set<Promise<void>>();
  return {
    forConversation(root: string, conversationId: ConversationId, context: Context) {
      let environments = pool.get(root);
      if (environments === undefined) {
        environments = create(root);
        pool.set(root, environments);
      }
      return environments.forConversation(conversationId, context);
    },
    /** Close and forget one checkout's environments; never awaited by a commit, failures are reported. */
    release(root: string, context: Context): void {
      const environments = pool.get(root);
      if (environments === undefined) return;
      pool.delete(root);
      const pending = environments.close(context).catch(report).finally(() => { closing.delete(pending); });
      closing.add(pending);
    },
    has: (root: string): boolean => pool.has(root),
    /** Close every remaining set at gateway close or failed open; `close` isolates each failure. */
    async closeAll(close: (operation: () => unknown) => Promise<void>, context: Context): Promise<void> {
      const remaining = [...pool.values()];
      pool.clear();
      for (const environments of remaining) await close(() => environments.close(context));
      await Promise.all([...closing]);
    },
  };
}

export type WorkerEnvironmentPool = ReturnType<typeof createWorkerEnvironmentPool>;
