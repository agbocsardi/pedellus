import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Local speech recognition with an explicit backend choice.
 *
 * `faster-whisper` (the default, and the only behavior an existing config gets)
 * runs the PEP 723 helper through `uv run --script --offline`. `whisper-cli`
 * is an opt-in, Python-free route: operator-provisioned `whisper-cli`, a `ggml`
 * model and a Silero VAD model, plus `ffmpeg`/`ffprobe` for container decoding.
 *
 * Neither backend talks to a cloud provider, installs anything or downloads
 * anything: the model and engine must already be on disk. A whisper-cli call is
 * one bounded operation — probe, decode and inference share a single deadline —
 * writes exactly one private temporary WAV and always removes it.
 */

export const TRANSCRIPTION_LIMITS = {
  /** Wall-clock budget for one local transcription, including model load. */
  timeoutMs: 180_000,
  /** Recognized text is bounded like any other untrusted input. */
  maxOutputBytes: 64 * 1024,
  /** Audio longer than this is refused instead of transcribed. */
  maxDurationSeconds: 120,
  /** Bounded wait for a killed child to be reaped before the operation settles anyway. */
  killGraceMs: 2_000,
  /** Refused input size, kept here so every caller is bounded, not only Telegram. */
  maxInputBytes: 20 * 1024 * 1024,
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

/**
 * Explicit engine selection. Absent means the legacy uv/faster-whisper helper, so
 * an existing config keeps exactly the behavior it had.
 */
export type TranscriptionBackend = "faster-whisper" | "whisper-cli";

/**
 * Operator-provisioned whisper.cpp route. Every path is absolute and explicit:
 * nothing is discovered, downloaded or built at runtime, and the engine directory
 * must resolve its own shared libraries (the upstream prebuilt tarball uses an
 * `$ORIGIN` rpath; `LD_LIBRARY_PATH` is deliberately not inherited).
 */
export interface WhisperCliEngine {
  /** `whisper-cli` executable. */
  readonly binary: string;
  /** `ggml` Whisper model file (for example `ggml-small-q5_1.bin`). */
  readonly model: string;
  /** Silero VAD `ggml` model; required, because VAD is mandatory on this route. */
  readonly vadModel: string;
  /** `ffmpeg` executable used only to decode the local input into 16 kHz mono WAV. */
  readonly ffmpeg: string;
  /** `ffprobe` executable used for the early duration refusal. */
  readonly ffprobe: string;
}

export interface TranscriberOptions {
  /** Null disables local transcription; the stored audio is still available. */
  readonly enabled?: boolean;
  /** Explicit engine; absent keeps `faster-whisper`. */
  readonly backend?: TranscriptionBackend;
  /** Required when `backend` is `whisper-cli`; rejected otherwise. */
  readonly whisperCli?: WhisperCliEngine;
  /** uv executable; must be resolved from PATH, never a shell string. */
  readonly uvPath?: string;
  /** Absolute path of the shipped helper; defaults to this checkout's `scripts/`. */
  readonly helperPath?: string;
  /**
   * `uv run --script --offline` never installs the helper environment or downloads
   * a model unasked. Provision the helper once, as SETUP.md describes, before use.
   */
  readonly offline?: boolean;
  /** One deadline for the whole operation, shared by every child on the CLI route. */
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxDurationSeconds?: number;
  /** BCP-47-ish language hint; absent means auto-detect on both backends. */
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

/** whisper-cli exit codes, as implemented upstream (cli.cpp). Code 4 is grammar. */
const CLI_EXIT_INIT_OR_MODEL = 3;
const CLI_EXIT_PROCESSING = 10;
const CLI_EXIT_INPUT = 11;
/**
 * Only what a local decoder or engine needs. Unrelated runtime credentials from
 * this process are not inherited. The legacy route additionally keeps the uv and
 * Hugging Face cache locations so a provisioned Python environment still resolves;
 * the whisper-cli route has no cache or hub configuration at all.
 */
const SHARED_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TEMP", "TMP"] as const;

const LEGACY_ENV_KEYS = [
  ...SHARED_ENV_KEYS,
  "HOME",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "UV_CACHE_DIR",
  "UV_PYTHON",
  "HF_HOME",
  "HF_HUB_CACHE",
  "HUGGINGFACE_HUB_CACHE",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
] as const;

function childEnvironment(keys: readonly string[], extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...extra };
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function legacyEnvironment(): NodeJS.ProcessEnv {
  return childEnvironment(LEGACY_ENV_KEYS, {
    HF_HUB_OFFLINE: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
  });
}

function engineEnvironment(): NodeJS.ProcessEnv {
  return childEnvironment(SHARED_ENV_KEYS);
}

type ChildResult =
  | { readonly kind: "exit"; readonly code: number | null; readonly stdout: Buffer }
  | { readonly kind: "timeout" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "overflow" }
  /** The executable could not be started at all (missing binary, permission). */
  | { readonly kind: "missing" };

interface RunChildOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  /** Absolute time; every child of one transcription shares it. */
  readonly deadline: number;
  readonly maxStdoutBytes: number;
  readonly signal?: AbortSignal;
}

/**
 * One bounded child, with the shared kill-group and settle-after-reap semantics.
 * The caller decides what an exit code means; this never retries.
 */
function runChild(options: RunChildOptions): Promise<ChildResult> {
  const remaining = options.deadline - Date.now();
  if (remaining <= 0) return Promise.resolve({ kind: "timeout" });

  return new Promise<ChildResult>((resolveResult) => {
    const child = spawn(options.command, [...options.args], {
      // No shell, no interpolation: each element is one argument.
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env,
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    /** The result is decided; the promise may still be waiting for the child to be reaped. */
    let decided = false;
    let resolved = false;
    let childClosed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        // uv/ffmpeg/whisper-cli may spawn workers: kill the whole group.
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    };

    const resolveOnce = (result: ChildResult) => {
      if (resolved) return;
      resolved = true;
      resolveResult(result);
    };

    /**
     * Settle only after the child is reaped, or after a bounded grace when the platform
     * never reports close. The caller never has to clean up a process it cannot see.
     */
    const settle = (result: ChildResult) => {
      if (decided) return;
      decided = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (childClosed || child.pid === undefined) {
        resolveOnce(result);
        return;
      }
      const grace = setTimeout(() => resolveOnce(result), TRANSCRIPTION_LIMITS.killGraceMs);
      child.once("close", () => {
        clearTimeout(grace);
        resolveOnce(result);
      });
    };

    const onAbort = () => {
      killGroup();
      settle({ kind: "cancelled" });
    };

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const timerId = setTimeout(() => {
      killGroup();
      settle({ kind: "timeout" });
    }, remaining);
    timer = timerId;
    timerId.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (decided) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > options.maxStdoutBytes) {
        killGroup();
        settle({ kind: "overflow" });
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on("data", () => {
      // Drain (a full pipe would stall the child) but never keep or surface it.
    });
    child.on("error", () => {
      settle({ kind: "missing" });
    });
    child.on("close", (code: number | null) => {
      childClosed = true;
      // A settle() already in flight resolves through its own close listener.
      if (decided) return;
      settle({ kind: "exit", code, stdout: Buffer.concat(stdout) });
    });
  });
}

function clampOutputBytes(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) >= 1
    ? Math.trunc(value as number)
    : TRANSCRIPTION_LIMITS.maxOutputBytes;
}

function positiveNumber(value: number | undefined, fallback: number, label: string): number {
  const chosen = value ?? fallback;
  if (!Number.isFinite(chosen) || chosen <= 0) throw new Error(`${label} is invalid`);
  return chosen;
}

/** Legacy route: one uv-managed faster-whisper helper subprocess. */
function createFasterWhisperTranscriber(options: TranscriberOptions): Transcriber {
  const enabled = options.enabled !== false;
  const uvPath = options.uvPath ?? "uv";
  const helperPath = options.helperPath ?? defaultHelperPath();
  const offline = options.offline !== false;
  const timeoutMs = options.timeoutMs ?? TRANSCRIPTION_LIMITS.timeoutMs;
  const maxOutputBytes = clampOutputBytes(options.maxOutputBytes);
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

      const result = await runChild({
        command: uvPath,
        args,
        env: legacyEnvironment(),
        deadline: Date.now() + timeoutMs,
        maxStdoutBytes: maxOutputBytes,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      switch (result.kind) {
        case "missing":
          return { ok: false, reason: "unavailable" } as const;
        case "timeout":
          return { ok: false, reason: "timeout" } as const;
        case "cancelled":
          return { ok: false, reason: "cancelled" } as const;
        case "overflow":
          return { ok: false, reason: "failed" } as const;
        case "exit": {
          if (result.code === EXIT_UNAVAILABLE) return { ok: false, reason: "unavailable" } as const;
          if (result.code === EXIT_TOO_LARGE) return { ok: false, reason: "too-large" } as const;
          if (result.code !== 0) return { ok: false, reason: "failed" } as const;
          const text = result.stdout.toString("utf8").trim();
          if (text === "") return { ok: false, reason: "empty" } as const;
          return { ok: true, text: text.slice(0, maxOutputBytes) } as const;
        }
      }
    },
  };
}

export /**
 * Hard bound on the decoded PCM the decoder may write: 16 kHz mono 16-bit plus a
 * small WAV-header allowance. This is the fence that duration metadata alone
 * cannot be trusted to provide.
 */
function decodedPcmLimitBytes(maxDurationSeconds: number): number {
  return 44 + Math.floor(maxDurationSeconds * 16_000 * 2) + 1024;
}

/** Probe output is one number; anything larger is not a transcript. */
const PROBE_STDOUT_BYTES = 8 * 1024;

const failureForChild = (result: ChildResult, missing: TranscriptionFailure = "unavailable"):
  | { ok: false; reason: TranscriptionFailure }
  | undefined => {
  switch (result.kind) {
    case "missing":
      return { ok: false, reason: missing };
    case "timeout":
      return { ok: false, reason: "timeout" };
    case "cancelled":
      return { ok: false, reason: "cancelled" };
    case "overflow":
      return { ok: false, reason: "failed" };
    case "exit":
      return undefined;
  }
};

/**
 * Opt-in route: probe (`ffprobe`), decode (`ffmpeg`) and infer (`whisper-cli`)
 * under one deadline, one private temporary WAV, and a mandatory VAD model.
 */
function createWhisperCliTranscriber(options: TranscriberOptions): Transcriber {
  const enabled = options.enabled !== false;
  const engine = options.whisperCli;
  if (engine === undefined) throw new Error("media.transcription.whisperCli is required for the whisper-cli backend");
  const timeoutMs = options.timeoutMs ?? TRANSCRIPTION_LIMITS.timeoutMs;
  const maxOutputBytes = clampOutputBytes(options.maxOutputBytes);
  const maxDurationSeconds = options.maxDurationSeconds ?? TRANSCRIPTION_LIMITS.maxDurationSeconds;
  const language = options.language;
  const pcmLimit = decodedPcmLimitBytes(maxDurationSeconds);

  return {
    enabled,
    maxDurationSeconds,
    async transcribe(audioPath: string, request: { readonly signal?: AbortSignal } = {}) {
      if (!enabled) return { ok: false, reason: "unavailable" } as const;
      // A caller-supplied bound is a refusal, never a truncation.
      positiveNumber(timeoutMs, TRANSCRIPTION_LIMITS.timeoutMs, "transcription timeout");
      positiveNumber(maxDurationSeconds, TRANSCRIPTION_LIMITS.maxDurationSeconds, "transcription duration limit");

      let inputBytes: number;
      try {
        inputBytes = (await stat(audioPath)).size;
      } catch {
        return { ok: false, reason: "failed" } as const;
      }
      if (inputBytes === 0) return { ok: false, reason: "failed" } as const;
      if (inputBytes > TRANSCRIPTION_LIMITS.maxInputBytes) return { ok: false, reason: "too-large" } as const;

      const deadline = Date.now() + timeoutMs;
      let workdir: string;
      try {
        workdir = await mkdtemp(join(tmpdir(), "nanobot-transcribe-"));
      } catch {
        return { ok: false, reason: "failed" } as const;
      }

      try {
        const probe = await runChild({
          command: engine.ffprobe,
          args: [
            "-v", "error",
            "-protocol_whitelist", "file",
            "-show_entries", "format=duration",
            "-of", "default=nw=1:nk=1",
            audioPath,
          ],
          env: engineEnvironment(),
          deadline,
          maxStdoutBytes: PROBE_STDOUT_BYTES,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        const probeFailure = failureForChild(probe);
        if (probeFailure !== undefined) return probeFailure;
        if (probe.kind === "exit" && probe.code !== 0) return { ok: false, reason: "failed" } as const;

        // Early, precise refusal when the container reports a duration; the decoder
        // size fence below is the binding limit when metadata is absent or wrong.
        if (probe.kind === "exit") {
          const reported = Number.parseFloat(probe.stdout.toString("utf8").trim());
          if (Number.isFinite(reported) && reported > maxDurationSeconds) {
            return { ok: false, reason: "too-large" } as const;
          }
        }

        const decodedPath = join(workdir, "audio.wav");
        const decode = await runChild({
          command: engine.ffmpeg,
          args: [
            "-nostdin",
            "-hide_banner",
            "-loglevel", "error",
            // Local file only: no concat, http, tcp or other demuxer protocols.
            "-protocol_whitelist", "file",
            "-i", audioPath,
            "-vn",
            "-map", "0:a:0",
            "-ac", "1",
            "-ar", "16000",
            "-c:a", "pcm_s16le",
            "-f", "wav",
            // Stop writing past the bound instead of filling the disk. Reaching it
            // is reported as too-large below, never accepted as a short transcript.
            "-fs", String(pcmLimit),
            "-y",
            decodedPath,
          ],
          env: engineEnvironment(),
          deadline,
          maxStdoutBytes: PROBE_STDOUT_BYTES,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        const decodeFailure = failureForChild(decode);
        if (decodeFailure !== undefined) return decodeFailure;
        if (decode.kind === "exit" && decode.code !== 0) return { ok: false, reason: "failed" } as const;

        let decodedBytes: number;
        try {
          decodedBytes = (await stat(decodedPath)).size;
        } catch {
          return { ok: false, reason: "failed" } as const;
        }
        if (decodedBytes === 0) return { ok: false, reason: "failed" } as const;
        if (decodedBytes >= pcmLimit) return { ok: false, reason: "too-large" } as const;

        const engineResult = await runChild({
          command: engine.binary,
          args: [
            "-m", engine.model,
            "-f", decodedPath,
            // VAD is mandatory on this route; it is also what stops silence from
            // producing phantom text.
            "--vad", "-vm", engine.vadModel,
            "-np",
            "-nt",
            // The CLI default is English, so auto-detection must be explicit.
            "-l", language ?? "auto",
          ],
          env: engineEnvironment(),
          deadline,
          maxStdoutBytes: maxOutputBytes,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        const engineFailure = failureForChild(engineResult);
        if (engineFailure !== undefined) return engineFailure;
        if (engineResult.kind !== "exit") return { ok: false, reason: "failed" } as const;
        if (engineResult.code === CLI_EXIT_INIT_OR_MODEL) return { ok: false, reason: "unavailable" } as const;
        if (engineResult.code === CLI_EXIT_PROCESSING || engineResult.code === CLI_EXIT_INPUT) {
          return { ok: false, reason: "failed" } as const;
        }
        if (engineResult.code !== 0) return { ok: false, reason: "failed" } as const;
        const text = engineResult.stdout.toString("utf8").trim();
        if (text === "") return { ok: false, reason: "empty" } as const;
        return { ok: true, text: text.slice(0, maxOutputBytes) } as const;
      } finally {
        // Every path, including abort, timeout and partial failure, removes the WAV.
        await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

function validateEngine(engine: WhisperCliEngine): void {
  for (const key of ["binary", "model", "vadModel", "ffmpeg", "ffprobe"] as const) {
    const value = engine[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`media.transcription.whisperCli.${key} is required`);
    }
    if (!isAbsolute(value)) {
      throw new Error(`media.transcription.whisperCli.${key} must be an absolute path`);
    }
  }
}

export function createTranscriber(options: TranscriberOptions = {}): Transcriber {
  const backend: TranscriptionBackend = options.backend ?? "faster-whisper";
  if (backend === "faster-whisper") {
    if (options.whisperCli !== undefined) {
      throw new Error("media.transcription.whisperCli requires backend \"whisper-cli\"");
    }
    return createFasterWhisperTranscriber(options);
  }
  if (backend !== "whisper-cli") {
    throw new Error(`unknown media.transcription.backend: ${String(backend)}`);
  }
  if (options.whisperCli === undefined) {
    throw new Error("media.transcription.backend \"whisper-cli\" requires media.transcription.whisperCli");
  }
  validateEngine(options.whisperCli);
  return createWhisperCliTranscriber(options);
}
