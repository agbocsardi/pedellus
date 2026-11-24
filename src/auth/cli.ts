import { createInterface } from "node:readline";
import type { Interface as ReadlineInterface } from "node:readline";
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  AuthType,
  CredentialInfo,
  Models,
  Provider,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import type { PortConfig } from "../config.js";
import { createAuthModels, nativeProviderId } from "../providers.js";
import { StartupDiagnosticError } from "../startup-diagnostics.js";
import { prepareDataDirectory } from "../store.js";
import { authStorePath, FileCredentialStore, installationDeviceId } from "./store.js";

export interface AuthTerminalOptions {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly signal?: AbortSignal;
}

export interface LoginSelection {
  /** Configured spelling or native provider ID; absent lists every interactive method. */
  readonly provider?: string;
  /** Explicit method; absent prompts when the provider supports more than one. */
  readonly auth?: AuthType;
}

interface LoginChoice {
  readonly provider: Provider;
  readonly type: AuthType;
  readonly label: string;
  readonly subscription: boolean;
}

function terminalInteraction(options: AuthTerminalOptions): {
  interaction: AuthInteraction;
  close: () => void;
} {
  const readline: ReadlineInterface = createInterface({
    input: options.input,
    output: options.output,
    terminal: Boolean((options.input as NodeJS.ReadStream).isTTY && (options.output as NodeJS.WriteStream).isTTY),
  });
  const signal = options.signal;

  const question = (query: string, secret: boolean, promptSignal?: AbortSignal): Promise<string> => new Promise((resolve, reject) => {
    const active = promptSignal === undefined
      ? signal
      : signal === undefined
        ? promptSignal
        : AbortSignal.any([signal, promptSignal]);
    if (active?.aborted) {
      reject(active.reason);
      return;
    }
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      restoreEcho();
      reject(active?.reason);
    };
    const cleanup = () => active?.removeEventListener("abort", onAbort);
    active?.addEventListener("abort", onAbort, { once: true });
    const hidden = readline as ReadlineInterface & { _writeToOutput?: (text: string) => void };
    const originalWrite = hidden._writeToOutput;
    const restoreEcho = () => {
      if (originalWrite === undefined) delete hidden._writeToOutput;
      else hidden._writeToOutput = originalWrite;
    };
    if (secret && readline.terminal) {
      hidden._writeToOutput = (text: string) => {
        if (text === query) originalWrite?.call(readline, text);
      };
    }
    try {
      readline.question(query, (answer) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (secret && readline.terminal) options.output.write("\n");
        restoreEcho();
        resolve(answer);
      });
    } catch (error) {
      settled = true;
      cleanup();
      restoreEcho();
      reject(error);
    }
  });

  const prompt = async (request: AuthPrompt): Promise<string> => {
    if (request.type === "select") {
      options.output.write(`${request.message}\n`);
      request.options.forEach((option, index) => {
        options.output.write(
          `  ${index + 1}) ${option.label}${option.description === undefined ? "" : ` - ${option.description}`}\n`,
        );
      });
      for (;;) {
        const answer = (await question("Selection: ", false, request.signal)).trim();
        const byIndex = Number(answer);
        if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= request.options.length) {
          return request.options[byIndex - 1]!.id;
        }
        const exact = request.options.find((option) => option.id === answer);
        if (exact !== undefined) return exact.id;
        options.output.write(`Choose one of 1-${request.options.length}.\n`);
      }
    }
    const suffix = request.placeholder === undefined ? "" : ` [${request.placeholder}]`;
    return question(`${request.message}${suffix}: `, request.type === "secret", request.signal);
  };

  const notify = (event: AuthEvent): void => {
    switch (event.type) {
      case "info":
        options.output.write(`${event.message}\n`);
        for (const link of event.links ?? []) {
          options.output.write(`${link.label ?? "More information"}: ${link.url}\n`);
        }
        return;
      case "auth_url":
        options.output.write(`Open this URL to continue: ${event.url}\n`);
        if (event.instructions !== undefined) options.output.write(`${event.instructions}\n`);
        return;
      case "device_code":
        options.output.write(`Enter code ${event.userCode} at ${event.verificationUri}\n`);
        return;
      case "progress":
        options.output.write(`${event.message}\n`);
        return;
    }
  };

  return {
    interaction: {
      ...(signal === undefined ? {} : { signal }),
      prompt,
      notify,
    },
    close: () => readline.close(),
  };
}

