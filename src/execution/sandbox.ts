import { access, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

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

function addTargetParents(args: string[], path: string): void {
	const ancestors: string[] = [];
	for (let current = dirname(path); current !== "/"; current = dirname(current)) ancestors.push(current);
	for (const ancestor of ancestors.reverse()) args.push("--dir", ancestor);
}

/** Build the namespace that runs pi-env itself, so every filesystem syscall is inside bwrap too. */
export function buildBwrapArgs(
	roots: readonly string[],
	daemonPath: string,
	daemonBinary: string,
	bwrapBinary: string,
): string[] {
	const args = [
		"--unshare-user",
		"--unshare-pid",
		"--unshare-net",
		"--die-with-parent",
		"--new-session",
		"--cap-drop",
		"ALL",
		"--clearenv",
		"--setenv",
		"PATH",
		"/usr/bin:/bin",
		"--setenv",
		"HOME",
		roots[0]!,
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
	addTargetParents(args, daemonPath);
	args.push("--ro-bind", daemonBinary, daemonPath);
	const bwrapTarget = `${dirname(daemonPath)}/bwrap`;
	args.push("--ro-bind", bwrapBinary, bwrapTarget);
	for (const root of [...roots].sort((a, b) => a.length - b.length)) {
		// Do not shadow host /tmp before Bubblewrap resolves a root mounted from there.
		if (!root.startsWith("/tmp/")) addTargetParents(args, root);
		args.push("--bind", root, root);
	}
	// With a workspace below /tmp, its bind creates private ancestors there; creating /tmp again would mask it.
	if (!roots.some((root) => root.startsWith("/tmp/"))) args.push("--dir", "/tmp");
	args.push("--chdir", roots[0]!, "--");
	return args;
}

/** Wrap one shell command in a PID namespace so cancellation kills even setsid-detached descendants. */
export function buildCommandBwrapArgs(
	roots: readonly string[],
	cwd: string,
	command: readonly string[],
): string[] {
	const args = [
		"--unshare-user",
		"--unshare-pid",
		"--unshare-net",
		"--die-with-parent",
		"--as-pid-1",
		"--cap-drop",
		"ALL",
		"--clearenv",
		"--setenv",
		"PATH",
		"/usr/bin:/bin",
		"--setenv",
		"HOME",
		roots[0]!,
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
	for (const root of [...roots].sort((a, b) => a.length - b.length)) {
		if (!root.startsWith("/tmp/")) addTargetParents(args, root);
		args.push("--bind", root, root);
	}
	if (!roots.some((root) => root.startsWith("/tmp/"))) args.push("--dir", "/tmp");
	args.push("--chdir", cwd, "--", ...command);
	return args;
}
