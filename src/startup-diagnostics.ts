/**
 * Fixed startup diagnostics for the local CLI.
 *
 * `STARTUP_DIAGNOSTICS` supplies the CLI's fixed human-facing summaries. A separate bounded
 * failure record includes safe classes/codes, causes and code-relative locations. These summaries
 * never interpolate configuration/environment values, paths or raw provider/dependency errors.
 */
export const STARTUP_DIAGNOSTICS = Object.freeze({
  configHome:
    "cannot resolve the default configuration home; set HOME or pass --config <path> (diagnostic details suppressed)",
  defaultConfigFile:
    "no default configuration found; run `pedellus init`, create ~/.pedellus/config.json, or pass --config <path> " +
    "(diagnostic details suppressed)",
  configFile:
    "cannot read or parse the configuration file; check that it exists, is readable, and contains valid JSON " +
    "(diagnostic details suppressed)",
  configInvalid:
    "invalid configuration; check required fields and documented value formats (diagnostic details suppressed)",
  provider:
    "invalid provider configuration; check allowedModels, providers and the native provider IDs in PROVIDERS.md " +
    "(diagnostic details suppressed)",
  credential:
    "provider credential is missing or misconfigured; run pedellus login, set the environment variable " +
    "named by credentials.<provider>, or set the provider's native API-key environment (diagnostic details suppressed)",
  model:
    "configured model or thinking level is unavailable; compare model/allowedModels with `pedellus models list` " +
    "(diagnostic details suppressed)",
  authProvider:
    "unknown provider or no interactive login method; run `pedellus login` without a provider to list " +
    "native providers and their methods (diagnostic details suppressed)",
  authMethod:
    "the selected provider does not offer that authentication method; omit --auth to choose from the methods it " +
    "actually offers (diagnostic details suppressed)",
  authNoCredential:
    "no stored credential for that provider; run `pedellus login <provider>` first (diagnostic details suppressed)",
  authCanceled: "login or logout was cancelled; nothing further was attempted (diagnostic details suppressed)",
  authFailed:
    "login or logout failed; check the provider selection, network access for an OAuth flow, and the private " +
    "credential store under dataDir (diagnostic details suppressed)",
  initCanceled:
    "setup was cancelled; whatever was already written is kept and an existing configuration is never replaced " +
    "(diagnostic details suppressed)",
  initFailed:
    "setup failed; check that the configuration directory is writable and on a Linux filesystem, then run " +
    "`pedellus init` again with a path that has no configuration yet (diagnostic details suppressed)",
  telegramToken:
    "missing Telegram bot token; set the environment variable named by telegram.tokenEnv (diagnostic details suppressed)",
  discordToken:
    "missing Discord bot token; set the environment variable named by discord.tokenEnv (diagnostic details suppressed)",
  webCredential:
    "missing web search credential; set the environment variable named by web.search.keyEnv (diagnostic details suppressed)",
  workspace:
    "cannot prepare the configured workspace or data directory; check workspace, dataDir and extraAllowedDirs " +
    "(diagnostic details suppressed)",
  storeLocked:
    "another process already owns the configured data store; stop the other running pedellus gateway process " +
    "before starting another (diagnostic details suppressed)",
  preparedContext:
    "startup could not complete automatic interrupted-turn recovery; run " +
    "`pedellus recovery --config <path>` with this configuration to inspect and cancel a blocked prepared " +
    "dispatch, or omit `--config` for the default primary configuration, then start again " +
    "(diagnostic details suppressed)",
  cronRecovery:
    "startup could not finish recovering legacy scheduled timers, so nothing was served; check the journal " +
    "and start the gateway again (diagnostic details suppressed)",
  gatewayCanceled: "gateway start was cancelled before anything was served (diagnostic details suppressed)",
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
  return `pedellus: ${STARTUP_DIAGNOSTICS[code]}`;
}
