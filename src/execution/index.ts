import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
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
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { buildBwrapArgs, shellQuote, validateBwrap } from "./sandbox.js";

export interface ExecutionOptions {
	workspace: string;
	cwd?: string;
	extraAllowedDirs?: readonly string[];
	bwrapPath?: string;
}

function isWithin(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function canonicalRoot(path: string, label: string): Promise<string> {
	if (!isAbsolute(path) || path.includes("\0")) throw new Error(`${label} must be an absolute path`);
	const root = await realpath(path);
	if (!(await stat(root)).isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
	return root;
}

class ConfinedExecutionEnv extends NodeExecutionEnv implements ExecutionEnv {
	readonly #roots: readonly string[];
	readonly #tempRoot: string;
	readonly #tempPaths = new Set<string>();
	readonly #bwrap: string;
	#closed = false;

	constructor(roots: readonly string[], cwd: string, bwrap: string) {
		super({ cwd });
		this.#roots = roots;
		this.#tempRoot = resolve(roots[0]!, `.pi-execution-tmp-${randomUUID()}`);
		this.#bwrap = bwrap;
	}

	private async checked(path: string, context?: Context): Promise<{ path: string } | { error: FileError }> {
		const absolute = resolve(this.cwd, path);
		if (context?.abortSignal?.aborted) return { error: new FileError("aborted", "aborted", absolute) };
		try {
			// Resolve existing ancestors, then append the missing suffix. This protects
			// missing write leaves and detects current symlink escapes, but is not an
			// OS-level race-free capability (see EXECUTION.md).
			let probe = absolute;
			const missing: string[] = [];
			while (true) {
				try {
					const actual = await realpath(probe);
					const target = resolve(actual, ...missing.reverse());
					if (!this.#roots.some((root) => isWithin(root, target))) {
						return { error: new FileError("permission_denied", "Path is outside allowed execution roots", absolute) };
					}
					return { path: absolute };
				} catch (error) {
					if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
					// A dangling symlink is not a missing leaf: following it for a write
					// could create a file outside every allowed root.
					try {
						await lstat(probe);
						return { error: new FileError("permission_denied", "Unresolvable symlink path is not allowed", absolute) };
					} catch (statError) {
						if (!(statError && typeof statError === "object" && "code" in statError && statError.code === "ENOENT")) throw statError;
					}
					const parent = dirname(probe);
					if (parent === probe) throw error;
					missing.push(probe.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
					probe = parent;
				}
			}
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
			return { error: new FileError(code === "ENOENT" ? "not_found" : "unknown", String(error), absolute) };
		}
	}

	private async checkedResult<T>(path: string, context: Context, call: (absolute: string) => Promise<Result<T, FileError>>): Promise<Result<T, FileError>> {
		const resolved = await this.checked(path, context);
		return "error" in resolved ? err<T, FileError>(resolved.error) : call(resolved.path);
	}

	override async absolutePath(path: string, context: Context): ReturnType<NodeExecutionEnv["absolutePath"]> {
		const absolute = resolve(this.cwd, path);
		const checked = await this.checked(absolute, context);
		return "error" in checked ? err<string, FileError>(checked.error) : ok(checked.path);
	}

	override async joinPath(parts: string[], context: Context): ReturnType<NodeExecutionEnv["joinPath"]> {
		if (context.abortSignal?.aborted) return err<string, FileError>(new FileError("aborted", "aborted"));
		const result = await super.joinPath(parts, context);
		if (!result.ok) return result;
		const checked = await this.checked(result.value, context);
		return "error" in checked ? err<string, FileError>(checked.error) : ok(checked.path);
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
	override openDirReader(path: string, context: Context) { return this.checkedResult(path, context, (p) => super.openDirReader(p, context)); }
	override canonicalPath(path: string, context: Context) { return this.checkedResult(path, context, (p) => super.canonicalPath(p, context)); }
	override exists(path: string, context: Context) { return this.checkedResult(path, context, (p) => super.exists(p, context)); }
	override createDir(path: string, options: { recursive?: boolean } | undefined, context: Context) { return this.checkedResult(path, context, (p) => super.createDir(p, options, context)); }
	override remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context) { return this.checkedResult(path, context, (p) => super.remove(p, options, context)); }

	override async renameFile(sourcePath: string, destinationPath: string, context: Context): ReturnType<NodeExecutionEnv["renameFile"]> {
		const source = await this.checked(sourcePath, context);
		if ("error" in source) return err<void, FileError>(source.error);
		const destination = await this.checked(destinationPath, context);
		if ("error" in destination) return err<void, FileError>(destination.error);
		return super.renameFile(source.path, destination.path, context);
	}

	override async watch(targets: Parameters<NodeExecutionEnv["watch"]>[0], onChange: Parameters<NodeExecutionEnv["watch"]>[1], context: Context): ReturnType<NodeExecutionEnv["watch"]> {
		const safe = [];
		for (const target of targets) {
			const checked = await this.checked(target.path, context);
			if ("error" in checked) return err<FileWatcher, FileError>(checked.error);
			safe.push({ ...target, path: checked.path });
		}
		return super.watch(safe, onChange, context);
	}

	override async createTempDir(prefix: string | undefined, context: Context): ReturnType<NodeExecutionEnv["createTempDir"]> {
		if (context.abortSignal?.aborted) return err<string, FileError>(new FileError("aborted", "aborted"));
		if (this.#closed) return err<string, FileError>(new FileError("invalid", "Execution environment is closed"));
		try {
			if (prefix?.includes("/") || prefix?.includes("\\") || prefix?.includes("\0")) {
				return err<string, FileError>(new FileError("invalid", "Temporary directory prefix must be a name"));
			}
			await mkdir(this.#tempRoot, { recursive: true, mode: 0o700 });
			const tempStat = await lstat(this.#tempRoot);
			const realTempRoot = await realpath(this.#tempRoot);
			if (!tempStat.isDirectory() || tempStat.isSymbolicLink() || !this.#roots.some((root) => isWithin(root, realTempRoot))) {
				return err<string, FileError>(new FileError("permission_denied", "Temporary directory escaped the workspace", this.#tempRoot));
			}
			// Host temporary directories are not mounted in the shell. Place spill files
			// in a private workspace directory instead.
			const resultPath = await mkdtemp(resolve(this.#tempRoot, prefix ?? "tmp-"));
			if (context.abortSignal?.aborted) {
				await rm(resultPath, { recursive: true, force: true });
				return err<string, FileError>(new FileError("aborted", "aborted", resultPath));
			}
			this.#tempPaths.add(resultPath);
			return ok(resultPath);
		} catch (error) {
			return err<string, FileError>(new FileError("unknown", String(error)));
		}
	}

	override async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): ReturnType<NodeExecutionEnv["createTempFile"]> {
		if (context.abortSignal?.aborted) return err<string, FileError>(new FileError("aborted", "aborted"));
		if ([options?.prefix, options?.suffix].some((part) => part?.includes("/") || part?.includes("\\") || part?.includes("\0"))) {
			return err<string, FileError>(new FileError("invalid", "Temporary file prefix and suffix must be names"));
		}
		const dir = await this.createTempDir("tmp-", context);
		if (!dir.ok) return dir;
		const path = resolve(dir.value, `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`);
		try {
			await writeFile(path, "", { flag: "wx", mode: 0o600 });
			if (context.abortSignal?.aborted) {
				await rm(dir.value, { recursive: true, force: true });
				this.#tempPaths.delete(dir.value);
				return err<string, FileError>(new FileError("aborted", "aborted", path));
			}
			return ok(path);
		} catch (error) {
			return err<string, FileError>(new FileError("unknown", String(error), path));
		}
	}

	override async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
		if (context.abortSignal?.aborted) return err<ShellExecResult, ExecutionError>(new ExecutionError("aborted", "aborted"));
		if (this.#closed) return err<ShellExecResult, ExecutionError>(new ExecutionError("spawn_error", "Execution environment is closed"));
		const requestedCwd = options?.cwd ? resolve(this.cwd, options.cwd) : this.cwd;
		const safeCwd = await this.checked(requestedCwd, context);
		if ("error" in safeCwd) return err<ShellExecResult, ExecutionError>(new ExecutionError("spawn_error", safeCwd.error.message, safeCwd.error));
		const argv = typeof command === "string" ? ["/bin/sh", "-c", command] : [...command];
		if (!argv.length) return err<ShellExecResult, ExecutionError>(new ExecutionError("spawn_error", "Empty argv: no program to run"));
		let args: string[];
		try {
			args = await buildBwrapArgs(this.#bwrap, this.#roots, safeCwd.path, argv);
		} catch (error) {
			return err<ShellExecResult, ExecutionError>(new ExecutionError("spawn_error", error instanceof Error ? error.message : String(error), error instanceof Error ? error : undefined));
		}
		if (context.abortSignal?.aborted) return err<ShellExecResult, ExecutionError>(new ExecutionError("aborted", "aborted"));
		return super.exec(["/bin/sh", "-c", args.map(shellQuote).join(" ")], {
			...options,
			cwd: this.cwd,
			env: { PATH: "/usr/bin:/bin", HOME: this.#roots[0]!, TMPDIR: "/tmp", LANG: "C.UTF-8" },
			inheritEnv: false,
		}, context);
	}

	override async cleanup(context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await super.cleanup(context);
		await Promise.all([...this.#tempPaths].map((path) => rm(path, { recursive: true, force: true }).catch(() => undefined)));
		this.#tempPaths.clear();
		await rm(this.#tempRoot, { recursive: true, force: true }).catch(() => undefined);
	}
}

export async function createExecutionEnv(options: ExecutionOptions): Promise<ExecutionEnv> {
	if (process.platform !== "linux") throw new Error("ExecutionEnv requires Linux; no unsandboxed fallback is available");
	const bwrap = await validateBwrap(options.bwrapPath ?? "/usr/bin/bwrap");
	const roots = [await canonicalRoot(options.workspace, "workspace")];
	for (const extra of options.extraAllowedDirs ?? []) roots.push(await canonicalRoot(extra, "extraAllowedDirs entry"));
	const uniqueRoots = [...new Set(roots)];
	const home = await realpath(process.env.HOME ?? homedir());
	for (const root of uniqueRoots) {
		if (root === "/" || isWithin(root, home)) throw new Error(`Execution root must not expose the host home directory: ${root}`);
	}
	for (const root of uniqueRoots) {
		if (uniqueRoots.some((other) => root !== other && isWithin(root, other))) {
			throw new Error(`Execution roots must not contain one another: ${root}`);
		}
	}
	const cwd = resolve(options.cwd ?? uniqueRoots[0]!);
	const env = new ConfinedExecutionEnv(uniqueRoots, cwd, bwrap.path);
	try {
		const check = await env.absolutePath(cwd, BACKGROUND_CONTEXT);
		if (!check.ok) throw new Error(`cwd is not an allowed existing path: ${cwd}: ${check.error.message}`);
		let cwdInfo;
		try {
			cwdInfo = await stat(check.value);
		} catch (error) {
			throw new Error(`cwd does not exist: ${cwd}`, { cause: error });
		}
		if (!cwdInfo.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
		// Verify namespace setup and require an actual successful process exit.
		const probe = await env.exec(["/usr/bin/true"], { timeout: 5 }, BACKGROUND_CONTEXT);
		if (!probe.ok || probe.value.exitCode !== 0) {
			const detail = probe.ok ? `exit code ${probe.value.exitCode}` : probe.error.message;
			throw new Error(`Bubblewrap execution probe failed: ${detail}`);
		}
		return env;
	} catch (error) {
		await env.cleanup(BACKGROUND_CONTEXT);
		throw error;
	}
}
