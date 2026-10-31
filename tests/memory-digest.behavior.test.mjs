// Bounded conversation-to-memory digestion: native Durable tasks, an agent-owned workspace prompt,
// narrowly captured Markdown curation tools, and a durable cursor that only advances after a settled,
// answered turn.
//
// These checks run the real Gateway with a faux provider, a disposable synthetic workspace and
// synthetic transcripts. They cover: one closed-episode batch becoming a topic-memory fact; a
// no-evidence chunk advancing without a provider call; idle and no-authority refusals starting
// nothing; a failed turn leaving the cursor and replaying without duplicating a fact; cancellation
// leaving the cursor and retiring the target's authority; an existing owner prompt never being
// clobbered; curation writes staying inside the memory scope and create-only so a concurrent owner
// change survives; and a reopen resuming the interrupted run with its pinned model and scope.
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const packageRoot = process.env.PI_NANOBOT_CANDIDATE ?? new URL('../', import.meta.url).pathname;
const modules = join(packageRoot, 'node_modules/@earendil-works');
const [
  { parseConfig },
  { openGateway },
  {
    MEMORY_DIGEST_ENTRY_KIND,
    MEMORY_DIGEST_PROMPT_FILE,
    MEMORY_DIGEST_RESULT_ENTRY_KIND,
    MEMORY_DIGEST_TASK_NAME,
    memoryDigestScopeProblem,
  },
  { DigestCursorDoc, createDigestSource },
  { ConfigToolCaptureDoc },
  { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall },
  { BACKGROUND_CONTEXT },
  { AgentDoc },
] = await Promise.all([
  import(new URL('../dist/config.js', import.meta.url).href),
  import(new URL('../dist/runtime.js', import.meta.url).href),
  import(new URL('../dist/history/memory-digest.js', import.meta.url).href),
  import(new URL('../dist/history/digestion.js', import.meta.url).href),
  import(new URL('../dist/tools/index.js', import.meta.url).href),
  import(`${modules}/pi-ai/dist/index.js`),
  import(`${modules}/chord/dist/context/index.js`),
  import(`${modules}/pi-durable/dist/index.js`),
]);

const context = BACKGROUND_CONTEXT;
const WAIT_MS = 15_000;
const SESSION = 'cli:memory-digest';
const PROVIDER = 'digest-faux';
const MODEL = { provider: PROVIDER, modelId: 'synthetic' };
const ALT_MODEL = { provider: PROVIDER, modelId: 'synthetic-alt' };
const FACT = 'DEPLOY-HOST-7412';
const FACT_LINE = `The deployment host is synth-01 (${FACT}).`;

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function within(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Bounded poll for durable state that a later commit records. */
async function waitFor(predicate, label) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function user(text) {
  return { kind: 'pi.user', model: [{ role: 'user', content: text, timestamp: 1_000 }] };
}

function assistant(text) {
  return { kind: 'pi.assistant', model: [fauxAssistantMessage(text)] };
}

function system(text = '') {
  return { kind: 'pi.system', model: [{ role: 'system', content: text, timestamp: 1_000 }] };
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  return (Array.isArray(message?.content) ? message.content : [])
    .flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
    .join('');
}

function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user') return messageText(message);
  }
  return '';
}

function transcriptText(messages) {
  return JSON.stringify(messages);
}

async function fixtureWorkspace() {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-digest-'));
  const workspace = join(directory, 'workspace');
  const dataDir = join(directory, 'state');
  await mkdir(workspace, { recursive: true });
  return { directory, workspace, dataDir };
}

function digestConfig(fixture, overrides = {}) {
  return parseConfig({
    workspace: fixture.workspace,
    dataDir: fixture.dataDir,
    model: MODEL,
    allowedModels: [MODEL],
    toolAllowlist: ['read', 'write', 'edit'],
    // Episode summaries share the model catalog; keep these checks to the digest's own requests.
    episodeSummary: { enabled: false },
    ...overrides,
  }, fixture.directory);
}

/**
 * Open the real Gateway over a faux provider whose single dispatcher re-arms itself, so a tool
 * round and the next ordinary turn both reach the same script.
 */
