// The cron conversation model: a conversation is ongoing activity and an episode is one execution.
// A recurring job keeps one automation conversation across its runs, one-off jobs share a per-origin
// catch-all conversation and queue on it durably, every background run starts with a native reset
// boundary so earlier episodes stay stored but out of the model context, and each run prepares and
// retires its own authority. Origin mode keeps running in the chat itself.
//
// The foundation cases drive the foundation directly with a faux provider and real task waits; the
// gateway cases drive the real Gateway and assert the automation class, authority retirement, the
// mapped chat rule, per-run workspace context, the per-run recall/MCP capture and episode cataloguing.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { scheduledContent } from "./fixtures/cron-input.mjs";

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
const { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } = await load(
  `${ai}/index.js`,
);
const { ToolResultEntry } = await load(`${durable}/index.js`);
const { mcpToolNames } = await load(`${pkg}/dist/mcp/index.js`);
const MCP_FIXTURE = resolve(import.meta.dirname, "fixtures/mcp-stdio-server.mjs");
const { getCurrentSystemPrompt } = await load(`${ai}/utils/transcript.js`);
const context = BACKGROUND_CONTEXT;

const MODEL = { id: "synthetic", name: "Synthetic" };
/** The stored session map, as the gateway's own doc kind, for seeding a forged mapping. */
const SessionMap = defineDoc({
  kind: "nanobot.session-map",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ sessions: {} }),
  checkpointWhen: () => true,
});
/** The stored key for one session key, as the gateway encodes it. */
const mappedKey = (sessionKey) => `k:${Buffer.from(sessionKey, "utf8").toString("base64url")}`;
const ONE_OFF_QUEUE_FULL_TEXT =
  "one-off run queue is full (16 admitted runs); this occurrence was not run";
