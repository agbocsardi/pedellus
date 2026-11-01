import { resolve } from "node:path";
import { isPathWithin } from "../execution/policy.js";

/**
 * Explicit MCP server configuration.
 *
 * This is a separate connection authority from `toolAllowlist`. Naming a server here only allows the
 * gateway to connect it; MCP tools still reach the model only inside authenticated mapped chat
 * conversations. `enabled` is the config-level switch: absent or false installs nothing.
 *
 * Secrets are referenced by environment variable name (`env` values, `headers` values), never by
 * value, matching `credentials` and `telegram.tokenEnv`. Values are resolved from the host
 * environment at connect time and never appear in diagnostics or documentation examples.
 */
export interface McpServerBase {
  /** Keep the entry without connecting it. Default true. */
  readonly enabled?: boolean;
  /** One line describing what the server offers; used as the Code Mode namespace summary. */
  readonly description?: string;
  /** Per-request timeout in seconds. Default 60. */
  readonly timeoutSeconds?: number;
}

/** A local server launched as one executable with its own argument vector (never a shell string). */
export interface McpStdioServerConfig extends McpServerBase {
  readonly command: string;
  readonly args?: readonly string[];
  /** Working directory; absolute or relative to the workspace, and confined to it. */
  readonly cwd?: string;
  /** Child environment: variable name -> host environment variable name that supplies its value. */
  readonly env?: Readonly<Record<string, string>>;
}

/** A remote Streamable HTTP server. Legacy HTTP+SSE is not supported. */
export interface McpHttpServerConfig extends McpServerBase {
  /** `https:` URL, or `http:` on a loopback host. */
  readonly url: string;
  /** Request headers: header name -> host environment variable name that supplies its value. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Use an OAuth bearer token from this runtime's private MCP token store instead of a configured
   * `Authorization` header. The token is obtained by an owner-approved browser login; the gateway
   * only reads it, and never prints it, at connect time. `false` or absent requires a static header
   * or an unauthenticated server.
   */
  readonly oauth?: boolean;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export interface McpConfig {
  /** Config-level opt-in. False installs no MCP client, no MCP tools and no product Code Mode. */
  readonly enabled: boolean;
  readonly servers: Readonly<Record<string, McpServerConfig>>;
}

/** Bounds that keep untrusted server metadata from reaching a prompt or a schema unbounded. */
export const MCP_LIMITS = Object.freeze({
  maxDescriptionChars: 200,
  maxInstructionsChars: 2_000,
  maxToolDescriptionChars: 2_000,
  maxSchemaBytes: 16 * 1024,
  maxArgs: 128,
  argMaxChars: 8 * 1024,
  defaultTimeoutSeconds: 60,
  maxTimeoutSeconds: 600,
});

export const DEFAULT_MCP_TIMEOUT_SECONDS = MCP_LIMITS.defaultTimeoutSeconds;

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SERVER_KEYS = new Set([
  "enabled",
  "description",
  "timeoutSeconds",
  "command",
  "args",
  "cwd",
  "env",
  "url",
  "headers",
  "oauth",
]);
const REJECTED_KEYS: Readonly<Record<string, string>> = Object.freeze({
  sse: 'MCP legacy SSE is not supported; use the server\'s Streamable HTTP endpoint (often "/mcp")',
  type: 'MCP entries select stdio with "command" or Streamable HTTP with "url"; "type" is not accepted',
  auth: "MCP provider sign-in is not supported; set \"oauth\": true or supply an Authorization header through an environment variable",
  exposure: "MCP tool exposure is not configurable; MCP tools are always discovered",
  toolExposure: "MCP tool exposure is not configurable; MCP tools are always discovered",
});

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${name} must be a plain object`);
  return Object.fromEntries(Object.entries(value));
}

function nonempty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${name} must not contain control characters`);
  return value;
}

