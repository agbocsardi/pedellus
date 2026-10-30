import type { WebTransport } from "./fetch.js";
import type { WebResolver } from "./resolver.js";
import type { WebSearchTransport } from "./search.js";

export type { WebConfig, WebSearchConfig } from "./config.js";
export { parseWebConfig } from "./config.js";
export {
  PublicWebFetcher,
  WEB_FETCH_LIMITS,
  WebFetchError,
  nativeWebTransport,
  type WebFetchErrorCode,
  type WebFetchResult,
  type WebTransport,
  type WebTransportRequest,
  type WebTransportResponse,
} from "./fetch.js";
export { extractHtml, type HtmlExtraction } from "./html.js";
export { nativeWebResolver, type WebResolver } from "./resolver.js";
export {
  BRAVE_PROVIDER_LABEL,
  BraveSearchClient,
  WEB_SEARCH_LIMITS,
  WebSearchError,
  nativeWebSearchTransport,
  type BraveSearchClientOptions,
  type WebSearchErrorCode,
  type WebSearchResponse,
  type WebSearchResult,
  type WebSearchTransport,
} from "./search.js";
export {
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WEB_TOOL_NAMES,
  createWebToolExtension,
  formatFetchResult,
  formatSearchResponse,
  type WebToolOptions,
} from "./tools.js";

/**
 * Host seams for the native web tools. Only tests inject these; no shipped
 * configuration field selects a transport, resolver or clock.
 */
export interface WebRuntimeOptions {
  /** Environment snapshot used to resolve `web.search.keyEnv`. */
  readonly env?: NodeJS.ProcessEnv;
  readonly searchTransport?: WebSearchTransport;
  readonly fetchTransport?: WebTransport;
  readonly resolver?: WebResolver;
  readonly now?: () => Date;
}
