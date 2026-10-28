import { processLock } from "@earendil-works/chord/node";
import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { AgentDoc, configure, ConversationBusy, createRegistry, defineDoc, Harness, LiveDoc, type AgentChange, type AgentState, type Conversation, type ConversationId, type Cursor, type EntryId, type Extension, type Harness as HarnessType, type ModelRef, type Storage, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { CONTEXT_LIMITS, createContextExtensionBuilder, type ConversationContextSnapshot } from "./context/index.js";
import { parseToolTimeoutSeconds, type ModelReference, type PortConfig } from "./config.js";
import { hasPersistedNanobotContext, preparedContextReplay, preparedTaskModel } from "./recovery/prepared.js";
import { prepareDataDirectory } from "./store.js";
import { openFullSyncNodeSqliteStorage } from "./storage/sqlite.js";
import { createProviderModels, nativeModelReference, resolveModelChoices, type ResolvedModelChoice } from "./providers.js";
import {
  CODING_TOOL_NAMES,
  ToolGrantDoc,
  activeToolGrants,
  createCodingToolExtension,
  createToolEnvironments,
  normalizeToolGrants,
  pruneToolGrants,
  type CodingToolName,
  type GatewayToolGrant,
  type ToolEnvironments,
} from "./tools/index.js";

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
  /** Active, unexpired grants for a known session; empty when tools are disabled. */
  listToolGrants(sessionKey: string, context: Context): Promise<readonly GatewayToolGrant[]>;
  /**
   * Adds explicit expiring grants for a known session. Every name must be inside the host ceiling and
   * every expiry must be in the future; a conversation never receives an implicit or permanent grant.
   */
  grantTools(sessionKey: string, grants: unknown, context: Context): Promise<readonly GatewayToolGrant[]>;
  /** Revokes grants by name. Revocation is persisted and survives reopen; unknown names are ignored. */
  revokeTools(sessionKey: string, names: readonly string[], context: Context): Promise<readonly GatewayToolGrant[]>;
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
  // A config name is not a Durable registration identity or an authorization grant. Only the four
  // native coding tools have reviewed registrations; anything else fails closed before setup.
  const toolAllowlist = config.toolAllowlist ?? [];
  const unavailableTools = toolAllowlist.filter(
    (name) => !(CODING_TOOL_NAMES as readonly string[]).includes(name),
  );
  if (unavailableTools.length > 0) {
    throw new Error(
      `toolAllowlist names unsupported tools: ${unavailableTools.join(", ")} ` +
      "(no approved registered tools)",
    );
  }
  const toolsEnabled = toolAllowlist.length > 0;
  // Fail at startup, not at the first tool call, when the default cannot be represented by the host shell.
  const toolTimeoutSeconds = parseToolTimeoutSeconds(config.toolTimeoutSeconds);
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
  const { workspace, extraRoots, dbPath } = await prepareDataDirectory(config);
  const hostPolicy: AgentChange = { cwd: workspace };
  const defaultAgentPolicy: AgentChange = {
    ...hostPolicy,
    model,
    thinkingLevel: defaultThinkingLevel,
    tools: [],
    modelTools: [],
  };
  const now = () => Date.now();
  // Mirrors the shared policy's config-level default so a host-default timeout reports its duration.
  const defaultTimeoutSeconds = toolTimeoutSeconds ?? 60;
  const toolExtension: Extension | undefined = toolsEnabled
    ? createCodingToolExtension({
        tools: toolAllowlist as readonly CodingToolName[],
        ceiling: toolAllowlist,
        defaultTimeoutSeconds,
        now,
      })
    : undefined;
  const toolEnvironments: ToolEnvironments | undefined = toolsEnabled
    ? createToolEnvironments({
        workspaceRoot: workspace,
        allowedRoots: extraRoots,
        ...(toolTimeoutSeconds === undefined ? {} : { timeoutSeconds: toolTimeoutSeconds }),
      })
    : undefined;
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
  const extensionsPolicy = (conversationId: ConversationId): AgentChange => {
    const add: Extension[] = [];
    const remove: Extension[] = [];
    if (toolExtension) add.push(toolExtension);
    if (options.contextSnapshotProvider && contextExtension) {
      if (contextConversations.has(conversationId)) add.push(contextExtension);
      else remove.push(contextExtension);
    }
    if (add.length === 0 && remove.length === 0) return { extensions: [] };
    return {
      extensions: {
        ...(add.length === 0 ? {} : { add }),
        ...(remove.length === 0 ? {} : { remove }),
      },
    };
  };
  const toolRegistrations = new Map<string, ToolRegistration>(
    (toolExtension?.tools ?? []).map((tool) => [tool.name, tool]),
  );
  const toolFilterFromNames = (
    names: readonly string[],
  ): Pick<AgentChange, "tools" | "modelTools"> => {
    const tools = names.flatMap((name) => {
      const tool = toolRegistrations.get(name);
      return tool === undefined ? [] : [tool];
    });
    return { tools, modelTools: tools };
  };
  const toolFilterFor = async (
    tx: Tx,
    conversationId: ConversationId,
  ): Promise<Pick<AgentChange, "tools" | "modelTools">> => {
    if (!toolExtension) {
      // Retire instead of creating an empty document: a disabled ceiling must durably remove
      // previously granted tools so re-enabling it cannot resurrect them.
      await tx.retireDoc(ToolGrantDoc, conversationId);
      return { tools: [], modelTools: [] };
    }
    const document = await tx.doc(ToolGrantDoc, conversationId);
    return toolFilterFromNames(pruneToolGrants(document, toolAllowlist, now()));
  };
  const denyNewConversation = async (
    tx: Tx,
    conversation: { readonly id: ConversationId },
  ): Promise<void> => {
    // Every native creation path, including forks and raw/task-created conversations, starts denied.
    // The grant document is retired so a fork's copied agent state can never inherit authority.
    await tx.retireDoc(ToolGrantDoc, conversation.id);
    await configure(tx, conversation.id, { tools: [], modelTools: [] });
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
      const toolFilter = await toolFilterFor(tx, conversation.id);
      await configure(tx, conversation.id, {
        ...policyForState(state),
        ...extensionsPolicy(conversation.id),
        ...toolFilter,
      });
    }, ctx);
  }
  const releaseLock = await processLock(`nanobot:${dbPath}`);
  let harness: HarnessType | undefined;
  let storage: Storage | undefined;
  let closed = false;
  try {
    const registry = createRegistry();
    if (toolExtension) registry.install(toolExtension);
    storage = await openFullSyncNodeSqliteStorage(dbPath, context);
    const harnessOptions = {
      models,
      registry,
      conversationCreated: denyNewConversation,
      ...(toolEnvironments === undefined
        ? {}
        : {
            env: (target: { readonly conversationId: ConversationId }, ctx: Context) =>
              toolEnvironments.forConversation(target.conversationId, ctx),
          }),
    };
    harness = await Harness.open(storage, harnessOptions, context);
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

    // Apply host security, grants and context selection only after every prepared dispatch passes the replay guard.
    // Pruning expired/revoked grants before resume is what keeps a revoked tool from replaying.
    await root.commit(async (tx) => {
      let cursor: Cursor | undefined;
      do {
        const page = await tx.scanConversations({}, 1000, cursor);
        for (const conversation of page.items) {
          const state = await tx.doc(AgentDoc, conversation.id);
          const toolFilter = await toolFilterFor(tx, conversation.id);
          await configure(tx, conversation.id, {
            ...policyForState(state),
            ...extensionsPolicy(conversation.id),
            ...toolFilter,
          });
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
          const toolFilter = await toolFilterFor(tx, created.id);
          await configure(tx, created.id, {
            ...defaultAgentPolicy,
            ...extensionsPolicy(created.id),
            ...toolFilter,
          });
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
          const toolFilter = await toolFilterFor(tx, conversation.id);
          await configure(tx, conversation.id, {
            ...hostPolicy,
            model: target.native,
            thinkingLevel: nextLevel,
            ...toolFilter,
          });
          return nextLevel;
        }, ctx);
        return publicSelection(target, level);
      },
      async listToolGrants(sessionKey, ctx) {
        if (!toolExtension) return [];
        const conversation = await existingConversationFor(sessionKey, ctx);
        const document = await harness!.snapshot(ToolGrantDoc, conversation.id, ctx);
        return document === undefined ? [] : activeToolGrants(document, toolAllowlist, now());
      },
      async grantTools(sessionKey, grants, ctx) {
        if (!toolExtension) throw new Error("Tools are disabled: toolAllowlist is empty");
        const normalized = normalizeToolGrants(grants, toolAllowlist, now());
        const conversation = await existingConversationFor(sessionKey, ctx);
        return conversation.commit(async (tx) => {
          const document = await tx.doc(ToolGrantDoc, conversation.id);
          for (const grant of normalized) document.grants[grant.name] = grant.expiresAt;
          const timestamp = now();
          const active = pruneToolGrants(document, toolAllowlist, timestamp);
          await configure(tx, conversation.id, toolFilterFromNames(active));
          return activeToolGrants(document, toolAllowlist, timestamp);
        }, ctx);
      },
      async revokeTools(sessionKey, names, ctx) {
        if (!toolExtension) throw new Error("Tools are disabled: toolAllowlist is empty");
        if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || name.length === 0)) {
          throw new TypeError("Tool revocations must be an array of non-empty tool names");
        }
        const conversation = await existingConversationFor(sessionKey, ctx);
        return conversation.commit(async (tx) => {
          const document = await tx.doc(ToolGrantDoc, conversation.id);
          for (const name of new Set(names)) delete document.grants[name];
          const timestamp = now();
          const active = pruneToolGrants(document, toolAllowlist, timestamp);
          await configure(tx, conversation.id, toolFilterFromNames(active));
          return activeToolGrants(document, toolAllowlist, timestamp);
        }, ctx);
      },
      async close(ctx) {
        if (closed) return;
        closed = true;
        const cleanup = withoutAbortSignal(ctx);
        try { await harness!.close(cleanup); }
        finally {
          try { await toolEnvironments?.close(cleanup); }
          finally { await releaseLock(); }
        }
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
    const cleanup = withoutAbortSignal(context);
    try {
      if (harness) await harness.close(cleanup);
      else await storage?.close(cleanup);
    } finally {
      await toolEnvironments?.close(cleanup).catch(() => undefined);
      await releaseLock();
    }
    throw error;
  }
}