function boundedText(value: unknown, name: string, maxChars: number): string {
  const text = nonempty(value, name).trim();
  if (text.length > maxChars) throw new Error(`${name} must be at most ${maxChars} characters`);
  return text;
}

function environmentName(value: unknown, name: string): string {
  const text = nonempty(value, name);
  if (!ENVIRONMENT_NAME.test(text)) throw new Error(`${name} must name an environment variable`);
  return text;
}

function timeoutSeconds(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MCP_LIMITS.maxTimeoutSeconds) {
    throw new Error(`${name} must be an integer number of seconds from 1 to ${MCP_LIMITS.maxTimeoutSeconds}`);
  }
  return value;
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  if (value.length > MCP_LIMITS.maxArgs) throw new Error(`${name} must contain at most ${MCP_LIMITS.maxArgs} entries`);
  return value.map((entry, index) => {
    // Arguments pass verbatim to one executable; an empty argument is legitimate (`--root=`+"").
    if (typeof entry !== "string") throw new Error(`${name}[${index}] must be a string`);
    if (/[\u0000\u000a\u000d]/.test(entry)) throw new Error(`${name}[${index}] must not contain NUL or line breaks`);
    if (entry.length > MCP_LIMITS.argMaxChars) throw new Error(`${name}[${index}] is too long`);
    return entry;
  });
}

function environmentMap(value: unknown, name: string): Readonly<Record<string, string>> {
  const raw = object(value, name);
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, entry] of Object.entries(raw)) {
    if (!ENVIRONMENT_NAME.test(key)) throw new Error(`${name} key "${key}" must be an environment variable name`);
    result[key] = environmentName(entry, `${name}.${key}`);
  }
  return Object.freeze(result);
}

function headerMap(value: unknown, name: string): Readonly<Record<string, string>> {
  const raw = object(value, name);
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, entry] of Object.entries(raw)) {
    if (!HEADER_NAME.test(key)) throw new Error(`${name} key "${key}" must be an HTTP header name`);
    result[key] = environmentName(entry, `${name}.${key}`);
  }
  return Object.freeze(result);
}

function httpUrl(value: unknown, name: string): string {
  const text = nonempty(value, name);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (url.username !== "" || url.password !== "") throw new Error(`${name} must not embed credentials`);
  if (url.hash !== "") throw new Error(`${name} must not contain a fragment`);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new Error(`${name} must use https, or http on localhost, 127.0.0.1, or [::1]`);
  }
  return url.href;
}

/** Server names that differ only by `-`/`_` (or case) would produce the same tool namespace. */
function namespaceKey(name: string): string {
  return name.replace(/-/g, "_").toLocaleLowerCase("en-US");
}

