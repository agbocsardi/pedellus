import type { MemoryBackend, MemoryHost } from "./contracts.js";
import { createHistoryBrowser } from "./history-browse.js";
import { createHistoryReader } from "./history-read.js";
import { createHistorySearcher } from "./history-search.js";

/** Compose the read-only history discovery, browsing and original-reading surfaces. */
export function createHistoryBackend(host: MemoryHost): MemoryBackend {
  const searcher = createHistorySearcher(host);
  const browser = createHistoryBrowser(host);
  const reader = createHistoryReader(host);
  return {
    search: searcher.search,
    browse: browser.browse,
    read: reader.read,
    close(): void {
      searcher.close();
      browser.close?.();
      reader.close?.();
    },
  };
}
