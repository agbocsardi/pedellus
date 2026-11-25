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
const { EPISODE_SUMMARY_SOURCE_LIMITS, renderEntry } = await import(
  pathToFileURL(`${pkg}/dist/history/summary-source.js`).href
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

/** The newest memory tool result in one request; earlier results stay in the transcript. */
function lastMemoryResult(requestText, toolName) {
  const results = toolResultsOf(requestText).filter((result) => result.toolName === toolName && !result.isError);
  assert.ok(results.length > 0, `expected a ${toolName} tool result`);
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
    for (const name of ["memory_search", "memory_browse", "memory_read"]) assert.ok(names.includes(name), names.join(","));
    assert.ok(!names.includes("history"), names.join(","));
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
    // through model-facing memory search and read, which locate and open original evidence.
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
    for (const name of ["memory_search", "memory_browse", "memory_read"]) assert.ok(reopenedNames.includes(name), reopenedNames.join(","));
    assert.ok(!reopenedNames.includes("history"), reopenedNames.join(","));

    const requestCount = built.state.generationRequests.length;
    await scriptedSend("Search prior history for the early decision fact.", [
      fauxAssistantMessage([fauxToolCall("memory_search", { target: "messages", query: FACT })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Memory search completed."),
    ]);
    const searchResult = lastMemoryResult(built.state.generationRequests[requestCount + 1].text, "memory_search");
    const searchPage = JSON.parse(searchResult.text);
    const hit = searchPage.hits[0];
    assert.ok(hit?.ref, JSON.stringify(searchPage));

    const beforeOpen = built.state.generationRequests.length;
    await scriptedSend("Read the located original message.", [
      fauxAssistantMessage([fauxToolCall("memory_read", { ref: hit.ref })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Memory read completed."),
    ]);
    const openResult = lastMemoryResult(built.state.generationRequests[beforeOpen + 1].text, "memory_read");
    const opened = JSON.parse(openResult.text);
    assert.match(opened.content, new RegExp(SENTINEL), "the original early turn remains the evidence");
    assert.match(opened.content, new RegExp(FACT));
    assert.doesNotMatch(opened.content, new RegExp(TOPIC_MARKER), "topic body stays on demand");

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
      fauxAssistantMessage([fauxToolCall("memory_search", { target: "messages", query: LATE_FACT })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Memory search completed."),
    ]);
    const failedSearchResult = lastMemoryResult(built.state.generationRequests[beforeFailedOpen + 1].text, "memory_search");
    const failedSearchPage = JSON.parse(failedSearchResult.text);
    const lateHit = failedSearchPage.hits[0];
    assert.ok(lateHit?.ref, JSON.stringify(failedSearchPage));

    const beforeFailedSurround = built.state.generationRequests.length;
    await scriptedSend("Read the located late decision message.", [
      fauxAssistantMessage([fauxToolCall("memory_read", { ref: lateHit.ref })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Late entry read."),
    ]);
    const lateOpenResult = lastMemoryResult(built.state.generationRequests[beforeFailedSurround + 1].text, "memory_read");
    assert.match(JSON.parse(lateOpenResult.text).content, new RegExp(LATE_FACT), "raw evidence survives a failed summary");
  } finally {
    built.state.summaryGate.release();
    if (gateway) await gateway.close(context);
  }
});

test("episode summary source bounds one entry and previews long tool text head-tail", () => {
  const entryChars = EPISODE_SUMMARY_SOURCE_LIMITS.entryChars;
  const head = "RESULT-HEAD-1142";
  const tail = "RESULT-TAIL-1143";
  const result = renderEntry({
    id: 7,
    kind: "pi.tool-result",
    model: [{
      role: "toolResult",
      toolCallId: "call-7",
      toolName: "bash",
      content: [{ type: "text", text: `${head}${"r".repeat(9_000)}${tail}` }],
      isError: false,
    }],
  });
  assert.equal(result.toolResult, true);
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= entryChars, `body=${result.text.length}`);
  assert.ok(result.text.startsWith(`[Tool result bash]: ${head}`), result.text.slice(0, 80));
  assert.ok(result.text.endsWith(tail), result.text.slice(-80));
  assert.match(result.text, /characters omitted; original at entry:7\/tool-result\/call-7/);
  // The omitted middle is really gone, not merely labelled as omitted.
  assert.ok(!result.text.includes("r".repeat(4_650)), "the preview must not carry the middle");

  const argsHead = "ARGS-HEAD-5531";
  const argsTail = "ARGS-TAIL-5532";
  const call = renderEntry({
    id: 9,
    kind: "pi.assistant",
    model: [{
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "call-9",
        name: "edit",
        arguments: { path: `${argsHead}${"a".repeat(4_000)}${argsTail}` },
      }],
      stopReason: "toolUse",
    }],
  });
  assert.equal(call.truncated, true);
  assert.ok(call.text.length <= entryChars, `body=${call.text.length}`);
  assert.match(call.text, new RegExp(argsHead));
  assert.match(call.text, new RegExp(argsTail));
  assert.match(call.text, /characters omitted; original at entry:9\/tool-call\/call-9/);
  assert.ok(!call.text.includes("a".repeat(2_050)), "the preview must not carry the middle");

  // A short tool result is quoted whole, with no marker.
  assert.deepEqual(
    { ...renderEntry({
      id: 3,
      kind: "pi.tool-result",
      model: [{ role: "toolResult", toolCallId: "call-3", toolName: "read", content: [{ type: "text", text: "ok" }] }],
    }) },
    { text: "[Tool result read]: ok", message: false, toolResult: true, truncated: false },
  );

  // Multi-item entries: the preview takes the rest of the bound, so the parts after it are counted as
  // omitted. They are never dropped without a marker the summarizer can see.
  const multi = renderEntry({
    id: 11,
    kind: "pi.assistant",
    model: [{
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-a", name: "write", arguments: { content: "w".repeat(4_000) } },
        { type: "toolCall", id: "call-b", name: "bash", arguments: { command: "SECOND-CALL-LATE-8801" } },
      ],
      stopReason: "toolUse",
    }],
  });
  assert.equal(multi.truncated, true);
  assert.match(multi.text, /original at entry:11\/tool-call\/call-a/);
  assert.doesNotMatch(multi.text, /SECOND-CALL-LATE-8801/);
  assert.match(multi.text, /\[\.\.\. \d+ more characters truncated\]$/);

  // Prose that already fills the bound leaves the tool call unquoted, still with an exact count.
  const proseThenCall = renderEntry({
    id: 12,
    kind: "pi.assistant",
    model: [{
      role: "assistant",
      content: [
        { type: "text", text: "p".repeat(3_000) },
        { type: "toolCall", id: "call-c", name: "bash", arguments: { command: "AFTER-PROSE-9902" } },
      ],
      stopReason: "toolUse",
    }],
  });
  assert.equal(proseThenCall.truncated, true);
  assert.doesNotMatch(proseThenCall.text, /AFTER-PROSE-9902/);
  assert.match(proseThenCall.text, /\[\.\.\. \d+ more characters truncated\]$/);

  // A bound left too small for the preview's reference marker must still say how much was cut: the
  // shared preview degrades to a bare ellipsis there, so the counted head cut is used instead.
  const compact = renderEntry({
    id: 13,
    kind: "pi.assistant",
    model: [{
      role: "assistant",
      content: [
        { type: "text", text: "q".repeat(1_950) },
        { type: "toolCall", id: "call-d", name: "bash", arguments: { command: "COMPACT-TAIL-4410" } },
      ],
      stopReason: "toolUse",
    }],
  });
  assert.equal(compact.truncated, true);
  assert.doesNotMatch(compact.text, /COMPACT-TAIL-4410/);
  assert.doesNotMatch(compact.text, /\u2026$/);
  assert.match(compact.text, /\[\.\.\. \d+ more characters truncated\]$/);

  // Ordinary message prose keeps its head cut and its exact omitted-character count.
  const prose = renderEntry({ id: 4, kind: "pi.user", model: [{ role: "user", content: "u".repeat(3_000) }] });
  assert.equal(prose.truncated, true);
  assert.ok(prose.text.startsWith(`[User]: ${"u".repeat(entryChars - "[User]: ".length)}`));
  assert.match(prose.text, /\[\.\.\. 1008 more characters truncated\]$/);
});

test("an episode longer than the old 12-chunk cap is covered by one bounded request per chunk", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "nanobot-summary-span-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = resolve(root, "workspace");
  const dataDir = resolve(root, "state");
  await writeWorkspace(workspace);
  const config = lifecycleConfig(workspace, dataDir);
  const built = buildProviders();
  const session = "cli:summary-span";
  const resultHead = "SPAN-RESULT-HEAD-9142";
  const resultTail = "SPAN-RESULT-TAIL-9143";
  const argsHead = "SPAN-ARGS-HEAD-9144";
  const argsTail = "SPAN-ARGS-TAIL-9145";
  let gateway;
  try {
    gateway = await openGateway(config, context, {
      models: built.models,
      ...workspaceContextGatewayOptions(config),
    });
    const conversation = await gateway.conversationFor(session, context);
    await gateway.harness.commit(async (tx) => {
      await tx.appendEntry(conversation.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "Long synthetic episode start.", timestamp: 1_000 }],
      });
      await tx.appendEntry(conversation.id, {
        kind: "pi.assistant",
        model: [{
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "call-span",
            name: "bash",
            arguments: { command: `${argsHead}${"a".repeat(4_000)}${argsTail}` },
          }],
          stopReason: "toolUse",
          timestamp: 1_001,
        }],
      });
      await tx.appendEntry(conversation.id, {
        kind: "pi.tool-result",
        model: [{
          role: "toolResult",
          toolCallId: "call-span",
          toolName: "bash",
          content: [{ type: "text", text: `${resultHead}${"r".repeat(9_000)}${resultTail}` }],
          isError: false,
          timestamp: 1_002,
        }],
      });
      for (let index = 0; index < 1_650; index += 1) {
        // The first 300 fillers are full-size, so the episode needs far more than the old 12 chunks; the
        // rest are tiny, so 1,650 entries stay cheap while crossing a collect phase boundary (five
        // 400-entry pages, four of them per phase invocation).
        const body = index < 300 ? `Filler entry ${index}: ${"f".repeat(1_900)}` : `Small filler ${index}.`;
        await tx.appendEntry(conversation.id, {
          kind: "pi.user",
          model: [{ role: "user", content: body, timestamp: 2_000 + index }],
        });
      }
      await tx.appendEntry(conversation.id, {
        kind: "pi.assistant",
        model: [{ role: "assistant", content: [{ type: "text", text: "Long synthetic episode end." }], stopReason: "stop", timestamp: 9_000 }],
      });
    }, context);

    // Park the first fold so the worker identity is read from committed state, then let the chain run.
    const entered = built.state.summaryGate.wait();
    await conversation.reset(undefined, context);
    // The catalog records episode boundaries in bounded passes, so settle it before the summary queues.
    const settledCatalog = await within((async () => {
      let report = await gateway.reconcileHistoryEpisodes(session, context);
      for (let attempt = 0; attempt < 8 && !report.caughtUp; attempt += 1) {
        report = await gateway.reconcileHistoryEpisodes(session, context);
      }
      assert.equal(report.caughtUp, true, "the episode catalog never caught up");
      return report;
    })(), 10_000, "episode catalog reconciliation");
    assert.ok(settledCatalog.scanned > 0);
    await within(entered, 10_000, "first summary request");
    const queue = await gateway.historySummaryQueue(session, context);
    assert.ok(Number.isSafeInteger(queue.currentTaskId) && queue.currentTaskId > 0, "summary worker is live");
    const settled = gateway.harness.waitForTask(queue.currentTaskId, context);
    built.state.summaryGate.release();
    assert.equal((await within(settled, 30_000, "long summary task")).state.outcome.status, "completed");

    const episodes = await gateway.listHistoryEpisodes(session, { limit: 5 }, context);
    const closed = episodes.episodes.find((episode) => episode.status === "closed");
    assert.ok(closed, JSON.stringify(episodes.episodes.map((episode) => episode.status)));
    const record = await gateway.historyEpisodeSummary(session, closed.startEntryId, context);
    assert.equal(record.status, "ready");
    // The whole range is covered: the fold cap is gone, not merely raised.
    assert.ok(record.coverage.chunks > 12, `chunks=${record.coverage.chunks}`);
    // More than four collect pages means the collect phase yielded and resumed from its durable
    // checkpoint; the same episode is still covered exactly once and folded chunk by chunk.
    assert.equal(record.coverage.complete, true);
    assert.equal(record.coverage.uncoveredEntries, 0);
    assert.equal(record.coverage.entriesRead, record.coverage.sourceEntries);
    // Exactly one provider request per chunk: the request is bounded, and no attempt was repeated.
    assert.equal(built.state.summaryRequests.length, record.coverage.chunks);
    assert.equal(record.attempts, record.coverage.chunks);
    assert.equal(record.interruptedCalls, 0);
    const segments = built.state.summaryRequests.map((request) => {
      const messages = JSON.parse(request);
      const body = messages
        .filter((message) => message.role === "user")
        .map((message) => (typeof message.content === "string"
          ? message.content
          : message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n")))
        .join("\n");
      const fenced = /«transcript»\n([\s\S]*)\n«\/transcript»/.exec(body);
      assert.ok(fenced, "each fold carries one fenced transcript segment");
      return fenced[1];
    });
    for (const segment of segments) {
      // A chunk closes at 24,000 characters and may cross that by the entry that closes it, that
      // entry's truncation marker, and one two-character separator per entry in the chunk.
      const bound = EPISODE_SUMMARY_SOURCE_LIMITS.chunkChars
        + EPISODE_SUMMARY_SOURCE_LIMITS.entryChars
        + 2 * EPISODE_SUMMARY_SOURCE_LIMITS.chunkEntries
        + 128;
      assert.ok(segment.length <= bound, `segment=${segment.length}`);
    }
    // The long tool call and its result are quoted with the shared memory-recall head-tail preview.
    const first = segments[0];
    assert.match(first, new RegExp(resultHead));
    assert.match(first, new RegExp(resultTail));
    assert.match(first, /characters omitted; original at entry:\d+\/tool-result\/call-span/);
    assert.match(first, new RegExp(argsHead));
    assert.match(first, new RegExp(argsTail));
    assert.match(first, /characters omitted; original at entry:\d+\/tool-call\/call-span/);
  } finally {
    built.state.summaryGate.release();
    if (gateway) await gateway.close(context);
  }
});