const ONE_OFF_QUEUE_MALFORMED_TEXT = "one-off run queue is malformed; this occurrence was not run";

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
  const unsubscribe = harness.observeCommits({ advance: (publication) => {
    try {
      if (predicate(publication.changes)) settle.resolve(publication);
    } catch (error) {
      settle.reject(error);
    }
  }, end: () => {} })
  return {
    promise,
    stop() {
      settled = true;
      clearTimeout(timer);
      unsubscribe.detach();
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
  const prepared = [];
  return {
    resets,
    prepared,
    prepare: async ({ tx, originConversationId, targetConversationId }) => {
      prepared.push({ originConversationId, targetConversationId });
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

/** The tools one conversation's agent offers, by registration name. */
const offeredToolNames = (agent) => (agent.tools ?? [])
  .map((tool) => (typeof tool === "string" ? tool : tool.name));

/** Every committed tool result of one conversation, keyed by the model's tool-call ID. */
async function toolResults(conversation) {
  const items = (await conversation.entries({}, 500, undefined, context)).items;
  return items.filter(ToolResultEntry.is).map((entry) => {
    const message = entry.model?.[0];
    return {
      id: message?.toolCallId,
      name: message?.toolName,
      isError: message?.isError === true,
      text: (message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("\n"),
    };
  });
}

/**
 * One isolated store: a faux provider, the host seams above, the cron foundation and an ownerless
 * origin conversation. `script` is the provider's response list; every request's user texts are
 * recorded in `requests` before the responder runs. Always `close()` in a `finally`.
 */
async function openScenario(prefix, script) {
  const dir = await temp(`nanobot-cron-conversations-${prefix}-`);
  const providerId = `cron-conversations-${prefix}`;
  const provider = fauxProvider({ provider: providerId, models: [MODEL] });
  const requests = [];
  provider.setResponses(script.map((respond) => (transcript) => {
    requests.push(userTexts(transcript.messages));
    return respond(transcript);
  }));
  const models = createModels();
  models.setProvider(provider.provider);
  const harnessRef = { current: undefined };
  const seams = hostSeams(harnessRef);
  const foundation = createCronFoundation({
    now: () => Date.now(),
    prepare: seams.prepare,
    finalize: seams.finalize,
    reset: seams.reset,
  });
  const harness = await openHarness(resolve(dir, "probe.sqlite"), foundation.extension, models);
  harnessRef.current = harness;
  harness.resume();
  // Create the root conversation up front, as the gateway does, so the root's own ID is a real
  // conversation rather than a reserved number this store has never stored.
  await harness.root(context, {});
  const origin = await harness.createConversation({
    ownership: { kind: "ownerless" },
    agent: { model: { provider: providerId, modelId: "synthetic" }, tools: [], modelTools: [] },
  }, context);
  const writer = conversationWriter(harness, origin);
  return {
    dir, harness, origin, foundation, seams, requests,
    schedule: (job) => foundation.schedule(owner, writer, job, context),
    oneOff: (message, key, options = {}) => foundation.schedule(owner, writer, {
      message,
      name: message,
      mode: "background",
      schedule: { kind: "after", afterMs: 200 },
      idempotencyKey: key,
      ...options,
    }, context),
    async close() {
      harnessRef.current = undefined;
      await harness.close(context).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Settle one one-off job's admitted run and return the stored job record. */
async function settledOneOff(scenario, jobId) {
  const admitted = (await readJobs(scenario.harness, scenario.origin.id)).find((job) => job.id === jobId);
  await scenario.harness.waitForTask(admitted.executionTaskId, context);
  return (await readJobs(scenario.harness, scenario.origin.id)).find((job) => job.id === jobId);
}

/**
 * Wait for one commit of the origin's job document whose one-off queue satisfies `predicate`, and
 * return that committed document. It is armed before the event, so nothing is missed by polling.
 */
async function waitForQueue(harness, conversationId, predicate, label) {
  const watcher = changeWatcher(harness, (changes) => changes.some((change) => {
    if (change.type !== "document" || change.record.kind !== CRON_JOBS_KIND
      || change.conversationId !== conversationId || change.value === null) return false;
    return Array.isArray(change.value.oneOffQueue) && predicate(change.value.oneOffQueue);
  }), label);
  try {
    const publication = await watcher.promise;
    return publication.changes.find((change) =>
      change.type === "document" && change.record.kind === CRON_JOBS_KIND)?.value;
  } finally {
    watcher.stop();
  }
}

const countConversations = async (scenario) =>
  (await scenario.harness.commit((tx) => tx.scanConversations({}, 100), context)).items.length;

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
    assert.deepEqual(requests[1], [scheduledContent("stretch every interval")]);

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
  // Released in the finally so a failed assertion cannot turn into a 20 s timeout.
  let releaseFirst = () => {};
  try {
    const providerId = "cron-conversations-one-off-faux";
    const provider = fauxProvider({ provider: providerId, models: [MODEL] });
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
    releaseFirst();
    harnessRef.current = undefined;
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("a queued one-off wakes when its head finishes and runs in its own episode", { timeout: 20_000 }, async () => {
  let release = () => {};
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  let firstStarted = () => {};
  const started = new Promise((resolveStarted) => { firstStarted = resolveStarted; });
  const scenario = await openScenario("queued-wake", [
    async () => {
      firstStarted();
      await gate;
      return fauxAssistantMessage("head answered");
    },
    () => fauxAssistantMessage("queued answered"),
  ]);
  try {
    const head = await scenario.oneOff("head one-off", "queued-wake-1");
    await scenario.harness.waitForTask(head.timerTaskId, context);
    const [headJob] = await readJobs(scenario.harness, scenario.origin.id);
    await started;

    const queued = await scenario.oneOff("queued one-off", "queued-wake-2");
    const queuedDoc = await waitForQueue(scenario.harness, scenario.origin.id, (queue) => queue.length === 2,
      "the queued one-off to be admitted");
    await scenario.harness.waitForTask(queued.timerTaskId, context);
    const queuedJob = queuedDoc.jobs.find((job) => job.id === queued.jobId);
    assert.equal((await scenario.harness.getTask(queuedJob.executionTaskId, context)).state.status, "waiting");

    release();
    await scenario.harness.waitForTask(headJob.executionTaskId, context);
    // The queued run wakes on the head's terminal commit and executes in the same conversation.
    await scenario.harness.waitForTask(queuedJob.executionTaskId, context);
    const doc = await readDoc(scenario.harness, scenario.origin.id);
    assert.deepEqual(doc.oneOffQueue, [], "both admitted runs left the queue");
    const automationId = doc.oneOffConversationId;
    assert.equal(typeof automationId, "number", "both runs used the catch-all conversation");
    for (const job of doc.jobs) {
      assert.equal(job.lastOutcome.status, "ok");
      assert.equal(job.lastOutcome.conversationId, automationId);
    }
    assert.deepEqual(
      scenario.requests.map((texts) => texts[0]),
      [scheduledContent("head one-off"), scheduledContent("queued one-off")],
      "the occurrence order is the queue's durable order");
    const conversation = await scenario.harness.conversation(automationId, context);
    const page = await conversation.entries({ order: "ascending" }, 100, undefined, context);
    assert.deepEqual(transcriptKinds(page), [
      "pi.reset", CRON_INPUT_ENTRY_KIND, "pi.assistant",
      "pi.reset", CRON_INPUT_ENTRY_KIND, "pi.assistant",
    ], "each executed occurrence is its own episode");
  } finally {
    release();
    await scenario.close();
  }
});

test("a waiting one-off creates and records no catch-all conversation", { timeout: 20_000 }, async () => {
  // The window two same-tick claims can leave behind: this origin's document has never recorded a
  // catch-all conversation, while the queue already holds a live head ahead of this occurrence. A
  // waiting run needs no target, so it must create and record nothing and prepare nothing; a
  // conversation created here would split the one-catch-all-per-origin identity.
  const scenario = await openScenario("waiting-creates-nothing", []);
  try {
    // A live task that is not a run: the far-future one-off's own timer task. The claim phase only
    // checks that an entry's task is non-terminal, so it holds the queue exactly as a live head run
    // does, without that head ever having recorded a conversation.
    const head = await scenario.schedule({
      message: "the head never runs",
      name: "the head never runs",
      mode: "background",
      schedule: { kind: "at", at: Date.now() + 3_600_000 },
      idempotencyKey: "waiting-creates-nothing-head",
    });
    const [headJob] = await readJobs(scenario.harness, scenario.origin.id);
    assert.notEqual((await scenario.harness.getTask(headJob.timerTaskId, context)).state.status, "terminal",
      "the queue entry names a live task");
    await scenario.harness.commit(async (tx) => {
      const doc = await tx.doc(CronJobsDoc, scenario.origin.id);
      doc.oneOffQueue = [{ jobId: head.jobId, scheduledAtMs: 0, taskId: Number(headJob.timerTaskId) }];
    }, context);
    assert.equal((await readDoc(scenario.harness, scenario.origin.id)).oneOffConversationId, undefined);
    const before = await countConversations(scenario);

    const queued = await scenario.oneOff("queued one-off", "waiting-creates-nothing-queued");
    const doc = await waitForQueue(scenario.harness, scenario.origin.id, (queue) => queue.length === 2,
      "the queued one-off to be admitted behind the live head");
    assert.deepEqual(doc.oneOffQueue.map((entry) => entry.jobId), [head.jobId, queued.jobId]);
    const queuedJob = doc.jobs.find((job) => job.id === queued.jobId);
    assert.equal((await scenario.harness.getTask(queuedJob.executionTaskId, context)).state.status, "waiting",
      "the occurrence waits instead of running");
    assert.equal(doc.oneOffConversationId, undefined,
      "a waiting run neither creates nor records a catch-all conversation");
    assert.equal(await countConversations(scenario), before, "no conversation was created for it");
    assert.deepEqual(scenario.seams.prepared, [], "a waiting run prepares no authority or context");
    assert.deepEqual(scenario.seams.resets, []);
  } finally {
    await scenario.close();
  }
});

test("cancelling a head one-off lets the queued occurrence proceed", { timeout: 20_000 }, async () => {
  let release = () => {};
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  let firstStarted = () => {};
  const started = new Promise((resolveStarted) => { firstStarted = resolveStarted; });
  const scenario = await openScenario("cancelled-head", [
    async () => {
      firstStarted();
      await gate;
      return fauxAssistantMessage("head answered");
    },
    () => fauxAssistantMessage("queued answered"),
  ]);
  try {
    const head = await scenario.oneOff("head one-off", "cancelled-head-1");
    await scenario.harness.waitForTask(head.timerTaskId, context);
    const [headJob] = await readJobs(scenario.harness, scenario.origin.id);
    await started;

    const next = await scenario.oneOff("queued one-off", "cancelled-head-2");
    const nextDoc = await waitForQueue(scenario.harness, scenario.origin.id, (queue) => queue.length === 2,
      "the next one-off to be queued");
    await scenario.harness.waitForTask(next.timerTaskId, context);
    const nextJob = nextDoc.jobs.find((job) => job.id === next.jobId);
    assert.equal((await scenario.harness.getTask(nextJob.executionTaskId, context)).state.status, "waiting");

    // Cancel the head while the next occurrence waits behind it. Releasing the blocked response lets
    // the bounded conversation abort land instead of waiting out its full 5 s bound.
    const cancelling = scenario.foundation.cancel(
      scenario.harness, scenario.origin.id, head.jobId, owner, context,
    );
    release();
    assert.equal((await cancelling).status, "cancelled");
    await scenario.harness.waitForTask(nextJob.executionTaskId, context);

    const doc = await readDoc(scenario.harness, scenario.origin.id);
    assert.deepEqual(doc.oneOffQueue, [], "the cancelled head left the queue and the next run finished");
    assert.notEqual(doc.jobs.find((job) => job.id === head.jobId).cancelledAtMs, null);
    assert.equal(doc.jobs.find((job) => job.id === next.jobId).lastOutcome.status, "ok");
    const page = await (await scenario.harness.conversation(doc.oneOffConversationId, context))
      .entries({ order: "ascending" }, 100, undefined, context);
    assert.equal(page.items.some((entry) => entry.kind === CRON_INPUT_ENTRY_KIND), true,
      "the shared conversation and its entries stay");
  } finally {
    release();
    await scenario.close();
  }
});

test("a full one-off queue refuses the occurrence visibly and touches no conversation", { timeout: 20_000 }, async () => {
  const scenario = await openScenario("queue-full", [() => fauxAssistantMessage("unused answer")]);
  try {
    const conversationsBefore = await countConversations(scenario);
    // Sixteen live entries is the bound. A one-shot timer far in the future is a live task, so it
    // stands in for sixteen admitted runs and nothing here executes.
    const holder = await scenario.schedule({
      message: "hold the queue",
      name: "hold",
      schedule: { kind: "at", at: Date.now() + 3_600_000 },
      idempotencyKey: "queue-full-hold",
    });
    assert.notEqual(holder.timerTaskId, null);
    await scenario.harness.commit(async (tx) => {
      const doc = await tx.doc(CronJobsDoc, scenario.origin.id);
      doc.oneOffQueue = Array.from({ length: 16 }, (_, index) => ({
        jobId: `held-${index}`,
        scheduledAtMs: Date.now(),
        taskId: holder.timerTaskId,
      }));
    }, context);

    const refused = await scenario.oneOff("refused one-off", "queue-full-run");
    await scenario.harness.waitForTask(refused.timerTaskId, context);
    const stored = await settledOneOff(scenario, refused.jobId);
    assert.equal(stored.lastOutcome.status, "error");
    assert.equal(stored.lastOutcome.error, ONE_OFF_QUEUE_FULL_TEXT);
    const doc = await readDoc(scenario.harness, scenario.origin.id);
    assert.equal(doc.oneOffConversationId, undefined, "a refused occurrence creates no conversation");
    assert.equal(doc.oneOffQueue.length, 16, "a refused occurrence adds no queue entry");
    assert.equal(await countConversations(scenario), conversationsBefore, "no conversation was created");
    assert.deepEqual(scenario.seams.resets, [], "a refused occurrence places no boundary");
    await scenario.foundation.cancel(scenario.harness, scenario.origin.id, holder.jobId, owner, context);
  } finally {
    await scenario.close();
  }
});

test("a malformed one-off queue refuses the occurrence instead of faulting its run", { timeout: 20_000 }, async () => {
  const scenario = await openScenario("queue-malformed", [() => fauxAssistantMessage("unused answer")]);
  try {
    await scenario.harness.commit(async (tx) => {
      const doc = await tx.doc(CronJobsDoc, scenario.origin.id);
      doc.oneOffQueue = "not-an-array";
    }, context);
    const refused = await scenario.oneOff("malformed queue one-off", "queue-malformed-run");
    await scenario.harness.waitForTask(refused.timerTaskId, context);
    const admitted = (await readJobs(scenario.harness, scenario.origin.id))
      .find((job) => job.id === refused.jobId);
    const outcome = await scenario.harness.waitForTask(admitted.executionTaskId, context);
    assert.equal(outcome.state.outcome.status, "completed", "the occurrence is refused, not faulted");
    const stored = (await readJobs(scenario.harness, scenario.origin.id))
      .find((job) => job.id === refused.jobId);
    assert.equal(stored.lastOutcome.status, "error");
    assert.equal(stored.lastOutcome.error, ONE_OFF_QUEUE_MALFORMED_TEXT);
    const doc = await readDoc(scenario.harness, scenario.origin.id);
    assert.equal(doc.oneOffQueue, "not-an-array", "a malformed queue is never guessed at or rewritten");
    assert.equal(doc.oneOffConversationId, undefined);
  } finally {
    await scenario.close();
  }
});

test("a recorded conversation is adopted only when its own marker names this job", { timeout: 20_000 }, async () => {
  const scenario = await openScenario("adoption", Array.from({ length: 5 }, () => () => fauxAssistantMessage("adopted answered")));
  try {
    // A chat-like ownerless conversation: unforked and not the origin, so only its own class marker
    // can keep it out of the automation class.
    const bystander = await scenario.harness.createConversation({
      ownership: { kind: "ownerless" },
      agent: { tools: [{ name: "read" }], modelTools: [{ name: "read" }] },
    }, context);
    const bystanderAgent = await scenario.harness.snapshot(AgentDoc, bystander.id, context);
    const damaged = await scenario.oneOff("damaged pointer", "adoption-damaged", { schedule: { kind: "after", afterMs: 400 } });
    await scenario.harness.commit(async (tx) => {
      const doc = await tx.doc(CronJobsDoc, scenario.origin.id);
      doc.oneOffConversationId = bystander.id;
    }, context);
    await scenario.harness.waitForTask(damaged.timerTaskId, context);
    const stored = await settledOneOff(scenario, damaged.jobId);
    assert.equal(stored.lastOutcome.status, "ok");
    const created = (await readDoc(scenario.harness, scenario.origin.id)).oneOffConversationId;
    assert.equal(typeof created, "number");
    assert.notEqual(created, bystander.id, "an unmarked conversation is never adopted");
    assert.equal(stored.lastOutcome.conversationId, created);
    assert.equal(await scenario.harness.snapshot(CronConversationDoc, bystander.id, context), undefined,
      "the conversation the damaged pointer named keeps no automation marker");
    assert.deepEqual((await scenario.harness.snapshot(AgentDoc, bystander.id, context)).tools, bystanderAgent.tools,
      "its agent authority is untouched");
    assert.equal((await scenario.harness.commit((tx) => tx.scanEntries({ conversationId: bystander.id }, 10), context)).items.length, 0,
      "the conversation the damaged pointer named received nothing");

    // The root is ownerless and unforked too, so it needs the same guard.
    const rooted = await scenario.oneOff("root pointer", "adoption-root", { schedule: { kind: "after", afterMs: 400 } });
    await scenario.harness.commit(async (tx) => {
      const doc = await tx.doc(CronJobsDoc, scenario.origin.id);
      doc.oneOffConversationId = ROOT_CONVERSATION_ID;
    }, context);
    await scenario.harness.waitForTask(rooted.timerTaskId, context);
    const rootStored = await settledOneOff(scenario, rooted.jobId);
    assert.equal(rootStored.lastOutcome.status, "ok");
    const replacement = (await readDoc(scenario.harness, scenario.origin.id)).oneOffConversationId;
    assert.equal(typeof replacement, "number");
    assert.notEqual(replacement, ROOT_CONVERSATION_ID, "the root is never adopted");
    assert.equal(await scenario.harness.snapshot(CronConversationDoc, ROOT_CONVERSATION_ID, context), undefined);
    assert.equal((await scenario.harness.commit((tx) => tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 10), context)).items.length, 0,
      "the root received no marker, boundary or input");

    // A pointer to another origin's conversation for another job: the marker names something else, so
    // this job records a fresh conversation and leaves that marker and its transcript alone.
    const otherOrigin = await scenario.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const foreign = await scenario.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await scenario.harness.commit(async (tx) => {
      const marker = await tx.doc(CronConversationDoc, foreign.id);
      marker.conversationClass = "recurring";
      marker.originConversationId = otherOrigin.id;
      marker.jobId = "another-job";
    }, context);
    const misdirected = await scenario.oneOff("foreign pointer", "adoption-foreign", { schedule: { kind: "after", afterMs: 400 } });
    await scenario.harness.commit(async (tx) => {
      const doc = await tx.doc(CronJobsDoc, scenario.origin.id);
      doc.oneOffConversationId = foreign.id;
    }, context);
    await scenario.harness.waitForTask(misdirected.timerTaskId, context);
    const foreignStored = await settledOneOff(scenario, misdirected.jobId);
    assert.equal(foreignStored.lastOutcome.status, "ok");
    assert.notEqual((await readDoc(scenario.harness, scenario.origin.id)).oneOffConversationId, foreign.id,
      "another origin and job's conversation is never adopted");
    const foreignMarker = await scenario.harness.snapshot(CronConversationDoc, foreign.id, context);
    assert.equal(foreignMarker.originConversationId, otherOrigin.id,
      "the misdirected conversation keeps its own marker");
    assert.equal(foreignMarker.jobId, "another-job");
    assert.equal((await scenario.harness.commit((tx) => tx.scanEntries({ conversationId: foreign.id }, 10), context)).items.length, 0,
      "it received no boundary and no input");
  } finally {
    await scenario.close();
  }
});

test("a boundary already at the end of the conversation is not placed twice", { timeout: 20_000 }, async () => {
  const scenario = await openScenario("boundary", [() => fauxAssistantMessage("boundary answered")]);
  try {
    // The catch-all conversation, its class marker and a boundary already as the newest entry: this
    // is exactly the durable state a retry after a crash between `reset(...)` and `submit(...)` sees.
    const automation = await scenario.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await scenario.harness.commit(async (tx) => {
      const marker = await tx.doc(CronConversationDoc, automation.id);
      marker.conversationClass = "one-off";
      marker.originConversationId = scenario.origin.id;
      marker.jobId = null;
      const doc = await tx.doc(CronJobsDoc, scenario.origin.id);
      doc.oneOffConversationId = automation.id;
    }, context);
    await (await scenario.harness.conversation(automation.id, context)).reset(undefined, context);

    const run = await scenario.oneOff("boundary one-off", "boundary-run");
    await scenario.harness.waitForTask(run.timerTaskId, context);
    const stored = await settledOneOff(scenario, run.jobId);
    assert.equal(stored.lastOutcome.status, "ok");
    assert.equal(stored.lastOutcome.conversationId, automation.id, "the marked conversation was adopted");
    assert.deepEqual(scenario.seams.resets, [], "the run placed no second boundary");
    const page = await (await scenario.harness.conversation(automation.id, context))
      .entries({ order: "ascending" }, 100, undefined, context);
    assert.deepEqual(transcriptKinds(page), ["pi.reset", CRON_INPUT_ENTRY_KIND, "pi.assistant"]);
    assert.deepEqual(scenario.requests[0], [scheduledContent("boundary one-off")],
      "the already-placed boundary starts the episode with an empty context");
  } finally {
    await scenario.close();
  }
});

test("origin mode runs in the chat with no new conversation and no cron boundary", { timeout: 20_000 }, async () => {
  const scenario = await openScenario("origin-mode", [() => fauxAssistantMessage("origin answered")]);
  try {
    const conversationsBefore = await countConversations(scenario);
    const receipt = await scenario.oneOff("origin one-off", "origin-mode-run", { mode: "origin" });
    await scenario.harness.waitForTask(receipt.timerTaskId, context);
    const stored = await settledOneOff(scenario, receipt.jobId);
    assert.equal(stored.lastOutcome.status, "ok");
    assert.equal(stored.lastOutcome.conversationId, scenario.origin.id, "the occurrence ran in the chat itself");
    assert.equal(stored.conversationId, undefined, "origin mode records no conversation for its job");
    const doc = await readDoc(scenario.harness, scenario.origin.id);
    assert.equal(doc.oneOffConversationId, undefined, "origin mode creates no catch-all conversation");
    assert.equal(await countConversations(scenario), conversationsBefore, "no conversation was created");
    assert.deepEqual(scenario.seams.resets, [], "origin mode places no cron boundary");
    const page = await (await scenario.harness.conversation(scenario.origin.id, context))
      .entries({ order: "ascending" }, 100, undefined, context);
    assert.deepEqual(transcriptKinds(page), [CRON_INPUT_ENTRY_KIND, "pi.assistant"],
      "the chat itself holds the occurrence and its answer");
  } finally {
    await scenario.close();
  }
});

test("a fenced one-off claim removes its queued entry", { timeout: 20_000 }, async () => {
  let release = () => {};
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  let firstStarted = () => {};
  const started = new Promise((resolveStarted) => { firstStarted = resolveStarted; });
  const scenario = await openScenario("fenced-claim", [
    async () => {
      firstStarted();
      await gate;
      return fauxAssistantMessage("head answered");
    },
    () => fauxAssistantMessage("unused answer"),
  ]);
  try {
    const head = await scenario.oneOff("head one-off", "fenced-claim-1");
    await scenario.harness.waitForTask(head.timerTaskId, context);
    const [headJob] = await readJobs(scenario.harness, scenario.origin.id);
    await started;

    const next = await scenario.oneOff("fenced one-off", "fenced-claim-2");
    const nextDoc = await waitForQueue(scenario.harness, scenario.origin.id, (queue) => queue.length === 2,
      "the fenced one-off to be queued");
    await scenario.harness.waitForTask(next.timerTaskId, context);
    const nextJob = nextDoc.jobs.find((job) => job.id === next.jobId);
    // A cancellation recorded while the gateway was down: the generation moved on but the queued run
    // task was never aborted, so it re-claims on reopen and is fenced out there.
    await scenario.harness.commit(async (tx) => {
      const doc = await tx.doc(CronJobsDoc, scenario.origin.id);
      doc.jobs.find((job) => job.id === next.jobId).generation += 1;
    }, context);

    release();
    await scenario.harness.waitForTask(headJob.executionTaskId, context);
    const outcome = await scenario.harness.waitForTask(nextJob.executionTaskId, context);
    assert.equal(outcome.state.outcome.status, "aborted");
    assert.equal(outcome.state.outcome.result.outcome, "superseded");
    const doc = await readDoc(scenario.harness, scenario.origin.id);
    assert.deepEqual(doc.oneOffQueue, [], "a fenced claim leaves no stale queue entry");
    assert.equal(doc.jobs.find((job) => job.id === next.jobId).lastOutcome, null,
      "a fenced run records no outcome");
  } finally {
    release();
    await scenario.close();
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
      if (input === scheduledContent("one-off reminder")) return fauxAssistantMessage("ONE-OFF-ANSWER");
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
        await gateway.harness.commit(async (tx) => {
          const map = await tx.doc(SessionMap, ROOT_CONVERSATION_ID);
          map.sessions[mappedKey(forgedKey)] = automationId;
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
        // Channel ingress refuses the same mapping before it can become a cron owner or receive
        // chat policy, so a forged or stale map entry can never schedule from an automation
        // conversation or take a live run's captured tools away through the policy pass.
        await assert.rejects(
          () => gateway.conversationFor(forgedKey, context),
          /automation conversation/,
          "a forged mapping is refused on the channel ingress path too",
        );
        // The forged mapping refuses, but the real chat keeps its own conversation and authority.
        const stillChat = await gateway.conversationFor(sessionKey, context);
        assert.equal(stillChat.id, chat.id);
        assert.equal((await stillChat.agent(context)).tools.some((tool) => tool.name === "read"), true);

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

test("a mapping forged before the gateway opens is still automation, not chat", { timeout: 30_000 }, async () => {
  // The threat model is a persisted map, not a live process: a forged or stale entry written by an
  // older layout is read by the *next* open, so the class has to be restored before the mapped-chat
  // authority pass runs. Before that order was fixed, the reopened gateway admitted the automation
  // conversation as a chat and could never reclassify it for the life of the process.
  const directory = await temp("nanobot-cron-conversations-reopen-");
  try {
    const workspace = resolve(directory, "workspace");
    await mkdir(workspace);
    const providerId = "cron-conversations-reopen-faux";
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
    const provider = fauxProvider({ provider: providerId, models: [MODEL] });
    let toolCallIssued = false;
    provider.setResponses(Array.from({ length: 8 }, () => (transcript) => {
      const input = userTexts(transcript.messages)[0];
      if (input === scheduledContent("one-off reminder")) return fauxAssistantMessage("ONE-OFF-ANSWER");
      if (input === "remind me once" && !toolCallIssued) {
        toolCallIssued = true;
        return fauxAssistantMessage([
          fauxToolCall("cron", {
            action: "add",
            message: "one-off reminder",
            after_seconds: 1,
          }, { id: "cron-conversations-reopen-add" }),
        ], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("Scheduled the one-off reminder.");
    }));
    const models = createModels();
    models.setProvider(provider.provider);
    const sessionKey = "cron-conversations:reopen";
    const forgedKey = "cron-conversations:reopen-forged";
    let automationId;
    let chatId;

    const first = await openGateway(config, context, { models });
    try {
      const chat = await first.conversationFor(sessionKey, context);
      chatId = chat.id;
      const settledWatcher = changeWatcher(first.harness, (changes) => changes.some((change) => {
        if (change.type !== "document" || change.record.kind !== CRON_JOBS_KIND
          || change.conversationId !== chat.id || change.value === null) return false;
        return Array.isArray(change.value.jobs)
          && change.value.jobs.some((job) => job.lastOutcome !== null);
      }), "the scheduled run to settle");
      try {
        const submission = await chat.submit(
          { type: "input", content: "remind me once", requestId: "cron-conversations-reopen-request" },
          context,
        );
        assert.equal((await submission.wait(context)).status, "done");
        const publication = await settledWatcher.promise;
        const doc = publication.changes.find((change) =>
          change.type === "document" && change.record.kind === CRON_JOBS_KIND)?.value;
        automationId = doc.jobs[0].lastOutcome.conversationId;
        assert.equal(typeof automationId, "number");
        assert.equal(doc.oneOffConversationId, automationId);
      } finally {
        settledWatcher.stop();
      }
      // Forged before the next open, which is the only moment that can still choose the class.
      await first.harness.commit(async (tx) => {
        const map = await tx.doc(SessionMap, ROOT_CONVERSATION_ID);
        map.sessions[mappedKey(forgedKey)] = automationId;
      }, context);
    } finally {
      await first.close(context);
    }

    // The provider records the tool names one turn in the automation conversation is offered.
    const offered = [];
    provider.setResponses([
      (transcript) => {
        offered.push(getCurrentTools(transcript.messages).map((tool) => tool.name));
        return fauxAssistantMessage("AUTOMATION-TURN-ANSWER");
      },
    ]);
    const second = await openGateway(config, context, { models });
    try {
      // Every chat surface refuses the mapping in a process that never saw the forge happen.
      await assert.rejects(
        () => second.historyEntries(forgedKey, {}, 10, undefined, context),
        /automation conversation/,
        "a mapping forged before the open is rejected by history reads",
      );
      await assert.rejects(
        () => second.listHistoryEpisodes(forgedKey, {}, context),
        /automation conversation/,
      );
      await assert.rejects(
        () => second.conversationFor(forgedKey, context),
        /automation conversation/,
        "and by the channel ingress path",
      );
      // It is not a cron owner and holds no chat authority between runs.
      const conversation = await second.harness.conversation(automationId, context);
      assert.deepEqual((await conversation.agent(context)).tools, [],
        "a reopened automation conversation keeps no coding, cron or history tool");
      const turn = await conversation.submit(
        { type: "input", content: "automation turn", requestId: "cron-conversations-reopen-turn" },
        context,
      );
      assert.equal((await turn.wait(context)).status, "done");
      assert.deepEqual(offered, [[]], "a turn in it is offered no tool at all, cron included");
      // The real chat key still resolves to its own conversation with its configured authority.
      const chat = await second.conversationFor(sessionKey, context);
      assert.equal(chat.id, chatId);
      const chatTools = (await chat.agent(context)).tools.map((tool) => tool.name);
      assert.equal(chatTools.includes("read"), true);
      assert.equal(chatTools.includes("cron"), true,
        "the mapped chat stays an authenticated cron owner");
    } finally {
      await second.close(context);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a mapping to an automation conversation whose pointer was lost is still automation", { timeout: 30_000 }, async () => {
  // The pointer and the marker record the same fact twice, so losing one of them cannot lose the
  // class. A damaged write, a hand-edited document or a store restored from an inconsistent layout
  // can drop `oneOffConversationId` while the conversation keeps its own marker; a stale key naming
  // it must still be refused by the next open instead of being admitted as chat for its lifetime.
  const directory = await temp("nanobot-cron-conversations-lapsed-");
  try {
    const workspace = resolve(directory, "workspace");
    await mkdir(workspace);
    const providerId = "cron-conversations-lapsed-faux";
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
    const provider = fauxProvider({ provider: providerId, models: [MODEL] });
    let toolCallIssued = false;
    provider.setResponses(Array.from({ length: 8 }, () => (transcript) => {
      const input = userTexts(transcript.messages)[0];
      if (input === scheduledContent("one-off reminder")) return fauxAssistantMessage("ONE-OFF-ANSWER");
      if (input === "remind me once" && !toolCallIssued) {
        toolCallIssued = true;
        return fauxAssistantMessage([
          fauxToolCall("cron", {
            action: "add",
            message: "one-off reminder",
            after_seconds: 1,
          }, { id: "cron-conversations-lapsed-add" }),
        ], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("Scheduled the one-off reminder.");
    }));
    const models = createModels();
    models.setProvider(provider.provider);
    const sessionKey = "cron-conversations:lapsed";
    const forgedKey = "cron-conversations:lapsed-forged";
    let automationId;
    let chatId;

    const first = await openGateway(config, context, { models });
    try {
      const chat = await first.conversationFor(sessionKey, context);
      chatId = chat.id;
      const settledWatcher = changeWatcher(first.harness, (changes) => changes.some((change) => {
        if (change.type !== "document" || change.record.kind !== CRON_JOBS_KIND
          || change.conversationId !== chat.id || change.value === null) return false;
        return Array.isArray(change.value.jobs)
          && change.value.jobs.some((job) => job.lastOutcome !== null && job.lastOutcome !== undefined);
      }), "the scheduled run to settle");
      try {
        const submission = await chat.submit(
          { type: "input", content: "remind me once", requestId: "cron-conversations-lapsed-request" },
          context,
        );
        assert.equal((await submission.wait(context)).status, "done");
        await settledWatcher.promise;
      } finally {
        settledWatcher.stop();
      }
      const doc = await readDoc(first.harness, chat.id);
      automationId = doc.oneOffConversationId;
      assert.equal(typeof automationId, "number");
      // The pointer is lost the way document damage loses it; the marker and the stale key stay.
      await first.harness.commit(async (tx) => {
        const damaged = await tx.doc(CronJobsDoc, chat.id);
        damaged.oneOffConversationId = null;
        damaged.jobs = damaged.jobs.map((job) => ({ ...job, conversationId: null }));
        const map = await tx.doc(SessionMap, ROOT_CONVERSATION_ID);
        map.sessions[mappedKey(forgedKey)] = automationId;
      }, context);
      assert.equal((await readDoc(first.harness, chat.id)).oneOffConversationId, null,
        "no committed pointer names the automation conversation any more");
      assert.equal(typeof (await first.harness.snapshot(CronConversationDoc, automationId, context)), "object",
        "the conversation keeps its own class marker");
    } finally {
      await first.close(context);
    }

    const second = await openGateway(config, context, { models });
    try {
      // The marker alone is enough to refuse the mapping on every chat surface.
      await assert.rejects(
        () => second.historyEntries(forgedKey, {}, 10, undefined, context),
        /automation conversation/,
        "history reads refuse the stale mapping even though no document records the conversation",
      );
      await assert.rejects(
        () => second.listHistoryEpisodes(forgedKey, {}, context),
        /automation conversation/,
      );
      await assert.rejects(
        () => second.conversationFor(forgedKey, context),
        /automation conversation/,
        "the channel ingress path refuses it too",
      );
      const conversation = await second.harness.conversation(automationId, context);
      assert.deepEqual((await conversation.agent(context)).tools, [],
        "a reopened automation conversation keeps no coding, cron or history tool");
      // The real chat key still resolves to its own conversation with its configured authority.
      const chat = await second.conversationFor(sessionKey, context);
      assert.equal(chat.id, chatId);
      const chatTools = (await chat.agent(context)).tools.map((tool) => tool.name);
      assert.equal(chatTools.includes("read"), true);
      assert.equal(chatTools.includes("cron"), true,
        "the mapped chat stays an authenticated cron owner");
    } finally {
      await second.close(context);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a mapping to a fork is not restored as a mapped session at open", { timeout: 30_000 }, async () => {
  // The startup pass installs a cron owner and a context snapshot slot for a mapped session. Every
  // other authority pass already refuses the root, a task-owned conversation and a fork, and so does
  // the channel ingress; this pass has to apply the same rule instead of installing the mapping and
  // leaving the cron tool behind on a conversation no chat surface will ever admit.
  const directory = await temp("nanobot-cron-conversations-fork-");
  try {
    const workspace = resolve(directory, "workspace");
    await mkdir(workspace);
    const providerId = "cron-conversations-fork-faux";
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
    const provider = fauxProvider({ provider: providerId, models: [MODEL] });
    provider.setResponses([() => fauxAssistantMessage("FORK-SOURCE-ANSWER")]);
    const models = createModels();
    models.setProvider(provider.provider);
    const sessionKey = "cron-conversations:fork-chat";
    const forgedKey = "cron-conversations:fork-forged";
    const stateKey = "cron-conversations:fork-state:channel-state";
    let chatId;
    let forkId;
    let stateId;

    const first = await openGateway(config, context, { models });
    try {
      const chat = await first.conversationFor(sessionKey, context);
      chatId = chat.id;
      stateId = (await first.conversationFor(stateKey, context)).id;
      const submission = await chat.submit(
        { type: "input", content: "fork me", requestId: "cron-conversations-fork-request" },
        context,
      );
      assert.equal((await submission.wait(context)).status, "done");
      const entries = (await chat.entries({}, 50, undefined, context)).items;
      assert.ok(entries.length > 0, "the mapped chat has an entry to fork at");
      const fork = await chat.fork(
        entries[0].id,
        { ownership: { kind: "ownerless" }, agent: { model } },
        context,
      );
      forkId = fork.id;
      assert.equal(
        (await first.harness.commit((tx) => tx.conversation(forkId), context)).parent !== undefined,
        true,
        "the seeded mapping names a fork",
      );
      // Forged before the next open, which is the only moment that can still choose the class.
      await first.harness.commit(async (tx) => {
        const map = await tx.doc(SessionMap, ROOT_CONVERSATION_ID);
        map.sessions[mappedKey(forgedKey)] = forkId;
      }, context);
    } finally {
      await first.close(context);
    }

    const second = await openGateway(config, context, { models });
    try {
      await assert.rejects(
        () => second.historyEntries(forgedKey, {}, 10, undefined, context),
        /forked conversation/,
        "history reads still refuse the mapping",
      );
      await assert.rejects(
        () => second.conversationFor(forgedKey, context),
        /forked conversation/,
        "and so does the channel ingress path",
      );
      // The startup pass installed no cron owner or tool for it. The coding extension carries no tool
      // either: the fork has no configured authority of its own.
      const forkAgent = await (await second.harness.conversation(forkId, context)).agent(context);
      assert.deepEqual(forkAgent.tools, [], "a reopened fork holds no tool, cron included");
      assert.deepEqual(forkAgent.extensions.filter((extension) => extension.name.startsWith("nanobot.cron")), [],
        "the startup pass selected no cron extension for it");
      // The legitimate mappings keep their current behaviour: the chat is an authenticated cron
      // owner, and a state-only key is still a mapped session.
      const chat = await second.conversationFor(sessionKey, context);
      assert.equal(chat.id, chatId);
      const chatTools = (await chat.agent(context)).tools.map((tool) => tool.name);
      assert.equal(chatTools.includes("read"), true);
      assert.equal(chatTools.includes("cron"), true);
      assert.equal((await second.conversationFor(stateKey, context)).id, stateId,
        "a channel-state key stays a mapped session");
    } finally {
      await second.close(context);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a recurring run rebuilds the origin's workspace context for each episode", { timeout: 25_000 }, async () => {
  const directory = await temp("nanobot-cron-conversations-workspace-");
  try {
    const workspace = resolve(directory, "workspace");
    await mkdir(workspace);
    const providerId = "cron-conversations-workspace-faux";
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
    const provider = fauxProvider({ provider: providerId, models: [MODEL] });
    const prompts = [];
    let toolCallIssued = false;
    provider.setResponses(Array.from({ length: 12 }, () => (transcript) => {
      prompts.push({
        system: getCurrentSystemPrompt(transcript.messages),
        texts: userTexts(transcript.messages),
      });
      const input = userTexts(transcript.messages)[0];
      if (input === "schedule a recurring context check" && !toolCallIssued) {
        toolCallIssued = true;
        return fauxAssistantMessage([
          fauxToolCall("cron", {
            action: "add",
            message: "scheduled context episode",
            every_seconds: 1,
          }, { id: "cron-workspace-add" }),
        ], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("SYNTHETIC-ANSWER");
    }));
    const models = createModels();
    models.setProvider(provider.provider);
    // Every call returns a new token, so a snapshot reused from an earlier run is visible in the
    // rendered context instead of being indistinguishable from a fresh one.
    const loads = new Map();
    const gateway = await openGateway(config, context, {
      models,
      contextSnapshotProvider: (_sessionKey, conversationId) => {
        const n = (loads.get(conversationId) ?? 0) + 1;
        loads.set(conversationId, n);
        return { identity: { source: "synthetic:cron-context", content: `cron-context-${n}` } };
      },
    });
    const aborts = [];
    try {
      const sessionKey = "cron-conversations:workspace";
      const chat = await gateway.conversationFor(sessionKey, context);
      const firstSettled = changeWatcher(gateway.harness, (changes) => changes.some((change) => {
        if (change.type !== "document" || change.record.kind !== CRON_JOBS_KIND
          || change.conversationId !== chat.id || change.value === null) return false;
        return Array.isArray(change.value.jobs)
          && change.value.jobs.some((job) => job.lastOutcome !== null && job.lastOutcome !== undefined);
      }), "the first recurring run to settle");
      let firstJob;
      let firstOutcome;
      try {
        const submission = await chat.submit(
          { type: "input", content: "schedule a recurring context check", requestId: "cron-workspace-request" },
          context,
        );
        assert.equal((await submission.wait(context)).status, "done");
        const publication = await firstSettled.promise;
        const doc = publication.changes.find((change) =>
          change.type === "document" && change.record.kind === CRON_JOBS_KIND)?.value;
        firstJob = doc.jobs[0];
        firstOutcome = firstJob.lastOutcome;
        assert.equal(firstOutcome.status, "ok");
        const automationId = firstJob.lastOutcome.conversationId;
        assert.equal(typeof automationId, "number");
        assert.equal(firstJob.conversationId, automationId);

        // The next occurrence is already armed; arm its watcher before the settled one above is read
        // so no commit can be missed.
        const secondSettled = changeWatcher(gateway.harness, (changes) => changes.some((change) => {
          if (change.type !== "document" || change.record.kind !== CRON_JOBS_KIND
            || change.conversationId !== chat.id || change.value === null) return false;
          return Array.isArray(change.value.jobs) && change.value.jobs.some((job) =>
            job.lastOutcome !== null && job.lastOutcome !== undefined
            && job.lastOutcome.scheduledAtMs !== firstOutcome.scheduledAtMs);
        }), "the second recurring run to settle");
        try {
          await secondSettled.promise;
        } finally {
          secondSettled.stop();
        }
        assert.equal(loads.get(automationId), 2, "the shared conversation's snapshot was prepared twice");
        const episodes = prompts.filter((prompt) =>
          prompt.texts.includes(scheduledContent("scheduled context episode")));
        assert.equal(episodes.length, 2, "two episodes produced two model requests");
        assert.match(episodes[0].system, /cron-context-1/);
        assert.doesNotMatch(episodes[0].system, /cron-context-2/);
        assert.match(episodes[1].system, /cron-context-2/,
          "the second episode renders the workspace context rebuilt for it");
        assert.doesNotMatch(episodes[1].system, /cron-context-1/,
          "the rebuilt snapshot replaces the earlier one instead of stacking");
      } finally {
        firstSettled.stop();
      }
      const [job] = await readJobs(gateway.harness, chat.id);
      if (job?.timerTaskId !== null && job?.timerTaskId !== undefined) aborts.push(job.timerTaskId);
    } finally {
      for (const timerTaskId of aborts) {
        await gateway.harness.abortTask(timerTaskId, context).catch(() => undefined);
      }
      await gateway.close(context);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const codingTools of [["read"], []]) {
test(`an isolated scheduled run captures and permanently prunes capabilities (coding: ${codingTools.length})`, { timeout: 40_000 }, async () => {
  // Scouts and reflections had to run in `origin` mode because an isolated run had no read-only
  // recall and no MCP tool. The capture now carries both from the authenticated origin, and exactly
  // them: no scheduling, worker delegation, MCP management, channel action, classifier or Code Mode.
  // Every call is checked at call time against the durable capture and the current grants, so a
  // narrowed capture denies while the run's captured coding tool keeps working.
  const directory = await temp("nanobot-cron-capabilities-");
  try {
    const workspace = resolve(directory, "workspace");
    await mkdir(resolve(workspace, "memory"), { recursive: true });
    await writeFile(resolve(workspace, "memory", "notes.md"), "# Notes\n\nCAPABILITY-RECALL-MARKER\n");
    await writeFile(resolve(workspace, "note.txt"), "CAPABILITY-READ-CONTENT\n");
    const { openGateway } = await load(`${pkg}/dist/runtime.js`);
    const { parseConfig } = await load(`${pkg}/dist/config.js`);
    const providerId = "cron-capabilities-faux";
    const model = { provider: providerId, modelId: "synthetic" };
    const config = parseConfig({
      workspace,
      dataDir: resolve(directory, "state"),
      model,
      allowedModels: [model],
      toolAllowlist: codingTools,
      cron: { enabled: true, timeZone: "UTC" },
      mcp: {
        enabled: true,
        servers: {
          synthetic: { command: process.execPath, args: [MCP_FIXTURE] },
        },
      },
    }, directory);
    const configFile = resolve(directory, "config.json");
    await writeFile(configFile, JSON.stringify(config));
    const echoName = mcpToolNames("synthetic", ["echo"]).get("echo");
    const capturedMcpNames = [...mcpToolNames("synthetic", ["a-b", "a_b", "echo", "fail", "slow"]).values()];
    const provider = fauxProvider({ provider: providerId, models: [MODEL] });
    let releaseInspection;
    const inspectionGate = new Promise((release) => { releaseInspection = release; });
    let releaseNarrowing;
    const narrowingGate = new Promise((release) => { releaseNarrowing = release; });
    let reachedSecondRound;
    const secondRound = new Promise((reached) => { reachedSecondRound = reached; });
    let reachedThirdRound;
    const thirdRound = new Promise((reached) => { reachedThirdRound = reached; });
    let scheduledTurns = 0;
    let addIssued = false;
    let removeIssued = false;
    let restoreIssued = false;
    provider.setResponses(Array.from({ length: 20 }, () => async (transcript) => {
      const input = userTexts(transcript.messages)[0];
      if (input === scheduledContent("capability probe")) {
        scheduledTurns += 1;
        // The claim commit (conversation, class marker, queue entry, capture) precedes this request.
        if (scheduledTurns === 1) {
          await inspectionGate;
          return fauxAssistantMessage([
            fauxToolCall("memory_search", { target: "notes", query: "CAPABILITY-RECALL-MARKER" }, { id: "capability-recall" }),
            fauxToolCall(echoName, { label: "captured" }, { id: "capability-mcp" }),
          ], { stopReason: "toolUse" });
        }
        // Reached only after the allowed round's tool results committed, so the capture can be
        // narrowed in between and the same names requested again.
        if (scheduledTurns === 2) {
          reachedSecondRound();
          await narrowingGate;
          return fauxAssistantMessage([
            fauxToolCall("memory_search", { target: "notes", query: "CAPABILITY-RECALL-MARKER" }, { id: "capability-recall-revoked" }),
            fauxToolCall(echoName, { label: "captured" }, { id: "capability-mcp-revoked" }),
            ...(codingTools.length === 0 ? [] : [fauxToolCall("read", { path: "note.txt" }, { id: "capability-read" })]),
          ], { stopReason: "toolUse" });
        }
        // Reached only after the revoked round's own tool results committed.
        reachedThirdRound();
        return fauxAssistantMessage("CAPABILITY-ANSWER");
      }
      const latest = input;
      if (latest === "remove probe server" && !removeIssued) {
        removeIssued = true;
        return fauxAssistantMessage([fauxToolCall("mcp", { action: "remove", name: "synthetic" }, { id: "remove-probe-server" })], { stopReason: "toolUse" });
      }
      if (latest === "restore probe server" && !restoreIssued) {
        restoreIssued = true;
        return fauxAssistantMessage([fauxToolCall("mcp", {
          action: "add", name: "synthetic", server: { command: process.execPath, args: [MCP_FIXTURE] },
        }, { id: "restore-probe-server" })], { stopReason: "toolUse" });
      }
      if (input === "schedule a capability probe" && !addIssued) {
        addIssued = true;
        return fauxAssistantMessage([
          fauxToolCall("cron", { action: "add", message: "capability probe", after_seconds: 1 }, { id: "capability-add" }),
        ], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("Scheduled the capability probe.");
    }));
    const models = createModels();
    models.setProvider(provider.provider);
    const gateway = await openGateway({ ...config, configFile }, context, { models });
    try {
      const chat = await gateway.conversationFor("cron-conversations:capabilities", context);
      // MCP auto-enables Code Mode, so the chat holds the compositor and the cron tool; its MCP
      // tools stay deferred there. The scheduled run below must get neither one.
      assert.deepEqual(offeredToolNames(await chat.agent(context)).sort(),
        ["ask_user", "codemode", "cron", "memory_browse", "memory_read", "memory_search", "mcp", ...codingTools, "tool_search"].sort(),
        "the origin chat holds recall, its coding tool, cron and the compositor");
      const claimed = changeWatcher(gateway.harness, (changes) => changes.some((change) =>
        change.type === "document" && change.record.kind === CRON_JOBS_KIND
        && change.conversationId === chat.id && change.value !== null
        && typeof change.value.oneOffConversationId === "number"
        && Array.isArray(change.value.jobs) && change.value.jobs.some((job) => job.lastOutcome === null)),
      "the scheduled run's claim");
      const settledWatcher = changeWatcher(gateway.harness, (changes) => changes.some((change) =>
        change.type === "document" && change.record.kind === CRON_JOBS_KIND
        && change.conversationId === chat.id && change.value !== null
        && Array.isArray(change.value.jobs) && change.value.jobs.some((job) => job.lastOutcome?.status === "ok")),
      "the scheduled run to settle");
      try {
        const submission = await chat.submit(
          { type: "input", content: "schedule a capability probe", requestId: "capability-request" },
          context,
        );
        assert.equal((await submission.wait(context)).status, "done");
        const publication = await claimed.promise;
        const automationId = publication.changes
          .find((change) => change.type === "document" && change.record.kind === CRON_JOBS_KIND
            && change.conversationId === chat.id)?.value?.oneOffConversationId;
        assert.equal(typeof automationId, "number", "the claim records the automation conversation");

        // The capture is the origin's current authority and nothing else.
        const capture = await gateway.harness.snapshot(ConfigToolCaptureDoc, automationId, context);
        assert.equal(capture.originConversationId, chat.id);
        assert.deepEqual([...capture.tools].sort(),
          [...codingTools, "memory_search", "memory_browse", "memory_read", ...capturedMcpNames].sort(),
          "captured names are the coding ceiling plus recall and the exact connected MCP tools");
        for (const name of ["ask_user", "codemode", "tool_search", "worker", "cron", "mcp", "telegram", "discord_history"]) {
          assert.ok(!capture.tools.includes(name), `a scheduled run never captures ${name}`);
        }
        assert.equal(capture.classifierModel, null, "a scheduled run never captures a classifier");

        // The run is offered those tools directly: it has no Code Mode or tool search to load a
        // deferred MCP tool, so its captured MCP names are in the offered set.
        const automation = await gateway.harness.conversation(automationId, context);
        const automationTools = offeredToolNames(await automation.agent(context));
        for (const name of [...codingTools, "memory_search", "memory_browse", "memory_read", echoName]) {
          assert.ok(automationTools.includes(name), `the scheduled run is offered ${name}: ${automationTools.join(", ")}`);
        }
        for (const name of ["ask_user", "codemode", "tool_search", "worker", "cron", "mcp", "telegram", "discord_history"]) {
          assert.ok(!automationTools.includes(name), `the scheduled run is not offered ${name}`);
        }
        releaseInspection();

        // The allowed round: recall and the captured MCP tool both run. This request is only built
        // after their results committed.
        await secondRound;
        const allowed = await toolResults(automation);
        const recall = allowed.find((result) => result.id === "capability-recall");
        assert.ok(recall, "the recall call reached the transcript");
        assert.equal(recall.isError, false, `recall result: ${recall.text.slice(0, 300)}`);
        assert.match(recall.text, /memory\/notes\.md/, "the note is searched in the run's workspace");
        const mcp = allowed.find((result) => result.id === "capability-mcp");
        assert.ok(mcp, "the MCP call reached the transcript");
        assert.equal(mcp.isError, false, `mcp result: ${mcp.text.slice(0, 300)}`);
        assert.match(mcp.text, /echo:captured/, "the captured MCP tool reached the server");

        // Actual live management must permanently prune the running capture, including when the
        // coding ceiling is empty. Re-adding identical registration names cannot restore old grants.
        for (const command of ["remove probe server", "restore probe server"]) {
          const result = await (await chat.submit({ type: "input", content: command }, context)).wait(context);
          assert.equal(result.status, "done");
          const managed = (await toolResults(chat)).find((entry) => entry.id ===
            (command === "remove probe server" ? "remove-probe-server" : "restore-probe-server"));
          assert.ok(managed, `management call was made: ${command}`);
          assert.equal(managed.isError, false, managed.text);
          const pruned = await gateway.harness.snapshot(ConfigToolCaptureDoc, automationId, context);
          assert.ok(pruned, "a recall-only scheduled capture survives live policy refresh");
          assert.ok(pruned.tools.includes("memory_search"), "recall survives independently of coding");
          assert.ok(!pruned.tools.includes(echoName), "removed MCP names are never resurrected");
        }
        assert.equal(gateway.mcp.servers.find((server) => server.name === "synthetic")?.state, "connected");

        // Narrow recall as well; the still-captured coding tool, if any, keeps working.
        await gateway.harness.commit(async (tx) => {
          const doc = await tx.doc(ConfigToolCaptureDoc, automationId);
          doc.tools = doc.tools.filter((name) => name === "read");
        }, context);
        releaseNarrowing();
        await thirdRound;
        const afterRevocation = await toolResults(automation);
        const revokedRecall = afterRevocation.find((result) => result.id === "capability-recall-revoked");
        assert.equal(revokedRecall.isError, true, "revoked recall is denied");
        assert.match(revokedRecall.text, /captured authority/);
        const revokedMcp = afterRevocation.find((result) => result.id === "capability-mcp-revoked");
        assert.equal(revokedMcp.isError, true, "a revoked MCP tool is denied");
        assert.match(revokedMcp.text, /captured authority|not available|not enabled|not callable|unknown tool/i);
        if (codingTools.length > 0) {
          const read = afterRevocation.find((result) => result.id === "capability-read");
          assert.equal(read.isError, false, `the captured coding tool still works: ${read.text.slice(0, 200)}`);
          assert.match(read.text, /CAPABILITY-READ-CONTENT/);
        }

        // The run settles and its capture is retired with it in the same terminal commit.
        await settledWatcher.promise;
        assert.equal(await gateway.harness.snapshot(ConfigToolCaptureDoc, automationId, context), undefined,
          "a finished run keeps no captured authority");
        assert.deepEqual((await automation.agent(context)).tools, [],
          "the automation conversation is denied between runs");
      } finally {
        releaseInspection();
        releaseNarrowing();
        claimed.stop();
        settledWatcher.stop();
      }
    } finally {
      await gateway.close(context);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

}

test("a stale scheduled-run recall/MCP capture never survives a reopen", { timeout: 30_000 }, async () => {
  // A crash before a run's terminal commit leaves its capture on the automation conversation. A
  // reopen must not admit those names for a conversation that is no longer a live run target, and a
  // later re-enable of recall or MCP must not resurrect them.
  const directory = await temp("nanobot-cron-capabilities-reopen-");
  try {
    const workspace = resolve(directory, "workspace");
    await mkdir(workspace);
    const { openGateway } = await load(`${pkg}/dist/runtime.js`);
    const { parseConfig } = await load(`${pkg}/dist/config.js`);
    const providerId = "cron-capabilities-reopen-faux";
    const model = { provider: providerId, modelId: "synthetic" };
    const config = parseConfig({
      workspace,
      dataDir: resolve(directory, "state"),
      model,
      allowedModels: [model],
      toolAllowlist: ["read"],
      cron: { enabled: true, timeZone: "UTC" },
      mcp: {
        enabled: true,
        servers: { synthetic: { command: process.execPath, args: [MCP_FIXTURE] } },
      },
    }, directory);
    const echoName = mcpToolNames("synthetic", ["echo"]).get("echo");
    const provider = fauxProvider({ provider: providerId, models: [MODEL] });
    let addIssued = false;
    provider.setResponses(Array.from({ length: 8 }, () => (transcript) => {
      const input = userTexts(transcript.messages)[0];
      if (input === scheduledContent("stale capability probe")) return fauxAssistantMessage("STALE-PROBE-ANSWER");
      if (input === "schedule a stale capability probe" && !addIssued) {
        addIssued = true;
        return fauxAssistantMessage([
          fauxToolCall("cron", { action: "add", message: "stale capability probe", after_seconds: 1 }, { id: "stale-add" }),
        ], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("Scheduled the stale capability probe.");
    }));
    const models = createModels();
    models.setProvider(provider.provider);
    const sessionKey = "cron-conversations:capabilities-reopen";
    let automationId;
    let chatId;

    const first = await openGateway(config, context, { models });
    try {
      const chat = await first.conversationFor(sessionKey, context);
      chatId = chat.id;
      const settledWatcher = changeWatcher(first.harness, (changes) => changes.some((change) => {
        if (change.type !== "document" || change.record.kind !== CRON_JOBS_KIND
          || change.conversationId !== chat.id || change.value === null) return false;
        return Array.isArray(change.value.jobs)
          && change.value.jobs.some((job) => job.lastOutcome?.status === "ok");
      }), "the stale probe run to settle");
      try {
        const submission = await chat.submit(
          { type: "input", content: "schedule a stale capability probe", requestId: "stale-request" },
          context,
        );
        assert.equal((await submission.wait(context)).status, "done");
        const publication = await settledWatcher.promise;
        automationId = publication.changes.find((change) =>
          change.type === "document" && change.record.kind === CRON_JOBS_KIND
          && change.conversationId === chat.id)?.value?.jobs[0]?.lastOutcome?.conversationId;
        assert.equal(typeof automationId, "number");
      } finally {
        settledWatcher.stop();
      }
      // A capture left behind by a run that crashed before its terminal commit.
      await first.harness.commit(async (tx) => {
        const capture = await tx.doc(ConfigToolCaptureDoc, automationId);
        capture.originConversationId = chatId;
        capture.tools = ["read", "memory_search", "memory_browse", "memory_read", echoName];
        capture.classifierModel = null;
      }, context);
    } finally {
      await first.close(context);
    }

    // Reopen with recall and MCP both withdrawn: neither the stale capture nor the automation
    // conversation may keep them.
    const second = await openGateway(config, context, { models, agentHistory: false });
    try {
      assert.equal(await second.harness.snapshot(ConfigToolCaptureDoc, automationId, context), undefined,
        "a reopened gateway retires a capture that belongs to no live run");
      const conversation = await second.harness.conversation(automationId, context);
      assert.deepEqual((await conversation.agent(context)).tools, []);
    } finally {
      await second.close(context);
    }

    // Re-enabling recall and MCP in a later open cannot revive the retired names.
    const third = await openGateway(config, context, { models });
    try {
      assert.equal(await third.harness.snapshot(ConfigToolCaptureDoc, automationId, context), undefined,
        "a re-enabled capability never resurrects a retired capture");
      const conversation = await third.harness.conversation(automationId, context);
      assert.deepEqual((await conversation.agent(context)).tools, []);
      await assert.rejects(
        () => third.memorySearch(automationId, { target: "notes", query: "CAPABILITY-RECALL-MARKER" }, context),
        /Memory recall is unavailable in this conversation/,
        "an automation conversation between runs has no recall scope",
      );
    } finally {
      await third.close(context);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cronFoundation.finalize strips extensions consistently with vision off and on", { timeout: 30_000 }, async () => {
  const { openGateway } = await load(`${pkg}/dist/runtime.js`);
  const { parseConfig } = await load(`${pkg}/dist/config.js`);
  const extensionNames = (agent) => (agent?.extensions ?? []).map((ext) => (typeof ext === "string" ? ext : ext.name));

  for (const withVision of [false, true]) {
    const directory = await temp(`nanobot-cron-finalize-ext-${withVision ? "vision" : "plain"}-`);
    try {
      const workspace = resolve(directory, "workspace");
      await mkdir(workspace);
      const providerId = `cron-finalize-ext-${withVision ? "vision" : "plain"}`;
      const provider = fauxProvider({
        provider: providerId,
        models: [
          { id: "chat", name: "Chat", input: ["text", "image"] },
        ],
      });
      let addIssued = false;
      provider.setResponses(Array.from({ length: 8 }, () => (transcript) => {
        const input = userTexts(transcript.messages)[0];
        if (input === scheduledContent("extension strip probe")) return fauxAssistantMessage("STRIP-PROBE-ANSWER");
        if (input === "schedule extension strip probe" && !addIssued) {
          addIssued = true;
          return fauxAssistantMessage([
            fauxToolCall("cron", { action: "add", message: "extension strip probe", after_seconds: 1 }, { id: "ext-strip-add" }),
          ], { stopReason: "toolUse" });
        }
        return fauxAssistantMessage("Scheduled.");
      }));
      const models = createModels();
      models.setProvider(provider.provider);

      const config = parseConfig({
        workspace,
        dataDir: resolve(directory, "state"),
        ...(withVision
          ? {
              modelPresets: {
                chat: { provider: providerId, modelId: "chat" },
              },
              modelPreset: "chat",
              visionHandoff: { describerPreset: "chat" },
            }
          : {
              model: { provider: providerId, modelId: "chat" },
              allowedModels: [{ provider: providerId, modelId: "chat" }],
            }),
        toolAllowlist: ["read"],
        cron: { enabled: true, timeZone: "UTC" },
        episodeSummary: { enabled: false },
      }, directory);

      const gateway = await openGateway(config, context, { models });
      try {
        const chat = await gateway.conversationFor("cron-conversations:finalize-ext", context);
        const settledWatcher = changeWatcher(gateway.harness, (changes) => changes.some((change) => {
          if (change.type !== "document" || change.record.kind !== CRON_JOBS_KIND
            || change.conversationId !== chat.id || change.value === null) return false;
          return Array.isArray(change.value.jobs)
            && change.value.jobs.some((job) => job.lastOutcome?.status === "ok");
        }), "extension strip probe run to settle");
        try {
          const submission = await chat.submit(
            { type: "input", content: "schedule extension strip probe", requestId: "ext-strip-req" },
            context,
          );
          assert.equal((await submission.wait(context)).status, "done");
          const publication = await settledWatcher.promise;
          const automationId = publication.changes.find((change) =>
            change.type === "document" && change.record.kind === CRON_JOBS_KIND
            && change.conversationId === chat.id)?.value?.jobs[0]?.lastOutcome?.conversationId;
          assert.equal(typeof automationId, "number");

          // Inspect immediately after finalize (no reopen): extensions must be stripped to
          // `[visionExtension]` when vision is enabled, or `[]` when vision is off.
          const agent = await gateway.harness.snapshot(AgentDoc, automationId, context);
          assert.deepEqual(agent?.tools ?? [], [], "finalized cron target keeps no tools");
          assert.deepEqual(agent?.modelTools ?? [], [], "finalized cron target keeps no modelTools");
          assert.deepEqual(
            extensionNames(agent),
            withVision ? ["nanobot-vision-handoff"] : [],
            `finalized cron target extensions must be stripped (withVision=${withVision})`,
          );
        } finally {
          settledWatcher.stop();
        }
      } finally {
        await gateway.close(context);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
