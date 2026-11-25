/**
 * Shared owner-control engine of the chat channels (Telegram, Discord, the app).
 *
 * A mutating control (`new`, `abort`/`stop`, `model <preset>`, `restart`, `digest`) is durably
 * admitted with a held acknowledgement before its effect, gates its scope so no later input can
 * overtake it, places every earlier owner input first, applies the native effect once and reports
 * a truthful outcome: applied, refused (a proven no-effect), still pending, or interrupted with an
 * unknown outcome. It is never replayed after a restart.
 *
 * The coordinator owns ordering, gating, retries and outcome wording. Each channel keeps its own
 * durable state document and implements the small {@link ControlLedger} commits against it, plus
 * how an earlier input is prepared and submitted (attachments included).
 */

import type { Context } from "@earendil-works/chord";
import { ConversationBusy } from "@earendil-works/pi-durable";
import { renderBackgroundStatus } from "../background-status.js";
import { renderMemoryDigestStart, renderMemoryDigestStatus } from "../history/memory-digest.js";
import type { OwnerInputContent } from "../history/idle-rollover.js";
import type { McpCallbackResult } from "../mcp/admin.js";
import { boundedLabel } from "../media/outbound.js";
import { RESTART_BUSY_MESSAGE, RestartBusyError } from "../restart.js";
import type { GatewayModelList } from "../runtime.js";
import {
  projectConversationStatus,
  type ChannelGateway,
  type ChannelScopeNoun,
  type ConversationStatus,
  type HostRestartController,
} from "./contracts.js";
import { DEFAULT_CHANNEL_TIMERS, type ChannelTimers, type SubmissionOrderQueue } from "./turn-runtime.js";

// ── Commands, outcomes and fixed wording ─────────────────────────────────────

/** A command with a native effect; `stop` normalizes to `abort` before admission. */
export type ChannelMutation = "new" | "abort" | "model" | "restart" | "digest";

/**
 * `admitted` is committed with the held acknowledgement before the native call; `applied` after it
 * returns; `refused` when the call proved nothing changed; `unconfirmed` once reported interrupted.
 */
export type ControlStatus = "admitted" | "applied" | "refused" | "unconfirmed";

export type ControlOutcome =
  | { readonly kind: "applied"; readonly text?: string; readonly requestRestart?: true }
  | { readonly kind: "refused"; readonly text: string }
  | { readonly kind: "deferred" }
  | { readonly kind: "abandoned" };

export const CONTROL_ACK: Readonly<Record<ChannelMutation, string>> = Object.freeze({
  new: "Context reset.",
  abort: "Idle. Queue cleared.",
  model: "Model selected.",
  restart: "Restart requested; checking active work.",
  digest: "Digest requested.",
});

export const CONTROL_PENDING: Readonly<Record<ChannelMutation, string>> = Object.freeze({
  new: "Reset pending.",
  abort: "Still stopping. New messages are held.",
  model: "Model change pending.",
  restart: "Restart pending.",
  digest: "Digest pending; not started yet.",
});

export const UNCONFIRMED_CONTROL = "Command interrupted; outcome unknown. Send it again if needed.";
/** An interrupted restart is never repeated automatically; resending it is the owner's decision. */
export const UNCONFIRMED_RESTART = "Restart interrupted; outcome unknown. Not retried.";
export const CONTROL_PREVIOUS_PENDING = "Previous command pending. This command wasn't started; retry later.";

/** What the replacement process owes the scope that asked for `restart`: only that it opened. */
export const RESTART_LIVE = "Restarted.";
/** The host refused the replacement, so this process is still the one serving. */
export const RESTART_FAILED = "Restart refused. Gateway still running.";
export const RESTART_UNAVAILABLE_HOST =
  "Restart is unavailable in this host: it cannot replace its own process with the same program and configuration. " +
  "Nothing was sent to the assistant.";
export const RESTART_ALREADY_REQUESTED =
  "A restart was already requested in this gateway and is still stopping it; this /restart was not requested again.";
export const RESTART_REQUEST_FAILED =
  "A restart was already requested in this gateway and the host refused it, so the gateway is still running. " +
  "This /restart was not requested again; fix the host and start the gateway yourself.";

export const STATUS_UNAVAILABLE_HOST =
  "Status is unavailable in this host: it exposes no model/status metadata for this chat. Nothing was sent to the assistant.";
export const MODEL_UNAVAILABLE_HOST =
  "Model commands are unavailable in this host: it exposes no preset catalog or preset selection. Nothing was sent to the assistant.";
export const MODEL_LISTING_UNAVAILABLE =
  "Model choices are unavailable right now: this chat's host model catalog could not be read. Nothing changed.";
export const MODEL_PRESETS_UNAVAILABLE =
  "Named model presets are not configured in this deployment, so /model <name> and /model default are unavailable. " +
  "Nothing was changed; /model lists the current selection read only, and this chat command never rewrites the configuration.";
export const DIGEST_UNAVAILABLE_HOST =
  "Memory digestion is unavailable in this host: it exposes no manual digestion entry. Nothing was started and " +
  "nothing was sent to the assistant.";