/** The derived history index file of one disposable data directory. */
async function historyIndexFile(dataDir) {
  const { readdir } = await import("node:fs/promises");
  const names = await readdir(dataDir, { recursive: true });
  const name = names.find((candidate) => candidate.endsWith("-history-index.sqlite"));
  assert.ok(name, `no derived history index under ${dataDir}: ${names.join(",")}`);
  return join(dataDir, name);
}

/** Drop one summary row from FTS5 only: logical drift that queries do not report as an error. */
async function driftSummaryFts(indexFile) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(indexFile);
  try {
    const rows = db.prepare("SELECT summary_id, title, body FROM history_summaries").all();
    assert.ok(rows.length > 0, "a summary row is indexed");
    for (const row of rows) {
      db.prepare("INSERT INTO history_summary_fts (history_summary_fts, rowid, title, body) VALUES ('delete', ?, ?, ?)")
        .run(row.summary_id, row.title, row.body);
    }
  } finally {
    db.close();
  }
}

test("summary search verifies FTS5 integrity once per open and repairs a failing query in place", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "nanobot-summary-integrity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = resolve(root, "workspace");
  const dataDir = resolve(root, "state");
  await writeWorkspace(workspace);
  const config = lifecycleConfig(workspace, dataDir);
  const built = buildProviders();
  const open = () => openGateway(config, context, { models: built.models, ...workspaceContextGatewayOptions(config) });
  let gateway = await open();
  try {
    const conversation = await gateway.conversationFor(SESSION, context);
    built.state.script = [fauxAssistantMessage("Recorded the fact.")];
    built.generation.setResponses([built.dispatcher]);
    const submission = await conversation.submit({ type: "input", content: `Remember ${FACT}.`, requestId: "integrity-1" }, context);
    assert.equal((await submission.wait(context)).status, "done");
    await conversation.waitForIdle(context);

    const entered = built.state.summaryGate.wait();
    await conversation.reset(undefined, context);
    await within(gateway.reconcileHistoryEpisodes(SESSION, context).then(() => entered), 10_000, "summary request");
    const queue = await gateway.historySummaryQueue(SESSION, context);
    const settled = gateway.harness.waitForTask(queue.currentTaskId, context);
    built.state.summaryGate.release();
    assert.equal((await within(settled, 10_000, "summary task")).state.outcome.status, "completed");

    const search = () => gateway.historySummarySearch({ text: FACT }, context);
    const first = await search();
    assert.equal(first.hits.length, 1, JSON.stringify(first.coverage));
    assert.equal(first.coverage.indexReady, true);
    const indexFile = await historyIndexFile(dataDir);

    // A normal page trusts this open's verification: silent FTS drift is not re-checked per query.
    await driftSummaryFts(indexFile);
    const drifted = await search();
    assert.equal(drifted.hits.length, 0, "a normal summary page does not run the FTS5 integrity check");
    assert.equal(drifted.coverage.indexReady, true);

    // A query that fails on a broken summary layer re-verifies, repairs and retries in place.
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(indexFile);
    try { raw.exec("DROP TABLE history_summary_fts"); } finally { raw.close(); }
    const repaired = await search();
    assert.equal(repaired.hits.length, 1, JSON.stringify(repaired.coverage));
    assert.equal(repaired.coverage.indexReady, true);
    assert.equal(repaired.coverage.available, true);

    // Drift after that repair is found by the next open's one-time integrity check.
    await driftSummaryFts(indexFile);
    assert.equal((await search()).hits.length, 0);
    await gateway.close(context);
    gateway = undefined;
    gateway = await open();
    const reopened = await search();
    assert.equal(reopened.hits.length, 1, JSON.stringify(reopened.coverage));
    assert.equal(reopened.coverage.indexReady, true);
  } finally {
    built.state.summaryGate.release();
    if (gateway) await gateway.close(context);
  }
});

