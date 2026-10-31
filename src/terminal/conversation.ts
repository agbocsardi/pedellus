import type { Context } from "@earendil-works/chord";
import { AssistantEntry } from "@earendil-works/pi-durable";
import type {
  Conversation,
  ConversationView,
  Cursor,
  EntryId,
  EntryRecord,
  LiveState,
  SettledSubmissionRecord,
  UsageState,
} from "@earendil-works/pi-durable";
import type { AssistantMessage, ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { BackgroundStatus } from "../background-status.js";

/** Plain typed input, or the text/image parts of a stored attachment submission. */
export type TerminalInput = string | (TextContent | ImageContent)[];

/**
 * The terminal's narrow conversation boundary.
 *
 * A terminal is a conversation surface, not a runtime owner. Both an in-process
 * conversation and the local gateway client implement this surface, so the UI code
 * never receives a raw Harness, conversation ID or full Durable handle it could use
 * to reach another conversation, fork or task.
 */
export interface TerminalConversation {
  /** Identity of the one conversation this surface is attached to. */
  readonly id: number;
  /** Observe committed conversation revisions until stopped or the context fails. */
  watch(context: Context): Promise<TerminalWatch>;
  /** Durably admit one ordinary user input (text, or attachment content built by the host). */
  submit(content: TerminalInput, context: Context): Promise<TerminalSubmission>;
  /** Read one committed assistant entry of this conversation, by entry ID. */
  answer(entryId: number, context: Context): Promise<TerminalAnswerText>;
  /** Point-in-time status of this conversation, already bounded for presentation. */
  status(context: Context): Promise<TerminalStatus>;
  /** One bounded page of raw stored entries of this conversation. */
  entries(
    query: TerminalEntryQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<TerminalEntryPage>;
  /** Admit native manual compaction; resolves with its task ID. */
  compact(context: Context): Promise<number>;
  /** Native Durable abort: withdraw queued inputs and stop foreground work. */
  abort(context: Context): Promise<void>;
  /** Native Durable reset: a new context in this same conversation. */
  reset(context: Context): Promise<void>;
}

export interface TerminalWatch {
  /** Install the sole snapshot listener. Frames before installation are not replayed. */
  start(listener: (snapshot: TerminalSnapshot) => Promise<void>): void;
  /** Idempotently stop delivery and release the underlying watch. */
  stop(): Promise<void>;
}

export interface TerminalSubmission {
  readonly id: number;
  wait(context: Context): Promise<TerminalSettlement>;
  status(context: Context): Promise<{ readonly status: string }>;
}

export interface TerminalSettlement {
  readonly status: "done" | "unanswered";
  readonly type: "input" | "write";
  readonly answer?: number;
  readonly reason?: string;
}

/** One stored local attachment, as the host reports it back to the terminal. */
export interface TerminalAttachment {
  /** Workspace-relative stored locator; never the operator's absolute path. */
  readonly relativePath: string;
  readonly bytes: number;
}

/** An attachment turn already admitted by the host, with its stored-file summary. */
export interface TerminalAttachmentSubmission {
  readonly submission: TerminalSubmission;
  readonly attachment: TerminalAttachment;
}

export interface TerminalAnswerText {
  readonly text: string;
  readonly stopReason?: string;
}

export interface TerminalEntryQuery {
  readonly minEntryId?: EntryId;
  readonly maxEntryId?: EntryId;
  readonly order?: "ascending" | "descending";
}

export interface TerminalToolCall {
  readonly name: string;
  readonly argumentsText?: string;
}

/** One stored model message projected to display-safe, bounded fields. */
export interface TerminalMessage {
  readonly role: "user" | "assistant" | "toolResult";
  readonly text: string;
  readonly stopReason?: string;
  readonly toolName?: string;
  readonly toolCalls?: readonly TerminalToolCall[];
}

export interface TerminalEntry {
  readonly id: number;
  readonly kind: string;
  readonly byTaskId?: number;
  /** True when this entry carries context edits; the terminal shows it as raw stored text. */
  readonly edited?: boolean;
  readonly messages: readonly TerminalMessage[];
}

export interface TerminalEntryPage {
  readonly conversationId: number;
  readonly items: readonly TerminalEntry[];
  readonly next?: Cursor;
}

export interface TerminalAnswer {
  readonly taskId: number;
  readonly entryId: number;
  readonly text: string;
  readonly stopReason?: string;
}

export interface TerminalSnapshot {
  readonly run?: {
    readonly taskId: number;
    readonly inputs: readonly number[];
    readonly generation?: { readonly attempt: number; readonly text: string };
  };
  /** Newest committed assistant answer per generation task, bounded for transport. */
  readonly answers: readonly TerminalAnswer[];
}

export interface TerminalStatus {
  readonly model?: { readonly provider: string; readonly modelId: string };
  readonly run?: { readonly taskId: number; readonly inputs: number; readonly attempt?: number };
  readonly inbox: {
    readonly total: number;
    readonly steer: number;
    readonly followUp: number;
    readonly write: number;
    readonly scanned: number;
  };
  readonly tools: {
    readonly total: number;
    readonly running: number;
    readonly pending: number;
    readonly scanned: number;
  };
  readonly compactions: number;
  readonly usage?: UsageState;
  /**
   * Host-read, bounded background activity for this conversation. Absent leaves the core status
   * unchanged: an older host adds no field and a failing read omits it rather than claiming idle.
   */
  readonly background?: BackgroundStatus;
}

/** Bounds shared by every projection, so a local transport carries bounded frames. */
const TERMINAL_SURFACE_LIMITS = Object.freeze({
  /** Same bound as the terminal's displayed response. */
  generationTextChars: 64_001,
  entryTextChars: 4_000,
  toolArgumentChars: 400,
  toolCallsPerMessage: 32,
  messagesPerEntry: 8,
  snapshotEntryScan: 500,
  snapshotAnswers: 8,
  snapshotAnswerChars: 128_000,
  statusQueueScan: 2_000,
});

/** Project a committed conversation revision to the fields a terminal renders. */
function projectSnapshot(view: ConversationView): TerminalSnapshot {
  const live = view.docs["pi.live"] as unknown as LiveState | undefined;
  const run = live?.run;
  const generation = live?.generation;
  const answers: TerminalAnswer[] = [];
  const answeredTasks = new Set<number>();
  let answerChars = 0;
  const entries = view.entries;
  const scanFrom = Math.max(0, entries.length - TERMINAL_SURFACE_LIMITS.snapshotEntryScan);
  for (let index = entries.length - 1; index >= scanFrom && answers.length < TERMINAL_SURFACE_LIMITS.snapshotAnswers; index--) {
    const entry = entries[index]!;
    if (!AssistantEntry.is(entry)) continue;
    const taskId = entry.byTaskId;
    if (typeof taskId !== "number" || !Number.isSafeInteger(taskId) || answeredTasks.has(taskId)) continue;
    const message = entry.model?.[0];
    if (message?.role !== "assistant") continue;
    const text = assistantTextFromMessage(message, TERMINAL_SURFACE_LIMITS.generationTextChars);
    if (answerChars + text.length > TERMINAL_SURFACE_LIMITS.snapshotAnswerChars) continue;
    answeredTasks.add(taskId);
    answerChars += text.length;
    answers.push({
      taskId,
      entryId: entry.id,
      text,
      ...(message.stopReason === undefined ? {} : { stopReason: message.stopReason }),
    });
  }
  return {
    ...(run === undefined
      ? {}
      : {
          run: {
            taskId: run.taskId,
            inputs: [...run.inputs],
            ...(generation === undefined
              ? {}
              : {
                  generation: {
                    attempt: generation.attempt,
                    text: assistantTextFromMessage(generation.message, TERMINAL_SURFACE_LIMITS.generationTextChars),
                  },
                }),
          },
        }),
    answers,
  };
}

/** Project one conversation view and resolved agent model to a bounded status record. */
function projectStatus(
  view: ConversationView,
  model: { readonly provider: string; readonly modelId: string } | undefined,
): TerminalStatus {
  const live = view.docs["pi.live"] as unknown as LiveState | undefined;
  const inbox = view.docs["pi.inbox"] as unknown as { readonly items?: readonly { readonly mode?: string }[] } | undefined;
  const usage = view.docs["pi.usage"] as unknown as UsageState | undefined;
  const queued = inbox?.items ?? [];
  const modeCounts = { steer: 0, followUp: 0, write: 0 };
  const scanned = Math.min(queued.length, TERMINAL_SURFACE_LIMITS.statusQueueScan);
  for (let index = 0; index < scanned; index++) {
    const mode = queued[index]!.mode;
    if (mode === "steer" || mode === "followUp" || mode === "write") modeCounts[mode]++;
  }
  const tools = live?.tools ?? [];
  const toolsScanned = Math.min(tools.length, TERMINAL_SURFACE_LIMITS.statusQueueScan);
  let running = 0;
  let pending = 0;
  for (let index = 0; index < toolsScanned; index++) {
    if (tools[index]!.status === "running") running++;
    else if (tools[index]!.status === "pending") pending++;
  }
  const run = live?.run;
  return {
    ...(model === undefined ? {} : { model: { provider: model.provider, modelId: model.modelId } }),
    ...(run === undefined
      ? {}
      : {
          run: {
            taskId: run.taskId,
            inputs: run.inputs.length,
            ...(live?.generation === undefined ? {} : { attempt: live.generation.attempt }),
          },
        }),
    inbox: { total: queued.length, scanned, ...modeCounts },
    tools: { total: tools.length, scanned: toolsScanned, running, pending },
    compactions: live?.compactions?.length ?? 0,
    ...(usage === undefined ? {} : { usage }),
  };
}

/** Project one raw stored entry to bounded display fields. */
export function projectEntry(entry: EntryRecord): TerminalEntry {
  const messages: TerminalMessage[] = [];
  for (const message of entry.model ?? []) {
    if (messages.length >= TERMINAL_SURFACE_LIMITS.messagesPerEntry) break;
    const projected = projectMessage(message);
    if (projected !== undefined) messages.push(projected);
  }
  return {
    id: entry.id,
    kind: entry.kind,
    ...(entry.byTaskId === undefined ? {} : { byTaskId: entry.byTaskId }),
    ...(entry.edits === undefined ? {} : { edited: true }),
    messages,
  };
}

/** Project one bounded page of raw stored entries. */
export function projectEntryPage(
  conversationId: number,
  page: { readonly items: readonly EntryRecord[]; readonly next?: Cursor },
): TerminalEntryPage {
  return {
    conversationId,
    items: page.items.map(projectEntry),
    ...(page.next === undefined ? {} : { next: page.next }),
  };
}

/** Concatenate assistant text blocks, bounded without splitting a surrogate pair. */
function assistantTextFromMessage(
  message: Message | AssistantMessage | undefined,
  maxChars = TERMINAL_SURFACE_LIMITS.generationTextChars,
): string {
  if (message?.role !== "assistant") return "";
  let text = "";
  for (const part of message.content) {
    if (text.length >= maxChars) break;
    if (part.type === "text") text += part.text.slice(0, maxChars - text.length);
  }
  return text;
}

function projectMessage(message: Message): TerminalMessage | undefined {
  if (message.role === "user") {
    return { role: "user", text: messageText(message.content) };
  }
  if (message.role === "assistant") {
    let text = "";
    const toolCalls: TerminalToolCall[] = [];
    for (const part of message.content) {
      if (part.type === "text") text += part.text.slice(0, Math.max(0, TERMINAL_SURFACE_LIMITS.entryTextChars - text.length));
      else if (part.type === "toolCall" && toolCalls.length < TERMINAL_SURFACE_LIMITS.toolCallsPerMessage) {
        const argumentsText = boundedJson(part.arguments, TERMINAL_SURFACE_LIMITS.toolArgumentChars);
        toolCalls.push({ name: part.name, ...(argumentsText === undefined ? {} : { argumentsText }) });
      }
    }
    return {
      role: "assistant",
      text: text.slice(0, TERMINAL_SURFACE_LIMITS.entryTextChars),
      ...(message.stopReason === undefined ? {} : { stopReason: message.stopReason }),
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
    };
  }
  if (message.role === "toolResult") {
    return {
      role: "toolResult",
      text: messageText(message.content).slice(0, TERMINAL_SURFACE_LIMITS.entryTextChars),
      toolName: message.toolName,
    };
  }
  return undefined;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content.slice(0, TERMINAL_SURFACE_LIMITS.entryTextChars);
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (text.length >= TERMINAL_SURFACE_LIMITS.entryTextChars) break;
    if (part === null || typeof part !== "object") continue;
    const block = part as { readonly type?: unknown; readonly text?: unknown };
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text.slice(0, TERMINAL_SURFACE_LIMITS.entryTextChars - text.length);
    }
  }
  return text;
}

