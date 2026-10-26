import { access, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function within(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
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
	const result = spawnSync(binary, ["--version"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C" }, timeout: 5000 });
	const match = /^bubblewrap (\d+)\.(\d+)\.(\d+)/.exec((result.stdout ?? "").trim());
	if (result.error || result.status !== 0 || !match || Number(match[1]) < 0 || (Number(match[1]) === 0 && Number(match[2]) < 9)) {
		throw new Error(`Bubblewrap validation failed at ${binary}: ${(result.stderr || result.error?.message || result.stdout || "unexpected version").trim()}`);
	}
	return { path: binary, version: match[0]!.replace("bubblewrap ", "") };
}

function addTargetParents(args: string[], path: string): void {
	const ancestors: string[] = [];
	for (let current = dirname(path); current !== "/"; current = dirname(current)) ancestors.push(current);
	for (const ancestor of ancestors.reverse()) args.push("--dir", ancestor);
}

export async function buildBwrapArgs(binary: string, roots: readonly string[], cwd: string, command: readonly string[]): Promise<string[]> {
	const args = [
		binary,
		"--unshare-user", "--unshare-pid", "--unshare-net", "--die-with-parent", "--new-session",
		"--cap-drop", "ALL", "--clearenv",
		"--setenv", "PATH", "/usr/bin:/bin",
		"--setenv", "HOME", roots[0]!, "--setenv", "TMPDIR", "/tmp", "--setenv", "LANG", "C.UTF-8",
		"--ro-bind", "/usr", "/usr",
	];
	for (const [path, link] of [["/bin", "usr/bin"], ["/lib", "usr/lib"], ["/lib64", "usr/lib64"]] as const) {
		args.push("--symlink", link, path);
	}
	args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
	for (const systemPath of ["/etc/ssl/certs", "/etc/alternatives", "/etc/ld.so.cache"]) {
		try {
			await access(systemPath);
			addTargetParents(args, systemPath);
			args.push("--ro-bind-try", systemPath, systemPath);
		} catch { /* Optional system files. */ }
	}
	for (const root of [...roots].sort((a, b) => a.length - b.length)) {
		addTargetParents(args, root);
		args.push("--bind", root, root);
	}
	if (!roots.some((root) => within(root, cwd))) throw new Error(`cwd outside execution roots: ${cwd}`);
	args.push("--chdir", cwd, "--", ...command);
	return args;
}
