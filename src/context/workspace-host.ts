import { tmpdir } from "node:os";
import type { PortConfig } from "../config.js";
import { defaultShellEnvironment } from "../execution/policy.js";
import type { OpenGatewayOptions } from "../runtime.js";
import { loadSkillsContext, type SkillsContextRequest } from "./skills.js";
import { loadMemoryContext, type MemoryContextResult } from "./memory.js";
import {
  createWorkspaceContextSnapshotProvider,
  loadWorkspaceContextSnapshot,
  type WorkspaceContextRequest,
  type WorkspaceContextSnapshot,
} from "./workspace.js";

export type WorkspaceContextHostConfig = Pick<PortConfig, "workspace" | "workspaceContext">;

/**
 * Gateway options for the local CLI/gateway host.
 *
 * `workspaceContext` is absent by default and yields `{}`, so the gateway
 * installs no context extension. When present, every session key receives the
 * same fixed selection: the explicit `workspace` root for the fixed bootstrap
 * files plus the explicitly named memory files. Only an explicit
 * `workspaceContext.skills` section adds Markdown skill discovery, from
 * `<workspace>/skills` and, when configured, an explicit builtin skills root.
 * Only `workspaceContext.memoryManifest: true` adds the bounded `# Memory Tree`
 * manifest after those memory files; topic bodies stay on disk for the granted
 * native `read` tool. No identity, ambient configuration, default memory file,
 * package skill path, or home directory is added. The selection is copied once
 * and the loaders are still called for each conversation, so snapshots remain
 * detached and conversation-scoped.
 *
 * A loader error rejects conversation setup; no partial snapshot is installed.
 * Oversized manifests are shortened inside the helper with a visible count, not
 * rejected.
 *
 * Skills are discovery and prompt inclusion only: this host never runs a skill
 * as code. A selected skill body reaches the model, and the configured
 * `read`/`bash` tools decide what can actually be done.
 */
export function workspaceContextGatewayOptions(
  config: WorkspaceContextHostConfig,
): OpenGatewayOptions {
  if (config.workspaceContext === undefined) return {};
  const workspace: WorkspaceContextRequest = Object.freeze({
    workspaceRoot: config.workspace,
    memoryFiles: Object.freeze([...config.workspaceContext.memoryFiles]),
  });
  const memoryManifest = config.workspaceContext.memoryManifest === true;
  const skills = config.workspaceContext.skills;
  if (skills === undefined && !memoryManifest) {
    return {
      contextSnapshotProvider: createWorkspaceContextSnapshotProvider(() => workspace),
    };
  }
  const skillsRequest: SkillsContextRequest | undefined = skills === undefined
    ? undefined
    : Object.freeze({
        workspaceRoot: config.workspace,
        ...(skills.builtinSkillsRoot === undefined ? {} : { builtinSkillsRoot: skills.builtinSkillsRoot }),
        disabledSkills: Object.freeze([...skills.disabledSkills]),
        // Gates see exactly the non-secret variables the guarded shell exports (PATH, HOME,
        // TMPDIR, LANG, TERM, PYTHONUNBUFFERED); no other host variable, so a `requires.env`
        // entry for a secret or host-only name stays unmet. TMPDIR here is the host temp root
        // standing in for the per-conversation private directory.
        environment: Object.freeze(defaultShellEnvironment(config.workspace, tmpdir(), process.env)),
      });
  return {
    contextSnapshotProvider: async () => {
      const snapshot = await loadWorkspaceContextSnapshot(workspace);
      const [discovered, memory] = await Promise.all([
        skillsRequest === undefined ? undefined : loadSkillsContext(skillsRequest),
        memoryManifest
          ? loadMemoryContext({
              workspaceRoot: config.workspace,
              loadedFiles: injectedMemoryFiles(snapshot, workspace.memoryFiles ?? []),
            })
          : undefined,
      ]);
      return {
        ...withMemoryManifest(snapshot, memory),
        // The summary is what makes progressive loading work: the model learns that
        // unselected workspace and builtin skills exist, then loads a body on demand.
        ...(discovered === undefined || discovered.summary.length === 0
          ? {}
          : { skillSummary: discovered.summary }),
        ...(discovered === undefined ? {} : { skills: discovered.skills }),
      };
    },
  };
}

/**
 * Only configured files present in the snapshot were injected. An empty file is
 * omitted by the workspace loader, so the manifest must not mark it `loaded`.
 */
function injectedMemoryFiles(
  snapshot: WorkspaceContextSnapshot,
  memoryFiles: readonly string[],
): readonly string[] {
  const injected = new Set((snapshot.memory ?? []).map((document) => document.source));
  return Object.freeze(memoryFiles.filter((path) => injected.has(`workspace:${path}`)));
}

/** Append the manifest beside, not instead of, the configured memory documents. */
function withMemoryManifest(
  snapshot: WorkspaceContextSnapshot,
  memory: MemoryContextResult | undefined,
): WorkspaceContextSnapshot {
  if (memory?.document === undefined) return snapshot;
  return {
    ...snapshot,
    memory: Object.freeze([...(snapshot.memory ?? []), memory.document]),
  };
}
