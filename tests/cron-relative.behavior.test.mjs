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
const { configure, Harness, createRegistry } = await load(
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
async function openHarness(dbPath, extension, models, now) {
  const storage = await openFullSyncNodeSqliteStorage(dbPath, context);
  const registry = createRegistry();
  registry.install(extension);
  return Harness.open(storage, { models, registry, ...(now === undefined ? {} : { now }) }, context);
}
const owner = { owner: { ownerId: "relative-owner", sessionKey: "relative:session" } };
const base = { message: "stretch", name: "stretch", mode: "background" };
/** Await one task's state reaching `status`, draining the event loop between bounded reads. */
async function awaitTaskStatus(harness, id, status, context) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const record = await harness.getTask(id, context);
    if (record !== undefined && record.state.status === status) return record;
    await new Promise((resolve) => setImmediate(resolve));
  }
  const record = await harness.getTask(id, context);
  assert.fail(`task ${id} never reached ${status} (state: ${record?.state.status})`);
}

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
  // Arithmetic overflow while following the interval is the absence of a next slot, never a
  // throw that would discard the occurrence that is due right now: the anchor's own slot is
  // valid, and the slot after it overflows the safe-integer range.
  assert.equal(nextCronOccurrence({ kind: "every", everyMs: 4e15, anchorMs: 8e15 }, now), 8e15);
  assert.equal(nextCronOccurrence({ kind: "every", everyMs: 4e15, anchorMs: 8e15 }, 8e15), null);
  assert.match(cronScheduleText({ kind: "at", at: MAX_DATE_MS + 1 }), /once at an unrepresentable time/);
  assert.match(cronScheduleText({ kind: "every", everyMs: 60_000, anchorMs: MAX_DATE_MS + 5 }), /from an unrepresentable time/);
});

