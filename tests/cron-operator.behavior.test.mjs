// Owner scheduling controls over the private local socket.
//
// These checks use the real Gateway, the real local server/client and a synthetic provider. They
// cover the operator surface only: create/list/show/cancel across every mapped chat, the host's
// own origin and actor resolution (no conversation ID and no owner record is accepted from the
// wire), the native request-key idempotency (identical retry dedupes, conflict is refused, a
// cancelled original is never re-armed), exact-ID cancellation from another chat, and the CLI's
// honest unknown-outcome text when the gateway stops answering.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";

const packageRoot = process.env.PI_NANOBOT_CANDIDATE ?? new URL("../", import.meta.url).pathname;
const modules = join(packageRoot, "node_modules/@earendil-works");
const [
  { loadConfig },
  { openGateway },
  { CronJobsDoc },
  { prepareDataDirectory },
  { gatewaySocketPath, serveLocalGateway },
  { connectLocalGateway, LocalRemoteError },
  { CronCommandError, CronUsageError, parseCronInvocation, runCronCommand },
  { createModels, fauxAssistantMessage, fauxProvider },
  { BACKGROUND_CONTEXT },
] = await Promise.all([
  import(new URL("../dist/config.js", import.meta.url).href),
  import(new URL("../dist/runtime.js", import.meta.url).href),
  import(new URL("../dist/automation/cron.js", import.meta.url).href),
  import(new URL("../dist/store.js", import.meta.url).href),
  import(new URL("../dist/local/server.js", import.meta.url).href),
  import(new URL("../dist/local/client.js", import.meta.url).href),
  import(new URL("../dist/automation/operator-cli.js", import.meta.url).href),
  import(`${modules}/pi-ai/dist/index.js`),
  import(`${modules}/chord/dist/context/index.js`),
]);

const context = BACKGROUND_CONTEXT;
const PROVIDER = "operator-fixture";
const MODEL = { provider: PROVIDER, modelId: "synthetic" };
const CLI_CHAT = "cli:operator";
const TELEGRAM_CHAT = "telegram:77:chat:5";
const HOUR = 3_600_000;

async function syntheticGateway(t, label) {
  const directory = await mkdtemp(join(tmpdir(), `nanobot-cron-operator-${label}-`));
  const workspace = join(directory, "workspace");
  const dataDir = join(directory, "state");
  await mkdir(workspace, { recursive: true });
  const faux = fauxProvider({ provider: PROVIDER, models: [{ id: MODEL.modelId, name: "Synthetic operator model" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  // Loaded from a file so a spawned `dist/cli.js cron ...` reads exactly this configuration.
  const configFile = join(directory, "config.json");
  await writeFile(configFile, `${JSON.stringify({
    workspace,
    dataDir,
    model: MODEL,
    allowedModels: [MODEL],
    toolAllowlist: [],
    episodeSummary: { enabled: false },
    cron: { enabled: true },
  }, null, 2)}\n`);
  const config = await loadConfig(configFile);
  const gateway = await openGateway(config, context, { models });
  const socketPath = gatewaySocketPath((await prepareDataDirectory(config)).canonicalDataDir);
  const server = await serveLocalGateway({
    socketPath,
    gateway,
    context,
    tools: [],
    contextRefresh: false,
    presets: false,
  });
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await gateway.close(context).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  return {
    gateway,
    server,
    socketPath,
    configFile,
    faux,
    harness: gateway.harness,
    async connect(conversation, operatorOnly = false) {
      const client = await connectLocalGateway({ socketPath, conversation, operatorOnly, context });
      clients.push(client);
      return client;
    },
  };
}

/** Run the built process entry point against the already-listening synthetic gateway. */
function runCronCli(configFile, args) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(packageRoot, "dist", "cli.js"), "cron", ...args, "--config", configFile], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolveRun({ code: null, stdout, stderr: `${stderr}${String(error)}` });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr });
    });
  });
}

function capture() {
  const chunks = [];
  return {
    chunks,
    output: new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); } }),
    text: () => chunks.join(""),
  };
}

const jobCount = async (store, conversationId) =>
  ((await store.harness.snapshot(CronJobsDoc, conversationId, context))?.jobs ?? []).length;
const taskCount = async (store) => (await store.harness.inspect(context)).tasks.length;

const schedule = (overrides = {}) => ({
  message: "Stretch and check the build",
  name: "stretch",
  schedule: { kind: "after", afterMs: HOUR },
  idempotencyKey: "operator-1",
  ...overrides,
});

