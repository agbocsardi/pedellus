import type { Context } from "@earendil-works/chord";
import type { ConversationId } from "@earendil-works/pi-durable";
import { MEMORY_TOOL_NAMES, type MemoryBackend, type MemoryHost, type MemoryPage, type MemoryReadPage, type MemoryScope, type MemoryService } from "./contracts.js";
import { decodeRef, validateQuery, validateRead } from "./validation.js";

export function createMemoryService(host: MemoryHost, backends: { notes: MemoryBackend; history: MemoryBackend }): MemoryService {
  const getScope = async (caller: ConversationId, context: Context, operation: typeof MEMORY_TOOL_NAMES[number]): Promise<MemoryScope> => host.scope(caller, context, operation);
  const service: MemoryService = {
    async search(caller, query, context): Promise<MemoryPage> {
      const valid = validateQuery(query, "search");
      const scope = await getScope(caller, context, MEMORY_TOOL_NAMES[0]);
      const backend = valid.target === "notes" ? backends.notes : backends.history;
      return backend.search(valid, scope, context);
    },
    async browse(caller, query, context): Promise<MemoryPage> {
      const valid = validateQuery(query, "browse");
      const scope = await getScope(caller, context, MEMORY_TOOL_NAMES[1]);
      const backend = valid.target === "notes" ? backends.notes : backends.history;
      return backend.browse(valid, scope, context);
    },
    async read(caller, query, context): Promise<MemoryReadPage> {
      const valid = validateRead(query);
      const scope = await getScope(caller, context, MEMORY_TOOL_NAMES[2]);
      const ref = decodeRef(valid.ref, scope.storeId);
      const backend = ref.kind === "note" ? backends.notes : backends.history;
      return backend.read(valid, ref, scope, context);
    },
    close(): void {
      const closed = new Set<MemoryBackend>();
      for (const backend of [backends.notes, backends.history]) {
        if (!closed.has(backend)) {
          closed.add(backend);
          backend.close?.();
        }
      }
    },
  };
  return service;
}