function boundedJson(value: unknown, maxChars: number): string | undefined {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return undefined;
    let length = Math.min(json.length, Math.max(0, maxChars));
    // Never cut a surrogate pair; the terminal would otherwise print a replacement char.
    if (length > 0 && isHighSurrogate(json.charCodeAt(length - 1))) length--;
    return json.slice(0, length);
  } catch {
    return "(unserializable)";
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function projectSettlement(settled: SettledSubmissionRecord): TerminalSettlement {
  return {
    status: settled.status,
    type: settled.type,
    ...(settled.status === "done" && settled.type === "input" ? { answer: settled.answer } : {}),
    ...(settled.status === "unanswered" ? { reason: settled.reason } : {}),
  };
}

/**
 * Adapt one in-process Durable conversation to the terminal surface.
 *
 * The shipped CLI uses the local gateway client instead. This adapter exists so
 * terminal behaviour checks and SDK hosts can run the same UI against a conversation
 * they already own, without the terminal receiving the full handle.
 */
export function inProcessTerminalConversation(conversation: Conversation): TerminalConversation {
  return {
    id: conversation.id,
    async watch(context) {
      const watch = await conversation.watch(context);
      return {
        start(listener) {
          watch.start(async (view) => listener(projectSnapshot(view)));
        },
        async stop() {
          await watch.stop();
        },
      };
    },
    async submit(content, context) {
      const submission = await conversation.submit({ type: "input", content }, context);
      return {
        id: submission.id,
        wait: async (ctx) => projectSettlement(await submission.wait(ctx)),
        status: async (ctx) => ({ status: (await submission.status(ctx)).status }),
      };
    },
    async answer(entryId, context) {
      const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, entryId as EntryId), context);
      const message = entry?.model?.[0];
      if (message?.role !== "assistant") return { text: "" };
      return {
        text: assistantTextFromMessage(message),
        ...(message.stopReason === undefined ? {} : { stopReason: message.stopReason }),
      };
    },
    async status(context) {
      const agent = await conversation.agent(context);
      const state = await conversation.viewState(context);
      try {
        return projectStatus(state.value, agent.model);
      } finally {
        state.dispose();
      }
    },
    async entries(query, limit, cursor, context) {
      const page = await conversation.entries(query, limit, cursor, context);
      return projectEntryPage(conversation.id, page);
    },
    async compact(context) {
      return conversation.compact(undefined, context);
    },
    async abort(context) {
      await conversation.abort(context);
    },
    async reset(context) {
      await conversation.reset(undefined, context);
    },
  };
}
