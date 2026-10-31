// The cron conversation model: a conversation is ongoing activity and an episode is one execution.
// A recurring job keeps one automation conversation across its runs, one-off jobs share a per-origin
// catch-all conversation and queue on it durably, every background run starts with a native reset
// boundary so earlier episodes stay stored but out of the model context, and each run prepares and
// retires its own authority. Origin mode keeps running in the chat itself.
//
// The first two cases drive the foundation directly with a faux provider and real task waits; the
// third drives the real Gateway and asserts the automation class, authority retirement, the mapped
// chat rule and episode cataloguing.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const pkg = process.env.PI_MODEL_CANDIDATE ?? resolve(import.meta.dirname, "..");
const ai = `${pkg}/node_modules/@earendil-works/pi-ai/dist`;
const chord = `${pkg}/node_modules/@earendil-works/chord/dist`;
const durable = `${pkg}/node_modules/@earendil-works/pi-durable/dist`;
const load = (path) => import(pathToFileURL(path).href);

const { CRON_INPUT_ENTRY_KIND, CRON_JOBS_KIND, CronJobsDoc, createCronFoundation } = await load(
  `${pkg}/dist/automation/cron.js`,
);
const { CronConversationDoc } = await load(`${pkg}/dist/automation/cron-conversations.js`);
const { EPISODE_CATALOG_KIND } = await load(`${pkg}/dist/history/episodes.js`);
const { ConfigToolCaptureDoc } = await load(`${pkg}/dist/tools/index.js`);
const { openFullSyncNodeSqliteStorage } = await load(`${pkg}/dist/storage/sqlite.js`);
const {
  AgentDoc, Harness, ROOT_CONVERSATION_ID, configure, createRegistry, defineDoc,
} = await load(`${durable}/index.js`);
const { BACKGROUND_CONTEXT } = await load(`${chord}/context/index.js`);
const { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } = await load(`${ai}/index.js`);
const context = BACKGROUND_CONTEXT;

const WAIT_MS = 10_000;

const temp = (prefix) => mkdtemp(resolve(tmpdir(), prefix));
const conversationWriter = (harness, conversation) => ({
  id: conversation.id,
  commit: (change, ctx) => harness.commit(change, ctx),
});
const readJobs = async (harness, conversationId) => {
  const doc = await harness.snapshot(CronJobsDoc, conversationId, context);
  return doc?.jobs ?? [];
};
const readDoc = (harness, conversationId) => harness.snapshot(CronJobsDoc, conversationId, context);

async function openHarness(dbPath, extension, models) {
  const storage = await openFullSyncNodeSqliteStorage(dbPath, context);
  const registry = createRegistry();
  registry.install(extension);
  return Harness.open(storage, { models, registry }, context);
}

const ownerOf = (sessionKey) => ({ owner: { ownerId: sessionKey, sessionKey } });
const owner = ownerOf("cron-conversations:origin");

/**
 * Resolve on the next commit that matches, with a bounded deadline. `stop()` always clears that
 * deadline and cancels the observer, whether the watcher settled, failed or was never awaited.
 */
function changeWatcher(harness, predicate, label) {
  let settled = false;
  let settle;
  let timer;
  const promise = new Promise((resolveWatcher, reject) => {
    timer = setTimeout(() => settle.reject(new Error(`timed out waiting for ${label}`)), WAIT_MS);
    settle = {
      resolve: (publication) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveWatcher(publication);
      },
      reject: (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    };
  });
  void promise.catch(() => undefined);
  const unsubscribe = harness.subscribeCommits((publication) => {
    try {
      if (predicate(publication.changes)) settle.resolve(publication);
    } catch (error) {
      settle.reject(error);
    }
  });
  return {
    promise,
    stop() {
      settled = true;
      clearTimeout(timer);
      unsubscribe();
    },
  };
}

/** The user text of the last request in one recorded provider call, for context assertions. */
function userTexts(messages) {
  const texts = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    texts.push(typeof message.content === "string"
      ? message.content
      : (message.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join(""));
  }
  return texts;
}

/**
 * A foundation whose host seams do what the gateway does: prepare the run's model, tools and
 * captured authority in the claim commit, and retire them in the terminal commit. The automation
 * conversation is ownerless, so the host is the only thing that gives the run a model at all.
 */
