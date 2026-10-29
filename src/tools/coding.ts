import {
  defineExtension,
  wrapTool,
  type ConversationId,
  type Extension,
  type ToolRegistration,
  type Wrap,
} from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { createConfigToolHook } from "./config-authority.js";
import { createToolGrantHook } from "./grants.js";

/** Native coding tools this slice can register, in ceiling order. */
export const CODING_TOOL_NAMES = Object.freeze(["read", "write", "edit", "bash"] as const);

export type CodingToolName = (typeof CODING_TOOL_NAMES)[number];

export interface CodingToolExtensionOptions {
  /** Tools to register; must be a non-empty subset of `CODING_TOOL_NAMES`. */
  readonly tools: readonly CodingToolName[];
  /** Host-owned ceiling the grant hook enforces; normally the configured allowlist. */
  readonly ceiling: readonly string[];
  /**
   * Non-effectful context tools registered by another extension in the same conversations.
   * The grant hook exempts them; they are not grantable and never widen this ceiling.
   */
  readonly contextTools?: readonly string[];
  /** Effective config-level shell timeout, for a meaningful message when the host default fires. */
  readonly defaultTimeoutSeconds: number;
  /** Grant-clock override; defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Config-mode host predicate: true only for conversations the host has authenticated as ordinary
   * mapped chats. When present, the ceiling is authority for those conversations and scheduled-run
   * captures are checked at call time instead of expiring grants.
   */
  readonly authenticatedChat?: (conversationId: ConversationId) => boolean;
}

/**
 * Native bash names the timeout it requested. When the caller omits one and the host policy default
 * fires, that value is `undefined`, and the native schema says "no default timeout". Declare the host
 * default and keep native output, spill and execution semantics; only that one timeout message changes.
 */
function withHostTimeoutDeclaration<T extends ToolRegistration>(
  tool: T,
  defaultTimeoutSeconds: number,
): T {
  if (defaultTimeoutSeconds <= 0) return tool;
  const parameters = tool.parameters as unknown as {
    readonly properties?: Record<string, unknown>;
  };
  const timeout = parameters.properties?.timeout;
  const declaredParameters =
    parameters.properties === undefined || timeout === null || typeof timeout !== "object"
      ? tool.parameters
      : {
          ...parameters,
          properties: {
            ...parameters.properties,
            timeout: {
              ...(timeout as Record<string, unknown>),
              description: `Timeout in seconds (optional; host default ${defaultTimeoutSeconds} seconds)`,
            },
          },
        };
  return {
    ...tool,
    description:
      `${tool.description} A host default timeout of ${defaultTimeoutSeconds} seconds applies ` +
      "when no timeout is given.",
    parameters: declaredParameters,
    async execute(...callArgs: Parameters<T["execute"]>) {
      const [args, api, context] = callArgs;
      try {
        return await tool.execute(args, api, context);
      } catch (error) {
        if (error instanceof Error && error.message === "Command timed out after undefined seconds") {
          throw new Error(`Command timed out after ${defaultTimeoutSeconds} seconds`, { cause: error });
        }
        throw error;
      }
    },
  } as T;
}

/**
 * Register the native read/write/edit/bash tools over the guarded host environment. In the default
 * grant mode no tool is offered unless the conversation has an explicit unexpired grant, and the
 * grant hook rechecks that at call time. In config mode the host passes its authenticated-chat
 * predicate and the same ceiling directly authorizes those conversations, with scheduled-run
 * captures bounded by it. Tool definitions, limits, output windows and spill behavior stay native.
 */
export function createCodingToolExtension(options: CodingToolExtensionOptions): Extension {
  const selected = new Set(options.tools);
  const unknown = [...selected].filter(
    (name) => !(CODING_TOOL_NAMES as readonly string[]).includes(name),
  );
  if (unknown.length > 0) throw new Error(`Unknown coding tools: ${unknown.join(", ")}`);
  if (selected.size === 0) throw new Error("A coding tool extension requires at least one tool");
  const contextTools = [...(options.contextTools ?? [])];
  if (contextTools.some((name) => typeof name !== "string" || name.length === 0 || selected.has(name as CodingToolName))) {
    throw new Error("Context tools must be non-empty names outside the coding tool set");
  }

  const tools: ToolRegistration[] = [];
  const wraps: Wrap[] = [];
  for (const name of CODING_TOOL_NAMES) {
    if (!selected.has(name)) continue;
    if (name === "read") tools.push(createReadTool());
    else if (name === "write") tools.push(createWriteTool());
    else if (name === "edit") tools.push(createEditTool());
    else {
      const bash = createBashTool();
      tools.push(bash);
      wraps.push(wrapTool(bash, (tool) => withHostTimeoutDeclaration(tool, options.defaultTimeoutSeconds)));
    }
  }

  return defineExtension({
    name: "nanobot-coding-tools",
    tools,
    wraps,
    hooks: [
      options.authenticatedChat === undefined
        ? createToolGrantHook(options.ceiling, options.now ?? Date.now, contextTools)
        : createConfigToolHook(options.ceiling, options.authenticatedChat, contextTools),
    ],
  });
}