test("operator controls create, list, show and cancel across every mapped chat", { timeout: 60_000 }, async (t) => {
  const store = await syntheticGateway(t, "controls");
  const origin = await store.gateway.conversationFor(CLI_CHAT, context);
  const telegram = await store.gateway.conversationFor(TELEGRAM_CHAT, context);
  const client = await store.connect("operator");
  assert.equal(client.sessionKey, CLI_CHAT);

  const created = await client.cronCreate(CLI_CHAT, schedule(), context);
  assert.equal(created.status, "scheduled");
  assert.equal(created.deduplicated, false);
  assert.equal(created.job.origin, CLI_CHAT, "the job is attributed to the mapped chat, not a conversation");
  assert.equal(created.job.status, "scheduled");
  assert.ok(created.nextAtMs > Date.now(), "the first occurrence is in the future");
  assert.equal(created.job.mode, "background");
  assert.equal(JSON.stringify(created).includes("\"conversationId\""), false,
    "the operator surface never projects a conversation ID");

  const stored = async () => (await store.harness.snapshot(CronJobsDoc, origin.id, context)).jobs;
  const [first] = await stored();
  assert.equal(first.idempotencyKey, "operator-1", "the explicit durable request key is stored");
  assert.equal(first.owner.sessionKey, CLI_CHAT, "the host derived the owner from the mapped chat");
  assert.equal(await jobCount(store, origin.id), 1);
  assert.equal(await jobCount(store, telegram.id), 0);
  const tasksAfterFirst = await taskCount(store);

  const retried = await client.cronCreate(CLI_CHAT, schedule(), context);
  assert.equal(retried.status, "scheduled");
  assert.equal(retried.deduplicated, true, "an identical retry dedupes on the request key");
  assert.equal(retried.jobId, created.jobId);
  assert.equal(await jobCount(store, origin.id), 1, "a retry creates no second job");
  assert.equal(await taskCount(store), tasksAfterFirst, "a retry arms no second timer");

  await assert.rejects(
    () => client.cronCreate(CLI_CHAT, schedule({ message: "different instruction" }), context),
    (error) => {
      assert.ok(error instanceof LocalRemoteError);
      assert.equal(error.code, "invalid", "a conflicting payload is a definitive refusal");
      assert.match(error.message, /already names a different cron job/);
      return true;
    },
  );
  assert.equal((await stored())[0].message, "Stretch and check the build",
    "the conflicting request changed nothing");

  // An explicitly selected Telegram origin is a mapped ordinary chat, so the operator may schedule
  // on it; the gateway still resolves that key to its conversation and its own owner record.
  const telegramJob = await client.cronCreate(TELEGRAM_CHAT, schedule({
    idempotencyKey: "operator-telegram-1",
    message: "Morning check",
    name: "morning check",
    schedule: { kind: "after", afterMs: HOUR / 2 },
  }), context);
  assert.equal(telegramJob.status, "scheduled");
  assert.equal(telegramJob.job.origin, TELEGRAM_CHAT);
  assert.equal((await stored()).length, 1);

  const unknownOrigin = await client.cronCreate("telegram:1:chat:0", schedule({
    idempotencyKey: "operator-unknown",
  }), context);
  assert.deepEqual(unknownOrigin, { status: "unknown_origin" });
  assert.equal(await taskCount(store), tasksAfterFirst + 1, "an unknown origin schedules nothing");

  await assert.rejects(
    () => client.cronCreate(CLI_CHAT, schedule({ idempotencyKey: "bad", message: "" }), context),
    (error) => error instanceof LocalRemoteError && error.code === "invalid",
  );
  await assert.rejects(
    () => client.cronCreate(origin.id, schedule({ idempotencyKey: "bad-number" }), context),
    (error) => error instanceof LocalRemoteError && error.code === "invalid",
    "a conversation ID on the wire is refused; only a mapped session key is a chat",
  );

  const listed = await client.cronList(context);
  assert.deepEqual(listed.origins.sort(), [CLI_CHAT, TELEGRAM_CHAT].sort(),
    "listing names the legitimate origins so an explicit --origin can be given");
  assert.deepEqual(listed.jobs.map((job) => job.origin).sort(), [CLI_CHAT, TELEGRAM_CHAT].sort(),
    "store-wide listing spans both legitimate origins");
  assert.equal(listed.jobs[0].id, telegramJob.jobId, "armed work is ordered by its next occurrence");
  assert.equal(listed.jobs.every((job) => job.status === "scheduled"), true);

  assert.equal((await client.cronShow(created.jobId, context)).length, 1);
  assert.deepEqual(await client.cronShow("cron-missing", context), []);

  // Cross-origin exact-ID cancellation: the caller attached as cli:operator, the job belongs to the
  // Telegram chat. Nothing is cancelled by origin guesswork, only by the exact job ID.
  const cancelledElsewhere = await client.cronCancel(telegramJob.jobId, context);
  assert.equal(cancelledElsewhere.status, "cancelled");
  assert.equal(cancelledElsewhere.job.status, "cancelled");
  assert.equal(cancelledElsewhere.job.origin, TELEGRAM_CHAT);
  assert.equal(cancelledElsewhere.abortError, null);
  assert.equal((await store.harness.snapshot(CronJobsDoc, telegram.id, context)).jobs[0].cancelledAtMs !== null, true);

  const cancelled = await client.cronCancel(created.jobId, context);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.job.status, "cancelled");
  assert.equal(cancelled.job.nextAtMs, null);
  assert.equal(cancelled.abortError, null, "a complete cancellation reports no cleanup failure");
  const tasksAfterCancel = await taskCount(store);

  const again = await client.cronCancel(created.jobId, context);
  assert.equal(again.status, "already_terminal");
  assert.equal(again.job.status, "cancelled");

  assert.deepEqual(await client.cronCancel("cron-missing", context), { status: "not_found" });

  const replayedAfterCancel = await client.cronCreate(CLI_CHAT, schedule(), context);
  assert.equal(replayedAfterCancel.status, "scheduled");
  assert.equal(replayedAfterCancel.deduplicated, true);
  assert.equal(replayedAfterCancel.jobId, created.jobId);
  assert.equal(replayedAfterCancel.job.status, "cancelled", "a cancelled original is never re-armed");
  assert.equal(replayedAfterCancel.job.nextAtMs, null);
  assert.equal(await taskCount(store), tasksAfterCancel, "the replayed request armed no timer");
  assert.equal(await jobCount(store, origin.id), 1);
  assert.equal((await stored())[0].cancelledAtMs !== null, true);
});

