import {
  McpClient,
  McpTimeoutError,
  StdioTransport,
  StreamableHttpTransport,
  type AuthProvider,
  type CallToolResult,
  type McpFetch,
  type Tool as McpTool,
} from "@earendil-works/pi-mcp";
import { McpOAuthProvider, adaptOAuthProvider } from "@earendil-works/pi-mcp/oauth";
import {
  mcpTimeoutMs,
  type McpServerConfig,
} from "./config.js";
import { FileMcpOAuthStateStore } from "./oauth-store.js";

/**
 * One configured MCP server: connect, list tools, call a tool, close.
 *
 * The native `@earendil-works/pi-mcp` client and transports own framing, initialization, request
 * correlation, cancellation and the stdio shutdown sequence (close stdin, then SIGTERM, then
 * SIGKILL to the server's whole process group). This module adds only the host policy the gateway
 * needs: a minimal child environment, a sanitized failure value, availability at call time, and no
 * retry of a tool call.
 */
export type McpServerState = "connected" | "failed" | "closed";

/** Why a configured server is unusable. Fixed text only: no transport body, stderr or header value. */
export type McpFailureCode =
  | "start-failed"
  | "start-timeout"
  | "missing-environment"
  | "auth-required"
  | "connection-closed"
  | "closed";

export interface McpServerStatus {
  readonly name: string;
  readonly state: McpServerState;
  readonly tools: number;
  readonly failure?: McpFailureCode;
}

export interface McpServerConnectionOptions {
  readonly name: string;
  readonly config: McpServerConfig;
  /** Workspace root; a stdio server's cwd was already resolved and confined to it. */
  readonly workspace: string;
  /** Host environment the configured variable names are resolved from. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /**
   * Required exactly when the entry sets `oauth: true`: where this server's grant lives, plus the
   * redirect URI presented if an authorization attempt happens on this connection. The gateway never
   * runs an authorization flow itself; an absent or unusable grant fails the connection closed.
   */
  readonly oauth?: {
    readonly storePath: string;
    readonly redirectUrl?: string;
  };
}

/** The child environment never inherits the host's: only PATH (to find the command) and configured names. */
function childEnvironment(
  config: Extract<McpServerConfig, { command: string }>,
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const child: Record<string, string> = { PATH: environment.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
  for (const [name, source] of Object.entries(config.env ?? {})) {
    const value = environment[source];
    if (value === undefined) throw new MissingEnvironmentError(source);
    child[name] = value;
  }
  return child;
}

export function headerValues(
  config: Extract<McpServerConfig, { url: string }>,
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, source] of Object.entries(config.headers ?? {})) {
    const value = environment[source];
    if (value === undefined) throw new MissingEnvironmentError(source);
    headers[name] = value;
  }
  return headers;
}

/** A configured variable the host environment does not define. Carries the name, never a value. */
export class MissingEnvironmentError extends Error {
  constructor(readonly variable: string) {
    super(`Environment variable ${variable} is not set`);
    this.name = "MissingEnvironmentError";
  }
}

/**
 * This entry uses OAuth and has no usable stored grant. The connection fails closed instead of
 * starting a browser flow: authorization is an explicit owner action, never a side effect of a
 * gateway open or a tool call. It carries no URL, state or token.
 */
export class MissingOAuthGrantError extends Error {
  constructor() {
    super("MCP server has no stored OAuth grant");
    this.name = "MissingOAuthGrantError";
  }
}

/** Refuse redirects so a configured Authorization header cannot be forwarded to another origin. */
export const guardedFetch: McpFetch = (input, init) => fetch(input, { ...init, redirect: "error" });

function classifyStart(error: unknown): McpFailureCode {
  if (error instanceof McpTimeoutError) return "start-timeout";
  // A configured variable the host environment does not define. Only the name is configured text.
  if (error instanceof MissingEnvironmentError) return "missing-environment";
  // No stored grant, or a grant the server rejected: only an owner-approved login can change that.
  if (error instanceof MissingOAuthGrantError) return "auth-required";
  if (error instanceof Error && error.name === "McpOAuthAuthorizationRequiredError") return "auth-required";
  return "start-failed";
}

