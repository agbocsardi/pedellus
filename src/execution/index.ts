import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, mkdtemp, realpath, rm, stat, writeFile, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
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
import { buildBwrapArgs, buildCommandBwrapArgs, shellQuote, validateBwrap } from "./sandbox.js";

export interface ExecutionOptions {
	workspace: string;
	cwd?: string;
	extraAllowedDirs?: readonly string[];
	bwrapPath?: string;
}

interface Root {
	path: string;
	dev: number;
	ino: number;
}

const SETUP_TIMEOUT_MS = 10_000;
const TEARDOWN_TIMEOUT_MS = 5_000;
const PRIVATE_TMP = "/tmp";
const RESTRICTED_SYSTEM_ROOTS = [
	"/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/proc", "/sys", "/dev", "/run", "/var", "/opt", "/boot", "/root",
];
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

async function canonicalRoot(path: string, label: string): Promise<Root> {
	if (!isAbsolute(path) || path.includes("\0")) throw new Error(`${label} must be an absolute path`);
	const root = await realpath(path);
	const info = await stat(root);
	if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
	return { path: root, dev: info.dev, ino: info.ino };
}

function checkRootLocation(root: string): void {
	if (root === "/") throw new Error("Execution roots must not expose the host filesystem root");
	for (const systemRoot of RESTRICTED_SYSTEM_ROOTS) {
		if (isWithin(systemRoot, root) || isWithin(root, systemRoot)) {
			throw new Error(`Execution root overlaps a protected system path: ${root}`);
		}
	}
	// Host /tmp is not mounted. Mounting it as a root would expose unrelated host temporary data.
	if (root === PRIVATE_TMP || isWithin(root, PRIVATE_TMP)) {
		throw new Error(`Execution root must not replace the private temporary directory: ${root}`);
	}
}

function aborted<T>(context: Context, path?: string): Result<T, FileError> | undefined {
	return context.abortSignal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
}

function setupWait<T>(promise: Promise<T>, context: Context, label: string): Promise<T> {
	if (context.abortSignal?.aborted) return Promise.reject(new Error("Execution environment setup aborted"));
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

class BwrapExecutionEnv extends RemoteExecutionEnv implements ExecutionEnv {
	readonly #roots: readonly string[];
	readonly #daemonDir: string;
	readonly #pidFile: string;
	readonly #bwrapPath: string;
	#closed = false;

	constructor(
		options: RemoteExecutionEnvOptions,
		roots: readonly string[],
		daemonDir: string,
		pidFile: string,
		bwrapPath: string,
	) {
		super(options);
		this.#roots = roots;
		this.#daemonDir = daemonDir;
		this.#pidFile = pidFile;
		this.#bwrapPath = bwrapPath;
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
		const safeEnv = { ...SHELL_ENV, HOME: this.#roots[0]! };
		const argv = typeof command === "string" ? ["/bin/sh", "-c", command] : [...command];
		if (argv.length === 0) return err<ShellExecResult, ExecutionError>(new ExecutionError("spawn_error", "Empty argv: no program to run"));
		const sandboxedCommand = [this.#bwrapPath, ...buildCommandBwrapArgs(this.#roots, actual.value, argv)];
		const { env: _ignored, inheritEnv: _ignoredInheritance, ...safeOptions } = options ?? {};
		return super.exec(sandboxedCommand, { ...safeOptions, cwd: cwd.path, env: safeEnv, inheritEnv: false }, context);
	}

	override async cleanup(context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		let failure: unknown;
		try {
			await super.cleanup(context);
		} catch (error) {
			failure = error;
		} finally {
			this.connection.close();
			try {
				const pidText = await readFile(this.#pidFile, "utf8").catch(() => "");
				const pid = Number(pidText.trim());
				if (Number.isSafeInteger(pid) && pid > 0) await waitForPidExit(pid);
			} catch (error) {
				failure ??= error;
			}
			await rm(this.#daemonDir, { recursive: true, force: true }).catch((error: unknown) => {
				failure ??= error;
			});
		}
		if (failure !== undefined) throw failure;
	}
}

async function makeDaemonBundle(bwrapSource: string): Promise<{ directory: string; binary: string; bwrapBinary: string; pidFile: string; launcher: string }> {
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
		const script = `#!/bin/sh\nprintf '%s\\n' "$$" > ${shellQuote(pidFile)}\nexec "$@"\n`;
		await writeFile(launcher, script, { mode: 0o700, flag: "wx" });
		return { directory, binary, bwrapBinary, pidFile, launcher };
	} catch (error) {
		await rm(directory, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}

async function verifyMountedRoots(connection: Connection, roots: readonly Root[], context: Context): Promise<void> {
	for (const root of roots) {
		const reply = await setupWait(connection.request("lstat", { path: root.path }), context, "Sandbox root probe");
		const info = reply.json;
		if (info.kind !== "directory" || Number(info.dev) !== root.dev || Number(info.ino) !== root.ino) {
			throw new Error(`Execution root changed while the Bubblewrap namespace was being created: ${root.path}`);
		}
	}
}

export async function createExecutionEnv(options: ExecutionOptions, context: Context = BACKGROUND_CONTEXT): Promise<ExecutionEnv> {
	if (process.platform !== "linux") throw new Error("ExecutionEnv requires Linux; no unsandboxed fallback is available");
	if (context.abortSignal?.aborted) throw new Error("Execution environment setup aborted");
	const bwrap = await setupWait(validateBwrap(options.bwrapPath ?? "/usr/bin/bwrap"), context, "Bubblewrap validation");
	const rootRecords = [await canonicalRoot(options.workspace, "workspace")];
	for (const extra of options.extraAllowedDirs ?? []) rootRecords.push(await canonicalRoot(extra, "extraAllowedDirs entry"));
	const roots = [...new Map(rootRecords.map((root) => [root.path, root])).values()];
	const home = await realpath(process.env.HOME ?? homedir());
	for (const root of roots) {
		checkRootLocation(root.path);
		if (isWithin(root.path, home) || isWithin(home, root.path)) {
			throw new Error(`Execution root must not expose the host home directory: ${root.path}`);
		}
	}
	for (const root of roots) {
		if (roots.some((other) => root.path !== other.path && isWithin(root.path, other.path))) {
			throw new Error(`Execution roots must not contain one another: ${root.path}`);
		}
	}
	const bundle = await makeDaemonBundle(bwrap.path);
	const daemonInSandbox = `/run/.nanobot-pi-env-${randomUUID()}/pi-env`;
	const bwrapInSandbox = `${dirname(daemonInSandbox)}/bwrap`;
	const connection = new Connection({
		command: [
			bundle.launcher,
			bwrap.path,
			...buildBwrapArgs(roots.map((root) => root.path), daemonInSandbox, bundle.binary, bundle.bwrapBinary),
			daemonInSandbox,
		],
	});
	const cwd = roots[0]!.path;
	const env = new BwrapExecutionEnv(
		{ connection, id: "nanobot:bwrap:local", cwd },
		roots.map((root) => root.path),
		bundle.directory,
		bundle.pidFile,
		bwrapInSandbox,
	);
	try {
		await setupWait(connection.info(), context, "Bubblewrap daemon startup");
		await verifyMountedRoots(connection, roots, context);
		const requestedCwd = options.cwd ?? cwd;
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
		await env.cleanup(BACKGROUND_CONTEXT).catch((cleanupError: unknown) => {
			throw new AggregateError([error, cleanupError], "Execution environment setup failed and sandbox cleanup failed");
		});
		throw error;
	}
}
