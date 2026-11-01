import { randomUUID } from "node:crypto";
import { constants, existsSync, statSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readlink, realpath, rm, writeFile as writeFileHost, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import {
	ExecutionError,
	FileError,
	err,
	ok,
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	type FileInfo,
	type FileWatcher,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type TextLineReader,
	type WatchChange,
	type WatchTarget,
} from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
	createExecutionPolicy,
	defaultShellEnvironment,
	isPathWithin,
	type ExecutionPolicy,
	type FilesystemPathProbe,
	type ShellPolicyOptions,
} from "./policy.js";
import { buildDirectBwrapArgs, resolveDirectBwrapPath } from "./direct-bwrap.js";

/** Optional direct-workspace Bubblewrap shell. Filesystem calls remain the guarded native implementation. */
export interface BwrapShellOptions {
	/** Absolute trusted Bubblewrap executable. Absent prefers `/usr/bin/bwrap`, then PATH. There is no host fallback. */
	bwrapPath?: string;
}

interface BwrapShell {
	readonly binary: string;
	readonly interpreter: readonly [string, ...string[]];
}

/**
 * A host environment that can create a file atomically. The digest writer uses this instead of a
 * `stat` check plus a truncating write, so a concurrent create cannot be overwritten. A host
 * environment without it fails that write closed instead of falling back.
 */
export interface ExclusiveFileCreate {
	createFileExclusive(
		path: string,
		content: string | Uint8Array,
		context: Context,
	): Promise<Result<void, FileError>>;
}

/** True only when `env` really exposes the exclusive create this module implements. */
export function supportsExclusiveFileCreate(env: object): env is ExclusiveFileCreate {
	return typeof (env as Partial<ExclusiveFileCreate>).createFileExclusive === "function";
}

export interface HostExecutionOptions {
	/** Existing directory that is the workspace root. It is canonicalized once at creation. */
	workspaceRoot: string;
	/** Extra roots the filesystem guard accepts, in addition to the workspace and the private scratch directory. */
	allowedRoots?: readonly string[];
	/** Shared shell policy overrides. The host supplies HOME, TMPDIR, PATH and LANG defaults. */
	shell?: ShellPolicyOptions;
	/** Initial cwd, absolute or relative to `workspaceRoot`; must be inside the configured roots. */
	cwd?: string;
	/**
	 * Run shell commands under direct-workspace Bubblewrap. The workspace is the actual read-write directory; there is no
	 * managed copy or publish-back. Filesystem methods stay native and guarded. Absent keeps the native host shell. A
	 * configured backend that cannot start fails the call; it never falls back to host execution.
	 */
	shellSandbox?: BwrapShellOptions;
	/**
	 * Scratch directory for spills and temp files. Defaults to a private, owner-only directory under the host temp
	 * root. It is always an allowed root so the native bash spill path remains readable while the environment lives.
	 * Spill/temp paths last only for the environment lifetime: the owned default is removed on `cleanup`, and an
	 * explicit directory stays caller-owned. Never treat a spill path as durable storage.
	 */
	tempDirectory?: string;
}

/**
 * A guarded host environment for accidental-damage protection, not confinement. Filesystem methods refuse lexical and
 * symlink escapes from the configured roots, but:
 *
 * - a shell command can still read or write anything the process user can, and networking remains available; the
 *   optional Bubblewrap shell narrows that mount view but is still not hostile isolation;
 * - a hard link inside a root to an outside inode is indistinguishable by path and is allowed, so writes or removals
 *   through it affect the outside inode;
 * - a dangling symlink is refused even when its textual target is inside, because resolution cannot be authorized;
 * - `NodeExecutionEnv` kills the command's process group on timeout, abort and cleanup, but a host descendant that
 *   creates a new session/process group (for example with `setsid`) escapes that teardown; the Bubblewrap shell adds
 *   `--unshare-pid` and `--die-with-parent` for its own descendants.
 *
 * File *content* reads and writes do not rely on the path check alone. The policy resolves symlinks before the
 * operation, and a concurrent process could swap a path component in between; so the operation is performed through a
 * descriptor that is opened first and then identified from `/proc/self/fd`, and a descriptor that resolved outside the
 * roots is refused before any byte moves. This is what keeps a private file outside the roots out of a racing read
 * tool call, not the pre-check by itself. Directory listings, `create`, `rename`, `remove` and `watch` keep the
 * resolved-path check; they disclose no file content.
 *
 * The shell timeout, environment allowlist, command filters and filesystem checks all come from `./policy.ts`; the
 * Bubblewrap shell uses that same policy and the direct-workspace argv builder rather than a second policy.
 */
