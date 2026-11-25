import type { Context } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { Writable } from "node:stream";
import { ConversationBusy } from "@earendil-works/pi-durable";
import type { UsageState } from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  conversationCommandNames,
  conversationCommandRefusal,
  conversationCommandUsage,
  conversationDetailBlock,
  conversationHelpListing,
  findConversationCommand,
  SAFE_COMMAND_NAME,
} from "../help/commands.js";
import { renderMcpListing, type McpAdminListing, type McpCallbackResult } from "../mcp/admin.js";
import { looksLikeOAuthCallback } from "../mcp/surface.js";
import { renderBackgroundStatus } from "../background-status.js";
import { renderModelReloadNotice, type ModelReloadResult } from "../model-reload.js";
import {
  renderMemoryDigestStart,
  renderMemoryDigestStatus,
  type MemoryDigestStartResult,
  type MemoryDigestStatusView,
} from "../history/memory-digest.js";
import type {
  GatewayModelList,
  GatewayModelSelection,
  GatewayModelSelectionRequest,
} from "../runtime.js";
import { handleOAuthCallback } from "../channels/controls.js";
import type {
  TerminalAttachmentSubmission,
  TerminalConversation,
  TerminalStatus,
  TerminalSubmission,
} from "./conversation.js";
import { createHistoryCommands, type TerminalHistoryHost } from "./history-commands.js";
import { createStreamRenderer } from "./stream-renderer.js";
import { completePrefix, errorName, safeLabel, sanitizeTerminalText } from "./text.js";

export type { TerminalHistoryHost } from "./history-commands.js";

const MAX_PENDING_INPUTS = 64;
const MAX_ACTIVE_COMMANDS = 16;
const MAX_ADMITTED_LINE_CODE_UNITS = 32_000;
const LITERAL_SLASH_PREFIX = "//";
/**
 * Interactive-only receipts and display. A slow reply must look pending rather than broken, and a
 * closed terminal must not look like a lost answer. Neither receipt claims a model turn is running:
 * native admission only establishes that the input is durable, so `/status` stays the authority on
 * whether it is queued or running.
 */
const INTERACTIVE_ATTACH_NOTICE =
  "Attached. Earlier replies are not replayed; /history prints them. Closing this terminal does not cancel admitted work.";
const INTERACTIVE_PENDING_NOTICE = "Reply pending; it may be queued behind a running turn. /status shows progress.";
const ACTIVITY_FRAMES = ["|", "/", "-", "\\"] as const;
const ACTIVITY_INTERVAL_MS = 250;
/**
 * The activity line reports only what committed state establishes: an admitted input is pending, and
 * a run containing it has been observed. "Waiting" is also what a queued input shows, so neither
 * label claims that the model is generating.
 */
const ACTIVITY_WAITING = "Waiting for the assistant...";
const ACTIVITY_WORKING = "Assistant working...";