test("memory_search reads message hits with one bounded entry read per conversation slice", { timeout: 30_000 }, async () => {
  const { createHistorySearcher } = await import(pathToFileURL(`${pkg}/dist/memory/history-search.js`).href);
  const { UserEntry } = await import(pathToFileURL(`${pkg}/node_modules/@earendil-works/pi-durable/dist/index.js`).href);
  const entry = (id, text) => ({ id, kind: UserEntry.kind, model: [{ role: "user", content: text, timestamp: 1_700_000_000_000 + id }] });
  const stored = new Map([
    ["cli:a", [entry(3, "needle three"), entry(5, "needle five"), entry(6, "filler"), entry(7, "needle seven"), entry(40, "needle forty")]],
    ["cli:b", [entry(1000, "needle thousand")]],
  ]);
  const hit = (sessionKey, entryId, conversationId) => ({
    conversationId, sessionKey, entryId, entryKind: UserEntry.kind, role: "user", episodeStartEntryId: 1,
    excerpt: `[needle] ${entryId}`, excerptTruncated: false, bodyLength: 12, partIndex: 0, chunkIndex: 0, charStart: 0,
    bodyTruncated: false,
  });
  // Relevance order interleaves sessions; entry 9 is missing from the transcript.
  const hits = [hit("cli:a", 7, 1), hit("cli:b", 1000, 2), hit("cli:a", 3, 1), hit("cli:a", 9, 1), hit("cli:a", 5, 1), hit("cli:a", 40, 1)];
  const calls = [];
  const host = {
    async search() { return { hits, coverage: { complete: true, sessions: 2 } }; },
    async searchSummaries() { throw new Error("not used"); },
    async summary() { throw new Error("not used"); },
    async scope() { throw new Error("not used"); },
    async entries(session, query, limit, cursor) {
      calls.push({ session, ...query, limit, cursor });
      const items = (stored.get(session) ?? [])
        .filter((item) => (query.minEntryId === undefined || item.id >= query.minEntryId)
          && (query.maxEntryId === undefined || item.id <= query.maxEntryId))
        .slice(0, limit);
      return { items };
    },
  };
  const scope = {
    storeId: "synthetic-store",
    workspaceRoot: "/nonexistent",
    memoryFiles: [],
    sessions: [
      { sessionKey: "cli:a", conversationId: 1, channel: "cli" },
      { sessionKey: "cli:b", conversationId: 2, channel: "cli" },
    ],
  };
  const searcher = createHistorySearcher(host);
  try {
    const page = await searcher.search({ target: "messages", query: "needle" }, scope, context);
    assert.deepEqual(page.hits.map((item) => [item.source.session, item.source.entryId]),
      [["cli:a", 7], ["cli:b", 1000], ["cli:a", 3], ["cli:a", 5], ["cli:a", 40]],
      "relevance order and filtering are unchanged");
    assert.deepEqual(page.hits.map((item) => item.excerpt), ["[needle] 7", "[needle] 1000", "[needle] 3", "[needle] 5", "[needle] 40"]);
    assert.equal(page.coverage.unreadable, 1, "the missing entry is still one unreadable hit");
    assert.equal(page.complete, true);
    assert.deepEqual(calls.map(({ session, minEntryId, maxEntryId, limit }) => [session, minEntryId, maxEntryId, limit]),
      [["cli:a", 3, 9, 7], ["cli:b", 1000, 1000, 1], ["cli:a", 40, 40, 1]],
      "dense hits coalesce into one bounded slice while a distant hit stays an exact read");
  } finally {
    searcher.close();
  }
});

