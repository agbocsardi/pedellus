/**
 * Native Brave web search: one provider, one fixed HTTPS origin, one endpoint.
 *
 * The endpoint, header and response shape follow the Brave Search API
 * (`GET https://api.search.brave.com/res/v1/web/search`) and the proven
 * @juicesharp/rpiv-web-tools provider contract; see THIRD_PARTY_NOTICES.md.
 * This adaptation adds bounded body/timeout handling and sanitized fixed
 * errors, and keeps the subscription token out of every result and log.
 */
const BRAVE_SEARCH_ORIGIN = "https://api.search.brave.com";
const BRAVE_SEARCH_PATH = "/res/v1/web/search";

export const WEB_SEARCH_LIMITS = Object.freeze({
  /** Brave accepts 1-20; the tool deliberately exposes a narrower, cheaper range. */
  minCount: 1,
  maxCount: 10,
  defaultCount: 5,
  /** Brave's documented query bound. */
  maxQueryChars: 600,
  maxQueryWords: 75,
  maxTitleChars: 300,
  maxSnippetChars: 500,
  maxBodyBytes: 1024 * 1024,
  totalTimeoutMs: 15_000,
});

export const BRAVE_PROVIDER_LABEL = "Brave";

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface WebSearchResponse {
  readonly query: string;
  readonly requestedCount: number;
  readonly provider: typeof BRAVE_PROVIDER_LABEL;
  readonly results: readonly WebSearchResult[];
}

/** Narrow response surface so tests can supply a controlled transport. */
export interface WebSearchTransportResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: (AsyncIterable<Uint8Array> & { cancel?(reason?: unknown): Promise<void> }) | null;
}

export type WebSearchTransport = (
  url: URL,
  init: {
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
    readonly redirect: "error";
  },
) => Promise<WebSearchTransportResponse>;

export type WebSearchErrorCode =
  | "credential"
  | "http"
  | "network"
  | "timeout"
  | "cancelled"
  | "response"
  | "too-large";

export class WebSearchError extends Error {
  constructor(
    readonly code: WebSearchErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "WebSearchError";
  }
}

/** The process-default transport. No proxy environment and no ambient auth. */
export function nativeWebSearchTransport(): WebSearchTransport {
  return async (url, init) => {
    const response = await globalThis.fetch(url, {
      method: "GET",
      headers: init.headers,
      signal: init.signal,
      redirect: init.redirect,
    });
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      body: response.body,
    };
  };
}

export interface BraveSearchClientOptions {
  /** Resolved subscription token; read from the configured environment variable once. */
  readonly apiKey: string;
  readonly transport?: WebSearchTransport;
}

export interface BraveSearchOptions {
  /** Caller cancellation, combined with the client's own total deadline. */
  readonly signal?: AbortSignal;
  readonly count?: number;
}

function clampCount(value: number | undefined): number {
  if (value === undefined) return WEB_SEARCH_LIMITS.defaultCount;
  if (!Number.isSafeInteger(value)) return WEB_SEARCH_LIMITS.defaultCount;
  return Math.min(Math.max(value, WEB_SEARCH_LIMITS.minCount), WEB_SEARCH_LIMITS.maxCount);
}

/** One line, control characters removed, bounded. Untrusted text never becomes structure. */
function oneLine(value: string, maxChars: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function webUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (parsed.username !== "" || parsed.password !== "") return undefined;
  return parsed.toString();
}

async function readBoundedBody(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const iterator = body[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done === true) break;
      const chunk = next.value;
      if (total + chunk.byteLength > maxBytes) {
        throw new WebSearchError("too-large", "Brave Search API response was too large.");
      }
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    // A rejected or abandoned read must not leave the response stream open.
    if (typeof iterator.return === "function") await iterator.return().catch(() => undefined);
  }
  return Buffer.concat(chunks, total);
}

export class BraveSearchClient {
  readonly #transport: WebSearchTransport;
  readonly #apiKey: string;