export const MCP_UNAVAILABLE_HOST =
  "MCP management is unavailable in this host: the gateway was opened without an on-disk configuration file, " +
  "so there is nothing to write. Nothing was sent to the assistant.";
export const RESET_BUSY = "Reset refused: chat busy. /abort or retry /new when idle.";

export const OAUTH_CALLBACK_UNAVAILABLE =
  "No MCP login is available in this host; the callback was not stored or sent to the assistant.";
export const OAUTH_CALLBACK_UNHANDLED =
  "This OAuth callback was not accepted. It was not sent to the assistant and was not stored.";

/** The interrupted-outcome wording for one recorded command: a restart is never retried. */
export function unconfirmedControlText(command: string): string {
  return command === "restart" ? UNCONFIRMED_RESTART : UNCONFIRMED_CONTROL;
}

/** Fixed refusal for a new mutating control while too many are still unresolved. */
export function tooManyControlsText(command: string, limit: number): string {
  return `Too many control commands are still unconfirmed (limit ${limit}); this ${command} command was not ` +
    "started and was not sent to the assistant. Wait for them to finish or restart the gateway.";
}

/** Replay wording for a command recorded before a restart; it is never run twice. */
export function renderReplayControlText(entry: { readonly command: string; readonly status: ControlStatus }): string {
  if (entry.command === "restart") {
    return entry.status === "applied"
      ? "That /restart was already requested before this process restarted, so it is not requested again."
      : "That /restart was interrupted before it was confirmed: it may or may not have restarted the gateway, and it " +
        "is not requested again.";
  }
  if (entry.status === "applied") return "That command was already applied before a restart, so it was not run again.";
  if (entry.status === "refused") {
    return "That command was refused before any effect and will not be retried; send it again if it is still needed.";
  }
  if (entry.status === "unconfirmed") {
    return "That command was already reported as interrupted; send it again if you still need it.";
  }
  return UNCONFIRMED_CONTROL;
}

export function isConversationBusy(error: unknown): boolean {
  return error instanceof ConversationBusy || (error instanceof Error && error.name === "ConversationBusy");
}

// ── Model presets ────────────────────────────────────────────────────────────

export type ModelArgument =
  | { readonly kind: "list" }
  | { readonly kind: "preset"; readonly name: string }
  | { readonly kind: "usage" };

/**
 * Config preset names carry no whitespace, control or bidi/format characters; anything else would
 * reorder or forge the notice that echoes it.
 */
const PRESET_NAME = /^[^\s\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]+$/u;

/** Bound a `model` argument to the shape the config accepts: one name, never a selector triple. */
export function parseModelArgument(args: string): ModelArgument {
  const trimmed = args.trim();
  if (trimmed === "") return { kind: "list" };
  const parts = trimmed.split(/\s+/u);
  if (parts.length !== 1) return { kind: "usage" };
  const name = parts[0]!;
  if (name.length > 80 || !PRESET_NAME.test(name)) return { kind: "usage" };
  return { kind: "preset", name };
}

/** The configured preset a session currently uses, matched by provider, model and thinking level. */
export function matchingPresetName(listing: GatewayModelList): string | undefined {
  const selected = listing.selected;
  return listing.presets?.find((preset) => preset.provider === selected.provider &&
    preset.modelId === selected.modelId && (preset.thinkingLevel ?? "off") === selected.thinkingLevel)?.name;
}

/**
 * Why a validated `model <name>` cannot be admitted against this listing, or `undefined` when it
 * can: only the finite configured catalog may be selected, never an arbitrary triple.
 */
export function modelPresetRefusal(listing: GatewayModelList | undefined, name: string): string | undefined {
  if (listing === undefined) return MODEL_LISTING_UNAVAILABLE;
  if (listing.presets === undefined) return MODEL_PRESETS_UNAVAILABLE;
  if (name !== "default" && !listing.presets.some((preset) => preset.name === name)) {
    return `Unknown model preset ${boundedLabel(name, 80)}: nothing was changed. Use /model to list the configured presets.`;
  }
  return undefined;
}

export interface RenderOptions {
  /** Where the owner talks: `chat`, `channel` or `thread`. */
  readonly scope: ChannelScopeNoun;
  /** Text for a label with nothing printable left; default `(empty)`. */
  readonly emptyLabel?: string;
}

const MAX_MODEL_CHOICES = 50;

