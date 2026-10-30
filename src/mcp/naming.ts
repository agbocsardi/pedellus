import { createHash } from "node:crypto";

/**
 * MCP tool naming, matching the coding agent's scheme so scripts and documentation read the same
 * way: `mcp__<server>__<tool>`, with every character outside `[A-Za-z0-9_]` replaced by `_`.
 *
 * Sanitizing can map two tools to one name (`a-b` and `a_b`). Every tool of such a group, and every
 * name over the provider length limit, gets an 8-hex-character SHA-256 suffix derived from the
 * exact `server\0tool` pair. The result therefore depends on the server's tool set, not on the order
 * the server listed the tools in.
 */
export const MCP_TOOL_PREFIX = "mcp__";
/** Providers allow at most 64 characters of `[A-Za-z0-9_-]`. */
export const MCP_TOOL_NAME_MAX = 64;

/** Namespace name of a server: `mcp__<name>` with `-` replaced by `_`. */
export function mcpNamespaceName(server: string): string {
  return `mcp__${server.replace(/-/g, "_")}`;
}

/** Prefix every tool of a server shares, for the Code Mode namespace. */
export function mcpToolPrefix(server: string): string {
  return `${mcpNamespaceName(server)}__`;
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}

function hashSuffix(server: string, tool: string): string {
  return createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
}

/** A name over the provider limit, or one that must not keep its plain form, with a hash and then a counter. */
function suffixed(name: string, server: string, tool: string, taken: ReadonlySet<string>): string {
  const base = `${name.slice(0, MCP_TOOL_NAME_MAX - 9)}_${hashSuffix(server, tool)}`;
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const suffix = `_${index}`;
    const candidate = `${base.slice(0, MCP_TOOL_NAME_MAX - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Registration names of one server's tools, keyed by the server's own tool name. Tool names are
 * de-duplicated first (a server that lists the same name twice offers one tool), and the result is
 * deterministic for a given tool set.
 */
export function mcpToolNames(server: string, tools: readonly string[]): ReadonlyMap<string, string> {
  const unique = [...new Set(tools)].sort((left, right) => left.localeCompare(right, "en-US"));
  const plain = new Map(unique.map((tool) => [tool, sanitize(`${mcpToolPrefix(server)}${tool}`)]));
  const counts = new Map<string, number>();
  for (const name of plain.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
  const taken = new Set<string>();
  const names = new Map<string, string>();
  for (const tool of unique) {
    const candidate = plain.get(tool)!;
    // Every member of a colliding group is suffixed, so which tool keeps the plain name does not
    // depend on the order the server listed them in.
    const collides = (counts.get(candidate) ?? 0) > 1;
    const name = collides || candidate.length > MCP_TOOL_NAME_MAX || taken.has(candidate)
      ? suffixed(candidate, server, tool, taken)
      : candidate;
    taken.add(name);
    names.set(tool, name);
  }
  return names;
}
