import { processLock } from "@earendil-works/chord/node";
import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { AgentDoc, configure, ConversationBusy, createRegistry, defineDoc, Harness, LiveDoc, type AgentChange, type AgentState, type Conversation, type ConversationId, type Cursor, type EntryId, type Extension, type Harness as HarnessType, type ModelRef, type Storage } from "@earendil-works/pi-durable";
import { CONTEXT_LIMITS, createContextExtensionBuilder, type ConversationContextSnapshot } from "./context/index.js";
import type { ModelReference, PortConfig } from "./config.js";
import { hasPersistedNanobotContext, preparedContextReplay, preparedTaskModel } from "./recovery/prepared.js";
import { prepareDataDirectory } from "./store.js";
import { openFullSyncNodeSqliteStorage } from "./storage/sqlite.js";
import { createProviderModels, nativeModelReference, resolveModelChoices, type ResolvedModelChoice } from "./providers.js";

const SessionMap = defineDoc<{ sessions: Record<string, number> }>({
  kind: "nanobot.session-map", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ sessions: {} }), checkpointWhen: () => true,
});

export interface GatewayModelChoice {
  provider: string;
  modelId: string;
  name: string;
  thinkingLevels: readonly ModelThinkingLevel[];
}

export interface GatewayModelSelectionRequest extends ModelReference {
  thinkingLevel?: ModelThinkingLevel;
}

export interface GatewayModelSelection extends ModelReference {
  thinkingLevel: ModelThinkingLevel;
}

export interface GatewayModelList {
  models: readonly GatewayModelChoice[];
  selected: GatewayModelSelection;
}

export type GatewayContextSnapshotProvider = (
  sessionKey: string,
  conversationId: ConversationId,
  context: Context,
) =>
  | Omit<ConversationContextSnapshot, "conversationId">
  | undefined
  | Promise<Omit<ConversationContextSnapshot, "conversationId"> | undefined>;

export interface OpenGatewayOptions {
  readonly models?: Models;
  /** Explicit host-owned context snapshots; absent means no context extension is installed. */
  readonly contextSnapshotProvider?: GatewayContextSnapshotProvider;
}

export interface Gateway {
  readonly harness: HarnessType;
  conversationFor(sessionKey: string, context: Context): Promise<Conversation>;
  /** Lists the explicit allowlist and persisted selection for an already-known session key. */
  listModels(sessionKey: string, context: Context): Promise<GatewayModelList>;
  /** Persists a native pi.agent choice; rejects ConversationBusy atomically without changing it. */
  selectModel(sessionKey: string, selection: GatewayModelSelectionRequest, context: Context): Promise<GatewayModelSelection>;
  close(context: Context): Promise<void>;
}

function encodedSessionKey(key: string): string {
  if (!key) throw new Error("sessionKey must not be empty");
  return `k:${Buffer.from(key, "utf8").toString("base64url")}`;
}

function decodedSessionKey(key: string): string {
  if (!key.startsWith("k:")) throw new Error("Stored session map contains an invalid session key");
  const decoded = Buffer.from(key.slice(2), "base64url").toString("utf8");
  if (encodedSessionKey(decoded) !== key) throw new Error("Stored session map contains an invalid session key");
  return decoded;
}

function bindContextSnapshot(
  value: object | undefined,
  conversationId: ConversationId,
): ConversationContextSnapshot {
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (value !== undefined) {
    for (const key of ["identity", "agents", "soul", "user", "memory", "skills", "selectedSkills"]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && Object.hasOwn(descriptor, "value")) snapshot[key] = descriptor.value;
    }
  }
  snapshot.conversationId = conversationId;
  return snapshot as unknown as ConversationContextSnapshot;
}