/** One bounded listing of the current selection and the finite configured choices. */
export function renderModelListing(listing: GatewayModelList, options: RenderOptions): string {
  const label = (value: unknown, max: number): string => boundedLabel(value, max, labelOptions(options));
  const selectedLine = `Current model: ${label(listing.selected.provider, 80)}/` +
    `${label(listing.selected.modelId, 160)} (thinking: ${label(listing.selected.thinkingLevel, 32)}).`;
  const presets = listing.presets ?? [];
  if (presets.length === 0) {
    // Legacy direct-model configuration: the selection and its allowed choices are read only here.
    const rows = listing.models.slice(0, MAX_MODEL_CHOICES).map((choice) => {
      const current = choice.provider === listing.selected.provider && choice.modelId === listing.selected.modelId;
      const levels = choice.thinkingLevels.map((level) => label(level, 32)).join(", ");
      return `  ${current ? "* " : "  "}${label(choice.provider, 80)} ${label(choice.modelId, 160)} ` +
        `— ${label(choice.name, 160)} [thinking: ${levels === "" ? "off" : levels}]`;
    });
    if (listing.models.length > MAX_MODEL_CHOICES) {
      rows.push(`  … ${listing.models.length - MAX_MODEL_CHOICES} more allowed models omitted`);
    }
    return [
      selectedLine,
      "Named model presets are not configured in this deployment, so /model <name> and /model default are " +
        "unavailable here; this chat command never rewrites the configuration.",
      "Configured direct choices (read only; the direct selection belongs to the local CLI):",
      ...rows,
    ].join("\n");
  }
  const selectedPreset = matchingPresetName(listing);
  const rows = presets.slice(0, MAX_MODEL_CHOICES).map((preset) => {
    const isDefault = preset.name === listing.defaultPreset;
    return `  ${preset.name === selectedPreset ? "* " : "  "}${label(preset.name, 80)} — ` +
      `${label(preset.provider, 80)} ${label(preset.modelId, 160)} ` +
      `[thinking: ${label(preset.thinkingLevel ?? "off", 32)}]${isDefault ? " (default)" : ""}`;
  });
  if (presets.length > MAX_MODEL_CHOICES) rows.push(`  … ${presets.length - MAX_MODEL_CHOICES} more named presets omitted`);
  return [
    selectedLine,
    ...(listing.defaultPreset === undefined ? [] : [`Configured default preset: ${label(listing.defaultPreset, 80)}.`]),
    "Named model presets (see /help model to select one):",
    ...rows,
    `A selection applies to this ${options.scope} only and lasts while the gateway stays open; a restart restores ` +
      "the configured default and prepared requests keep their model.",
  ].join("\n");
}

/**
 * The host model catalog of one mapped session, or `undefined` when the host has none or it could
 * not be read. The catalog is per-session, so the session's own conversation is resolved first;
 * that creates no other conversation and holds no model call.
 */
export async function readModelListing(
  gateway: Pick<ChannelGateway, "conversationFor" | "listModels">,
  sessionKey: string,
  context: Context,
): Promise<GatewayModelList | undefined> {
  if (typeof gateway.listModels !== "function") return undefined;
  try {
    await gateway.conversationFor(sessionKey, context);
    return await gateway.listModels(sessionKey, context);
  } catch {
    return undefined;
  }
}

// ── Read-only status ─────────────────────────────────────────────────────────

/**
 * One bounded `status` notice. The model line prefers the host's live selection (with thinking
 * level and the matching preset name) over the stored agent model; every label is sanitized.
 */
export function renderStatusNotice(input: {
  readonly scope: ChannelScopeNoun;
  readonly status: ConversationStatus;
  readonly listing?: GatewayModelList;
  /** Already rendered background lines; empty or absent adds nothing. */
  readonly background?: readonly string[];
  readonly emptyLabel?: string;
}): string {
  const options = labelOptions(input);
  const selection = input.listing?.selected;
  const model = selection !== undefined
    ? `${selection.provider}/${selection.modelId} (thinking: ${selection.thinkingLevel})`
    : input.status.model === undefined ? "unknown" : `${input.status.model.provider}/${input.status.model.modelId}`;
  const preset = input.listing === undefined ? undefined : matchingPresetName(input.listing);
  const run = input.status.run;
  return [
    `Status for this ${input.scope} (no model call, no configuration change):`,
    `Model: ${boundedLabel(model, 240, options)}${preset === undefined ? "" : ` — preset ${boundedLabel(preset, 80, options)}`}`,
    run === undefined
      ? "Run: idle"
      : `Run: running (turn ${run.taskId}, ${run.inputs} input(s)` +
        `${run.attempt === undefined ? "" : `, generation attempt ${run.attempt}`})`,
    `Queued native inputs: ${input.status.inbox.total}`,
    ...(input.background ?? []),
    `Only this ${input.scope}'s own records were read; no other chat's transcript, prompt or tool argument is included.`,
  ].join("\n");
}

/**
 * Read and render one session's `status`: the stored projection, the host selection and the
 * bounded background lines. Read only: no model call, no watch, no transcript and no other chat.
 * A failed background read adds nothing; any other failure is one fixed unavailable notice.
 */
export async function readStatusNotice(
  gateway: Pick<ChannelGateway, "conversationFor" | "harness" | "listModels" | "backgroundStatus">,
  sessionKey: string,
  scope: ChannelScopeNoun,
  context: Context,
): Promise<string> {
  try {
    const listing = await readModelListing(gateway, sessionKey, context);
    const conversation = await gateway.conversationFor(sessionKey, context);
    const status = await projectConversationStatus(conversation, context, gateway.harness);
    let background: string[] = [];
    try {
      if (typeof gateway.backgroundStatus === "function") {
        background = renderBackgroundStatus(await gateway.backgroundStatus(sessionKey, context));
      }
    } catch {
      background = [];
    }
    return renderStatusNotice({ scope, status, ...(listing === undefined ? {} : { listing }), background });
  } catch {
    return `Status is unavailable right now: this ${scope}'s conversation metadata could not be read. ` +
      "No model call was made and nothing changed.";
  }
}

