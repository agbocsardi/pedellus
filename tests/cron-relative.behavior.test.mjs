import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const pkg = process.env.PI_MODEL_CANDIDATE ?? resolve(import.meta.dirname, "..");
const ai = `${pkg}/node_modules/@earendil-works/pi-ai/dist`;
const chord = `${pkg}/node_modules/@earendil-works/chord/dist`;
const load = (path) => import(pathToFileURL(path).href);

const { createCronFoundation, CronJobsDoc } = await load(`${pkg}/dist/automation/cron.js`);
const { openFullSyncNodeSqliteStorage } = await load(`${pkg}/dist/storage/sqlite.js`);
const { Harness, createRegistry } = await load(
  `${pkg}/node_modules/@earendil-works/pi-durable/dist/index.js`,
);
const { BACKGROUND_CONTEXT } = await load(`${chord}/context/index.js`);
const { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } = await load(`${ai}/index.js`);
const context = BACKGROUND_CONTEXT;

const temp = (prefix) => mkdtemp(resolve(tmpdir(), prefix));
const conversationWriter = (harness, conversation) => ({
  id: conversation.id,
  commit: (change, ctx) => harness.commit(change, ctx),
});
const readJobs = async (harness, conversationId) => {
  const doc = await harness.snapshot(CronJobsDoc, conversationId, context);
  return doc?.jobs ?? [];
};
async function openHarness(dbPath, extension, models) {
  const storage = await openFullSyncNodeSqliteStorage(dbPath, context);
  const registry = createRegistry();
  registry.install(extension);
  return Harness.open(storage, { models, registry }, context);
}
const owner = { owner: { ownerId: "relative-owner", sessionKey: "relative:session" } };
const base = { message: "stretch", name: "stretch", mode: "background" };