test("memory_search pre-filters excluded sessions, bounds sparse windows, and falls back on failed range reads", { timeout: 30_000 }, async () => {
  const { createHistorySearcher } = await import(pathToFileURL(`${pkg}/dist/memory/history-search.js`).href);
  const { UserEntry } = await import(pathToFileURL(`${pkg}/node_modules/@earendil-works/pi-durable/dist/index.js`).href);
  const entry = (id, text) => ({ id, kind: UserEntry.kind, model: [{ role: "user", content: text, timestamp: 1_700_000_000_000 + id }] });
  const hit = (sessionKey, entryId, conversationId) => ({
    conversationId, sessionKey, entryId, entryKind: UserEntry.kind, role: "user", episodeStartEntryId: 1,
    excerpt: `[needle] ${entryId}`, excerptTruncated: false, bodyLength: 12, partIndex: 0, chunkIndex: 0, charStart: 0,
    bodyTruncated: false,
  });

  // Part A: 60 hits in an excluded session plus 15 sparse hits (50 entries apart, dense filler
  // between every pair) in the requested session must complete in one call without reading the
  // excluded session or coalescing across wide filler gaps.
  const sparseTargetIds = Array.from({ length: 15 }, (_, index) => 10 + index * 50);
  const sparseTargetSet = new Set(sparseTargetIds);
  const sparseStored = new Map([
    ["cli:excluded", Array.from({ length: 3000 }, (_, i) => entry(i + 1, "excluded filler"))],
    ["cli:target", Array.from({ length: 800 }, (_, i) => entry(i + 1, sparseTargetSet.has(i + 1) ? `needle ${i + 1}` : "filler"))],
  ]);
  const allSparseHits = [
    ...Array.from({ length: 60 }, (_, i) => hit("cli:excluded", 10 + i * 40, 1)),
    ...sparseTargetIds.map((id) => hit("cli:target", id, 2)),
  ];
  const sparseCalls = [];
  const sparseHost = {
    async search(query) {
      const offset = query.cursor ?? 0;
      const slice = allSparseHits.slice(offset, offset + 20);
      return {
        hits: slice,
        ...(offset + 20 < allSparseHits.length ? { next: offset + 20 } : {}),
        coverage: { complete: true, sessions: 2 },
      };
    },
    async searchSummaries() { throw new Error("not used"); },
    async summary() { throw new Error("not used"); },
    async scope() { throw new Error("not used"); },
    async entries(session, query, limit) {
      sparseCalls.push({ session, ...query, limit });
      const items = (sparseStored.get(session) ?? [])
        .filter((item) => (query.minEntryId === undefined || item.id >= query.minEntryId)
          && (query.maxEntryId === undefined || item.id <= query.maxEntryId))
        .slice(0, limit);
      return { items };
    },
  };
  const scope = {
    storeId: "synthetic-store",
    workspaceRoot: "/nonexistent",
    memoryFiles: [],
    sessions: [
      { sessionKey: "cli:excluded", conversationId: 1, channel: "cli" },
      { sessionKey: "cli:target", conversationId: 2, channel: "cli" },
    ],
  };
  const sparseSearcher = createHistorySearcher(sparseHost);
  try {
    const page = await sparseSearcher.search(
      { target: "messages", query: "needle", filter: { sessions: ["cli:target"] } },
      scope,
      context,
    );
    assert.deepEqual(page.hits.map((item) => item.source.entryId), sparseTargetIds);
    assert.equal(page.complete, true, "sparse hits finish in one call without exhausting source budget");
    assert.equal(sparseCalls.some((call) => call.session === "cli:excluded"), false, "excluded session is never read");
    assert.equal(sparseCalls.every((call) => call.limit === 1 && call.minEntryId === call.maxEntryId), true, "sparse hits do not span wide filler gaps");
  } finally {
    sparseSearcher.close();
  }

  // Part B: a failed batched range read (e.g. corrupt filler entry 11) falls back to exact-ID reads
  // so readable hits 10, 12, 16 still succeed and only genuinely unreadable hit 14 is dropped.
  const fallbackStored = new Map([
    ["cli:target", [entry(10, "needle 10"), entry(12, "needle 12"), entry(16, "needle 16")]],
  ]);
  const fallbackHits = [hit("cli:target", 10, 2), hit("cli:target", 12, 2), hit("cli:target", 14, 2), hit("cli:target", 16, 2)];
  const fallbackCalls = [];
  const fallbackHost = {
    async search() { return { hits: fallbackHits, coverage: { complete: true, sessions: 1 } }; },
    async searchSummaries() { throw new Error("not used"); },
    async summary() { throw new Error("not used"); },
    async scope() { throw new Error("not used"); },
    async entries(session, query, limit) {
      fallbackCalls.push({ session, ...query, limit });
      if (query.minEntryId <= 11 && query.maxEntryId >= 11) throw new Error("corrupt filler entry 11");
      if (query.minEntryId === 14 && query.maxEntryId === 14) throw new Error("corrupt hit entry 14");
      const items = (fallbackStored.get(session) ?? [])
        .filter((item) => (query.minEntryId === undefined || item.id >= query.minEntryId)
          && (query.maxEntryId === undefined || item.id <= query.maxEntryId))
        .slice(0, limit);
      return { items };
    },
  };
  const fallbackSearcher = createHistorySearcher(fallbackHost);
  try {
    const page = await fallbackSearcher.search({ target: "messages", query: "needle" }, scope, context);
    assert.deepEqual(page.hits.map((item) => item.source.entryId), [10, 12, 16]);
    assert.equal(page.coverage.unreadable, 1, "only genuinely unreadable hit 14 counts as unreadable");
    assert.deepEqual(
      fallbackCalls.map(({ minEntryId, maxEntryId, limit }) => [minEntryId, maxEntryId, limit]),
      [[10, 16, 7], [10, 10, 1], [12, 12, 1], [14, 14, 1], [16, 16, 1]],
      "failed range read falls back to exact-ID reads for the window",
    );
  } finally {
    fallbackSearcher.close();
  }
});

