/**
 * Fixed startup diagnostics for the local CLI.
 *
 * The `STARTUP_DIAGNOSTICS` text is the only text the CLI prints for a failed
 * start. It never interpolates configuration values, environment values,
 * filesystem paths, provider/dependency error text or the underlying exception.
 */
export const STARTUP_DIAGNOSTICS = Object.freeze({
  usage: "Usage: nanobot --config <path>",
  configFile:
    "cannot read or parse the configuration file; check that it exists, is readable, and contains valid JSON " +
    "(diagnostic details suppressed)",
  configInvalid:
    "invalid configuration; check required fields and documented value formats (diagnostic details suppressed)",
  provider:
    "invalid provider configuration; check allowedModels and the supported provider aliases in PROVIDERS.md " +
    "(diagnostic details suppressed)",
  credential:
    "provider credential is missing or misconfigured; set the environment variable named by credentials.<alias> " +
    "(diagnostic details suppressed)",
  model:
    "configured model or thinking level is unavailable; compare model/allowedModels with the pinned provider catalog " +
    "(diagnostic details suppressed)",
  telegramToken:
    "missing Telegram bot token; set the environment variable named by telegram.tokenEnv (diagnostic details suppressed)",
  workspace:
    "cannot prepare the configured workspace or data directory; check workspace, dataDir and extraAllowedDirs " +
    "(diagnostic details suppressed)",
  storeLocked:
    "another process already owns the configured data store; stop the other running nanobot/gateway process " +
    "before starting another (diagnostic details suppressed)",
  preparedContext:
    "startup refused because a prepared model dispatch pins historical Nanobot context; run " +
    "`nanobot recovery --config <path>` with this configuration to inspect and cancel the blocked task, " +
    "then start again (diagnostic details suppressed)",
  unexpected: "command failed; diagnostic details suppressed",
} as const);

export type StartupDiagnosticCode = keyof typeof STARTUP_DIAGNOSTICS;

function knownStartupDiagnosticCode(code: unknown): StartupDiagnosticCode {
  return typeof code === "string" && Object.hasOwn(STARTUP_DIAGNOSTICS, code)
    ? code as StartupDiagnosticCode
    : "unexpected";
}

export interface StartupDiagnosticOptions {
  /** Underlying error retained for SDK callers; never printed by the CLI. */
  readonly cause?: unknown;
  /**
   * Optional detailed message for SDK callers. The CLI uses `code` and the
   * fixed `STARTUP_DIAGNOSTICS` text instead, so this must not be printed.
   */
  readonly detail?: string;
}

/** A known, expected startup or configuration failure with a fixed safe message. */
export class StartupDiagnosticError extends Error {
  override name = "StartupDiagnosticError";
  readonly code: StartupDiagnosticCode;

  constructor(code: StartupDiagnosticCode, options: StartupDiagnosticOptions = {}) {
    const safeCode = knownStartupDiagnosticCode(code);
    super(
      safeCode === "unexpected" ? STARTUP_DIAGNOSTICS[safeCode] : options.detail ?? STARTUP_DIAGNOSTICS[safeCode],
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.code = safeCode;
  }
}

/** Format a startup failure for the CLI using only fixed diagnostic text. */
export function startupDiagnostic(error: unknown): string {
  const code = error instanceof StartupDiagnosticError
    ? knownStartupDiagnosticCode(error.code)
    : "unexpected";
  // Usage text already names the executable; avoid a `nanobot: Usage: nanobot` prefix.
  return code === "usage" ? STARTUP_DIAGNOSTICS.usage : `nanobot: ${STARTUP_DIAGNOSTICS[code]}`;
}
