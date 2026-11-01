import {
  defineExtension,
  hook,
  ToolTask,
  type ConversationId,
  type Extension,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import { MCP_LIMITS, mcpServerEnabled, type McpConfig, type McpServerConfig } from "./config.js";
import { mcpNamespaceName, mcpToolNames, mcpToolPrefix, MCP_TOOL_PREFIX } from "./naming.js";
import { mcpOAuthStatePath } from "./oauth-store.js";
import { McpServerConnection, type McpServerStatus } from "./server.js";
import { createMcpToolRegistration } from "./tools.js";

export {
  DEFAULT_MCP_TIMEOUT_SECONDS,
  MCP_LIMITS,
  mcpServerEnabled,
  mcpTimeoutMs,
  parseMcpConfig,
  type McpConfig,
  type McpHttpServerConfig,
  type McpServerBase,
  type McpServerConfig,
  type McpStdioServerConfig,
} from "./config.js";
export { mcpNamespaceName, mcpToolNames, mcpToolPrefix, MCP_TOOL_NAME_MAX, MCP_TOOL_PREFIX } from "./naming.js";
export {
  McpServerConnection,
  MissingEnvironmentError,
  MissingOAuthGrantError,
  type McpFailureCode,
  type McpServerState,
  type McpServerStatus,
} from "./server.js";
export { createMcpToolRegistration } from "./tools.js";
export {
  FileMcpOAuthStateStore,
  adoptMcpOAuthRefresh,
  commitMcpOAuthState,
  commitMcpOAuthStateIfUnchanged,
  hasMcpOAuthTokens,
  mcpOAuthGrantEpoch,
  mcpOAuthStagingPath,
  mcpOAuthStatePath,
  mcpOAuthStoreDirectory,
  snapshotMcpOAuthGrant,
  type McpOAuthGrantSnapshot,
} from "./oauth-store.js";
export { beginMcpLogin, MCP_LOGIN_TIMEOUT_MS, type McpLoginFailure, type McpLoginOutcome, type McpLoginRun } from "./login.js";
export {
  removeMcpServerEntry,
  writeMcpServerEntry,
  type McpConfigBlockExpectation,
  type McpConfigEdit,
  type McpConfigEditResult,
} from "./install.js";
export {
  createMcpAdmin,
  loginNoticeText,
  MCP_ADMIN_LIMITS,
  MCP_ADMIN_TOOL_NAME,
  McpRequestsDoc,
  type McpAdmin,
  type McpAdminListing,
  type McpAdminRequestView,
  type McpAdminServer,
  type McpApproveResult,
  type McpLoginNotice,
  type McpRequest,
  type McpRequestKind,
  type McpRequestStore,
} from "./admin.js";

export interface McpIntegrationOptions {
  readonly config: McpConfig;
  /** Workspace root; a stdio server without `cwd` runs here. */
  readonly workspace: string;
  /**
   * Canonical data directory. An `oauth: true` HTTP entry reads its owner-approved grant from a private
   * file under it. Absent means such an entry fails closed with `auth-required`.
   */
  readonly dataDir?: string;
  /**
   * Host predicate: true only for conversations the host has authenticated as ordinary mapped
   * chats. It is consulted on every MCP tool call, never at registration or prompt time.
   */
  readonly isAuthorizedChat: (conversationId: ConversationId) => boolean;
  /**
   * Tool names owned by another capability that this hook also gates (Code Mode and tool search).
   * They are exempt from the coding-tool ceiling, so their call-time authority lives here.
   */
  readonly delegatedToolNames: readonly string[];
  /** Host environment the configured variable names are resolved from. Defaults to `process.env`. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/**
 * Explicit MCP connection authority plus its model-facing registrations.
 *
 * `extension` carries the tools and one call-time hook. The host selects it only in authorized
 * conversations. Every call is rechecked against the live connection and the server's current tool
 * list, so a persisted selection, a prepared replay, a nested Code Mode call or a stale discovery
 * entry cannot reach a disabled or withdrawn tool.
 */
export interface McpIntegration {
  readonly extension: Extension;
  /** Registration names of every connected server's tools. */
  readonly toolNames: readonly string[];
  /** Code Mode namespaces, one per connected server, for tool discovery and `describeNamespace()`. */
  readonly namespaces: readonly CodemodeNamespace[];
  /** One entry per enabled configured server; failures carry a fixed code, never a value. */
  readonly status: readonly McpServerStatus[];
  /** Whether a registration belongs to a configured MCP server. */
  ownsTool(name: string): boolean;
  close(): Promise<void>;
}

interface ToolOwner {
  readonly server: McpServerConnection;
  /** The server's own tool name. */
  readonly serverTool: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function namespaceFor(
  server: McpServerConnection,
  config: McpServerConfig,
): CodemodeNamespace {
  const instructions = server.instructions;
  const summary = config.description?.trim()
    || (instructions === undefined ? "" : firstLine(instructions));
  return Object.freeze({
    name: mcpNamespaceName(server.name),
    prefix: mcpToolPrefix(server.name),
    ...(summary === "" ? {} : { description: bounded(summary, MCP_LIMITS.maxDescriptionChars) }),
    // Server instructions are untrusted text: bounded, and labeled with their origin. They are never
    // part of a tool description or the Code Mode section, only `describeNamespace()`.
    ...(instructions === undefined
      ? {}
      : {
          instructions: bounded(
            `Untrusted instructions reported by MCP server "${server.name}":\n${instructions}`,
            MCP_LIMITS.maxInstructionsChars,
          ),
        }),
  });
}

async function connect(
  name: string,
  config: McpServerConfig,
  workspace: string,
  dataDir: string | undefined,
  environment: Readonly<Record<string, string | undefined>> | undefined,
): Promise<McpServerConnection> {
  const server = new McpServerConnection({
    name,
    config,
    workspace,
    ...(environment === undefined ? {} : { environment }),
    ...("url" in config && config.oauth === true && dataDir !== undefined
      ? { oauth: { storePath: mcpOAuthStatePath(dataDir, config.url) } }
      : {}),
  });
  await server.open();
  return server;
}

/**
 * Connect every enabled server, build the MCP tool registrations and namespaces, and return the
 * extension that carries them. A server that fails to start contributes no tool and no namespace and
 * is reported as `failed`, so one broken entry cannot take the gateway down. A closed or failed
 * client is torn down here; the native transport owns process-group teardown.
 */
export async function createMcpIntegration(options: McpIntegrationOptions): Promise<McpIntegration> {
  if (!options.config.enabled) throw new Error("MCP integration requires mcp.enabled");
  const servers: McpServerConnection[] = [];
  let closed = false;
  try {
    const enabled = Object.entries(options.config.servers)
      .filter(([, config]) => mcpServerEnabled(config))
      .sort(([left], [right]) => left.localeCompare(right, "en-US"));
    const connected = await Promise.all(enabled.map(async ([name, config]) =>
      connect(
        name,
        config,
        options.workspace,
        options.dataDir,
        options.environment,
      )));
    servers.push(...connected);

    const registrations: ToolRegistration[] = [];
    const owners = new Map<string, ToolOwner>();
    const namespaces: CodemodeNamespace[] = [];
    const used = new Set<string>();
    for (const server of servers.sort((left, right) => left.name.localeCompare(right.name, "en-US"))) {
      if (!server.connected) continue;
      const config = options.config.servers[server.name]!;
      const toolNames = mcpToolNames(server.name, server.toolNames());
      for (const [serverTool, registrationName] of toolNames) {
        const tool = server.tool(serverTool);
        if (tool === undefined) continue;
        // Global uniqueness: a hashed name from one server must not shadow another's registration.
        if (used.has(registrationName)) continue;
        used.add(registrationName);
        owners.set(registrationName, { server, serverTool });
        registrations.push(createMcpToolRegistration(server, registrationName, tool));
      }
      namespaces.push(namespaceFor(server, config));
    }

    const delegated = new Set(options.delegatedToolNames);
    const extension = defineExtension({
      name: "nanobot-mcp",
      tools: registrations,
      hooks: [
        hook(ToolTask, {
          beforeTool(call, api) {
            const name = call.name;
            // Only names this extension or the coding hook delegating to it can produce.
            if (!name.startsWith(MCP_TOOL_PREFIX) && !delegated.has(name)) return undefined;
            if (!options.isAuthorizedChat(api.conversationId)) {
              return { block: `Tool ${name} is not enabled for this conversation` };
            }
            if (delegated.has(name)) return undefined;
            const owner = owners.get(name);
            if (owner === undefined) {
              return { block: `Tool ${name} is not a configured MCP tool` };
            }
            if (!owner.server.offers(owner.serverTool)) {
              return { block: `MCP server "${owner.server.name}" no longer offers ${name}` };
            }
            return undefined;
          },
        }),
      ],
    });

    return {
      extension,
      toolNames: Object.freeze(registrations.map((tool) => tool.name)),
      namespaces: Object.freeze(namespaces),
      get status() {
        return servers.map((server) => server.status);
      },
      ownsTool(name: string): boolean {
        return owners.has(name);
      },
      async close() {
        if (closed) return;
        closed = true;
        await Promise.allSettled(servers.map((server) => server.close()));
      },
    };
  } catch (error) {
    closed = true;
    await Promise.allSettled(servers.map((server) => server.close()));
    throw error;
  }
}

/** Config check used by the runtime before it starts any client. */
export function mcpHasEnabledServers(config: McpConfig | undefined): boolean {
  if (config === undefined || !config.enabled) return false;
  return isRecord(config.servers) && Object.values(config.servers).some((entry) => mcpServerEnabled(entry));
}
