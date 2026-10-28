import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { ExecutionError, FileError, err, ok, type FileInfo, type Result } from "@earendil-works/pi-durable/env";

/**
 * Shared execution policy for every backend. The filesystem and shell parts here are the only source of truth for
 * path containment, shell command filters, the environment allowlist and the timeout. Backends must import this module
 * rather than carry their own copy; `ExecutionEnv` is the layer that sees the actual syscall or process.
 *
 * Path checks are decisions about the original path. Callers keep operating on the path they were given and must not
 * use the canonical path returned by a probe as the operation target, because that would change no-follow, rename and
 * removal semantics.
 */

/** Command filter applied to shell text after lower-casing, matching the Python tool's behaviour. */
export const DEFAULT_SHELL_DENY_PATTERNS: readonly string[] = [
	String.raw`\brm\s+-[rf]{1,2}\b`, // rm -r, rm -rf, rm -fr
	String.raw`\bdel\s+/[fq]\b`, // del /f, del /q
	String.raw`\brmdir\s+/s\b`, // rmdir /s
	String.raw`(?:^|[;&|]\s*)format(?!=)\b`, // format as a standalone command only
	String.raw`\b(mkfs|diskpart)\b`, // disk operations
	String.raw`\bdd\s+if=`, // dd input from a device
	String.raw`>\s*/dev/sd`, // write to a block device
	String.raw`\b(shutdown|reboot|poweroff)\b`, // system power
	String.raw`:\(\)\s*\{.*\};\s*:`, // fork bomb
	// Direct writes to bot-managed state files. These are managed by the application, and a shell write can corrupt
	// their cursor/format invariants.
	String.raw`>>?\s*\S*(?:history\.jsonl|\.dream_cursor)`,
	String.raw`\btee\b[^|;&<>]*(?:history\.jsonl|\.dream_cursor)`,
	String.raw`\b(?:cp|mv)\b(?:\s+[^\s|;&<>]+)+\s+\S*(?:history\.jsonl|\.dream_cursor)`,
	String.raw`\bdd\b[^|;&<>]*\bof=\S*(?:history\.jsonl|\.dream_cursor)`,
	String.raw`\bsed\s+-i[^|;&<>]*(?:history\.jsonl|\.dream_cursor)`,
];

const DEFAULT_TIMEOUT_SECONDS = 60;
const DEFAULT_MAX_TIMEOUT_SECONDS = 600;
const SHELL_SEGMENT_OPERATORS = new Set([";", "|"]);
const SHELL_CHAIN_OPERATORS = ["&&", "||"];
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ShellPolicyOptions {
	/** Hard default when the caller omits a timeout. 0 disables the default. */
	timeoutSeconds?: number;
	/** Upper bound applied to a caller-supplied timeout. 0 disables the cap. */
	maxTimeoutSeconds?: number;
	/** Host environment keys copied into the shell environment after `environment`. */
	allowedEnvKeys?: readonly string[];
	/** Patterns that allow every top-level segment despite the deny list. */
	allowPatterns?: readonly string[];
	/** Extra deny patterns appended to the ported defaults. */
	denyPatterns?: readonly string[];
	/** Explicit values passed to every command. These are the only non-allowlisted values. */
	environment?: Readonly<Record<string, string>>;
	/** Source for `allowedEnvKeys`; defaults to `process.env`. */
	hostEnvironment?: Readonly<Record<string, string | undefined>>;
}

export interface ExecutionPolicyOptions {
	/** Absolute roots the backend may operate in. The first root is the workspace root. */
	roots: readonly string[];
	shell?: ShellPolicyOptions;
}

export interface FilesystemPathProbe {
	canonicalPath(path: string): Promise<Result<string, FileError>>;
	/** Metadata of the path itself, usually `lstat`, so a symbolic link is reported as a link. */
	fileInfo(path: string): Promise<Result<FileInfo, FileError>>;
}

