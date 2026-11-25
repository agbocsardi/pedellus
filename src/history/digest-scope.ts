/**
 * The memory-digest curation scope: which workspace paths a digest run may touch, the call-time
 * scope and budget hook, and the create-only `write`.
 *
 * Scope is SOUL.md, USER.md, memory/**.md (never the legacy MEMORY.md/HISTORY.md) and
 * skills/<name>/SKILL.md. The path guard is lexical: it cannot defend against a symlink swapped in
 * after the check. Budgets are charged at the native call from the run's committed transcript, so a
 * refused call still counts and a mutation that would exceed a bound never runs.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import {
  defineExtension,
  GenerationTask,
  hook,
  ToolTask,
  wrapTool,
  type ConversationId,
  type Extension,
  type Harness,
  type HookRegistration,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createWriteTool } from "@earendil-works/pi-durable/tools";
import { MEMORY_DIR, PROTECTED_MEMORY_NAMES, SAFE_ASCII_NAME } from "../context/fs-safe.js";
import { supportsExclusiveFileCreate } from "../execution/host.js";
import { DIGEST_RUN_LIMITS_DEFAULT, type DigestRunLimits } from "./digest-limits.js";
import { MEMORY_DIGEST_TOOL_NAMES } from "./digest-prompt.js";
import {
  createDigestTranscriptTracker,
  digestFailureVerdict,
  MEMORY_DIGEST_BUDGET_REFUSAL_PREFIX,
  toolCallsOf,
  toolOutcomesOf,
  type DigestToolUse,
} from "./digest-verifier.js";
import { isRecord } from "./transcript.js";

export const MEMORY_DIGEST_SCOPE_EXTENSION_NAME = "nanobot.memory-digest-scope";

/**
 * Why a workspace-relative path is outside the memory curation scope, or undefined when it is in
 * scope. A naming guard only: it cannot defend against a symlink swapped in after the check.
 */
export function memoryDigestScopeProblem(path: string): string | undefined {
  if (typeof path !== "string" || path.length === 0) return "a workspace-relative path is required";
  if (path.includes("\u0000")) return "the path contains a NUL byte";
  if (path.includes("\\")) return "use forward slashes in a workspace-relative path";
  if (isAbsolute(path)) return "use a workspace-relative path";
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment.length === 0) return "the path has an empty segment";
    if (segment === "." || segment === "..") return "the path has a relative segment";
    if (!SAFE_ASCII_NAME.test(segment)) return "the path has an unsafe segment";
  }
  if (!path.endsWith(".md")) return "only Markdown files are curated";
  const base = segments[segments.length - 1]!;
  if (segments.length === 1) {
    return path === "SOUL.md" || path === "USER.md"
      ? undefined
      : "only SOUL.md, USER.md, memory/**/*.md and skills/<name>/SKILL.md are curated";
  }
  if (segments[0] === MEMORY_DIR) {
    return PROTECTED_MEMORY_NAMES.has(base) ? `${base} is a legacy name and is not curated` : undefined;
  }
  if (segments[0] === "skills") {
    if (segments.length !== 3 || base !== "SKILL.md") return "only skills/<name>/SKILL.md is curated";
    return undefined;
  }
  return "only SOUL.md, USER.md, memory/**/*.md and skills/<name>/SKILL.md are curated";
}