function interactiveChoices(models: Models): LoginChoice[] {
  const choices: LoginChoice[] = [];
  for (const provider of [...models.getProviders()].sort((left, right) => left.id.localeCompare(right.id))) {
    if (provider.auth.oauth?.login !== undefined) {
      const oauth = provider.auth.oauth;
      choices.push({
        provider,
        type: "oauth",
        label: oauth.loginLabel ?? oauth.name,
        subscription: oauth.isSubscription === true,
      });
    }
    const apiKey = provider.auth.apiKey;
    if (apiKey?.login !== undefined) {
      choices.push({
        provider,
        type: "api_key",
        label: apiKey.name,
        subscription: false,
      });
    }
  }
  return choices;
}

async function chooseLogin(choices: readonly LoginChoice[], interaction: AuthInteraction): Promise<LoginChoice> {
  if (choices.length === 0) throw new StartupDiagnosticError("authProvider");
  if (choices.length === 1) return choices[0]!;
  const answer = await interaction.prompt({
    type: "select",
    message: "Choose a provider and authentication method",
    options: choices.map((choice, index) => ({
      id: String(index),
      label: `${choice.provider.name} (${choice.provider.id})`,
      description: `${choice.label}${choice.subscription ? " - subscription" : ""}`,
    })),
  });
  const choice = choices[Number(answer)];
  if (choice === undefined) throw new StartupDiagnosticError("authMethod");
  return choice;
}

export async function runLogin(
  config: PortConfig,
  selection: LoginSelection,
  terminal: AuthTerminalOptions,
): Promise<void> {
  const prepared = await prepareDataDirectory(config);
  const store = new FileCredentialStore(authStorePath(prepared.canonicalDataDir));
  const models = createAuthModels(config, process.env, store);
  const { interaction, close } = terminalInteraction(terminal);
  try {
    let choices = interactiveChoices(models);
    if (selection.provider !== undefined) {
      const nativeId = nativeProviderId(selection.provider);
      choices = choices.filter((choice) => choice.provider.id === nativeId);
      if (choices.length === 0) {
        throw new StartupDiagnosticError("authProvider", {
          detail: `Provider ${nativeId} is unknown or has no interactive login`,
        });
      }
    }
    if (selection.auth !== undefined) {
      choices = choices.filter((choice) => choice.type === selection.auth);
      if (choices.length === 0) {
        throw new StartupDiagnosticError("authMethod", {
          detail: `No selected provider supports ${selection.auth} login`,
        });
      }
    }
    const choice = await chooseLogin(choices, interaction);
    const deviceId = choice.type === "oauth" ? await installationDeviceId(prepared.canonicalDataDir) : undefined;
    await models.login(choice.provider.id, choice.type, interaction, {
      agentName: "pedellus",
      ...(deviceId === undefined ? {} : { getDeviceId: () => deviceId }),
    });
    terminal.output.write(`Logged in to ${choice.provider.id} using ${choice.label}.\n`);
  } finally {
    close();
  }
}

export async function runLogout(
  config: PortConfig,
  provider: string | undefined,
  terminal: AuthTerminalOptions,
): Promise<void> {
  const prepared = await prepareDataDirectory(config);
  const store = new FileCredentialStore(authStorePath(prepared.canonicalDataDir));
  const stored: readonly CredentialInfo[] = await store.list(
    terminal.signal === undefined ? {} : { signal: terminal.signal },
  );
  if (stored.length === 0) {
    terminal.output.write("No stored credentials.\n");
    return;
  }
  const models = createModels({
    credentials: store,
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  let providerId: string;
  if (provider === undefined) {
    const { interaction, close } = terminalInteraction(terminal);
    try {
      const answer = await interaction.prompt({
        type: "select",
        message: "Choose a stored credential to remove",
        options: stored
          .slice()
          .sort((left, right) => left.providerId.localeCompare(right.providerId))
          .map((entry, index) => ({ id: String(index), label: entry.providerId, description: entry.type })),
      });
      const choice = stored
        .slice()
        .sort((left, right) => left.providerId.localeCompare(right.providerId))[Number(answer)];
      if (choice === undefined) throw new StartupDiagnosticError("authFailed");
      providerId = choice.providerId;
    } finally {
      close();
    }
  } else {
    providerId = nativeProviderId(provider);
    if (!stored.some((entry) => entry.providerId === providerId)) {
      throw new StartupDiagnosticError("authNoCredential", {
        detail: `No stored credential for provider ${providerId}`,
      });
    }
  }
  await models.logout(providerId, terminal.signal === undefined ? {} : { signal: terminal.signal });
  terminal.output.write(`Logged out of ${providerId}.\n`);
}
