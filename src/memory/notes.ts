import { createHash, randomBytes } from "node:crypto";
import { open, readdir } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import {
  CONTROL_CHARACTERS,
  DIRECTORY_FLAGS,
  FILE_FLAGS,
  LINE_SEPARATORS,
  RESTRICTED_ROOTS,
  frontmatterField,
  isWithin,
  openAbsoluteDirectoryNoFollow,
  pinnedChildPath as childPath,
  procFdPath,
  unquoteFrontmatter,
} from "../context/fs-safe.js";
import type { MemoryBackend, MemoryCoverage, MemoryHit, MemoryPage, MemoryQuery, MemoryReadPage, MemoryScope } from "./contracts.js";
import { decodeToken, encodeRef, encodeToken, hash } from "./validation.js";

const MAX_MANIFEST_ENTRIES = 100_000;
const FILES_PER_PASS = 32;
const TTL = 10 * 60_000;
const MAX_SNAPSHOTS = 48;
const MAX_METADATA_CHARS = 1_048_576;
type Note = { path: string; identity: string; fingerprint?: string; description?: string; matched?: boolean };
type Snapshot = { id: string; secret: string; root: string; authority: string; key: string; notes: Note[]; position: number; unreadable: number; expires: number };
type NoteRead = { fingerprint: string; description: string; matched: boolean; content: string; total: number };