/** Bounded read-only `digest status` of one session; it creates no task and reads no transcript. */
export async function renderDigestStatus(
  gateway: Pick<ChannelGateway, "conversationFor" | "memoryDigest">,
  sessionKey: string,
  context: Context,
): Promise<string> {
  const host = gateway.memoryDigest;
  if (host === undefined) return DIGEST_UNAVAILABLE_HOST;
  const conversation = await gateway.conversationFor(sessionKey, context);
  return renderMemoryDigestStatus(await host.status({
    id: conversation.id,
    commit: (change, commitContext) => conversation.commit(change, commitContext),
  }, context));
}

// ── Native effects ───────────────────────────────────────────────────────────

/**
 * `new`: a native reset, or the host's paired reset plus prompt-snapshot rebuild. A busy refusal,
 * reported or thrown, is a known no-effect and becomes a refusal, never a crash or an applied claim.
 */
export async function executeNewSession(
  gateway: Pick<ChannelGateway, "conversationFor" | "resetSession">,
  sessionKey: string,
  context: Context,
  options: { readonly busyText?: string } = {},
): Promise<ControlOutcome> {
  const busy = { kind: "refused", text: options.busyText ?? RESET_BUSY } as const;
  try {
    if (typeof gateway.resetSession !== "function") {
      const conversation = await gateway.conversationFor(sessionKey, context);
      await conversation.reset(undefined, context);
      return { kind: "applied" };
    }
    const result = await gateway.resetSession(sessionKey, context);
    return result.status === "busy" ? busy : { kind: "applied" };
  } catch (error) {
    if (isConversationBusy(error)) return busy;
    throw error;
  }
}

/** `abort`/`stop`: withdraw queued inputs and stop foreground work of this session. */
export async function executeAbort(
  gateway: Pick<ChannelGateway, "conversationFor">,
  sessionKey: string,
  context: Context,
): Promise<ControlOutcome> {
  const conversation = await gateway.conversationFor(sessionKey, context);
  await conversation.abort(context);
  return { kind: "applied" };
}

/**
 * `model <preset>`: the only model effect a chat command may have. The host selection rejects
 * atomically (including a busy conversation), so any rejection is a known no-effect.
 */
export async function executeModelPreset(
  gateway: Pick<ChannelGateway, "selectModelPreset">,
  sessionKey: string,
  name: string,
  context: Context,
  options: RenderOptions,
): Promise<ControlOutcome> {
  if (typeof gateway.selectModelPreset !== "function") return { kind: "refused", text: MODEL_UNAVAILABLE_HOST };
  const label = (value: unknown, max: number): string => boundedLabel(value, max, labelOptions(options));
  try {
    const selection = await gateway.selectModelPreset(sessionKey, name, context);
    const preset = name === "default" ? "the configured default preset" : `preset ${label(name, 80)}`;
    return {
      kind: "applied",
      text: `Model set to ${preset}: ${label(selection.provider, 80)}/${label(selection.modelId, 160)} ` +
        `(thinking: ${label(selection.thinkingLevel, 32)}) for this ${options.scope}.`,
    };
  } catch (error) {
    if (isConversationBusy(error)) {
      return {
        kind: "refused",
        text: `Model selection refused: this ${options.scope} is busy, so nothing changed. Stop it or retry when idle.`,
      };
    }
    return { kind: "refused", text: "Model selection was refused; nothing was changed. Use /model to list the configured presets." };
  }
}

/**
 * `digest`: admit one bounded digestion batch for this session's own conversation. It returns once
 * the task is admitted; nothing waits for the digest turn and nothing is sent to a user.
 */
export async function executeDigest(
  gateway: Pick<ChannelGateway, "conversationFor" | "memoryDigest">,
  sessionKey: string,
  context: Context,
): Promise<ControlOutcome> {
  const host = gateway.memoryDigest;
  if (host === undefined) return { kind: "refused", text: DIGEST_UNAVAILABLE_HOST };
  const conversation = await gateway.conversationFor(sessionKey, context);
  const result = await host.start({
    id: conversation.id,
    commit: (change, commitContext) => conversation.commit(change, commitContext),
  }, context);
  return result.status === "refused"
    ? { kind: "refused", text: renderMemoryDigestStart(result) }
    : { kind: "applied", text: renderMemoryDigestStart(result) };
}

/**
 * Apply one admitted mutation of one session. `restart` has no conversation effect: its outcome
 * asks the coordinator to request the host replacement only after the acknowledgement is durable.
 */
