/**
 * Explicit `web` configuration: a native Brave search client and/or a public
 * URL reader. Presence enables a capability; absence installs nothing and
 * exposes no tool. The coding `toolAllowlist` is unrelated authority and never
 * names these tools.
 */

export interface WebSearchConfig {
  /**
   * Environment variable holding the Brave Search subscription token. The
   * variable is read once at gateway startup; its value is never logged,
   * persisted or returned.
   */
  readonly keyEnv: string;
}

export interface WebConfig {
  /** Brave web search, enabled by naming its credential variable. */
  readonly search?: WebSearchConfig;
  /** Public `http`/`https` page reading, enabled with `"fetch": true`. */
  readonly fetch?: true;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${name} must be a plain object`);
  const copy = Object.fromEntries(Object.entries(value));
  Object.setPrototypeOf(copy, null);
  return copy;
}

function envName(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${name} must be an environment variable name`);
  }
  return value;
}

/**
 * Validate `web`. An empty object enables neither capability; an unknown field,
 * a non-boolean `fetch`, or a search block without a usable `keyEnv` is a
 * startup error rather than a silently partial installation.
 */
export function parseWebConfig(value: unknown): WebConfig {
  const raw = object(value, "web");
  for (const key of Object.keys(raw)) {
    if (key !== "search" && key !== "fetch") throw new Error(`Unknown web field: ${key}`);
  }
  let search: WebSearchConfig | undefined;
  if (raw.search !== undefined) {
    const rawSearch = object(raw.search, "web.search");
    for (const key of Object.keys(rawSearch)) {
      if (key !== "keyEnv") throw new Error(`Unknown web.search field: ${key}`);
    }
    search = Object.freeze({ keyEnv: envName(rawSearch.keyEnv, "web.search.keyEnv") });
  }
  if (raw.fetch !== undefined && raw.fetch !== true) {
    throw new Error('web.fetch must be true when present');
  }
  return Object.freeze({
    ...(search === undefined ? {} : { search }),
    ...(raw.fetch === true ? { fetch: true as const } : {}),
  });
}
