import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Build a Bubblewrap argv that runs a command against the caller's actual
 * workspace, matching Python's `_bwrap` behavior instead of the managed-copy
 * sandbox in `sandbox.ts`.
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
	/** Optional host directory (Python's media directory) mounted read-only at the same path. Must not be the workspace or its parent. */
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
] as const;

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

function isWithin(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Resolve the Bubblewrap executable without an unsandboxed fallback.
 *
 * An explicitly configured path must resolve to an executable file. Without a
 * configured path, prefer the distro binary (the AppArmor profile on this host
 * is pinned to `/usr/bin/bwrap`) and then search PATH.
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
		if (!isExecutableFile(binary)) throw new Error(`Configured Bubblewrap is not executable: ${requested}`);
		return binary;
	}

	try {
		const distroBinary = realpathSync(DEFAULT_BWRAP);
		if (isExecutableFile(distroBinary)) return distroBinary;
	} catch {
		// Fall through to PATH only for the unconfigured default.
	}
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!directory || !isAbsolute(directory)) continue;
		const candidate = join(directory, "bwrap");
		if (!isExecutableFile(candidate)) continue;
		try {
			return realpathSync(candidate);
		} catch {
			// A dangling PATH entry is not a usable candidate.
		}
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
	return isWithin(workspace, canonical) ? canonical : workspace;
}

/**
 * Return the Bubblewrap argv for one shell command over the actual workspace.
 *
 * The workspace is bound read-write at its real path. It is not copied,
 * imported, staged, or published back. `/usr` and the existing optional system
 * paths are read-only, `/tmp` is a private tmpfs, and the workspace parent is
 * masked so sibling files such as a config file are not visible. Networking is
 * not unshared, matching the Python wrapper. This function writes nothing and
 * creates no sandbox state.
 */
export function buildDirectBwrapArgs(options: DirectBwrapOptions): string[] {
	const bwrap = resolveDirectBwrapPath(options.bwrapPath);

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
		if (isWithin(media, workspace)) {
			throw new Error("mediaDirectory must not be the workspace or one of its parents");
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

	const args = [bwrap, "--new-session", "--die-with-parent", "--setenv", "HOME", workspace];
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
