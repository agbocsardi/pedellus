// Configurable memory-digestion bounds: batch size, tool-call budget, run deadline and the write
// budget. These checks run the real Gateway over a faux provider and a disposable synthetic
// workspace. They cover config validation and plumbing into the accepted task, the native call-time
// tool-call cap (refused calls included), the changed-file and changed-text refusals before a
// mutation, budget persistence across a replay/reopen, no parallel overshoot, and the one native
// parked-task retry an ordinary start performs.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const packageRoot = process.env.PI_NANOBOT_CANDIDATE ?? new URL('../', import.meta.url).pathname;
const modules = join(packageRoot, 'node_modules/@earendil-works');
const [
  { parseConfig },
  { openGateway },
  {
    createMemoryDigest,
    MEMORY_DIGEST_RESULT_ENTRY_KIND,
  },
  { createDigestSource, DigestCursorDoc },
  { DIGEST_RUN_LIMITS_DEFAULT },
  { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall },
  { BACKGROUND_CONTEXT },
] = await Promise.all([
  import(new URL('../dist/config.js', import.meta.url).href),
  import(new URL('../dist/runtime.js', import.meta.url).href),
  import(new URL('../dist/history/memory-digest.js', import.meta.url).href),
  import(new URL('../dist/history/digestion.js', import.meta.url).href),
  import(new URL('../dist/history/digest-limits.js', import.meta.url).href),
  import(`${modules}/pi-ai/dist/index.js`),
  import(`${modules}/chord/dist/context/index.js`),
]);

const context = BACKGROUND_CONTEXT;
const WAIT_MS = 15_000;
const SESSION = 'cli:memory-digest-bounds';
const PROVIDER = 'digest-bounds-faux';
const MODEL = { provider: PROVIDER, modelId: 'synthetic' };

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
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-digest-bounds-'));
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
    episodeSummary: { enabled: false },
    ...overrides,
  }, fixture.directory);
}

