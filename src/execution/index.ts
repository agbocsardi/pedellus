import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile, readFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isChordError } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { processLock } from "@earendil-works/chord/node";
import {
	Connection,
	localDaemon,
	RemoteExecutionEnv,
	type RemoteExecutionEnvOptions,
} from "@earendil-works/pi-env";
import {
	ExecutionError,
	FileError,
	err,
	ok,
	type ExecutionEnv,
	type FileWatcher,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
} from "@earendil-works/pi-durable/env";
import type { WatchTarget, WatchChange } from "@earendil-works/pi-durable/env";
import {
	buildBwrapArgs,
	buildCommandBwrapArgs,
	buildImportBwrapArgs,
	shellQuote,
	validateBwrap,
	type ImportMount,
} from "./sandbox.js";

export interface ExecutionOptions {
	/** Trusted application-owned data directory; guest code can access only a generated child workspace. */
	storageDirectory?: string;
	/** Explicit files/directories copied into `imports/<basename>`; no source is mounted after admission. */
	imports?: readonly string[];
	/** Optional cwd within the virtual `/workspace`, never a host path. */
	cwd?: string;
	bwrapPath?: string;
}

export interface ManagedExecutionEnv extends ExecutionEnv {
	readonly workspaceId: string;
}

interface WorkspaceRecord {
	id: string;
	rootPath: string;
	rootDev: string;
	rootIno: string;
}

interface AdmissionRecord {
	version: 3;
	id: string;
	rootDev: string;
	rootIno: string;
}

interface ImportSource {
	name: string;
	kind: "file" | "directory";
	handle: FileHandle;
}

class SandboxCleanupFailure extends AggregateError {}

/**
 * One kernel-held lock per managed workspace, shared with every other Nanobot process on the host. The lock lives in
 * this process: a crash or SIGKILL releases it, and there is no stale on-disk state to steal. If teardown cannot be
 * verified, the lock is retained for the rest of this process's lifetime so no second owner can start a writer.
 */
class WorkspaceLock {
	readonly #release: () => Promise<void>;
	#released = false;
	#retained = false;

	constructor(release: () => Promise<void>) {
		this.#release = release;
	}

	retain(): void {
		this.#retained = true;
	}

	async release(): Promise<void> {
		if (this.#released) return;
		this.#released = true;
		if (this.#retained) return;
		await this.#release();
	}
}

async function acquireWorkspaceLock(store: StorePaths, id: string): Promise<WorkspaceLock> {
	try {
		return new WorkspaceLock(await processLock(`nanobot:execution:${store.store}:${id}`));
	} catch (error) {
		if (isChordError(error) && error.reason === "locked") {
			throw new Error(`Managed workspace ${id} is owned by another live process`, { cause: error });
		}
		throw error;
	}
}

const SETUP_TIMEOUT_MS = 10_000;
const TEARDOWN_TIMEOUT_MS = 5_000;
const IMPORT_TIMEOUT_MS = 30_000;
const PRIVATE_TMP = "/tmp";
const GUEST_ROOT = "/workspace";
const DEFAULT_STORAGE_DIRECTORY = join(homedir(), ".local", "share", "nanobot", "execution");
const RESTRICTED_SYSTEM_ROOTS = [
	"/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/proc", "/sys", "/dev", "/run", "/var", "/opt", "/boot", "/root",
];
const MAX_SHELL_TIMEOUT_SECONDS = 5;
const SHELL_OUTPUT_WINDOW = {
	maxBytes: 64 * 1024,
	maxLines: 2_000,
	minIntervalMs: 100,
	bytesPerSecond: 64 * 1024,
} as const;

const SHELL_ENV = {
	PATH: "/usr/bin:/bin",
	HOME: "",
	TMPDIR: PRIVATE_TMP,
	LANG: "C.UTF-8",
};

function isWithin(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function validateManagedOptions(options: ExecutionOptions): void {
	const supplied = options as ExecutionOptions & Record<string, unknown>;
	if ("workspace" in supplied || "extraAllowedDirs" in supplied) {
		throw new Error("Arbitrary writable host roots are unsupported; use a managed workspace and explicit imports");
	}
	const accepted = new Set(["storageDirectory", "imports", "cwd", "bwrapPath"]);
	for (const key of Object.keys(supplied)) {
		if (!accepted.has(key)) throw new Error(`Unsupported execution option: ${key}`);
	}
	if (options.storageDirectory !== undefined && (!isAbsolute(options.storageDirectory) || options.storageDirectory.includes("\0"))) {
		throw new Error("storageDirectory must be an absolute trusted application data path");
	}
	if (options.cwd !== undefined && isAbsolute(options.cwd) && options.cwd !== GUEST_ROOT && !options.cwd.startsWith(`${GUEST_ROOT}/`)) {
		throw new Error(`cwd must be inside the virtual ${GUEST_ROOT}`);
	}
	if (options.cwd?.includes("\0")) throw new Error("cwd must not contain NUL");
}

function requireOwner(info: { uid: number | bigint }, label: string): void {
	const uid = typeof info.uid === "bigint" ? Number(info.uid) : info.uid;
	if (typeof process.getuid === "function" && uid !== process.getuid()) {
		throw new Error(`${label} is not owned by the current application user`);
	}
}

async function ensurePrivateDirectory(path: string, label: string): Promise<string> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const info = await lstat(path);
	if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} is not a real directory`);
	requireOwner(info, label);
	if ((info.mode & 0o077) !== 0) throw new Error(`${label} must not be accessible to group or other users`);
	return realpath(path);
}

interface StorePaths {
	store: string;
	workspaces: string;
	admissions: string;
	runs: string;
}

async function prepareStore(storageDirectory?: string): Promise<StorePaths> {
	const requested = resolve(storageDirectory ?? DEFAULT_STORAGE_DIRECTORY);
	const store = await ensurePrivateDirectory(requested, "Managed workspace store");
	const workspaces = await ensurePrivateDirectory(join(store, "workspaces"), "Managed workspace directory");
	const admissions = await ensurePrivateDirectory(join(store, "admissions"), "Managed admission directory");
	const runs = await ensurePrivateDirectory(join(store, "runs"), "Managed run-marker directory");
	return { store, workspaces, admissions, runs };
}

function managedPaths(store: StorePaths, id: string): { container: string; root: string; admission: string; launch: string } {
	return {
		container: join(store.workspaces, id),
		root: join(store.workspaces, id, "root"),
		admission: join(store.admissions, `${id}.json`),
		launch: join(store.runs, `${id}.launch`),
	};
}

function validWorkspaceId(id: string): boolean {
	return validUuid(id);
}

function validUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function rejectImportRoot(path: string): void {
	if (path === "/") throw new Error("Importing the host filesystem root is unsupported");
	const home = resolve(homedir());
	if (isWithin(path, home)) throw new Error("Importing the host home directory or one of its parents is unsupported");
	for (const systemRoot of RESTRICTED_SYSTEM_ROOTS) {
		if (isWithin(systemRoot, path) || isWithin(path, systemRoot)) {
			throw new Error(`Import path overlaps a protected system path: ${path}`);
		}
	}
	if (path === PRIVATE_TMP || isWithin(path, PRIVATE_TMP)) {
		throw new Error("Importing host /tmp or one of its parents is unsupported");
	}
}

function procFdPath(fd: number): string {
	return `/proc/self/fd/${fd}`;
}

async function openImportSource(path: string): Promise<ImportSource> {
	if (!isAbsolute(path) || path.includes("\0")) throw new Error("Import paths must be absolute");
	const absolute = resolve(path);
	const components = absolute.slice(1).split(sep).filter(Boolean);
	const name = components.pop();
	if (!name) throw new Error("Importing the host filesystem root is unsupported");

	let parent = await open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		for (const component of components) {
			const child = await open(
				join(procFdPath(parent.fd), component),
				constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
			);
			try {
				if (!(await child.stat()).isDirectory()) throw new Error(`Import ancestor is not a directory: ${path}`);
			} catch (error) {
				await child.close().catch(() => undefined);
				throw error;
			}
			const previous = parent;
			parent = child;
			await previous.close();
		}

		// Apply path policy only after this exact no-follow component sequence is pinned.
		rejectImportRoot(absolute);
		const handle = await open(
			join(procFdPath(parent.fd), name),
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		try {
			const pinned = await handle.stat({ bigint: true });
			const kind = pinned.isFile() ? "file" : pinned.isDirectory() ? "directory" : undefined;
			if (!kind) throw new Error(`Import must be a regular file or directory: ${path}`);
			if (kind === "file" && pinned.nlink !== 1n) {
				throw new Error(`Import file has an outside hard-link alias: ${path}`);
			}
			return { name: basename(absolute), kind, handle };
		} catch (error) {
			await handle.close();
			throw error;
		}
	} finally {
		await parent.close();
	}
}

function privateDirectoryInfo(info: Awaited<ReturnType<typeof lstat>>, label: string, checkMode = true): void {
	if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} is not a real directory`);
	requireOwner(info, label);
	const mode = typeof info.mode === "bigint" ? Number(info.mode) : info.mode;
	if (checkMode && (mode & 0o077) !== 0) throw new Error(`${label} is not private to the application user`);
}