test("relative one-shot keeps its admitted deadline across retries, clock jumps and reopen", { timeout: 10_000 }, async () => {
  const dir = await temp("nanobot-cron-relative-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    let clock = Date.now() + 3_600_000;
    const admission = clock;
    const foundation = createCronFoundation({ now: () => clock });
    const models = createModels();
    harness = await openHarness(db, foundation.extension, models);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const writer = conversationWriter(harness, conversation);
    const request = {
      ...base,
      schedule: { kind: "after", afterMs: 600_000 },
      idempotencyKey: "tool:relative-600",
    };

    const receipt = await foundation.schedule(owner, writer, request, context);
    const [created] = await readJobs(harness, conversation.id);
    assert.equal(created.schedule.kind, "at");
    assert.equal(created.schedule.at, admission + 600_000);
    assert.equal(created.createdAtMs, admission);
    assert.equal(receipt.nextAtMs, admission + 600_000);
    const timer = await harness.getTask(receipt.timerTaskId, context);
    assert.equal(timer.input.scheduledAtMs, admission + 600_000);

    clock = admission + 900_000;
    const replayed = await foundation.schedule(owner, writer, request, context);
    const afterReplay = await readJobs(harness, conversation.id);
    assert.equal(replayed.deduplicated, true);
    assert.equal(replayed.jobId, created.id);
    assert.equal(replayed.timerTaskId, created.timerTaskId);
    assert.equal(replayed.nextAtMs, admission + 600_000);
    assert.equal(afterReplay.length, 1);

    await assert.rejects(
      () => foundation.schedule(owner, writer, {
        ...base, schedule: { kind: "after", afterMs: 60_000 }, idempotencyKey: "tool:relative-600",
      }, context),
      /already names a different cron job/,
    );
    for (const schedule of [
      { kind: "after", afterMs: 0 },
      { kind: "after", afterMs: 1.5 },
      { kind: "after", afterMs: Number.NaN },
      { kind: "after", afterMs: 9e15 },
      { kind: "after", afterMs: Number.MAX_SAFE_INTEGER },
      { kind: "after", afterMs: 600_000, at: admission + 1_000 },
    ]) {
      await assert.rejects(
        () => foundation.schedule(owner, writer, { ...base, schedule, idempotencyKey: `tool:bad-${String(schedule.afterMs)}` }, context),
        /after schedule requires a positive integer afterMs|an after schedule must not carry|the relative one-shot exceeds the safe integer range|the relative one-shot is beyond the representable date range/,
      );
    }
    const unchanged = await readJobs(harness, conversation.id);
    assert.equal(unchanged.length, 1);
    assert.equal(unchanged[0].schedule.at, admission + 600_000);

    // A future deadline must not keep the process alive; settle the timer natively before closing.
    await harness.abortTask(created.timerTaskId, context);
    await harness.waitForTask(created.timerTaskId, context);
    await harness.close(context);
    harness = undefined;
    harness = await openHarness(db, foundation.extension, models);
    const reopenedWriter = conversationWriter(harness, conversation);
    const reopened = await foundation.schedule(owner, reopenedWriter, request, context);
    const afterReopen = await readJobs(harness, conversation.id);
    assert.equal(reopened.deduplicated, true);
    assert.equal(reopened.nextAtMs, admission + 600_000);
    assert.equal(afterReopen.length, 1);
    assert.equal(afterReopen[0].schedule.at, admission + 600_000);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("a persistent silent request dedupes, validates, and treats an absent legacy field as false", { timeout: 10_000 }, async () => {
  const dir = await temp("nanobot-cron-silent-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    const clock = Date.now();
    const foundation = createCronFoundation({ now: () => clock });
    harness = await openHarness(db, foundation.extension, createModels());
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const writer = conversationWriter(harness, conversation);
    const request = {
      ...base,
      silent: true,
      schedule: { kind: "every", everyMs: 3_600_000 },
      idempotencyKey: "tool:silent",
    };
    const receipt = await foundation.schedule(owner, writer, request, context);
    const [created] = await readJobs(harness, conversation.id);
    assert.equal(created.silent, true);

    const replayed = await foundation.schedule(owner, writer, request, context);
    assert.equal(replayed.deduplicated, true);
    assert.equal(replayed.jobId, created.id);

    // A different delivery setting under the same key is a different request, not a silent update.
    await assert.rejects(
      () => foundation.schedule(owner, writer, { ...request, silent: false }, context),
      /already names a different cron job/,
    );
    await assert.rejects(
      () => foundation.schedule(owner, writer, {
        ...request, idempotencyKey: "tool:silent-bad", silent: "yes",
      }, context),
      /silent must be a boolean when provided/,
    );

    // A job document written before `silent` existed lacks the field and must compare as false.
    await harness.commit(async (tx) => {
      const doc = await tx.doc(CronJobsDoc, conversation.id);
      delete doc.jobs[0].silent;
    }, context);
    const legacyReplay = await foundation.schedule(owner, writer, { ...request, silent: false }, context);
    assert.equal(legacyReplay.deduplicated, true);
    assert.equal(legacyReplay.jobId, created.id);
    const [afterLegacy] = await readJobs(harness, conversation.id);
    assert.equal(afterLegacy.silent, undefined, "the legacy record is not rewritten");

    await harness.abortTask(receipt.timerTaskId, context);
    await harness.waitForTask(receipt.timerTaskId, context);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("a completed relative one-shot retry dedupes its original instant with no new job or timer", { timeout: 10_000 }, async () => {
  const dir = await temp("nanobot-cron-relative-fired-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    const providerId = "cron-relative-fired-faux";
    const provider = fauxProvider({ provider: providerId, models: [{ id: "synthetic", name: "Synthetic" }] });
    provider.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("Reminder: stretch.")));
    const models = createModels();
    models.setProvider(provider.provider);
    const foundation = createCronFoundation({ now: () => Date.now() });
    harness = await openHarness(db, foundation.extension, models);
    harness.resume();
    const conversation = await harness.createConversation({
      ownership: { kind: "ownerless" },
      agent: { model: { provider: providerId, modelId: "synthetic" }, tools: [], modelTools: [] },
    }, context);
    const writer = conversationWriter(harness, conversation);
    const request = {
      ...base,
      mode: "origin",
      schedule: { kind: "after", afterMs: 50 },
      idempotencyKey: "tool:relative-fired",
    };

    const receipt = await foundation.schedule(owner, writer, request, context);
    const [created] = await readJobs(harness, conversation.id);
    assert.equal(created.schedule.at, created.createdAtMs + 50);
    await harness.waitForTask(receipt.timerTaskId, context);
    const [fired] = await readJobs(harness, conversation.id);
    assert.equal(fired.timerTaskId, null);
    assert.notEqual(fired.executionTaskId, null);
    await harness.waitForTask(fired.executionTaskId, context);

    const [settled] = await readJobs(harness, conversation.id);
    assert.equal(settled.lastOutcome.status, "ok");
    const replayed = await foundation.schedule(owner, writer, request, context);
    const afterReplay = await readJobs(harness, conversation.id);
    assert.equal(replayed.deduplicated, true);
    assert.equal(replayed.jobId, settled.id);
    assert.equal(replayed.timerTaskId, null);
    assert.equal(replayed.nextAtMs, null);
    assert.equal(afterReplay.length, 1);
    assert.equal(afterReplay[0].schedule.at, settled.schedule.at);
    assert.equal(afterReplay[0].lastOutcome.status, "ok");
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("the model-facing cron tool accepts after_seconds and acknowledges the stored instant", { timeout: 10_000 }, async () => {
  const dir = await temp("nanobot-cron-relative-gateway-");
  const workspace = resolve(dir, "workspace");
  await mkdir(workspace);
  let gateway;
  try {
    const providerId = "cron-relative-gateway-faux";
    const model = { provider: providerId, modelId: "synthetic" };
    const { openGateway } = await load(`${pkg}/dist/runtime.js`);
    const { parseConfig } = await load(`${pkg}/dist/config.js`);
    const config = parseConfig({
      workspace,
      dataDir: resolve(dir, "data"),
      model,
      allowedModels: [model],
      cron: { enabled: true, timeZone: "UTC" },
    }, dir);
    const provider = fauxProvider({ provider: providerId, models: [{ id: "synthetic", name: "Synthetic" }] });
    provider.setResponses([
      fauxAssistantMessage([fauxToolCall("cron", {
        action: "add", message: "stretch", after_seconds: 600,
      }, { id: "call-relative-600" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Scheduled the stretch reminder."),
    ]);
    const models = createModels();
    models.setProvider(provider.provider);
    gateway = await openGateway(config, context, { models });
    const conversation = await gateway.conversationFor("cron-relative:session", context);

    const before = Date.now();
    const submission = await conversation.submit(
      { type: "input", content: "remind me in ten minutes to stretch", requestId: "relative-request" },
      context,
    );
    assert.equal((await submission.wait(context)).status, "done");
    await conversation.waitForIdle(context);
    const after = Date.now();

    const jobs = await readJobs(gateway.harness, conversation.id);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].idempotencyKey, "tool:call-relative-600");
    assert.equal(jobs[0].schedule.kind, "at");
    assert.ok(jobs[0].schedule.at >= before + 600_000);
    assert.ok(jobs[0].schedule.at <= after + 600_000);
    const page = await conversation.entries({}, 50, undefined, context);
    const result = page.items.find((entry) => entry.kind === "pi.tool-result");
    assert.ok(result !== undefined);
    assert.match(JSON.stringify(result), new RegExp(`once at ${new Date(jobs[0].schedule.at).toISOString()}`));

    // Clear the ten-minute deadline rather than leaving a live timer behind the test.
    await gateway.harness.abortTask(jobs[0].timerTaskId, context);
    await gateway.harness.waitForTask(jobs[0].timerTaskId, context);
    await gateway.close(context);
    gateway = undefined;
  } finally {
    if (gateway !== undefined) await gateway.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("times beyond the representable date range are refused at admission and settle when stored", async () => {
  const { MAX_DATE_MS, cronScheduleText, materializeCronSchedule, nextCronOccurrence } =
    await load(`${pkg}/dist/automation/cron-schedule.js`);
  const now = Date.now();
  // Admission: a one-shot instant or interval anchor beyond the shared bound is refused before
  // any job or timer state is written; the bound itself is accepted.
  assert.throws(
    () => materializeCronSchedule({ kind: "at", at: MAX_DATE_MS + 1 }, now),
    /representable date range/,
  );
  assert.throws(
    () => materializeCronSchedule({ kind: "every", everyMs: MAX_DATE_MS }, now),
    /representable date range/,
  );
  assert.equal(materializeCronSchedule({ kind: "at", at: MAX_DATE_MS }, now).at, MAX_DATE_MS);
  // Stored legacy records beyond the bound stay safe: no future slot is armed and the schedule
  // text renders honestly instead of throwing or fabricating a valid date.
  assert.equal(nextCronOccurrence({ kind: "at", at: MAX_DATE_MS + 1 }, now), null);
  assert.equal(nextCronOccurrence({ kind: "every", everyMs: 1_000, anchorMs: MAX_DATE_MS + 1 }, now), null);
  assert.match(cronScheduleText({ kind: "at", at: MAX_DATE_MS + 1 }), /once at an unrepresentable time/);
  assert.match(cronScheduleText({ kind: "every", everyMs: 60_000, anchorMs: MAX_DATE_MS + 5 }), /from an unrepresentable time/);
});
