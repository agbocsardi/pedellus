import { Type } from "typebox";
import { defineTool, type JsonObject, type ToolRegistration } from "@earendil-works/pi-durable";
import { toLlmContent, type Tool as McpTool } from "@earendil-works/pi-mcp";
import type { JsonValue } from "@earendil-works/chord";
import { MCP_LIMITS } from "./config.js";
import type { McpServerConnection } from "./server.js";

/**
 * The value a Code Mode script receives from an MCP tool: the complete `CallToolResult` without
 * `_meta`, as the coding agent passes it. A result with `isError` still resolves inside scripts and
 * is reported as an error result otherwise.
 *
 * The declaration is intentionally loose (`content` items only pin `type`): a server's own output
 * schema is untrusted and may use any JSON Schema dialect, so it is not copied into the
 * registration contract.
 */
const CONTENT_BLOCK_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string" },
    text: { type: "string" },
    data: { type: "string" },
    mimeType: { type: "string" },
  },
  required: ["type"],
  additionalProperties: true,
} as const;

const CALL_TOOL_RESULT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    content: { type: "array", items: CONTENT_BLOCK_SCHEMA },
    structuredContent: {},
    isError: { type: "boolean" },
  },
  required: ["content"],
  // Fields newer protocol revisions add stay readable.
  additionalProperties: true,
});

/** An object-shaped input schema; providers reject one without `properties`. */
const ANY_OBJECT_SCHEMA = Object.freeze({
  type: "object",
  properties: {},
  additionalProperties: true,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

/**
 * Copy of a server's input schema, forced to an object schema and bounded in size. A schema over the
 * limit becomes an unconstrained object so the tool stays callable and the declaration stays small.
 */
function boundedInputSchema(tool: McpTool): Record<string, unknown> {
  const source = isRecord(tool.inputSchema) ? tool.inputSchema : {};
  const candidate = {
    ...source,
    type: "object",
    properties: isRecord(source.properties) ? source.properties : {},
  };
  if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= MCP_LIMITS.maxSchemaBytes) return candidate;
  return { ...ANY_OBJECT_SCHEMA };
}

/**
 * One MCP tool as a native Durable registration.
 *
 * - `deferred`: absent from the main prompt; `searchTools()` in Code Mode and `tool_search` both
 *   reach it, which is the coding agent's `codemode`/`deferred` behavior.
 * - No `replay`: an interrupted call is `unsafe` and is never rerun after a restart, so an
 *   interrupted external effect is not repeated. Annotations are not consulted at all.
 * - `execute` rechecks the connection and the server's current tool list, so a stale registration
 *   (another conversation, a persisted selection, a prepared replay, a nested script) cannot reach
 *   a disabled, disconnected or withdrawn tool.
 */
export function createMcpToolRegistration(
  server: McpServerConnection,
  registrationName: string,
  tool: McpTool,
): ToolRegistration {
  const description = bounded(
    tool.description?.trim() || tool.title?.trim() || tool.name,
    MCP_LIMITS.maxToolDescriptionChars,
  );
  return defineTool({
    name: registrationName,
    description,
    parameters: Type.Unsafe(boundedInputSchema(tool)),
    structuredOutputSchema: Type.Unsafe(CALL_TOOL_RESULT_SCHEMA),
    deferred: true,
    async execute(args, _api, context) {
      const result = await server.callTool(tool.name, args as JsonObject, context.abortSignal);
      const content = Array.isArray(result.content) ? result.content : [];
      const value = {
        content,
        ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
        isError: result.isError === true,
      };
      return {
        output: toLlmContent({
          content: result.content,
          ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
        }),
        structuredOutput: value as unknown as JsonValue,
        ...(result.isError === true ? { isError: true } : {}),
      };
    },
  });
}
