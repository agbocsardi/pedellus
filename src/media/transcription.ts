import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Local speech recognition through one uv-managed faster-whisper helper.
 *
 * The helper is a PEP 723 script run by `uv run --script`; it fixes the model
 * (`small`), device (`cpu`) and compute type (`int8`). This module never talks to
 * a cloud provider, never installs anything, and never claims a transcript it did
 * not receive. Cancellation, time and output are bounded, and the whole child
 * process group is killed on abort or timeout.
 */

export const TRANSCRIPTION_LIMITS = {
  /** Wall-clock budget for one local transcription, including model load. */
  timeoutMs: 180_000,
  /** Recognized text is bounded like any other untrusted input. */
  maxOutputBytes: 64 * 1024,
  /** Audio longer than this is refused instead of transcribed. */
  maxDurationSeconds: 120,
} as const;

export type TranscriptionFailure =
  | "unavailable"
  | "timeout"
  | "cancelled"
  | "too-large"
  | "failed"
  | "empty";

export type TranscriptionOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: TranscriptionFailure };

export interface TranscriberOptions {
  /** Null disables local transcription; the stored audio is still available. */
  readonly enabled?: boolean;
  /** uv executable; must be resolved from PATH, never a shell string. */
  readonly uvPath?: string;
  /** Absolute path of the shipped helper; defaults to this checkout's `scripts/`. */
  readonly helperPath?: string;
  /**
   * `uv run --script --offline` never installs the helper environment or downloads
   * a model unasked. Provision the helper once, as SETUP.md describes, before use.
   */
  readonly offline?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxDurationSeconds?: number;
  /** BCP-47-ish language hint passed to the helper; absent means auto-detect. */
  readonly language?: string;
}

export interface Transcriber {
  readonly enabled: boolean;
  readonly maxDurationSeconds: number;
  transcribe(audioPath: string, options?: { readonly signal?: AbortSignal }): Promise<TranscriptionOutcome>;
}

/** The helper shipped beside `src/`, resolved for both `src/` and `dist/` builds. */
export function defaultHelperPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "local-transcribe.py");
}

/** Helper exit codes; document changes in `scripts/local-transcribe.py` too. */
const EXIT_UNAVAILABLE = 3;
const EXIT_TOO_LARGE = 4;

export function createTranscriber(options: TranscriberOptions = {}): Transcriber {
  const enabled = options.enabled !== false;
  const uvPath = options.uvPath ?? "uv";
  const helperPath = options.helperPath ?? defaultHelperPath();
  const offline = options.offline !== false;
  const timeoutMs = options.timeoutMs ?? TRANSCRIPTION_LIMITS.timeoutMs;
  const rawMaxOutputBytes = options.maxOutputBytes ?? TRANSCRIPTION_LIMITS.maxOutputBytes;
  const maxOutputBytes = Number.isFinite(rawMaxOutputBytes) && rawMaxOutputBytes >= 1
    ? Math.trunc(rawMaxOutputBytes)
    : TRANSCRIPTION_LIMITS.maxOutputBytes;
  const maxDurationSeconds = options.maxDurationSeconds ?? TRANSCRIPTION_LIMITS.maxDurationSeconds;
  const language = options.language;

  return {
    enabled,
    maxDurationSeconds,
    async transcribe(audioPath: string, request: { readonly signal?: AbortSignal } = {}) {
      if (!enabled) return { ok: false, reason: "unavailable" } as const;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("transcription timeout is invalid");
      if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) {
        throw new Error("transcription duration limit is invalid");
      }

      const args = [
        "run",
        "--quiet",
        "--script",
        ...(offline ? ["--offline"] : []),
        helperPath,
        audioPath,
        "--max-duration-seconds",
        String(Math.floor(maxDurationSeconds)),
        ...(language === undefined ? [] : ["--language", language]),
      ];

      return await new Promise<TranscriptionOutcome>((resolveOutcome) => {
        const child = spawn(uvPath, args, {
          // No shell, no interpolation: each element is one argument.
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            // A voice message must never install the helper environment or download a
            // model: a missing local model fails truthfully instead.
            HF_HUB_OFFLINE: "1",
            HF_HUB_DISABLE_TELEMETRY: "1",
          },
        });
        const stdout: Buffer[] = [];
        let stdoutBytes = 0;
        let settled = false;
        let timedOut = false;
        let killedByAbort = false;

        const killGroup = () => {
          if (child.pid === undefined) return;
          try {
            if (process.platform === "win32") child.kill("SIGKILL");
            // uv spawns the interpreter: kill the whole group so no worker survives.
            else process.kill(-child.pid, "SIGKILL");
          } catch {
            try {
              child.kill("SIGKILL");
            } catch {
              // Already gone.
            }
          }
        };

        let timer: ReturnType<typeof setTimeout> | undefined;

        const fail = (reason: TranscriptionFailure) => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          request.signal?.removeEventListener("abort", onAbort);
          resolveOutcome({ ok: false, reason });
        };

        const onAbort = () => {
          killedByAbort = true;
          killGroup();
          fail("cancelled");
        };

        if (request.signal?.aborted) {
          onAbort();
          return;
        }
        request.signal?.addEventListener("abort", onAbort, { once: true });

        timer = setTimeout(() => {
          timedOut = true;
          killGroup();
          fail("timeout");
        }, timeoutMs);
        timer.unref?.();

        child.stdout?.on("data", (chunk: Buffer) => {
          if (settled) return;
          stdoutBytes += chunk.byteLength;
          if (stdoutBytes > maxOutputBytes) {
            killGroup();
            fail("failed");
            return;
          }
          stdout.push(chunk);
        });
        child.stderr?.on("data", () => {
          // Drain (a full pipe would stall the child) but never keep or surface it.
        });
        child.on("error", () => {
          fail("unavailable");
        });
        child.on("close", (code: number | null) => {
          if (settled) return;
          if (timedOut) return fail("timeout");
          if (killedByAbort) return fail("cancelled");
          if (code === EXIT_UNAVAILABLE) return fail("unavailable");
          if (code === EXIT_TOO_LARGE) return fail("too-large");
          if (code !== 0) return fail("failed");
          const text = Buffer.concat(stdout).toString("utf8").trim();
          if (text === "") return fail("empty");
          settled = true;
          clearTimeout(timer);
          request.signal?.removeEventListener("abort", onAbort);
          resolveOutcome({ ok: true, text: text.slice(0, maxOutputBytes) });
        });
      });
    },
  };
}