export async function executeChannelControl(
  gateway: Pick<ChannelGateway, "conversationFor" | "resetSession" | "selectModelPreset" | "memoryDigest">,
  control: { readonly command: ChannelMutation; readonly sessionKey: string; readonly option?: string },
  context: Context,
  options: RenderOptions & { readonly resetBusyText?: string },
): Promise<ControlOutcome> {
  switch (control.command) {
    case "new":
      return executeNewSession(gateway, control.sessionKey, context,
        options.resetBusyText === undefined ? {} : { busyText: options.resetBusyText });
    case "abort":
      return executeAbort(gateway, control.sessionKey, context);
    case "digest":
      return executeDigest(gateway, control.sessionKey, context);
    case "restart":
      return { kind: "applied", text: CONTROL_ACK.restart, requestRestart: true };
    case "model":
      return executeModelPreset(gateway, control.sessionKey, control.option ?? "default", context, options);
  }
}

/**
 * Offer one callback-shaped owner line to the MCP login lifecycle before any admission. The text is
 * never stored, echoed or modelled: only fixed wording or the lifecycle's own credential-free text
 * comes back. `authenticated: false` (a sender that does not own the scope) refuses without
 * offering it; a failing host is reported as not accepted.
 */
export async function handleOAuthCallback(
  submit: ((text: string) => Promise<McpCallbackResult>) | undefined,
  text: string,
  options: { readonly authenticated?: boolean; readonly scope?: ChannelScopeNoun } = {},
): Promise<{ readonly accepted: boolean; readonly text: string }> {
  if (options.authenticated === false) {
    return {
      accepted: false,
      text: `This OAuth callback did not come from the authenticated sender that owns this ${options.scope ?? "chat"}. ` +
        "It was not sent to the assistant and was not stored.",
    };
  }
  if (submit === undefined) return { accepted: false, text: OAUTH_CALLBACK_UNAVAILABLE };
  try {
    const result = await submit(text);
    return result.handled && result.text !== ""
      ? { accepted: result.accepted, text: result.text }
      : { accepted: false, text: OAUTH_CALLBACK_UNHANDLED };
  } catch {
    return { accepted: false, text: OAUTH_CALLBACK_UNHANDLED };
  }
}

// ── Durable record bookkeeping ───────────────────────────────────────────────

/** Default bound of applied records kept for replay reports. */
export const MAX_CONTROL_RECORDS = 64;

/**
 * Keep every unresolved record, only the newest `maxApplied` applied ones, and a refused or
 * unconfirmed record only while its report is still queued (`reported`). Repeated commands against a
 * hung provider therefore cannot grow the log.
 */
export function pruneControls<R extends { readonly status: ControlStatus }>(
  controls: readonly R[],
  reported: (entry: R) => boolean,
  maxApplied: number = MAX_CONTROL_RECORDS,
): R[] {
  const totalApplied = controls.filter((entry) => entry.status === "applied").length;
  let drop = Math.max(0, totalApplied - maxApplied);
  return controls.filter((entry) => {
    if ((entry.status === "unconfirmed" || entry.status === "refused") && !reported(entry)) return false;
    if (entry.status !== "applied" || drop === 0) return true;
    drop -= 1;
    return false;
  });
}

/** The parts of a stored control record and pending notice that recovery reads and corrects. */
export type RecoverableControl = { readonly command: string; status: ControlStatus };
export type RecoverableNotice = { readonly notice?: boolean; hold?: boolean; text: string };

/**
 * Startup recovery inside the channel's open transaction: a control recorded but never confirmed
 * may or may not have taken effect, so it is reported once (`unconfirmed`) and never replayed. Its
 * held acknowledgement is corrected and released; when none is left, `report` queues one fresh
 * notice (return `false` when it does not fit; the record then stays admitted for a later open). A
 * held acknowledgement without a record is released as interrupted; one whose record was applied
 * is released as is. Returns how many records were reported interrupted.
 */
export function recoverInterruptedControls<Key, C extends RecoverableControl, N extends RecoverableNotice>(
  controls: C[],
  pending: N[],
  access: {
    controlKey(entry: C): Key;
    noticeKey(item: N): Key;
    report(entry: C, text: string): boolean;
  },
): number {
  let interrupted = 0;
  for (const entry of controls) {
    if (entry.status !== "admitted") continue;
    const key = access.controlKey(entry);
    const text = unconfirmedControlText(entry.command);
    const notice = pending.find((item) => item.notice === true && access.noticeKey(item) === key);
    if (notice !== undefined) {
      if (notice.hold === true) notice.text = text;
      delete notice.hold;
    } else if (!access.report(entry, text)) {
      continue;
    }
    entry.status = "unconfirmed";
    interrupted++;
  }
  for (const notice of pending) {
    if (notice.notice !== true || notice.hold !== true) continue;
    const key = access.noticeKey(notice);
    const record = controls.find((entry) => access.controlKey(entry) === key);
    if (record === undefined) {
      notice.text = UNCONFIRMED_CONTROL;
      delete notice.hold;
    } else if (record.status !== "admitted") {
      delete notice.hold;
    }
  }
  return interrupted;
}

/**
 * Queue one notice per owed restart confirmation (the live confirmation in a replacement process,
 * or the refusal report in the process that stayed up). `admit` returns `false` when one does not
 * fit; those stay owed and are returned instead of being claimed as delivered. `authorized` drops an
 * owner the live configuration no longer admits.
 */
