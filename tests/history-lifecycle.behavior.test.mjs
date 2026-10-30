import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const pkg = process.env.PI_MODEL_CANDIDATE ?? resolve(import.meta.dirname, "..");
const ai = `${pkg}/node_modules/@earendil-works/pi-ai/dist`;
const chord = `${pkg}/node_modules/@earendil-works/chord/dist`;
const { openGateway } = await import(pathToFileURL(`${pkg}/dist/runtime.js`).href);
const { parseConfig } = await import(pathToFileURL(`${pkg}/dist/config.js`).href);
const { workspaceContextGatewayOptions } = await import(
  pathToFileURL(`${pkg}/dist/context/workspace-host.js`).href
);
const { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } = await import(
  pathToFileURL(`${ai}/index.js`).href
);
const { getCurrentSystemPrompt } = await import(
  pathToFileURL(`${ai}/utils/transcript.js`).href
);
const { BACKGROUND_CONTEXT } = await import(pathToFileURL(`${chord}/context/index.js`).href);
const context = BACKGROUND_CONTEXT;

const SESSION = "cli:memory-lifecycle";
const PROVIDER = "lifecycle-faux";
const GENERATION_MODEL = { provider: PROVIDER, modelId: "synthetic" };
const SUMMARY_PROVIDER = "lifecycle-summary-faux";
const SUMMARY_MODEL = { provider: SUMMARY_PROVIDER, modelId: "summary" };
const FACT = "MEMORY-FACT-3174";
const LATE_FACT = "LATE-DECISION-9285";
const SENTINEL = "RAW-EARLY-TURN-5521";
const SKILL_NAME = "note-keeping";
const SKILL_DESCRIPTION = "Synthetic lifecycle note-keeping instructions";
const SKILL_BODY = "SKILL_BODY_MARKER_C41A";
const BOOTSTRAP_MARKER = "LIFECYCLE_BOOTSTRAP_MARKER";
const TOPIC_PATH = "memory/topics/lifecycle.md";
const TOPIC_MARKER = "TOPIC_MARKER_7E2B";
const COMPACTION_PREFIX = "The conversation history before this point was compacted into the following summary";
const SUMMARY_PROMPT_PREFIX = "You maintain one short factual summary";

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolveValue) => { resolvePromise = resolveValue; });
  return { promise, resolve: resolvePromise };
}

/** Race against a hard deadline so a wedged provider or task fails instead of hanging the test. */
async function within(promise, ms, label) {
  const expired = deferred();
  const deadline = setTimeout(() => expired.resolve(`timeout after ${ms}ms: ${label}`), ms);
  try {
    return await Promise.race([promise, expired.promise.then((message) => { throw new Error(message); })]);
  } finally {
    clearTimeout(deadline);
  }
}

/** A provider request can be parked until the test has read committed state. */
function holdpoint() {
  const point = { held: false, entered: undefined, release: undefined };
  return {
    held: () => point.held,
    wait() {
      point.entered = deferred();
      point.held = true;
      return point.entered.promise;
    },
    park() {
      point.entered.resolve();
      return new Promise((resolveRelease) => { point.release = resolveRelease; });
    },
    release() {
      point.held = false;
      point.entered = undefined;
      const release = point.release;
      point.release = undefined;
      release?.();
    },
  };
}

/** FTS excerpts wrap matches in `[...]`; strip only that highlighting for content checks. */
function unhighlight(text) {
  return text.replace(/\[([^\]]*)\]/g, "$1");
}

function toolResultsOf(requestText) {
  const messages = JSON.parse(requestText);
  return messages
    .filter((message) => message !== null && typeof message === "object" && message.role === "toolResult")
    .map((message) => ({
      toolName: typeof message.toolName === "string" ? message.toolName : "",
      isError: message.isError === true,
      text: Array.isArray(message.content)
        ? message.content.map((block) => (block?.type === "text" ? block.text : "")).join("\n")
        : "",
    }));
}

/** The newest history tool result in one request; earlier history results stay in the transcript. */
function lastHistoryResult(requestText) {
  const results = toolResultsOf(requestText).filter((result) => result.toolName === "history" && !result.isError);
  assert.ok(results.length > 0, "expected a history tool result");
  return results.at(-1);
}