async function openStore(fixture, script, overrides = {}, openOptions = {}) {
  const faux = fauxProvider({
    provider: PROVIDER,
    models: [{ id: MODEL.modelId, name: 'Synthetic digest model' }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const calls = [];
  const dispatcher = (request, options, _state, model) => {
    faux.appendResponses([dispatcher]);
    const input = lastUserText(request.messages);
    calls.push(input);
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

function toolRead(path, id) {
  return fauxAssistantMessage([fauxToolCall('read', { path }, { id })], { stopReason: 'toolUse' });
}

function toolWrite(path, content, id) {
  return fauxAssistantMessage([fauxToolCall('write', { path, content }, { id })], { stopReason: 'toolUse' });
}

function toolEdit(path, oldText, newText, id) {
  return fauxAssistantMessage([fauxToolCall('edit', { path, edits: [{ oldText, newText }] }, { id })], { stopReason: 'toolUse' });
}

test('digest config accepts only its six positive integer bounds and starts nothing by itself', () => {
  const fixture = { directory: tmpdir(), workspace: join(tmpdir(), 'digest-config-ws'), dataDir: join(tmpdir(), 'digest-config-data') };
  const base = { workspace: fixture.workspace, dataDir: fixture.dataDir, model: MODEL, toolAllowlist: [] };
  assert.equal(parseConfig(base, fixture.directory).digest, undefined, 'absent config keeps the defaults');
  const partial = parseConfig({
    ...base,
    digest: { entriesPerBatch: 4, maxToolCalls: 3, runTimeoutSeconds: 60 },
  }, fixture.directory);
  assert.deepEqual({ ...partial.digest }, { entriesPerBatch: 4, maxToolCalls: 3, runTimeoutSeconds: 60 });
  for (const bad of [
    { enabled: true },
    { intervalSeconds: 60 },
    { entriesPerBatch: 0 },
    { charsPerBatch: -1 },
    { maxToolCalls: 1.5 },
    { maxChangedFiles: '8' },
    { maxDiffChars: null },
    { runTimeoutSeconds: 0 },
  ]) {
    assert.throws(
      () => parseConfig({ ...base, digest: bad }, fixture.directory),
      (error) => error instanceof Error && /digest/.test(error.message),
      `digest ${JSON.stringify(bad)} must be rejected`,
    );
  }
});

test('configured batch bounds reach the source and are captured in the accepted task', { timeout: 30_000 }, async (t) => {
  const fixture = await fixtureWorkspace();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const store = await openStore(fixture, () => fauxAssistantMessage('No durable fact in this batch.'), {
    digest: {
      entriesPerBatch: 2,
      charsPerBatch: 40,
      maxToolCalls: 4,
      runTimeoutSeconds: 120,
      maxChangedFiles: 1,
      maxDiffChars: 1_000,
    },
  });
  t.after(async () => { await store.gateway.close(context).catch(() => undefined); });
  const origin = await store.gateway.conversationFor(SESSION, context);
  await closedEpisode(store.gateway.harness, origin.id, [
    user('A'.repeat(30)),
    user('B'.repeat(30)),
    user('C'.repeat(30)),
  ]);

  // The source honours a batch bound at read and at re-derivation; a different bound set is rejected
  // instead of silently producing a wider chunk.
  const source = createDigestSource({
    harness: store.gateway.harness,
    sessions: async () => [{ sessionKey: SESSION, conversationId: origin.id }],
    limits: { entriesPerBatch: 1, charsPerBatch: 5 },
  });
  const configured = await source.read(context);
  assert.equal(configured.status, 'batch');
  assert.equal(configured.entries.length, 1);
  assert.equal(configured.entries[0].text.length, 5);
  const ref = {
    sessionKey: configured.sessionKey,
    conversationId: configured.conversationId,
    episodeStartEntryId: configured.episodeStartEntryId,
    episodeEndEntryId: configured.episodeEndEntryId,
    firstEntryId: configured.firstEntryId,
    firstTextStart: configured.firstTextStart,
    throughEntryId: configured.throughEntryId,
    throughChars: configured.throughChars,
    complete: configured.complete,
    cursor: configured.cursor,
  };
  const replayed = await source.readBatch(ref, context, { entriesPerBatch: 1, charsPerBatch: 5 });
  assert.deepEqual(replayed.entries, configured.entries);
  await assert.rejects(
    source.readBatch(ref, context, { entriesPerBatch: 80, charsPerBatch: 24_000 }),
    /no longer matches/,
  );

  // A new start uses the configured batch and records every accepted bound in the task input.
  const started = await startDigest(store.gateway);
  assert.equal(started.status, 'started');
  assert.equal(started.evidenceEntries, 2, 'two entries fit the configured entry and character bounds');
  const task = await taskOf(store.gateway.harness, started.taskId);
  assert.deepEqual({ ...task.input.limits }, {
    entriesPerBatch: 2,
    charsPerBatch: 40,
    maxToolCalls: 4,
    runTimeoutMs: 120_000,
    maxChangedFiles: 1,
    maxDiffChars: 1_000,
  });
  assert.equal((await settleTask(store.gateway.harness, started.taskId)).state.outcome.result.outcome, 'digested');
});

test('exact tool-call and changed-file bounds admit one clean run and stay silent', { timeout: 30_000 }, async (t) => {
  const fixture = await fixtureWorkspace();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  await writeFile(join(fixture.workspace, 'SOUL.md'), 'owner rules\n', 'utf8');
  const store = await openStore(fixture, (request) => {
    const text = transcriptText(request.messages);
    if (!text.includes('read-soul')) return toolRead('SOUL.md', 'read-soul');
    if (!text.includes('write-one')) return toolWrite('memory/one.md', '- ADDED-FACT-19\n', 'write-one');
    return fauxAssistantMessage('Recorded the fact in memory/one.md.');
  }, { digest: { maxToolCalls: 2, maxChangedFiles: 1, maxDiffChars: 1_000 } });
  t.after(async () => { await store.gateway.close(context).catch(() => undefined); });
  const origin = await store.gateway.conversationFor(SESSION, context);
  await closedEpisode(store.gateway.harness, origin.id, [user('ADDED-FACT-19'), assistant('Noted.')]);

  const started = await startDigest(store.gateway);
  assert.equal(started.status, 'started');
  const task = await settleTask(store.gateway.harness, started.taskId);
  assert.equal(task.state.outcome.status, 'completed', JSON.stringify(task.state.outcome));
  assert.equal(task.state.outcome.result.outcome, 'digested');
  assert.match(await readFile(join(fixture.workspace, 'memory/one.md'), 'utf8'), /ADDED-FACT-19/);
  assert.equal((await cursorDoc(store.gateway.harness, origin.id)).throughEntryId, started.throughEntryId);
  // A successful run notifies nobody: only the two digest requests reached the provider.
  const originHandle = await store.gateway.harness.conversation(origin.id, context);
  const notices = (await originHandle.entries({ order: 'ascending' }, 100, undefined, context)).items
    .filter((entry) => entry.kind === MEMORY_DIGEST_RESULT_ENTRY_KIND);
  assert.deepEqual(notices, []);
  await originHandle.waitForIdle(context);
  assert.equal(store.calls.length, 3, 'two tool rounds and the answer are the only requests');
});

test('the tool-call cap counts a refused call and fails the batch without a cursor move', { timeout: 30_000 }, async (t) => {
  const fixture = await fixtureWorkspace();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  await writeFile(join(fixture.workspace, 'SOUL.md'), 'owner rules\n', 'utf8');
  await writeFile(join(fixture.workspace, 'AGENTS.md'), 'AGENT-RULES-KEEP\n', 'utf8');
  const store = await openStore(fixture, (request) => {
    const text = transcriptText(request.messages);
    if (!text.includes('read-first')) return toolRead('SOUL.md', 'read-first');
    if (!text.includes('write-outside')) return toolWrite('AGENTS.md', 'REPLACED\n', 'write-outside');
    if (!text.includes('write-over-budget')) return toolWrite('memory/ok.md', '- fact\n', 'write-over-budget');
    return fauxAssistantMessage('The last write was blocked.');
  }, { digest: { maxToolCalls: 2 } });
  t.after(async () => { await store.gateway.close(context).catch(() => undefined); });
  const origin = await store.gateway.conversationFor(SESSION, context);
  await closedEpisode(store.gateway.harness, origin.id, [user('A durable fact.'), assistant('Noted.')]);

  const started = await startDigest(store.gateway);
  assert.equal(started.status, 'started');
  const task = await settleTask(store.gateway.harness, started.taskId);
  assert.equal(task.state.outcome.status, 'failed');
  assert.match(task.state.outcome.error.message, /tool call failed/);
  assert.equal(task.state.outcome.result.consumed, false);
  assert.equal(await cursorDoc(store.gateway.harness, origin.id), undefined, 'a refused budget writes no cursor');
  assert.equal(await readFile(join(fixture.workspace, 'AGENTS.md'), 'utf8'), 'AGENT-RULES-KEEP\n');
  assert.equal(await exists(join(fixture.workspace, 'memory/ok.md')), false, 'the over-budget mutation never ran');
  const target = await targetOf(store.gateway.harness, started.taskId);
  const results = await toolResults(store.gateway.harness, target.id);
  assert.deepEqual(results.map((result) => [result.name, result.isError]), [
    ['read', false],
    ['write', true],
    ['write', true],
  ]);
  assert.match(results[2].text, /tool-call budget/, 'the refused call still used one of the two calls');
});

test('changed-file and changed-text bounds refuse before mutation, including repeated file edits', { timeout: 40_000 }, async (t) => {
  const filesFixture = await fixtureWorkspace();
  const diffFixture = await fixtureWorkspace();
  t.after(() => rm(filesFixture.directory, { recursive: true, force: true }));
  t.after(() => rm(diffFixture.directory, { recursive: true, force: true }));
  const filesStore = await openStore(filesFixture, (request) => {
    const text = transcriptText(request.messages);
    if (!text.includes('write-a')) return toolWrite('memory/a.md', '- a\n', 'write-a');
    if (!text.includes('write-b')) return toolWrite('memory/b.md', '- b\n', 'write-b');
    return fauxAssistantMessage('Stopped after the changed-file budget refused the second file.');
  }, { digest: { maxChangedFiles: 1 } });
  const original = '0123456789ab';
  const diffStore = await openStore(diffFixture, (request) => {
    const text = transcriptText(request.messages);
    if (!text.includes('write-c')) return toolWrite('memory/c.md', original, 'write-c');
    if (!text.includes('edit-c')) return toolEdit('memory/c.md', original, `${original}!`, 'edit-c');
    return fauxAssistantMessage('Stopped after the changed-text budget refused the second edit.');
  }, { digest: { maxDiffChars: 20 } });
  t.after(async () => {
    await filesStore.gateway.close(context).catch(() => undefined);
    await diffStore.gateway.close(context).catch(() => undefined);
  });

  {
    const origin = await filesStore.gateway.conversationFor(SESSION, context);
    await closedEpisode(filesStore.gateway.harness, origin.id, [user('Two files would exceed the bound.'), assistant('Noted.')]);
    const started = await startDigest(filesStore.gateway);
    const task = await settleTask(filesStore.gateway.harness, started.taskId);
    assert.equal(task.state.outcome.status, 'failed');
    assert.match(task.state.outcome.error.message, /tool call failed/);
    assert.equal(await cursorDoc(filesStore.gateway.harness, origin.id), undefined);
    assert.equal(await exists(join(filesFixture.workspace, 'memory/a.md')), true);
    assert.equal(await exists(join(filesFixture.workspace, 'memory/b.md')), false, 'the second file was refused before it was created');
    const target = await targetOf(filesStore.gateway.harness, started.taskId);
    const results = await toolResults(filesStore.gateway.harness, target.id);
    assert.match(results.at(-1).text, /changed-file budget/);
  }

  {
    const origin = await diffStore.gateway.conversationFor(SESSION, context);
    await closedEpisode(diffStore.gateway.harness, origin.id, [user('A repeated edit would exceed the text bound.'), assistant('Noted.')]);
    const started = await startDigest(diffStore.gateway);
    const task = await settleTask(diffStore.gateway.harness, started.taskId);
    assert.equal(task.state.outcome.status, 'failed');
    assert.match(task.state.outcome.error.message, /tool call failed/);
    assert.equal(await cursorDoc(diffStore.gateway.harness, origin.id), undefined);
    // The successful create charged 12 inserted characters; the edit's 12 removed + 13 inserted
    // would exceed 20, so it never touched the file.
    assert.equal(await readFile(join(diffFixture.workspace, 'memory/c.md'), 'utf8'), original);
    const target = await targetOf(diffStore.gateway.harness, started.taskId);
    const results = await toolResults(diffStore.gateway.harness, target.id);
    assert.match(results.at(-1).text, /changed-text budget/);
  }
});

test('parallel mutation calls cannot exceed the changed-file bound', { timeout: 30_000 }, async (t) => {
  const fixture = await fixtureWorkspace();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const store = await openStore(fixture, (request) => {
    const text = transcriptText(request.messages);
    if (!text.includes('parallel-a')) {
      return fauxAssistantMessage([
        fauxToolCall('write', { path: 'memory/parallel-a.md', content: '- a\n' }, { id: 'parallel-a' }),
        fauxToolCall('write', { path: 'memory/parallel-b.md', content: '- b\n' }, { id: 'parallel-b' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('The parallel writes were refused.');
  }, { digest: { maxChangedFiles: 1 } });
  t.after(async () => { await store.gateway.close(context).catch(() => undefined); });
  const origin = await store.gateway.conversationFor(SESSION, context);
  await closedEpisode(store.gateway.harness, origin.id, [user('Two parallel files exceed one.'), assistant('Noted.')]);
  const started = await startDigest(store.gateway);
  const task = await settleTask(store.gateway.harness, started.taskId);
  assert.equal(task.state.outcome.status, 'failed');
  assert.equal(await cursorDoc(store.gateway.harness, origin.id), undefined);
  const created = [
    await exists(join(fixture.workspace, 'memory/parallel-a.md')),
    await exists(join(fixture.workspace, 'memory/parallel-b.md')),
  ].filter(Boolean).length;
  assert.ok(created <= 1, `a parallel round must not exceed the one-file bound, created ${created}`);
  const target = await targetOf(store.gateway.harness, started.taskId);
  const results = await toolResults(store.gateway.harness, target.id);
  assert.equal(results.length, 2, 'both calls settled');
  assert.ok(results.some((result) => result.isError), 'the round could not pass as a successful curation');
});

test('a replay after reopen keeps the tool-call budget it already spent', { timeout: 40_000 }, async (t) => {
  const fixture = await fixtureWorkspace();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  await writeFile(join(fixture.workspace, 'SOUL.md'), 'owner rules\n', 'utf8');
  const entered = deferred();
  const store = await openStore(fixture, async (request, options) => {
    const text = transcriptText(request.messages);
    if (!text.includes('read-once')) return toolRead('SOUL.md', 'read-once');
    entered.resolve();
    await new Promise((resolve) => {
      const signal = options?.signal;
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', resolve, { once: true });
    });
    return fauxAssistantMessage('interrupted');
  }, { digest: { maxToolCalls: 1 } });
  let reopened;
  t.after(async () => {
    await reopened?.close(context).catch(() => undefined);
    await store.gateway.close(context).catch(() => undefined);
  });
  const origin = await store.gateway.conversationFor(SESSION, context);
  await closedEpisode(store.gateway.harness, origin.id, [user('A durable fact.'), assistant('Noted.')]);
  const started = await startDigest(store.gateway);
  assert.equal(started.status, 'started');
  await within(entered.promise, WAIT_MS, 'the first attempt never spent its read call');

  await store.gateway.close(context);
  const reopenedStore = await openStore(fixture, (request) => {
    if (transcriptText(request.messages).includes('write-after-reopen')) {
      return fauxAssistantMessage('The write was blocked by the spent budget.');
    }
    return toolWrite('memory/after-reopen.md', '- fact\n', 'write-after-reopen');
  }, {
    digest: { maxToolCalls: 1 },
  });
  reopened = reopenedStore.gateway;
  const task = await settleTask(reopened.harness, started.taskId);
  assert.equal(task.state.outcome.status, 'failed', JSON.stringify(task.state.outcome));
  assert.match(task.state.outcome.error.message, /tool call failed/);
  assert.equal(task.state.outcome.result.consumed, false);
  assert.equal(await cursorDoc(reopened.harness, origin.id), undefined, 'a resumed over-budget turn writes no cursor');
  assert.equal(await exists(join(fixture.workspace, 'memory/after-reopen.md')), false);
  const target = await targetOf(reopened.harness, started.taskId);
  const results = await toolResults(reopened.harness, target.id);
  assert.match(results.at(-1).text, /tool-call budget/, 'the read call already counted before the reopen');
});

test('a product-configured run deadline wins over the host test seam, which fills only its absence', { timeout: 30_000 }, async (t) => {
  const configuredFixture = await fixtureWorkspace();
  const seamFixture = await fixtureWorkspace();
  t.after(() => rm(configuredFixture.directory, { recursive: true, force: true }));
  t.after(() => rm(seamFixture.directory, { recursive: true, force: true }));
  const hanging = async (request, options) => {
    await new Promise((resolve) => {
      const signal = options?.signal;
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', resolve, { once: true });
    });
    return fauxAssistantMessage('late');
  };
  const configured = await openStore(configuredFixture, hanging,
    { digest: { runTimeoutSeconds: 300 } },
    { memoryDigest: { turnTimeoutMs: 5_000 } });
  const seam = await openStore(seamFixture, hanging, {}, { memoryDigest: { turnTimeoutMs: 5_000 } });
  t.after(async () => {
    await configured.gateway.close(context).catch(() => undefined);
    await seam.gateway.close(context).catch(() => undefined);
  });

  const inspectAndAbort = async (store, fixture, expectedMs) => {
    const origin = await store.gateway.conversationFor(SESSION, context);
    await closedEpisode(store.gateway.harness, origin.id, [user('Timeout bound.'), assistant('Noted.')]);
    const started = await startDigest(store.gateway);
    assert.equal(started.status, 'started');
    const task = await taskOf(store.gateway.harness, started.taskId);
    assert.equal(task.input.limits.runTimeoutMs, expectedMs);
    assert.deepEqual({ ...task.input.limits }, {
      ...DIGEST_RUN_LIMITS_DEFAULT,
      runTimeoutMs: expectedMs,
    }, `${fixture} keeps every other shared default`);
    await store.gateway.harness.abortTask(started.taskId, context);
    await settleTask(store.gateway.harness, started.taskId);
  };
  await inspectAndAbort(configured, 'config', 300_000);
  await inspectAndAbort(seam, 'seam', 5_000);
});

test('an ordinary start retries a live digest task once through the native call and stays busy', { timeout: 15_000 }, async () => {
  let inCommit = false;
  const retries = [];
  let sourceReads = 0;
  const harness = {
    async commit(change) {
      inCommit = true;
      try {
        return await change({ scanTasks: async () => ({ items: [{ id: 42 }] }) });
      } finally {
        inCommit = false;
      }
    },
    async retryTask(taskId) {
      assert.equal(inCommit, false, 'retryTask runs outside the start commit');
      retries.push(taskId);
    },
  };
  const digest = createMemoryDigest({
    harness: () => harness,
    source: () => ({
      read: async () => { sourceReads += 1; throw new Error('a busy start reads no batch'); },
      cursor: async () => { throw new Error('unused'); },
      readBatch: async () => { throw new Error('unused'); },
      acknowledge: async () => { throw new Error('unused'); },
    }),
    workspaceRoot: join(tmpdir(), 'digest-parked-workspace'),
    now: () => 0,
    model: async () => ({ model: { provider: 'synthetic', modelId: 'synthetic' }, thinkingLevel: 'off' }),
    allowModel: () => true,
    curationTools: () => ['read', 'write', 'edit'],
    prepare: async () => undefined,
    finalize: async () => undefined,
  });
  const writer = {
    id: 1,
    commit: async () => { throw new Error('a busy start commits nothing'); },
  };
  assert.deepEqual(await digest.start(writer, context), { status: 'busy', taskId: 42 });
  assert.deepEqual(retries, [42], 'one retry for this invocation');
  assert.deepEqual(await digest.start(writer, context), { status: 'busy', taskId: 42 });
  assert.deepEqual(retries, [42, 42], 'one retry per ordinary invocation, never a loop');
  assert.equal(sourceReads, 0, 'a live task is never joined by a second writer');
});