export function admitOwedRestartNotices<R>(
  owed: readonly R[],
  admit: (record: R) => boolean,
  authorized: (record: R) => boolean = () => true,
): R[] {
  const remaining: R[] = [];
  for (const record of owed) {
    if (!authorized(record)) continue;
    if (!admit(record)) remaining.push(record);
  }
  return remaining;
}

/**
 * The one host restart request of an adapter lifetime. A busy refusal is a known no-effect, so a
 * later `restart` may ask again; any other refusal latches, and further commands get a fixed
 * refusal instead of asking again. Every refusal is reported through `onRefused` with the text the
 * requesting scopes are owed.
 */
export interface RestartRequester {
  /** The fixed refusal for a new `restart` command, or `undefined` when it may be admitted. */
  admissionRefusal(): string | undefined;
  /** Ask the host, at most once until a busy refusal re-opens it. */
  request(): void;
}

export function createRestartRequester(
  host: HostRestartController | undefined,
  options: {
    /** Channel name for the operator warning, such as `Telegram`. */
    readonly label: string;
    onRefused(text: string, busy: boolean): void;
    readonly warn?: (message: string) => void;
  },
): RestartRequester {
  let requested = false;
  let failed = false;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  return {
    admissionRefusal() {
      if (!requested) return undefined;
      return failed ? RESTART_REQUEST_FAILED : RESTART_ALREADY_REQUESTED;
    },
    request() {
      if (requested || host === undefined || !host.supported) return;
      requested = true;
      let started: Promise<void>;
      try {
        started = Promise.resolve(host.request());
      } catch (error) {
        started = Promise.reject(error);
      }
      void started.catch((error: unknown) => {
        const busy = error instanceof RestartBusyError;
        failed = !busy;
        if (busy) requested = false;
        warn(busy
          ? `${options.label} /restart was refused while live work is active; the gateway keeps running.`
          : `${options.label} /restart request was refused by the host; the gateway keeps running.`);
        options.onRefused(busy ? RESTART_BUSY_MESSAGE : RESTART_FAILED, busy);
      });
    },
  };
}

// ── The durable mutating-control coordinator ─────────────────────────────────

/** One admitted mutating control. `Key` is the channel's durable record key, `Scope` its gate. */
export interface ControlRecord<Key, Scope> {
  readonly key: Key;
  readonly scope: Scope;
  readonly command: ChannelMutation;
  /** The validated `model` preset name. */
  readonly option?: string;
}

/**
 * The channel's durable commits for one control, each against its own state document. Every method
 * is one commit of the channel's state; reads are of its current committed copy.
 */
export interface ControlLedger<Key, Scope, R extends ControlRecord<Key, Scope>> {
  /** The record's durable status, or `undefined` when it is gone. */
  status(key: Key): ControlStatus | undefined;
  /** Admitted plus unconfirmed records, for the admission bound. */
  unresolved(): number;
  /**
   * Commit the `admitted` record and its held acknowledgement `ackText`, with any channel
   * bookkeeping (such as a polling offset). May throw (a full queue); nothing is gated then.
   */
  admit(record: R, ackText: string): Promise<void>;
  /** Commit `applied`; a `restart` also records who is owed a live confirmation. */
  markApplied(record: R): Promise<void>;
  /** Release the held acknowledgement, rewriting it to `text` when given. */
  release(key: Key, text?: string): Promise<void>;
  /**
   * Commit `refused` and publish `text` in one atomic state commit: rewrite and release a still-
   * queued acknowledgement when present, or when `late` is true and it is already gone, queue one
   * fresh notice instead of dropping `text` or emitting a duplicate.
   */
  markRefused(record: R, text: string, late?: boolean): Promise<void>;
  /**
   * Commit `unconfirmed` and rewrite/release a still-queued acknowledgement to `text` in one atomic
   * state commit. When `lateRecord` is given and that acknowledgement is already gone, queue one
   * fresh notice in the same commit instead of dropping `text` or emitting a duplicate.
   */
  markUnconfirmed(key: Key, text: string, lateRecord?: R): Promise<void>;
  /**
   * Deliver a final outcome after the still-pending wording was published: replace that
   * acknowledgement while it is still queued, or queue a fresh notice. Never drop the text.
   */
  publishLate(record: R, text: string): Promise<void>;
  /** Queue one fixed notice for a control that was not admitted (busy gate, unresolved bound). */
  refuse(record: R, text: string): Promise<void>;
}

/** How the owner inputs admitted before a control are placed ahead of it. */
export interface ControlFlush<Key, Scope, R extends ControlRecord<Key, Scope>, Input> {
  /** Earlier owner inputs of this control's scope, oldest first, from current committed state. */
  inputs(record: R): readonly Input[];
  /**
   * Prepare one input's full content (text plus stored attachments) inside the scope's submission
   * order; `undefined` skips an input that was delivered or withdrawn meanwhile.
   */
  prepareInput(input: Input, record: R): Promise<OwnerInputContent | undefined>;
  /** Submit the prepared input (idle rollover, native submit, early-submission bookkeeping). */
  submit(input: Input, content: OwnerInputContent, record: R): Promise<void>;
}