async function writeWorkspace(workspace) {
  const files = {
    "AGENTS.md": [
      "# Synthetic memory lifecycle workspace",
      "",
      BOOTSTRAP_MARKER,
      "",
      "This workspace is generated for one offline test and deleted afterwards.",
      "",
    ].join("\n"),
    "memory/MEMORY.md": [
      "# Loaded memory",
      "",
      "A synthetic loaded memory file.",
      "",
    ].join("\n"),
    "skills/note-keeping/SKILL.md": [
      "---",
      `name: ${SKILL_NAME}`,
      `description: ${SKILL_DESCRIPTION}`,
      "---",
      "",
      "# Note keeping",
      "",
      SKILL_BODY,
      "",
      "Keep notes in topic memory; the body is loaded only through the skill tool.",
      "",
    ].join("\n"),
  };
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(workspace, ...relativePath.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  await mkdir(join(workspace, "memory", "topics"), { recursive: true });
}

function lifecycleConfig(workspace, dataDir) {
  return parseConfig({
    workspace,
    dataDir,
    model: GENERATION_MODEL,
    allowedModels: [GENERATION_MODEL, SUMMARY_MODEL],
    toolAllowlist: ["read", "write", "edit"],
    workspaceContext: {
      memoryFiles: ["memory/MEMORY.md"],
      memoryManifest: true,
      skills: { disabledSkills: [] },
    },
    episodeSummary: { model: SUMMARY_MODEL },
  }, resolve(workspace, ".."));
}

function buildProviders() {
  const generation = fauxProvider({
    provider: PROVIDER,
    models: [{ id: GENERATION_MODEL.modelId, name: "Synthetic lifecycle model" }],
  });
  const summary = fauxProvider({
    provider: SUMMARY_PROVIDER,
    models: [{ id: SUMMARY_MODEL.modelId, name: "Synthetic summary model" }],
  });
  const models = createModels();
  models.setProvider(generation.provider);
  models.setProvider(summary.provider);

  const state = {
    script: [],
    generationRequests: [],
    compactionRequests: [],
    summaryRequests: [],
    summaryMode: "ready",
    summaryGate: holdpoint(),
  };

  // One re-arming dispatcher answers every model family the gateway dispatches. Compaction and
  // ordinary turns share the conversation model; episode summaries use their own configured model.
  const dispatcher = (request) => {
    const prompt = getCurrentSystemPrompt(request.messages);
    if (prompt.startsWith(SUMMARY_PROMPT_PREFIX)) throw new Error("summary provider used the generation dispatcher");
    const text = JSON.stringify(request.messages);
    const isCompaction = prompt.startsWith("You are a context summarization assistant");
    state.generationRequests.push({ kind: isCompaction ? "compaction" : "generation", text, prompt });
    generation.appendResponses([dispatcher]);
    if (isCompaction) {
      state.compactionRequests.push(text);
      return fauxAssistantMessage([
        "## Goal",
        "Continue the synthetic lifecycle conversation.",
        "## Progress",
        "### Done",
        "- [x] Synthetic early fact and topic note were recorded.",
        "## Critical Context",
        `- Early lifecycle fact: ${text.includes(FACT) ? FACT : "missing from request"}`,
        `- Topic memory locator: ${TOPIC_PATH}`,
      ].join("\n"), { stopReason: "stop" });
    }
    const step = state.script.shift();
    if (step === undefined) throw new Error("unexpected synthetic generation request");
    return step;
  };
  generation.setResponses([dispatcher]);

  const summaryDispatcher = (request) => {
    const text = JSON.stringify(request.messages);
    state.summaryRequests.push(text);
    summary.appendResponses([summaryDispatcher]);
    const respond = () => {
      if (state.summaryMode === "fail") return fauxAssistantMessage("", { stopReason: "stop" });
      const carried = text.includes(FACT) ? FACT : "fact absent from this fold";
      return fauxAssistantMessage([
        `Title: synthetic lifecycle episode (${carried})`,
        "## Topics",
        "- synthetic lifecycle",
        "## Keywords",
        `- ${carried}`,
        "",
        "Derived navigation only; the original transcript remains the evidence.",
      ].join("\n"), { stopReason: "stop" });
    };
    return state.summaryGate.held() ? state.summaryGate.park().then(respond) : respond();
  };
  summary.setResponses([summaryDispatcher]);

  return { generation, summary, models, state, dispatcher };
}

test("offline memory lifecycle preserves original evidence across compaction, reset and reopen", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "nanobot-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = resolve(root, "workspace");
  const dataDir = resolve(root, "state");
  await writeWorkspace(workspace);
  const config = lifecycleConfig(workspace, dataDir);
  const built = buildProviders();
  let gateway;
  try {
    gateway = await openGateway(config, context, {
      models: built.models,
      ...workspaceContextGatewayOptions(config),
    });
    const conversation = await gateway.conversationFor(SESSION, context);
    const conversationId = conversation.id;
    let active = conversation;

    // The lifecycle driver uses the gateway's actual agent loop and synthetic provider turns.
    let turn = 0;
    const state = built.state;
    const scriptedSend = async (text, steps) => {
      state.script = [...steps];
      // Each turn re-binds the one re-arming dispatcher; follow-up tool turns append themselves.
      built.generation.setResponses([built.dispatcher]);
      turn += 1;
      const submission = await active.submit({ type: "input", content: text, requestId: `lifecycle-${turn}` }, context);
      assert.equal((await submission.wait(context)).status, "done");
      await active.waitForIdle(context);
      assert.equal(state.script.length, 0, `unconsumed synthetic responses after turn ${turn}`);
    };

    const names = ((await conversation.agent(context)).tools ?? []).map((tool) =>
      typeof tool === "string" ? tool : tool?.name);
    assert.ok(names.includes("skill"), names.join(","));
    assert.ok(names.includes("history"), names.join(","));
    assert.ok(names.includes("write") && names.includes("read"), names.join(","));

    // Phase 1: on-demand skill body, early fact/decision, and a topic-memory write through the
    // configured host tools. These are ordinary faux-model turns over the real Gateway.
    await scriptedSend("Load the note-keeping skill instructions.", [
      fauxAssistantMessage([fauxToolCall("skill", { name: SKILL_NAME })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Skill instructions reviewed."),
    ]);
    const firstPrompt = built.state.generationRequests[0].prompt;
    assert.match(firstPrompt, new RegExp(BOOTSTRAP_MARKER));
    assert.match(firstPrompt, new RegExp(SKILL_NAME));
    assert.match(firstPrompt, new RegExp(SKILL_DESCRIPTION));
    assert.doesNotMatch(firstPrompt, new RegExp(SKILL_BODY));
    const skillResults = toolResultsOf(built.state.generationRequests[1].text).filter((result) => result.toolName === "skill");
    assert.equal(skillResults.length, 1);
    assert.match(skillResults[0].text, new RegExp(SKILL_BODY));

    await scriptedSend(
      `Early decision: keep personal topics under ${TOPIC_PATH}. Remember the fact ${FACT}. ` +
      `This raw early turn also carries ${SENTINEL}.`,
      [fauxAssistantMessage("Recorded the early decision.")],
    );

    const topicContent = [
      "---",
      "description: Synthetic lifecycle topic",
      "---",
      "",
      "# Lifecycle topic",
      "",
      `The topic marker is ${TOPIC_MARKER}.`,
      "",
    ].join("\n");
    await scriptedSend(`Write the topic memory to ${TOPIC_PATH}.`, [
      fauxAssistantMessage([fauxToolCall("write", { path: TOPIC_PATH, content: topicContent })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Topic memory written."),
    ]);
    const onDisk = await readFile(join(workspace, ...TOPIC_PATH.split("/")), "utf8");
    assert.match(onDisk, new RegExp(TOPIC_MARKER));
    assert.doesNotMatch(onDisk, new RegExp(FACT));

    // Enough recent context for native Durable compaction to select an old prefix that still
    // contains the early fact in the retained transcript.
    const fillerLine = "Synthetic lifecycle filler. It exists only to give native compaction an old prefix to summarize. ";
    for (let index = 1; index <= 3; index += 1) {
      const filler = fillerLine.repeat(Math.ceil(42_000 / fillerLine.length)).slice(0, 42_000);
      await scriptedSend(`Filler turn ${index}. ${filler}`, [fauxAssistantMessage(`Acknowledged filler ${index}.`)]);
    }

    const compactionTaskId = await conversation.compact(undefined, context);
    const compacted = await within(gateway.harness.waitForTask(compactionTaskId, context), 10_000, "compaction task");
    assert.equal(compacted.state.outcome.status, "completed");
    await conversation.waitForIdle(context);
    assert.equal(built.state.compactionRequests.length, 1, "one native compaction request");
    assert.match(built.state.compactionRequests[0], new RegExp(FACT));
    assert.match(built.state.compactionRequests[0], new RegExp(SENTINEL));

    const compactedView = await conversation.context(context);
    const compactedText = JSON.stringify(compactedView.messages ?? []);
    assert.ok(compactedView.head !== undefined, "compaction summary must be placed at the head");
    assert.match(compactedText, new RegExp(COMPACTION_PREFIX));
    assert.match(compactedText, new RegExp(FACT));
    assert.doesNotMatch(compactedText, new RegExp(SENTINEL), "the raw early turn is no longer active context");

    // Phase 2: reset closes the episode; the queued summary pass uses the original transcript,
    // not only the compacted active context. The provider is held so the worker identity is
    // observable without sleeping.
    const entered = built.state.summaryGate.wait();
    await conversation.reset(undefined, context);
    await within(gateway.reconcileHistoryEpisodes(SESSION, context).then(() => entered), 10_000, "summary request");
    const queue = await gateway.historySummaryQueue(SESSION, context);
    assert.ok(Number.isSafeInteger(queue.currentTaskId) && queue.currentTaskId > 0, "summary worker is live");
    // While the summary pass is still pending, raw search already works: derived navigation is not
    // a prerequisite for transcript recall.
    const pendingEpisodes = await gateway.listHistoryEpisodes(SESSION, { limit: 10 }, context);
    const pendingEpisode = pendingEpisodes.episodes.find((episode) => episode.status === "closed");
    assert.ok(pendingEpisode, JSON.stringify(pendingEpisodes.episodes.map((episode) => episode.status)));
    const pendingSummaryView = await gateway.historySummary(SESSION, pendingEpisode.startEntryId, context);
    assert.equal(pendingSummaryView.state, "not-ready");
    assert.equal(pendingSummaryView.status, "pending");
    const pendingSearch = await gateway.historySearch({ text: FACT, scope: "messages", limit: 5 }, context);
    assert.equal(pendingSearch.hits.length, 1, JSON.stringify(pendingSearch.hits));
    assert.match(unhighlight(pendingSearch.hits[0].excerpt), new RegExp(FACT));
    const summarySettled = gateway.harness.waitForTask(queue.currentTaskId, context);
    built.state.summaryGate.release();
    const summaryTask = await within(summarySettled, 10_000, "summary task");
    assert.equal(summaryTask.state.outcome.status, "completed");
    assert.ok(built.state.summaryRequests.some((request) => request.includes(FACT)), "summary read the early fact");
    assert.ok(built.state.summaryRequests.some((request) => request.includes(SENTINEL)),
      "summary read the original early entry even after compaction");

    const episodes = await gateway.listHistoryEpisodes(SESSION, { limit: 10 }, context);
    const firstEpisode = episodes.episodes.find((episode) => episode.status === "closed" && episode.summary.status === "ready");
    assert.ok(firstEpisode, JSON.stringify(episodes.episodes.map((episode) => episode.status)));
    const firstSummary = await gateway.historyEpisodeSummary(SESSION, firstEpisode.startEntryId, context);
    assert.equal(firstSummary.status, "ready");
    assert.match(firstSummary.summary, new RegExp(FACT));
    assert.doesNotMatch(firstSummary.summary, new RegExp(SENTINEL), "summary text is derived navigation, not raw evidence");

    // Phase 3: close and reopen the same durable store. The original evidence stays reachable
    // through the model-facing history tool, which searches raw entries and opens one window.
    await gateway.close(context);
    gateway = undefined;
    gateway = await openGateway(config, context, {
      models: built.models,
      ...workspaceContextGatewayOptions(config),
    });
    const reopened = await gateway.conversationFor(SESSION, context);
    assert.equal(reopened.id, conversationId);
    active = reopened;

    const factHit = await gateway.historySearch({ text: FACT, scope: "messages", limit: 5 }, context);
    assert.equal(factHit.hits.length, 1, JSON.stringify(factHit.hits));
    assert.ok(factHit.hits[0].entryId > 0);
    assert.match(unhighlight(factHit.hits[0].excerpt), new RegExp(FACT));

    const reopenedNames = ((await reopened.agent(context)).tools ?? []).map((tool) =>
      typeof tool === "string" ? tool : tool?.name);
    assert.ok(reopenedNames.includes("history"), reopenedNames.join(","));

    const requestCount = built.state.generationRequests.length;
    await scriptedSend("Search prior history for the early decision fact.", [
      fauxAssistantMessage([fauxToolCall("history", { action: "search", query: FACT })], { stopReason: "toolUse" }),
      fauxAssistantMessage("History search completed."),
    ]);
    const searchResult = lastHistoryResult(built.state.generationRequests[requestCount + 1].text);
    assert.match(searchResult.text, /History search \(read-only/);
    assert.match(unhighlight(searchResult.text), new RegExp(FACT));
    const entryId = Number(/entry=(\d+)/.exec(searchResult.text)?.[1]);
    assert.ok(Number.isSafeInteger(entryId) && entryId > 0, searchResult.text);

    const beforeOpen = built.state.generationRequests.length;
    await scriptedSend(`Open history entry ${entryId}.`, [
      fauxAssistantMessage([fauxToolCall("history", { action: "open", session: SESSION, entryId })], { stopReason: "toolUse" }),
      fauxAssistantMessage("History entry opened."),
    ]);
    const openResult = lastHistoryResult(built.state.generationRequests[beforeOpen + 1].text);
    assert.match(openResult.text, new RegExp(SENTINEL), "the original early turn remains the evidence");
    assert.match(openResult.text, new RegExp(FACT));
    assert.doesNotMatch(openResult.text, new RegExp(TOPIC_MARKER), "topic body stays on demand");

    // Phase 4: a second closed episode whose summary fails must not block raw recall. The summary
    // provider parks once so the worker identity is read from committed state; it then answers empty,
    // which is a classified terminal failure, not a transcript problem.
    built.state.summaryMode = "fail";
    const failedEntered = built.state.summaryGate.wait();
    await scriptedSend(`Late decision for the next episode: ${LATE_FACT}.`, [
      fauxAssistantMessage("Recorded the late decision."),
    ]);
    await reopened.reset(undefined, context);
    await within(gateway.reconcileHistoryEpisodes(SESSION, context).then(() => failedEntered), 10_000, "failed summary request");
    const failedQueue = await gateway.historySummaryQueue(SESSION, context);
    assert.ok(Number.isSafeInteger(failedQueue.currentTaskId) && failedQueue.currentTaskId > 0,
      "failed-summary worker is live");
    const failedSettled = gateway.harness.waitForTask(failedQueue.currentTaskId, context);
    built.state.summaryGate.release();
    const failedTask = await within(failedSettled, 10_000, "failed summary task");
    assert.equal(failedTask.state.outcome.status, "failed");

    const closedEpisodes = await gateway.listHistoryEpisodes(SESSION, { limit: 10 }, context);
    const failedEpisode = closedEpisodes.episodes.find((episode) => episode.status === "closed" && episode.summary.status === "failed");
    assert.ok(failedEpisode, JSON.stringify(closedEpisodes.episodes.map((episode) => episode.summary.status)));
    const failedSummary = await gateway.historyEpisodeSummary(SESSION, failedEpisode.startEntryId, context);
    assert.equal(failedSummary.status, "failed");
    assert.equal(failedSummary.error, "empty-summary");
    assert.equal((await gateway.historySummary(SESSION, failedEpisode.startEntryId, context)).state, "not-ready");

    const lateSearch = await gateway.historySearch({ text: LATE_FACT, scope: "messages", limit: 5 }, context);
    assert.equal(lateSearch.hits.length, 1, JSON.stringify(lateSearch.hits));
    assert.match(unhighlight(lateSearch.hits[0].excerpt), new RegExp(LATE_FACT));

    const beforeFailedOpen = built.state.generationRequests.length;
    await scriptedSend("Search history for the late decision despite the failed summary.", [
      fauxAssistantMessage([fauxToolCall("history", { action: "search", query: LATE_FACT })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Raw history search completed."),
    ]);
    const failedSearchResult = lastHistoryResult(built.state.generationRequests[beforeFailedOpen + 1].text);
    assert.match(unhighlight(failedSearchResult.text), new RegExp(LATE_FACT));
    const lateEntryId = Number(/entry=(\d+)/.exec(failedSearchResult.text)?.[1]);
    assert.ok(Number.isSafeInteger(lateEntryId) && lateEntryId > 0, failedSearchResult.text);

    const beforeFailedSurround = built.state.generationRequests.length;
    await scriptedSend(`Open the late decision entry ${lateEntryId}.`, [
      fauxAssistantMessage([fauxToolCall("history", { action: "open", session: SESSION, entryId: lateEntryId })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Late entry opened."),
    ]);
    const lateOpenResult = lastHistoryResult(built.state.generationRequests[beforeFailedSurround + 1].text);
    assert.match(lateOpenResult.text, new RegExp(LATE_FACT), "raw evidence survives a failed summary");
  } finally {
    built.state.summaryGate.release();
    if (gateway) await gateway.close(context);
  }
});
