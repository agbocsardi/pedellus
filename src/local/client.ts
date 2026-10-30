import { connect } from "node:net";
import type { Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import type { Context } from "@earendil-works/chord";
import type { Cursor } from "@earendil-works/pi-durable";
import type { HistoryEpisode, HistoryEpisodePage, HistoryEpisodeQuery } from "../history/episodes.js";
import type { HistoryPage, HistoryQuery } from "../history/index.js";
import type { GatewayModelList, GatewayModelSelection, GatewayModelSelectionRequest } from "../runtime.js";
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
} from "./protocol.js";

/** A server-side busy rejection keeps its native name so the terminal prints its busy text. */
class RemoteConversationBusy extends Error {
  override name = "ConversationBusy";
}

export interface LocalGatewayClient extends TerminalConversation {
  readonly sessionKey: string;
  readonly tools: readonly string[];
  readonly contextRefresh: boolean;
  readonly presets: boolean;
  /** True when the gateway has a configured media store for local attachments. */
  readonly attachments: boolean;
  listModels(context: Context): Promise<GatewayModelList>;
  selectModel(selection: GatewayModelSelectionRequest, context: Context): Promise<GatewayModelSelection>;
  selectModelPreset(name: string, context: Context): Promise<GatewayModelSelection>;
  refreshContext(context: Context): Promise<{ readonly skills: number }>;
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
  /** Store one operator-named local file in the gateway's media directory and admit its turn. */
  submitAttachment(path: string, content: string, context: Context): Promise<TerminalAttachmentSubmission>;
  /** Close this attachment only; the gateway and already admitted turns keep running. */
  close(): Promise<void>;
}

export interface ConnectLocalGatewayOptions {
  readonly socketPath: string;
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
    await client.attach(options.conversation, options.context);
  } catch (error) {
    await client.close();
    throw error;
  }
  return client;
}

class LocalGatewayConnection implements LocalGatewayClient {
  id = 0;
  sessionKey = "";
  tools: readonly string[] = [];
  contextRefresh = false;
  presets = false;
  attachments = false;
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
    this.attachments = result.attachments === true;
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
    const kind = attachment?.kind;
    const relativePath = attachment?.relativePath;
    const bytes = attachment?.bytes;
    if ((kind !== "photo" && kind !== "document")
      || typeof relativePath !== "string" || relativePath.length === 0
      || typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw new LocalGatewayError("unavailable", "local gateway sent an unexpected attachment submission");
    }
    return {
      attachment: { kind, relativePath, bytes },
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
    await this.call("reset", {}, context);
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

  async refreshContext(context: Context): Promise<{ readonly skills: number }> {
    return this.call("refreshContext", {}, context);
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
      else this.receiveSettlement(message.id, message.settlement);
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
  return new Error(body.message);
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
