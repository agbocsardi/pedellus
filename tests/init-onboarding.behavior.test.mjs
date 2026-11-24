import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const ai = await import(join(repoRoot, "node_modules/@earendil-works/pi-ai/dist/index.js"));
const { InitError, parseProfile, runInit } = await import(join(repoRoot, "dist/init/index.js"));
const { terminalInteraction } = await import(join(repoRoot, "dist/auth/cli.js"));
const { loadConfig } = await import(join(repoRoot, "dist/config.js"));
const { loadWorkspaceContextSnapshot } = await import(join(repoRoot, "dist/context/workspace.js"));
const { createModels, fauxAssistantMessage, fauxProvider } = ai;

const SECRET = "sk-SYNTHETIC-INIT-SECRET-0123456789";
const home = await mkdtemp(join(tmpdir(), "pedellus-init-"));
after(async () => { await rm(home, { recursive: true, force: true }); });

/**
 * Terminal double: every prompt the init flow prints ends with ": ", and each one is answered with
 * the next scripted line. Running out of answers aborts the run instead of hanging it.
 */
function terminal(answers) {
  const input = new PassThrough();
  const controller = new AbortController();
  let transcript = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString();
      transcript += text;
      if (text.endsWith(": ")) {
        const next = answers.shift();
        setImmediate(() => {
          if (next === undefined) controller.abort(new Error("script exhausted"));
          else input.write(`${next}\n`);
        });
      }
      callback();
    },
  });
  return { input, output, signal: controller.signal, transcript: () => transcript, remaining: () => answers.length };
}

/** A synthetic provider with an API-key login and two chat models; no network is involved. */
function syntheticModels(responses) {
  const faux = fauxProvider({
    provider: "synthetic",
    models: [
      { id: "synthetic-deep", name: "Synthetic Deep", reasoning: true },
      { id: "synthetic-mini", name: "Synthetic Mini", reasoning: false },
    ],
  });
  faux.setResponses(responses);
  const provider = {
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Synthetic API key",
        login: async (interaction) => ({
          type: "api_key",
          key: await interaction.prompt({ type: "secret", message: "API key" }),
        }),
        resolve: async ({ credential }) => (credential?.key ? { auth: { apiKey: credential.key } } : undefined),
      },
    },
  };
  return {
    faux,
    factory: (credentials) => {
      const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
      models.setProvider(provider);
      return models;
    },
  };
}

const PROFILE = {
  ownerName: "Ada",
  preferredLanguage: "English",
  mainUses: ["daily planning", "coding notes"],
  toneAndDetail: "Brief and crisp by default.",
  soulBullets: ["Warm and crisp.", "Honest about uncertainty."],
  standingPreferences: ["Prefers bullet points."],
};

/** Answers through the basics: login key, deep and fast defaults, time zone, name, file tools, no shell. */
const BASICS = [SECRET, "", "", "UTC", "", "", ""];

async function setupDirectory(name) {
  const directory = join(home, name);
  await mkdir(directory);
  return join(directory, "config.json");
}

async function run(configPath, answers, models, extra = {}) {
  const io = terminal(answers);
  const result = await runInit({
    configPath,
    input: io.input,
    output: io.output,
    signal: io.signal,
    repoRoot,
    platform: "linux",
    isWsl: false,
    models: models.factory,
    ...extra,
  });
  return { result, io };
}

async function assertConfigAndContext(configPath) {
  const text = await readFile(configPath, "utf8");
  assert.doesNotMatch(text, new RegExp(SECRET), "config.json never carries a secret");
  const raw = JSON.parse(text);
  assert.equal(raw.credentials, undefined, "no credentials references are written");
  assert.equal(raw.workspace, "./workspace");
  assert.equal(raw.dataDir, "./data");
  assert.equal(raw.modelPreset, "deep");
  assert.deepEqual(raw.modelPresets.deep, { provider: "synthetic", modelId: "synthetic-deep", thinkingLevel: "high" });
  assert.deepEqual(raw.modelPresets.fast, { provider: "synthetic", modelId: "synthetic-mini", thinkingLevel: "off" });
  assert.deepEqual(raw.toolAllowlist, ["read", "write", "edit"]);
  assert.deepEqual(raw.cron, { enabled: true, timeZone: "UTC" });
  assert.deepEqual(raw.digest, { preset: "fast" });

  const config = await loadConfig(configPath);
  assert.equal((await stat(config.dataDir)).mode & 0o777, 0o700);
  const credentials = join(config.dataDir, "credentials.json");
  assert.equal((await stat(credentials)).mode & 0o777, 0o600);
  assert.match(await readFile(credentials, "utf8"), new RegExp(SECRET), "the key went to the private store");
  for (const skill of ["memory", "cron", "skill-creator"]) {
    await stat(join(config.workspace, "skills", skill, "SKILL.md"));
  }
  const snapshot = await loadWorkspaceContextSnapshot({
    workspaceRoot: config.workspace,
    memoryFiles: config.workspaceContext.memoryFiles,
  });
  return { config, snapshot };
}

