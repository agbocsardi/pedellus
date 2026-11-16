import {
  defineExtension,
  wrapTool,
  type ConversationId,
  type Extension,
  type ToolRegistration,
  type Wrap,
} from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { createReadImageProcessor } from "../media/read-images.js";
import { createConfigToolHook } from "./config-authority.js";

/** Native coding tools this slice can register, in ceiling order. */
export const CODING_TOOL_NAMES = Object.freeze(["read", "write", "edit", "bash"] as const);

export type CodingToolName = (typeof CODING_TOOL_NAMES)[number];

export interface CodingToolExtensionOptions {
  /** Tools to register; must be a non-empty subset of `CODING_TOOL_NAMES`. */
  readonly tools: readonly CodingToolName[];
  /** Host-owned ceiling the call-time hook enforces; normally the configured allowlist. */
  readonly ceiling: readonly string[];
  /** Optional separate coding ceiling for captured task targets; mapped chats still use `ceiling`. */
  readonly capturedCeiling?: (conversationId: ConversationId) => readonly string[];
  /**
   * Non-effectful context tools registered by another extension in the same conversations.
   * The hook exempts them; they are outside this ceiling and never widen it.
   */
  readonly contextTools?: readonly string[];
  /**
   * Names whose call-time authority a separate hook enforces (MCP server tools and the Code Mode
   * tools that reach them). A block here would make that authority unreachable, so the host must
   * return true only for names its other hook actually guards.
   */
  readonly delegatedTools?: (name: string) => boolean;
  /** Effective config-level shell timeout, for a meaningful message when the host default fires. */
  readonly defaultTimeoutSeconds: number;
  /**
   * Host predicate: true only for conversations the host has authenticated as ordinary mapped
   * chats. Scheduled-run captures are checked at call time against their recorded origin.
   */
  readonly authenticatedChat: (conversationId: ConversationId) => boolean;
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
 * Register the native read/write/edit/bash tools over the guarded host environment. The configured
 * ceiling authorizes authenticated mapped chat conversations; the host's call-time hook rechecks
 * that, and a scheduled-run target must present a capture bounded by the current ceiling. Tool
 * definitions, limits, output windows and spill behavior stay native; `read` prepares a bounded,
 * model-facing image copy while the original file stays untouched.
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
  // One processor per extension: Photon starts lazily on the first image and its
  // worker bounds decode time and releases memory when idle.
  const readImages = createReadImageProcessor();
  for (const name of CODING_TOOL_NAMES) {
    if (!selected.has(name)) continue;
    if (name === "read") tools.push(createReadTool({ images: readImages }));
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
    hooks: [createConfigToolHook(options.ceiling, options.authenticatedChat, contextTools, options.delegatedTools, options.capturedCeiling)],
  });
}