/** Match the execution hook's lexical resolution and containment rules. */
export function mutationPathOf(args: unknown, workspaceRoot: string): string | undefined {
  if (!isRecord(args) || typeof args.path !== "string" || args.path.length === 0) return undefined;
  const root = resolve(workspaceRoot);
  const inside = relative(root, resolve(root, args.path));
  if (inside.length === 0 || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined;
  const path = inside.split(sep).join("/");
  return memoryDigestScopeProblem(path) === undefined ? path : undefined;
}

function digestScopeHook(workspaceRoot: string, options: MemoryDigestScopeOptions): HookRegistration {
  const root = resolve(workspaceRoot);
  const tracker = createDigestTranscriptTracker();
  return hook(ToolTask, {
    async beforeTool(call, api, context) {
      const refuseBudget = (reason: string) => ({ block: `${MEMORY_DIGEST_BUDGET_REFUSAL_PREFIX}${reason}` });
      if (!(MEMORY_DIGEST_TOOL_NAMES as readonly string[]).includes(call.name)) {
        return { block: `Memory digestion holds only ${MEMORY_DIGEST_TOOL_NAMES.join(", ")}; ${call.name} is not available` };
      }
      const supplied = (call.arguments as Record<string, unknown> | undefined)?.path;
      if (typeof supplied !== "string" || supplied.length === 0) {
        return { block: `${call.name} needs a workspace-relative path inside the memory curation scope` };
      }
      const absolute = resolve(root, supplied);
      const inside = relative(root, absolute);
      if (inside.length === 0 || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
        return { block: "Memory digestion may only reach files inside the configured workspace" };
      }
      const problem = memoryDigestScopeProblem(inside.split(sep).join("/"));
      if (problem !== undefined) return { block: `Memory digestion is out of scope: ${problem}` };

      // Budgets are checked at the native call, after scope and before execution, so a failed or
      // refused call still counts and a mutation that would exceed a bound never runs. The counters
      // come from this run's committed transcript, so a replay or reopen cannot reset them. Each call
      // reads only the entries committed since this conversation's previous call.
      const limits = options.limitsFor === undefined
        ? DIGEST_RUN_LIMITS_DEFAULT
        : options.limitsFor(api.conversationId);
      if (limits === undefined) {
        return refuseBudget("its configured run budget could not be verified; the batch was not acknowledged");
      }
      if (options.harness !== undefined) {
        let use: DigestToolUse;
        try {
          use = await tracker.toolUse(
            options.harness(),
            api.conversationId,
            { id: call.id, name: call.name, arguments: call.arguments },
            limits,
            context,
          );
        } catch {
          return refuseBudget("its tool and spending budget could not be verified; the batch was not acknowledged");
        }
        if (use.calls > limits.maxToolCalls) {
          return refuseBudget("it reached its configured tool-call budget; the batch was not acknowledged");
        }
        // A tool round needs room for one more successful response. Native failed attempts and
        // retries are reported separately; the owner-approved limit counts successful responses.
        if (!limits.spendingAdmissionOnly && use.successfulRequests >= limits.maxRequests) {
          return refuseBudget("it reached its configured successful-response budget; the batch was not acknowledged");
        }
        if (use.unaccountedResponses > 0) {
          return refuseBudget(
            "a committed response's reported usage could not be verified; the batch was not acknowledged",
          );
        }
        if (!limits.spendingAdmissionOnly && use.chargedInputTokens + use.reserveNextTokens > limits.maxInputTokens) {
          return refuseBudget("it reached its configured input-token budget; the batch was not acknowledged");
        }
        if (call.name === "write" || call.name === "edit") {
          if (use.paths.size > limits.maxChangedFiles) {
            return refuseBudget("it reached its configured changed-file budget; the batch was not acknowledged");
          }
          if (use.diffChars > limits.maxDiffChars) {
            return refuseBudget("it reached its configured changed-text budget; the batch was not acknowledged");
          }
        }
      }
      return undefined;
    },
  });
}

/**
 * Digest `write` is create-only for real: it performs one guarded `O_CREAT | O_EXCL` create through the
 * host environment instead of the native truncating write. A concurrent create — by this process or by
 * an outside editor — makes the call fail with nothing overwritten, so there is no check-then-write
 * window. A host environment without that primitive fails the call closed rather than falling back.
 * It does not join the platform's internal per-file mutation queue (not exported); atomic exclusivity
 * is the property that matters here, and an existing file is never replaced. `edit` keeps its native
 * serialized in-process behaviour; an outside process changing the file between its read and its write
 * is not detected.
 */
function digestWriteWrap(): ReturnType<typeof wrapTool<ToolRegistration>> {
  return wrapTool(createWriteTool() as ToolRegistration, (tool) => ({
    ...tool,
    async execute(args, api, context) {
      const { path, content } = args as { readonly path?: unknown; readonly content?: unknown };
      if (typeof path !== "string" || path.length === 0 || typeof content !== "string") {
        throw new TypeError("write needs a path and content");
      }
      const env = api.env;
      if (env === undefined) throw new Error("No execution environment is configured");
      if (!supportsExclusiveFileCreate(env)) {
        throw new Error(
          "This environment cannot create a file exclusively, so memory digestion refuses to write it",
        );
      }
      if (context.abortSignal?.aborted) throw new Error("Operation aborted");
      const created = await env.createFileExclusive(path, content, context);
      if (!created.ok) {
        if (created.error.code === "invalid" && created.error.message === "the file already exists") {
          throw new Error(
            "write is create-only in memory digestion: that file already exists; read it and " +
            "use edit with the exact current oldText so a concurrent owner change is never overwritten",
          );
        }
        throw new Error(created.error.message);
      }
      if (context.abortSignal?.aborted) throw new Error("Operation aborted");
      return { output: [{ type: "text" as const, text: `Successfully wrote to ${path}` }] };
    },
  }) as ToolRegistration);
}

/** Host lookups the scope hook needs: the target transcript and this run's accepted bounds. */
export interface MemoryDigestScopeOptions {
  /** Live harness, resolved at call time because the extension is built before the Harness opens. */
  readonly harness?: () => Harness;
  /** Accepted bounds of the run that owns this conversation; absent uses the shared defaults. */
  readonly limitsFor?: (conversationId: ConversationId) => DigestRunLimits | undefined;
}

/** The curation-scope hook and create-only writer a digest target conversation needs. */
export function createMemoryDigestScopeExtension(
  workspaceRoot: string,
  options: MemoryDigestScopeOptions = {},
): Extension {
  return defineExtension({
    name: MEMORY_DIGEST_SCOPE_EXTENSION_NAME,
    hooks: [digestScopeHook(workspaceRoot, options), hook(GenerationTask, {
      async afterTools(assistant, results, api, context) {
        if (options.harness === undefined) return;
        const calls = toolCallsOf(await api.entry(assistant, context).catch(() => undefined));
        let fatal = false;
        for (const id of results) {
          const entry = await api.entry(id, context).catch(() => undefined);
          if (entry === undefined) continue;
          for (const outcome of toolOutcomesOf(entry, calls)) {
            if (!outcome.isError) continue;
            if (digestFailureVerdict(outcome.name, outcome.arguments, outcome.diagnostics, workspaceRoot) === "fatal") {
              fatal = true;
              break;
            }
          }
          if (fatal) break;
        }
        if (!fatal) return;
        // A host budget/usage refusal, a harness interruption or an impossible mutation is not
        // repairable. Preserve its committed result, then abort rather than spending more requests
        // on calls that can only be refused again. A harmless failed read and an in-scope failed
        // write/edit do not abort: the model may re-read and repair them before its report, and the
        // final committed-turn validation still decides whether the batch may be acknowledged.
        // abort() joins this generation task too, so start it without awaiting our own termination.
        const conversation = await options.harness().conversation(api.conversationId, context);
        void conversation?.abort(withoutAbortSignal(context)).catch(() => {
          // The deadline and final turn validation still fail closed if teardown races this abort.
        });
      },
    })],
    wraps: [digestWriteWrap()],
  });
}

/** The curated subset of one configured allowlist; order follows the allowlist. */
export function memoryDigestCurationTools(allowed: readonly string[]): string[] {
  return allowed.filter((name) => (MEMORY_DIGEST_TOOL_NAMES as readonly string[]).includes(name));
}

/** True only when every tool a digest run needs is granted. */
export function hasMemoryDigestTools(tools: readonly string[]): boolean {
  return MEMORY_DIGEST_TOOL_NAMES.every((name) => tools.includes(name));
}