function modelKey(model: ModelReference | ModelRef): string {
  return JSON.stringify([model.provider, model.modelId]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isModelSelection(value: unknown): value is GatewayModelSelectionRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (!Object.hasOwn(value, "provider") || !Object.hasOwn(value, "modelId")) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.provider === "string" && candidate.provider.length > 0 &&
    typeof candidate.modelId === "string" && candidate.modelId.length > 0;
}

export async function openGateway(config: PortConfig, context: Context, options: OpenGatewayOptions = {}): Promise<Gateway> {
  // A config name is not a Durable registration identity or an authorization grant. Until the
  // gateway installs reviewed registrations, fail closed rather than silently accepting grants.
  if ((config.toolAllowlist ?? []).length > 0) {
    throw new Error("toolAllowlist is non-empty, but this gateway has no approved registered tools");
  }
  const allowedModels = config.allowedModels ?? [config.model];
  const prepared = options.models
    ? { models: options.models, model: nativeModelReference(config.model) }
    : createProviderModels(config);
  const { models, model } = prepared;
  const choices = resolveModelChoices(models, allowedModels);
  const choicesByConfigured = new Map(choices.map((choice) => [modelKey(choice.configured), choice]));
  const choicesByNative = new Map(choices.map((choice) => [modelKey(choice.native), choice]));
  const defaultChoice = choicesByConfigured.get(modelKey(config.model));
  if (!defaultChoice) throw new Error("Default model must be included in allowedModels");
  if (modelKey(model) !== modelKey(defaultChoice.native)) throw new Error("Resolved default model does not match its configured choice");
  if (config.thinkingLevel !== undefined && !defaultChoice.thinkingLevels.includes(config.thinkingLevel)) {
    throw new Error(`Unsupported thinkingLevel ${config.thinkingLevel} for default model ${config.model.provider}/${config.model.modelId}`);
  }
  if (options.contextSnapshotProvider !== undefined && typeof options.contextSnapshotProvider !== "function") {
    throw new TypeError("contextSnapshotProvider must be a function");
  }
  const defaultThinkingLevel = config.thinkingLevel ?? "off";
  const { workspace, dbPath } = await prepareDataDirectory(config);
  const hostPolicy: AgentChange = { cwd: workspace, tools: [], modelTools: [] };
  const defaultAgentPolicy: AgentChange = {
    ...hostPolicy,
    model,
    thinkingLevel: defaultThinkingLevel,
  };
  const fallbackThinkingLevel = (choice: ResolvedModelChoice): ModelThinkingLevel =>
    config.thinkingLevel !== undefined && choice.thinkingLevels.includes(config.thinkingLevel)
      ? config.thinkingLevel
      : "off";
  const choiceFromState = (state: Readonly<AgentState> | undefined): ResolvedModelChoice | undefined =>
    state?.model === undefined ? undefined : choicesByNative.get(modelKey(state.model));
  const policyForState = (state: Readonly<AgentState> | undefined): AgentChange => {
    const existing = choiceFromState(state);
    const choice = existing ?? defaultChoice;
    const modelWasRevoked = existing === undefined;
    const thinkingLevel = !modelWasRevoked && state?.thinkingLevel !== undefined && choice.thinkingLevels.includes(state.thinkingLevel)
      ? state.thinkingLevel
      : fallbackThinkingLevel(choice);
    return { ...hostPolicy, model: choice.native, thinkingLevel };
  };
  let contextExtension: Extension | undefined;
  const contextExtensionBuilder = createContextExtensionBuilder();
  const contextConversations = new Set<ConversationId>();
  const contextAgentPolicy = (conversationId: ConversationId): AgentChange => {
    if (!options.contextSnapshotProvider || !contextExtension) return { extensions: [] };
    return contextConversations.has(conversationId)
      ? { extensions: { add: [contextExtension] } }
      : { extensions: { remove: [contextExtension] } };
  };
  const publicChoice = (choice: ResolvedModelChoice): GatewayModelChoice => ({
    ...choice.configured,
    name: choice.model.name,
    thinkingLevels: [...choice.thinkingLevels],
  });
  const publicSelection = (choice: ResolvedModelChoice, thinkingLevel: ModelThinkingLevel): GatewayModelSelection => ({
    ...choice.configured,
    thinkingLevel,
  });
  async function applyConversationPolicy(conversation: Conversation, ctx: Context): Promise<void> {
    await conversation.commit(async (tx) => {
      const state = await tx.doc(AgentDoc, conversation.id);
      await configure(tx, conversation.id, { ...policyForState(state), ...contextAgentPolicy(conversation.id) });
    }, ctx);
  }
  const releaseLock = await processLock(`nanobot:${dbPath}`);
  let harness: HarnessType | undefined;
  let storage: Storage | undefined;
  let closed = false;
  try {
    const registry = createRegistry();
    storage = await openFullSyncNodeSqliteStorage(dbPath, context);
    harness = await Harness.open(storage, { models, registry }, context);
    const root = await harness.root(context, { agent: defaultAgentPolicy });

    const contextSnapshotLoads = new Map<ConversationId, Promise<void>>();
    const ensureContextSnapshot = async (
      sessionKey: string,
      conversationId: ConversationId,
      ctx: Context,
    ): Promise<void> => {
      if (!options.contextSnapshotProvider || contextConversations.has(conversationId)) return;
      let pending = contextSnapshotLoads.get(conversationId);
      if (!pending) {
        pending = Promise.resolve()
          .then(() => options.contextSnapshotProvider!(sessionKey, conversationId, ctx))
          .then((supplied) => {
            if (supplied !== undefined && !isRecord(supplied)) {
              throw new TypeError("Context snapshot provider must return an object or undefined");
            }
            const snapshot = bindContextSnapshot(supplied, conversationId);
            const extension = contextExtensionBuilder.add(snapshot);
            contextConversations.add(conversationId);
            contextExtension = extension;
            registry.install(extension);
          })
          .finally(() => contextSnapshotLoads.delete(conversationId));
        contextSnapshotLoads.set(conversationId, pending);
      }
      await pending;
    };

    // Restore each host snapshot against the persisted session mapping before resume can schedule work.
    if (options.contextSnapshotProvider) {
      await root.commit(async (tx) => { await tx.doc(SessionMap, root.id); }, context);
      const mapping = await harness.snapshot(SessionMap, root.id, context);
      const sessions = mapping?.sessions;
      if (!isRecord(sessions)) throw new Error("Stored session map is malformed");
      const entries = Object.entries(sessions);
      if (entries.length > CONTEXT_LIMITS.maxConversations) {
        throw new Error(`Context snapshots support at most ${CONTEXT_LIMITS.maxConversations} mapped conversations`);
      }
      const mappedConversationIds = new Set<ConversationId>();
      const mappedSessions: { sessionKey: string; conversationId: ConversationId }[] = [];
      for (const [encodedKey, rawId] of entries) {
        const sessionKey = decodedSessionKey(encodedKey);
        if (!Number.isSafeInteger(rawId) || rawId < 1 || rawId === root.id) {
          throw new Error("Stored session map contains an invalid conversation ID");
        }
        const conversationId = rawId as ConversationId;
        if (mappedConversationIds.has(conversationId)) {
          throw new Error("Stored session map maps multiple session keys to one conversation");
        }
        mappedConversationIds.add(conversationId);
        mappedSessions.push({ sessionKey, conversationId });
      }
      for (const { sessionKey, conversationId } of mappedSessions) {
        if (!(await harness.conversation(conversationId, context))) {
          throw new Error("Stored session mapping points to a missing conversation");
        }
        await ensureContextSnapshot(sessionKey, conversationId, context);
      }
    }

    // Refuse unsafe prepared replays before resume; checkpoints pin historical context cutoffs.
    const preparedContextReplays: NonNullable<ReturnType<typeof preparedContextReplay>>[] = [];
    await root.commit(async (tx) => {
      let taskCursor: Cursor | undefined;
      do {
        const page = await tx.scanTasks({}, 1000, taskCursor);
        for (const task of page.items) {
          const preparedModel = preparedTaskModel(task);
          if (preparedModel !== undefined && !choicesByNative.has(modelKey(preparedModel))) {
            throw new Error(`Cannot resume ${task.kind} task ${task.id}: prepared model ${modelKey(preparedModel)} is outside allowedModels`);
          }
          const contextReplay = preparedContextReplay(task);
          if (contextReplay !== undefined) preparedContextReplays.push(contextReplay);
        }
        taskCursor = page.next;
      } while (taskCursor !== undefined);
    }, context);

    for (const replay of preparedContextReplays) {
      const conversation = await harness.conversation(replay.conversationId, context);
      if (!conversation) throw new Error(`Cannot safely resume ${replay.kind} task ${replay.id}: conversation is missing`);
      const view = await conversation.context(context, { at: replay.at as EntryId });
      if (hasPersistedNanobotContext(view.messages)) {
        throw new Error(
          `Cannot safely resume ${replay.kind} task ${replay.id} (${replay.phase}): its prepared request includes ` +
          "persisted Nanobot context; cancel that prepared dispatch with the context recovery interface before gateway recovery",
        );
      }
    }

    // Apply host security and context selection only after every prepared dispatch passes the replay guard.
    await root.commit(async (tx) => {
      let cursor: Cursor | undefined;
      do {
        const page = await tx.scanConversations({}, 1000, cursor);
        for (const conversation of page.items) {
          const state = await tx.doc(AgentDoc, conversation.id);
          await configure(tx, conversation.id, { ...policyForState(state), ...contextAgentPolicy(conversation.id) });
        }
        cursor = page.next;
      } while (cursor !== undefined);
    }, context);

    const gateway: Gateway = {
      harness,
      async conversationFor(sessionKey, ctx) {
        const key = encodedSessionKey(sessionKey);
        let conversationId: ConversationId | undefined;
        await root.commit(async (tx) => {
          const map = await tx.doc(SessionMap, root.id);
          if (Object.hasOwn(map.sessions, key)) {
            conversationId = map.sessions[key] as ConversationId;
            return;
          }
          if (options.contextSnapshotProvider && Object.keys(map.sessions).length >= CONTEXT_LIMITS.maxConversations) {
            throw new Error(`Context snapshots support at most ${CONTEXT_LIMITS.maxConversations} mapped conversations`);
          }
          const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
          await configure(tx, created.id, { ...defaultAgentPolicy, ...contextAgentPolicy(created.id) });
          map.sessions[key] = created.id as number;
          conversationId = created.id;
        }, ctx);
        if (!Number.isSafeInteger(conversationId)) throw new Error("Stored conversation mapping has an invalid ID");
        const conversation = await harness!.conversation(conversationId!, ctx);
        if (!conversation) throw new Error("Stored conversation mapping points to a missing conversation");
        await ensureContextSnapshot(sessionKey, conversationId!, ctx);
        // Read and reapply host policy atomically so concurrent selection cannot be overwritten.
        await applyConversationPolicy(conversation, ctx);
        return conversation;
      },
      async listModels(sessionKey, ctx) {
        const conversation = await existingConversationFor(sessionKey, ctx);
        await applyConversationPolicy(conversation, ctx);
        const state = await harness!.snapshot(AgentDoc, conversation.id, ctx);
        const choice = choiceFromState(state) ?? defaultChoice;
        const level = state?.thinkingLevel !== undefined && choice.thinkingLevels.includes(state.thinkingLevel)
          ? state.thinkingLevel
          : fallbackThinkingLevel(choice);
        return { models: choices.map(publicChoice), selected: publicSelection(choice, level) };
      },
      async selectModel(sessionKey, selection, ctx) {
        if (!isModelSelection(selection)) throw new Error("Model selection requires provider and modelId strings");
        const target = choicesByConfigured.get(modelKey(selection));
        if (!target) throw new Error("Model is not in the configured allowlist");
        const requestedLevel = Object.hasOwn(selection, "thinkingLevel") ? selection.thinkingLevel : undefined;
        if (requestedLevel !== undefined && !target.thinkingLevels.includes(requestedLevel)) {
          throw new Error(`Unsupported thinkingLevel ${requestedLevel} for ${selection.provider}/${selection.modelId}`);
        }
        const conversation = await existingConversationFor(sessionKey, ctx);
        const level = await conversation.commit(async (tx) => {
          const state = await tx.doc(AgentDoc, conversation.id);
          const current = choiceFromState(state);
          const live = await tx.doc(LiveDoc, conversation.id);
          if (live.run !== undefined) throw new ConversationBusy(conversation.id);
          const changed = current === undefined || modelKey(current.native) !== modelKey(target.native);
          const currentLevel = current !== undefined && state.thinkingLevel !== undefined && current.thinkingLevels.includes(state.thinkingLevel)
            ? state.thinkingLevel
            : fallbackThinkingLevel(current ?? defaultChoice);
          const nextLevel = requestedLevel ?? (changed
            ? fallbackThinkingLevel(target)
            : target.thinkingLevels.includes(currentLevel) ? currentLevel : fallbackThinkingLevel(target));
          await configure(tx, conversation.id, { ...hostPolicy, model: target.native, thinkingLevel: nextLevel });
          return nextLevel;
        }, ctx);
        return publicSelection(target, level);
      },
      async close(ctx) {
        if (closed) return;
        closed = true;
        try { await harness!.close(withoutAbortSignal(ctx)); }
        finally { await releaseLock(); }
      },
    };
    async function existingConversationFor(sessionKey: string, ctx: Context): Promise<Conversation> {
      const key = encodedSessionKey(sessionKey);
      const map = await harness!.snapshot(SessionMap, root.id, ctx);
      const id = map && Object.hasOwn(map.sessions, key) ? map.sessions[key] : undefined;
      if (!Number.isSafeInteger(id)) throw new Error("Unknown session key");
      const conversation = await harness!.conversation(id as ConversationId, ctx);
      if (!conversation) throw new Error("Stored conversation mapping points to a missing conversation");
      return conversation;
    }
    // Scheduling begins only after registry and all persisted conversation policies are ready.
    harness.resume();
    return gateway;
  } catch (error) {
    try {
      const cleanup = withoutAbortSignal(context);
      if (harness) await harness.close(cleanup);
      else await storage?.close(cleanup);
    } finally { await releaseLock(); }
    throw error;
  }
}