export class HostExecutionEnv extends NodeExecutionEnv implements ExecutionEnv {
	readonly #policy: ExecutionPolicy;
	readonly #workspaceRoot: string;
	readonly #tempRoot: string;
	readonly #ownsTempRoot: boolean;
	readonly #bwrap: BwrapShell | undefined;
	/** `/proc/self/fd` where the platform provides it: the operation-time identity check for file content. */
	readonly #descriptorRoot: string | undefined;

	constructor(options: {
		cwd: string;
		workspaceRoot: string;
		policy: ExecutionPolicy;
		tempRoot: string;
		ownsTempRoot: boolean;
		bwrap?: BwrapShell;
	}) {
		super({ cwd: options.cwd });
		this.#policy = options.policy;
		this.#workspaceRoot = options.workspaceRoot;
		this.#tempRoot = options.tempRoot;
		this.#ownsTempRoot = options.ownsTempRoot;
		this.#bwrap = options.bwrap;
		this.#descriptorRoot = existsSync("/proc/self/fd") ? "/proc/self/fd" : undefined;
	}

	async #probe(context: Context): Promise<FilesystemPathProbe> {
		return {
			canonicalPath: (path) => super.canonicalPath(path, context),
			fileInfo: (path) => super.fileInfo(path, context),
		};
	}

	async #absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
		return super.absolutePath(path, context);
	}

	async #guarded<T>(
		path: string,
		context: Context,
		followFinalLink: boolean,
		run: (absolutePath: string) => Promise<Result<T, FileError>>,
	): Promise<Result<T, FileError>> {
		const absolute = await this.#absolutePath(path, context);
		if (!absolute.ok) return absolute;
		const denied = await this.#policy.checkFilesystemPath(
			absolute.value,
			await this.#probe(context),
			followFinalLink,
		);
		return denied === undefined ? run(absolute.value) : err<T, FileError>(denied);
	}

	/**
	 * Run one content operation against a descriptor whose identity was verified after opening.
	 *
	 * The policy check resolves the path first; between that and the operation a concurrent process can
	 * swap a component for a symbolic link. Opening here and reading `/proc/self/fd/<fd>` reports the file
	 * the descriptor really refers to, because that entry resolves to the opened inode and not to a path.
	 * A descriptor outside every root is refused before the operation runs; an accepted one is then the
	 * operation target itself, so the operation's own open cannot be redirected either. Without procfs the
	 * guard keeps its resolved-path check, as the module docs say.
	 *
	 * `flags` never truncates: a refused descriptor must not have damaged the file, so the delegated
	 * operation does its own truncate or write against the verified inode.
	 */
	async #throughDescriptor<T>(
		absolute: string,
		flags: string | number,
		context: Context,
		run: (target: string) => Promise<Result<T, FileError>>,
	): Promise<Result<T, FileError>> {
		if (context.abortSignal?.aborted) return err<T, FileError>(new FileError("aborted", "aborted", absolute));
		const root = this.#descriptorRoot;
		if (root === undefined) return run(absolute);
		let handle: FileHandle | undefined;
		try {
			handle = await open(absolute, flags);
			const actual = await readlink(`${root}/${handle.fd}`);
			if (!this.#policy.roots.some((candidate) => isPathWithin(candidate, actual))) {
				return err<T, FileError>(new FileError(
					"permission_denied",
					`The opened file resolved outside the execution workspace: ${absolute}`,
					absolute,
				));
			}
			return await run(`${root}/${handle.fd}`);
		} catch (error) {
			return err<T, FileError>(openError(error, absolute));
		} finally {
			await handle?.close().catch(() => undefined);
		}
	}

	override readTextFile(path: string, context: Context) {
		return this.#guarded(path, context, true, (absolute) =>
			this.#throughDescriptor(absolute, "r", context, (target) => super.readTextFile(target, context)));
	}

	override openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		return this.#guarded(path, context, true, (absolute) =>
			this.#throughDescriptor(absolute, "r", context, (target) => super.openTextLineReader(target, context)));
	}

	override readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>> {
		// Delegates to the guarded `openTextLineReader`, so it inherits the same descriptor check.
		return super.readTextLines(path, options, context);
	}

	override readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		return this.#guarded(path, context, true, (absolute) =>
			this.#throughDescriptor(absolute, "r", context, (target) => super.readBinaryFile(target, context)));
	}

	override openBinaryReader(
		path: string,
		options: { noFollow?: boolean } | undefined,
		context: Context,
	): Promise<Result<BinaryReader, FileError>> {
		// `noFollow` means the final component is not a symlink the operation may follow, so the parent is the boundary.
		const noFollow = options?.noFollow === true;
		return this.#guarded(path, context, !noFollow, async (absolute) => {
			const verified = await this.#throughDescriptor(
				absolute,
				// O_NOFOLLOW rejects a final symbolic link here; the delegated open must not then re-read the
				// verified proc entry as a link of its own.
				noFollow ? constants.O_RDONLY | constants.O_NOFOLLOW : "r",
				context,
				(target) => super.openBinaryReader(target, noFollow ? { ...options, noFollow: false } : options, context),
			);
			if (!verified.ok) return verified;
			const reader = verified.value;
			// The reader was opened through a descriptor entry, which is not the path the caller asked for:
			// report the caller's path and name as the native reader would.
			return ok<BinaryReader, FileError>({
				info: async (inner) => reportedInfo(await reader.info(inner), absolute),
				read: (offset, length, inner) => reader.read(offset, length, inner),
				scanLines: (scan, inner) => reader.scanLines(scan, inner),
				close: (inner) => reader.close(inner),
			});
		});
	}

	override writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.#guarded(path, context, true, async (absolute) => {
			// The native write creates missing parents; the descriptor has to exist before it can be opened.
			const prepared = await ensureParent(absolute);
			return prepared === undefined
				? this.#throughDescriptor(absolute, "a", context, (target) => super.writeFile(target, content, context))
				: err<void, FileError>(prepared);
		});
	}

	override appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.#guarded(path, context, true, async (absolute) => {
			const prepared = await ensureParent(absolute);
			return prepared === undefined
				? this.#throughDescriptor(absolute, "a", context, (target) => super.appendFile(target, content, context))
				: err<void, FileError>(prepared);
		});
	}

	override truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		return this.#guarded(path, context, true, (absolute) =>
			this.#throughDescriptor(absolute, "r+", context, (target) => super.truncateFile(target, size, context)));
	}

	override flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		return this.#guarded(path, context, true, (absolute) =>
			this.#throughDescriptor(absolute, "r+", context, (target) => super.flushFile(target, context)));
	}

	/**
	 * Create a new file, failing when any directory entry already has that name.
	 *
	 * This is a real `O_CREAT | O_EXCL` create at the guarded absolute path, not a check followed by a
	 * truncating write: a concurrent create by this process or by an outside editor makes the call fail
	 * with `invalid` ("the file already exists") and nothing is overwritten. It stays inside the same
	 * guarded roots as `writeFile`, and `O_EXCL` never follows a final symbolic link. Missing parent
	 * directories are created first, matching the native write. It is not a lock and does not join
	 * another tool's in-process mutation queue; callers that need ordering with a concurrent `write`
	 * keep the exclusive result, not a substitute write.
	 */
	async createFileExclusive(
		path: string,
		content: string | Uint8Array,
		context: Context,
	): Promise<Result<void, FileError>> {
		return this.#guarded(path, context, true, async (absolute) => {
			if (context.abortSignal?.aborted) return err<void, FileError>(new FileError("aborted", "aborted", absolute));
			try {
				await mkdir(dirname(absolute), { recursive: true });
				await writeFileHost(absolute, content, { flag: "wx" });
				return ok(undefined);
			} catch (error) {
				if ((error as NodeJS.ErrnoException | null)?.code === "EEXIST") {
					return err<void, FileError>(new FileError("invalid", "the file already exists", absolute));
				}
				return err<void, FileError>(toFileError(error));
			}
		});
	}

	override fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		// `fileInfo` uses lstat-like semantics: a final symlink is reported, not followed.
		return this.#guarded(path, context, false, (absolute) => super.fileInfo(absolute, context));
	}

	override listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		return this.#guarded(path, context, true, (absolute) => super.listDir(absolute, context));
	}

	override openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		return this.#guarded(path, context, true, (absolute) => super.openDirReader(absolute, context));
	}

	override canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.#guarded(path, context, true, (absolute) => super.canonicalPath(absolute, context));
	}

	override exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		return this.#guarded(path, context, false, (absolute) => super.exists(absolute, context));
	}

	override createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		// mkdir does not follow a final symlink; its parent is the boundary.
		return this.#guarded(path, context, false, (absolute) => super.createDir(absolute, options, context));
	}

	override remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		// Removing a symbolic link removes the link, not what it points at.
		return this.#guarded(path, context, false, (absolute) => super.remove(absolute, options, context));
	}

	override async renameFile(
		sourcePath: string,
		destinationPath: string,
		context: Context,
	): Promise<Result<void, FileError>> {
		const source = await this.#absolutePath(sourcePath, context);
		if (!source.ok) return source;
		const destination = await this.#absolutePath(destinationPath, context);
		if (!destination.ok) return destination;
		const probe = await this.#probe(context);
		const deniedSource = await this.#policy.checkFilesystemPath(source.value, probe, false);
		if (deniedSource !== undefined) return err<void, FileError>(deniedSource);
		const deniedDestination = await this.#policy.checkFilesystemPath(destination.value, probe, false);
		if (deniedDestination !== undefined) return err<void, FileError>(deniedDestination);
		return super.renameFile(source.value, destination.value, context);
	}

	override async watch(
		targets: readonly WatchTarget[],
		onChange: (change: WatchChange) => void,
		context: Context,
	): Promise<Result<FileWatcher, FileError>> {
		const safe: WatchTarget[] = [];
		for (const target of targets) {
			const absolute = await this.#absolutePath(target.path, context);
			if (!absolute.ok) return absolute;
			const denied = await this.#policy.checkFilesystemPath(
				absolute.value,
				await this.#probe(context),
				true,
			);
			if (denied !== undefined) return err<FileWatcher, FileError>(denied);
			safe.push({ ...target, path: absolute.value });
		}
		return super.watch(safe, onChange, context);
	}

	override async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		if (context.abortSignal?.aborted) return err<string, FileError>(new FileError("aborted", "aborted"));
		const name = prefix === undefined || prefix === "" ? "tmp-" : prefix;
		const invalid = invalidNamePart(name);
		if (invalid !== undefined) return err<string, FileError>(invalid);
		try {
			await mkdir(this.#tempRoot, { recursive: true, mode: 0o700 });
			return ok(await mkdtemp(join(this.#tempRoot, name)));
		} catch (error) {
			return err<string, FileError>(toFileError(error));
		}
	}

	override async createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): Promise<Result<string, FileError>> {
		const invalid =
			invalidNamePart(options?.prefix ?? "") ?? invalidNamePart(options?.suffix ?? "");
		if (invalid !== undefined) return err<string, FileError>(invalid);
		const directory = await this.createTempDir("tmp-", context);
		if (!directory.ok) return directory;
		const path = join(directory.value, `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`);
		try {
			await writeFileHost(path, "");
			return ok(path);
		} catch (error) {
			return err<string, FileError>(toFileError(error));
		}
	}

	override async cleanup(context: Context): Promise<void> {
		try {
			await super.cleanup(context);
		} finally {
			// Owned spill/temp paths are environment-lifetime only; never treat them as durable storage.
			if (this.#ownsTempRoot) await rm(this.#tempRoot, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	override async exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		if (context.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		const cwd = await this.#absolutePath(options?.cwd ?? this.cwd, context);
		if (!cwd.ok) return err(new ExecutionError("spawn_error", cwd.error.message, cwd.error));
		const deniedCwd = await this.#policy.checkFilesystemPath(cwd.value, await this.#probe(context), true);
		if (deniedCwd !== undefined) {
			return err(new ExecutionError("spawn_error", deniedCwd.message, deniedCwd));
		}
		const denied = this.#policy.checkCommand(command, { cwd: cwd.value });
		if (denied !== undefined) return err(new ExecutionError("spawn_error", denied));
		const timeout = this.#policy.resolveShellTimeout(options?.timeout);
		if (!timeout.ok) return err(timeout.error);
		const safe: ShellExecOptions = {
			...(options ?? {}),
			cwd: cwd.value,
			// Caller env and inheritEnv are ignored: only the shared allowlist reaches the shell.
			env: this.#policy.shellEnvironment(),
			inheritEnv: false,
		};
		if (timeout.value === undefined) delete safe.timeout;
		else safe.timeout = timeout.value;
		if (this.#bwrap === undefined) return super.exec(command, safe, context);

		// The sandbox mounts only the workspace; a cwd in an extra allowed root would silently fall back to the
		// workspace inside the builder, so refuse it instead of running somewhere the caller did not ask for.
		if (!isPathWithin(this.#workspaceRoot, cwd.value)) {
			return err(
				new ExecutionError(
					"spawn_error",
					`Bubblewrap shell cwd is outside the workspace: ${cwd.value}`,
				),
			);
		}

		let argv: string[];
		try {
			argv = buildDirectBwrapArgs({
				workspace: this.#workspaceRoot,
				cwd: cwd.value,
				bwrapPath: this.#bwrap.binary,
				command:
					typeof command === "string"
						? [...this.#bwrap.interpreter, command]
						: [...command],
			});
		} catch (error) {
			const cause = error instanceof Error ? error : new Error(String(error));
			return err(new ExecutionError("spawn_error", cause.message, cause));
		}
		return super.exec(
			argv,
			{
				...safe,
				// The host scratch root is not mounted inside the sandbox. Its `/tmp` is a private writable tmpfs, while
				// bash spill files are still written by this host process under the private scratch root and stay readable.
				env: { ...safe.env, TMPDIR: "/tmp" },
			},
			context,
		);
	}
}

/** Create a write target's parent directories, as the native write does, and report a failure as a FileError. */
async function ensureParent(absolute: string): Promise<FileError | undefined> {
	try {
		await mkdir(dirname(absolute), { recursive: true });
		return undefined;
	} catch (error) {
		return openError(error, absolute);
	}
}

/** Report the caller's path and name on metadata read through a verified-descriptor target. */
function reportedInfo(result: Result<FileInfo, FileError>, path: string): Result<FileInfo, FileError> {
	if (!result.ok) return result;
	return ok<FileInfo, FileError>({ ...result.value, path, name: basename(path) });
}

/** Map an open failure the way the native environment does, so callers see the same codes. */
function openError(error: unknown, path: string): FileError {
	if (error instanceof FileError) return error;
	const cause = error instanceof Error ? error : new Error(String(error));
	switch ((cause as NodeJS.ErrnoException).code) {
		case "ABORT_ERR":
			return new FileError("aborted", cause.message, path, cause);
		case "ENOENT":
			return new FileError("not_found", cause.message, path, cause);
		case "EACCES":
		case "EPERM":
			return new FileError("permission_denied", cause.message, path, cause);
		case "ENOTDIR":
			return new FileError("not_directory", cause.message, path, cause);
		case "EISDIR":
			return new FileError("is_directory", cause.message, path, cause);
		case "EINVAL":
			return new FileError("invalid", cause.message, path, cause);
		// O_NOFOLLOW reports a final-component symlink as ELOOP (EMLINK on some BSDs).
		case "ELOOP":
		case "EMLINK":
			return new FileError("invalid", `Refusing to follow a symbolic link: ${path}`, path, cause);
		default:
			return new FileError("unknown", cause.message, path, cause);
	}
}

/** Prefer bash inside the sandbox for native bash-tool semantics, then fall back to the mounted system shell. */
function sandboxInterpreter(): readonly [string, ...string[]] {
	for (const candidate of ["/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh"]) {
		try {
			if (statSync(candidate).isFile()) return [candidate, "-c"];
		} catch {
			// Try the next mounted system path.
		}
	}
	return ["sh", "-c"];
}

function resolveBwrapShell(options: BwrapShellOptions | undefined): BwrapShell | undefined {
	if (options === undefined) return undefined;
	return { binary: resolveDirectBwrapPath(options.bwrapPath), interpreter: sandboxInterpreter() };
}

/** Create a guarded host environment. The root, allowed roots, cwd and default scratch directory are canonicalized once. */
export async function createHostExecutionEnv(options: HostExecutionOptions): Promise<HostExecutionEnv> {
	// Roots reach the policy only after this one canonicalization so the policy itself can stay usable with virtual
	// sandbox paths and never needs to call realpath.
	const root = await canonicalDirectory(options.workspaceRoot, "workspaceRoot");
	const allowedRoots: string[] = [];
	for (const allowed of options.allowedRoots ?? []) {
		allowedRoots.push(await canonicalDirectory(allowed, "allowedRoots entry"));
	}
	let tempRoot: string | undefined;
	let ownsTempRoot = false;
	try {
		if (options.tempDirectory === undefined) {
			tempRoot = await realpath(await mkdtemp(join(tmpdir(), "nanobot-host-exec-")));
			ownsTempRoot = true;
		} else {
			tempRoot = resolve(options.tempDirectory);
			await mkdir(tempRoot, { recursive: true, mode: 0o700 });
			tempRoot = await canonicalDirectory(tempRoot, "tempDirectory");
		}
		const roots = [...new Set([root, ...allowedRoots, tempRoot])];
		const cwd = await initialCwd(options.cwd, root, roots);
		const shell: ShellPolicyOptions = {
			...options.shell,
			environment: {
				...defaultShellEnvironment(root, tempRoot, options.shell?.hostEnvironment ?? process.env),
				...options.shell?.environment,
			},
		};
		const policy = createExecutionPolicy({ roots, shell });
		const bwrap = resolveBwrapShell(options.shellSandbox);
		return new HostExecutionEnv({
			cwd,
			workspaceRoot: root,
			policy,
			tempRoot,
			ownsTempRoot,
			...(bwrap === undefined ? {} : { bwrap }),
		});
	} catch (error) {
		// A failure after scratch creation must not leave an owned private directory behind.
		if (ownsTempRoot && tempRoot !== undefined) {
			await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
		}
		throw error;
	}
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
	const actual = await realpath(path);
	const info = await lstat(actual);
	if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
	return actual;
}

async function initialCwd(value: string | undefined, root: string, roots: readonly string[]): Promise<string> {
	if (value === undefined) return root;
	const candidate = isAbsolute(value) ? resolve(value) : resolve(root, value);
	const actual = await canonicalDirectory(candidate, "cwd");
	if (!roots.some((allowed) => isPathWithin(allowed, actual))) {
		throw new Error(`cwd is outside the execution workspace: ${value}`);
	}
	return actual;
}

function invalidNamePart(value: string): FileError | undefined {
	if (value.includes("/") || value.includes("\\") || value.includes("\0")) {
		return new FileError("invalid", "Temporary path prefixes and suffixes must be names");
	}
	return undefined;
}

function toFileError(error: unknown): FileError {
	if (error instanceof FileError) return error;
	const message = error instanceof Error ? error.message : String(error);
	return new FileError("unknown", message);
}
