/**
 * Host prompt snapshots: one `nanobot-context` extension holding every installed conversation's
 * workspace sections, the read-only on-demand `skill` loader, and the bounded snapshot slots.
 *
 * A mapped chat is installed once per process; a background target is rebuilt on every run, because
 * each scheduled run is a new episode that must render the workspace as it is now. Both reuse the one
 * extension name, so a rebuild replaces that conversation's sections instead of adding another
 * extension. Snapshot content is metadata only and adds no tool authority; the authority policy
 * decides selection from `has`/`hasSkills`.
 */
import type { Context } from "@earendil-works/chord";
import {
  ConversationBusy,
  InboxDoc,
  LiveDoc,
  ResetEntry,
  type Conversation,
  type ConversationId,
  type Extension,
  type Harness as HarnessType,
  type Tx,
} from "@earendil-works/pi-durable";
import {
  CONTEXT_LIMITS,
  createContextExtension,
  createContextExtensionBuilder,
  type ConversationContextSnapshot,
} from "../context/index.js";
import { createSkillTool } from "../context/skill-tool.js";
import { appendIdleRolloverReset, type IdleRolloverReset } from "../history/idle-rollover.js";
import { AskQuestionsDoc, cancelPendingQuestions } from "../questions/index.js";
import type { CommitEffects, ContextOverlay } from "./authority.js";
import { SessionMap } from "./sessions.js";
import type { GatewayContextSnapshotProvider, GatewaySessionReset } from "./types.js";

function bindContextSnapshot(value: object | undefined, conversationId: ConversationId): ConversationContextSnapshot {
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (value !== undefined) {
    for (const key of ["identity", "agents", "soul", "user", "memory", "skills", "skillSummary"]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && Object.hasOwn(descriptor, "value")) snapshot[key] = descriptor.value;
    }
  }
  snapshot.conversationId = conversationId;
  return snapshot as unknown as ConversationContextSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function countSnapshotSkills(conversationId: ConversationId, snapshot: ConversationContextSnapshot): number {
  return createSkillTool().setConversation(conversationId, snapshot).skills;
}

export interface ContextHostOptions {
  /** Explicit host-owned snapshots; absent, no context extension and no skill loader exist. */
  readonly provider: GatewayContextSnapshotProvider | undefined;
  readonly now: () => number;
  /** A mapped session's snapshot owns its slot and is never evicted for another conversation. */
  readonly isMapped: (id: ConversationId) => boolean;
  /** Post-commit publication for in-tx snapshot installations and refreshes. */
  readonly effects: CommitEffects;
}

/** What installing and refreshing need from the open gateway, bound once the harness is open. */
export interface ContextHostBinding {
  readonly harness: HarnessType;
  readonly root: Conversation;
  readonly install: (extension: Extension) => void;
  /** Encoded keys of archived app threads: mapped, but their idle snapshots are evictable. */
  readonly archivedSessionKeys: (tx: Tx) => Promise<Set<string>>;
  /** Reapply the conversation's extension selection and tool filter in this commit. */
  readonly applyPolicy: (tx: Tx, id: ConversationId, contextOverride?: ContextOverlay) => Promise<void>;
}

export type ContextHost = ReturnType<typeof createContextHost>;