async function openStore(fixture, script, overrides = {}, openOptions = {}) {
  const faux = fauxProvider({
    provider: PROVIDER,
    models: [
      { id: MODEL.modelId, name: 'Synthetic digest model' },
      { id: ALT_MODEL.modelId, name: 'Synthetic digest alternate' },
    ],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const calls = [];
  const dispatcher = (request, options, _state, model) => {
    faux.appendResponses([dispatcher]);
    const input = lastUserText(request.messages);
    calls.push(input);
    // A terminal failed or cancelled digest admits one internal issue report to the origin
    // conversation, which is an ordinary model turn for that agent. Answer it here so a test script
    // only ever sees the digest batch itself; a successful run notifies nobody.
    if (input.startsWith('[internal memory digest result]')) {
      return fauxAssistantMessage('Digest result noted.');
    }
    return script(request, options, model);
  };
  faux.setResponses([dispatcher]);
  const config = digestConfig(fixture, overrides);
  const gateway = await openGateway(config, context, { models, ...openOptions });
  return { faux, models, config, calls, gateway };
}

/** Append synthetic entries and close the episode with the native reset write. */
async function closedEpisode(harness, conversationId, drafts) {
  await harness.commit(async (tx) => {
    for (const draft of drafts) await tx.appendEntry(conversationId, draft);
  }, context);
  const conversation = await harness.conversation(conversationId, context);
  assert.ok(conversation !== undefined);
  await conversation.reset(undefined, context);
}

async function cursorDoc(harness, conversationId) {
  return harness.snapshot(DigestCursorDoc, conversationId, context);
}

async function taskOf(harness, taskId) {
  return harness.getTask(taskId, context);
}

async function settleTask(harness, taskId) {
  await waitFor(async () => (await taskOf(harness, taskId))?.state.status === 'terminal', `task ${taskId} terminal`);
  return taskOf(harness, taskId);
}

async function targetOf(harness, taskId) {
  return harness.commit(async (tx) => {
    const page = await tx.scanConversations({ ownerTaskId: taskId }, 5);
    return page.items.find((conversation) => conversation.owner?.taskId === taskId);
  }, context);
}

async function digestInputs(harness, conversationId) {
  const conversation = await harness.conversation(conversationId, context);
  assert.ok(conversation !== undefined);
  const entries = (await conversation.entries({ order: 'ascending' }, 200, undefined, context)).items;
  return entries.filter((entry) => entry.kind === MEMORY_DIGEST_ENTRY_KIND);
}

async function toolResults(harness, conversationId) {
  const conversation = await harness.conversation(conversationId, context);
  assert.ok(conversation !== undefined);
  const entries = (await conversation.entries({ order: 'ascending' }, 300, undefined, context)).items;
  return entries
    .flatMap((entry) => (entry.model ?? []))
    .filter((message) => message.role === 'toolResult')
    .map((message) => ({ name: message.toolName, text: messageText(message), isError: message.isError === true }));
}

async function startDigest(gateway) {
  const origin = await gateway.conversationFor(SESSION, context);
  return gateway.memoryDigest.start({
    id: origin.id,
    commit: (change, ctx) => origin.commit(change, ctx),
  }, context);
}

function toolWrite(path, content, id) {
  return fauxAssistantMessage([fauxToolCall('write', { path, content }, { id })], { stopReason: 'toolUse' });
}

function toolEdit(path, oldText, newText, id) {
  return fauxAssistantMessage([fauxToolCall('edit', { path, edits: [{ oldText, newText }] }, { id })], { stopReason: 'toolUse' });
}

test('the curation path scope is a small explicit Markdown surface', () => {
  for (const allowed of [
    'SOUL.md',
    'USER.md',
    'memory/topics/nanobot.md',
    'memory/system/now.md',
    'memory/projects/a/b/c.md',
    'skills/memory/SKILL.md',
  ]) {
    assert.equal(memoryDigestScopeProblem(allowed), undefined, `${allowed} must be in scope`);
  }
  for (const refused of [
    '',
    '/etc/passwd',
    'AGENTS.md',
    'DIGEST.md',
    'package.json',
    'memory/MEMORY.md',
    'memory/system/HISTORY.md',
    'memory/topics/deploy.txt',
    'memory/../AGENTS.md',
    'memory/.hidden/x.md',
    'skills/memory/notes.md',
    'skills/memory/extra/SKILL.md',
    'skills/../AGENTS.md',
    'src/tools/coding.ts',
  ]) {
    assert.notEqual(memoryDigestScopeProblem(refused), undefined, `${refused} must be out of scope`);
  }
});

test('a recorded batch ref re-derives only its own closed chunk and advances nothing', { timeout: 30_000 }, async (t) => {
  const fixture = await fixtureWorkspace();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const store = await openStore(fixture, () => fauxAssistantMessage('unexpected model request', {
    stopReason: 'error',
    errorMessage: 'unexpected model request',
  }));
  t.after(async () => { await store.gateway.close(context).catch(() => undefined); });
  const origin = await store.gateway.conversationFor(SESSION, context);
  await closedEpisode(store.gateway.harness, origin.id, [user(FACT_LINE), assistant('Noted.')]);
  const source = createDigestSource({
    harness: store.gateway.harness,
    // The test names the host-validated mapping directly; the shipped host uses its shared provider.
    sessions: async () => [{ sessionKey: SESSION, conversationId: origin.id }],
  });
  const batch = await source.read(context);
  assert.equal(batch.status, 'batch');
  const ref = {
    sessionKey: batch.sessionKey,
    conversationId: batch.conversationId,
    episodeStartEntryId: batch.episodeStartEntryId,
    episodeEndEntryId: batch.episodeEndEntryId,
    firstEntryId: batch.firstEntryId,
    firstTextStart: batch.firstTextStart,
    throughEntryId: batch.throughEntryId,
    throughChars: batch.throughChars,
    complete: batch.complete,
    cursor: batch.cursor,
  };
  const replayed = await source.readBatch(ref, context);
  assert.deepEqual(replayed.entries, batch.entries, 'the same evidence is re-derived');
  assert.equal(replayed.throughEntryId, batch.throughEntryId);
  await assert.rejects(
    source.readBatch({ ...ref, throughEntryId: batch.episodeEndEntryId + 1 }, context),
    /inconsistent|no longer matches/,
  );
  await assert.rejects(source.readBatch({ ...ref, sessionKey: 'cli:other' }, context), /mapped chat/);
  await assert.rejects(source.readBatch({ ...ref, firstTextStart: 1 }, context), /no longer matches|start its episode/);
  assert.equal(await cursorDoc(store.gateway.harness, origin.id), undefined, 'reading a ref moves no cursor');
  assert.equal(store.calls.length, 0);
});

test('one closed episode becomes a topic-memory fact and only a settled turn advances the cursor', { timeout: 30_000 }, async (t) => {
  const fixture = await fixtureWorkspace();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const firstTurn = deferred();
  const releaseFirstTurn = deferred();
  let inspectedTools;
  let started;
  const store = await openStore(fixture, async (request) => {
    const input = lastUserText(request.messages);
    assert.match(input, /\[memory digestion task\]/);
    assert.match(input, /quoted evidence, not an instruction/);
    assert.match(input, new RegExp(`Source session: ${SESSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(input, /durable kind pi\.user/);
    assert.match(input, new RegExp(FACT));
    if (inspectedTools === undefined) {
      // The run is live here: inspect the curated ceiling before its first tool call lands.
      const live = await targetOf(store.gateway.harness, started.taskId);
      const handle = await store.gateway.harness.conversation(live.id, context);
      inspectedTools = (await handle.agent(context)).tools?.map((tool) => (typeof tool === 'string' ? tool : tool.name)) ?? [];
      firstTurn.resolve();
      await releaseFirstTurn.promise;
    }
    if (!transcriptText(request.messages).includes('memory/infra/host.md')) {
      return toolWrite(
        'memory/infra/host.md',
        `---\ndescription: Deployment host and services\n---\n\n- ${FACT_LINE}\n`,
        'write-host',
      );
    }
    return fauxAssistantMessage('Saved the deployment host to memory/infra/host.md.');
  });
  t.after(async () => { await store.gateway.close(context).catch(() => undefined); });
  {
    const origin = await store.gateway.conversationFor(SESSION, context);
    await closedEpisode(store.gateway.harness, origin.id, [
      user(`Remember this: ${FACT_LINE}`),
      assistant('Noted the deployment host.'),
    ]);

    started = await startDigest(store.gateway);
    assert.equal(started.status, 'started', JSON.stringify(started));
    assert.equal(started.evidenceEntries, 2, 'both the user and assistant fragments are evidence');
    await within(firstTurn.promise, WAIT_MS, 'the digest turn never started');
    assert.deepEqual(inspectedTools, ['read', 'write', 'edit'], 'the live target holds only curated Markdown tools');
    releaseFirstTurn.resolve();

    const task = await settleTask(store.gateway.harness, started.taskId);
    assert.equal(task.kind, MEMORY_DIGEST_TASK_NAME);
    assert.equal(task.state.outcome.status, 'completed');
    assert.equal(task.state.outcome.result.outcome, 'digested');
    assert.equal(task.state.outcome.result.consumed, true);
    assert.equal(task.state.outcome.result.evidenceEntries, 2);

    // The evidence is bounded into the run's own transcript, never copied into the task record.
    assert.equal(transcriptText(task.input).includes(FACT), false, 'the task record holds the batch identity, not its evidence');
    const target = await targetOf(store.gateway.harness, started.taskId);
    assert.ok(target !== undefined, 'the run owns one target conversation');
    const inputs = await digestInputs(store.gateway.harness, target.id);
    assert.equal(inputs.length, 1, 'one bounded model input');
    assert.match(messageText(inputs[0].model?.[0]), /entry \d+ \| owner message \| durable kind pi\.user/);

    // The fact is in plain workspace Markdown, and the seeded prompt is an ordinary file.
    assert.match(await readFile(join(fixture.workspace, 'memory/infra/host.md'), 'utf8'), new RegExp(FACT));
    assert.match(await readFile(join(fixture.workspace, MEMORY_DIGEST_PROMPT_FILE), 'utf8'), /# Memory digestion policy/);

    // The frontier advanced to the committed batch end and the chunk state was cleared.
    const cursor = await cursorDoc(store.gateway.harness, origin.id);
    assert.equal(cursor.throughEntryId, started.throughEntryId);
    assert.equal(cursor.episodeStartEntryId, null);
    assert.equal(cursor.episodeEndEntryId, null);

    // No user/channel message and no cron delivery were produced, and a successful run notifies
    // nobody: no internal result event, so no extra origin-agent model turn.
    const originHandle = await store.gateway.harness.conversation(origin.id, context);
    const originNotices = async () => (await originHandle.entries({ order: 'ascending' }, 100, undefined, context))
      .items.filter((entry) => entry.kind === MEMORY_DIGEST_RESULT_ENTRY_KIND);
    assert.deepEqual(await store.gateway.cronOutbox.list(SESSION, context), []);

    // Authority is retired in the terminal commit.
    assert.equal(await store.gateway.harness.snapshot(ConfigToolCaptureDoc, target.id, context), undefined);
    const state = await store.gateway.harness.snapshot(AgentDoc, target.id, context);
    assert.deepEqual((state.tools ?? []).map((tool) => (typeof tool === 'string' ? tool : tool.name)), []);

    // A second start finds nothing pending: idle, with a complete scan, and no new task. It also
    // flushes retained notices once, so no delivery path is left unexercised.
    const idle = await startDigest(store.gateway);
    assert.equal(idle.status, 'idle');
    assert.equal(idle.idle.caughtUp, true);
    assert.deepEqual(await originNotices(), [], 'a successful run delivers no internal result event');
    await originHandle.waitForIdle(context);
    assert.equal(store.calls.length, 2,
      'the digest tool round and its answer were the only model requests; success is silent');
    const status = await store.gateway.memoryDigest.status({
      id: origin.id,
      commit: (change, ctx) => origin.commit(change, ctx),
    }, context);
    assert.equal(status.latest.outcome, 'digested', 'the successful outcome stays visible in status');
    assert.equal(status.pendingNotices, 0);
  }
});

test('a chunk with no evidence advances the cursor without a provider call', { timeout: 30_000 }, async (t) => {
  const fixture = await fixtureWorkspace();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const store = await openStore(fixture, () => fauxAssistantMessage('unexpected model request', {
    stopReason: 'error',
    errorMessage: 'unexpected model request',
  }));
  t.after(async () => { await store.gateway.close(context).catch(() => undefined); });
  {
    const origin = await store.gateway.conversationFor(SESSION, context);
    await closedEpisode(store.gateway.harness, origin.id, [system('boot')]);
    const started = await startDigest(store.gateway);
    assert.equal(started.status, 'started');
    assert.equal(started.evidenceEntries, 0);
    const task = await settleTask(store.gateway.harness, started.taskId);
    assert.equal(task.state.outcome.status, 'completed');
    assert.equal(task.state.outcome.result.outcome, 'noop');
    assert.equal(task.state.outcome.result.consumed, true);
    // A successful no-op notifies nobody, so it makes no model request at all.
    const originHandle = await store.gateway.harness.conversation(origin.id, context);
    const originNotices = (await originHandle.entries({ order: 'ascending' }, 100, undefined, context)).items
      .filter((entry) => entry.kind === MEMORY_DIGEST_RESULT_ENTRY_KIND);
    assert.deepEqual(originNotices, [], 'a successful no-op delivers no internal result event');
    assert.equal((await startDigest(store.gateway)).status, 'idle', 'the no-op advanced the frontier');
    await originHandle.waitForIdle(context);
    assert.equal(store.calls.length, 0, 'a successful no-op run makes no model request');
    const cursor = await cursorDoc(store.gateway.harness, origin.id);
    assert.equal(cursor.throughEntryId, started.throughEntryId);
  }
});

test('nothing pending starts nothing; an empty allowlist is refused, not widened', { timeout: 30_000 }, async (t) => {
  const idleFixture = await fixtureWorkspace();
  const emptyFixture = await fixtureWorkspace();
  t.after(() => rm(idleFixture.directory, { recursive: true, force: true }));
  t.after(() => rm(emptyFixture.directory, { recursive: true, force: true }));
  const unexpected = () => fauxAssistantMessage('unexpected model request', {
    stopReason: 'error',
    errorMessage: 'unexpected model request',
  });
  const store = await openStore(idleFixture, unexpected);
  const empty = await openStore(emptyFixture, unexpected, { toolAllowlist: [] });
  t.after(async () => {
    await store.gateway.close(context).catch(() => undefined);
    await empty.gateway.close(context).catch(() => undefined);
  });
  const idleOrigin = await store.gateway.conversationFor(SESSION, context);
  const idle = await startDigest(store.gateway);
  assert.equal(idle.status, 'idle');
  assert.equal(idle.idle.caughtUp, true);
  assert.equal(store.calls.length, 0);

  // The root conversation is never a source, even with a closed episode of its own.
  const root = await store.gateway.harness.root(context);
  await closedEpisode(store.gateway.harness, root.id, [user('ROOT-SECRET-4471'), assistant('root answer')]);
  const stillIdle = await startDigest(store.gateway);
  assert.equal(stillIdle.status, 'idle', 'the root transcript is not digest evidence');

  // A mapped chat with a real closed episode, but an empty tool allowlist: refused before any task.
  const emptyOrigin = await empty.gateway.conversationFor(SESSION, context);
  await closedEpisode(empty.gateway.harness, emptyOrigin.id, [user('A durable fact.'), assistant('Noted.')]);
  const refused = await startDigest(empty.gateway);
  assert.equal(refused.status, 'refused');
  assert.match(refused.reason, /toolAllowlist/);
  assert.equal(empty.calls.length, 0);
  assert.equal(await cursorDoc(empty.gateway.harness, emptyOrigin.id), undefined, 'a refusal writes no cursor');
});

test('a partial write survives a failed turn, and the replay reads and compares before completing', { timeout: 30_000 }, async (t) => {
  const fixture = await fixtureWorkspace();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const state = { run: 1 };
  const store = await openStore(fixture, (request) => {
    const text = transcriptText(request.messages);
    if (state.run === 1) {
      if (!text.includes('memory/topics/host.md')) {
        return toolWrite('memory/topics/host.md', `- ${FACT_LINE}\n`, 'write-fact-1');
      }
      // Non-retryable, so the turn fails once and leaves the frontier alone.
      return fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'synthetic curation failure' });
    }
    const input = lastUserText(request.messages);
    assert.match(input, new RegExp(FACT), 'the replayed batch carries the same evidence');
    if (!text.includes('read-fact')) {
      // The replay inspects what already landed instead of writing again.
      return fauxAssistantMessage([fauxToolCall('read', { path: 'memory/topics/host.md' }, { id: 'read-fact' })], { stopReason: 'toolUse' });
    }
    assert.match(text, new RegExp(FACT), 'the replay saw the retained fact');
    return fauxAssistantMessage('The fact was already recorded in memory/topics/host.md; nothing was duplicated.');
  });
  t.after(async () => { await store.gateway.close(context).catch(() => undefined); });
  {
    const origin = await store.gateway.conversationFor(SESSION, context);
    await closedEpisode(store.gateway.harness, origin.id, [user(FACT_LINE), assistant('Noted.')]);

    const first = await startDigest(store.gateway);
    assert.equal(first.status, 'started');
    const failed = await settleTask(store.gateway.harness, first.taskId);
    assert.equal(failed.state.outcome.status, 'failed');
    assert.match(failed.state.outcome.error.message, /model_error/);
    assert.equal(failed.state.outcome.result.consumed, false);
    assert.equal(await cursorDoc(store.gateway.harness, origin.id), undefined, 'a failed turn writes no cursor');
    state.run = 2;
    // The write that already landed is preserved, not rolled back.
    assert.equal((await readFile(join(fixture.workspace, 'memory/topics/host.md'), 'utf8')).match(new RegExp(FACT, 'g')).length, 1);

    const second = await startDigest(store.gateway);
    assert.equal(second.status, 'started');
    assert.equal(second.throughEntryId, first.throughEntryId, 'the same unacknowledged batch is offered again');
    const completed = await settleTask(store.gateway.harness, second.taskId);
    assert.equal(completed.state.outcome.status, 'completed', JSON.stringify(completed.state.outcome));
    assert.equal(completed.state.outcome.result.outcome, 'digested');
    assert.match(completed.state.outcome.result.answer, /already recorded/);
    const body = await readFile(join(fixture.workspace, 'memory/topics/host.md'), 'utf8');
    assert.equal(body.match(new RegExp(FACT, 'g')).length, 1, 'the replay did not duplicate the fact');
    assert.equal((await cursorDoc(store.gateway.harness, origin.id)).throughEntryId, second.throughEntryId);
    const target = await targetOf(store.gateway.harness, second.taskId);
    const results = await toolResults(store.gateway.harness, target.id);
    assert.deepEqual(results.map((result) => [result.name, result.isError]), [['read', false]],
      'the replay succeeded by reading the retained fact, with no failed call');
  }
});

test('a refused, create-only or stale call fails the batch, and only a clean turn advances', { timeout: 40_000 }, async (t) => {
  const fixture = await fixtureWorkspace();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const existing = 'memory/topics/deploy.md';
  await mkdir(join(fixture.workspace, 'memory/topics'), { recursive: true });
  await writeFile(join(fixture.workspace, existing), '---\ndescription: Deploy notes\n---\n\nOWNER-ORIGINAL\n', 'utf8');
  await writeFile(join(fixture.workspace, 'AGENTS.md'), 'AGENT-RULES-KEEP\n', 'utf8');
  const state = { run: 1 };
  const store = await openStore(fixture, (request) => {
    const text = transcriptText(request.messages);
    if (state.run === 1) {
      if (!text.includes('write-outside')) return toolWrite('AGENTS.md', 'REPLACED-RULES\n', 'write-outside');
      return fauxAssistantMessage('I could not save the fact because that file is out of scope.');
    }
    if (state.run === 2) {
      if (!text.includes('write-existing')) return toolWrite(existing, 'REPLACED-BY-WRITE\n', 'write-existing');
      return fauxAssistantMessage('I could not save the fact because the file already exists.');
    }
    if (state.run === 3) {
      if (!text.includes('edit-stale')) return toolEdit(existing, 'STALE-OLD-TEXT', `never\n`, 'edit-stale');
      return fauxAssistantMessage('I could not save the fact because the old text had changed.');
    }
    if (!text.includes('edit-exact')) {
      return toolEdit(existing, 'OWNER-ORIGINAL', `OWNER-ORIGINAL\n\n- ${FACT_LINE}`, 'edit-exact');
    }
    return fauxAssistantMessage('Added the deployment fact with an exact edit.');
  });
  t.after(async () => { await store.gateway.close(context).catch(() => undefined); });
  {
    const origin = await store.gateway.conversationFor(SESSION, context);
    await closedEpisode(store.gateway.harness, origin.id, [user(FACT_LINE), assistant('Noted.')]);

    // 1. A refused write outside the curation scope fails the batch even though the model answers.
    const first = await startDigest(store.gateway);
    assert.equal(first.status, 'started');
    const refused = await settleTask(store.gateway.harness, first.taskId);
    assert.equal(refused.state.outcome.status, 'failed');
    assert.match(refused.state.outcome.error.message, /tool call failed/);
    assert.equal(refused.state.outcome.result.consumed, false);
    assert.equal(await cursorDoc(store.gateway.harness, origin.id), undefined);
    assert.equal(await readFile(join(fixture.workspace, 'AGENTS.md'), 'utf8'), 'AGENT-RULES-KEEP\n');

    // 2. A create-only refusal against an existing file fails the batch and changes nothing.
    state.run = 2;
    const second = await startDigest(store.gateway);
    assert.equal(second.status, 'started');
    const createOnly = await settleTask(store.gateway.harness, second.taskId);
    assert.equal(createOnly.state.outcome.status, 'failed');
    assert.match(createOnly.state.outcome.error.message, /tool call failed/);
    assert.equal(await cursorDoc(store.gateway.harness, origin.id), undefined);
    assert.match(await readFile(join(fixture.workspace, existing), 'utf8'), /OWNER-ORIGINAL/);
    assert.doesNotMatch(await readFile(join(fixture.workspace, existing), 'utf8'), /REPLACED-BY-WRITE/);

    // 3. A stale edit (the owner's text moved) fails the batch instead of overwriting it.
    state.run = 3;
    const third = await startDigest(store.gateway);
    assert.equal(third.status, 'started');
    const stale = await settleTask(store.gateway.harness, third.taskId);
    assert.equal(stale.state.outcome.status, 'failed');
    assert.match(stale.state.outcome.error.message, /tool call failed/);
    assert.equal(await cursorDoc(store.gateway.harness, origin.id), undefined);
    assert.match(await readFile(join(fixture.workspace, existing), 'utf8'), /OWNER-ORIGINAL/);

    // 4. A clean turn with an exact edit and a non-empty report advances the frontier.
    state.run = 4;
    const fourth = await startDigest(store.gateway);
    assert.equal(fourth.status, 'started');
    const completed = await settleTask(store.gateway.harness, fourth.taskId);
    assert.equal(completed.state.outcome.status, 'completed', JSON.stringify(completed.state.outcome));
    assert.equal(completed.state.outcome.result.outcome, 'digested');
    const body = await readFile(join(fixture.workspace, existing), 'utf8');
    assert.match(body, /OWNER-ORIGINAL/);
    assert.match(body, new RegExp(FACT));
    assert.equal(body.match(new RegExp(FACT, 'g')).length, 1);
    assert.equal((await cursorDoc(store.gateway.harness, origin.id)).throughEntryId, fourth.throughEntryId);
    const target = await targetOf(store.gateway.harness, fourth.taskId);
    const results = await toolResults(store.gateway.harness, target.id);
    assert.deepEqual(results.map((result) => [result.name, result.isError]), [['edit', false]],
      'the successful turn made exactly one clean edit');
  }
});

test('a concurrent create between the decision and the write is never overwritten', { timeout: 30_000 }, async (t) => {
  const fixture = await fixtureWorkspace();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const target = 'memory/topics/race.md';
  await mkdir(join(fixture.workspace, 'memory/topics'), { recursive: true });
  const store = await openStore(fixture, async (request) => {
    const text = transcriptText(request.messages);
    if (!text.includes('race-write')) {
      // Another writer creates the file after the model decided to write and before the call runs.
      await writeFile(join(fixture.workspace, target), 'CONCURRENT-OWNER-CONTENT\n', 'utf8');
      return toolWrite(target, `- ${FACT_LINE}\n`, 'race-write');
    }
    return fauxAssistantMessage('I could not save the fact because the file appeared concurrently.');
  });
  t.after(async () => { await store.gateway.close(context).catch(() => undefined); });
  {
    const origin = await store.gateway.conversationFor(SESSION, context);
    await closedEpisode(store.gateway.harness, origin.id, [user(FACT_LINE), assistant('Noted.')]);
    const started = await startDigest(store.gateway);
    assert.equal(started.status, 'started');
    const task = await settleTask(store.gateway.harness, started.taskId);
    assert.equal(task.state.outcome.status, 'failed');
    assert.match(task.state.outcome.error.message, /tool call failed/);
    assert.equal(await cursorDoc(store.gateway.harness, origin.id), undefined);
    // The exclusive create failed and the concurrent owner content is byte-for-byte intact.
    assert.equal(await readFile(join(fixture.workspace, target), 'utf8'), 'CONCURRENT-OWNER-CONTENT\n');
    const digestTarget = await targetOf(store.gateway.harness, started.taskId);
    const results = await toolResults(store.gateway.harness, digestTarget.id);
    assert.equal(results.length, 1);
    assert.equal(results[0].isError, true);
    assert.match(results[0].text, /create-only in memory digestion/);
  }
});

test('an empty final report fails the batch even after a successful write', { timeout: 30_000 }, async (t) => {
  const fixture = await fixtureWorkspace();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const store = await openStore(fixture, (request) => {
    const text = transcriptText(request.messages);
    if (!text.includes('memory/topics/host.md')) {
      return toolWrite('memory/topics/host.md', `- ${FACT_LINE}\n`, 'write-fact');
    }
    return fauxAssistantMessage('   ');
  });
  t.after(async () => { await store.gateway.close(context).catch(() => undefined); });
  {
    const origin = await store.gateway.conversationFor(SESSION, context);
    await closedEpisode(store.gateway.harness, origin.id, [user(FACT_LINE), assistant('Noted.')]);
    const started = await startDigest(store.gateway);
    assert.equal(started.status, 'started');
    const task = await settleTask(store.gateway.harness, started.taskId);
    assert.equal(task.state.outcome.status, 'failed');
    assert.match(task.state.outcome.error.message, /no final report/);
    assert.equal(task.state.outcome.result.consumed, false);
    assert.equal(task.state.outcome.result.answer, null);
    assert.equal(await cursorDoc(store.gateway.harness, origin.id), undefined);
    // The write remains, honestly unacknowledged, for a later replay to inspect.
    assert.match(await readFile(join(fixture.workspace, 'memory/topics/host.md'), 'utf8'), new RegExp(FACT));
  }
});

test('cancellation keeps the frontier and retires the target authority', { timeout: 30_000 }, async (t) => {
  const fixture = await fixtureWorkspace();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const entered = deferred();
  const store = await openStore(fixture, async (request, options) => {
    entered.resolve();
    await new Promise((resolve) => {
      const signal = options?.signal;
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', resolve, { once: true });
    });
    return fauxAssistantMessage('late answer');
  });
  t.after(async () => { await store.gateway.close(context).catch(() => undefined); });
  {
    const origin = await store.gateway.conversationFor(SESSION, context);
    await closedEpisode(store.gateway.harness, origin.id, [user(FACT_LINE), assistant('Noted.')]);
    const started = await startDigest(store.gateway);
    assert.equal(started.status, 'started');
    await within(entered.promise, WAIT_MS, 'the digest turn never reached the provider');
    await waitFor(async () => (await targetOf(store.gateway.harness, started.taskId)) !== undefined, 'the target conversation');
    const target = await targetOf(store.gateway.harness, started.taskId);
    await store.gateway.harness.abortTask(started.taskId, context);
    const task = await settleTask(store.gateway.harness, started.taskId);
    assert.equal(task.state.outcome.status, 'aborted');
    assert.equal(task.state.outcome.result.consumed, false);
    assert.equal(await cursorDoc(store.gateway.harness, origin.id), undefined, 'cancellation writes no cursor');
    assert.equal(await store.gateway.harness.snapshot(ConfigToolCaptureDoc, target.id, context), undefined);
    const state = await store.gateway.harness.snapshot(AgentDoc, target.id, context);
    assert.deepEqual(state.tools ?? [], []);
  }
});

test('an expired turn deadline fails without advancing the frontier', { timeout: 30_000 }, async (t) => {
  const fixture = await fixtureWorkspace();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const entered = deferred();
  const store = await openStore(fixture, async (request, options) => {
    entered.resolve();
    await new Promise((resolve) => {
      const signal = options?.signal;
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', resolve, { once: true });
    });
    return fauxAssistantMessage('too late');
  }, {}, { memoryDigest: { turnTimeoutMs: 1_500 } });
  t.after(async () => { await store.gateway.close(context).catch(() => undefined); });
  {
    const origin = await store.gateway.conversationFor(SESSION, context);
    await closedEpisode(store.gateway.harness, origin.id, [user(FACT_LINE), assistant('Noted.')]);
    const started = await startDigest(store.gateway);
    assert.equal(started.status, 'started');
    await within(entered.promise, WAIT_MS, 'the bounded turn never reached the provider');
    const task = await settleTask(store.gateway.harness, started.taskId);
    assert.equal(task.state.outcome.status, 'failed');
    assert.match(task.state.outcome.error.message, /time budget/);
    assert.equal(task.state.outcome.result.consumed, false);
    assert.equal(await cursorDoc(store.gateway.harness, origin.id), undefined, 'a timeout writes no cursor');
  }
});

test('a non-empty no-op report advances the cursor and never clobbers the owner prompt', { timeout: 30_000 }, async (t) => {
  const fixture = await fixtureWorkspace();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const custom = '# Owner curation prompt\n\nCUSTOM-PROMPT-9931 keep only decisions.\n';
  await writeFile(join(fixture.workspace, MEMORY_DIGEST_PROMPT_FILE), custom, 'utf8');
  const store = await openStore(fixture, (request) => {
    assert.match(lastUserText(request.messages), /CUSTOM-PROMPT-9931/);
    return fauxAssistantMessage('No durable fact in this batch.');
  });
  t.after(async () => { await store.gateway.close(context).catch(() => undefined); });
  {
    const origin = await store.gateway.conversationFor(SESSION, context);
    await closedEpisode(store.gateway.harness, origin.id, [user('Small talk with no durable fact.'), assistant('Sure.')]);
    const started = await startDigest(store.gateway);
    assert.equal(started.status, 'started');
    const task = await settleTask(store.gateway.harness, started.taskId);
    assert.equal(task.state.outcome.status, 'completed');
    assert.equal(task.state.outcome.result.outcome, 'digested');
    assert.match(task.state.outcome.result.answer, /No durable fact in this batch/,
      'the completed turn kept its explicit non-empty no-op report');
    assert.equal((await cursorDoc(store.gateway.harness, origin.id)).throughEntryId, started.throughEntryId,
      'a settled turn that saved nothing still counts as processed');
    assert.equal(await readFile(join(fixture.workspace, MEMORY_DIGEST_PROMPT_FILE), 'utf8'), custom,
      'the owner prompt is byte-for-byte untouched');
  }
});

test('a reopen resumes the interrupted run with its pinned model and curation scope', { timeout: 40_000 }, async (t) => {
  const fixture = await fixtureWorkspace();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const entered = deferred();
  const store = await openStore(fixture, async (request, options, model) => {
    assert.equal(model.id, ALT_MODEL.modelId, 'the digest run uses the origin model selected at start');
    const text = transcriptText(request.messages);
    if (!text.includes('memory/topics/reopen.md')) {
      return toolWrite('memory/topics/reopen.md', `- ${FACT_LINE}\n`, 'write-before-close');
    }
    entered.resolve();
    await new Promise((resolve) => {
      const signal = options?.signal;
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', resolve, { once: true });
    });
    return fauxAssistantMessage('answer after reopen');
  }, { allowedModels: [MODEL, ALT_MODEL] });
  let reopened;
  t.after(async () => {
    await reopened?.close(context).catch(() => undefined);
    await store.gateway.close(context).catch(() => undefined);
  });
  {
    const origin = await store.gateway.conversationFor(SESSION, context);
    // A temporary per-chat model switch must be pinned into the run and survive the reopen,
    // instead of silently reverting to the configured default in the middle of the batch.
    await store.gateway.selectModel(SESSION, ALT_MODEL, context);
    await closedEpisode(store.gateway.harness, origin.id, [user(FACT_LINE), assistant('Noted.')]);
    const started = await startDigest(store.gateway);
    assert.equal(started.status, 'started');
    await within(entered.promise, WAIT_MS, 'the first attempt never wrote and paused');
    assert.match(await readFile(join(fixture.workspace, 'memory/topics/reopen.md'), 'utf8'), new RegExp(FACT));
    const target = await targetOf(store.gateway.harness, started.taskId);
    assert.ok(target !== undefined);
    assert.equal(await cursorDoc(store.gateway.harness, origin.id), undefined, 'the interrupted attempt never acknowledged');

    await store.gateway.close(context);
    // Reopen the same store with a fresh faux provider. The live digest task resumes before the
    // queued child input runs again, so its pinned model and curation tools must be restored from
    // the task rather than the configured default.
    const reopenedStore = await openStore(fixture, (request, _options, model) => {
      assert.equal(model.id, ALT_MODEL.modelId, 'the reopened run keeps its pinned model');
      const input = lastUserText(request.messages);
      assert.match(input, /\[memory digestion task\]/, 'the resumed turn keeps its bounded batch input');
      const text = transcriptText(request.messages);
      if (!text.includes('read-after-reopen')) {
        // The resumed turn inspects the fact its interrupted attempt already wrote.
        return fauxAssistantMessage([fauxToolCall('read', { path: 'memory/topics/reopen.md' }, { id: 'read-after-reopen' })], { stopReason: 'toolUse' });
      }
      return fauxAssistantMessage('Resumed after reopen; the fact was already recorded and was not duplicated.');
    }, { allowedModels: [MODEL, ALT_MODEL] });
    reopened = reopenedStore.gateway;
    const task = await settleTask(reopened.harness, started.taskId);
    assert.equal(task.state.outcome.status, 'completed', JSON.stringify(task.state.outcome));
    assert.equal(task.state.outcome.result.outcome, 'digested');
    assert.equal(task.state.outcome.result.consumed, true);
    const after = await cursorDoc(reopened.harness, origin.id);
    assert.equal(after.throughEntryId, started.throughEntryId);
    const body = await readFile(join(fixture.workspace, 'memory/topics/reopen.md'), 'utf8');
    assert.equal(body.match(new RegExp(FACT, 'g')).length, 1, 'the reopened turn could not duplicate the fact');
    const results = await toolResults(reopened.harness, target.id);
    assert.deepEqual(results.map((result) => [result.name, result.isError]),
      [['write', false], ['read', false]],
      'the first attempt wrote once and the reopened target read it back, both clean');
  }
});

test('a failed tool call before a reopen still fails the resumed attempt', { timeout: 40_000 }, async (t) => {
  const fixture = await fixtureWorkspace();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const entered = deferred();
  await writeFile(join(fixture.workspace, 'AGENTS.md'), 'AGENT-RULES-KEEP\n', 'utf8');
  const store = await openStore(fixture, async (request, options) => {
    const text = transcriptText(request.messages);
    if (!text.includes('write-outside-before-close')) {
      // A refused write is committed as a failed pi.tool-result before the attempt is interrupted.
      return toolWrite('AGENTS.md', 'REPLACED-RULES\n', 'write-outside-before-close');
    }
    entered.resolve();
    await new Promise((resolve) => {
      const signal = options?.signal;
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', resolve, { once: true });
    });
    return fauxAssistantMessage('answer after reopen');
  });
  let reopened;
  t.after(async () => {
    await reopened?.close(context).catch(() => undefined);
    await store.gateway.close(context).catch(() => undefined);
  });
  {
    const origin = await store.gateway.conversationFor(SESSION, context);
    await closedEpisode(store.gateway.harness, origin.id, [user(FACT_LINE), assistant('Noted.')]);
    const started = await startDigest(store.gateway);
    assert.equal(started.status, 'started');
    await within(entered.promise, WAIT_MS, 'the first attempt never paused after its refused call');
    const target = await targetOf(store.gateway.harness, started.taskId);
    assert.ok(target !== undefined);
    assert.equal(await cursorDoc(store.gateway.harness, origin.id), undefined);

    await store.gateway.close(context);
    reopened = (await openStore(fixture, () => {
      // The model recovers and answers non-empty, but the committed failed call still fails the batch.
      return fauxAssistantMessage('I could not save the fact because that file is out of scope.');
    })).gateway;
    const task = await settleTask(reopened.harness, started.taskId);
    assert.equal(task.state.outcome.status, 'failed', JSON.stringify(task.state.outcome));
    assert.match(task.state.outcome.error.message, /tool call failed/);
    assert.equal(task.state.outcome.result.consumed, false);
    assert.equal(await cursorDoc(reopened.harness, origin.id), undefined, 'a failed call never acknowledges on reopen');
    assert.equal(await readFile(join(fixture.workspace, 'AGENTS.md'), 'utf8'), 'AGENT-RULES-KEEP\n');
  }
});
