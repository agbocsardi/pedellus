import { connect } from "node:net";
import type { Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import type { Context } from "@earendil-works/chord";
import type { Cursor } from "@earendil-works/pi-durable";
import type { HistoryEpisode, HistoryEpisodePage, HistoryEpisodeQuery } from "../history/episodes.js";
import type { HistoryPage, HistoryQuery } from "../history/index.js";
import type { MemoryDigestStartResult, MemoryDigestStatusView } from "../history/memory-digest.js";
import type { GatewayModelList, GatewayModelSelection, GatewayModelSelectionRequest } from "../runtime.js";
import type { ModelReloadResult } from "../model-reload.js";
import type { McpAdminListing, McpCallbackResult } from "../mcp/index.js";
import type { McpAuthorizationLink } from "../mcp/surface.js";
import { validAskQuestionView, type AskQuestionView } from "../questions/index.js";
import type {
  CronOperatorCancelOutcome,
  CronOperatorCreateOutcome,
  CronOperatorJob,
  CronOperatorListing,
} from "../automation/operator.js";
import type { CronScheduleInput } from "../automation/cron.js";
import type { AppDeviceListing, AppPairingCreated, AppPairingRefusal } from "../channels/app.js";
import type {
  TerminalAttachmentSubmission,
  TerminalConversation,
  TerminalEntryPage,
  TerminalEntryQuery,
  TerminalInput,
  TerminalSettlement,
  TerminalSnapshot,
  TerminalStatus,
  TerminalSubmission,
  TerminalWatch,
} from "../terminal/conversation.js";
import {
  LOCAL_PROTOCOL_LIMITS,
  LOCAL_PROTOCOL_VERSION,
  LocalGatewayError,
  asObject,
  parseServerLine,
  type LocalErrorBody,
  type LocalErrorCode,
} from "./protocol.js";

/** A server-side busy rejection keeps its native name so the terminal prints its busy text. */
class RemoteConversationBusy extends Error {
  override name = "ConversationBusy";
}

/**
 * A refusal the gateway itself sent, as opposed to a transport that stopped answering. The code
 * distinguishes a request the host rejected (`invalid`, `unavailable`) from work that merely failed
 * (`failed`), so an operator command can report a definitive refusal separately from an unknown
 * outcome after a lost response.
 */
export class LocalRemoteError extends Error {
  override name = "LocalRemoteError";
  constructor(readonly code: LocalErrorCode, message: string) {
    super(message);
  }
}

export interface LocalHostNotice {
  readonly id: string;
  readonly text: string;
}

/** Owner pairing outcome: one created code, or one fixed refusal reason. */
export type AppPairingResult = AppPairingCreated | { readonly refused: AppPairingRefusal };
/** One paired device row as the terminal prints it. */
export type AppDeviceRow = AppDeviceListing;

export interface LocalGatewayClient extends TerminalConversation {
  readonly sessionKey: string;
  readonly tools: readonly string[];
  readonly contextRefresh: boolean;
  readonly presets: boolean;
  /** True only when the gateway host supplied a configuration-file loader for /reload. */
  readonly reloadSupported: boolean;
  /** True when the gateway has a configured media store for local attachments. */
  readonly attachments: boolean;
  /** True when this host exposes the manual memory-digestion entry and status. */
  readonly digest: boolean;
  /** True when this gateway loaded a configuration file and exposes owner MCP management. */
  readonly mcp: boolean;
  /** True only when the owner host supports whole-gateway process replacement. */
  readonly restartSupported: boolean;
  restart(context: Context): Promise<void>;
  listModels(context: Context): Promise<GatewayModelList>;
  selectModel(selection: GatewayModelSelectionRequest, context: Context): Promise<GatewayModelSelection>;
  selectModelPreset(name: string, context: Context): Promise<GatewayModelSelection>;
  /** Explicit host-only foreground model/credential reload; requires `reloadSupported`. */
  reloadModels(context: Context): Promise<ModelReloadResult>;
  refreshContext(context: Context): Promise<{ readonly skills: number }>;
  /** Start one bounded digestion batch for this attachment's conversation. */
  digestStart(context: Context): Promise<MemoryDigestStartResult>;
  /** Bounded read-only digest status: no scan, no model call, no cursor change. */
  digestStatus(context: Context): Promise<MemoryDigestStatusView>;
  /** MCP status and callback ingress over the already-authenticated attach. */
  mcpList(context: Context): Promise<McpAdminListing>;
  mcpSubmitCallback(text: string, context: Context): Promise<McpCallbackResult>;
  /** Pending host notices carried by the last attach; print them, then call `ackNotices`. */
  readonly pendingNotices: readonly LocalHostNotice[];
  /** Mark printed host notices delivered; a failed call leaves them pending for the next attach. */
  ackNotices(ids: readonly string[], context: Context): Promise<void>;
  /** Questions still open in this exact conversation; reprinted once on attach. */
  readonly askQuestions: readonly AskQuestionView[];
  /** Direct, transient owner delivery from the gateway for a question it just admitted. */
  onAskQuestion?: ((question: AskQuestionView) => void) | undefined;
  /** Direct, transient owner delivery from the gateway; never a transcript or durable outbox entry. */
  onMcpAuthorization?: ((authorization: McpAuthorizationLink) => void) | undefined;
  onMcpNotice?: ((text: string) => void) | undefined;
  /** Owner controls for scheduled work: store-wide reads and exact-ID create/cancel. */
  cronList(context: Context, offset?: number): Promise<CronOperatorListing>;
  cronShow(id: string, context: Context): Promise<CronOperatorJob[]>;
  cronCreate(origin: string, request: CronScheduleInput, context: Context): Promise<CronOperatorCreateOutcome>;
  cronCancel(id: string, context: Context): Promise<CronOperatorCancelOutcome>;
  /** Owner controls for the app channel: pairing, device listing and exact-label revocation. */
  appPair(label: string | undefined, context: Context): Promise<AppPairingResult>;
  appDevices(context: Context): Promise<readonly AppDeviceRow[]>;
  appRevoke(label: string, context: Context): Promise<"revoked" | "missing">;
  historySearch(query: HistoryQuery, context: Context): Promise<HistoryPage>;
  listEpisodes(sessionKey: string, query: HistoryEpisodeQuery, context: Context): Promise<HistoryEpisodePage>;
  episode(sessionKey: string, startEntryId: number, context: Context): Promise<HistoryEpisode | undefined>;
  historyEntries(
    sessionKey: string,
    query: TerminalEntryQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<TerminalEntryPage>;
  /** Store one operator-named local file in the gateway's CLI attachment directory and admit its path-only turn. */
  submitAttachment(path: string, content: string, context: Context): Promise<TerminalAttachmentSubmission>;
  /** Close this attachment only; the gateway and already admitted turns keep running. */
  close(): Promise<void>;
}

export interface ConnectLocalGatewayOptions {
  readonly socketPath: string;
  /** Connect for store-wide operator calls without creating or configuring a chat. */
  readonly operatorOnly?: boolean;
  /** CLI conversation name; absent is the historical `default` (`cli:default`). */
  readonly conversation?: string;
  readonly context: Context;
}

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly detach: () => void;
}

interface SettlementWaiter {
  readonly resolve: (settlement: TerminalSettlement) => void;
  readonly reject: (error: Error) => void;
  readonly detach: () => void;
}

/** Attach one terminal surface to an already running gateway over its private socket. */
export async function connectLocalGateway(options: ConnectLocalGatewayOptions): Promise<LocalGatewayClient> {
  const socket = connect({ path: options.socketPath });
  await new Promise<void>((resolveConnect, rejectConnect) => {
    const timer = setTimeout(() => {
      socket.destroy();
      rejectConnect(new LocalGatewayError("unavailable", "the local gateway did not answer in time"));
    }, 5_000);
    timer.unref();
    socket.once("connect", () => {
      clearTimeout(timer);
      resolveConnect();
    });
    socket.once("error", () => {
      clearTimeout(timer);
      rejectConnect(new LocalGatewayError("unavailable", "no running gateway answers on the configured local endpoint"));
    });
  });
  socket.setNoDelay(true);
  const client = new LocalGatewayConnection(socket);
  try {
    if (!options.operatorOnly) await client.attach(options.conversation, options.context);
  } catch (error) {
    await client.close();
    throw error;
  }
  return client;
}

class LocalGatewayConnection implements LocalGatewayClient {
  id = 0;
  sessionKey = "";
  onMcpAuthorization: ((authorization: McpAuthorizationLink) => void) | undefined;
  onMcpNotice: ((text: string) => void) | undefined;
  onAskQuestion: ((question: AskQuestionView) => void) | undefined;
  askQuestions: readonly AskQuestionView[] = [];
  pendingNotices: LocalHostNotice[] = [];
  tools: readonly string[] = [];
  contextRefresh = false;
  presets = false;
  reloadSupported = false;
  attachments = false;
  digest = false;
  mcp = false;
  restartSupported = false;
  private readonly socket: Socket;
  private nextId = 0;
  private readonly pending = new Map<number, PendingCall>();
  private readonly settlementWaiters = new Map<number, SettlementWaiter>();
  private readonly settled = new Map<number, TerminalSettlement>();
  private settledOrder: number[] = [];
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private closed = false;
  private listener: ((snapshot: TerminalSnapshot) => Promise<void>) | undefined;
  private snapshotQueue: TerminalSnapshot[] = [];
  private delivering = false;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", () => this.fail(new Error("local gateway connection failed")));
    socket.on("close", () => this.fail(new Error("local gateway connection closed")));
  }

  async attach(conversation: string | undefined, context: Context): Promise<void> {
    const result = await this.call<Record<string, unknown>>("attach", conversation === undefined ? {} : { conversation }, context);
    const protocol = result.protocol;
    if (protocol !== LOCAL_PROTOCOL_VERSION) throw new LocalGatewayError("unavailable", "local gateway protocol mismatch");
    if (typeof result.sessionKey !== "string" || result.sessionKey.length === 0
      || !Number.isSafeInteger(result.conversationId)) {
      throw new LocalGatewayError("unavailable", "local gateway sent an unexpected attach result");
    }
    const tools = result.tools;
    if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string")) {
      throw new LocalGatewayError("unavailable", "local gateway sent an unexpected attach result");
    }
    this.id = result.conversationId as number;
    this.sessionKey = result.sessionKey;
    this.tools = tools as string[];
    this.contextRefresh = result.contextRefresh === true;
    this.presets = result.presets === true;
    this.reloadSupported = result.reload === true;
    this.attachments = result.attachments === true;
    this.digest = result.digest === true;
    this.mcp = result.mcp === true;
    this.restartSupported = result.restart === true;
    const questions = result.questions;
    if (questions !== undefined) {
      if (!Array.isArray(questions) || questions.some((entry) => !validAskQuestionView(entry))) {
        throw new LocalGatewayError("unavailable", "local gateway sent an unexpected attach result");
      }
      this.askQuestions = questions as AskQuestionView[];
    } else {
      this.askQuestions = [];
    }
    const notices = result.notices;
    if (notices === undefined) {
      this.pendingNotices = [];
    } else {
      if (!Array.isArray(notices) || notices.length > LOCAL_PROTOCOL_LIMITS.maxNoticeIds) {
        throw new LocalGatewayError("unavailable", "local gateway sent an unexpected attach result");
      }
      this.pendingNotices = notices.map((entry) => {
        const notice = asObject(entry);
        if (notice === undefined || typeof notice.id !== "string" || notice.id.length === 0
          || typeof notice.text !== "string" || notice.text.trim() === ""
          || notice.text.length > LOCAL_PROTOCOL_LIMITS.maxNoticeTextChars) {
          throw new LocalGatewayError("unavailable", "local gateway sent an unexpected attach result");
        }
        return { id: notice.id, text: notice.text };
      });
    }
  }

  async ackNotices(ids: readonly string[], context: Context): Promise<void> {
    if (ids.length === 0) return;
    await this.call("ackNotices", { ids: [...ids] }, context);
  }

  async watch(context: Context): Promise<TerminalWatch> {
    await this.call("watch", {}, context);
    return {
      start: (listener) => {
        this.listener = listener;
        this.pumpSnapshots();
      },
      stop: async () => {
        this.listener = undefined;
        this.snapshotQueue = [];
      },
    };
  }

  async submit(content: TerminalInput, context: Context): Promise<TerminalSubmission> {
    // Attachment content is composed and stored by the gateway, never sent inline by the terminal.
    if (typeof content !== "string") {
      throw new Error("local attachments must be submitted through the gateway attachment request");
    }
    const result = await this.call<{ readonly id: number }>("submit", { content }, context);
    if (!Number.isSafeInteger(result.id)) throw new LocalGatewayError("unavailable", "local gateway sent an unexpected submission");
    const id = result.id;
    return {
      id,
      wait: (waitContext) => this.waitSettlement(id, waitContext),
      status: (statusContext) => this.call("submissionStatus", { id }, statusContext),
    };
  }

  async submitAttachment(path: string, content: string, context: Context): Promise<TerminalAttachmentSubmission> {
    if (!this.attachments) throw new Error("local attachments are not configured");
    const result = await this.call<Record<string, unknown>>(
      "submitAttachment",
      content === "" ? { path } : { path, content },
      context,
    );
    const id = result.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
      throw new LocalGatewayError("unavailable", "local gateway sent an unexpected attachment submission");
    }
    const attachment = asObject(result.attachment);
    const relativePath = attachment?.relativePath;
    const bytes = attachment?.bytes;
    if (typeof relativePath !== "string" || relativePath.length === 0
      || typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw new LocalGatewayError("unavailable", "local gateway sent an unexpected attachment submission");
    }
    return {
      attachment: { relativePath, bytes },
      submission: {
        id,
        wait: (waitContext) => this.waitSettlement(id, waitContext),
        status: (statusContext) => this.call("submissionStatus", { id }, statusContext),
      },
    };
  }

  answer(entryId: number, context: Context): Promise<{ readonly text: string; readonly stopReason?: string }> {
    return this.call("answer", { entryId }, context);
  }

  status(context: Context): Promise<TerminalStatus> {
    return this.call("status", {}, context);
  }

  entries(
    query: TerminalEntryQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<TerminalEntryPage> {
    return this.call("entries", { query, limit, ...(cursor === undefined ? {} : { cursor }) }, context);
  }

  async compact(context: Context): Promise<number> {
    const result = await this.call<{ readonly taskId: number }>("compact", {}, context);
    if (!Number.isSafeInteger(result.taskId)) throw new LocalGatewayError("unavailable", "local gateway sent an unexpected compaction result");
    return result.taskId;
  }

  async abort(context: Context): Promise<void> {
    await this.call("abort", {}, context);
  }

  async reset(context: Context): Promise<void> {
    const result = await this.call<{ readonly status: string }>("reset", {}, context);
    if (result.status === "busy") throw new RemoteConversationBusy("conversation is busy");
  }

  async restart(context: Context): Promise<void> {
    if (!this.restartSupported) throw new Error("gateway restart is unavailable");
    await this.call("restart", {}, context);
  }

  async listModels(context: Context): Promise<GatewayModelList> {
    return this.call("listModels", {}, context);
  }

  async selectModel(selection: GatewayModelSelectionRequest, context: Context): Promise<GatewayModelSelection> {
    return this.call("selectModel", { selection }, context);
  }

  async selectModelPreset(name: string, context: Context): Promise<GatewayModelSelection> {
    return this.call("selectModelPreset", { name }, context);
  }

  async reloadModels(context: Context): Promise<ModelReloadResult> {
    if (!this.reloadSupported) throw new Error("live model reload is unavailable");
    return this.call("reloadModels", {}, context);
  }

  async refreshContext(context: Context): Promise<{ readonly skills: number }> {
    return this.call("refreshContext", {}, context);
  }

  async digestStart(context: Context): Promise<MemoryDigestStartResult> {
    return this.call("digestStart", {}, context);
  }

  async digestStatus(context: Context): Promise<MemoryDigestStatusView> {
    return this.call("digestStatus", {}, context);
  }

  async mcpList(context: Context): Promise<McpAdminListing> {
    const result = await this.call<{ readonly listing: McpAdminListing }>("mcpList", {}, context);
    return result.listing;
  }

  async mcpSubmitCallback(text: string, context: Context): Promise<McpCallbackResult> {
    return this.call("mcpCallback", { text }, context);
  }

  async cronList(context: Context, offset = 0): Promise<CronOperatorListing> {
    const result = await this.call<CronOperatorListing>("cronList", { offset }, context);
    if (!Array.isArray(result.jobs) || !Array.isArray(result.origins)) {
      throw new LocalGatewayError("unavailable", "local gateway sent an unexpected job listing");
    }
    return result;
  }

  async cronShow(id: string, context: Context): Promise<CronOperatorJob[]> {
    const result = await this.call<{ readonly jobs: CronOperatorJob[] }>("cronShow", { id }, context);
    if (!Array.isArray(result.jobs)) throw new LocalGatewayError("unavailable", "local gateway sent an unexpected job listing");
    return result.jobs;
  }

  cronCreate(origin: string, request: CronScheduleInput, context: Context): Promise<CronOperatorCreateOutcome> {
    return this.call("cronCreate", { origin, request }, context);
  }

  cronCancel(id: string, context: Context): Promise<CronOperatorCancelOutcome> {
    return this.call("cronCancel", { id }, context);
  }

  async appPair(label: string | undefined, context: Context): Promise<AppPairingResult> {
    const result = await this.call<Record<string, unknown>>("appPair",
      label === undefined ? {} : { label }, context);
    if (typeof result.refused === "string") {
      if (result.refused !== "label-in-use" && result.refused !== "device-limit" &&
          result.refused !== "pairing-limit" && result.refused !== "invalid-label") {
        throw new LocalGatewayError("unavailable", "local gateway sent an unexpected pairing result");
      }
      return { refused: result.refused };
    }
    if (typeof result.code !== "string" || typeof result.expiresAtMs !== "number") {
      throw new LocalGatewayError("unavailable", "local gateway sent an unexpected pairing result");
    }
    return { code: result.code, expiresAtMs: result.expiresAtMs };
  }

  async appDevices(context: Context): Promise<readonly AppDeviceRow[]> {
    const result = await this.call<{ readonly devices?: unknown }>("appDevices", {}, context);
    if (!Array.isArray(result.devices) || result.devices.some((entry) =>
      entry === null || typeof entry !== "object" || typeof (entry as Record<string, unknown>).label !== "string" ||
      typeof (entry as Record<string, unknown>).createdAtMs !== "number")) {
      throw new LocalGatewayError("unavailable", "local gateway sent an unexpected device listing");
    }
    return result.devices as AppDeviceRow[];
  }

  async appRevoke(label: string, context: Context): Promise<"revoked" | "missing"> {
    const result = await this.call<{ readonly result?: unknown }>("appRevoke", { label }, context);
    if (result.result !== "revoked" && result.result !== "missing") {
      throw new LocalGatewayError("unavailable", "local gateway sent an unexpected revoke result");
    }
    return result.result;
  }

  async historySearch(query: HistoryQuery, context: Context): Promise<HistoryPage> {
    return this.call("historySearch", { query }, context);
  }

  async listEpisodes(sessionKey: string, query: HistoryEpisodeQuery, context: Context): Promise<HistoryEpisodePage> {
    return this.call("historyEpisodes", { session: sessionKey, query }, context);
  }

  async episode(sessionKey: string, startEntryId: number, context: Context): Promise<HistoryEpisode | undefined> {
    return this.call("historyEpisode", { session: sessionKey, startEntryId }, context);
  }

  async historyEntries(
    sessionKey: string,
    query: TerminalEntryQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<TerminalEntryPage> {
    return this.call("historyEntries", {
      session: sessionKey,
      query,
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    }, context);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.listener = undefined;
    this.snapshotQueue = [];
    const ended = new Promise<void>((resolveEnded) => {
      if (this.socket.destroyed) {
        resolveEnded();
        return;
      }
      this.socket.once("close", () => resolveEnded());
    });
    this.socket.end();
    this.socket.destroy();
    await ended;
    this.fail(new Error("local gateway connection closed"));
  }

  private call<T>(method: string, params: unknown, context: Context): Promise<T> {
    if (this.closed) return Promise.reject(new Error("local gateway connection is closed"));
    if (this.pending.size >= LOCAL_PROTOCOL_LIMITS.maxPendingRequests) {
      return Promise.reject(new Error("local gateway request limit reached"));
    }
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const signal = context.abortSignal;
      const onAbort = (): void => {
        this.pending.delete(id);
        reject(signal?.reason instanceof Error ? signal.reason : new Error("local gateway request cancelled"));
      };
      const detach = (): void => { signal?.removeEventListener("abort", onAbort); };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          detach();
          resolve(value as T);
        },
        reject: (error) => {
          detach();
          reject(error);
        },
        detach,
      });
      try {
        this.socket.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch {
        this.pending.delete(id);
        detach();
        reject(new Error("local gateway connection is closed"));
      }
    });
  }

  private waitSettlement(id: number, context: Context): Promise<TerminalSettlement> {
    const cached = this.settled.get(id);
    if (cached !== undefined) {
      this.settled.delete(id);
      return Promise.resolve(cached);
    }
    return new Promise<TerminalSettlement>((resolve, reject) => {
      const signal = context.abortSignal;
      const onAbort = (): void => {
        this.settlementWaiters.delete(id);
        reject(signal?.reason instanceof Error ? signal.reason : new Error("local turn observation cancelled"));
      };
      const detach = (): void => { signal?.removeEventListener("abort", onAbort); };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.settlementWaiters.set(id, {
        resolve: (settlement) => {
          detach();
          resolve(settlement);
        },
        reject: (error) => {
          detach();
          reject(error);
        },
        detach,
      });
    });
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer, "utf8") > LOCAL_PROTOCOL_LIMITS.maxResponseLineBytes) {
      this.fail(new Error("local gateway response exceeded the transport bound"));
      this.socket.destroy();
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim().length > 0) this.route(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private route(line: string): void {
    let message;
    try {
      message = parseServerLine(line);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("local gateway sent an unexpected message"));
      this.socket.destroy();
      return;
    }
    if ("event" in message) {
      if (message.event === "snapshot") this.queueSnapshot(message.snapshot);
      else if (message.event === "settled") this.receiveSettlement(message.id, message.settlement);
      else if (message.event === "askQuestion") {
        if (validAskQuestionView(message.question)) this.onAskQuestion?.(message.question);
      } else if (message.event === "mcpAuthorization") {
        const authorization = asObject(message.authorization);
        if (authorization !== undefined
          && typeof authorization.requestId === "string"
          && typeof authorization.name === "string"
          && typeof authorization.url === "string"
          && typeof authorization.expiresAtMs === "number") {
          this.onMcpAuthorization?.(authorization as unknown as McpAuthorizationLink);
        }
      } else if (message.event === "mcpNotice") {
        this.onMcpNotice?.(message.text);
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    if ("error" in message) pending.reject(remoteError(message.error));
    else pending.resolve(message.result);
  }

  private queueSnapshot(value: unknown): void {
    const snapshot = asObject(value);
    if (snapshot === undefined) return;
    if (this.listener === undefined) {
      if (this.snapshotQueue.length >= LOCAL_PROTOCOL_LIMITS.maxPendingSnapshots) this.snapshotQueue.shift();
      this.snapshotQueue.push(snapshot as unknown as TerminalSnapshot);
      return;
    }
    if (this.snapshotQueue.length >= LOCAL_PROTOCOL_LIMITS.maxPendingSnapshots) this.snapshotQueue.shift();
    this.snapshotQueue.push(snapshot as unknown as TerminalSnapshot);
    this.pumpSnapshots();
  }

  /** Deliver snapshots strictly in order, awaiting each terminal render. */
  private pumpSnapshots(): void {
    if (this.delivering) return;
    this.delivering = true;
    void (async () => {
      try {
        while (!this.closed) {
          const listener = this.listener;
          const snapshot = this.snapshotQueue.shift();
          if (listener === undefined || snapshot === undefined) return;
          await listener(snapshot);
        }
      } catch {
        // A terminal render failure is reported through the terminal's own output path.
      } finally {
        this.delivering = false;
        if (!this.closed && this.listener !== undefined && this.snapshotQueue.length > 0) this.pumpSnapshots();
      }
    })();
  }

  private receiveSettlement(id: number, value: unknown): void {
    const settlement = asSettlement(value);
    if (settlement === undefined) return;
    const waiter = this.settlementWaiters.get(id);
    if (waiter === undefined) {
      this.settled.set(id, settlement);
      this.settledOrder.push(id);
      while (this.settledOrder.length > 256) {
        const oldest = this.settledOrder.shift();
        if (oldest !== undefined) this.settled.delete(oldest);
      }
      return;
    }
    this.settlementWaiters.delete(id);
    waiter.resolve(settlement);
  }

  private fail(error: Error): void {
    if (this.closed && this.pending.size === 0 && this.settlementWaiters.size === 0) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const waiter of this.settlementWaiters.values()) waiter.reject(error);
    this.settlementWaiters.clear();
    this.listener = undefined;
    this.snapshotQueue = [];
  }
}

function remoteError(body: LocalErrorBody): Error {
  if (body.code === "busy") return new RemoteConversationBusy(body.message);
  return new LocalRemoteError(body.code, body.message);
}

function asSettlement(value: unknown): TerminalSettlement | undefined {
  const record = asObject(value);
  if (record === undefined) return undefined;
  if (record.status !== "done" && record.status !== "unanswered") return undefined;
  if (record.type !== "input" && record.type !== "write") return undefined;
  return {
    status: record.status,
    type: record.type,
    ...(typeof record.answer === "number" && Number.isSafeInteger(record.answer) ? { answer: record.answer } : {}),
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
  };
}