const sources = (snapshot) => JSON.stringify(snapshot);

test("--skip-interview scaffolds a loadable setup with first-chat onboarding", { timeout: 30_000 }, async () => {
  const configPath = await setupDirectory("skip");
  const models = syntheticModels([]);
  const { result, io } = await run(configPath, [...BASICS], models, { skipInterview: true });
  assert.equal(result.outcome, "onboarding");
  assert.equal(io.remaining(), 0);
  assert.equal(models.faux.state.callCount, 0, "no model call without the interview");
  assert.doesNotMatch(io.transcript(), new RegExp(SECRET));
  assert.match(io.transcript(), /pedellus doctor/);

  const { config, snapshot } = await assertConfigAndContext(configPath);
  for (const file of ["AGENTS.md", "SOUL.md", "USER.md", "memory/MEMORY.md"]) {
    assert.ok((await readFile(join(config.workspace, file), "utf8")).length > 0, file);
  }
  const onboarding = await readFile(join(config.workspace, "memory/system/onboarding.md"), "utf8");
  assert.match(onboarding, /USER\.md/);
  assert.match(onboarding, /memory\/preferences\/standing\.md/);
  assert.match(onboarding, /empty content/);
  assert.match(sources(snapshot), /memory\/system\/onboarding\.md/, "the onboarding note reaches the first chat");

  // Emptying the note, as the first chat is told to, drops it from later snapshots.
  await writeFile(join(config.workspace, "memory/system/onboarding.md"), "");
  const later = await loadWorkspaceContextSnapshot({ workspaceRoot: config.workspace, memoryFiles: ["memory/MEMORY.md"] });
  assert.doesNotMatch(sources(later), /onboarding\.md/);
});

test("the interview runs several turns and saves trusted rendered profile files", { timeout: 30_000 }, async () => {
  const configPath = await setupDirectory("interview");
  const seen = [];
  const models = syntheticModels([
    fauxAssistantMessage("Good evening. Whom do I have the pleasure of assisting?"),
    (context) => {
      seen.push(context);
      return fauxAssistantMessage("Splendid, Ada. Brief or thorough?");
    },
    (context) => {
      seen.push(context);
      return fauxAssistantMessage(`All noted.\n\`\`\`pedellus-profile\n${JSON.stringify(PROFILE)}\n\`\`\``);
    },
  ]);
  const { result, io } = await run(configPath, [...BASICS, "", "Ada", "Brief, please", ""], models);
  assert.equal(result.outcome, "personalized");
  assert.equal(io.remaining(), 0);
  assert.equal(models.faux.state.callCount, 3);
  assert.match(JSON.stringify(seen.at(-1)), /Brief, please/, "each turn carries the conversation so far");
  assert.match(io.transcript(), /Proposed files \(full preview\)/);
  assert.doesNotMatch(io.transcript(), /ownerName/, "raw JSON keys are not echoed");

  const { config, snapshot } = await assertConfigAndContext(configPath);
  assert.match(await readFile(join(config.workspace, "USER.md"), "utf8"), /- Name: Ada/);
  assert.match(await readFile(join(config.workspace, "SOUL.md"), "utf8"), /- Warm and crisp\./);
  assert.match(await readFile(join(config.workspace, "memory/preferences/standing.md"), "utf8"), /- Prefers bullet points\./);
  await stat(join(config.workspace, "AGENTS.md"));
  await assert.rejects(stat(join(config.workspace, "memory/system/onboarding.md")), /ENOENT/);
  assert.doesNotMatch(sources(snapshot), /onboarding/);
});

test("a failed, skipped or adversarial interview falls back to starter files and onboarding", { timeout: 30_000 }, async () => {
  const failing = await setupDirectory("failing");
  const broken = syntheticModels([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "SYNTHETIC-PROVIDER-PAYLOAD upstream 500" }),
  ]);
  const failed = await run(failing, [...BASICS, ""], broken);
  assert.equal(failed.result.outcome, "onboarding");
  assert.match(failed.io.transcript(), /could not continue/);
  assert.doesNotMatch(failed.io.transcript(), /SYNTHETIC-PROVIDER-PAYLOAD/, "no raw provider error is printed");
  const failedSetup = await assertConfigAndContext(failing);
  await stat(join(failedSetup.config.workspace, "memory/system/onboarding.md"));
  assert.match(await readFile(join(failedSetup.config.workspace, "USER.md"), "utf8"), /not yet known/);

  const skipping = await setupDirectory("skipping");
  const skipped = await run(skipping, [...BASICS, "", "/skip"], syntheticModels([fauxAssistantMessage("Hello! Your name?")]));
  assert.equal(skipped.result.outcome, "onboarding");
  const skippedSetup = await assertConfigAndContext(skipping);
  await stat(join(skippedSetup.config.workspace, "memory/system/onboarding.md"));

  // Profiles carrying terminal escapes, bidi controls (repeatedly, proving stateless regex), or secrets are rejected.
  assert.equal(parseProfile(`\`\`\`pedellus-profile\n${JSON.stringify({ ...PROFILE, ownerName: "\x1b[31mAda" })}\n\`\`\``), undefined);
  assert.equal(parseProfile(`\`\`\`pedellus-profile\n${JSON.stringify({ ...PROFILE, ownerName: "Ada\u202e" })}\n\`\`\``), undefined);
  assert.equal(parseProfile(`\`\`\`pedellus-profile\n${JSON.stringify({ ...PROFILE, ownerName: "Ada\u202e" })}\n\`\`\``), undefined);
  assert.equal(parseProfile(`\`\`\`pedellus-profile\n${JSON.stringify({ ...PROFILE, standingPreferences: [SECRET] })}\n\`\`\``, [SECRET]), undefined);
});

