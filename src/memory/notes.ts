import { constants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import type { BigIntStats, Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { MemoryBackend, MemoryCoverage, MemoryHit, MemoryPage, MemoryQuery, MemoryReadPage, MemoryRef, MemoryScope } from "./contracts.js";
import { encodeRef, decodeToken, encodeToken, hash } from "./validation.js";

const PAGE_DEFAULT = 20;
const PAGE_MAX = 100;
const TEXT_PAGE_DEFAULT = 16_384;
const TEXT_PAGE_MAX = 65_536;
const SCAN_LIMIT = 4_096;
const SNAPSHOT_LIMIT = 48;
const SNAPSHOT_TTL = 10 * 60_000;
const PREVIEW_LIMIT = 600;
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;
type Note = { path: string; fingerprint: string; description: string; size: number; mtime: string | null; matched?: boolean };
type Snapshot = { id: string; storeId: string; root: string; authority: string; queryHash: string; mode: "search" | "browse"; notes: Note[]; dirs: { path: string; offset: number; entries?: Dirent[] }[]; scanned: number; complete: boolean; unreadable: number; expires: number };
const snapshots = new Map<string, Snapshot>();

function fail(message: string): never { throw new Error(message); }
function isWithin(parent: string, child: string): boolean { const rel = relative(parent, child); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); }
function validateScope(scope: MemoryScope): { root: string; authority: string } {
  if (!scope || typeof scope.storeId !== "string" || !scope.storeId || typeof scope.workspaceRoot !== "string" || !isAbsolute(scope.workspaceRoot)) fail("Notes scope is invalid");
  const root = resolve(scope.workspaceRoot);
  if (root === sep || ["/proc", "/sys", "/dev"].some((p) => isWithin(p, root))) fail("Notes workspace is not allowed");
  const memoryFiles = configuredFiles(scope.memoryFiles);
  return { root, authority: hash({ storeId: scope.storeId, root, memoryFiles }) };
}
async function assertRoot(root: string): Promise<void> {
  const st = await lstat(root).catch(() => undefined);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) fail("Notes workspace is unavailable");
}
function pathOk(path: string): boolean { return typeof path === "string" && path.length <= 1_024 && path.startsWith("memory/") && path.endsWith(".md") && !path.includes("\\") && !CONTROL.test(path) && !path.split("/").some((p) => !p || p === "." || p === ".."); }
function configuredFiles(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) fail("Notes scope is invalid");
  const seen = new Set<string>();
  for (const path of value) { if (!pathOk(path) || seen.has(path)) fail("Notes scope is invalid"); seen.add(path); }
  return value;
}
function sortNotes(notes: Note[]): void { notes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); }
function readLimit(value: number | undefined, fallback: number, max: number): number { return value === undefined ? fallback : Math.min(max, Math.max(1, value)); }
function trimPreview(text: string): string { const s = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim(); return s.length <= PREVIEW_LIMIT ? s : `${s.slice(0, PREVIEW_LIMIT - 1)}…`; }
function parseDescription(text: string): string {
  let body = text;
  if (text.startsWith("---\n") || text.startsWith("---\r\n")) {
    const start = text.startsWith("---\r\n") ? 5 : 4;
    const end = text.indexOf("\n---", start);
    if (end >= 0) {
      for (const line of text.slice(start, end).split(/\r?\n/)) {
        const m = /^description\s*:\s*(.*)$/i.exec(line);
        if (m?.[1]) return trimPreview(m[1].trim().replace(/^['\"]|['\"]$/g, ""));
      }
      body = text.slice(end + (text[end + 4] === "\n" ? 5 : 4));
    }
  }
  for (const line of body.split(/\r?\n/)) if (/^\s*#/.test(line)) return trimPreview(line.replace(/^\s*#+\s*/, ""));
  return "(missing description)";
}
function jsonTime(note: Note) { return { from: null, to: null, undated: 1 }; }
function coverage(complete: boolean, unreadable: number, extra: Record<string, unknown> = {}): MemoryCoverage { return { complete, unreadable, undated: 0, ...extra }; }
function prune(): void {
  const now = Date.now();
  for (const [id, s] of snapshots) if (s.expires <= now) snapshots.delete(id);
  while (snapshots.size >= SNAPSHOT_LIMIT) snapshots.delete(snapshots.keys().next().value!);
}
function cursor(snapshot: Snapshot, index: number, queryHash: string): string { return encodeToken({ v: 1, id: snapshot.id, index, storeId: snapshot.storeId, root: snapshot.root, authority: snapshot.authority, queryHash }); }
function getSnapshot(token: string, scope: MemoryScope, root: string, authority: string, queryHash: string, mode: Snapshot["mode"]): { snapshot: Snapshot; index: number } {
  let value: unknown;
  try { value = decodeToken(token); } catch { return fail("Notes cursor is invalid"); }
  if (!value || typeof value !== "object") return fail("Notes cursor is invalid");
  const c = value as Record<string, unknown>;
  const s = typeof c.id === "string" ? snapshots.get(c.id) : undefined;
  if (!s || s.expires <= Date.now()) return fail("Notes snapshot expired; start again");
  if (s.storeId !== scope.storeId || s.root !== root || s.authority !== authority || s.queryHash !== queryHash || s.mode !== mode || c.storeId !== scope.storeId || c.root !== root || c.authority !== authority || c.queryHash !== queryHash || !Number.isSafeInteger(c.index) || (c.index as number) < 0) return fail("Notes cursor does not match this request or scope");
  s.expires = Date.now() + SNAPSHOT_TTL;
  return { snapshot: s, index: c.index as number };
}
async function safeParents(root: string, path: string): Promise<boolean> {
  let current = root;
  for (const segment of path.split("/").slice(0, -1)) {
    current = join(current, segment);
    const st = await lstat(current).catch(() => undefined);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return false;
  }
  return true;
}
async function fingerprint(root: string, path: string, searchTerm?: string): Promise<Note> {
  if (!pathOk(path) || !await safeParents(root, path)) throw new Error("unsafe");
  const abs = join(root, ...path.split("/"));
  const lst = await lstat(abs);
  if (lst.isSymbolicLink() || !lst.isFile() || lst.nlink !== 1) throw new Error("unsafe");
  const fd = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) throw new Error("unsafe");
    const size = Number(before.size);
    if (!Number.isSafeInteger(size)) throw new Error("unreadable");
    const h = createHash("sha256");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let desc = "";
    let searchTail = "";
    let matched = searchTerm === undefined;
    // Description and frontmatter fit in this bounded prefix; fingerprint and UTF-8 validation cover the whole file.
    let left = size, pos = 0;
    const buf = Buffer.alloc(Math.min(64 * 1024, Math.max(1, size)));
    while (left > 0) {
      const { bytesRead } = await fd.read(buf, 0, Math.min(buf.length, left), pos);
      if (!bytesRead) throw new Error("changed");
      const chunk = buf.subarray(0, bytesRead);
      h.update(chunk);
      const decoded = decoder.decode(chunk, { stream: true });
      if (desc.length < 32_768) { desc += decoded; }
      if (searchTerm !== undefined && !matched) {
        const searchable = (searchTail + decoded).toLocaleLowerCase();
        matched = searchable.includes(searchTerm.toLocaleLowerCase());
        searchTail = searchable.slice(-Math.max(1, searchTerm.length * 2));
      }
      pos += bytesRead; left -= bytesRead;
    }
    decoder.decode();
    const after = await fd.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.nlink !== after.nlink || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("changed");
    // Description parser only needs a small prefix; frontmatter is conventionally at the beginning.
    const description = parseDescription(desc);
    return { path, fingerprint: h.digest("hex"), description, size, mtime: before.mtimeNs.toString(), ...(searchTerm === undefined ? {} : { matched }) };
  } finally { await fd.close().catch(() => undefined); }
}
async function advance(snapshot: Snapshot, scope: MemoryScope, searchTerm?: string): Promise<void> {
  const candidates = new Set<string>(configuredFiles(scope.memoryFiles));
  let processed = 0;
  while (snapshot.dirs.length && processed < SCAN_LIMIT) {
    const frame = snapshot.dirs[0]!;
    if (!frame.entries) {
      try { frame.entries = await readdir(join(snapshot.root, ...frame.path.split("/")), { withFileTypes: true }); }
      catch { snapshot.unreadable++; snapshot.dirs.shift(); continue; }
      frame.entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    }
    const entries = frame.entries;
    while (frame.offset < entries.length && processed < SCAN_LIMIT) {
      const entry = entries[frame.offset++]!;
      processed++; snapshot.scanned++;
      const path = `${frame.path}/${entry.name}`;
      if (entry.isSymbolicLink()) { snapshot.unreadable++; continue; }
      if (entry.isDirectory()) { if (entry.name !== "system") snapshot.dirs.push({ path, offset: 0 }); continue; }
      if (entry.isFile() && entry.name.endsWith(".md")) candidates.add(path);
    }
    if (frame.offset >= entries.length) snapshot.dirs.shift();
  }
  for (const path of candidates) {
    if (!pathOk(path) || snapshot.notes.some((n) => n.path === path)) continue;
    try { snapshot.notes.push(await fingerprint(snapshot.root, path, searchTerm)); } catch { snapshot.unreadable++; }
  }
  snapshot.complete = snapshot.dirs.length === 0;
  if (snapshot.complete) sortNotes(snapshot.notes);
}
async function enumerate(root: string, scope: MemoryScope, mode: Snapshot["mode"], queryHash: string, searchTerm?: string): Promise<Snapshot> {
  const snapshot: Snapshot = { id: randomBytes(18).toString("base64url"), storeId: scope.storeId, root, authority: validateScope(scope).authority, queryHash, mode, notes: [], dirs: [], scanned: 0, complete: true, unreadable: 0, expires: Date.now() + SNAPSHOT_TTL };
  try {
    const memory = await lstat(join(root, "memory"));
    if (memory.isSymbolicLink() || !memory.isDirectory()) snapshot.unreadable++;
    else snapshot.dirs.push({ path: "memory", offset: 0 });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") snapshot.unreadable++; }
  if (!snapshot.dirs.length) {
    for (const path of configuredFiles(scope.memoryFiles)) try { snapshot.notes.push(await fingerprint(root, path, searchTerm)); } catch { snapshot.unreadable++; }
    sortNotes(snapshot.notes);
    return snapshot;
  }
  await advance(snapshot, scope, searchTerm);
  return snapshot;
}
function matches(note: Note, query: MemoryQuery): boolean {
  const f = query.filter;
  if (f?.pathPrefix && !note.path.startsWith(f.pathPrefix)) return false;
  if (f?.description && !f.description.includes(note.description)) return false;
  if (query.query && !note.matched) return false;
  return true;
}
function makeHit(note: Note, scope: MemoryScope): MemoryHit {
  const ref: MemoryRef = { version: 1, storeId: scope.storeId, kind: "note", path: note.path, fingerprint: note.fingerprint };
  return { ref: encodeRef(ref), source: { target: "notes", path: note.path }, time: jsonTime(note), excerpt: note.description, preview: true, coverage: { ...coverage(true, 0, { excerpt: "description" }), undated: 1 } };
}
function page(snapshot: Snapshot, notes: Note[], index: number, limit: number, scope: MemoryScope, qHash: string): MemoryPage {
  const batch = notes.slice(index, index + limit);
  const next = index + batch.length;
  const complete = snapshot.complete && next >= notes.length;
  return { hits: batch.map((n) => makeHit(n, scope)), ...(complete ? {} : { cursor: cursor(snapshot, next, qHash) }), complete, coverage: coverage(complete, snapshot.unreadable, { scanned: snapshot.scanned, partialEnumeration: !snapshot.complete }), freshness: { snapshot: "frozen", order: "path-ascending" } };
}

export function createNotesBackend(): MemoryBackend {
  const readCursors = new Map<string, { path: string; fingerprint: string; storeId: string; root: string; authority: string; offset: number; expires: number }>();
  function issueReadCursor(value: Omit<NonNullable<ReturnType<typeof readCursors.get>>, "expires">): string {
    const now = Date.now();
    for (const [key, entry] of readCursors) if (entry.expires <= now) readCursors.delete(key);
    while (readCursors.size >= 256) readCursors.delete(readCursors.keys().next().value!);
    const token = randomBytes(24).toString("base64url");
    readCursors.set(token, { ...value, expires: now + SNAPSHOT_TTL });
    return token;
  }
  async function run(query: MemoryQuery, scope: MemoryScope, mode: Snapshot["mode"]): Promise<MemoryPage> {
    const { root, authority } = validateScope(scope);
    await assertRoot(root);
    const qHash = hash({ mode, target: query.target, query: query.query, filter: query.filter, order: query.order, authority });
    let snapshot: Snapshot, index: number;
    if (query.cursor) {
      ({ snapshot, index } = getSnapshot(query.cursor, scope, root, authority, qHash, mode));
      if (!snapshot.complete) await advance(snapshot, scope, mode === "search" ? query.query : undefined);
    } else {
      prune(); snapshot = await enumerate(root, scope, mode, qHash, mode === "search" ? query.query : undefined); snapshots.set(snapshot.id, snapshot); index = 0;
    }
    if (!snapshot.complete) return { hits: [], cursor: cursor(snapshot, 0, qHash), complete: false, phase: "preparing", coverage: coverage(false, snapshot.unreadable, { scanned: snapshot.scanned, partialEnumeration: true }), freshness: { snapshot: "frozen", order: "path-ascending" } };
    let notes = snapshot.notes.filter((n) => matches(n, query));
    // Notes have no occurrence timestamps; both order choices are deterministic path order.
    sortNotes(notes);
    const limit = readLimit(query.limit, PAGE_DEFAULT, PAGE_MAX);
    return page(snapshot, notes, index, limit, scope, qHash);
  }
  return {
    search(query, scope, _context: Context) { return run(query, scope, "search"); },
    browse(query, scope, _context: Context) { return run(query, scope, "browse"); },
    async read(query, ref, scope, _context): Promise<MemoryReadPage> {
      const { root, authority } = validateScope(scope);
      await assertRoot(root);
      if (ref.kind !== "note" || !ref.path || !ref.fingerprint || !pathOk(ref.path)) throw new Error("Note reference is invalid");
      const current = await fingerprint(root, ref.path).catch(() => undefined);
      if (!current || current.fingerprint !== ref.fingerprint) throw new Error("Note changed or is no longer available; search again");
      const offset = 0;
      let pageOffset = offset;
      if (query.cursor) {
        const saved = readCursors.get(query.cursor);
        if (!saved || saved.expires <= Date.now()) { readCursors.delete(query.cursor); throw new Error("Note continuation expired; start the read again"); }
        if (saved.path !== ref.path || saved.fingerprint !== ref.fingerprint || saved.storeId !== scope.storeId || saved.root !== root || saved.authority !== authority) throw new Error("Note continuation does not match this resource or scope");
        pageOffset = saved.offset;
        readCursors.delete(query.cursor);
      }
      const limit = readLimit(query.limit, TEXT_PAGE_DEFAULT, TEXT_PAGE_MAX);
      const abs = join(root, ...ref.path.split("/"));
      const fd: FileHandle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const st = await fd.stat({ bigint: true });
        if (!st.isFile() || st.nlink !== 1n) throw new Error("Note is not a safe regular file");
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const digest = createHash("sha256");
        let chars = 0, content = "", pos = 0, left = Number(st.size);
        const buf = Buffer.alloc(64 * 1024);
        while (left > 0) {
          const { bytesRead } = await fd.read(buf, 0, Math.min(buf.length, left), pos);
          if (!bytesRead) throw new Error("Note changed while reading");
          digest.update(buf.subarray(0, bytesRead));
          const chunk = decoder.decode(buf.subarray(0, bytesRead), { stream: true });
          for (const ch of chunk) {
            const width = ch.length;
            if (chars >= pageOffset && content.length < limit) content += ch;
            chars += width;
          }
          pos += bytesRead; left -= bytesRead;
        }
        decoder.decode();
        const after = await fd.stat({ bigint: true });
        if (st.dev !== after.dev || st.ino !== after.ino || st.size !== after.size || st.mtimeNs !== after.mtimeNs || st.ctimeNs !== after.ctimeNs || st.nlink !== after.nlink || digest.digest("hex") !== ref.fingerprint) throw new Error("Note changed while reading");
        const total = chars;
        const nextOffset = pageOffset + content.length;
        const complete = nextOffset >= total;
        return { ref: query.ref, content, complete, coverage: coverage(true, 0, { fingerprint: "verified", resourceChars: total }), ...(!complete ? { cursor: issueReadCursor({ path: ref.path, fingerprint: ref.fingerprint, storeId: scope.storeId, root, authority, offset: nextOffset }) } : {}) };
      } catch (e) { if (e instanceof TypeError && /encoded data/.test(e.message)) throw new Error("Note contains invalid UTF-8"); throw e; }
      finally { await fd.close().catch(() => undefined); }
    },
    close() { snapshots.clear(); readCursors.clear(); },
  };
}