export interface ExecutionPolicy {
	readonly roots: readonly string[];
	/** Lexical containment: resolves `..` but never touches the filesystem. */
	checkPath(path: string): FileError | undefined;
	/**
	 * Detect a symlink escape for one operation. `followFinalLink` must match what the operation does with its final
	 * component: true when it follows a leaf symlink (read/write), false when it acts on the link itself (remove,
	 * rename, lstat) or on the parent directory (create).
	 */
	checkFilesystemPath(
		path: string,
		probe: FilesystemPathProbe,
		followFinalLink: boolean,
	): Promise<FileError | undefined>;
	/** Return a human-readable denial for a shell command, or undefined when it may run. */
	checkCommand(command: string | readonly string[]): string | undefined;
	shellEnvironment(): Record<string, string>;
	resolveShellTimeout(requested: number | undefined): Result<number | undefined, ExecutionError>;
}

/** Lexical containment check. Both paths must already be absolute; `..` is normalized by `resolve`. */
export function isPathWithin(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Default environment for a backend whose workspace is `root` and whose scratch space is `tempRoot`. */
export function defaultShellEnvironment(
	root: string,
	tempRoot: string,
	hostEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
	return {
		PATH: hostEnvironment.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		HOME: root,
		TMPDIR: tempRoot,
		LANG: hostEnvironment.LANG ?? "C.UTF-8",
		TERM: "dumb",
		PYTHONUNBUFFERED: "1",
	};
}

function positiveNumber(value: number | undefined, fallback: number, name: string, allowZero: boolean): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
		throw new Error(`${name} must be ${allowZero ? "zero or " : ""}a finite positive number of seconds`);
	}
	return value;
}

function escapePattern(pattern: string): RegExp {
	return new RegExp(`^(?:${pattern})$`);
}

/**
 * Split a shell command on top-level `;`, `|`, `&&` and `||`. Parentheses group, and quoted text is not split. This
 * mirrors the Python tool's allowlist behaviour: a chained command is allowed only when every segment matches.
 */
export function splitShellSegments(command: string): string[] {
	const segments: string[] = [];
	let current: string[] = [];
	let quote: string | undefined;
	let escaped = false;
	let parenDepth = 0;
	let index = 0;
	while (index < command.length) {
		const character = command[index]!;
		if (escaped) {
			current.push(character);
			escaped = false;
			index += 1;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			current.push(character);
			escaped = true;
			index += 1;
			continue;
		}
		if (quote !== undefined) {
			current.push(character);
			if (character === quote) quote = undefined;
			index += 1;
			continue;
		}
		if (character === "'" || character === '"' || character === "`") {
			current.push(character);
			quote = character;
			index += 1;
			continue;
		}
		if (character === "(") {
			parenDepth += 1;
			current.push(character);
			index += 1;
			continue;
		}
		if (character === ")" && parenDepth > 0) {
			parenDepth -= 1;
			current.push(character);
			index += 1;
			continue;
		}
		let operatorLength = 0;
		if (parenDepth === 0) {
			if (SHELL_CHAIN_OPERATORS.some((operator) => command.startsWith(operator, index))) {
				operatorLength = 2;
			} else if (SHELL_SEGMENT_OPERATORS.has(character)) {
				operatorLength = 1;
			}
		}
		if (operatorLength > 0) {
			const segment = current.join("").trim();
			if (segment !== "") segments.push(segment);
			current = [];
			index += operatorLength;
			continue;
		}
		current.push(character);
		index += 1;
	}
	const segment = current.join("").trim();
	if (segment !== "") segments.push(segment);
	return segments;
}

function commandText(command: string | readonly string[]): string {
	return typeof command === "string" ? command : command.join(" ");
}

function normalizeRoots(roots: readonly string[]): string[] {
	if (roots.length === 0) throw new Error("Execution policy requires at least one root");
	return [...new Set(roots.map((root) => resolve(root)))];
}