  constructor(options: BraveSearchClientOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.trim() === "") {
      throw new WebSearchError(
        "credential",
        "Web search is not configured with a usable Brave API key.",
      );
    }
    this.#apiKey = options.apiKey;
    this.#transport = options.transport ?? nativeWebSearchTransport();
  }

  async search(query: string, options: BraveSearchOptions = {}): Promise<WebSearchResponse> {
    const text = query.trim();
    if (text.length === 0 || text.length > WEB_SEARCH_LIMITS.maxQueryChars) {
      throw new WebSearchError(
        "response",
        `The search query must be 1-${WEB_SEARCH_LIMITS.maxQueryChars} characters.`,
      );
    }
    if (text.split(/\s+/).length > WEB_SEARCH_LIMITS.maxQueryWords) {
      throw new WebSearchError(
        "response",
        `The search query must be at most ${WEB_SEARCH_LIMITS.maxQueryWords} words.`,
      );
    }
    const count = clampCount(options.count);
    // Fixed origin and path: the model supplies a query and a count, never a host.
    const url = new URL(BRAVE_SEARCH_PATH, BRAVE_SEARCH_ORIGIN);
    url.searchParams.set("q", text);
    url.searchParams.set("count", String(count));

    const deadline = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      deadline.abort();
    }, WEB_SEARCH_LIMITS.totalTimeoutMs);
    const onAbort = () => deadline.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await this.#transport(url, {
        headers: {
          accept: "application/json",
          "accept-encoding": "identity",
          "x-subscription-token": this.#apiKey,
        },
        signal: deadline.signal,
        redirect: "error",
      });
      if (!response.ok) {
        // Status only: a provider body can echo request details and must not reach the model.
        // Release the body rather than keeping a socket and unread bytes alive.
        await response.body?.cancel?.().catch(() => undefined);
        throw new WebSearchError(
          "http",
          `Brave Search API returned HTTP ${response.status}.`,
          response.status,
        );
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > WEB_SEARCH_LIMITS.maxBodyBytes) {
        await response.body?.cancel?.().catch(() => undefined);
        throw new WebSearchError("too-large", "Brave Search API response was too large.");
      }
      const body = response.body;
      if (body === null) throw new WebSearchError("response", "Brave Search API returned an invalid response.");
      let raw: unknown;
      try {
        raw = JSON.parse(new TextDecoder("utf-8").decode(await readBoundedBody(body, WEB_SEARCH_LIMITS.maxBodyBytes)));
      } catch (error) {
        if (error instanceof WebSearchError) throw error;
        throw new WebSearchError("response", "Brave Search API returned an invalid response.");
      }
      return { query: text, requestedCount: count, provider: BRAVE_PROVIDER_LABEL, results: normalize(raw, count) };
    } catch (error) {
      if (error instanceof WebSearchError) throw error;
      if (timedOut) throw new WebSearchError("timeout", "Brave Search API request timed out.");
      if (options.signal?.aborted === true) {
        throw new WebSearchError("cancelled", "Brave Search API request was cancelled.");
      }
      throw new WebSearchError("network", "Brave Search API request failed.");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
}

function normalize(raw: unknown, count: number): WebSearchResult[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WebSearchError("response", "Brave Search API returned an invalid response.");
  }
  const web = (raw as Record<string, unknown>).web;
  if (web === undefined) return [];
  if (web === null || typeof web !== "object" || Array.isArray(web)) {
    throw new WebSearchError("response", "Brave Search API returned an invalid response.");
  }
  const rawResults = (web as Record<string, unknown>).results;
  if (rawResults === undefined) return [];
  if (!Array.isArray(rawResults)) {
    throw new WebSearchError("response", "Brave Search API returned an invalid response.");
  }
  const results: WebSearchResult[] = [];
  for (const entry of rawResults) {
    if (results.length >= count) break;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const url = webUrl(record.url);
    if (url === undefined) continue;
    results.push({
      title: oneLine(typeof record.title === "string" ? record.title : "", WEB_SEARCH_LIMITS.maxTitleChars),
      url,
      snippet: oneLine(typeof record.description === "string" ? record.description : "", WEB_SEARCH_LIMITS.maxSnippetChars),
    });
  }
  return results;
}
