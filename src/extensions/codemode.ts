import type { Context } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { parseCodemodeSource, CODEMODE_OPTIONS_PREFIX } from "@earendil-works/pi-codemode/source";
import {
  CODEMODE_TOOL_NAME,
  createCodemodeExtension,
  type CodemodeNamespace,
} from "@earendil-works/pi-durable/codemode";
import { createToolSearchExtension, TOOL_SEARCH_TOOL_NAME } from "@earendil-works/pi-durable/tool-search";
import {
  defineExtension,
  type Extension,
  type ToolExecutionApi,
  type ToolRegistration,
  wrapTool,
} from "@earendil-works/pi-durable";

export const CODEMODE_BUDGETS = Object.freeze({
  memoryLimitBytes: 128 * 1024 * 1024,
  timeoutMs: 60_000,
  maxOutputTokens: 4_000,
  maxWorkers: 2,
});

export interface CodeModeIntegrationOptions {
  /** Group deferred tools in the native code-mode declaration and search. */
  readonly namespaces?: readonly CodemodeNamespace[];
  /** Explicitly opt into Durable's non-LLM models.* capabilities. Default false. */
  readonly models?: boolean;
}

/** The native tool names a host may need when it gates or delegates Code Mode authority. */
export { TOOL_SEARCH_TOOL_NAME, CODEMODE_TOOL_NAME };

/** Install these extensions explicitly; close the Harness before closing this host. */
export interface CodeModeIntegration {
  readonly extensions: readonly [Extension, Extension];
  /** Reject new executions and abort current Code Mode executions. */
  stopAdmission(): void;
  /** Stop admission, close the native sandbox, and wait for every worker thread to exit. */
  close(): Promise<void>;
}

function boundSource(source: string): string {
  const parsed = parseCodemodeSource(source);
  const timeoutMs = Math.min(parsed.options.timeoutMs ?? CODEMODE_BUDGETS.timeoutMs, CODEMODE_BUDGETS.timeoutMs);
  const maxOutputTokens = Math.min(
    parsed.options.maxOutputTokens ?? CODEMODE_BUDGETS.maxOutputTokens,
    CODEMODE_BUDGETS.maxOutputTokens,
  );
  const options = JSON.stringify({ max_output_tokens: maxOutputTokens, timeout_ms: timeoutMs });
  const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
  const hasOptionsLine = firstLine.trimStart().startsWith(CODEMODE_OPTIONS_PREFIX);
  return `${CODEMODE_OPTIONS_PREFIX} ${options}${hasOptionsLine ? parsed.code : `\n${parsed.code}`}`;
}

/**
 * Create an inert Durable Code Mode + deferred-tool discovery bundle.
 * Native Durable remains responsible for validation, hooks, nested tasks, journaling, stores and forks.
 */
export function createCodeModeIntegration(options: CodeModeIntegrationOptions = {}): CodeModeIntegration {
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let reservedWorkers = 0;
  const shutdown = new AbortController();
  const activeExecutions = new Set<Promise<unknown>>();
  const workerExits = new Set<Promise<void>>();

  const sandbox = new CodemodeSandbox({
    memoryLimitBytes: CODEMODE_BUDGETS.memoryLimitBytes,
    acquireWorker() {
      if (closed) throw new Error("Code Mode admission is closed");
      if (reservedWorkers >= CODEMODE_BUDGETS.maxWorkers) {
        throw new Error(`Code Mode worker capacity exhausted (limit ${CODEMODE_BUDGETS.maxWorkers})`);
      }
      reservedWorkers++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        reservedWorkers--;
      };
    },
    onWorkerStarted(exited) {
      workerExits.add(exited);
      void exited.then(() => workerExits.delete(exited));
    },
  });

  const native = createCodemodeExtension({
    sandbox,
    models: options.models === true,
    ...(options.namespaces === undefined ? {} : { namespaces: options.namespaces }),
  });
  const nativeTool = native.tools?.find((tool) => tool.name === CODEMODE_TOOL_NAME);
  if (!nativeTool) throw new Error("Durable Code Mode extension did not register its codemode tool");

  const boundedCodeMode = defineExtension({
    ...native,
    wraps: [
      ...(native.wraps ?? []),
      wrapTool(nativeTool as ToolRegistration, (tool) => {
        const registration = tool as ToolRegistration;
        const execute = registration.execute;
        return {
          ...tool,
          async execute(args: { code: string }, api: ToolExecutionApi, context: Context) {
            if (closed) throw new Error("Code Mode integration is closed");
            // Invalid source/options retain the native tool's error path.
            let code = args.code;
            try {
              code = boundSource(code);
            } catch {
              // createCodemodeTool parses the same source and returns its normal error result.
            }
            const scopedContext = withAbortSignal(shutdown.signal, context);
            const running = Promise.resolve(execute({ ...args, code }, api, scopedContext));
            activeExecutions.add(running);
            try {
              return await running;
            } finally {
              activeExecutions.delete(running);
            }
          },
        } as unknown as ToolRegistration;
      }),
    ],
  });

  const extensions = [boundedCodeMode, createToolSearchExtension()] as const;
  const stopAdmission = () => {
    if (closed) return;
    closed = true;
    shutdown.abort(new Error("Code Mode integration is shutting down"));
  };

  return {
    extensions,
    stopAdmission,
    close() {
      if (closePromise) return closePromise;
      stopAdmission();
      closePromise = (async () => {
        try {
          await sandbox.close();
        } finally {
          await Promise.allSettled([...activeExecutions]);
          // CodemodeSandbox.close() requests termination but deliberately does not await worker exit.
          while (workerExits.size > 0) await Promise.all([...workerExits]);
        }
      })();
      return closePromise;
    },
  };
}