export interface ControlCoordinatorOptions<Key, Scope, R extends ControlRecord<Key, Scope>, Input> {
  readonly ledger: ControlLedger<Key, Scope, R>;
  readonly flush: ControlFlush<Key, Scope, R, Input>;
  /** The channel's own submission order, shared with its normal deliveries. */
  readonly order: SubmissionOrderQueue<Scope>;
  /** The native effect, normally {@link executeChannelControl}. */
  execute(record: R): Promise<ControlOutcome>;
  /** Ask the host to replace the process (normally {@link RestartRequester.request}). */
  requestRestart(): void;
  /** A native or storage failure: the record stays admitted and a reopen reports it. */
  onFatal(error: unknown): void;
  /** Dispatch pending deliveries again (notices, other scopes). */
  drain(): void;
  /** False once the adapter is stopping or its context aborted. */
  active(): boolean;
  /** Ordered-flush attempts before an earlier input is declared unplaceable; default 10. */
  readonly maxAttempts?: number;
  /** Unresolved records before new controls are refused; default 64. */
  readonly maxUnresolved?: number;
  /** Delay before an unanswered acknowledgement says the command is still pending; default 30 s. */
  readonly pendingNoticeMs?: number;
  readonly timers?: ChannelTimers;
}

export type ControlAdmission = "started" | "busy" | "limit";

export interface ControlCoordinator<Key, Scope, R extends ControlRecord<Key, Scope>> {
  /**
   * Admit one mutating control and start it off the caller's loop. A scope with a command still
   * applying or deferred refuses it (`busy`), as does the unresolved bound (`limit`); both queue a
   * fixed notice. A failed admission commit rethrows and leaves the scope ungated.
   */
  admit(record: R): Promise<ControlAdmission>;
  /** Retry deferred controls on the channel's own cadence (poll or scan). */
  resumeDeferred(): void;
  /** Whether ordinary inputs of this scope must wait (notices may still be delivered). */
  gated(scope: Scope): boolean;
  /** Whether this record is applying or deferred in this process. */
  inFlight(key: Key): boolean;
  /**
   * The report for a replayed command found already recorded. A record still applying or deferred
   * in this process returns `undefined` (its own acknowledgement is the answer); an `admitted`
   * record left by an earlier process is first committed `unconfirmed`; the fixed replay wording
   * is returned otherwise.
   */
  replay(entry: { readonly key: Key; readonly command: string; readonly status: ControlStatus }): Promise<string | undefined>;
  /** Settles when every started control task has finished. */
  idle(): Promise<void>;
}

type AckState = {
  value: "waiting" | "pending" | "applied" | "refused";
  pendingWrite?: Promise<void>;
};

