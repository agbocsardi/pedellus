import type { PortConfig } from "../config.js";
import type { OpenGatewayOptions } from "../runtime.js";
import { loadSkillsContext, type SkillsContextRequest } from "./skills.js";
import {
  createWorkspaceContextSnapshotProvider,
  loadWorkspaceContextSnapshot,
  type WorkspaceContextRequest,
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
 * No identity, ambient configuration, default memory file, package skill path,
 * or home directory is added. The selection is copied once and the loaders are
 * still called for each conversation, so snapshots remain detached and
 * conversation-scoped.
 *
 * Skills are discovery and prompt inclusion only: this host never runs a skill
 * as code. A selected skill body reaches the model, and the already-granted
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
  const skills = config.workspaceContext.skills;
  if (skills === undefined) {
    return {
      contextSnapshotProvider: createWorkspaceContextSnapshotProvider(() => workspace),
    };
  }
  const skillsRequest: SkillsContextRequest = Object.freeze({
    workspaceRoot: config.workspace,
    ...(skills.builtinSkillsRoot === undefined ? {} : { builtinSkillsRoot: skills.builtinSkillsRoot }),
    disabledSkills: Object.freeze([...skills.disabledSkills]),
    selectedSkills: Object.freeze([...skills.selectedSkills]),
    // Requirement gates only see PATH: the guarded shell exports this same PATH
    // and inherits no other host variable, so a `requires.env` entry for any
    // other name stays unmet instead of being satisfied by a host-only value.
    environment: Object.freeze({ PATH: process.env.PATH }),
  });
  return {
    contextSnapshotProvider: async () => {
      const [snapshot, discovered] = await Promise.all([
        loadWorkspaceContextSnapshot(workspace),
        loadSkillsContext(skillsRequest),
      ]);
      return {
        ...snapshot,
        skills: discovered.skills,
        selectedSkills: discovered.selectedSkills,
      };
    },
  };
}