test("an existing configuration, symlinked root or existing data store is refused without mutation", { timeout: 30_000 }, async () => {
  const configPath = await setupDirectory("existing");
  await writeFile(configPath, "{\"owner\": true}\n");
  const models = syntheticModels([]);
  const io = terminal([]);
  await assert.rejects(
    runInit({ configPath, input: io.input, output: io.output, signal: io.signal, repoRoot, platform: "linux", isWsl: false, models: models.factory }),
    (error) => error instanceof InitError && /pedellus doctor/.test(error.message) && /pedellus login/.test(error.message),
  );
  assert.equal(await readFile(configPath, "utf8"), "{\"owner\": true}\n");
  await assert.rejects(stat(join(home, "existing", "workspace")), /ENOENT/, "nothing is scaffolded");

  // Symlinked target directory is refused.
  const realTarget = join(home, "real-dir");
  const linkedTarget = join(home, "linked-dir");
  await mkdir(realTarget);
  await symlink(realTarget, linkedTarget);
  await assert.rejects(
    runInit({ configPath: join(linkedTarget, "config.json"), input: io.input, output: io.output, repoRoot, platform: "linux", isWsl: false, models: models.factory }),
    (error) => error instanceof InitError && /symlink/.test(error.message),
  );

  // Second config filename sharing an existing data/credentials.json is refused.
  const sharedDir = join(home, "shared-root");
  await mkdir(join(sharedDir, "data"), { recursive: true });
  await writeFile(join(sharedDir, "data", "credentials.json"), "{\"version\":1,\"credentials\":{}}\n");
  await assert.rejects(
    runInit({ configPath: join(sharedDir, "second.json"), input: io.input, output: io.output, repoRoot, platform: "linux", isWsl: false, models: models.factory }),
    (error) => error instanceof InitError && /already holds/.test(error.message),
  );
});

test("a /mnt path on WSL warns and can be aborted with nothing written", { timeout: 30_000 }, async () => {
  const io = terminal([""]);
  const result = await runInit({
    configPath: "/mnt/c/pedellus-init-test/config.json",
    input: io.input,
    output: io.output,
    signal: io.signal,
    repoRoot,
    platform: "linux",
    isWsl: true,
    models: syntheticModels([]).factory,
  });
  assert.equal(result.outcome, "aborted");
  assert.match(io.transcript(), /DrvFs/);
});

test("terminalInteraction never retains secrets in TTY history or kill ring and aborts signal on Ctrl-C", { timeout: 10_000 }, async () => {
  // TTY history & kill-ring check: deleting a mistyped secret with Ctrl-U then pressing Up or Ctrl-Y
  // at the next prompt must never reveal any secret characters.
  const input = new PassThrough();
  input.isTTY = true;
  let captured = "";
  const output = new Writable({ write(chunk, _enc, cb) { captured += chunk.toString(); cb(); } });
  output.isTTY = true;
  const tty = terminalInteraction({ input, output });
  try {
    const first = tty.interaction.prompt({ type: "secret", message: "API key" });
    input.write(`sk-MISTYPED-SECRET-99999\x15${SECRET}\r`);
    assert.equal(await first, SECRET);
    const second = tty.interaction.prompt({ type: "text", message: "Name" });
    // Send Up-arrow and Ctrl-Y (yank kill ring), then Enter.
    input.write("\x1b[A\x19\r");
    assert.equal(await second, "");
    assert.doesNotMatch(captured, new RegExp(SECRET), "secret must never appear in TTY output or history");
    assert.doesNotMatch(captured, /MISTYPED-SECRET/, "killed secret must never survive into Ctrl-Y kill ring");

    // Raw-TTY Ctrl-C between prompts aborts `tty.signal` immediately.
    assert.equal(tty.signal.aborted, false);
    input.write("\x03");
    assert.equal(tty.signal.aborted, true, "Ctrl-C between prompts must abort the shared operation signal");
  } finally {
    tty.close();
  }

  // Piped EOF settles pending prompt cleanly.
  const piped = new PassThrough();
  const sink = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  const nonTty = terminalInteraction({ input: piped, output: sink });
  try {
    const pending = nonTty.interaction.prompt({ type: "text", message: "EOF test" });
    piped.end();
    await assert.rejects(pending, /closed/);
  } finally {
    nonTty.close();
  }
});