test("persisted timer state: valid sleeps survive reopen, an invalid deadline never arms or runs", { timeout: 30_000 }, async () => {
  const dir = await temp("nanobot-cron-persisted-");
  const db = resolve(dir, "persisted.sqlite");
  const { MAX_DATE_MS } = await load(`${pkg}/dist/automation/cron-schedule.js`);
  let harness;
  try {
    let clock = Date.now();
    const foundation = createCronFoundation({ now: () => clock });
    const models = createModels();
    const faux = fauxProvider({ provider: "cron-persisted-faux", models: [{ id: "synthetic", name: "Synthetic" }] });
    faux.setResponses([fauxAssistantMessage("occurrence reply")]);
    models.setProvider(faux.provider);

    // Harness 1: two valid jobs sleep on their persisted deadlines.
    harness = await openHarness(db, foundation.extension, models, () => clock);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const writer = conversationWriter(harness, conversation);
    const valid = await foundation.schedule(owner, writer, {
      ...base, schedule: { kind: "after", afterMs: 3_600_000 }, idempotencyKey: "persisted:valid",
    }, context);
    const legacy = await foundation.schedule(owner, writer, {
      ...base, schedule: { kind: "after", afterMs: 3_600_000 }, idempotencyKey: "persisted:legacy",
    }, context);
    await harness.waitForIdle(context);
    const sleeping = await awaitTaskStatus(harness, valid.timerTaskId, "sleeping", context);
    assert.equal(sleeping.state.until, valid.nextAtMs);
    // Retire the legacy job's own valid timer; a fabricated out-of-range input replaces it below,
    // standing in for a timer persisted by an older build before the shared bound existed.
    await harness.abortTask(legacy.timerTaskId, context);
    await harness.waitForTask(legacy.timerTaskId, context);
    await harness.close(context);
    harness = undefined;

    // Harness 2 (recovery ordering): the valid sleep is restored as a sleep, not re-run early,
    // and the fabricated invalid timer is committed pending with no progress call to run it.
    harness = await openHarness(db, foundation.extension, models, () => clock);
    const timerDefinition = foundation.extension.tasks
      .find((task) => task.definition.name === "nanobot.cron.timer");
    assert.ok(timerDefinition !== undefined);
    const invalidTimerId = await harness.commit(async (tx) => {
      const id = await tx.createTask(timerDefinition,
        { jobId: legacy.jobId, scheduledAtMs: MAX_DATE_MS + 1, generation: 1 },
        { ownership: { kind: "conversation" }, conversationId: conversation.id, background: true });
      const doc = await tx.doc(CronJobsDoc, conversation.id, context);
      doc.jobs.find((job) => job.id === legacy.jobId).timerTaskId = id;
      return id;
    }, context);
    const restoredSleep = await harness.getTask(valid.timerTaskId, context);
    assert.equal(restoredSleep.state.status, "sleeping", "a valid sleep is restored, never re-run early");
    assert.equal(restoredSleep.state.until, valid.nextAtMs);
    await harness.close(context);
    harness = undefined;

    // Harness 3: the resumed invalid timer settles as failed without sleeping, arming or running
    // an occurrence, and the job stays inspectable and cancellable through the ordinary paths.
    harness = await openHarness(db, foundation.extension, models, () => clock);
    const settled = await harness.waitForTask(invalidTimerId, context);
    assert.equal(settled.state.status, "terminal");
    assert.equal(settled.state.outcome.status, "failed");
    assert.match(settled.state.outcome.error.message, /not a representable time/);
    const jobs = await readJobs(harness, conversation.id);
    const legacyJob = jobs.find((job) => job.id === legacy.jobId);
    assert.equal(legacyJob.executionTaskId, null, "no occurrence was armed for the invalid deadline");
    assert.equal(legacyJob.timerTaskId, invalidTimerId);
    assert.equal(legacyJob.lastOutcome, null);
    const stillSleeping = await harness.getTask(valid.timerTaskId, context);
    assert.equal(stillSleeping.state.status, "sleeping", "the valid timer is untouched");
    const listed = await foundation.list(harness, conversation.id, owner, context);
    assert.equal(listed.length, 2, "both jobs stay inspectable");
    const cancelled = await foundation.cancel(harness, conversation.id, legacy.jobId, owner, context);
    assert.equal(cancelled.status, "cancelled");
    assert.notEqual((await readJobs(harness, conversation.id))
      .find((job) => job.id === legacy.jobId).cancelledAtMs, null);
    // Cleanup: settle the valid timer so the closed harness leaves nothing live.
    await harness.abortTask(valid.timerTaskId, context);
    await harness.waitForTask(valid.timerTaskId, context);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("the final valid interval occurrence commits exactly once near the boundary", { timeout: 30_000 }, async () => {
  const dir = await temp("nanobot-cron-boundary-");
  const db = resolve(dir, "boundary.sqlite");
  const { MAX_DATE_MS } = await load(`${pkg}/dist/automation/cron-schedule.js`);
  let harness;
  try {
    const start = Date.now();
    let clock = start;
    const foundation = createCronFoundation({ now: () => clock });
    const models = createModels();
    const faux = fauxProvider({ provider: "cron-boundary-faux", models: [{ id: "synthetic", name: "Synthetic" }] });
    faux.setResponses([fauxAssistantMessage("boundary occurrence reply")]);
    models.setProvider(faux.provider);
    // Every conversation the run machinery creates (the occurrence's own execution conversation)
    // receives the faux model, exactly as the gateway's default agent policy does.
    const storage = await openFullSyncNodeSqliteStorage(db, context);
    const registry = createRegistry();
    registry.install(foundation.extension);
    harness = await Harness.open(storage, {
      models,
      registry,
      now: () => clock,
      conversationCreated: (tx, conversation) =>
        configure(tx, conversation.id, { model: { provider: faux.provider.id, modelId: "synthetic" } }),
    }, context);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const writer = conversationWriter(harness, conversation);
    // The admitted anchor sits 1000 ms inside the representable bound; the following slot is
    // arithmetic overflow, so the final valid occurrence must still commit exactly once.
    const everyMs = MAX_DATE_MS - 1_000 - start;
    const receipt = await foundation.schedule(owner, writer, {
      ...base, mode: "origin",
      schedule: { kind: "every", everyMs }, idempotencyKey: "boundary:final",
    }, context);
    assert.equal(receipt.nextAtMs, MAX_DATE_MS - 1_000);

    clock = MAX_DATE_MS - 500;
    const settled = await harness.waitForTask(receipt.timerTaskId, context);
    assert.equal(settled.state.status, "terminal");
    assert.equal(settled.state.outcome.result.outcome, "admitted",
      "the due occurrence commits instead of the overflow discarding it");
    const [job] = await readJobs(harness, conversation.id);
    assert.ok(job.executionTaskId !== null, "the final occurrence was admitted exactly once");
    assert.equal(job.timerTaskId, null, "the overflowed following slot arms no new timer");
    const execution = await harness.getTask(job.executionTaskId, context);
    assert.equal(execution.input.scheduledAtMs, MAX_DATE_MS - 1_000);
    const runSettled = await harness.waitForTask(job.executionTaskId, context);
    assert.equal(runSettled.state.status, "terminal");
    assert.equal(runSettled.state.outcome.status, "completed");
    assert.equal(runSettled.state.outcome.result.outcome, "ok");
    const [afterRun] = await readJobs(harness, conversation.id);
    assert.equal(afterRun.lastOutcome.status, "ok", JSON.stringify(afterRun.lastOutcome));
    assert.equal(afterRun.executionTaskId, job.executionTaskId);
    // One occurrence only: no skip, no second execution, no re-arm.
    assert.equal(afterRun.lastSkip, null);
    const runTasks = await harness.commit(
      (tx) => tx.scanTasks({ kind: "nanobot.cron.run" }, 100, undefined), context);
    assert.equal(runTasks.items.length, 1, "exactly one run task exists for the job");
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
