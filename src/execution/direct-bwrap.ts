import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { isPathWithin } from "./policy.js";

/**
 * Build a Bubblewrap argv that runs a command against the caller's actual
 * workspace, matching Python's `_bwrap` behavior.
 *
 * The returned value is an argv array. Paths and the cwd are never joined into
 * a shell string, so a path containing shell metacharacters cannot change the
 * command that runs.
 */
export interface DirectBwrapOptions {
	/** Absolute host workspace, mounted read-write at the same path. Must resolve to a directory other than `/`. */
	workspace: string;
	/** Requested cwd. Absolute paths and paths relative to `workspace` are accepted; outside cwd falls back to the workspace. */
	cwd?: string;
	/** Absolute Bubblewrap executable. Defaults to `/usr/bin/bwrap`, then PATH. A configured value never falls back. */
	bwrapPath?: string;
	/** Optional host directory (Python's media directory) mounted read-only at the same path. Must not overlap the workspace. */
	mediaDirectory?: string;
	/** Exact argv to execute inside the sandbox, e.g. `["/bin/sh", "-c", command]`. */
	command: readonly string[];
}

const DEFAULT_BWRAP = "/usr/bin/bwrap";
const REQUIRED_SYSTEM_RO_BINDS = ["/usr"] as const;
const OPTIONAL_SYSTEM_RO_BINDS = [
	"/bin",
	"/lib",
	"/lib64",
	"/etc/alternatives",
	"/etc/ssl/certs",
	"/etc/resolv.conf",
	"/etc/ld.so.cache",
	"/etc/passwd",
	"/etc/group",
	"/etc/hosts",
	"/etc/localtime",
] as const;

/**
 * Identity of one validated executable: the inode plus size and mtime, so both a replacement at
 * the same path and an in-place overwrite are detected. A pathname alone is not identity, because
 * the file at a validated path can be replaced between validation and a later spawn; a capable
 * attacker who can preserve inode, size and mtime while changing content is outside this
 * defensive boundary (and has already defeated the host it runs on).
 */
interface BwrapIdentity {
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
}

const validatedBwrap = new Map<string, BwrapIdentity>();

function requireAbsolute(path: string, label: string): string {
	if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
		throw new Error(`${label} must be an absolute path without NUL bytes`);
	}
	return path;
}

function isExecutableFile(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Validate identity and version once per canonical binary path; never fall back to another
 * executable. `force` re-runs the version check when the path now names a different file, so the
 * cached validation is never trusted across an executable swap.
 */
function validateBwrapBinary(binary: string, label: string, force = false): string {
	if (!force && validatedBwrap.has(binary)) return binary;
	if (!isExecutableFile(binary)) throw new Error(`${label} is not an executable file: ${binary}`);
	const result = spawnSync(binary, ["--version"], {
		encoding: "utf8",
		env: { PATH: "/usr/bin:/bin", LANG: "C" },
		timeout: 5000,
	});
	const match = /^bubblewrap (\d+)\.(\d+)\.(\d+)/.exec((result.stdout ?? "").trim());
	if (result.error || result.status !== 0 || !match) {
		throw new Error(
			`Bubblewrap validation failed at ${binary}: ${(result.stderr || result.error?.message || result.stdout || "unexpected version").trim()}`,
		);
	}
	if (Number(match[1]) === 0 && Number(match[2]) < 9) {
		throw new Error(`Bubblewrap ${match[0].replace("bubblewrap ", "")} at ${binary} is too old; 0.9 or newer is required`);
	}
	const info = statSync(binary);
	validatedBwrap.set(binary, { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs });
	return binary;
}

/**
 * Revalidate the executable target before one launch. The workspace, cwd and media paths are
 * re-resolved by the argv builder on every call, but bind-path revalidation cannot cover the
 * executable itself: this check compares the launch-time file against the inode/size/mtime
 * identity pinned at validation time, and a mismatch (a replaced, hard-linked-over or
 * overwritten binary) re-runs the full version validation against the file that is actually
 * there instead of trusting the pathname cache. Failure semantics stay the established ones: a binary that cannot be revalidated throws,
 * and a configured value never falls back to another executable.
 */
export function revalidateBwrapBinary(binary: string): string {
	requireAbsolute(binary, "bwrap");
	if (!isExecutableFile(binary)) throw new Error(`Bubblewrap is not an executable file: ${binary}`);
	const pinned = validatedBwrap.get(binary);
	if (pinned === undefined) return validateBwrapBinary(binary, "Bubblewrap");
	const info = statSync(binary);
	const sameFile = info.dev === pinned.dev && info.ino === pinned.ino
		&& info.size === pinned.size && info.mtimeMs === pinned.mtimeMs;
	return sameFile ? binary : validateBwrapBinary(binary, "Bubblewrap", true);
}

/**
 * Resolve the Bubblewrap executable without an unsandboxed fallback.
 *
 * An explicitly configured path must resolve to a valid `bubblewrap` binary of
 * version 0.9 or newer. Without a configured path, prefer the distro binary (the
 * AppArmor profile on this host is pinned to `/usr/bin/bwrap`) and then search
 * PATH. A distro binary that exists but fails validation throws rather than
 * silently selecting an unprofiled PATH build. There is no unsandboxed fallback.
 */
export function resolveDirectBwrapPath(configured?: string): string {
	if (process.platform !== "linux") {
		throw new Error("Direct Bubblewrap execution requires Linux; no unsandboxed fallback is available");
	}
	if (configured !== undefined) {
		const requested = requireAbsolute(configured, "bwrapPath");
		let binary: string;
		try {
			binary = realpathSync(requested);
		} catch {
			throw new Error(`Configured Bubblewrap does not exist: ${requested}`);
		}
		return validateBwrapBinary(binary, "Configured Bubblewrap");
	}

	if (existsSync(DEFAULT_BWRAP)) {
		let distroBinary: string;
		try {
			distroBinary = realpathSync(DEFAULT_BWRAP);
		} catch {
			throw new Error(`Distro Bubblewrap cannot be resolved: ${DEFAULT_BWRAP}`);
		}
		return validateBwrapBinary(distroBinary, "Distro Bubblewrap");
	}
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!directory || !isAbsolute(directory)) continue;
		const candidate = join(directory, "bwrap");
		if (!isExecutableFile(candidate)) continue;
		let binary: string;
		try {
			binary = realpathSync(candidate);
		} catch {
			continue;
		}
		return validateBwrapBinary(binary, "PATH Bubblewrap");
	}
	throw new Error("Bubblewrap was not found; install bwrap or configure an absolute bwrapPath");
}