test("operator reads attach to no chat and listings have compact reachable pages", { timeout: 30_000 }, async (t) => {
  const store = await syntheticGateway(t, "pages");
  const client = await store.connect(undefined, true);
  assert.deepEqual((await client.cronList(context)).origins, []);
  assert.deepEqual(await client.cronShow("cron-missing", context), []);
  const processList = await runCronCli(store.configFile, ["list"]);
  assert.equal(processList.code, 0, processList.stderr);
  assert.match(processList.stdout, /Mapped chats: none/);
  assert.deepEqual((await client.cronList(context)).origins, [], "reads create no session mapping");

  await store.gateway.conversationFor(CLI_CHAT, context);
  for (let index = 0; index < 101; index++) {
    await client.cronCreate(CLI_CHAT, schedule({ idempotencyKey: `page-${index}` }), context);
  }
  const first = await client.cronList(context);
  assert.equal(first.jobs.length, 100);
  assert.equal(first.total, 101);
  assert.equal(first.nextOffset, 100);
  assert.equal("message" in first.jobs[0], false, "list omits unused detailed projections");
  const second = await client.cronList(context, first.nextOffset);
  assert.equal(second.jobs.length, 1);
  assert.equal(second.nextOffset, null);
  assert.equal(new Set([...first.jobs, ...second.jobs].map((job) => job.id)).size, 101);
  const output = capture();
  await runCronCommand({ client, command: { kind: "list" }, output: output.output, context });
  assert.match(output.text(), /Next page: durable-nanobot cron list --offset 100/);
  assert.deepEqual(parseCronInvocation(["list", "--offset", "100"]).command, { kind: "list", offset: 100 });
});