export function createControlCoordinator<Key, Scope, R extends ControlRecord<Key, Scope>, Input>(
  options: ControlCoordinatorOptions<Key, Scope, R, Input>,
): ControlCoordinator<Key, Scope, R> {
  const { ledger, flush } = options;
  const maxAttempts = options.maxAttempts ?? 10;
  const maxUnresolved = options.maxUnresolved ?? 64;
  const pendingNoticeMs = options.pendingNoticeMs ?? 30_000;
  const timers = options.timers ?? DEFAULT_CHANNEL_TIMERS;
  /** Scopes whose ordinary inputs wait behind an unresolved control. */
  const gate = new Set<Scope>();
  /** Scopes, and record keys, with a control task running now. */
  const running = new Set<Scope>();
  const runningKeys = new Set<Key>();
  const deferred = new Map<Key, R>();
  const failures = new Map<Key, number>();
  const tasks = new Set<Promise<void>>();

  const forgetRetry = (key: Key): void => {
    deferred.delete(key);
    failures.delete(key);
  };

  /** Place every earlier input, then apply and record the native effect once. */
  const apply = async (record: R): Promise<ControlOutcome> => {
    try {
      for (const input of flush.inputs(record)) {
        await options.order.submitInOrder(record.scope, async () => {
          // Prepared in the same order as a normal delivery, so attachments are never dropped.
          const content = await flush.prepareInput(input, record);
          if (content !== undefined) await flush.submit(input, content, record);
        });
      }
    } catch (error) {
      if (!options.active()) {
        forgetRetry(record.key);
        throw error;
      }
      const attempts = (failures.get(record.key) ?? 0) + 1;
      if (attempts < maxAttempts) {
        failures.set(record.key, attempts);
        deferred.set(record.key, record);
        return { kind: "deferred" };
      }
      // A permanently failing earlier input cannot be overtaken: report honestly and release.
      forgetRetry(record.key);
      return { kind: "abandoned" };
    }
    // Earlier inputs are placed: once entering the native effect, the control is no longer
    // retryable, so a failed effect or confirmation commit goes to recovery instead of rerunning.
    forgetRetry(record.key);
    const outcome = await options.execute(record);
    if (outcome.kind === "applied") await ledger.markApplied(record);
    return outcome;
  };

  /**
   * Publish one outcome exactly once. While the acknowledgement is still held it becomes the
   * outcome; once the still-pending wording went out the outcome is a late follow-up, so a slow
   * command never loses its only answer.
   */
  const settle = async (record: R, outcome: ControlOutcome, ack: AckState): Promise<void> => {
    const late = ack.value !== "waiting";
    if (outcome.kind === "deferred") {
      if (late) return;
      ack.value = "pending";
      await ledger.release(record.key, CONTROL_PENDING[record.command]).catch(() => undefined);
      return;
    }
    if (outcome.kind === "abandoned") {
      ack.value = "refused";
      const text = unconfirmedControlText(record.command);
      await ledger.markUnconfirmed(record.key, text, late ? record : undefined).catch(() => undefined);
      return;
    }
    if (outcome.kind === "refused") {
      ack.value = "refused";
      await ledger.markRefused(record, outcome.text, late).catch(() => undefined);
      return;
    }
    ack.value = "applied";
    try {
      if (late) await ledger.publishLate(record, outcome.text ?? CONTROL_ACK[record.command]);
      else await ledger.release(record.key, outcome.text);
    } catch {
      // A failed release leaves the held notice for the next open to report; the command is done.
    } finally {
      // The record and acknowledgement are durable first; the host owns the replacement and is
      // still asked when the acknowledgement commit itself failed.
      if (outcome.requestRestart === true) options.requestRestart();
    }
  };

  const launch = (record: R, ack: AckState): void => {
    running.add(record.scope);
    runningKeys.add(record.key);
    let timer = ack.value === "waiting"
      ? timers.set(() => {
          timer = undefined;
          if (ack.value !== "waiting") return;
          ack.value = "pending";
          ack.pendingWrite = Promise.resolve()
            .then(() => ledger.release(record.key, CONTROL_PENDING[record.command]))
            .catch(() => undefined);
        }, pendingNoticeMs)
      : undefined;
    const clearTimer = (): void => {
      if (timer !== undefined) {
        timers.clear(timer);
        timer = undefined;
      }
    };
    let task!: Promise<void>;
    task = Promise.resolve()
      .then(() => apply(record))
      .then(
        async (outcome) => {
          clearTimer();
          // Serialize any started pending-timer write before settlement so it can never overwrite
          // the final receipt or outlive `idle()`.
          if (ack.pendingWrite !== undefined) await ack.pendingWrite;
          await settle(record, outcome, ack);
        },
        async (error: unknown) => {
          clearTimer();
          if (ack.pendingWrite !== undefined) await ack.pendingWrite;
          // The record stays admitted and the acknowledgement held: a reopen reports it unconfirmed.
          if (options.active()) options.onFatal(error);
        },
      )
      .catch(() => undefined)
      .finally(() => {
        clearTimer();
        tasks.delete(task);
        running.delete(record.scope);
        runningKeys.delete(record.key);
        if (!deferred.has(record.key)) gate.delete(record.scope);
        if (options.active()) options.drain();
      });
    tasks.add(task);
  };

  const scopeDeferred = (scope: Scope): boolean => {
    for (const record of deferred.values()) if (record.scope === scope) return true;
    return false;
  };

  return {
    async admit(record) {
      if (gate.has(record.scope) || running.has(record.scope) || scopeDeferred(record.scope)) {
        await ledger.refuse(record, CONTROL_PREVIOUS_PENDING);
        return "busy";
      }
      if (ledger.unresolved() >= maxUnresolved) {
        await ledger.refuse(record, tooManyControlsText(record.command, maxUnresolved));
        return "limit";
      }
      gate.add(record.scope);
      try {
        await ledger.admit(record, CONTROL_ACK[record.command]);
      } catch (error) {
        // No control task exists to release this gate when admission itself fails.
        gate.delete(record.scope);
        throw error;
      }
      launch(record, { value: "waiting" });
      options.drain();
      return "started";
    },
    resumeDeferred() {
      if (!options.active()) return;
      for (const [key, record] of [...deferred]) {
        if (running.has(record.scope)) continue;
        if (ledger.status(key) !== "admitted") {
          // Settled elsewhere (or reported by a reopen): release the gate without repeating it.
          forgetRetry(key);
          gate.delete(record.scope);
          continue;
        }
        // Leave `deferred` before launching: only another transient flush failure re-enqueues it.
        deferred.delete(key);
        // Its acknowledgement already said "still pending", so any final outcome is late.
        launch(record, { value: "pending" });
      }
    },
    gated(scope) {
      return gate.has(scope);
    },
    inFlight(key) {
      return runningKeys.has(key) || deferred.has(key);
    },
    async replay(entry) {
      // Still applying here: its own held acknowledgement is the visible result.
      if (runningKeys.has(entry.key) || deferred.has(entry.key)) return undefined;
      if (entry.status === "admitted") {
        await ledger.markUnconfirmed(entry.key, unconfirmedControlText(entry.command));
      }
      return renderReplayControlText(entry);
    },
    async idle() {
      while (tasks.size > 0) await Promise.allSettled([...tasks]);
    },
  };
}

function labelOptions(options: { readonly emptyLabel?: string }): { readonly empty?: string } {
  return options.emptyLabel === undefined ? {} : { empty: options.emptyLabel };
}