export class McpServerConnection {
  readonly name: string;
  readonly oauth: McpServerConnectionOptions["oauth"];
  readonly #config: McpServerConfig;
  readonly #workspace: string;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #timeoutMs: number;
  readonly #shutdown = new AbortController();
  #client: McpClient | undefined;
  #authProvider: AuthProvider | undefined;
  /** Memoized so `close()` (and a close during `open()`) awaits the native transport teardown. */
  #closeClient: (() => Promise<void>) | undefined;
  /** The setup currently awaiting its transport, so `close()` can wait for it to finish. */
  #opening: Promise<void> | undefined;
  /** Tools the server last reported, by the server's own tool name. */
  #tools = new Map<string, McpTool>();
  #modelInstructions: string | undefined;
  #state: McpServerState = "failed";
  #failure: McpFailureCode | undefined = "start-failed";

  constructor(options: McpServerConnectionOptions) {
    this.name = options.name;
    this.oauth = options.oauth;
    this.#config = options.config;
    this.#workspace = options.workspace;
    this.#environment = options.environment ?? process.env;
    this.#timeoutMs = mcpTimeoutMs(options.config);
  }

  get status(): McpServerStatus {
    return {
      name: this.name,
      state: this.#state,
      tools: this.#tools.size,
      ...(this.#failure === undefined ? {} : { failure: this.#failure }),
    };
  }

  get connected(): boolean {
    return this.#state === "connected" && this.#client !== undefined;
  }

  /** Server instructions from initialization, trimmed and unlabeled; the integration bounds and labels them. */
  get instructions(): string | undefined {
    return this.#modelInstructions;
  }

  /** The server's own tool names, sorted. */
  toolNames(): string[] {
    return [...this.#tools.keys()].sort((left, right) => left.localeCompare(right, "en-US"));
  }

  /** One tool as the server last listed it, or undefined once it withdrew the tool. */
  tool(name: string): McpTool | undefined {
    return this.connected ? this.#tools.get(name) : undefined;
  }

  offers(tool: string): boolean {
    return this.connected && this.#tools.has(tool);
  }

  #createTransport() {
    const config = this.#config;
    if ("command" in config) {
      return new StdioTransport({
        command: config.command,
        ...(config.args === undefined ? {} : { args: config.args }),
        cwd: config.cwd ?? this.#workspace,
        env: childEnvironment(config, this.#environment),
        inheritEnv: false,
        stderr: "pipe",
      });
    }
    return new StreamableHttpTransport({
      url: config.url,
      headers: headerValues(config, this.#environment),
      ...(this.#authProvider === undefined ? {} : { authProvider: this.#authProvider }),
      fetch: guardedFetch,
    });
  }

  /**
   * Build the bearer-token provider for an `oauth: true` entry. An absent grant fails closed here,
   * before any request: the transport would otherwise start a dynamic registration and an
   * authorization redirect that nobody asked for. With a stored grant, the native provider refreshes
   * on a 401; if the server then requires a fresh authorization, `auth-required` is reported instead
   * of opening anything.
   */
  async #prepareOAuth(): Promise<void> {
    const config = this.#config;
    if (!("url" in config) || config.oauth !== true) return;
    if (this.oauth === undefined) {
      throw new MissingOAuthGrantError();
    }
    const provider = new McpOAuthProvider({
      serverUrl: config.url,
      redirectUrl: this.oauth.redirectUrl ?? "http://127.0.0.1/oauth-callback",
      clientMetadata: { client_name: "durable-nanobot" },
      store: new FileMcpOAuthStateStore(this.oauth.storePath, config.url),
      onRedirect() {
        // A connect-time authorization attempt is never interactive.
        throw new MissingOAuthGrantError();
      },
    });
    let tokens;
    try {
      tokens = await provider.tokens();
    } catch {
      // A malformed or unreadable grant is not usable; the owner re-runs the login to replace it.
      throw new MissingOAuthGrantError();
    }
    if (tokens === undefined) throw new MissingOAuthGrantError();
    this.#authProvider = adaptOAuthProvider(provider);
  }

  /**
   * Connect and list tools. A failure leaves the connection `failed` with a sanitized code and no
   * client; it never throws a transport message through, so startup diagnostics carry no values.
   *
   * A close can land at any point, including during the awaited OAuth preparation; `close()` aborts and
   * then waits for this setup, and the setup rechecks the abort after every await so it never connects a
   * client the connection already reported closed.
   */
  open(): Promise<void> {
    if (this.#shutdown.signal.aborted) {
      return Promise.reject(new Error(`MCP server "${this.name}" was closed before it started`));
    }
    if (this.#opening !== undefined) {
      return Promise.reject(new Error(`MCP server "${this.name}" is already being opened`));
    }
    let opening: Promise<void>;
    opening = this.#connect().finally(() => {
      if (this.#opening === opening) this.#opening = undefined;
    });
    this.#opening = opening;
    return opening;
  }

  async #connect(): Promise<void> {
    let client: McpClient | undefined;
    let closing: Promise<void> | undefined;
    const closeClient = (): Promise<void> => {
      closing ??= client!.close().catch(() => undefined);
      return closing;
    };
    try {
      client = new McpClient({ name: "nanobot", version: "0.0.0", requestTimeoutMs: this.#timeoutMs });
      // Register the teardown before the awaited OAuth preparation: an abort during preparation must
      // close this client (so the connection owns no orphan) and must be visible to the recheck below,
      // since an abort that already fired never runs a listener added afterwards.
      this.#closeClient = closeClient;
      this.#shutdown.signal.addEventListener("abort", () => { void closeClient(); }, { once: true });
      if (this.#shutdown.signal.aborted) throw new Error("closed before it started");
      await this.#prepareOAuth();
      // Never start a connection after close(): the abort listener above already closed this client and
      // `connect` would fail on it anyway; refusing here keeps the reported state and effect the same.
      if (this.#shutdown.signal.aborted) throw new Error("closed during setup");
      const transport = this.#createTransport();
      await client.connect(transport);
      client.onNotification("notifications/tools/list_changed", () => { void this.#refreshTools(client!); });
      // A dropped connection makes every tool of this server unreachable until the gateway reopens.
      client.onClose(() => {
        if (this.#client !== client || this.#shutdown.signal.aborted) return;
        this.#client = undefined;
        this.#tools.clear();
        this.#state = "failed";
        this.#failure = "connection-closed";
      });
      const tools = client.serverCapabilities?.tools ? await client.listTools() : [];
      if (client.connectionState !== "connected" || this.#shutdown.signal.aborted) {
        throw new Error("MCP connection closed during setup");
      }
      this.#client = client;
      this.#tools = new Map(tools.map((tool) => [tool.name, tool]));
      const instructions = client.instructions?.trim();
      this.#modelInstructions = instructions === undefined || instructions === "" ? undefined : instructions;
      this.#state = "connected";
      this.#failure = undefined;
    } catch (error) {
      this.#client = undefined;
      this.#tools = new Map();
      this.#modelInstructions = undefined;
      this.#state = this.#shutdown.signal.aborted ? "closed" : "failed";
      this.#failure = this.#state === "closed" ? "closed" : classifyStart(error);
      if (client !== undefined) await closeClient();
    }
  }

  /** A server that announced a changed tool list: withdrawn tools become unreachable from now on. */
  async #refreshTools(client: McpClient): Promise<void> {
    if (this.#client !== client || !this.connected) return;
    try {
      this.#tools = new Map((await client.listTools()).map((tool) => [tool.name, tool]));
    } catch {
      // The connection is already unusable; keep the last known set, and calls fail on their own.
    }
  }

  /**
   * Call one tool once. `signal` cancels the wait; it never causes a retry, because a dropped
   * response may mean the server already performed the call.
   */
  async callTool(tool: string, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<CallToolResult> {
    const client = this.#client;
    if (this.#state !== "connected" || client === undefined) {
      throw new Error(`MCP server "${this.name}" is not connected`);
    }
    if (!this.#tools.has(tool)) {
      throw new Error(`MCP tool "${tool}" is no longer offered by server "${this.name}"`);
    }
    return client.callTool(tool, args, {
      timeoutMs: this.#timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /**
   * Stop new calls and close the client; the native transport tears down the server's process group.
   *
   * A setup still in progress is aborted and awaited, so a caller that awaits `close()` knows nothing of
   * this connection is left running or about to connect.
   */
  async close(): Promise<void> {
    if (this.#state !== "closed") {
      this.#state = "closed";
      this.#failure = undefined;
      this.#tools.clear();
      this.#client = undefined;
      this.#authProvider = undefined;
    }
    this.#shutdown.abort();
    await this.#opening?.catch(() => undefined);
    await this.#closeClient?.();
  }
}
