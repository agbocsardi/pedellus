import { access, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

export interface ImportMount {
	fd: number;
	target: string;
	kind: "file" | "directory";
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function executable(path: string): Promise<string> {
	if (!isAbsolute(path) || path.includes("\0")) throw new Error("bwrapPath must be an absolute path");
	const resolved = await realpath(path);
	await access(resolved, 1);
	return resolved;
}

export async function validateBwrap(path: string): Promise<{ path: string; version: string }> {
	if (process.platform !== "linux") throw new Error("Bubblewrap is supported only on Linux");
	const binary = await executable(path);
	const { spawnSync } = await import("node:child_process");
	const result = spawnSync(binary, ["--version"], {
		encoding: "utf8",
		env: { PATH: "/usr/bin:/bin", LANG: "C" },
		timeout: 5000,
	});
	const match = /^bubblewrap (\d+)\.(\d+)\.(\d+)/.exec((result.stdout ?? "").trim());
	if (
		result.error ||
		result.status !== 0 ||
		!match ||
		Number(match[1]) < 0 ||
		(Number(match[1]) === 0 && Number(match[2]) < 9)
	) {
		throw new Error(
			`Bubblewrap validation failed at ${binary}: ${(result.stderr || result.error?.message || result.stdout || "unexpected version").trim()}`,
		);
	}
	return { path: binary, version: match[0]!.replace("bubblewrap ", "") };
}

function addTargetParents(args: string[], path: string, directories: Set<string>): void {
	const ancestors: string[] = [];
	for (let current = dirname(path); current !== "/"; current = dirname(current)) ancestors.push(current);
	for (const ancestor of ancestors.reverse()) {
		if (directories.has(ancestor)) continue;
		args.push("--dir", ancestor);
		directories.add(ancestor);
	}
}

function baseArgs(home = "/workspace"): string[] {
	const args = [
		"--unshare-user",
		"--unshare-pid",
		"--unshare-net",
		"--die-with-parent",
		"--cap-drop",
		"ALL",
		"--clearenv",
		"--setenv",
		"PATH",
		"/usr/bin:/bin",
		"--setenv",
		"HOME",
		home,
		"--setenv",
		"TMPDIR",
		"/tmp",
		"--setenv",
		"LANG",
		"C.UTF-8",
		"--ro-bind",
		"/usr",
		"/usr",
	];
	for (const [path, target] of [["/bin", "usr/bin"], ["/lib", "usr/lib"], ["/lib64", "usr/lib64"]] as const) {
		args.push("--symlink", target, path);
	}
	args.push("--proc", "/proc", "--dev", "/dev");
	return args;
}

/** Build the outer namespace that runs pi-env itself; only the app-created workspace is writable. */
export function buildBwrapArgs(
	workspaceSource: string,
	daemonPath: string,
	daemonBinary: string,
	bwrapBinary: string,
): string[] {
	const args = [...baseArgs(), "--new-session"];
	const directories = new Set<string>();
	addTargetParents(args, daemonPath, directories);
	args.push("--ro-bind", daemonBinary, daemonPath);
	const bwrapTarget = `${dirname(daemonPath)}/bwrap`;
	args.push("--ro-bind", bwrapBinary, bwrapTarget);
	args.push("--dir", "/workspace");
	directories.add("/workspace");
	args.push("--bind", workspaceSource, "/workspace", "--dir", "/tmp");
	args.push("--chdir", "/workspace", "--", daemonPath);
	return args;
}

/** One-shot read-only import of selected sources into a new managed workspace. */
export function buildImportBwrapArgs(
	workspaceSource: string,
	imports: readonly ImportMount[],
	workerSource: string,
	manifestSource: string,
	nodeSource: string,
	workerTarget: string,
	manifestTarget: string,
	nodeTarget: string,
	nodeFlags: readonly string[] = [],
): string[] {
	const args = [...baseArgs(), "--new-session", "--as-pid-1"];
	const directories = new Set<string>();
	args.push("--dir", "/workspace");
	directories.add("/workspace");
	args.push("--bind", workspaceSource, "/workspace");
	for (const item of imports) {
		addTargetParents(args, item.target, directories);
		if (item.kind === "directory") {
			args.push("--dir", item.target);
			directories.add(item.target);
		}
		args.push("--ro-bind-fd", String(item.fd), item.target);
	}
	addTargetParents(args, workerTarget, directories);
	args.push("--ro-bind", workerSource, workerTarget);
	addTargetParents(args, manifestTarget, directories);
	args.push("--ro-bind", manifestSource, manifestTarget);
	addTargetParents(args, nodeTarget, directories);
	args.push("--ro-bind", nodeSource, nodeTarget);
	args.push("--dir", "/tmp", "--chdir", "/workspace", "--", nodeTarget, ...nodeFlags, workerTarget, manifestTarget);
	return args;
}

/** Wrap a shell command in a fresh PID/network namespace to contain detached descendants. */
export function buildCommandBwrapArgs(
	workspaceRoot: string,
	cwd: string,
	command: readonly string[],
): string[] {
	const args = [...baseArgs(), "--new-session", "--as-pid-1"];
	const directories = new Set<string>();
	addTargetParents(args, workspaceRoot, directories);
	args.push("--bind", workspaceRoot, workspaceRoot, "--dir", "/tmp", "--chdir", cwd, "--", ...command);
	return args;
}
