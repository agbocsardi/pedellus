import type { Context } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createHostExecutionEnv, type HostExecutionEnv } from "../execution/host.js";

export interface ToolEnvironmentOptions {
  /** Canonical actual workspace root. File tools operate here, not on a managed copy. */
  readonly workspaceRoot: string;
  /** Additional canonical roots the filesystem guard accepts. */
  readonly allowedRoots?: readonly string[];
  /** Config-level shell timeout; absent keeps the shared policy default. */
  readonly timeoutSeconds?: number;
}

export interface ToolEnvironments {
  /** One stable environment per conversation, so scratch/spill space stays conversation-local. */
  forConversation(conversationId: ConversationId, context: Context): Promise<ExecutionEnv>;
  close(context: Context): Promise<void>;
}

/**
 * Build and own the guarded host environments. Environments are long-lived per conversation and
 * cleaned up once the Gateway closes; no tool call cleans up or replaces another call's environment.
 */
export function createToolEnvironments(options: ToolEnvironmentOptions): ToolEnvironments {
  const environments = new Map<ConversationId, Promise<HostExecutionEnv>>();
  let closed = false;

  return {
    forConversation(conversationId, _context) {
      if (closed) return Promise.reject(new Error("Tool environments are closed"));
      let pending = environments.get(conversationId);
      if (pending === undefined) {
        pending = createHostExecutionEnv({
          workspaceRoot: options.workspaceRoot,
          ...(options.allowedRoots === undefined || options.allowedRoots.length === 0
            ? {}
            : { allowedRoots: options.allowedRoots }),
          shell: {
            restrictToWorkspace: true,
            ...(options.timeoutSeconds === undefined ? {} : { timeoutSeconds: options.timeoutSeconds }),
          },
        });
        environments.set(conversationId, pending);
        void pending.catch(() => {
          if (environments.get(conversationId) === pending) environments.delete(conversationId);
        });
      }
      return pending;
    },

    async close(context) {
      if (closed) return;
      closed = true;
      const pending = [...environments.values()];
      environments.clear();
      const settled = await Promise.allSettled(pending);
      await Promise.all(
        settled.flatMap((result) =>
          result.status === "fulfilled" ? [result.value.cleanup(context)] : [],
        ),
      );
    },
  };
}
