import type { PortConfig } from "../config.js";
import type { OpenGatewayOptions } from "../runtime.js";
import {
  createWorkspaceContextSnapshotProvider,
  type WorkspaceContextRequest,
} from "./workspace.js";

export type WorkspaceContextHostConfig = Pick<PortConfig, "workspace" | "workspaceContext">;

/**
 * Gateway options for the local CLI/gateway host.
 *
 * `workspaceContext` is absent by default and yields `{}`, so the gateway
 * installs no context extension. When present, every session key receives the
 * same fixed selection: the explicit `workspace` root for the fixed bootstrap
 * files plus the explicitly named memory files. No identity, skills, ambient
 * configuration, or default memory file is added. The selection is copied once
 * and the loader is still called for each conversation, so snapshots remain
 * detached and conversation-scoped.
 */
export function workspaceContextGatewayOptions(
  config: WorkspaceContextHostConfig,
): OpenGatewayOptions {
  if (config.workspaceContext === undefined) return {};
  const request: WorkspaceContextRequest = Object.freeze({
    workspaceRoot: config.workspace,
    memoryFiles: Object.freeze([...config.workspaceContext.memoryFiles]),
  });
  return {
    contextSnapshotProvider: createWorkspaceContextSnapshotProvider(() => request),
  };
}