test("the CLI surface creates, lists and reports a lost response as unknown", { timeout: 60_000 }, async (t) => {
  const store = await syntheticGateway(t, "cli");
  await store.gateway.conversationFor(CLI_CHAT, context);
  const client = await store.connect("operator");

  const created = capture();
  await runCronCommand({
    client,
    command: parseCronInvocation([
      "create", "--origin", CLI_CHAT, "--key", "cli-1", "--after", "600", "--message", "Stretch and check the build",
    ]).command,
    output: created.output,
    context,
  });
  const createdText = created.text();
  assert.match(createdText, /^Scheduled on cli:operator\./);
  const jobId = /^(cron-[0-9a-f-]+)  /m.exec(createdText)?.[1];
  assert.ok(jobId !== undefined, createdText);
  assert.match(createdText, /message: Stretch and check the build/);

  const listed = capture();
  await runCronCommand({ client, command: { kind: "list" }, output: listed.output, context });
  assert.match(listed.text(), new RegExp(`^1 cron job in 1 chat:\\n${jobId}  scheduled  next `));
  assert.match(listed.text(), /Mapped chats: .*cli:operator/);

  // The real process entry point: dispatch, configuration default, attach and exit status.
  const processList = await runCronCli(store.configFile, ["list"]);
  assert.equal(processList.signal, null);
  assert.equal(processList.code, 0, processList.stderr);
  assert.match(processList.stdout, new RegExp(`^1 cron job in 1 chat:\\n${jobId}  scheduled  next `));
  assert.match(processList.stdout, /Mapped chats: .*cli:operator/);
  assert.doesNotMatch(processList.stdout, /cli:default/, "operator reads must not create a default chat");
  const missing = await runCronCli(store.configFile, ["show", "cron-missing"]);
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /^durable-nanobot cron: no scheduled job with id cron-missing\.$/m);

  const shown = capture();
  await runCronCommand({ client, command: { kind: "show", jobId }, output: shown.output, context });
  assert.match(shown.text(), new RegExp(`^${jobId}  Stretch and check the build`));
  assert.match(shown.text(), /origin: cli:operator/);
  assert.match(shown.text(), /mode: background/);

  await assert.rejects(
    () => runCronCommand({ client, command: { kind: "show", jobId: "cron-missing" }, output: capture().output, context }),
    (error) => error instanceof CronCommandError && /no scheduled job/.test(error.message),
  );

  // The gateway stops answering after the request may already have been sent: the CLI must not
  // claim the cancellation failed or succeeded.
  await store.server.close();
  await assert.rejects(
    () => runCronCommand({ client, command: { kind: "cancel", jobId }, output: capture().output, context }),
    (error) => error instanceof CronCommandError
      && /outcome is unknown/.test(error.message)
      && /cron show/.test(error.message),
  );
});

test("the cron command refuses ambiguous and incomplete forms before anything is sent", () => {
  const list = parseCronInvocation(["list"]);
  assert.deepEqual(list.command, { kind: "list" });
  assert.deepEqual(parseCronInvocation(["list", "--config", "/tmp/config.json"]), {
    command: { kind: "list" },
    configPath: "/tmp/config.json",
  });

  const create = parseCronInvocation([
    "create", "--key", "daily-1", "--message", "Morning check", "--name", "morning",
    "--cron", "0 9 * * 1-5", "--tz", "Europe/Budapest", "--mode", "origin",
    "--origin", TELEGRAM_CHAT,
  ]);
  assert.deepEqual(create.command, {
    kind: "create",
    origin: TELEGRAM_CHAT,
    request: {
      message: "Morning check",
      name: "morning",
      mode: "origin",
      schedule: { kind: "cron", expr: "0 9 * * 1-5", timeZone: "Europe/Budapest" },
      idempotencyKey: "daily-1",
    },
  });
  assert.equal(parseCronInvocation(["show", "cron-abc"]).command.jobId, "cron-abc");
  assert.equal(parseCronInvocation(["cancel", "cron-abc"]).command.jobId, "cron-abc");

  for (const args of [
    [],
    ["list", "--origin", CLI_CHAT],
    ["list", "extra"],
    ["show"],
    ["show", "not a job id"],
    ["cancel", "cron-abc", "extra"],
    ["create", "--key", "k", "--message", "m", "--after", "600", "--origin", CLI_CHAT, "--bogus", "x"],
  ]) {
    assert.throws(() => parseCronInvocation(args), CronUsageError, `usage: ${JSON.stringify(args)}`);
  }
  assert.throws(() => parseCronInvocation(["create", "--key", "k", "--message", "m", "--after", "600"]),
    /requires --origin, --key and --message/);
  for (const [args, message] of [
    [["create", "--key", "k", "--message", "m"], /exactly one of --at, --after, --every or --cron/],
    [["create", "--key", "k", "--message", "m", "--after", "600", "--every", "60"], /exactly one/],
    [["create", "--message", "m", "--after", "600"], /requires --origin, --key and --message/],
    [["create", "--key", "k", "--after", "600"], /requires --origin, --key and --message/],
    [["create", "--key", "k", "--message", "m", "--after", "600", "--tz", "UTC"], /only applies to --cron/],
    [["create", "--key", "k", "--message", "m", "--after", "0"], /positive whole number of seconds/],
    [["create", "--key", "k", "--message", "m", "--mode", "sometimes", "--after", "600"], /mode must be/],
    [["create", "--key", "k", "--message", "m", "--at", "2026-11-01T09:00:00"], /explicit UTC offset or Z/],
  ]) {
    assert.throws(() => parseCronInvocation([...args, "--origin", CLI_CHAT]), (error) => {
      assert.ok(error instanceof CronCommandError, `refusal: ${JSON.stringify(args)}`);
      assert.match(error.message, message);
      return true;
    });
  }
});