test("summary continuation recovers from schema corruption and retry shares the read budget", { timeout: 30_000 }, async (t) => {
  const { createHistoryIndex, HISTORY_SUMMARY_LIMITS } = await import(pathToFileURL(`${pkg}/dist/history/index.js`).href);
  const { UserEntry, ResetEntry } = await import(pathToFileURL(`${pkg}/node_modules/@earendil-works/pi-durable/dist/index.js`).href);
  const { DatabaseSync } = await import("node:sqlite");
  const root = await mkdtemp(resolve(tmpdir(), "nanobot-summary-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const indexPath = resolve(root, "derived-history-index.sqlite");

  // 16 mapped sessions x 5 closed episodes = 80 closed episodes (> 64 read budget per pass).
  const sessionCount = 16;
  const episodesPerSession = 5;
  const sessions = Array.from({ length: sessionCount }, (_, index) => ({
    sessionKey: `cli:s${index + 1}`,
    conversationId: index + 1,
  }));
  const entriesByConv = new Map();
  const entryById = new Map();
  let nextEntryId = 1;
  for (const session of sessions) {
    const entries = [];
    for (let ep = 0; ep < episodesPerSession; ep++) {
      const userId = nextEntryId++;
      const resetId = nextEntryId++;
      const userEntry = {
        id: userId,
        conversationId: session.conversationId,
        kind: UserEntry.kind,
        model: [{ role: "user", content: `session ${session.conversationId} episode ${ep}`, timestamp: 1_700_000_000_000 + userId }],
      };
      const resetEntry = { id: resetId, conversationId: session.conversationId, kind: ResetEntry.kind, model: [] };
      entries.push(userEntry, resetEntry);
      entryById.set(userId, userEntry);
      entryById.set(resetId, resetEntry);
    }
    entriesByConv.set(session.conversationId, entries);
  }

  let readSummaryCalls = 0;
  let summaryVersion = 1;
  let summaryTag = "alpha";
  const index = createHistoryIndex({
    indexPath,
    storeId: "summary-recovery-store",
    sessions: async () => sessions,
    scan: async (_ctx, read) => read({
      async entry(entryId) { return entryById.get(entryId); },
      async scanEntries(query, limit) {
        let list = (entriesByConv.get(query.conversationId) ?? []).filter(
          (entry) => (query.minEntryId === undefined || entry.id >= query.minEntryId)
            && (query.maxEntryId === undefined || entry.id <= query.maxEntryId),
        );
        if (query.order === "descending") list = [...list].reverse();
        const items = list.slice(0, limit);
        return { items, ...(list.length > items.length ? { next: items[items.length - 1]?.id } : {}) };
      },
    }),
    readSummary: async (_ctx, conversationId, startEntryId) => {
      readSummaryCalls++;
      const list = entriesByConv.get(conversationId) ?? [];
      const startIndex = list.findIndex((entry) => entry.id === startEntryId);
      if (startIndex < 0) return { state: "missing" };
      const closingIndex = list.findIndex((entry, idx) => idx > startIndex && entry.kind === ResetEntry.kind);
      if (closingIndex < 0) return { state: "not-ready" };
      const end = list[closingIndex - 1];
      const reset = list[closingIndex];
      return {
        state: "ready",
        snapshot: {
          startEntryId,
          endEntryId: end.id,
          resetEntryId: reset.id,
          summarizerVersion: summaryVersion,
          title: `Episode ${conversationId}-${startEntryId}`,
          summary: `Digest ${summaryTag} for conversation ${conversationId} episode ${startEntryId}.`,
          summaryTruncated: false,
          completedAtMs: 1_700_000_000_000 + end.id,
          sourceEntries: closingIndex - startIndex,
          sourceMessages: 1,
          sourceToolResults: 0,
          sourceTruncatedEntries: 0,
          coverageComplete: true,
        },
      };
    },
  });

  try {
    // Seed the summary index with one bounded pass (64 reads).
    const initial = await index.searchSummaries({ text: "alpha", limit: 2 }, context);
    assert.equal(initial.hits.length, 2);
    assert.equal(readSummaryCalls, HISTORY_SUMMARY_LIMITS.maxSummaryReadsPerPass);

    // 1) Post-sweep FTS failure: repair preserves history_summaries and retries the query without
    // repeating the already-completed 64-read sweep.
    readSummaryCalls = 0;
    {
      const raw = new DatabaseSync(indexPath);
      try { raw.exec("DROP TABLE history_summary_fts"); } finally { raw.close(); }
    }
    const afterPostSweepRepair = await index.searchSummaries({ text: "alpha", limit: 2 }, context);
    assert.equal(afterPostSweepRepair.hits.length, 2);
    assert.equal(afterPostSweepRepair.coverage.indexReady, true);
    assert.equal(readSummaryCalls, HISTORY_SUMMARY_LIMITS.maxSummaryReadsPerPass, "retry must not repeat the 64-read sweep");

    // 2) Mid-sweep FTS failure: changing summary content forces writeSummary to hit the broken FTS
    // trigger during the sweep; the retry must share the remaining 64-read budget.
    readSummaryCalls = 0;
    summaryVersion = 2;
    summaryTag = "beta";
    {
      const raw = new DatabaseSync(indexPath);
      try { raw.exec("DROP TABLE history_summary_fts"); } finally { raw.close(); }
    }
    const afterMidSweepRepair = await index.searchSummaries({ text: "beta", limit: 2 }, context);
    assert.equal(afterMidSweepRepair.hits.length, 2);
    assert.equal(afterMidSweepRepair.coverage.indexReady, true);
    assert.ok(
      readSummaryCalls <= HISTORY_SUMMARY_LIMITS.maxSummaryReadsPerPass,
      `mid-sweep retry must share the 64-read budget (got ${readSummaryCalls})`,
    );

    // 3) Cursor-proof SQL corruption: corrupting a history_summaries column before a continuation
    // triggers self-repair inside the recovery boundary, rejects the invalidated cursor with a
    // contract error, and leaves the index healthy for a fresh search.
    const page1 = await index.searchSummaries({ text: "beta", limit: 1 }, context);
    assert.ok(page1.next, "page 1 returns a continuation cursor");
    {
      const raw = new DatabaseSync(indexPath);
      try { raw.exec("ALTER TABLE history_summaries RENAME COLUMN fingerprint TO broken_fingerprint"); }
      finally { raw.close(); }
    }
    await assert.rejects(
      () => index.searchSummaries({ text: "beta", limit: 1, cursor: page1.next }, context),
      /cursor no longer matches/i,
      "schema corruption during cursor proof self-repairs and rejects the invalidated cursor",
    );
    const fresh = await index.searchSummaries({ text: "beta", limit: 1 }, context);
    assert.equal(fresh.hits.length, 1, "fresh search succeeds immediately on the repaired schema");
    assert.equal(fresh.coverage.indexReady, true);
    assert.equal(fresh.coverage.available, true);
  } finally {
    await index.close();
  }
});