function hostSeams(harnessRef) {
  const resets = [];
  return {
    resets,
    prepare: async ({ tx, originConversationId, targetConversationId }) => {
      const originAgent = await tx.doc(AgentDoc, originConversationId);
      const capture = await tx.doc(ConfigToolCaptureDoc, targetConversationId);
      capture.originConversationId = originConversationId;
      capture.tools = ["read"];
      await configure(tx, targetConversationId, {
        tools: [{ name: "read" }],
        modelTools: [{ name: "read" }],
        ...(originAgent.model === undefined ? {} : { model: { ...originAgent.model } }),
        ...(originAgent.thinkingLevel === undefined ? {} : { thinkingLevel: originAgent.thinkingLevel }),
      });
    },
    finalize: async ({ tx, targetConversationId, background }) => {
      if (!background) return;
      await tx.retireDoc(ConfigToolCaptureDoc, targetConversationId);
      await configure(tx, targetConversationId, { tools: [], modelTools: [] });
    },
    reset: async (conversationId, ctx) => {
      const conversation = await harnessRef.current.conversation(conversationId, ctx);
      assert.ok(conversation !== undefined, "the run's reset names an existing automation conversation");
      await conversation.reset(undefined, ctx);
      resets.push(conversationId);
    },
  };
}

/** Model-visible entries of one conversation, ignoring positional system/compaction records. */
const transcriptKinds = (page) => page.items
  .map((entry) => entry.kind)
  .filter((kind) => kind === "pi.reset" || kind === "pi.assistant" || kind === CRON_INPUT_ENTRY_KIND);

