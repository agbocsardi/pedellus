import { chmod, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { processLock } from "@earendil-works/chord/node";
import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { configure, createRegistry, defineDoc, Harness, type AgentChange, type Conversation, type ConversationId, type Cursor, type Harness as HarnessType, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { PortConfig } from "./config.js";
import { createProviderModels } from "./providers.js";

const SessionMap = defineDoc<{ sessions: Record<string, number> }>({
  kind: "nanobot.session-map", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ sessions: {} }), checkpointWhen: () => true,
});

export interface Gateway {
  readonly harness: HarnessType;
  conversationFor(sessionKey: string, context: Context): Promise<Conversation>;
  close(context: Context): Promise<void>;
}

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function canonicalFuturePath(path: string): Promise<string> {
  const target = resolve(path);
  let existing = target;
  const tail: string[] = [];
  while (true) {
    try {
      const canonical = await realpath(existing);
      return resolve(canonical, ...tail.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = resolve(existing, "..");
      if (parent === existing) throw error;
      tail.push(relative(parent, existing));
      existing = parent;
    }
  }
}

function encodedSessionKey(key: string): string {
  if (!key) throw new Error("sessionKey must not be empty");
  return `k:${Buffer.from(key, "utf8").toString("base64url")}`;
}

export async function openGateway(config: PortConfig, context: Context, options: { models?: Models } = {}): Promise<Gateway> {
  const prepared = options.models ? { models: options.models, model: config.model } : createProviderModels(config);
  const { models, model } = prepared;
  if (!models.getModel(model.provider, model.modelId)) throw new Error(`Unknown model ${model.provider}/${model.modelId}`);
  const workspace = await realpath(config.workspace);
  if (!(await stat(workspace)).isDirectory()) throw new Error("workspace must be a directory");
  const extraRoots = await Promise.all((config.extraAllowedDirs ?? []).map(async (p) => {
    const root = await realpath(p);
    if (!(await stat(root)).isDirectory()) throw new Error(`extraAllowedDirs entry is not a directory: ${p}`);
    return root;
  }));
  const roots = [workspace, ...extraRoots];
  const dataDir = await canonicalFuturePath(config.dataDir);
  if (roots.some((root) => inside(dataDir, root) || inside(root, dataDir))) {
    throw new Error("dataDir must be disjoint from workspace and extraAllowedDirs");
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const canonicalDataDir = await realpath(dataDir);
  if (roots.some((root) => inside(canonicalDataDir, root) || inside(root, canonicalDataDir))) {
    throw new Error("dataDir resolves inside or above workspace/extraAllowedDirs");
  }
  await chmod(canonicalDataDir, 0o700);
  const dbPath = resolve(canonicalDataDir, "nanobot.sqlite");
  try {
    const stat = await lstat(dbPath);
    if (!stat.isFile()) throw new Error("SQLite database path must be a regular file, not a symlink or special file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const releaseLock = await processLock(`nanobot:${dbPath}`);
  let harness: HarnessType | undefined;
  let storage: Storage | undefined;
  let closed = false;
  try {
    const registry = createRegistry();
    storage = await openNodeSqliteStorage(dbPath);
    harness = await Harness.open(storage, { models, registry }, context);
    const agentPolicy: AgentChange = {
      model,
      cwd: workspace,
      tools: [],
      modelTools: [],
      ...(config.thinkingLevel === undefined ? {} : { thinkingLevel: config.thinkingLevel }),
    };
    const root = await harness.root(context, { agent: agentPolicy });
    await root.configure(agentPolicy, context);

    // Reapply host-owned policy to every persisted conversation before any task can resume.
    await root.commit(async (tx) => {
      let cursor: Cursor | undefined;
      do {
        const page = await tx.scanConversations({}, 1000, cursor);
        for (const conversation of page.items) await configure(tx, conversation.id, agentPolicy);
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
          const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
          await configure(tx, created.id, agentPolicy);
          map.sessions[key] = created.id as number;
          conversationId = created.id;
        }, ctx);
        const conversation = await harness!.conversation(conversationId!, ctx);
        if (!conversation) throw new Error("Stored conversation mapping points to a missing conversation");
        // Enforce current host policy on every acquisition, even if state was externally altered.
        await conversation.configure(agentPolicy, ctx);
        return conversation;
      },
      async close(ctx) {
        if (closed) return;
        closed = true;
        try { await harness!.close(withoutAbortSignal(ctx)); }
        finally { await releaseLock(); }
      },
    };
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