const DEFAULT_ACTIVITY_TIMER: TerminalActivityTimer = {
  set(callback, milliseconds) {
    const handle = setInterval(callback, milliseconds);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clear(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};
/**
 * Only a busy refusal guarantees no effect. Other failures may follow acceptance or a lost
 * acknowledgement, so report uncertainty without echoing an internal message.
 */
const RESTART_REFUSED =
  "Gateway restart was not confirmed; the gateway may already be restarting. Check its status before retrying.";

export interface TerminalModelReloadHost {
  /** Explicit host-owned reload of foreground model presets, selection and credentials references. */
  reload(): Promise<ModelReloadResult>;
}

export interface TerminalModelSelectionHost {
  list(): Promise<GatewayModelList>;
  select(selection: GatewayModelSelectionRequest): Promise<GatewayModelSelection>;
  /** Optional named-preset selection; absent for direct-model hosts. */
  selectPreset?(name: string): Promise<GatewayModelSelection>;
}

/**
 * Read-only view of a host whose coding-tool authority comes from configuration. There is no grant
 * or expiry here: the configured names are what authenticated chats may use, and changing them is a
 * host configuration change, not a chat command.
 */
export interface TerminalToolPolicyHost {
  readonly tools: readonly string[];
}

/** Optional host-owned workspace-context refresh for the current conversation. */
export interface TerminalContextRefreshHost {
  /** False when the gateway has no configured context snapshot provider. */
  readonly available: boolean;
  /** Re-capture this conversation's host snapshot; resolves with its skill count. */
  refresh(): Promise<{ readonly skills: number }>;
}

/**
 * Optional host-owned manual memory-digestion entry. Starting returns once one bounded task is
 * admitted (or reports idle/busy/refused); status is a bounded read-only read. Neither waits for
 * the digest model turn, and neither is a model tool or an automatic schedule.
 */
export interface TerminalDigestHost {
  start(): Promise<MemoryDigestStartResult>;
  /** One host-projected status view: this attachment never receives another chat's origin. */
  status(): Promise<MemoryDigestStatusView>;
}

/**
 * MCP host surface over the already-authenticated local attach. `/mcp` is bounded read-only status.
 * A callback-shaped input line is offered here before model admission; the host validates it against
 * the login that originated in this exact session.
 */
export interface TerminalMcpHost {
  list(): Promise<McpAdminListing>;
  submitCallback(text: string): Promise<McpCallbackResult>;
}

/**
 * Optional host-owned local attachment submission. The host resolves and reads the
 * operator-named file, stores the original in the gateway's CLI attachment
 * directory, and composes ordinary path-only text; the terminal only names the path.
 */
export interface TerminalAttachmentHost {
  submit(path: string, prompt: string, context: Context): Promise<TerminalAttachmentSubmission>;
}

/**
 * Optional owner-terminal display. Absent keeps plain line-oriented output, which is what a piped
 * run and an SDK caller rely on. Prompt/status hooks preserve the host's typed input buffer;
 * an optional streaming writer lets readline keep that buffer editable during assistant output.
 */
export interface TerminalDisplay {
  /** True only for a real owner terminal; interactive receipts and activity exist only then. */
  readonly interactive: boolean;
  /** Draw the host's prompt. */
  prompt(): void;
  /** Erase the displayed prompt block; the typed buffer stays in the host input source. */
  erasePrompt(): void;
  /** Optional readline-aware streaming output, preserving a partially typed next message. */
  write?(text: string, target: Writable): boolean;
  /** Release the display, leaving any unfinished assistant text visible. */
  close?(): void;
  /** Replace the transient status line above the prompt, or clear it with `undefined`. */
  status(text: string | undefined): void;
}

/** Timer hooks for the transient status line, so checks can drive frames deterministically. */
export interface TerminalActivityTimer {
  set(callback: () => void, milliseconds: number): unknown;
  clear(handle: unknown): void;
}

export interface TerminalIO {
  /** Each item is a completed line; the source owns any memory bound before yielding it. */
  readonly input: AsyncIterable<string>;
  readonly output: Writable;
  readonly errorOutput?: Writable;
  /** Optional interactive prompt, activity line and receipts; absent keeps answer-only output. */
  readonly display?: TerminalDisplay;
  /** Plain prompt fallback for a TTY without cursor-control support. */
  readonly prompt?: () => void;
  /** Optional timer source for the activity line; defaults to an unref'd interval. */
  readonly activityTimer?: TerminalActivityTimer;
  /** Close an input source that supports prompt cancellation (for example readline.Interface). */
  readonly closeInput?: () => void;
  /** Optional host-owned model policy; standalone terminal callers remain read-only without it. */
  readonly modelSelection?: TerminalModelSelectionHost;
  /** Optional read-only configured tool authority; absent leaves the local tool commands unavailable. */
  readonly toolPolicy?: TerminalToolPolicyHost;
  /** Optional host-owned live model/credential reload; absent leaves /reload unavailable. */
  readonly reload?: TerminalModelReloadHost;
  /** Optional host-owned workspace-context refresh; standalone callers leave /refresh unavailable. */
  readonly contextRefresh?: TerminalContextRefreshHost;
  /** Optional host-owned memory-digestion entry; absent leaves /digest unavailable. */
  readonly digest?: TerminalDigestHost;
  /** Optional owner-only MCP management; absent leaves /mcp unavailable. */
  readonly mcp?: TerminalMcpHost;
  /** Optional host-owned history search/episode reads; standalone callers leave /search and /episodes unavailable. */
  readonly history?: TerminalHistoryHost;
  /** Optional host-owned local attachment submission; absent leaves /attach unavailable. */
  readonly attachments?: TerminalAttachmentHost;
  /** Host-owned whole-gateway restart, never a model tool or a terminal-only reconnect. */
  readonly restart?: () => Promise<void>;
}

/** Observe one existing Durable conversation and present its committed model text in a local terminal. */
export async function runTerminalConversation(
  conversation: TerminalConversation,
  context: Context,
  io: TerminalIO,
): Promise<void> {
  const operationController = new AbortController();
  const operationContext = withAbortSignal(operationController.signal, context);
  const observerController = new AbortController();
  const observerContext = withAbortSignal(observerController.signal, operationContext);
  const signal = operationContext.abortSignal;
  const observerSignal = observerContext.abortSignal;
  // Prime the input source before any awaited remote setup. Readline and similar
  // async iterables only attach their line listener on the first next(), so an
  // immediate piped line or EOF would otherwise be lost while the watch attaches.
  // Only one item is pulled early; later lines stay in the source's own buffer
  // until the loop consumes them.
  const input = primedInput(io.input);
  const watch = await conversation.watch(observerContext);
  const watchCallbacks = new Set<Promise<void>>();
  const waits = new Set<Promise<void>>();
  const commands = new Set<Promise<void>>();
  let reservedInputs = 0;
  let activeCommands = 0;
  let admissionTail: Promise<void> = Promise.resolve();
  let outputTail: Promise<void> = Promise.resolve();
  let renderTail: Promise<void> = Promise.resolve();
  let outputFailure: unknown;
  // Owner-terminal display state. A host may keep the editable prompt visible during streaming;
  // otherwise it is erased before written text. Activity never owns assistant or owner text.
  const display = io.display;
  const interactive = display?.interactive === true;
  let promptVisible = false;
  let activityHandle: unknown;
  let activityFrame = 0;
  let inputEnded = false;

  const serializeRender = <T>(operation: () => Promise<T>): Promise<T> => {
    const task = renderTail.then(operation);
    renderTail = task.then(() => undefined, () => undefined);
    return task;
  };

  const closeInput = () => {
    try { io.closeInput?.(); } catch { /* the owning CLI still closes the gateway */ }
  };
  const onOutputError = (error: Error): void => {
    outputFailure ??= error;
    operationController.abort(error);
    closeInput();
  };
  const outputStreams = new Set([io.output, ...(io.errorOutput === undefined ? [] : [io.errorOutput])]);
  for (const stream of outputStreams) stream.on("error", onOutputError);

  const write = (text: string, toError = false): Promise<void> => {
    const cleaned = sanitizeTerminalText(text);
    if (!cleaned) return Promise.resolve();
    const target = toError ? (io.errorOutput ?? io.output) : io.output;
    const operation = outputTail.then(async () => {
      if (outputFailure !== undefined) throw outputFailure;
      // A status line or prompt display never survives text: the line belongs to the output.
      stopActivity();
      if (display?.write !== undefined) {
        const ready = display.write(cleaned, target);
        promptVisible = !inputEnded && !signal?.aborted;
        if (!ready) await waitForDrain(target, signal);
      } else {
        erasePrompt();
        if (!target.write(cleaned)) await waitForDrain(target, signal);
      }
    });
    outputTail = operation.catch((error: unknown) => {
      if (!signal?.aborted) outputFailure ??= error;
      if (!operationController.signal.aborted) operationController.abort(error);
      closeInput();
    });
    return operation;
  };

  const renderer = createStreamRenderer({
    conversation,
    context: operationContext,
    write,
    serializeRender,
    labelled: interactive,
    onRunObserved: () => { if (activityHandle !== undefined) renderActivity(); },
  });
  const notice = renderer.notice;
  const history = createHistoryCommands({ conversation, history: io.history, context: operationContext, notice });

  const activityTimer = io.activityTimer ?? DEFAULT_ACTIVITY_TIMER;
  const stopActivity = (): void => {
    if (activityHandle !== undefined) {
      activityTimer.clear(activityHandle);
      activityHandle = undefined;
    }
    display?.status(undefined);
  };
  const renderActivity = (): void => {
    if (display === undefined || !promptVisible) return;
    const glyph = ACTIVITY_FRAMES[activityFrame % ACTIVITY_FRAMES.length]!;
    activityFrame++;
    display.status(`${glyph} ${renderer.working() ? ACTIVITY_WORKING : ACTIVITY_WAITING}`);
  };
  /** The activity line exists only beside a drawn prompt and only for admitted, unsettled local input. */
  const startActivityIfPending = (): void => {
    if (display === undefined || !interactive || !promptVisible) return;
    if (signal?.aborted || !renderer.awaitingAnswer()) return;
    if (activityHandle !== undefined) return;
    activityFrame = 0;
    renderActivity();
    activityHandle = activityTimer.set(renderActivity, ACTIVITY_INTERVAL_MS);
  };
  const erasePrompt = (): void => {
    if (display === undefined || !promptVisible) return;
    promptVisible = false;
    display.erasePrompt();
  };
  /** Restore the prompt, and the activity line, when no answer text is being written. */
  const showPrompt = (): void => {
    if (signal?.aborted || inputEnded) return;
    if (display === undefined) { io.prompt?.(); return; }
    if (!interactive) return;
    stopActivity();
    if (!promptVisible) {
      display.prompt();
      promptVisible = true;
    }
    startActivityIfPending();
  };
  watch.start(async (snapshot) => {
    const callback = serializeRender(async () => {
      await renderer.streamView(snapshot);
      startActivityIfPending();
    });
    watchCallbacks.add(callback);
    try {
      await callback;
    } finally {
      watchCallbacks.delete(callback);
    }
  });

  const waitForSubmission = (id: number, submission: TerminalSubmission): void => {
    let task!: Promise<void>;
    task = submission.wait(observerContext)
      .then((settled) => renderer.finishSubmission(id, settled))
      .catch(async (error: unknown) => {
        if (!signal?.aborted && !observerSignal?.aborted) {
          await notice(`Could not observe turn completion (${errorName(error)}).`, true);
        }
      })
      .finally(async () => {
        await serializeRender(async () => {
          renderer.release(id);
          reservedInputs = Math.max(0, reservedInputs - 1);
        });
        waits.delete(task);
        showPrompt();
      });
    waits.add(task);
  };

  const queueInput = (content: string): Promise<void> => {
    if (reservedInputs >= MAX_PENDING_INPUTS) {
      return notice(`Input limit reached (${MAX_PENDING_INPUTS} unsettled submissions). Wait for a turn or use /abort.`, true);
    }
    reservedInputs++;
    const operation = admissionTail.then(async () => {
      if (signal?.aborted) throw signal.reason;
      const submission = await conversation.submit(content, operationContext);
      renderer.track(submission.id, submission);
      waitForSubmission(submission.id, submission);
      // Only after native admission: a rejected input has its own refusal notice instead.
      if (interactive) {
        await notice(INTERACTIVE_PENDING_NOTICE);
        showPrompt();
      }
    });
    admissionTail = operation.catch(async (error: unknown) => {
      reservedInputs = Math.max(0, reservedInputs - 1);
      if (!signal?.aborted) await notice(`Input was not admitted (${errorName(error)}).`, true);
    });
    return Promise.resolve();
  };

  /** The catalogued CLI commands this host actually offers, in catalogue order. */
  const offeredCommands = (): readonly string[] => {
    const offered = new Set(["help", "new", "abort", "stop", "status", "history", "entry", "compact"]);
    if (io.history) {
      offered.add("search");
      offered.add("episodes");
      offered.add("episode");
    }
    if (io.modelSelection) offered.add("model");
    if (io.toolPolicy) offered.add("tools");
    if (io.reload) offered.add("reload");
    if (io.contextRefresh?.available) offered.add("refresh");
    if (io.digest) offered.add("digest");
    if (io.mcp) offered.add("mcp");
    if (io.attachments) offered.add("attach");
    if (io.restart) offered.add("restart");
    return conversationCommandNames("cli").filter((name) => offered.has(name));
  };

  /**
   * A capability host the offer set already admitted. Availability is decided once, in
   * `offeredCommands`; this narrows the optional field for the handler and fails loudly instead of
   * repeating the refusal whenever the two disagree.
   */
  const offeredHost = <T>(host: T | undefined): T => {
    if (host === undefined) throw new Error("offered conversation command has no host");
    return host;
  };

  /**
   * One refusal for a typed slash command this host does not run: the same catalogue reason
   * `/help <command>` gives, the guarantee that it never reaches the model, and the `//` literal
   * escape for a name the catalogue does not know.
   */
  const refuseTypedCommand = async (name: string): Promise<void> => {
    const literal = findConversationCommand(name) === undefined && SAFE_COMMAND_NAME.test(name)
      ? ` Use //${name} to send it literally.`
      : "";
    // A host without model selection cannot change the model, but `/status` can still name it.
    const currentModel = name === "model" && io.modelSelection === undefined
      ? ` Current model: ${modelLabel((await conversation.status(operationContext)).model)}.`
      : "";
    await notice(`${conversationCommandRefusal("cli", name, offeredCommands())} It was not sent to the model.${currentModel}${literal}`, true);
  };

  const showModel = async (args: string): Promise<void> => {
    const host = offeredHost(io.modelSelection);

    const parts = args.trim() ? args.trim().split(/\s+/) : [];
    if (parts.length === 0) {
      const listing = await host.list();
      const maxChoices = 50;
      const presets = listing.presets ?? [];
      if (presets.length > 0) {
        const rows = presets.slice(0, maxChoices).map((preset) => {
          const selected = preset.provider === listing.selected.provider
            && preset.modelId === listing.selected.modelId
            && (preset.thinkingLevel ?? "off") === listing.selected.thinkingLevel;
          const isDefault = preset.name === listing.defaultPreset;
          const level = safeLabel(preset.thinkingLevel ?? "off", 32);
          return `  ${selected ? "* " : "  "}${safeLabel(preset.name, 80)} — ${safeLabel(preset.provider, 80)} ${safeLabel(preset.modelId, 160)} [thinking: ${level}]${isDefault ? " (default)" : ""}`;
        });
        if (presets.length > maxChoices) rows.push(`  … ${presets.length - maxChoices} more named presets omitted`);
        await notice([
          `Current model: ${modelLabel(listing.selected)} (thinking: ${safeLabel(listing.selected.thinkingLevel, 32)}).`,
          ...(listing.defaultPreset === undefined ? [] : [`Configured default preset: ${safeLabel(listing.defaultPreset, 80)}.`]),
          "Named model presets (see /help model to select one):",
          ...rows,
        ].join("\n"));
        return;
      }
      const rows = listing.models.slice(0, maxChoices).map((choice) => {
        const selected = choice.provider === listing.selected.provider && choice.modelId === listing.selected.modelId;
        const levels = choice.thinkingLevels.map((level) => safeLabel(level, 32)).join(", ");
        return `  ${selected ? "* " : "  "}${safeLabel(choice.provider, 80)} ${safeLabel(choice.modelId, 160)} — ${safeLabel(choice.name, 160)} [thinking: ${levels || "off"}]`;
      });
      if (listing.models.length > maxChoices) rows.push(`  … ${listing.models.length - maxChoices} more allowed models omitted`);
      await notice([
        `Current model: ${modelLabel(listing.selected)} (thinking: ${safeLabel(listing.selected.thinkingLevel, 32)}).`,
        "Allowed models (see /help model to select one):",
        ...rows,
      ].join("\n"));
      return;
    }
    if (parts.length === 1) {
      if (host.selectPreset) {
        try {
          await host.selectPreset(parts[0]!);
          await notice(`Model: ${safeLabel(parts[0]!, 80)}.`);
        } catch (error) {
          if (error instanceof ConversationBusy || (error instanceof Error && error.name === "ConversationBusy")) {
            await notice("Model preset selection rejected: this conversation is busy. Retry when it is idle.", true);
          } else {
            await notice("Model preset selection rejected: unknown name, unsupported thinking, or presets are not configured. Use /model to list named presets.", true);
          }
        }
        return;
      }
      await notice(conversationCommandUsage("model"), true);
      return;
    }
    if (parts.length > 3 || parts.some((part) => !part)) {
      await notice(conversationCommandUsage("model"), true);
      return;
    }
    const selection = { provider: parts[0]!, modelId: parts[1]!, ...(parts[2] === undefined ? {} : { thinkingLevel: parts[2]! as ModelThinkingLevel }) };
    try {
      const selected = await host.select(selection);
      await notice(`Model: ${modelLabel(selected)} (thinking: ${safeLabel(selected.thinkingLevel, 32)}).`);
    } catch (error) {
      if (error instanceof ConversationBusy || (error instanceof Error && error.name === "ConversationBusy")) {
        await notice("Model selection rejected: this conversation is busy. Retry when it is idle.", true);
      } else {
        await notice("Model unchanged: choice unavailable. Use /model to list choices.", true);
      }
    }
  };

  const refreshContext = async (args: string): Promise<void> => {
    if (args.trim()) { await notice(conversationCommandUsage("refresh"), true); return; }
    const host = offeredHost(io.contextRefresh);
    try {
      await host.refresh();
    } catch (error) {
      if (error instanceof ConversationBusy || (error instanceof Error && error.name === "ConversationBusy")) {
        await notice("Context refresh rejected: this conversation is busy. Retry when it is idle.", true);
      } else {
        await notice("Context refresh failed; the previous snapshot is still in effect.", true);
      }
      return;
    }
    await notice("Context refreshed.");
  };

  const showTools = async (args: string): Promise<void> => {
    if (args.trim()) { await notice(conversationCommandUsage("tools"), true); return; }
    const policy = offeredHost(io.toolPolicy);
    if (policy.tools.length === 0) {
      await notice("Coding tools disabled. Set toolAllowlist and restart to enable.");
      return;
    }
    await notice(`Coding tools: ${policy.tools.join(", ")}. Change toolAllowlist and restart to update.`);
  };

  const showStatus = async (): Promise<void> => {
    const status: TerminalStatus = await conversation.status(operationContext);
    const queueSummary = `steer=${status.inbox.steer} followUp=${status.inbox.followUp} write=${status.inbox.write}`;
    const queueNote = status.inbox.total > status.inbox.scanned ? ` (mode counts first ${status.inbox.scanned})` : "";
    const taskSummary = status.run === undefined
      ? "idle"
      : `busy (run task ${status.run.taskId}, ${status.run.inputs} input(s)${status.run.attempt === undefined ? "" : `, generation attempt ${status.run.attempt}`})`;
    const toolsNote = status.tools.total > status.tools.scanned ? ` (first ${status.tools.scanned})` : "";
    const lines = [
      `Model: ${modelLabel(status.model)}`,
      `Run: ${taskSummary}`,
      `Native inbox: ${status.inbox.total} queued (${queueSummary}${queueNote}); model tools running=${status.tools.running} pending=${status.tools.pending}${toolsNote}; compactions=${status.compactions}`,
      // Additive: an idle background is one line; an older host without the field adds nothing.
      ...renderBackgroundStatus(status.background),
      ...formatUsage(status.usage),
      "Unrecorded provider usage/charges: unknown.",
    ];
    await notice(lines.join("\n"));
  };

  /**
   * Store one operator-named file through the host and admit its path-only turn. The
   * path is local operator input; the stored locator and composed text come from the
   * host. A refusal is reported with fixed host text and never echoed as file bytes.
   */
  const attachFile = async (args: string): Promise<void> => {
    const host = offeredHost(io.attachments);
    const parsed = parseAttachArguments(args);
    if (parsed.kind === "usage") {
      await notice(ATTACH_USAGE, true);
      return;
    }
    if (reservedInputs >= MAX_PENDING_INPUTS) {
      await notice(`Input limit reached (${MAX_PENDING_INPUTS} unsettled submissions). Wait for a turn or use /abort.`, true);
      return;
    }
    reservedInputs++;
    let admitted: TerminalAttachmentSubmission;
    try {
      admitted = await host.submit(parsed.path, parsed.prompt, operationContext);
    } catch (error) {
      reservedInputs = Math.max(0, reservedInputs - 1);
      if (!signal?.aborted) {
        await notice(`Attachment was not submitted (${fixedErrorText(error)}).`, true);
      }
      return;
    }
    const submission = admitted.submission;
    renderer.track(submission.id, submission);
    waitForSubmission(submission.id, submission);
    await notice(
      `Stored attachment at ${safeLabel(admitted.attachment.relativePath, 200)} ` +
      `(${admitted.attachment.bytes} bytes) and admitted its turn.`,
    );
    if (interactive) {
      await notice(INTERACTIVE_PENDING_NOTICE);
      showPrompt();
    }
  };

  /**
   * One screen of controls: the generated listing, then one line for a command this host lacks and
   * one for the // escape. Per-command usage and detail stay in `/help <command>`.
   */
  const offerHelp = async (args: string): Promise<void> => {
    const available = offeredCommands();
    const requested = args.trim().toLowerCase();
    if (!requested) {
      const unavailable = conversationCommandNames("cli").filter((name) => !available.includes(name));
      await notice([
        conversationHelpListing("cli", available),
        ...(unavailable.length === 0
          ? []
          : [`Not offered by this host: ${unavailable.map((name) => `/${name}`).join(", ")}.`]),
        "Unknown slash commands are not sent to the model; prefix // to send one literally.",
      ].join("\n\n"));
      return;
    }
    const command = available.includes(requested) ? findConversationCommand(requested) : undefined;
    if (command === undefined) { await refuseTypedCommand(requested); return; }
    await notice(conversationDetailBlock(command));
  };

  const runCommand = async (name: string, args: string): Promise<void> => {
    // One catalogue refusal covers every name this host does not offer, before any handler runs.
    if (!offeredCommands().includes(name)) {
      await refuseTypedCommand(name);
      return;
    }
    switch (name) {
      case "help":
        await offerHelp(args);
        return;
      case "status":
        if (args.trim()) { await notice(conversationCommandUsage("status"), true); return; }
        await showStatus();
        return;
      case "history":
        await history.history(args);
        return;
      case "search":
        await history.search(args);
        return;
      case "episodes":
        await history.episodes(args);
        return;
      case "episode":
        await history.episode(args);
        return;
      case "entry":
        await history.entry(args);
        return;
      case "model":
        await showModel(args);
        return;
      case "tools":
        await showTools(args);
        return;
      case "reload": {
        if (args.trim()) { await notice(conversationCommandUsage("reload"), true); return; }
        await notice(renderModelReloadNotice(await offeredHost(io.reload).reload()));
        return;
      }
      case "refresh":
        await refreshContext(args);
        return;
      case "digest": {
        const host = offeredHost(io.digest);
        const argument = args.trim().toLowerCase();
        if (argument === "") {
          await notice(renderMemoryDigestStart(await host.start()));
          return;
        }
        if (argument === "status") {
          await notice(renderMemoryDigestStatus(await host.status()));
          return;
        }
        await notice(conversationCommandUsage("digest"), true);
        return;
      }
      case "mcp": {
        const host = offeredHost(io.mcp);
        if (args.trim() !== "") {
          await notice(conversationCommandUsage("mcp"), true);
          return;
        }
        await notice(renderMcpListing(await host.list()));
        return;
      }
      case "attach":
        await attachFile(args);
        return;
      case "compact": {
        if (args.trim()) { await notice(conversationCommandUsage("compact"), true); return; }
        const taskId = await conversation.compact(operationContext);
        await notice(`Compaction queued (${taskId}).`);
        return;
      }
      case "stop":
      case "abort":
        if (args.trim()) { await notice(conversationCommandUsage(name), true); return; }
        await conversation.abort(operationContext);
        await notice("Idle. Queue cleared.");
        return;
      case "new":
        if (args.trim()) { await notice(conversationCommandUsage("new"), true); return; }
        try {
          await conversation.reset(operationContext);
        } catch (error) {
          if (error instanceof ConversationBusy || (error instanceof Error && error.name === "ConversationBusy")) {
            await notice("Reset refused: chat busy. /abort or retry /new when idle.", true);
            return;
          }
          throw error;
        }
        await notice(io.contextRefresh?.available ? "Context reset." : "Context reset queued.");
        return;
      case "restart": {
        if (args.trim()) { await notice(conversationCommandUsage("restart"), true); return; }
        try {
          await offeredHost(io.restart)();
        } catch (error) {
          // Only a busy refusal is a known no-effect. A lost acknowledgement can follow acceptance.
          const busy = error instanceof ConversationBusy || (error instanceof Error && error.name === "ConversationBusy");
          await notice(busy && error instanceof Error ? error.message : RESTART_REFUSED, true);
          return;
        }
        await notice("Restarting; disconnecting.");
        io.closeInput?.();
        operationController.abort(new Error("gateway restart requested"));
        return;
      }
    }
  };

  const localCommand = (name: string, args: string): Promise<void> => {
    if (activeCommands >= MAX_ACTIVE_COMMANDS) {
      return notice(`Local command limit reached (${MAX_ACTIVE_COMMANDS} active controls).`, true);
    }
    activeCommands++;
    let task!: Promise<void>;
    task = admissionTail.then(() => {
      if (!signal?.aborted) return runCommand(name, args);
    })
      .catch(async (error: unknown) => {
        if (!signal?.aborted) await notice(`/${completePrefix(name, 80)} failed (${errorName(error)}).`, true);
      })
      .finally(() => {
        activeCommands--;
        commands.delete(task);
        showPrompt();
      });
    commands.add(task);
    admissionTail = task.catch(() => undefined);
    return Promise.resolve();
  };

  const onAbort = (): void => closeInput();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) closeInput();

  try {
    if (interactive) await notice(INTERACTIVE_ATTACH_NOTICE);
    showPrompt();
    for await (const line of input) {
      if (signal?.aborted) break;
      // This bounds admitted content after the source yields a complete line, not its ingress buffer.
      if (line.length > MAX_ADMITTED_LINE_CODE_UNITS) {
        await notice(`Input exceeds the ${MAX_ADMITTED_LINE_CODE_UNITS}-code-unit CLI limit.`, true);
        showPrompt();
        continue;
      }
      const leading = line.trimStart();
      if (!leading) {
        showPrompt();
        continue;
      }
      if (looksLikeOAuthCallback(line)) {
        // Even hosts without management must not admit an expired/foreign credential as input.
        const mcp = io.mcp;
        const result = await handleOAuthCallback(mcp === undefined ? undefined : (text) => mcp.submitCallback(text), line);
        await notice(result.text, !result.accepted);
      } else if (leading.startsWith(LITERAL_SLASH_PREFIX)) {
        const prefix = line.indexOf(LITERAL_SLASH_PREFIX);
        await queueInput(`${line.slice(0, prefix)}/${line.slice(prefix + LITERAL_SLASH_PREFIX.length)}`);
      } else if (leading.startsWith("/")) {
        const parsed = /^\s*\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(line);
        if (!parsed) await notice("Malformed slash command; it was not sent to the model.", true);
        else {
          const name = parsed[1]!.toLowerCase();
          const args = parsed[2] ?? "";
          await localCommand(name, args);
        }
      } else {
        await queueInput(line);
      }
      showPrompt();
    }
    inputEnded = !signal?.aborted;

    await admissionTail;
    await Promise.allSettled([...commands]);
    while (waits.size > 0 && !signal?.aborted) {
      await Promise.race([...waits]);
      if (!inputEnded || !renderer.unansweredObserved || signal?.aborted || waits.size === 0) continue;
      const status = await conversation.status(operationContext);
      const idle = status.run === undefined;
      if (idle) {
        const queued: TerminalSubmission[] = [];
        for (const submission of renderer.unsettled()) {
          if ((await submission.status(operationContext)).status === "queued") queued.push(submission);
        }
        if (queued.length > 0) {
          await notice(`Disconnected; ${queued.length} input(s) remain queued. Reopen or /abort to withdraw.`, true);
          observerController.abort(new Error("CLI EOF; preserve queued Durable submissions"));
          break;
        }
      }
    }
    await Promise.allSettled([...waits]);
    await outputTail;
    if (outputFailure !== undefined && !signal?.aborted) throw outputFailure;
  } catch (error) {
    if (!signal?.aborted) {
      operationController.abort(error);
      closeInput();
      throw error;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) closeInput();
    // A disconnect or abort never leaves an activity interval behind.
    inputEnded = true;
    stopActivity();
    for (const stream of outputStreams) stream.off("error", onOutputError);
    await watch.stop();
    await Promise.allSettled([...watchCallbacks, ...waits, ...commands]);
    await admissionTail;
    await outputTail;
    await renderTail;
    display?.close?.();
  }
  if (outputFailure !== undefined) throw outputFailure;
}

/**
 * Start one source read immediately, then yield it before iterating normally.
 *
 * The early read is kept awaitable for the terminal loop and marked handled so a
 * failure before the loop starts cannot surface as an unhandled rejection. The
 * generator's finally releases the source iterator if the loop is abandoned.
 */
function primedInput(source: AsyncIterable<string>): AsyncIterable<string> {
  const iterator = source[Symbol.asyncIterator]();
  const first = iterator.next();
  first.catch(() => undefined);
  return {
    [Symbol.asyncIterator]() {
      return (async function* () {
        try {
          const initial = await first;
          if (initial.done === true) return;
          yield initial.value;
          while (true) {
            const next = await iterator.next();
            if (next.done === true) return;
            yield next.value;
          }
        } finally {
          if (iterator.return !== undefined) {
            try {
              await iterator.return();
            } catch {
              // Closing an input source is best effort; read failures propagate through next().
            }
          }
        }
      })();
    },
  };
}

const ATTACH_USAGE = conversationCommandUsage("attach");

type AttachArguments =
  | { readonly kind: "usage" }
  | { readonly kind: "attach"; readonly path: string; readonly prompt: string };

/** The first ` -- ` separates the path from the optional prompt; paths may contain spaces. */
function parseAttachArguments(input: string): AttachArguments {
  const trimmed = input.trim();
  if (trimmed === "") return { kind: "usage" };
  const marker = " -- ";
  const index = trimmed.indexOf(marker);
  const path = (index < 0 ? trimmed : trimmed.slice(0, index)).trim();
  const prompt = index < 0 ? "" : trimmed.slice(index + marker.length).trim();
  if (path === "" || path.startsWith("--")) return { kind: "usage" };
  return { kind: "attach", path, prompt };
}

function modelLabel(model: { provider: string; modelId: string } | undefined): string {
  return model === undefined
    ? "unknown (no model configured)"
    : completePrefix(sanitizeTerminalText(`${model.provider}/${model.modelId}`), 240);
}

function formatUsage(usage: UsageState | undefined): string[] {
  if (usage === undefined) return ["Recorded usage: unavailable (pi.usage is absent from the current view)."];
  const lines = ["Recorded usage (native Durable records):"];
  const rows: string[] = [];
  const maxRows = 40;
  for (const model in usage.models ?? {}) {
    if (!Object.hasOwn(usage.models, model)) continue;
    const totals = usage.models[model]!;
    rows.push(`  model ${completePrefix(sanitizeTerminalText(model), 120)}: input=${totals.input} output=${totals.output} total=${totals.totalTokens} cost=${formatCost(totals.cost?.total)}`);
    if (rows.length >= maxRows) break;
  }
  if (rows.length < maxRows) {
    for (const tool in usage.tools ?? {}) {
      if (!Object.hasOwn(usage.tools, tool)) continue;
      const totals = usage.tools[tool]!;
      rows.push(`  tool ${completePrefix(sanitizeTerminalText(tool), 120)}: input=${totals.input} output=${totals.output} total=${totals.totalTokens} cost=${formatCost(totals.cost?.total)}`);
      if (rows.length >= maxRows) break;
    }
  }
  if (rows.length === 0) lines.push("  no usage recorded yet");
  else lines.push(...rows);
  if (rows.length === maxRows) lines.push("  additional usage rows omitted");
  return lines;
}

function formatCost(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(6)}` : "unknown";
}

/**
 * Bounded host text for an attachment refusal. The local gateway rejects with
 * fixed, value-free messages; anything else the host throws is sanitized and cut
 * to a short line so a raw stack, dependency dump or long path is never printed.
 */
function fixedErrorText(error: unknown): string {
  if (error instanceof Error) {
    const text = completePrefix(sanitizeTerminalText(error.message), 200).trim();
    if (text) return text;
  }
  return "unknown error";
}

async function waitForDrain(stream: Writable, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
      stream.off("close", onClose);
      stream.off("finish", onFinish);
      signal?.removeEventListener("abort", onAbort);
    };
    const onDrain = (): void => { cleanup(); resolve(); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onClose = (): void => { cleanup(); reject(new Error("Output stream closed before drain")); };
    const onFinish = (): void => { cleanup(); reject(new Error("Output stream finished before drain")); };
    const onAbort = (): void => { cleanup(); reject(signal?.reason ?? new Error("Output wait cancelled")); };
    stream.once("drain", onDrain);
    stream.once("error", onError);
    stream.once("close", onClose);
    stream.once("finish", onFinish);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (stream.destroyed || stream.writableFinished) onClose();
    else if (signal?.aborted) onAbort();
  });
}