test("a recurring job keeps one conversation and starts a new episode for each run", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-cron-conversations-recurring-");
  const db = resolve(dir, "probe.sqlite");
  const harnessRef = { current: undefined };
  let harness;
  try {
    const providerId = "cron-conversations-recurring-faux";
    const provider = fauxProvider({ provider: providerId, models: [{ id: "synthetic", name: "Synthetic" }] });
    const requests = [];
    let run = 0;
    provider.setResponses(Array.from({ length: 8 }, () => (transcript) => {
      requests.push(userTexts(transcript.messages));
      run += 1;
      return fauxAssistantMessage(`episode ${run} answered`);
    }));
    const models = createModels();
    models.setProvider(provider.provider);
    const seams = hostSeams(harnessRef);
    const foundation = createCronFoundation({
      now: () => Date.now(),
      prepare: seams.prepare,
      finalize: seams.finalize,
      reset: seams.reset,
    });
    harness = await openHarness(db, foundation.extension, models);
    harnessRef.current = harness;
    harness.resume();
    const origin = await harness.createConversation({
      ownership: { kind: "ownerless" },
      agent: { model: { provider: providerId, modelId: "synthetic" }, tools: [], modelTools: [] },
    }, context);
    const writer = conversationWriter(harness, origin);

    const receipt = await foundation.schedule(owner, writer, {
      message: "stretch every interval",
      name: "stretch",
      schedule: { kind: "every", everyMs: 400 },
      idempotencyKey: "conversations:recurring",
    }, context);
    // The job document records no conversation of its own: the first run creates and records it.
    const [scheduled] = await readJobs(harness, origin.id);
    assert.equal(scheduled.conversationId, undefined);

    await harness.waitForTask(receipt.timerTaskId, context);
    const [firstRun] = await readJobs(harness, origin.id);
    assert.notEqual(firstRun.executionTaskId, null);
    await harness.waitForTask(firstRun.executionTaskId, context);
    const [afterFirst] = await readJobs(harness, origin.id);
    assert.equal(typeof afterFirst.conversationId, "number", "the first run records its conversation");
    const automationId = afterFirst.conversationId;
    assert.equal(afterFirst.lastOutcome.status, "ok");
    assert.equal(afterFirst.lastOutcome.conversationId, automationId);
    // The run's authority ended with the run, even though the conversation persists.
    assert.equal(await harness.snapshot(ConfigToolCaptureDoc, automationId, context), undefined);
    assert.deepEqual((await harness.snapshot(AgentDoc, automationId, context)).tools, []);
    const marker = await harness.snapshot(CronConversationDoc, automationId, context);
    assert.equal(marker.conversationClass, "recurring");
    assert.equal(marker.originConversationId, origin.id);
    assert.equal(marker.jobId, afterFirst.id);

    const nextTimer = afterFirst.timerTaskId;
    assert.notEqual(nextTimer, null);
    await harness.waitForTask(nextTimer, context);
    const [secondRun] = await readJobs(harness, origin.id);
    assert.notEqual(secondRun.executionTaskId, firstRun.executionTaskId);
    await harness.waitForTask(secondRun.executionTaskId, context);
    const [afterSecond] = await readJobs(harness, origin.id);
    assert.equal(afterSecond.conversationId, automationId, "both runs used one conversation");
    assert.equal(afterSecond.lastOutcome.conversationId, automationId);
    assert.deepEqual(seams.resets, [automationId, automationId], "each run placed one native reset");

    const conversation = await harness.conversation(automationId, context);
    const page = await conversation.entries({ order: "ascending" }, 100, undefined, context);
    assert.deepEqual(transcriptKinds(page), [
      "pi.reset", CRON_INPUT_ENTRY_KIND, "pi.assistant",
      "pi.reset", CRON_INPUT_ENTRY_KIND, "pi.assistant",
    ], "every run is its own reset-delimited episode");
    // The reset boundary is real: the second request's context holds only its own episode.
    assert.equal(requests.length >= 2, true);
    assert.deepEqual(requests[1], ["stretch every interval"]);
    assert.equal(requests[0].includes("episode 1 answered"), false);

    await harness.abortTask(afterSecond.timerTaskId, context);
    await harness.waitForTask(afterSecond.timerTaskId, context);
  } finally {
    harnessRef.current = undefined;
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("one-off runs share the catch-all conversation and queue durably", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-cron-conversations-one-off-");
  const db = resolve(dir, "probe.sqlite");
  const harnessRef = { current: undefined };
  let harness;
  try {
    const providerId = "cron-conversations-one-off-faux";
    const provider = fauxProvider({ provider: providerId, models: [{ id: "synthetic", name: "Synthetic" }] });
    let releaseFirst;
    const gate = new Promise((resolveGate) => { releaseFirst = resolveGate; });
    let started;
    const firstStarted = new Promise((resolveStarted) => { started = resolveStarted; });
    provider.setResponses([
      async () => {
        started();
        await gate;
        return fauxAssistantMessage("first one-off answered");
      },
      () => fauxAssistantMessage("second one-off answered"),
      () => fauxAssistantMessage("third one-off answered"),
    ]);
    const models = createModels();
    models.setProvider(provider.provider);
    const seams = hostSeams(harnessRef);
    const foundation = createCronFoundation({
      now: () => Date.now(),
      prepare: seams.prepare,
      finalize: seams.finalize,
      reset: seams.reset,
    });
    harness = await openHarness(db, foundation.extension, models);
    harnessRef.current = harness;
    harness.resume();
    const origin = await harness.createConversation({
      ownership: { kind: "ownerless" },
      agent: { model: { provider: providerId, modelId: "synthetic" }, tools: [], modelTools: [] },
    }, context);
    const writer = conversationWriter(harness, origin);
    const oneOff = (message, key) => foundation.schedule(owner, writer, {
      message,
      name: message,
      mode: "background",
      schedule: { kind: "after", afterMs: 20 },
      idempotencyKey: key,
    }, context);

    const first = await oneOff("first one-off", "conversations:one-off-1");
    await harness.waitForTask(first.timerTaskId, context);
    const [admitted] = await readJobs(harness, origin.id);
    const firstTask = admitted.executionTaskId;
    // The first run holds the catch-all conversation open: this is a real request, not a race.
    await firstStarted;

    const second = await oneOff("second one-off", "conversations:one-off-2");
    await harness.waitForTask(second.timerTaskId, context);
    const queuedWatcher = changeWatcher(harness, (changes) => changes.some((change) => {
      if (change.type !== "document" || change.record.kind !== CRON_JOBS_KIND
        || change.conversationId !== origin.id || change.value === null) return false;
      return Array.isArray(change.value.oneOffQueue) && change.value.oneOffQueue.length === 2;
    }), "the second one-off run to be queued");
    let queued;
    try {
      queued = await queuedWatcher.promise;
    } finally {
      queuedWatcher.stop();
    }
    const doc = queued.changes.find((change) =>
      change.type === "document" && change.record.kind === CRON_JOBS_KIND)?.value;
    const jobs = doc.jobs;
    const automationId = doc.oneOffConversationId;
    assert.equal(typeof automationId, "number", "the catch-all conversation exists");
    assert.deepEqual(doc.oneOffQueue.map((entry) => entry.jobId), [first.jobId, second.jobId],
      "the queue keeps admission order");
    const secondJob = jobs.find((job) => job.id === second.jobId);
    const secondTask = await harness.getTask(secondJob.executionTaskId, context);
    assert.equal(secondTask.state.status, "waiting", "a queued one-off run holds no invocation");
    const views = await foundation.list(harness, origin.id, owner, context);
    assert.equal(views.find((view) => view.job.id === second.jobId).status, "queued");

    // Cancelling a queued run removes it from the durable queue and retires nothing else.
    const cancelled = await foundation.cancel(harness, origin.id, second.jobId, owner, context);
    assert.equal(cancelled.status, "cancelled");
    const afterCancel = await readDoc(harness, origin.id);
    assert.deepEqual(afterCancel.oneOffQueue.map((entry) => entry.jobId), [first.jobId]);
    assert.equal((await harness.getTask(secondJob.executionTaskId, context)).state.status, "terminal");

    releaseFirst();
    await harness.waitForTask(firstTask, context);
    const [firstSettled] = await readJobs(harness, origin.id);
    assert.equal(firstSettled.lastOutcome.status, "ok");
    assert.equal(firstSettled.lastOutcome.conversationId, automationId);
    assert.equal(await harness.snapshot(ConfigToolCaptureDoc, automationId, context), undefined,
      "the settled run left no captured authority in the persistent conversation");

    // A later one-off reuses the same catch-all conversation, with its own episode.
    const third = await oneOff("third one-off", "conversations:one-off-3");
    await harness.waitForTask(third.timerTaskId, context);
    const thirdRun = (await readJobs(harness, origin.id)).find((job) => job.id === third.jobId);
    await harness.waitForTask(thirdRun.executionTaskId, context);
    const [settled] = await readJobs(harness, origin.id);
    assert.equal(settled.lastOutcome.status, "ok");
    assert.equal(settled.lastOutcome.conversationId, automationId);
    assert.deepEqual((await readDoc(harness, origin.id)).oneOffQueue, [], "finished runs leave the queue");

    const marker = await harness.snapshot(CronConversationDoc, automationId, context);
    assert.equal(marker.conversationClass, "one-off");
    assert.equal(marker.originConversationId, origin.id);
    assert.equal(marker.jobId, null);
    assert.deepEqual(seams.resets, [automationId, automationId]);
    const conversation = await harness.conversation(automationId, context);
    const page = await conversation.entries({ order: "ascending" }, 100, undefined, context);
    assert.deepEqual(transcriptKinds(page), [
      "pi.reset", CRON_INPUT_ENTRY_KIND, "pi.assistant",
      "pi.reset", CRON_INPUT_ENTRY_KIND, "pi.assistant",
    ], "two executed occurrences, two episodes, one conversation");
  } finally {
    harnessRef.current = undefined;
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("a scheduled run's conversation is automation, not chat, and keeps no authority", { timeout: 25_000 }, async () => {
  const directory = await temp("nanobot-cron-conversations-gateway-");
  try {
    const workspace = resolve(directory, "workspace");
    await mkdir(workspace);
    const providerId = "cron-conversations-gateway-faux";
    const model = { provider: providerId, modelId: "synthetic" };
    const { openGateway } = await load(`${pkg}/dist/runtime.js`);
    const { parseConfig } = await load(`${pkg}/dist/config.js`);
    const config = parseConfig({
      workspace,
      dataDir: resolve(directory, "state"),
      model,
      allowedModels: [model],
      toolAllowlist: ["read"],
      cron: { enabled: true, timeZone: "UTC" },
    }, directory);
    const provider = fauxProvider({ provider: providerId, models: [{ id: "synthetic", name: "Synthetic" }] });
    let toolCallIssued = false;
    provider.setResponses(Array.from({ length: 8 }, () => (transcript) => {
      const input = userTexts(transcript.messages)[0];
      if (input === "one-off reminder") return fauxAssistantMessage("ONE-OFF-ANSWER");
      if (input === "remind me once" && !toolCallIssued) {
        toolCallIssued = true;
        return fauxAssistantMessage([
          fauxToolCall("cron", {
            action: "add",
            message: "one-off reminder",
            after_seconds: 1,
          }, { id: "cron-conversations-add" }),
        ], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("Scheduled the one-off reminder.");
    }));
    const models = createModels();
    models.setProvider(provider.provider);
    const gateway = await openGateway(config, context, { models });
    try {
      const sessionKey = "cron-conversations:chat";
      const chat = await gateway.conversationFor(sessionKey, context);
      // Armed before the reset commits: cataloguing is scheduled from that same commit's publication.
      const catalogWatcher = changeWatcher(gateway.harness, (changes) => changes.some((change) =>
        change.type === "document" && change.record.kind === EPISODE_CATALOG_KIND
        && change.conversationId !== chat.id && change.value !== null), "the automation episode catalog");
      const settledWatcher = changeWatcher(gateway.harness, (changes) => changes.some((change) => {
        if (change.type !== "document" || change.record.kind !== CRON_JOBS_KIND
          || change.conversationId !== chat.id || change.value === null) return false;
        return Array.isArray(change.value.jobs)
          && change.value.jobs.some((job) => job.lastOutcome !== null);
      }), "the scheduled run to settle");
      try {
        const submission = await chat.submit(
          { type: "input", content: "remind me once", requestId: "cron-conversations-request" },
          context,
        );
        assert.equal((await submission.wait(context)).status, "done");
        const publication = await settledWatcher.promise;
        const doc = publication.changes.find((change) =>
          change.type === "document" && change.record.kind === CRON_JOBS_KIND)?.value;
        const job = doc.jobs[0];
        const automationId = job.lastOutcome.conversationId;
        assert.equal(typeof automationId, "number");
        assert.equal(doc.oneOffConversationId, automationId);
        assert.equal(job.lastOutcome.status, "ok");

        // The conversation carries its own durable class and no run authority between runs.
        const marker = await gateway.harness.snapshot(CronConversationDoc, automationId, context);
        assert.equal(marker.conversationClass, "one-off");
        assert.equal(marker.originConversationId, chat.id);
        assert.equal(await gateway.harness.snapshot(ConfigToolCaptureDoc, automationId, context), undefined);
        assert.deepEqual((await gateway.harness.snapshot(AgentDoc, automationId, context)).tools, []);

        // It is not a chat session: a forged mapping to it is refused by the mapped-chat rule.
        const forgedKey = "cron-conversations:forged";
        const SessionMap = defineDoc({
          kind: "nanobot.session-map",
          version: 1,
          scope: "conversation",
          history: "latest",
          fork: "initial",
          initial: () => ({ sessions: {} }),
          checkpointWhen: () => true,
        });
        await gateway.harness.commit(async (tx) => {
          const map = await tx.doc(SessionMap, ROOT_CONVERSATION_ID);
          map.sessions[`k:${Buffer.from(forgedKey, "utf8").toString("base64url")}`] = automationId;
        }, context);
        await assert.rejects(
          () => gateway.historyEntries(forgedKey, {}, 10, undefined, context),
          /automation conversation/,
          "a mapped automation conversation is rejected, not read as chat",
        );
        await assert.rejects(
          () => gateway.listHistoryEpisodes(forgedKey, {}, context),
          /automation conversation/,
        );

        // It does participate in episode cataloguing: a reset scheduled that pass.
        const catalogPublication = await catalogWatcher.promise;
        assert.equal(
          catalogPublication.changes.some((change) => change.type === "document"
            && change.record.kind === EPISODE_CATALOG_KIND && change.conversationId === automationId),
          true,
        );
      } finally {
        settledWatcher.stop();
        catalogWatcher.stop();
      }
    } finally {
      await gateway.close(context);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