function canonicalDirectory(path: string, label: string): string {
	let canonical: string;
	try {
		canonical = realpathSync(path);
	} catch {
		throw new Error(`${label} does not exist or cannot be resolved: ${path}`);
	}
	if (!statSync(canonical).isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
	return canonical;
}

function resolveWorkspaceCwd(workspace: string, requested?: string): string {
	if (requested === undefined) return workspace;
	if (typeof requested !== "string" || requested.includes("\0")) throw new Error("cwd must be a path without NUL bytes");
	const candidate = isAbsolute(requested) ? resolve(requested) : resolve(workspace, requested);
	let canonical: string;
	try {
		canonical = realpathSync(candidate);
	} catch {
		throw new Error(`cwd does not exist or cannot be resolved: ${requested}`);
	}
	if (!statSync(canonical).isDirectory()) throw new Error(`cwd is not a directory: ${requested}`);
	// Never widen access: a cwd outside the workspace falls back to the
	// workspace root, matching the Python wrapper.
	return isPathWithin(workspace, canonical) ? canonical : workspace;
}

/**
 * Return the Bubblewrap argv for one shell command over the actual workspace.
 *
 * The workspace is bound read-write at its real path. It is not copied,
 * imported, staged, or published back. `/usr`, the existing optional system
 * paths, and the normal passwd/group/hosts/localtime files are read-only,
 * `/tmp` is a private tmpfs, and the workspace parent is masked so sibling
 * files such as a config file are not visible. Networking is not unshared,
 * matching the Python wrapper. The PID namespace is unshared so background
 * descendants die with the sandbox instead of outliving the command. This
 * function writes nothing and creates no sandbox state.
 */
export function buildDirectBwrapArgs(options: DirectBwrapOptions): string[] {
	return buildDirectBwrapArgsWithBinary(resolveDirectBwrapPath(options.bwrapPath), options);
}

/**
 * The same argv with a binary the caller already resolved through `resolveDirectBwrapPath` (for
 * example once per environment), so a long-lived shell does not re-resolve it on every command.
 *
 * Only the executable's resolution is reused: the workspace, cwd and media paths are revalidated on
 * every call — each is re-resolved through `realpath` and re-checked immediately before the argv is
 * built — and the executable itself is rechecked against the (dev, ino) identity pinned at
 * validation time (`revalidateBwrapBinary`), so launching still revalidates everything it binds
 * and executes even though the binary resolution happened earlier.
 */
export function buildDirectBwrapArgsWithBinary(
	bwrap: string,
	options: Omit<DirectBwrapOptions, "bwrapPath">,
): string[] {
	// The executable target is revalidated here on every launch: the caller's resolved path is a
	// pathname, and only the identity check above proves the same file still answers to it.
	revalidateBwrapBinary(bwrap);
	const workspaceInput = requireAbsolute(options.workspace, "workspace");
	if (workspaceInput === sep) throw new Error("workspace must not be the host filesystem root");
	const workspace = canonicalDirectory(workspaceInput, "workspace");
	if (workspace === sep) throw new Error("workspace must not resolve to the host filesystem root");
	const cwd = resolveWorkspaceCwd(workspace, options.cwd);

	let media: string | undefined;
	if (options.mediaDirectory !== undefined) {
		const mediaInput = requireAbsolute(options.mediaDirectory, "mediaDirectory");
		if (mediaInput === sep) throw new Error("mediaDirectory must not be the host filesystem root");
		media = canonicalDirectory(mediaInput, "mediaDirectory");
		if (media === sep) throw new Error("mediaDirectory must not resolve to the host filesystem root");
		if (isPathWithin(media, workspace) || isPathWithin(workspace, media)) {
			throw new Error("mediaDirectory must not overlap the workspace");
		}
	}

	const command = options.command;
	if (!Array.isArray(command) || command.length === 0) {
		throw new Error("command must be a non-empty argv array");
	}
	for (const argument of command) {
		if (typeof argument !== "string" || argument.includes("\0")) {
			throw new Error("command arguments must be strings without NUL bytes");
		}
	}

	const args = [bwrap, "--new-session", "--die-with-parent", "--unshare-pid", "--setenv", "HOME", workspace];
	for (const path of REQUIRED_SYSTEM_RO_BINDS) args.push("--ro-bind", path, path);
	for (const path of OPTIONAL_SYSTEM_RO_BINDS) args.push("--ro-bind-try", path, path);
	args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");

	const parent = dirname(workspace);
	// /tmp is already a private tmpfs; a second mask over it would just stack.
	if (parent !== sep && parent !== "/tmp") args.push("--tmpfs", parent);
	args.push("--dir", workspace, "--bind", workspace, workspace);
	if (media !== undefined) args.push("--ro-bind", media, media);
	args.push("--chdir", cwd, "--", ...command);
	return args;
}