async function readAdmission(store: StorePaths, id: string): Promise<WorkspaceRecord> {
	if (!validWorkspaceId(id)) throw new Error("Invalid managed workspace id");
	const paths = managedPaths(store, id);
	const containerInfo = await lstat(paths.container);
	privateDirectoryInfo(containerInfo, "Managed workspace container");
	const rootInfo = await lstat(paths.root, { bigint: true });
	if (!rootInfo.isDirectory()) throw new Error("Managed workspace root is not a directory");
	requireOwner(rootInfo, "Managed workspace root");
	const canonicalRootPath = await realpath(paths.root);
	if (canonicalRootPath !== paths.root) throw new Error("Managed workspace root path is not canonical");

	const recordInfo = await lstat(paths.admission, { bigint: true });
	if (!recordInfo.isFile() || (recordInfo.mode & 0o077n) !== 0n) throw new Error("Managed admission metadata is not private");
	requireOwner(recordInfo, "Managed admission metadata");
	if (recordInfo.size > 4096n) throw new Error("Managed admission metadata is invalid");
	const recordHandle = await open(paths.admission, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	let raw: string;
	try {
		const opened = await recordHandle.stat({ bigint: true });
		if (opened.dev !== recordInfo.dev || opened.ino !== recordInfo.ino || !opened.isFile()) {
			throw new Error("Managed admission metadata changed while being opened");
		}
		raw = await recordHandle.readFile("utf8");
	} finally {
		await recordHandle.close();
	}
	const admission = JSON.parse(raw) as Partial<AdmissionRecord>;
	if (admission.version !== 3) {
		throw new Error("Managed workspace predates launch-intent ownership and cannot be reopened safely; remove it manually");
	}
	if (
		admission.id !== id ||
		admission.rootDev !== String(rootInfo.dev) ||
		admission.rootIno !== String(rootInfo.ino)
	) {
		throw new Error("Managed workspace provenance does not match its private admission record");
	}
	// The root inode has been authenticated through private, guest-inaccessible metadata before restoring its usable mode.
	await chmod(paths.root, 0o700);
	return { id, rootPath: paths.root, rootDev: String(rootInfo.dev), rootIno: String(rootInfo.ino) };
}

async function writeAdmission(store: StorePaths, record: WorkspaceRecord): Promise<void> {
	const admission: AdmissionRecord = {
		version: 3,
		id: record.id,
		rootDev: record.rootDev,
		rootIno: record.rootIno,
	};
	const handle = await open(managedPaths(store, record.id).admission, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try {
		await handle.writeFile(JSON.stringify(admission));
		await handle.sync();
	} finally {
		await handle.close();
	}
}

type LaunchState =
	| { readonly kind: "pending"; readonly nonce: string }
	| { readonly kind: "pid"; readonly pid: number; readonly nonce: string };

function parseLaunchState(raw: string): LaunchState {
	const value = raw.trim();
	const pending = /^pending (\S+)$/.exec(value);
	if (pending && validUuid(pending[1]!)) return { kind: "pending", nonce: pending[1]! };
	const published = /^pid ([1-9]\d{0,9}) (\S+)$/.exec(value);
	if (published && validUuid(published[2]!)) return { kind: "pid", pid: Number(published[1]), nonce: published[2]! };
	throw new Error("Managed sandbox launch file is malformed; manual reconciliation is required");
}

async function readLaunchFile(file: string): Promise<LaunchState | undefined> {
	try {
		const info = await lstat(file);
		if (info.isSymbolicLink() || !info.isFile()) throw new Error("Managed sandbox launch file is not a regular file");
		requireOwner(info, "Managed sandbox launch file");
		const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			return parseLaunchState(await handle.readFile("utf8"));
		} finally {
			await handle.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function readLaunchState(store: StorePaths, id: string): Promise<LaunchState | undefined> {
	return readLaunchFile(managedPaths(store, id).launch);
}

/**
 * Refuse to start a second sandbox while a launch may still be in flight. The owner writes `pending` before it
 * spawns the launcher, so a crash between spawn and the launcher publishing its pid still leaves a durable intent.
 * A pending intent is never auto-recovered: the owner could not prove whether a pre-publication launcher exists, so
 * only manual reconciliation may clear it. A published pid is checked for liveness; a dead pid proves the launcher
 * and its PID namespace are gone, so the stale file is removed. A reused pid only delays startup (fail closed).
 */
async function assertLaunchSafe(store: StorePaths, id: string): Promise<void> {
	const state = await readLaunchState(store, id);
	if (state === undefined) return;
	if (state.kind === "pending") {
		throw new Error(
			`Managed workspace ${id} has an unverified launch intent; manual reconciliation is required before reuse`,
		);
	}
	try {
		process.kill(state.pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") {
			await rm(managedPaths(store, id).launch, { force: true });
			return;
		}
		throw error;
	}
	throw new Error(
		`Managed workspace ${id} may still have a live sandbox (supervisor pid ${state.pid}); previous owner did not finish teardown`,
	);
}

/** Write the launch intent before spawning anything; O_EXCL refuses to overwrite another launch's state. */
async function writeLaunchIntent(path: string, nonce: string): Promise<void> {
	const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try {
		await handle.writeFile(`pending ${nonce}\n`);
		await handle.sync();
	} catch (error) {
		await handle.close().catch(() => undefined);
		await rm(path, { force: true }).catch(() => undefined);
		throw error;
	}
	await handle.close();
}

function aborted<T>(context: Context, path?: string): Result<T, FileError> | undefined {
	return context.abortSignal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
}

function setupWait<T>(promise: Promise<T>, context: Context, label: string): Promise<T> {
	return new Promise<T>((resolvePromise, reject) => {
		let settled = false;
		const finish = (error?: unknown, value?: T) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			context.abortSignal?.removeEventListener("abort", onAbort);
			if (error !== undefined) reject(error);
			else resolvePromise(value as T);
		};
		const onAbort = () => finish(new Error("Execution environment setup aborted"));
		const timer = setTimeout(() => finish(new Error(`${label} timed out`)), SETUP_TIMEOUT_MS);
		context.abortSignal?.addEventListener("abort", onAbort, { once: true });
		promise.then((value) => finish(undefined, value), (error: unknown) => finish(error));
		if (context.abortSignal?.aborted) onAbort();
	});
}

function waitForPidExit(pid: number): Promise<void> {
	return new Promise<void>((resolvePromise, reject) => {
		const deadline = Date.now() + TEARDOWN_TIMEOUT_MS;
		const check = () => {
			try {
				process.kill(pid, 0);
			} catch (error) {
				if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
					resolvePromise();
					return;
				}
				reject(error);
				return;
			}
			if (Date.now() >= deadline) {
				reject(new Error(`Bubblewrap process ${pid} did not exit during cleanup`));
				return;
			}
			setTimeout(check, 25);
		};
		check();
	});
}

class BwrapExecutionEnv extends RemoteExecutionEnv implements ManagedExecutionEnv {
	readonly workspaceId: string;
	readonly #roots = [GUEST_ROOT];
	readonly #daemonDir: string;
	readonly #pidFile: string;
	readonly #launchFile: string;
	readonly #nonce: string;
	readonly #bwrapPath: string;
	readonly #lock: WorkspaceLock;
	#closed = false;

	constructor(
		options: RemoteExecutionEnvOptions,
		workspaceId: string,
		daemonDir: string,
		pidFile: string,
		launchFile: string,
		nonce: string,
		bwrapPath: string,
		lock: WorkspaceLock,
	) {
		super(options);
		this.workspaceId = workspaceId;
		this.#daemonDir = daemonDir;
		this.#pidFile = pidFile;
		this.#launchFile = launchFile;
		this.#nonce = nonce;
		this.#bwrapPath = bwrapPath;
		this.#lock = lock;
	}

	private async checked(path: string, context: Context, allowPrivateTmp = true): Promise<{ path: string } | { error: FileError }> {
		const early = aborted<string>(context);
		if (early && "error" in early) return { error: early.error };
		const absolute = await super.absolutePath(path, context);
		if (!absolute.ok) return { error: absolute.error };
		const candidate = absolute.value;
		let probe = candidate;
		const missing: string[] = [];
		while (true) {
			const actual = await super.canonicalPath(probe, context);
			if (!("error" in actual)) {
				const target = resolve(actual.value, ...missing.reverse());
				const allowed = this.#roots.some((root) => isWithin(root, target)) || (allowPrivateTmp && isWithin(PRIVATE_TMP, target));
				return allowed
					? { path: candidate }
					: { error: new FileError("permission_denied", "Path is outside allowed execution roots", candidate) };
			}
			const actualError = actual.error;
			if (actualError.code !== "not_found") return { error: actualError };
			const info = await super.fileInfo(probe, context);
			if (info.ok && info.value.kind === "symlink") {
				return { error: new FileError("permission_denied", "Unresolvable symlink path is not allowed", candidate) };
			}
			if (!info.ok && info.error.code !== "not_found") return { error: info.error };
			const parent = dirname(probe);
			if (parent === probe) return { error: actualError };
			missing.push(probe.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
			probe = parent;
		}
	}

	private async checkedResult<T>(
		path: string,
		context: Context,
		call: (absolute: string) => Promise<Result<T, FileError>>,
	): Promise<Result<T, FileError>> {
		const result = await this.checked(path, context);
		return "error" in result ? err<T, FileError>(result.error) : call(result.path);
	}

	override async absolutePath(path: string, context: Context): ReturnType<RemoteExecutionEnv["absolutePath"]> {
		const result = await this.checked(path, context);
		return "error" in result ? err<string, FileError>(result.error) : ok(result.path);
	}

	override async joinPath(parts: string[], context: Context): ReturnType<RemoteExecutionEnv["joinPath"]> {
		const joined = await super.joinPath(parts, context);
		if (!joined.ok) return joined;
		const result = await this.checked(joined.value, context);
		return "error" in result ? err<string, FileError>(result.error) : ok(result.path);
	}

	override readTextFile(path: string, context: Context) { return this.checkedResult(path, context, (p) => super.readTextFile(p, context)); }
	override openTextLineReader(path: string, context: Context) { return this.checkedResult(path, context, (p) => super.openTextLineReader(p, context)); }
	override readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context) { return this.checkedResult(path, context, (p) => super.readTextLines(p, options, context)); }
	override readBinaryFile(path: string, context: Context) { return this.checkedResult(path, context, (p) => super.readBinaryFile(p, context)); }
	override openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context) { return this.checkedResult(path, context, (p) => super.openBinaryReader(p, options, context)); }
	override writeFile(path: string, content: string | Uint8Array, context: Context) { return this.checkedResult(path, context, (p) => super.writeFile(p, content, context)); }
	override appendFile(path: string, content: string | Uint8Array, context: Context) { return this.checkedResult(path, context, (p) => super.appendFile(p, content, context)); }
	override truncateFile(path: string, size: number, context: Context) { return this.checkedResult(path, context, (p) => super.truncateFile(p, size, context)); }
	override flushFile(path: string, context: Context) { return this.checkedResult(path, context, (p) => super.flushFile(p, context)); }
	override fileInfo(path: string, context: Context) { return this.checkedResult(path, context, (p) => super.fileInfo(p, context)); }
	override listDir(path: string, context: Context) { return this.checkedResult(path, context, (p) => super.listDir(p, context)); }
	override listFiles(path: string, options: Parameters<RemoteExecutionEnv["listFiles"]>[1], context: Context) { return this.checkedResult(path, context, (p) => super.listFiles(p, options, context)); }
	override openDirReader(path: string, context: Context) { return this.checkedResult(path, context, (p) => super.openDirReader(p, context)); }
	override canonicalPath(path: string, context: Context) { return this.checkedResult(path, context, (p) => super.canonicalPath(p, context)); }
	override exists(path: string, context: Context) { return this.checkedResult(path, context, (p) => super.exists(p, context)); }
	override createDir(path: string, options: { recursive?: boolean } | undefined, context: Context) { return this.checkedResult(path, context, (p) => super.createDir(p, options, context)); }
	override remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context) { return this.checkedResult(path, context, (p) => super.remove(p, options, context)); }

	override async renameFile(sourcePath: string, destinationPath: string, context: Context): ReturnType<RemoteExecutionEnv["renameFile"]> {
		const source = await this.checked(sourcePath, context);
		if ("error" in source) return err<void, FileError>(source.error);
		const destination = await this.checked(destinationPath, context);
		if ("error" in destination) return err<void, FileError>(destination.error);
		return super.renameFile(source.path, destination.path, context);
	}

	override async watch(
		targets: readonly WatchTarget[],
		onChange: (change: WatchChange) => void,
		context: Context,
	): ReturnType<RemoteExecutionEnv["watch"]> {
		const safe = [];
		for (const target of targets) {
			const result = await this.checked(target.path, context);
			if ("error" in result) return err<FileWatcher, FileError>(result.error);
			safe.push({ ...target, path: result.path });
		}
		return super.watch(safe, onChange, context);
	}

	override async createTempDir(prefix: string | undefined, context: Context): ReturnType<RemoteExecutionEnv["createTempDir"]> {
		if (context.abortSignal?.aborted) return err<string, FileError>(new FileError("aborted", "aborted"));
		if (this.#closed) return err<string, FileError>(new FileError("invalid", "Execution environment is closed"));
		if (prefix?.includes("/") || prefix?.includes("\\") || prefix?.includes("\0")) {
			return err<string, FileError>(new FileError("invalid", "Temporary directory prefix must be a name"));
		}
		return super.createTempDir(prefix, context);
	}

	override async createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): ReturnType<RemoteExecutionEnv["createTempFile"]> {
		if ([options?.prefix, options?.suffix].some((part) => part?.includes("/") || part?.includes("\\") || part?.includes("\0"))) {
			return err<string, FileError>(new FileError("invalid", "Temporary file prefix and suffix must be names"));
		}
		return super.createTempFile(options, context);
	}

	override async exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		if (context.abortSignal?.aborted) return err<ShellExecResult, ExecutionError>(new ExecutionError("aborted", "aborted"));
		if (this.#closed) return err<ShellExecResult, ExecutionError>(new ExecutionError("spawn_error", "Execution environment is closed"));
		const requestedCwd = options?.cwd ?? this.cwd;
		const cwd = await this.checked(requestedCwd, context, false);
		if ("error" in cwd) {
			return err<ShellExecResult, ExecutionError>(new ExecutionError("spawn_error", cwd.error.message, cwd.error));
		}
		const actual = await super.canonicalPath(cwd.path, context);
		if (!actual.ok || !this.#roots.some((root) => isWithin(root, actual.value))) {
			const message = actual.ok ? "Shell cwd is outside allowed execution roots" : actual.error.message;
			return err<ShellExecResult, ExecutionError>(new ExecutionError("spawn_error", message, actual.ok ? undefined : actual.error));
		}
		const info = await super.fileInfo(actual.value, context);
		if (!info.ok || info.value.kind !== "directory") {
			const message = info.ok ? "Shell cwd is not a directory" : info.error.message;
			return err<ShellExecResult, ExecutionError>(new ExecutionError("spawn_error", message, info.ok ? undefined : info.error));
		}
		const safeEnv = { ...SHELL_ENV, HOME: GUEST_ROOT };
		const argv = typeof command === "string" ? ["/bin/sh", "-c", command] : [...command];
		if (argv.length === 0) return err<ShellExecResult, ExecutionError>(new ExecutionError("spawn_error", "Empty argv: no program to run"));
		const sandboxedCommand = [this.#bwrapPath, ...buildCommandBwrapArgs(GUEST_ROOT, actual.value, argv)];
		const { env: _ignored, inheritEnv: _ignoredInheritance, spill: _ignoredSpill, ...safeOptions } = options ?? {};
		const timeout = Math.min(options?.timeout ?? MAX_SHELL_TIMEOUT_SECONDS, MAX_SHELL_TIMEOUT_SECONDS);
		const window = {
			maxBytes: Math.min(
				options?.window?.maxBytes ?? SHELL_OUTPUT_WINDOW.maxBytes,
				SHELL_OUTPUT_WINDOW.maxBytes,
			),
			maxLines: Math.min(
				options?.window?.maxLines ?? SHELL_OUTPUT_WINDOW.maxLines,
				SHELL_OUTPUT_WINDOW.maxLines,
			),
			minIntervalMs: Math.max(
				options?.window?.minIntervalMs ?? SHELL_OUTPUT_WINDOW.minIntervalMs,
				SHELL_OUTPUT_WINDOW.minIntervalMs,
			),
			bytesPerSecond: Math.min(
				options?.window?.bytesPerSecond ?? SHELL_OUTPUT_WINDOW.bytesPerSecond,
				SHELL_OUTPUT_WINDOW.bytesPerSecond,
			),
		};
		return super.exec(sandboxedCommand, { ...safeOptions, timeout, window, cwd: cwd.path, env: safeEnv, inheritEnv: false }, context);
	}

	/**
	 * Stop the daemon and confirm its supervisor pid is gone. Without that pid, ownership is deliberately left
	 * unresolved: an in-flight pre-publication launcher cannot be distinguished from no launcher at all.
	 */
	async #stopDaemon(context: Context): Promise<void> {
		let failure: unknown;
		let supervisorPid: number | undefined;
		let attemptedPid: number | undefined;
		try {
			await super.cleanup(context);
		} catch (error) {
			failure = error;
		} finally {
			this.connection.close();
			try {
				const pidText = await readFile(this.#pidFile, "utf8").catch(() => "");
				const pid = Number(pidText.trim());
				if (Number.isSafeInteger(pid) && pid > 0) {
					attemptedPid = pid;
					await waitForPidExit(pid);
					supervisorPid = pid;
				}
			} catch (error) {
				failure ??= error;
			}
			await rm(this.#daemonDir, { recursive: true, force: true }).catch((error: unknown) => {
				failure ??= error;
			});
		}
		if (supervisorPid !== undefined) {
			// That supervisor is reaped, so no in-flight pre-publication launcher can remain. Drop only this launch's own
			// intent; a file that changed hands must stay fail-closed rather than be cleared by the wrong owner.
			try {
				const state = await readLaunchFile(this.#launchFile);
				if (state !== undefined) {
					if (state.nonce !== this.#nonce || (state.kind === "pid" && state.pid !== supervisorPid)) {
						throw new Error("Sandbox launch file changed ownership during teardown");
					}
					await rm(this.#launchFile, { force: true });
				}
			} catch (error) {
				failure ??= new Error("Sandbox launch file could not be removed; manual reconciliation is required", { cause: error });
			}
		}
		if (failure !== undefined) throw failure;
		if (supervisorPid === undefined) {
			const detail = attemptedPid === undefined ? "" : ` (supervisor pid ${attemptedPid} did not exit)`;
			throw new Error(`Sandbox launch could not be confirmed${detail}; launch intent retained for manual reconciliation`);
		}
	}

	override async cleanup(context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		try {
			await this.#stopDaemon(context);
		} catch (error) {
			// Teardown is unverified: keep the lock until this process exits rather than admit a second writer.
			this.#lock.retain();
			throw error;
		}
		await this.#lock.release();
	}

	/**
	 * Setup-failure teardown. Confirms the daemon is gone but deliberately keeps ownership: the caller still has to
	 * delete the partial workspace and only then releases the lock (or retains it if that rollback fails).
	 */
	async discard(context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		try {
			await this.#stopDaemon(context);
		} catch (error) {
			this.#lock.retain();
			throw error;
		}
	}
}

interface DaemonBundle {
	directory: string;
	binary: string;
	bwrapBinary: string;
	pidFile: string;
	launcher: string;
}

interface ImportBundle {
	directory: string;
	node: string;
	worker: string;
}

async function makeDaemonBundle(bwrapSource: string, launchFile: string, nonce: string): Promise<DaemonBundle> {
	const directory = await mkdtemp(join(tmpdir(), "nanobot-bwrap-"));
	try {
		const source = await realpath(localDaemon());
		const binary = join(directory, "pi-env");
		const bwrapBinary = join(directory, "bwrap");
		const pidFile = join(directory, "bwrap.pid");
		const launcher = join(directory, "launch");
		await copyFile(source, binary, constants.COPYFILE_EXCL);
		await chmod(binary, 0o500);
		await copyFile(bwrapSource, bwrapBinary, constants.COPYFILE_EXCL);
		await chmod(bwrapBinary, 0o500);
		// Publish the supervisor pid, claim only this launch's pending intent, then exec. Any failure before exec
		// leaves no sandbox; the owner's teardown must confirm this pid is gone before clearing the intent.
		const script = [
			"#!/bin/sh",
			"set -e",
			`launch=${shellQuote(launchFile)}`,
			`nonce=${shellQuote(nonce)}`,
			"pid=$$",
			`printf '%s\\n' "$pid" > ${shellQuote(pidFile)}`,
			'IFS= read -r current < "$launch" || exit 3',
			'[ "$current" = "pending $nonce" ] || exit 3',
			'tmp="$launch.tmp.$pid"',
			`printf 'pid %s %s\\n' "$pid" "$nonce" > "$tmp"`,
			'mv "$tmp" "$launch"',
			'IFS= read -r published < "$launch" || exit 4',
			'[ "$published" = "pid $pid $nonce" ] || exit 4',
			'exec "$@"',
			"",
		].join("\n");
		await writeFile(launcher, script, { mode: 0o700, flag: "wx" });
		return { directory, binary, bwrapBinary, pidFile, launcher };
	} catch (error) {
		await rm(directory, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}

async function makeImportBundle(): Promise<ImportBundle> {
	const directory = await mkdtemp(join(tmpdir(), "nanobot-import-"));
	try {
		const workerExtension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
		const workerSource = await realpath(fileURLToPath(new URL(`./import-worker${workerExtension}`, import.meta.url)));
		const nodeSource = await realpath(process.execPath);
		const node = join(directory, "node");
		const worker = join(directory, workerExtension === ".ts" ? "import-worker.ts" : "import-worker.mjs");
		await copyFile(nodeSource, node, constants.COPYFILE_EXCL);
		await chmod(node, 0o500);
		await copyFile(workerSource, worker, constants.COPYFILE_EXCL);
		await chmod(worker, 0o400);
		return { directory, node, worker };
	} catch (error) {
		await rm(directory, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}

async function runBoundedBwrap(
	binary: string,
	args: readonly string[],
	inheritedFds: readonly number[],
	context: Context,
): Promise<void> {
	if (context.abortSignal?.aborted) throw new Error("Import setup aborted");
	return new Promise<void>((resolvePromise, reject) => {
		const stdio: ("ignore" | "pipe" | number)[] = ["ignore", "pipe", "pipe", ...inheritedFds];
		const child = spawn(binary, [...args], {
			cwd: "/",
			detached: true,
			env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
			stdio,
		});
		let failure: Error | undefined;
		let stderr = "";
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const stop = () => {
			if (child.pid === undefined || child.exitCode !== null) return;
			try { process.kill(-child.pid, "SIGTERM"); } catch { /* The process group may already be gone. */ }
			killTimer = setTimeout(() => {
				try { process.kill(-child.pid!, "SIGKILL"); } catch { /* The process group may already be gone. */ }
			}, 750);
		};
		const fail = (error: Error) => {
			failure ??= error;
			stop();
		};
		const onAbort = () => fail(new Error("Import setup aborted"));
		const timer = setTimeout(() => fail(new Error("Import setup timed out")), IMPORT_TIMEOUT_MS);
		context.abortSignal?.addEventListener("abort", onAbort, { once: true });
		child.once("spawn", () => { if (failure) stop(); });
		child.once("error", (error) => fail(error));
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < 8192) stderr += chunk.toString("utf8").slice(0, 8192 - stderr.length);
		});
		child.stdout?.on("data", (chunk: Buffer) => {
			if (chunk.length > 8192) fail(new Error("Import worker output exceeded its bound"));
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			context.abortSignal?.removeEventListener("abort", onAbort);
			if (failure) reject(failure);
			else if (code !== 0) reject(new Error(`Import sandbox failed (${signal ?? code}): ${stderr.trim() || "no diagnostic"}`));
			else resolvePromise();
		});
		if (context.abortSignal?.aborted) onAbort();
	});
}

async function copyImportsIntoWorkspace(
	workspaceRoot: string,
	sources: readonly ImportSource[],
	bundle: ImportBundle,
	bwrapPath: string,
	context: Context,
): Promise<void> {
	if (sources.length === 0) return;
	const sourceIsTypeScript = bundle.worker.endsWith(".ts");
	const workerTarget = `/run/.nanobot-import-${randomUUID()}/import-worker${sourceIsTypeScript ? ".ts" : ".mjs"}`;
	const manifestTarget = `${dirname(workerTarget)}/imports.json`;
	const nodeTarget = `${dirname(workerTarget)}/node`;
	const manifestPath = join(bundle.directory, "imports.json");
	const mounts: ImportMount[] = [];
	const entries = sources.map((source, index) => {
		const sourceTarget = source.kind === "directory" ? `/imports/${index}` : `/imports/${index}/source`;
		mounts.push({ fd: 3 + index, target: sourceTarget, kind: source.kind });
		return { source: sourceTarget, destination: `imports/${source.name}`, kind: source.kind };
	});
	await writeFile(manifestPath, JSON.stringify(entries), { mode: 0o400, flag: "wx" });
	try {
		const args = buildImportBwrapArgs(
			workspaceRoot,
			mounts,
			bundle.worker,
			manifestPath,
			bundle.node,
			workerTarget,
			manifestTarget,
			nodeTarget,
			sourceIsTypeScript ? ["--experimental-strip-types"] : [],
		);
		await runBoundedBwrap(bwrapPath, args, sources.map((source) => source.handle.fd), context);
	} finally {
		await rm(manifestPath, { force: true });
	}
}

async function persistWorkspace(
	store: StorePaths,
	id: string,
	imports: readonly string[],
	bwrapPath: string,
	context: Context,
): Promise<WorkspaceRecord> {
	if (!Array.isArray(imports) || imports.length > 32) throw new Error("At most 32 explicit imports are supported");
	const sources: ImportSource[] = [];
	try {
		const names = new Set<string>();
		for (const path of imports) {
			if (typeof path !== "string") throw new Error("Import paths must be strings");
			const source = await openImportSource(path);
			if (names.has(source.name)) {
				await source.handle.close();
				throw new Error(`Import basename collision: ${source.name}`);
			}
			names.add(source.name);
			sources.push(source);
		}
		const paths = managedPaths(store, id);
		await mkdir(paths.container, { mode: 0o700 });
		await mkdir(paths.root, { mode: 0o700 });
		const before = await lstat(paths.root, { bigint: true });
		if (!before.isDirectory()) throw new Error("New managed workspace root is not a directory");
		requireOwner(before, "New managed workspace root");
		if (sources.length > 0) {
			const bundle = await makeImportBundle();
			try {
				await copyImportsIntoWorkspace(paths.root, sources, bundle, bwrapPath, context);
			} finally {
				await rm(bundle.directory, { recursive: true, force: true });
			}
		}
		const after = await lstat(paths.root, { bigint: true });
		if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) {
			throw new Error("Managed workspace root identity changed during import");
		}
		return { id, rootPath: paths.root, rootDev: String(after.dev), rootIno: String(after.ino) };
	} catch (error) {
		const paths = managedPaths(store, id);
		try {
			await rm(paths.container, { recursive: true, force: true });
		} catch (cleanupError) {
			throw new SandboxCleanupFailure(
				[error, cleanupError],
				`Managed workspace ${id} import failed and partial cleanup failed; inspect ${paths.container}`,
			);
		}
		throw error;
	} finally {
		await Promise.all(sources.map((source) => source.handle.close().catch(() => undefined)));
	}
}

async function verifyMountedWorkspace(connection: Connection, record: WorkspaceRecord, context: Context): Promise<void> {
	const reply = await setupWait(connection.request("lstat", { path: GUEST_ROOT }), context, "Sandbox workspace probe");
	const info = reply.json;
	const dev = Number(info.dev);
	const ino = Number(info.ino);
	if (
		info.kind !== "directory" ||
		!Number.isSafeInteger(dev) ||
		!Number.isSafeInteger(ino) ||
		String(dev) !== record.rootDev ||
		String(ino) !== record.rootIno
	) {
		throw new Error("Managed workspace root identity does not match its private admission record");
	}
}

async function startWorkspaceEnvironment(
	record: WorkspaceRecord,
	bundle: DaemonBundle,
	bwrapPath: string,
	options: ExecutionOptions,
	context: Context,
	lock: WorkspaceLock,
	launchFile: string,
	nonce: string,
): Promise<ManagedExecutionEnv> {
	const daemonInSandbox = `/run/.nanobot-pi-env-${randomUUID()}/pi-env`;
	const bwrapInSandbox = `${dirname(daemonInSandbox)}/bwrap`;
	let connection: Connection | undefined;
	let env: BwrapExecutionEnv | undefined;
	let intentWritten = false;
	try {
		await writeLaunchIntent(launchFile, nonce);
		intentWritten = true;
		connection = new Connection({
			command: [bundle.launcher, bwrapPath, ...buildBwrapArgs(record.rootPath, daemonInSandbox, bundle.binary, bundle.bwrapBinary)],
		});
		env = new BwrapExecutionEnv(
			{ connection, id: `nanobot:bwrap:${record.id}`, cwd: GUEST_ROOT },
			record.id,
			bundle.directory,
			bundle.pidFile,
			launchFile,
			nonce,
			bwrapInSandbox,
			lock,
		);
		await setupWait(connection.info(), context, "Bubblewrap daemon startup");
		await verifyMountedWorkspace(connection, record, context);
		const requestedCwd = options.cwd ?? GUEST_ROOT;
		const checkedCwd = await setupWait(env.absolutePath(requestedCwd, context), context, "cwd validation");
		if (!checkedCwd.ok) throw new Error(`cwd is not an allowed existing path: ${requestedCwd}: ${checkedCwd.error.message}`);
		const info = await setupWait(env.fileInfo(checkedCwd.value, context), context, "cwd validation");
		if (!info.ok || info.value.kind !== "directory") throw new Error(`cwd is not an allowed directory: ${requestedCwd}`);
		env.cwd = checkedCwd.value;
		const probe = await setupWait(env.exec(["/usr/bin/true"], { timeout: 5 }, context), context, "Bubblewrap execution probe");
		if (!probe.ok || probe.value.exitCode !== 0) {
			const detail = probe.ok ? `exit code ${probe.value.exitCode}` : probe.error.message;
			throw new Error(`Bubblewrap execution probe failed: ${detail}`);
		}
		if (context.abortSignal?.aborted) throw new Error("Execution environment setup aborted");
		return env;
	} catch (error) {
		if (env) {
			// Keep workspace ownership through the caller's rollback; discard does not release the lock.
			await env.discard(BACKGROUND_CONTEXT).catch((cleanupError: unknown) => {
				throw new SandboxCleanupFailure([error, cleanupError], "Execution environment setup failed and sandbox cleanup failed");
			});
		} else {
			// No Connection was constructed, so no launcher was spawned. Drop only an intent this launch created;
			// a pre-existing file must stay fail-closed for manual reconciliation.
			connection?.close();
			if (intentWritten) await rm(launchFile, { force: true }).catch(() => undefined);
			await rm(bundle.directory, { recursive: true, force: true }).catch(() => undefined);
		}
		throw error;
	}
}

export async function createExecutionEnv(
	options: ExecutionOptions,
	context: Context = BACKGROUND_CONTEXT,
): Promise<ManagedExecutionEnv> {
	validateManagedOptions(options);
	if (process.platform !== "linux") throw new Error("ExecutionEnv requires Linux; no unsandboxed fallback is available");
	if (context.abortSignal?.aborted) throw new Error("Execution environment setup aborted");
	const bwrap = await setupWait(validateBwrap(options.bwrapPath ?? "/usr/bin/bwrap"), context, "Bubblewrap validation");
	const store = await prepareStore(options.storageDirectory);
	const id = randomUUID();
	const lock = await acquireWorkspaceLock(store, id);
	let handedOff = false;
	try {
		let record: WorkspaceRecord;
		try {
			record = await persistWorkspace(store, id, options.imports ?? [], bwrap.path, context);
		} catch (error) {
			// persistWorkspace removed its partial container unless it reported an unverified cleanup failure.
			if (error instanceof SandboxCleanupFailure) lock.retain();
			throw error;
		}
		const paths = managedPaths(store, id);
		let bundle: DaemonBundle | undefined;
		try {
			await writeAdmission(store, record);
			const nonce = randomUUID();
			bundle = await makeDaemonBundle(bwrap.path, paths.launch, nonce);
			const created = bundle;
			const env = await startWorkspaceEnvironment(record, created, bwrap.path, options, context, lock, paths.launch, nonce);
			handedOff = true;
			return env;
		} catch (error) {
			if (error instanceof SandboxCleanupFailure) {
				lock.retain();
				throw new Error(`Managed workspace ${id} retained after sandbox cleanup failure`, { cause: error });
			}
			// The sandbox is either gone or never started; delete every host-side artifact before releasing ownership.
			const cleanupErrors: unknown[] = [];
			const attempt = async (action: () => Promise<unknown>) => {
				try {
					await action();
				} catch (cleanupError) {
					cleanupErrors.push(cleanupError);
				}
			};
			const bundleToRemove = bundle;
			if (bundleToRemove) await attempt(() => rm(bundleToRemove.directory, { recursive: true, force: true }));
			await attempt(() => rm(paths.admission, { force: true }));
			await attempt(() => rm(paths.container, { recursive: true, force: true }));
			// The whole workspace is being destroyed; its launch state has no remaining subject.
			await attempt(() => rm(paths.launch, { force: true }));
			if (cleanupErrors.length > 0) {
				lock.retain();
				throw new SandboxCleanupFailure(
					[error, ...cleanupErrors],
					`Managed workspace ${id} setup failed and cleanup failed; inspect ${paths.container}`,
				);
			}
			throw error;
		}
	} finally {
		// Release only after the complete rollback above; a retained lock is a deliberate fail-closed no-op.
		if (!handedOff) await lock.release().catch(() => lock.retain());
	}
}

export async function openExecutionEnv(
	workspaceId: string,
	options: ExecutionOptions = {},
	context: Context = BACKGROUND_CONTEXT,
): Promise<ManagedExecutionEnv> {
	validateManagedOptions(options);
	if (options.imports?.length) throw new Error("Imports are accepted only when creating a managed workspace");
	if (!validWorkspaceId(workspaceId)) throw new Error("Invalid managed workspace id");
	if (process.platform !== "linux") throw new Error("ExecutionEnv requires Linux; no unsandboxed fallback is available");
	if (context.abortSignal?.aborted) throw new Error("Execution environment setup aborted");
	const store = await prepareStore(options.storageDirectory);
	const lock = await acquireWorkspaceLock(store, workspaceId);
	let handedOff = false;
	try {
		// A previous owner may have died while its sandbox was still alive; refuse until that supervisor is reaped.
		await assertLaunchSafe(store, workspaceId);
		const record = await readAdmission(store, workspaceId);
		const paths = managedPaths(store, workspaceId);
		const bwrap = await setupWait(validateBwrap(options.bwrapPath ?? "/usr/bin/bwrap"), context, "Bubblewrap validation");
		const nonce = randomUUID();
		const bundle = await makeDaemonBundle(bwrap.path, paths.launch, nonce);
		try {
			const env = await startWorkspaceEnvironment(record, bundle, bwrap.path, options, context, lock, paths.launch, nonce);
			handedOff = true;
			return env;
		} catch (error) {
			await rm(bundle.directory, { recursive: true, force: true }).catch(() => undefined);
			throw error;
		}
	} finally {
		// Setup failure leaves the workspace intact; release only after its daemon teardown has been verified.
		if (!handedOff) await lock.release().catch(() => lock.retain());
	}
}

/**
 * Remove one managed workspace after every owner has stopped. The same kernel-held owner lock is required, so a live
 * environment (including one in another process) cannot be deleted underneath its guests.
 */
export async function removeExecutionWorkspace(
	workspaceId: string,
	options: ExecutionOptions = {},
	context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
	validateManagedOptions(options);
	if (options.imports?.length) throw new Error("Imports are accepted only when creating a managed workspace");
	if (!validWorkspaceId(workspaceId)) throw new Error("Invalid managed workspace id");
	if (process.platform !== "linux") throw new Error("ExecutionEnv requires Linux; no unsandboxed fallback is available");
	if (context.abortSignal?.aborted) throw new Error("Managed workspace removal aborted");
	const store = await prepareStore(options.storageDirectory);
	const lock = await acquireWorkspaceLock(store, workspaceId);
	let deleting = false;
	try {
		// A crashed owner may have left its sandbox running; never delete underneath a live guest.
		await assertLaunchSafe(store, workspaceId);
		// Authenticate the private admission record and root identity before deleting anything.
		await readAdmission(store, workspaceId);
		const paths = managedPaths(store, workspaceId);
		const container = await lstat(paths.container);
		privateDirectoryInfo(container, "Managed workspace container");
		deleting = true;
		await rm(paths.container, { recursive: true, force: true });
		await rm(paths.admission, { force: true });
		await rm(paths.launch, { force: true });
	} catch (error) {
		// A partial deletion must not be reopened by a new owner until this process exits.
		if (deleting) lock.retain();
		throw error;
	} finally {
		await lock.release();
	}
}