export function createContextHost(options: ContextHostOptions) {
  const { provider, effects } = options;
  const builder = createContextExtensionBuilder();
  // Descriptor carrying the `nanobot-context` extension name for in-tx AgentDoc selection before
  // the first snapshot commits and publishes the real extension.
  const extensionRef: Extension | undefined = provider === undefined ? undefined : createContextExtension([]);
  let extension: Extension | undefined;
  const contextConversations = new Set<ConversationId>();
  const skillConversations = new Set<ConversationId>();
  // A read-only progressive skill loader: it serves bodies from the host snapshot only, so a
  // builtin skill outside the workspace is reachable without widening the workspace or the shell.
  const skillTool = provider === undefined ? undefined : createSkillTool();
  const loads = new Map<ConversationId, Promise<unknown>>();
  // A scheduled run's target is tracked in insertion order so the cap can drop an idle target
  // instead of failing the run, and never a mapped session's snapshot.
  const backgroundTargets: ConversationId[] = [];
  let binding: ContextHostBinding | undefined;
  const bound = (): ContextHostBinding => {
    if (binding === undefined) throw new Error("The runtime is not open");
    return binding;
  };
  const publish = (next: Extension): void => {
    extension = next;
    bound().install(next);
  };

  /** Read-only selection of one idle evictable snapshot slot; performs no in-memory mutation. */
  async function findEvictableCandidate(tx: Tx, target: ConversationId): Promise<ConversationId | undefined> {
    if (contextConversations.size < CONTEXT_LIMITS.maxConversations) return undefined;
    const { root } = bound();
    const map = await tx.doc(SessionMap, root.id);
    const candidates = backgroundTargets.filter((id) => !options.isMapped(id));
    for (const key of await bound().archivedSessionKeys(tx)) {
      const id = map.sessions[key] as ConversationId | undefined;
      if (id !== undefined) candidates.push(id);
    }
    for (const candidate of candidates) {
      if (candidate === target || !contextConversations.has(candidate) || loads.has(candidate)) continue;
      if ((await tx.doc(LiveDoc, candidate)).run !== undefined ||
          (await tx.doc(InboxDoc, candidate)).items.length > 0) continue;
      return candidate;
    }
    return undefined;
  }

  /** Apply one already-selected eviction after its read or enclosing commit has settled. */
  function applyEviction(candidate: ConversationId): void {
    if (!contextConversations.has(candidate)) return;
    const index = backgroundTargets.indexOf(candidate);
    if (index >= 0) backgroundTargets.splice(index, 1);
    contextConversations.delete(candidate);
    skillConversations.delete(candidate);
    skillTool?.removeConversation(candidate);
    publish(builder.remove(candidate));
  }

  /** Apply one validated snapshot installation in memory (post-commit when called from a tx). */
  function applySnapshot(
    conversationId: ConversationId,
    snapshot: ConversationContextSnapshot,
    backgroundTarget: boolean,
    evictCandidate: ConversationId | undefined,
  ): boolean {
    if (!contextConversations.has(conversationId) && contextConversations.size >= CONTEXT_LIMITS.maxConversations
      && evictCandidate !== undefined) {
      applyEviction(evictCandidate);
    }
    const installed = contextConversations.has(conversationId);
    if (backgroundTarget && !installed && !backgroundTargets.includes(conversationId)) {
      backgroundTargets.push(conversationId);
    }
    const replacement = installed
      ? builder.replace(snapshot)
      : { extension: builder.add(snapshot) };
    contextConversations.add(conversationId);
    let skillsPresent = false;
    if (skillTool !== undefined) {
      if (skillTool.setConversation(conversationId, snapshot).skills > 0) {
        skillConversations.add(conversationId);
        skillsPresent = true;
      } else {
        skillConversations.delete(conversationId);
      }
    }
    publish(replacement.extension);
    return skillsPresent;
  }

  /**
   * Install one conversation's workspace snapshot and report whether context and skills were
   * delivered. A mapped chat is installed once per process; a background target is rebuilt on
   * every call. When called inside a transaction (`tx !== undefined`), in-memory snapshot/skill
   * mutations are deferred via `effects.defer(tx, ...)` so a rolled-back commit never pollutes
   * snapshot slots or tables.
   */
  const install = async (
    sessionKey: string, conversationId: ConversationId, ctx: Context, backgroundTarget: boolean, tx?: Tx,
  ): Promise<ContextOverlay> => {
    if (!provider) return { hasContext: false, hasSkills: false };
    const loading = loads.get(conversationId);
    if (loading !== undefined && tx === undefined) {
      await loading;
      return { hasContext: contextConversations.has(conversationId), hasSkills: skillConversations.has(conversationId) };
    }
    const installed = contextConversations.has(conversationId);
    if (installed && !backgroundTarget) {
      return { hasContext: true, hasSkills: skillConversations.has(conversationId) };
    }
    const pending = Promise.resolve()
      .then(() => provider(sessionKey, conversationId, ctx))
      .then(async (supplied): Promise<ContextOverlay> => {
        if (supplied !== undefined && !isRecord(supplied)) {
          throw new TypeError("Context snapshot provider must return an object or undefined");
        }
        const snapshot = bindContextSnapshot(supplied, conversationId);
        // Validate snapshot structure before any slot lookup or deferred apply.
        createContextExtension([snapshot]);
        const needsRoom = !contextConversations.has(conversationId)
          && contextConversations.size >= CONTEXT_LIMITS.maxConversations;
        if (tx !== undefined) {
          const evictCandidate = needsRoom ? await findEvictableCandidate(tx, conversationId) : undefined;
          if (needsRoom && evictCandidate === undefined) {
            throw new RangeError(`At most ${CONTEXT_LIMITS.maxConversations} conversation snapshots are accepted`);
          }
          const skillsPresent = skillTool !== undefined && countSnapshotSkills(conversationId, snapshot) > 0;
          await effects.defer(tx, () => {
            applySnapshot(conversationId, snapshot, backgroundTarget, evictCandidate);
          });
          return { hasContext: true, hasSkills: skillsPresent };
        }
        const evictCandidate = needsRoom
          ? await bound().root.commit((innerTx) => findEvictableCandidate(innerTx, conversationId), ctx)
          : undefined;
        const skillsPresent = applySnapshot(conversationId, snapshot, backgroundTarget, evictCandidate);
        return { hasContext: true, hasSkills: skillsPresent };
      })
      .finally(() => {
        if (loads.get(conversationId) === pending) loads.delete(conversationId);
      });
    loads.set(conversationId, pending);
    return pending;
  };

  /**
   * Explicit same-conversation refresh: re-run the host provider and apply the new snapshot to the
   * next turn. It is opt-in, per session key, and refuses a live run. Provider or loader failure
   * leaves the captured snapshot untouched. Refresh changes no tool authority: it re-renders the
   * skills summary and replaces the on-demand skill table, while the normal policy pass reapplies
   * the configured tool filter. The refresh registers in `loads` so an install for the same
   * conversation cannot build a competing snapshot; in-memory extension and table updates are
   * deferred post-commit so a rolled-back commit leaves them untouched. `reset` appends `/new`'s
   * native reset (or an idle rollover's guarded one) in the same commit as the prompt replacement.
   */
  const refresh = async (
    sessionKey: string, conversationId: ConversationId, ctx: Context, reset: boolean | IdleRolloverReset = false,
  ): Promise<number> => {
    if (!provider) throw new Error("Context refresh requires a configured contextSnapshotProvider");
    const { harness, applyPolicy } = bound();
    // Serialize with an in-flight install or a previous refresh for this conversation.
    for (;;) {
      const loading = loads.get(conversationId);
      if (loading === undefined) break;
      await loading;
    }
    const pending = (async () => {
      const conversation = await harness.conversation(conversationId, ctx);
      if (!conversation) throw new Error("Stored conversation mapping points to a missing conversation");
      // Refuse an obvious live run before re-reading skill files; the commit below rechecks atomically.
      if ((await harness.snapshot(LiveDoc, conversationId, ctx))?.run !== undefined) {
        throw new ConversationBusy(conversationId);
      }
      const supplied = await provider(sessionKey, conversationId, ctx);
      if (supplied !== undefined && !isRecord(supplied)) {
        throw new TypeError("Context snapshot provider must return an object or undefined");
      }
      const snapshot = bindContextSnapshot(supplied, conversationId);
      createContextExtension([snapshot]);
      const skillsCount = skillTool === undefined ? 0 : countSnapshotSkills(conversationId, snapshot);
      const overlay: ContextOverlay = { hasContext: true, hasSkills: skillsCount > 0 };
      return await conversation.commit(async (tx) => {
        const live = await tx.doc(LiveDoc, conversationId);
        if (live.run !== undefined) throw new ConversationBusy(conversationId);
        await applyPolicy(tx, conversationId, overlay);
        // Idle-only reset and prompt replacement share one commit, including across multiple
        // CLI attachments. No submission can begin between the two effects.
        if (reset === true) await tx.appendEntry(conversationId, { kind: ResetEntry.kind, head: "self" });
        else if (reset !== false) await appendIdleRolloverReset(tx, conversationId, reset, options.now());
        await effects.defer(tx, () => {
          applySnapshot(conversationId, snapshot, false, undefined);
        });
        return skillsCount;
      }, ctx);
    })();
    loads.set(conversationId, pending);
    try {
      return await pending;
    } finally {
      if (loads.get(conversationId) === pending) loads.delete(conversationId);
    }
  };

  /**
   * Start a new context for one mapped chat and rebuild its host prompt snapshot in one operation; a
   * live run reports `busy` before either happens. A new context also retires questions the owner can
   * no longer meaningfully answer: existing buttons remain, and a later tap is refused with fixed text.
   */
  const resetSession = async (
    sessionKey: string, conversation: Conversation, ctx: Context,
  ): Promise<GatewaySessionReset> => {
    const cancelQuestions = () => conversation.commit(async (tx) => {
      cancelPendingQuestions(await tx.doc(AskQuestionsDoc, conversation.id));
    }, ctx);
    // Without a host prompt snapshot there is nothing to rebuild: the native reset is the whole effect.
    if (!provider) {
      await conversation.reset(undefined, ctx);
      await cancelQuestions();
      return { status: "reset", skills: 0, promptRebuilt: false };
    }
    let skills: number;
    try {
      skills = await refresh(sessionKey, conversation.id, ctx, true);
    } catch (error) {
      if (error instanceof ConversationBusy) return { status: "busy" };
      throw error;
    }
    await cancelQuestions();
    return { status: "reset", skills, promptRebuilt: true };
  };

  return {
    enabled: provider !== undefined,
    skillTool,
    bind(next: ContextHostBinding): void { binding = next; },
    /** The current context extension; `undefined` until a snapshot is installed or without a provider. */
    extension: (): Extension | undefined => extension,
    /** Extension name reference available whenever context snapshots are configured. */
    extensionRef: (): Extension | undefined => extensionRef,
    has: (id: ConversationId): boolean => contextConversations.has(id),
    hasSkills: (id: ConversationId): boolean => skillConversations.has(id),
    install,
    /** A mapped chat's snapshot, installed once per process. */
    ensure: (sessionKey: string, id: ConversationId, ctx: Context): Promise<ContextOverlay> => install(sessionKey, id, ctx, false),
    refresh,
    resetSession,
  };
}