function fail(message: string): never { throw new Error(message); }
function validPath(path: unknown): path is string {
  return typeof path === "string" && path.length <= 1_024 && path.startsWith("memory/") && path.endsWith(".md") && !path.includes("\\") && !CONTROL_CHARACTERS.test(path) && !LINE_SEPARATORS.test(path) && !path.split("/").some((part) => !part || part === "." || part === "..");
}
function scopeIdentity(scope: MemoryScope): { root: string; authority: string } {
  if (!scope.storeId || !isAbsolute(scope.workspaceRoot) || !Array.isArray(scope.memoryFiles) || scope.memoryFiles.some((path) => !validPath(path))) fail("Notes scope is invalid");
  const root = resolve(scope.workspaceRoot);
  if (root === sep || RESTRICTED_ROOTS.some((path) => isWithin(path, root))) fail("Notes workspace is not allowed");
  return { root, authority: hash({ storeId: scope.storeId, root, memoryFiles: [...scope.memoryFiles].sort() }) };
}
function identity(info: BigIntStats): string { return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.nlink].join(":"); }
function directoryIdentity(info: BigIntStats): string { return [info.dev, info.ino, info.mtimeNs, info.ctimeNs].join(":"); }
/** Linux dirfd-style traversal: each component is opened beneath a pinned descriptor, never a checked pathname. */
function directory(root: string): Promise<FileHandle> {
  return openAbsoluteDirectoryNoFollow(root, () => new Error("Notes directory is unavailable or unsafe"));
}
async function beneath(root: string, relative: string): Promise<FileHandle> {
  let handle = await directory(root);
  try {
    for (const part of relative.split("/").filter(Boolean)) {
      const next = await open(childPath(handle, part), DIRECTORY_FLAGS);
      await handle.close(); handle = next;
    }
    return handle;
  } catch (error) { await handle.close().catch(() => undefined); throw error; }
}
async function noteHandle(root: string, path: string): Promise<FileHandle> {
  if (!validPath(path)) return fail("Note path is outside the memory scope");
  const parts = path.split("/"); const name = parts.pop()!;
  const parent = await beneath(root, parts.join("/"));
  try {
    const handle = await open(childPath(parent, name), FILE_FLAGS);
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isFile() || info.nlink !== 1n) fail("Note is not a safe regular file");
      return handle;
    } catch (error) { await handle.close().catch(() => undefined); throw error; }
  } finally { await parent.close(); }
}
/** A manifest is captured fully on the first call. Bounds refuse explicitly, never claim partial enumeration is complete. */
async function manifest(root: string, configured: readonly string[]): Promise<{ notes: Note[]; unreadable: number }> {
  const pending = ["memory"]; const dirs: { path: string; identity: string }[] = [];
  const notes = new Map<string, Note>(); let unreadable = 0, scanned = 0;
  while (pending.length) {
    const path = pending.shift()!;
    let handle: FileHandle;
    try { handle = await beneath(root, path); }
    catch (error) {
      if (!(path === "memory" && (error as NodeJS.ErrnoException).code === "ENOENT")) unreadable++;
      continue;
    }
    try {
      const before = await handle.stat({ bigint: true });
      dirs.push({ path, identity: directoryIdentity(before) });
      const entries = await readdir(procFdPath(handle.fd), { withFileTypes: true });
      for (const entry of entries) {
        if (++scanned > MAX_MANIFEST_ENTRIES) fail("Notes manifest exceeds the 100000-entry bound; narrow the workspace before browsing");
        const child = `${path}/${entry.name}`;
        if (entry.isSymbolicLink()) { unreadable++; continue; }
        if (entry.isDirectory()) { pending.push(child); continue; }
        if (!entry.name.endsWith(".md")) continue;
        if (!entry.isFile() || !validPath(child)) { unreadable++; continue; }
        try {
          const fd = await noteHandle(root, child);
          try { notes.set(child, { path: child, identity: identity(await fd.stat({ bigint: true })) }); }
          finally { await fd.close(); }
        } catch { unreadable++; }
      }
      if (directoryIdentity(await handle.stat({ bigint: true })) !== directoryIdentity(before)) fail("Notes directory changed while capturing the manifest; start again");
    } finally { await handle.close(); }
  }
  for (const path of configured) {
    if (notes.has(path)) continue;
    try {
      const handle = await noteHandle(root, path);
      try { notes.set(path, { path, identity: identity(await handle.stat({ bigint: true })) }); }
      finally { await handle.close(); }
    } catch { unreadable++; }
  }
  for (const saved of dirs) {
    const handle = await beneath(root, saved.path).catch(() => undefined);
    if (!handle) fail("Notes directory changed while capturing the manifest; start again");
    try { if (directoryIdentity(await handle.stat({ bigint: true })) !== saved.identity) fail("Notes directory changed while capturing the manifest; start again"); }
    finally { await handle.close(); }
  }
  return { notes: [...notes.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), unreadable };
}
/** Locale-independent lowercase per code point; no context-sensitive chunk folding. */
function fold(text: string): string { return Array.from(text, (character) => character.toLowerCase()).join(""); }
async function readNote(root: string, path: string, options: { expectedIdentity?: string; term?: string; offset?: number; limit?: number; metadata?: boolean }): Promise<NoteRead> {
  const handle = await noteHandle(root, path);
  try {
    const before = await handle.stat({ bigint: true });
    if (options.expectedIdentity && identity(before) !== options.expectedIdentity) fail("Note changed after the manifest was captured; start again");
    const size = Number(before.size);
    if (!Number.isSafeInteger(size)) fail("Note size cannot be read safely");
    const digest = createHash("sha256"), decoder = new TextDecoder("utf-8", { fatal: true });
    const buffer = Buffer.alloc(64 * 1024); const term = options.term === undefined ? undefined : fold(options.term);
    let position = 0, total = 0, content = "", tail = "", matched = term === undefined;
    const offset = options.offset ?? 0, limit = options.limit ?? 0;
    let firstLine = true, inHeader = false, metadataDone = false, lineBuffer = "", descriptionValue = "", headerDescription = "", firstHeading = "";
    const line = (value: string): void => {
      value = value.replace(/\r$/, "");
      if (firstLine) { firstLine = false; if (value === "---") { inHeader = true; return; } }
      if (inHeader) {
        if (value.startsWith("---")) { inHeader = false; if (headerDescription) { descriptionValue = headerDescription; metadataDone = true; } return; }
        const field = frontmatterField(value);
        if (field !== undefined && field.key.toLowerCase() === "description") headerDescription = unquoteFrontmatter(field.value);
        if (!firstHeading && value.trim().startsWith("#")) firstHeading = value.trim().replace(/^#+/, "").trim();
      } else if (value.trim().startsWith("#")) { descriptionValue = value.trim().replace(/^#+/, "").trim(); metadataDone = true; }
    };
    const consume = (chunk: string): void => {
      if (options.metadata && !metadataDone) {
        lineBuffer += chunk;
        let end: number;
        while (!metadataDone && (end = lineBuffer.indexOf("\n")) >= 0) {
          if (end > MAX_METADATA_CHARS) fail("Note metadata line exceeds the metadata bound");
          line(lineBuffer.slice(0, end)); lineBuffer = lineBuffer.slice(end + 1);
        }
        if (metadataDone) lineBuffer = "";
        else if (lineBuffer.length > MAX_METADATA_CHARS) fail("Note metadata line exceeds the metadata bound");
      }
      if (term !== undefined && !matched) {
        const searchable = tail + fold(chunk); matched = searchable.includes(term);
        tail = searchable.slice(-Math.max(0, term.length - 1));
      }
      for (const character of chunk) {
        if (total >= offset && content.length + character.length <= limit && total === offset + content.length) content += character;
        total += character.length;
      }
    };
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (!bytesRead) fail("Note changed while reading");
      digest.update(buffer.subarray(0, bytesRead));
      consume(decoder.decode(buffer.subarray(0, bytesRead), { stream: true })); position += bytesRead;
    }
    consume(decoder.decode());
    if (identity(await handle.stat({ bigint: true })) !== identity(before)) fail("Note changed while reading");
    if (options.metadata && !metadataDone && lineBuffer) line(lineBuffer);
    if (!descriptionValue) descriptionValue = inHeader && firstHeading ? firstHeading : "(missing description)";
    return { fingerprint: digest.digest("hex"), description: descriptionValue, matched, content, total };
  } finally { await handle.close(); }
}
function coverage(complete: boolean, unreadable: number, undated: number, extra: Record<string, unknown> = {}): MemoryCoverage { return { complete, unreadable, undated, ...extra }; }
function token(): string { return randomBytes(24).toString("base64url"); }

export function createNotesBackend(): MemoryBackend {
  const snapshots = new Map<string, Snapshot>();
  const reads = new Map<string, { authority: string; ref: string; secret: string; expires: number }>();
  function prune(): void {
    const now = Date.now();
    for (const [id, saved] of snapshots) if (saved.expires <= now) snapshots.delete(id);
    for (const [id, saved] of reads) if (saved.expires <= now) reads.delete(id);
  }
  function next(snapshot: Snapshot, index: number): string {
    return encodeToken({ id: snapshot.id, index, signature: hash({ secret: snapshot.secret, index }) });
  }
  async function run(query: MemoryQuery, scope: MemoryScope, mode: "search" | "browse"): Promise<MemoryPage> {
    prune();
    const { root, authority } = scopeIdentity(scope);
    const key = hash({ mode, query: query.query, filter: query.filter, order: query.order, authority });
    let snapshot: Snapshot, index = 0;
    if (query.cursor) {
      const value = decodeToken(query.cursor) as Record<string, unknown>;
      if (!value || typeof value !== "object" || typeof value.id !== "string" || !Number.isSafeInteger(value.index) || (value.index as number) < 0) fail("Notes continuation is invalid");
      const saved = snapshots.get(value.id);
      if (!saved || saved.expires <= Date.now()) fail("Notes snapshot expired; start again");
      snapshot = saved; index = value.index as number;
      if (snapshot.authority !== authority || snapshot.key !== key || value.signature !== hash({ secret: snapshot.secret, index })) fail("Notes continuation does not match this query or scope");
    } else {
      if (snapshots.size >= MAX_SNAPSHOTS) fail("Notes snapshot capacity reached; retry later");
      const found = await manifest(root, scope.memoryFiles);
      snapshot = { id: token(), secret: token(), root, authority, key, notes: found.notes, position: 0, unreadable: found.unreadable, expires: Date.now() + TTL };
      snapshots.set(snapshot.id, snapshot);
    }
    const end = Math.min(snapshot.notes.length, snapshot.position + FILES_PER_PASS);
    for (; snapshot.position < end; snapshot.position++) {
      const note = snapshot.notes[snapshot.position]!;
      try {
        const read = await readNote(root, note.path, { expectedIdentity: note.identity, ...(mode === "search" && query.query !== undefined ? { term: query.query } : {}), metadata: true });
        Object.assign(note, { fingerprint: read.fingerprint, description: read.description, matched: read.matched });
      } catch { snapshot.unreadable++; }
    }
    if (snapshot.position < snapshot.notes.length) return { hits: [], cursor: next(snapshot, 0), complete: false, phase: "preparing", coverage: coverage(false, snapshot.unreadable, snapshot.position, { capturedNotes: snapshot.notes.length, processedNotes: snapshot.position }), freshness: { source: "filesystem", manifest: "frozen" } };
    let notes = snapshot.notes.filter((note) => note.fingerprint && note.matched && (!query.filter?.pathPrefix || note.path.startsWith(query.filter.pathPrefix)) && (!query.filter?.description || query.filter.description.includes(note.description!)));
    if (query.order === "newest") notes = notes.slice().reverse();
    const limit = Math.min(query.limit ?? 20, 100), batch = notes.slice(index, index + limit), position = index + batch.length;
    const complete = position >= notes.length;
    const hits: MemoryHit[] = batch.map((note) => ({ ref: encodeRef({ version: 1, storeId: scope.storeId, kind: "note", path: note.path, fingerprint: note.fingerprint! }), source: { target: "notes", path: note.path }, time: { from: null, to: null, undated: 1 }, excerpt: note.description!.slice(0, 600), preview: true, coverage: coverage(true, 0, 1, { excerpt: "description" }) }));
    return { hits, ...(complete ? {} : { cursor: next(snapshot, position) }), complete, coverage: coverage(snapshot.unreadable === 0, snapshot.unreadable, snapshot.notes.length, { capturedNotes: snapshot.notes.length, matchedNotes: notes.length }), freshness: { source: "filesystem", manifest: "frozen", order: query.order === "newest" ? "path-descending" : "path-ascending", matching: "literal Unicode lowercase by code point; no locale or normalization" } };
  }
  return {
    search: (query, scope) => run(query, scope, "search"),
    browse: (query, scope) => run(query, scope, "browse"),
    async read(query, ref, scope): Promise<MemoryReadPage> {
      prune(); const { root, authority } = scopeIdentity(scope);
      if (query.view !== undefined) fail("view applies only to episodes and summaries");
      if (ref.kind !== "note" || !validPath(ref.path) || !ref.fingerprint) fail("Note reference is invalid");
      let offset = 0, readId: string | undefined;
      if (query.cursor) {
        const value = decodeToken(query.cursor) as Record<string, unknown>;
        if (!value || typeof value !== "object" || typeof value.id !== "string" || !Number.isSafeInteger(value.offset) || (value.offset as number) < 0) fail("Note continuation is invalid");
        const saved = reads.get(value.id);
        if (!saved || saved.expires <= Date.now()) fail("Note continuation expired; start again");
        if (saved.authority !== authority || saved.ref !== query.ref || value.signature !== hash({ secret: saved.secret, offset: value.offset })) fail("Note continuation does not match this resource or scope");
        offset = value.offset as number; readId = value.id;
      }
      const result = await readNote(root, ref.path, { offset, limit: Math.max(2, Math.min(query.limit ?? 4_096, 8_000)) }).catch(() => fail("Note is unsafe, changed, unreadable or no longer available"));
      if (result.fingerprint !== ref.fingerprint) fail("Note changed; search again");
      const nextOffset = offset + result.content.length, complete = nextOffset >= result.total;
      let cursor: string | undefined;
      if (!complete) {
        if (!readId) {
          if (reads.size >= 256) fail("Note continuation capacity reached; retry later");
          readId = token(); reads.set(readId, { authority, ref: query.ref, secret: token(), expires: Date.now() + TTL });
        }
        const saved = reads.get(readId)!;
        saved.expires = Date.now() + TTL;
        cursor = encodeToken({ id: readId, offset: nextOffset, signature: hash({ secret: saved.secret, offset: nextOffset }) });
      }
      return { ref: query.ref, content: result.content, complete, ...(cursor ? { cursor } : {}), coverage: coverage(true, 0, 1, { resourceChars: result.total, fingerprint: "verified" }) };
    },
    close() { snapshots.clear(); reads.clear(); },
  };
}