export function createExecutionPolicy(options: ExecutionPolicyOptions): ExecutionPolicy {
	const roots = normalizeRoots(options.roots);
	const shell = options.shell ?? {};
	const timeoutSeconds = positiveNumber(shell.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS, "timeoutSeconds", true);
	const maxTimeoutSeconds = positiveNumber(
		shell.maxTimeoutSeconds,
		DEFAULT_MAX_TIMEOUT_SECONDS,
		"maxTimeoutSeconds",
		true,
	);
	const allowedEnvKeys = [...(shell.allowedEnvKeys ?? [])];
	for (const key of allowedEnvKeys) {
		if (!ENVIRONMENT_KEY.test(key)) throw new Error(`Invalid allowed environment key: ${key}`);
	}
	const environment = { ...(shell.environment ?? {}) };
	const hostEnvironment = shell.hostEnvironment ?? process.env;
	const allowPatterns = (shell.allowPatterns ?? []).map(escapePattern);
	const denyPatterns = [...DEFAULT_SHELL_DENY_PATTERNS, ...(shell.denyPatterns ?? [])].map(
		(pattern) => new RegExp(pattern),
	);

	const policy: ExecutionPolicy = {
		roots,

		checkPath(path: string): FileError | undefined {
			const absolute = resolve(path);
			if (roots.some((root) => isPathWithin(root, absolute))) return undefined;
			return new FileError(
				"permission_denied",
				`Path is outside the execution workspace: ${path}`,
				path,
			);
		},

		async checkFilesystemPath(
			path: string,
			probe: FilesystemPathProbe,
			followFinalLink: boolean,
		): Promise<FileError | undefined> {
			const lexical = policy.checkPath(path);
			if (lexical !== undefined) return lexical;
			const checkRoot = followFinalLink ? resolve(path) : dirname(resolve(path));
			const actual = await existingPath(checkRoot, probe);
			if ("error" in actual) return actual.error;
			if (roots.some((root) => isPathWithin(root, actual.path))) return undefined;
			return new FileError(
				"permission_denied",
				`Path resolves through a symbolic link outside the execution workspace: ${path}`,
				path,
			);
		},

		checkCommand(command: string | readonly string[]): string | undefined {
			const text = commandText(command);
			const lower = text.trim().toLowerCase();
			const segments = splitShellSegments(lower);
			const explicitlyAllowed =
				allowPatterns.length > 0 &&
				segments.length > 0 &&
				segments.every((segment) => allowPatterns.some((pattern) => pattern.test(segment)));
			if (!explicitlyAllowed) {
				for (const pattern of denyPatterns) {
					if (pattern.test(lower)) return "Command blocked by deny pattern filter";
				}
				if (allowPatterns.length > 0) return "Command blocked by allowlist filter (not in allowlist)";
			}
			return undefined;
		},

		shellEnvironment(): Record<string, string> {
			const result = { ...environment };
			for (const key of allowedEnvKeys) {
				const value = hostEnvironment[key];
				if (value !== undefined) result[key] = value;
			}
			return result;
		},

		resolveShellTimeout(requested: number | undefined): Result<number | undefined, ExecutionError> {
			if (requested !== undefined) {
				if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
					return err(
						new ExecutionError(
							"timeout",
							"Invalid shell timeout: expected a finite number of seconds greater than zero",
						),
					);
				}
				return ok(maxTimeoutSeconds > 0 ? Math.min(requested, maxTimeoutSeconds) : requested);
			}
			if (timeoutSeconds === 0) return ok(undefined);
			return ok(maxTimeoutSeconds > 0 ? Math.min(timeoutSeconds, maxTimeoutSeconds) : timeoutSeconds);
		},
	};
	return policy;
}

/**
 * Resolve the nearest existing ancestor without returning it as the operation target. A missing leaf is reconstructed
 * lexically on top of the canonical ancestor; a link that cannot be resolved is refused rather than guessed.
 */
async function existingPath(
	start: string,
	probe: FilesystemPathProbe,
): Promise<{ path: string } | { error: FileError }> {
	let current = start;
	const missing: string[] = [];
	while (true) {
		const canonical = await probe.canonicalPath(current);
		if (canonical.ok) {
			const path = missing.length === 0 ? canonical.value : resolve(canonical.value, ...missing.slice().reverse());
			return { path };
		}
		if (canonical.error.code !== "not_found") return { error: canonical.error };
		const info = await probe.fileInfo(current);
		if (info.ok) {
			// The path exists but cannot be canonicalized (for example a dangling symbolic link). Refuse.
			return {
				error: new FileError(
					"permission_denied",
					`Path contains a symbolic link that cannot be resolved: ${start}`,
					start,
				),
			};
		}
		if (info.error.code !== "not_found") return { error: info.error };
		const parent = dirname(current);
		if (parent === current) return { error: canonical.error };
		missing.push(basename(current));
		current = parent;
	}
}