function serverConfig(name: string, value: unknown, workspace: string): McpServerConfig {
  const raw = object(value, `mcp.servers.${name}`);
  for (const key of Object.keys(raw)) {
    const rejected = REJECTED_KEYS[key];
    if (rejected !== undefined) throw new Error(`mcp.servers.${name}: ${rejected}`);
    if (!SERVER_KEYS.has(key)) throw new Error(`mcp.servers.${name} has an unsupported field: ${key}`);
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw new Error(`mcp.servers.${name}.enabled must be a boolean`);
  }
  const base = {
    ...(raw.enabled === undefined ? {} : { enabled: raw.enabled }),
    ...(raw.description === undefined
      ? {}
      : { description: boundedText(raw.description, `mcp.servers.${name}.description`, MCP_LIMITS.maxDescriptionChars) }),
    ...(raw.timeoutSeconds === undefined
      ? {}
      : { timeoutSeconds: timeoutSeconds(raw.timeoutSeconds, `mcp.servers.${name}.timeoutSeconds`) }),
  };
  const hasCommand = raw.command !== undefined;
  const hasUrl = raw.url !== undefined;
  if (hasCommand === hasUrl) {
    throw new Error(`mcp.servers.${name} must set exactly one of "command" (stdio) or "url" (Streamable HTTP)`);
  }
  if (hasCommand) {
    for (const key of ["url", "headers", "oauth"]) {
      if (raw[key] !== undefined) {
        throw new Error(`mcp.servers.${name}.${key} belongs to a Streamable HTTP server`);
      }
    }
    let cwd: string | undefined;
    if (raw.cwd !== undefined) {
      const requested = nonempty(raw.cwd, `mcp.servers.${name}.cwd`);
      const resolved = resolve(workspace, requested);
      if (!isPathWithin(workspace, resolved)) {
        throw new Error(`mcp.servers.${name}.cwd must stay inside the workspace`);
      }
      cwd = resolved;
    }
    return Object.freeze({
      ...base,
      command: nonempty(raw.command, `mcp.servers.${name}.command`),
      ...(raw.args === undefined ? {} : { args: Object.freeze(stringList(raw.args, `mcp.servers.${name}.args`)) }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(raw.env === undefined ? {} : { env: environmentMap(raw.env, `mcp.servers.${name}.env`) }),
    });
  }
  for (const key of ["command", "args", "cwd", "env"]) {
    if (raw[key] !== undefined) throw new Error(`mcp.servers.${name}.${key} belongs to a stdio server`);
  }
  const url = httpUrl(raw.url, `mcp.servers.${name}.url`);
  if (raw.oauth !== undefined && typeof raw.oauth !== "boolean") {
    throw new Error(`mcp.servers.${name}.oauth must be a boolean`);
  }
  const headers = raw.headers === undefined
    ? undefined
    : headerMap(raw.headers, `mcp.servers.${name}.headers`);
  const oauth = raw.oauth === true;
  if (oauth && headers !== undefined
    && Object.keys(headers).some((header) => header.toLowerCase() === "authorization")) {
    throw new Error(
      `mcp.servers.${name} selects one HTTP credential: remove the Authorization header when "oauth" is true`,
    );
  }
  return Object.freeze({
    ...base,
    url,
    ...(headers === undefined ? {} : { headers }),
    ...(oauth ? { oauth: true } : {}),
  });
}

/** Validate the `mcp` config block; `workspace` resolves and confines a stdio server's working directory. */
export function parseMcpConfig(value: unknown, workspace: string): McpConfig {
  const raw = object(value, "mcp");
  for (const key of Object.keys(raw)) {
    if (key !== "enabled" && key !== "servers") throw new Error(`mcp has an unsupported field: ${key}`);
  }
  if (typeof raw.enabled !== "boolean") throw new Error("mcp.enabled must be a boolean");
  if (!raw.enabled) return Object.freeze({ enabled: false, servers: Object.freeze({}) });
  const rawServers = raw.servers === undefined ? {} : object(raw.servers, "mcp.servers");
  const servers: Record<string, McpServerConfig> = Object.create(null) as Record<string, McpServerConfig>;
  const namespaces = new Map<string, string>();
  for (const [name, entry] of Object.entries(rawServers)) {
    if (!SERVER_NAME.test(name)) {
      throw new Error("mcp.servers names may contain only letters, digits, _ and -");
    }
    const key = namespaceKey(name);
    const existing = namespaces.get(key);
    if (existing !== undefined) {
      throw new Error(`mcp.servers names "${existing}" and "${name}" would share one tool namespace`);
    }
    namespaces.set(key, name);
    servers[name] = serverConfig(name, entry, workspace);
  }
  return Object.freeze({ enabled: true, servers: Object.freeze(servers) });
}

/** Whether a server entry connects at startup. */
export function mcpServerEnabled(config: McpServerConfig): boolean {
  return config.enabled !== false;
}

/** Effective per-request timeout in milliseconds. */
export function mcpTimeoutMs(config: McpServerConfig): number {
  return (config.timeoutSeconds ?? DEFAULT_MCP_TIMEOUT_SECONDS) * 1_000;
}
