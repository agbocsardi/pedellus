// Manual and scheduled memory digestion over the accepted O2 execution.
//
// These checks use the real Gateway, a faux provider and a disposable synthetic workspace. They
// cover: no activation on open or in configuration; the local CLI `/digest` host command through
// the private socket; bounded status; successful runs (including a no-op) staying silent while a
// failure or cancellation reports exactly one internal issue event, including a reopen retry that
// the request ID deduplicates and a legacy pending success that is never delivered; prompt freshness
// (a new batch reads the edited DIGEST.md, an in-flight attempt keeps its admitted text); idle
// pending versus complete wording; an ordinary cron job with explicit digest intent that calls the
// same native entry once, leaves scheduling to the timer, captures the mapped origin and current
// allowlist, and refuses after a narrowed reopen; and native cancellation leaving cursor and
// authority unchanged.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';

const packageRoot = process.env.PI_NANOBOT_CANDIDATE ?? new URL('../', import.meta.url).pathname;
const modules = join(packageRoot, 'node_modules/@earendil-works');
const [
  { parseConfig },
  { openGateway },
  {
    MEMORY_DIGEST_ENTRY_KIND,
    MEMORY_DIGEST_LIMITS,
    MEMORY_DIGEST_NOTICE_FULL_REASON,
    MEMORY_DIGEST_NOTICES_KIND,
    MEMORY_DIGEST_PROMPT_FILE,
    MEMORY_DIGEST_RESULT_ENTRY_KIND,
    MEMORY_DIGEST_RESULT_REQUEST_PREFIX,
    MEMORY_DIGEST_TASK_NAME,
    MemoryDigestNoticesDoc,
    memoryDigestNoticeState,
    renderMemoryDigestStart,
    renderMemoryDigestStatus,
  },
  { DigestCursorDoc },
  { CronJobsDoc, CRON_RUN_TASK_NAME },
  { ConfigToolCaptureDoc },
  { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall },
  { BACKGROUND_CONTEXT },
  { prepareDataDirectory },
  { gatewaySocketPath, serveLocalGateway },
  { connectLocalGateway },
  { runTerminalConversation },
] = await Promise.all([
  import(new URL('../dist/config.js', import.meta.url).href),
  import(new URL('../dist/runtime.js', import.meta.url).href),
  import(new URL('../dist/history/memory-digest.js', import.meta.url).href),
  import(new URL('../dist/history/digestion.js', import.meta.url).href),
  import(new URL('../dist/automation/cron.js', import.meta.url).href),
  import(new URL('../dist/tools/index.js', import.meta.url).href),
  import(`${modules}/pi-ai/dist/index.js`),
  import(`${modules}/chord/dist/context/index.js`),
  import(new URL('../dist/store.js', import.meta.url).href),
  import(new URL('../dist/local/server.js', import.meta.url).href),
  import(new URL('../dist/local/client.js', import.meta.url).href),
  import(new URL('../dist/terminal/index.js', import.meta.url).href),
]);

const context = BACKGROUND_CONTEXT;
const WAIT_MS = 15_000;
const SESSION = 'cli:memory-digest-controls';
const CRON_SESSION = 'cli:memory-digest-cron';
const PROVIDER = 'digest-controls-faux';
const MODEL = { provider: PROVIDER, modelId: 'synthetic' };
const FACT = 'DIGEST-CONTROL-8814';

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

async function waitForValue(predicate, label) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
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
    if (messages[index].role === 'user') return messageText(messages[index]);
  }
  return '';
}

async function fixtureWorkspace() {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-digest-controls-'));
  const workspace = join(directory, 'workspace');
  const dataDir = join(directory, 'state');
  await mkdir(workspace, { recursive: true });
  return { directory, workspace, dataDir };
}

function configFor(fixture, overrides = {}) {
  const { digest, ...rest } = overrides;
  return parseConfig({
    workspace: fixture.workspace,
    dataDir: fixture.dataDir,
    model: MODEL,
    allowedModels: [MODEL],
    toolAllowlist: ['read', 'write', 'edit'],
    // An explicit background model is required; the foreground conversation's is never inherited.
    digest: { model: MODEL, ...(digest ?? {}) },
    episodeSummary: { enabled: false },
    ...rest,
  }, fixture.directory);
}

/**
 * Real Gateway over a faux dispatcher. Digest batch requests and the internal issue-report turns are
 * distinguished, so a script only ever sees the batch it is meant to answer.
 */
async function openStore(fixture, script, overrides = {}, openOptions = {}) {
  const faux = fauxProvider({ provider: PROVIDER, models: [{ id: MODEL.modelId, name: 'Synthetic digest model' }] });
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
  const config = configFor(fixture, overrides);
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

async function entriesOf(harness, conversationId) {
  const conversation = await harness.conversation(conversationId, context);
  assert.ok(conversation !== undefined);
  return (await conversation.entries({ order: 'ascending' }, 300, undefined, context)).items;
}

async function digestNotices(harness, conversationId) {
  return (await entriesOf(harness, conversationId))
    .filter((entry) => entry.kind === MEMORY_DIGEST_RESULT_ENTRY_KIND);
}

async function digestInputs(harness, taskId) {
  const target = await harness.commit(async (tx) => {
    const page = await tx.scanConversations({ ownerTaskId: taskId }, 5);
    return page.items.find((conversation) => conversation.owner?.taskId === taskId);
  }, context);
  if (target === undefined) return [];
  return (await entriesOf(harness, target.id))
    .filter((entry) => entry.kind === MEMORY_DIGEST_ENTRY_KIND);
}

async function digestTasks(harness, conversationId) {
  return harness.commit(async (tx) => {
    const query = conversationId === undefined
      ? { kind: MEMORY_DIGEST_TASK_NAME, order: 'descending' }
      : { conversationId, kind: MEMORY_DIGEST_TASK_NAME, order: 'descending' };
    return (await tx.scanTasks(query, 20)).items;
  }, context);
}

async function startDigest(gateway, sessionKey = SESSION) {
  const origin = await gateway.conversationFor(sessionKey, context);
  return gateway.memoryDigest.start({
    id: origin.id,
    commit: (change, ctx) => origin.commit(change, ctx),
  }, context);
}

async function statusOf(gateway, sessionKey = SESSION) {
  const origin = await gateway.conversationFor(sessionKey, context);
  return gateway.memoryDigest.status({
    id: origin.id,
    commit: (change, ctx) => origin.commit(change, ctx),
  }, context);
}

async function settleTask(harness, taskId) {
  await waitFor(async () => (await harness.getTask(taskId, context))?.state.status === 'terminal', `task ${taskId}`);
  return harness.getTask(taskId, context);
}

/** Wait until the origin's own turn (including an internal issue-report turn) has settled. */
async function originIdle(harness, conversationId) {
  const conversation = await harness.conversation(conversationId, context);
  assert.ok(conversation !== undefined);
  await conversation.waitForIdle(context);
}

const answerNothing = () => fauxAssistantMessage('No durable fact in this batch.');

test('opening or configuring the gateway starts no digest run, task or schedule', { timeout: 30_000 }, async (t) => {
  const fixture = await fixtureWorkspace();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const store = await openStore(fixture, () => {
    throw new Error('no model request is expected before an explicit invocation');
  });
  t.after(async () => { await store.gateway.close(context).catch(() => undefined); });
  const origin = await store.gateway.conversationFor(SESSION, context);
  await closedEpisode(store.gateway.harness, origin.id, [user(FACT), assistant('Noted.')]);

  // No run, no task, no cron document and no report: configuration alone is inert.
  assert.deepEqual(await digestTasks(store.gateway.harness), []);
  assert.equal(await store.gateway.harness.snapshot(CronJobsDoc, origin.id, context), undefined);
  assert.deepEqual(await store.gateway.cronOutbox.list(SESSION, context), []);
  assert.deepEqual(await digestNotices(store.gateway.harness, origin.id), []);
  assert.equal(store.calls.length, 0);
  const status = await statusOf(store.gateway);
  assert.equal(status.liveTaskId, null);
  assert.equal(status.latest, null);
  assert.equal(status.pendingNotices, 0);
  assert.equal(
    await store.gateway.harness.snapshot(MemoryDigestNoticesDoc, origin.id, context),
    undefined,
    'a fresh read-only status creates no notice document',
  );

  // The owner prompt is seeded by a run, not by startup.
  await assert.rejects(readFile(join(fixture.workspace, MEMORY_DIGEST_PROMPT_FILE), 'utf8'));

  // No cron timer or run task exists either: digest intent needs an explicit job.
  const cronTasks = await store.gateway.harness.commit(async (tx) =>
    (await tx.scanTasks({}, 100)).items.filter((task) =>
      task.kind === 'nanobot.cron.timer' || task.kind === 'nanobot.cron.run'), context);
  assert.deepEqual(cronTasks, []);
});

test('the local CLI /digest starts one batch and reports bounded status', { timeout: 40_000 }, async (t) => {
  const fixture = await fixtureWorkspace();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const store = await openStore(fixture, answerNothing);
  t.after(async () => { await store.gateway.close(context).catch(() => undefined); });
  const origin = await store.gateway.conversationFor(SESSION, context);
  await closedEpisode(store.gateway.harness, origin.id, [user(`Remember ${FACT}`), assistant('Noted.')]);

  const prepared = await prepareDataDirectory(store.config);
  const server = await serveLocalGateway({
    socketPath: gatewaySocketPath(prepared.canonicalDataDir),
    gateway: store.gateway,
    context,
    tools: ['read', 'write', 'edit'],
    contextRefresh: false,
    presets: false,
  });
  const client = await connectLocalGateway({
    socketPath: gatewaySocketPath(prepared.canonicalDataDir),
    conversation: 'memory-digest-controls',
    context,
  });
  t.after(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  });
  assert.equal(client.digest, true, 'the local host exposes the manual entry');
  assert.equal((await digestTasks(store.gateway.harness)).length, 0, 'attaching starts nothing');

  const chunks = [];
  const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); } });
  const input = (async function* () {
    yield '/digest';
    yield '/digest status';
  })();
  await within(runTerminalConversation(client, context, {
    input,
    output,
    errorOutput: output,
    digest: {
      start: () => client.digestStart(context),
      status: () => client.digestStatus(context),
    },
  }), WAIT_MS, 'the CLI /digest commands');
  const text = chunks.join('');
  assert.match(text, /started for one bounded completed-exchange batch/);
  assert.match(text, /shared workspace/);
  assert.match(text, /Newest run: \d+ \((digested|running)\)/);
  assert.match(text, /Status is read-only/);
  assert.equal(chunks.join('').includes(FACT), false, 'the host acknowledgement never echoes evidence');

  const task = await waitForValue(async () => {
    const [candidate] = await digestTasks(store.gateway.harness, origin.id);
    return candidate !== undefined && candidate.state.status === 'terminal' ? candidate : undefined;
  }, 'the CLI-started digest task');
  assert.equal(task.state.outcome.result.outcome, 'digested');
  // A successful run is silent: it delivers no internal result event and so no origin-agent turn.
  assert.equal((await digestNotices(store.gateway.harness, origin.id)).length, 0);
  const status = await statusOf(store.gateway);
  assert.equal(status.latest.taskId, Number(task.id));
  assert.equal(status.latest.outcome, 'digested', 'status still shows the successful outcome');
  assert.equal(status.pendingNotices, 0);

  // With nothing pending, a second /digest reports a complete scan and starts nothing.
  assert.equal((await startDigest(store.gateway)).status, 'idle');
});

test('an idle scan that did not reach every chat never claims that everything is done', () => {
  const pending = renderMemoryDigestStart({
    status: 'idle',
    idle: { caughtUp: false, examinedChats: 2, postponedChats: 1, unfinishedChats: 1, missingChats: 1 },
  });
  assert.match(pending, /did not reach the tail of every mapped chat/);
  assert.match(pending, /completed history may remain pending/);
  assert.doesNotMatch(pending, /No completed exchange is pending/);
  const complete = renderMemoryDigestStart({
    status: 'idle',
    idle: { caughtUp: true, examinedChats: 3, postponedChats: 0, unfinishedChats: 0, missingChats: 0 },
  });
  assert.match(complete, /No completed exchange is pending/);
  assert.match(complete, /No new digest run was started/);
  assert.doesNotMatch(complete, /no model was called/);
});

test('a successful run stays silent while a failure reports once and a reopen deduplicates', { timeout: 40_000 }, async (t) => {
  const fixture = await fixtureWorkspace();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const state = { fail: false };
  const store = await openStore(fixture, () => (state.fail
    ? fauxAssistantMessage('provider unavailable', { stopReason: 'error', errorMessage: 'provider unavailable' })
    : answerNothing()));
  const origin = await store.gateway.conversationFor(SESSION, context);
  await closedEpisode(store.gateway.harness, origin.id, [user('Small talk.'), assistant('Sure.')]);

  const first = await startDigest(store.gateway);
  assert.equal(first.status, 'started');
  const firstTask = await settleTask(store.gateway.harness, first.taskId);
  assert.equal(firstTask.state.outcome.status, 'completed');
  await originIdle(store.gateway.harness, origin.id);
  assert.equal((await digestNotices(store.gateway.harness, origin.id)).length, 0,
    'a successful run delivers no internal result event');
  const successRecords = await store.gateway.harness.snapshot(MemoryDigestNoticesDoc, origin.id, context);
  assert.deepEqual(successRecords?.notices, [{ taskId: first.taskId, notified: false }],
    'the write-ahead record survives, unreported and safe to prune');
  assert.equal(store.calls.length, 1, 'the successful batch was the only model request');

  // A fresh closed episode is owed; the first batch's frontier is already advanced.
  await closedEpisode(store.gateway.harness, origin.id, [user('Second small talk.'), assistant('Sure.')]);
  state.fail = true;
  const second = await startDigest(store.gateway);
  assert.equal(second.status, 'started');
  const secondTask = await settleTask(store.gateway.harness, second.taskId);
  assert.equal(secondTask.state.outcome.status, 'failed');
  assert.equal(secondTask.state.outcome.result.consumed, false);
  await waitFor(async () => (await digestNotices(store.gateway.harness, origin.id)).length === 1, 'one failure report');
  const failureNotice = (await digestNotices(store.gateway.harness, origin.id))[0];
  assert.match(messageText(failureNotice.model?.[0]), /settled: failed/);
  assert.match(messageText(failureNotice.model?.[0]), /frontier is unchanged/);
  assert.equal(failureNotice.data?.taskId, second.taskId, 'the failure is the reported run');
  await originIdle(store.gateway.harness, origin.id);

  // Simulate a crash between the terminal commit and the notice admission, then reopen. The legacy
  // pending success must never be delivered; the failure re-admits under the same request ID
  // instead of duplicating the origin agent's turn.
  await store.gateway.harness.commit(async (tx) => {
    const doc = await tx.doc(MemoryDigestNoticesDoc, origin.id);
    for (const notice of doc.notices) notice.notified = false;
    return undefined;
  }, context);
  const callsBefore = store.calls.length;
  await store.gateway.close(context);
  const reopened = await openGateway(store.config, context, { models: store.models });
  t.after(async () => { await reopened.close(context).catch(() => undefined); });
  await originIdle(reopened.harness, origin.id);
  const notices = await reopened.harness.snapshot(MemoryDigestNoticesDoc, origin.id, context);
  assert.equal(notices.notices.find((notice) => notice.taskId === first.taskId)?.notified, false,
    'the legacy pending success is neither delivered nor marked reported');
  assert.equal(notices.notices.find((notice) => notice.taskId === second.taskId)?.notified, true,
    'the failure is the only reported outcome');
  assert.equal((await digestNotices(reopened.harness, origin.id)).length, 1,
    'the reopen retried the issue admission and the request ID deduplicated it');
  assert.equal(store.calls.length, callsBefore, 'the reopen started no new origin-agent turn');
  const status = await statusOf(reopened);
  assert.equal(status.pendingNotices, 0, 'neither a success nor a reported issue holds a pending slot');
});

test('a full notice queue refuses a start without evicting an undelivered issue, then reopen retries once', { timeout: 60_000 }, async (t) => {
  const fixture = await fixtureWorkspace();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  // A failed run is an issue, so its report is a real delivery obligation.
  const store = await openStore(fixture, () => fauxAssistantMessage('provider unavailable', {
    stopReason: 'error',
    errorMessage: 'provider unavailable',
  }));
  const origin = await store.gateway.conversationFor(SESSION, context);
  await closedEpisode(store.gateway.harness, origin.id, [user('First closed episode.'), assistant('Noted.')]);

  // Controllable admission failure: the digest target and ordinary conversation lookup still work,
  // but submitting this origin's internal issue report throws until the patch is removed.
  const harness = store.gateway.harness;
  const originalConversation = harness.conversation.bind(harness);
  let denyNotice = true;
  harness.conversation = async (id, ctx) => {
    const handle = await originalConversation(id, ctx);
    if (!denyNotice || id !== origin.id || handle === undefined) return handle;
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'submit') {
          return async (draft, submitContext) => {
            if (draft?.entry?.kind === MEMORY_DIGEST_RESULT_ENTRY_KIND) {
              throw new Error('synthetic admission failure');
            }
            return target.submit(draft, submitContext);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };

  const started = await startDigest(store.gateway);
  assert.equal(started.status, 'started');
  const task = await settleTask(store.gateway.harness, started.taskId);
  assert.equal(task.state.outcome.status, 'failed');
  const noticeDoc = async (reader) => reader.snapshot(MemoryDigestNoticesDoc, origin.id, context);
  await waitFor(async () => {
    const current = await noticeDoc(store.gateway.harness);
    return current?.notices.some((notice) => notice.taskId === started.taskId && notice.notified === false) === true;
  }, 'the retained undelivered notice');
  const retained = await noticeDoc(store.gateway.harness);
  assert.equal(retained.notices.length, 1);
  const callsBeforeRefusal = store.calls.length;
  const cursorBefore = await store.gateway.harness.snapshot(DigestCursorDoc, origin.id, context);

  // Fill the bounded list with records whose native task is unknown: never evictable.
  const maxTaskId = await store.gateway.harness.commit(async (tx) => {
    let max = 0;
    let cursor;
    do {
      const page = await tx.scanTasks({}, 1000, cursor);
      for (const record of page.items) max = Math.max(max, Number(record.id));
      cursor = page.next;
    } while (cursor !== undefined);
    return max;
  }, context);
  await store.gateway.harness.commit(async (tx) => {
    const doc = await tx.doc(MemoryDigestNoticesDoc, origin.id);
    for (let index = doc.notices.length; index < MEMORY_DIGEST_LIMITS.noticeRecords; index += 1) {
      doc.notices.push({ taskId: maxTaskId + 10_000 + index, notified: false });
    }
    return undefined;
  }, context);
  assert.equal((await noticeDoc(store.gateway.harness)).notices.length, MEMORY_DIGEST_LIMITS.noticeRecords);

  // A fresh closed batch exists, but the notice queue has no safe slot: refuse before any scan
  // result is consumed, any task is created or any provider request is made.
  await closedEpisode(store.gateway.harness, origin.id, [user('Second closed episode.'), assistant('Noted.')]);
  const refused = await startDigest(store.gateway);
  assert.equal(refused.status, 'refused');
  assert.equal(refused.reason, MEMORY_DIGEST_NOTICE_FULL_REASON);
  assert.equal((await digestTasks(store.gateway.harness, origin.id)).length, 1, 'no task was created');
  assert.equal(store.calls.length, callsBeforeRefusal, 'a refused start made no model request');
  assert.deepEqual(
    await store.gateway.harness.snapshot(DigestCursorDoc, origin.id, context),
    cursorBefore,
    'a refused start leaves the digest cursor untouched',
  );
  const refusedStatus = await statusOf(store.gateway);
  assert.equal(refusedStatus.pendingNotices, MEMORY_DIGEST_LIMITS.noticeRecords);
  assert.equal(refusedStatus.canStart, false);
  assert.equal(refusedStatus.refusal, MEMORY_DIGEST_NOTICE_FULL_REASON);
  assert.match(renderMemoryDigestStatus(refusedStatus), /New starts are refused/);

  // Reopen: recover uses the authoritative terminal task, admits its result once, and the retry
  // leaves the shared cursor exactly where it was.
  await store.gateway.close(context);
  const reopened = await openGateway(store.config, context, { models: store.models });
  t.after(async () => { await reopened.close(context).catch(() => undefined); });
  await waitFor(async () => (await digestNotices(reopened.harness, origin.id)).length === 1, 'one recovered result');
  assert.deepEqual(
    await reopened.harness.snapshot(DigestCursorDoc, origin.id, context),
    cursorBefore,
    'notification recovery never advances or rewinds the digest cursor',
  );
  // Whether recovery could verify the placed entry immediately or had to leave it pending for a
  // queued admission, the next start flushes/verifies it, prunes only that record, and then has a
  // safe slot. The original task's event is still admitted exactly once.
  await originIdle(reopened.harness, origin.id);
  const next = await startDigest(reopened);
  assert.equal(next.status, 'started');
  const verified = await reopened.harness.snapshot(MemoryDigestNoticesDoc, origin.id, context);
  const verifiedNotice = verified.notices.find((notice) => notice.taskId === started.taskId);
  // It was verified reported and then evicted to make the slot; a surviving trace must be notified.
  assert.ok(verifiedNotice === undefined || verifiedNotice.notified === true);
  assert.equal((await statusOf(reopened)).pendingNotices, MEMORY_DIGEST_LIMITS.noticeRecords);
  await settleTask(reopened.harness, next.taskId);
  const resultEntries = async (reader) => (await entriesOf(reader, origin.id))
    .filter((entry) => entry.kind === MEMORY_DIGEST_RESULT_ENTRY_KIND);
  await waitFor(async () => (await resultEntries(reopened.harness)).length === 2, 'the second internal issue report');
  const originalNotices = (await resultEntries(reopened.harness))
    .filter((entry) => entry.data?.taskId === started.taskId);
  assert.equal(originalNotices.length, 1, 'a recovered admission is never duplicated');
});

test('a foreign input under the result request ID stays pending and visible, never reported', { timeout: 60_000 }, async (t) => {
  const fixture = await fixtureWorkspace();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  // Keep the real issue admission from landing, then remove its record to model the old eviction.
  const store = await openStore(fixture, () => fauxAssistantMessage('provider unavailable', {
    stopReason: 'error',
    errorMessage: 'provider unavailable',
  }));
  const origin = await store.gateway.conversationFor(SESSION, context);
  await closedEpisode(store.gateway.harness, origin.id, [user('First closed episode.'), assistant('Noted.')]);
  const harness = store.gateway.harness;
  const originalConversation = harness.conversation.bind(harness);
  let denyNotice = true;
  harness.conversation = async (id, ctx) => {
    const handle = await originalConversation(id, ctx);
    if (!denyNotice || id !== origin.id || handle === undefined) return handle;
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'submit') {
          return async (draft, submitContext) => {
            if (draft?.entry?.kind === MEMORY_DIGEST_RESULT_ENTRY_KIND) {
              throw new Error('synthetic admission failure');
            }
            return target.submit(draft, submitContext);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };

  const started = await startDigest(store.gateway);
  assert.equal(started.status, 'started');
  await settleTask(store.gateway.harness, started.taskId);
  await waitFor(async () => {
    const doc = await store.gateway.harness.snapshot(MemoryDigestNoticesDoc, origin.id, context);
    return doc?.notices.some((notice) => notice.taskId === started.taskId) === true;
  }, 'the retained notice');
  await store.gateway.harness.commit(async (tx) => {
    const doc = await tx.doc(MemoryDigestNoticesDoc, origin.id);
    doc.notices = doc.notices.filter((notice) => notice.taskId !== started.taskId);
    return undefined;
  }, context);

  // A host submits an ordinary user input under the exact internal request ID. Durable dedupes by
  // request ID only, so a later digest admission must not mistake this foreign entry for its own.
  const requestId = `${MEMORY_DIGEST_RESULT_REQUEST_PREFIX}${started.taskId}`;
  const originHandle = await store.gateway.harness.conversation(origin.id, context);
  const foreign = await originHandle.submit({
    type: 'input',
    content: 'foreign collision input',
    requestId,
  }, context);
  await foreign.wait(context);
  await originHandle.waitForIdle(context);
  denyNotice = false;

  await store.gateway.close(context);
  const reopened = await openGateway(store.config, context, { models: store.models });
  t.after(async () => { await reopened.close(context).catch(() => undefined); });
  // Recovery sees the authoritative terminal task with no record, finds the foreign entry under its
  // request ID, and must reconstruct a bounded pending record instead of claiming it was reported.
  const recovered = await waitForValue(async () => {
    const doc = await reopened.harness.snapshot(MemoryDigestNoticesDoc, origin.id, context);
    return doc?.notices.find((notice) => notice.taskId === started.taskId);
  }, 'the reconstructed pending notice');
  assert.equal(recovered.notified, false);
  assert.equal(
    (await digestNotices(reopened.harness, origin.id))
      .filter((entry) => entry.data?.taskId === started.taskId).length,
    0,
    'the foreign input is never reported as this digest result',
  );
  const status = await statusOf(reopened);
  assert.equal(status.pendingNotices, 1);
  assert.equal(status.canStart, true);

  // Fill the bounded list: the collided record is unknown to its request ID and is never evicted.
  const maxTaskId = await reopened.harness.commit(async (tx) => {
    let max = 0;
    let cursor;
    do {
      const page = await tx.scanTasks({}, 1000, cursor);
      for (const record of page.items) max = Math.max(max, Number(record.id));
      cursor = page.next;
    } while (cursor !== undefined);
    return max;
  }, context);
  await reopened.harness.commit(async (tx) => {
    const doc = await tx.doc(MemoryDigestNoticesDoc, origin.id);
    for (let index = doc.notices.length; index < MEMORY_DIGEST_LIMITS.noticeRecords; index += 1) {
      doc.notices.push({ taskId: maxTaskId + 10_000 + index, notified: false });
    }
    return undefined;
  }, context);
  await closedEpisode(reopened.harness, origin.id, [user('Second closed episode.'), assistant('Noted.')]);
  const callsBefore = store.calls.length;
  const refused = await startDigest(reopened);
  assert.equal(refused.status, 'refused');
  assert.equal(refused.reason, MEMORY_DIGEST_NOTICE_FULL_REASON);
  assert.equal(store.calls.length, callsBefore, 'the collision retry starts no new model turn');
  const after = await reopened.harness.snapshot(MemoryDigestNoticesDoc, origin.id, context);
  assert.equal(after.notices.find((notice) => notice.taskId === started.taskId)?.notified, false);
  assert.equal((await digestNotices(reopened.harness, origin.id))
    .filter((entry) => entry.data?.taskId === started.taskId).length, 0);
  const refusedStatus = await statusOf(reopened);
  assert.equal(refusedStatus.pendingNotices, MEMORY_DIGEST_LIMITS.noticeRecords);
  assert.equal(refusedStatus.canStart, false);
});

test('notice pruning only frees reported, successful or genuinely nonreportable outcomes', () => {
  const live = { state: { status: 'running' } };
  const faulted = { state: { status: 'terminal', outcome: { status: 'faulted', error: { message: 'x' } } } };
  const orphaned = { state: { status: 'terminal', outcome: { status: 'orphaned', reason: 'x' } } };
  const abortedWithResult = {
    state: { status: 'terminal', outcome: { status: 'aborted', reason: 'x', result: { outcome: 'aborted' } } },
  };
  const failedWithResult = {
    state: {
      status: 'terminal',
      outcome: { status: 'failed', error: { message: 'x' }, result: { outcome: 'failed' } },
    },
  };
  const digested = { state: { status: 'terminal', outcome: { status: 'completed', result: { outcome: 'digested' } } } };
  const noop = { state: { status: 'terminal', outcome: { status: 'completed', result: { outcome: 'noop' } } } };
  const consumed = { state: { status: 'terminal', outcome: { status: 'completed', result: { outcome: 'consumed' } } } };
  const completedWithoutResult = { state: { status: 'terminal', outcome: { status: 'completed' } } };
  const successUnderFailure = {
    state: { status: 'terminal', outcome: { status: 'failed', error: { message: 'x' }, result: { outcome: 'noop' } } },
  };
  const issueUnderCompletion = {
    state: { status: 'terminal', outcome: { status: 'completed', result: { outcome: 'failed' } } },
  };
  assert.equal(memoryDigestNoticeState({ notified: false }, undefined), 'unknown');
  assert.equal(memoryDigestNoticeState({ notified: false }, live), 'unknown');
  assert.equal(memoryDigestNoticeState({ notified: false }, {}), 'unknown');
  assert.equal(memoryDigestNoticeState({ notified: false }, completedWithoutResult), 'unknown');
  assert.equal(memoryDigestNoticeState({ notified: false }, faulted), 'nonreportable');
  assert.equal(memoryDigestNoticeState({ notified: false }, orphaned), 'nonreportable');
  assert.equal(memoryDigestNoticeState({ notified: false }, digested), 'nonreportable');
  assert.equal(memoryDigestNoticeState({ notified: false }, noop), 'nonreportable');
  assert.equal(memoryDigestNoticeState({ notified: false }, consumed), 'nonreportable');
  assert.equal(memoryDigestNoticeState({ notified: false }, successUnderFailure), 'unknown');
  assert.equal(memoryDigestNoticeState({ notified: false }, issueUnderCompletion), 'unknown');
  assert.equal(memoryDigestNoticeState({ notified: false }, failedWithResult), 'reportable');
  assert.equal(memoryDigestNoticeState({ notified: false }, abortedWithResult), 'reportable');
  assert.equal(memoryDigestNoticeState({ notified: true }, undefined), 'notified');
  assert.equal(memoryDigestNoticeState({ notified: true }, abortedWithResult), 'notified');
  assert.equal(memoryDigestNoticeState({ notified: true }, live), 'unknown');
  assert.equal(MEMORY_DIGEST_NOTICES_KIND, 'nanobot.memory-digest-notices');
});

test('a reopen keeps a successful run silent and reclaims its retained slot without evicting unknown records', { timeout: 40_000 }, async (t) => {
  const fixture = await fixtureWorkspace();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const store = await openStore(fixture, answerNothing);
  const origin = await store.gateway.conversationFor(SESSION, context);
  await closedEpisode(store.gateway.harness, origin.id, [user('Small talk.'), assistant('Sure.')]);
  const success = await startDigest(store.gateway);
  assert.equal(success.status, 'started');
  await settleTask(store.gateway.harness, success.taskId);
  await originIdle(store.gateway.harness, origin.id);
  const callsAfterSuccess = store.calls.length;
  assert.equal(callsAfterSuccess, 1, 'the successful batch was the only model request');

  // A prior version left this success record pending, as if its result still owed a delivery. It is
  // not an obligation: a reopen must not deliver it, and a start may free its slot.
  const noticeDoc = async (reader) => reader.snapshot(MemoryDigestNoticesDoc, origin.id, context);
  assert.deepEqual((await noticeDoc(store.gateway.harness)).notices, [{ taskId: success.taskId, notified: false }]);

  // Fill the bounded list with records whose native task is unknown: never evictable.
  const maxTaskId = await store.gateway.harness.commit(async (tx) => {
    let max = 0;
    let cursor;
    do {
      const page = await tx.scanTasks({}, 1000, cursor);
      for (const record of page.items) max = Math.max(max, Number(record.id));
      cursor = page.next;
    } while (cursor !== undefined);
    return max;
  }, context);
  await store.gateway.harness.commit(async (tx) => {
    const doc = await tx.doc(MemoryDigestNoticesDoc, origin.id);
    for (let index = doc.notices.length; index < MEMORY_DIGEST_LIMITS.noticeRecords; index += 1) {
      doc.notices.push({ taskId: maxTaskId + 10_000 + index, notified: false });
    }
    return undefined;
  }, context);
  assert.equal((await noticeDoc(store.gateway.harness)).notices.length, MEMORY_DIGEST_LIMITS.noticeRecords);
  const before = await statusOf(store.gateway);
  assert.equal(before.pendingNotices, MEMORY_DIGEST_LIMITS.noticeRecords - 1,
    'the successful record is not a pending delivery obligation');
  assert.equal(before.canStart, true);

  await store.gateway.close(context);
  const reopened = await openGateway(store.config, context, { models: store.models });
  t.after(async () => { await reopened.close(context).catch(() => undefined); });
  await originIdle(reopened.harness, origin.id);
  assert.equal(store.calls.length, callsAfterSuccess, 'opening and recovery delivered no successful run');
  assert.equal((await digestNotices(reopened.harness, origin.id)).length, 0);
  assert.equal((await noticeDoc(reopened.harness)).notices.find((notice) => notice.taskId === success.taskId)?.notified,
    false, 'the success record stays unreported');

  // A start reclaims exactly that slot. The unknown records stay retained, so nothing is silently
  // dropped to make room.
  await closedEpisode(reopened.harness, origin.id, [user('A second closed episode.'), assistant('Noted.')]);
  const next = await startDigest(reopened);
  assert.equal(next.status, 'started');
  const reclaimed = (await noticeDoc(reopened.harness)).notices;
  assert.equal(reclaimed.some((notice) => notice.taskId === success.taskId), false,
    'the successful record freed its slot');
  assert.equal(reclaimed.filter((notice) => notice.taskId > maxTaskId && notice.taskId !== next.taskId).length,
    MEMORY_DIGEST_LIMITS.noticeRecords - 1, 'no unknown record was evicted');
  assert.equal(reclaimed.find((notice) => notice.taskId === next.taskId)?.notified, false,
    'the new run has its own write-ahead record');
  await settleTask(reopened.harness, next.taskId);
});

test('a new batch reloads the edited DIGEST.md while an in-flight attempt keeps its admitted text', { timeout: 40_000 }, async (t) => {
  const fixture = await fixtureWorkspace();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const promptOne = '# Prompt one\n\nPROMPT-ONE-5510\n';
  const promptTwo = '# Prompt two\n\nPROMPT-TWO-8820\n';
  await writeFile(join(fixture.workspace, MEMORY_DIGEST_PROMPT_FILE), promptOne, 'utf8');
  const entered = deferred();
  const release = deferred();
  let hold = false;
  const store = await openStore(fixture, async (request) => {
    if (hold) {
      entered.resolve();
      await release.promise;
    }
    assert.match(lastUserText(request.messages), /PROMPT-/);
    return answerNothing();
  });
  t.after(async () => { await store.gateway.close(context).catch(() => undefined); });
  const origin = await store.gateway.conversationFor(SESSION, context);

  await closedEpisode(store.gateway.harness, origin.id, [user('First closed episode.'), assistant('Noted.')]);
  const first = await startDigest(store.gateway);
  assert.equal(first.status, 'started');
  await settleTask(store.gateway.harness, first.taskId);
  const [firstInput] = await digestInputs(store.gateway.harness, first.taskId);
  assert.match(messageText(firstInput.model?.[0]), /PROMPT-ONE-5510/);
  await originIdle(store.gateway.harness, origin.id);

  await writeFile(join(fixture.workspace, MEMORY_DIGEST_PROMPT_FILE), promptTwo, 'utf8');
  await closedEpisode(store.gateway.harness, origin.id, [user('Second closed episode.'), assistant('Noted.')]);
  hold = true;
  const second = await startDigest(store.gateway);
  assert.equal(second.status, 'started');
  await within(entered.promise, WAIT_MS, 'the second digest turn');
  // The attempt's input is already committed; an owner edit now applies to the next batch.
  await writeFile(join(fixture.workspace, MEMORY_DIGEST_PROMPT_FILE), `${promptTwo}\nPROMPT-LATE-3307\n`, 'utf8');
  release.resolve();
  hold = false;
  const secondTask = await settleTask(store.gateway.harness, second.taskId);
  assert.equal(secondTask.state.outcome.status, 'completed');
  const [secondInput] = await digestInputs(store.gateway.harness, second.taskId);
  const secondText = messageText(secondInput.model?.[0]);
  assert.match(secondText, /PROMPT-TWO-8820/);
  assert.doesNotMatch(secondText, /PROMPT-ONE-5510/);
  assert.doesNotMatch(secondText, /PROMPT-LATE-3307/);
  await originIdle(store.gateway.harness, origin.id);

  // A third new batch reads the latest owner text from disk.
  await closedEpisode(store.gateway.harness, origin.id, [user('Third closed episode.'), assistant('Noted.')]);
  const third = await startDigest(store.gateway);
  assert.equal(third.status, 'started');
  await settleTask(store.gateway.harness, third.taskId);
  const [thirdInput] = await digestInputs(store.gateway.harness, third.taskId);
  assert.match(messageText(thirdInput.model?.[0]), /PROMPT-LATE-3307/);
  assert.match(await readFile(join(fixture.workspace, MEMORY_DIGEST_PROMPT_FILE), 'utf8'), /PROMPT-LATE-3307/);
});

test('cancelling a digest task keeps the frontier and notifies exactly once', { timeout: 40_000 }, async (t) => {
  const fixture = await fixtureWorkspace();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const entered = deferred();
  const store = await openStore(fixture, (_request, options) => {
    entered.resolve();
    return new Promise((resolve) => {
      const signal = options?.signal;
      if (signal?.aborted) {
        resolve(answerNothing());
        return;
      }
      // Hold the provider request until the test cancels the native task.
      signal?.addEventListener('abort', () => resolve(answerNothing()), { once: true });
    });
  });
  t.after(async () => { await store.gateway.close(context).catch(() => undefined); });
  const origin = await store.gateway.conversationFor(SESSION, context);
  await closedEpisode(store.gateway.harness, origin.id, [user(`Remember ${FACT}`), assistant('Noted.')]);
  const started = await startDigest(store.gateway);
  assert.equal(started.status, 'started');
  await within(entered.promise, WAIT_MS, 'the digest turn');
  await store.gateway.harness.abortTask(started.taskId, context);
  const task = await settleTask(store.gateway.harness, started.taskId);
  assert.equal(task.state.outcome.status, 'aborted');
  assert.equal(task.state.outcome.result.consumed, false);
  assert.equal(await store.gateway.harness.snapshot(DigestCursorDoc, origin.id, context), undefined,
    'a cancellation moves no cursor');
  await waitFor(async () => (await digestNotices(store.gateway.harness, origin.id)).length === 1, 'one abort notice');
  assert.match(messageText((await digestNotices(store.gateway.harness, origin.id))[0].model?.[0]), /settled: aborted/);
  const target = await store.gateway.harness.commit(async (tx) => {
    const page = await tx.scanConversations({ ownerTaskId: started.taskId }, 5);
    return page.items[0];
  }, context);
  assert.equal(await store.gateway.harness.snapshot(ConfigToolCaptureDoc, target.id, context), undefined,
    'the cancelled target keeps no captured authority');
});

test('an explicit cron digest job calls the same entry once and leaves scheduling to the timer', { timeout: 40_000 }, async (t) => {
  const fixture = await fixtureWorkspace();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const originSession = CRON_SESSION;
  let scheduling = true;
  const store = await openStore(fixture, (request) => {
    const input = lastUserText(request.messages);
    if (scheduling && input.includes('Schedule a digest job')) {
      scheduling = false;
      return fauxAssistantMessage([
        fauxToolCall('cron', {
          action: 'add',
          intent: 'digest',
          name: 'recurring digest',
          every_seconds: 2,
        }, { id: 'cron-add-digest' }),
      ], { stopReason: 'toolUse' });
    }
    if (input.includes('Schedule a digest job')) return fauxAssistantMessage('Scheduled.');
    return answerNothing();
  }, { cron: { enabled: true } });
  t.after(async () => { await store.gateway.close(context).catch(() => undefined); });
  const origin = await store.gateway.conversationFor(originSession, context);
  await closedEpisode(store.gateway.harness, origin.id, [user(`Remember ${FACT}`), assistant('Noted.')]);

  const conversation = await store.gateway.harness.conversation(origin.id, context);
  const submission = await conversation.submit({ type: 'input', content: 'Schedule a digest job' }, context);
  await submission.wait(context);
  await conversation.waitForIdle(context);

  const jobs = async () => (await store.gateway.harness.snapshot(CronJobsDoc, origin.id, context)).jobs;
  await waitFor(async () => (await jobs()).length === 1, 'one digest job');
  const [job] = await jobs();
  assert.equal(job.intent, 'digest');
  assert.equal(job.mode, 'origin', 'a digest occurrence never uses a task-owned target');
  assert.equal(job.owner.sessionKey, originSession, 'the validated mapped origin is captured');

  await waitFor(async () => {
    const current = (await jobs())[0];
    return current.executionTaskId !== null && current.timerTaskId !== null;
  }, 'the timer admitted one execution and its successor');
  const admitted = (await jobs())[0];
  const executionId = admitted.executionTaskId;
  await store.gateway.harness.waitForTask(executionId, context);

  const [settled] = await jobs();
  assert.equal(settled.lastOutcome.status, 'ok');
  assert.notEqual(settled.timerTaskId, null, 'the next occurrence is armed by the timer commit');
  const nextTimer = await store.gateway.harness.getTask(settled.timerTaskId, context);
  assert.ok(nextTimer.input.scheduledAtMs > Date.now(), 'the reschedule is independent of the digest run');
  // Stop the next occurrence so this check leaves no sleeping timer behind.
  await store.gateway.harness.abortTask(settled.timerTaskId, context);
  await store.gateway.harness.waitForTask(settled.timerTaskId, context);

  const digestTask = await waitForValue(async () => {
    const [candidate] = await digestTasks(store.gateway.harness, origin.id);
    return candidate !== undefined && candidate.state.status === 'terminal' ? candidate : undefined;
  }, 'one cron-started digest task');
  assert.equal(digestTask.state.outcome.result.outcome, 'digested');
  assert.deepEqual(digestTask.input.model, MODEL, 'the digest model is pinned from the mapped origin');
  const run = await store.gateway.harness.getTask(executionId, context);
  assert.equal(run.kind, CRON_RUN_TASK_NAME);
  const owned = await store.gateway.harness.commit(async (tx) => {
    return (await tx.scanConversations({ ownerTaskId: executionId }, 5)).items;
  }, context);
  assert.deepEqual(owned, [], 'the digest cron run creates no task-owned conversation');

  // A successful run is silent: the cron occurrence still queues no channel delivery and the origin
  // agent gets no internal result event.
  await originIdle(store.gateway.harness, origin.id);
  assert.equal((await digestNotices(store.gateway.harness, origin.id)).length, 0,
    'a successful cron digest delivers no internal result event');
  assert.deepEqual(await store.gateway.cronOutbox.list(originSession, context), [],
    'digest completion is not a user/channel delivery');
});

test('a digest cron job refuses after a reopen narrows the curation allowlist', { timeout: 60_000 }, async (t) => {
  const fixture = await fixtureWorkspace();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  let scheduling = true;
  const store = await openStore(fixture, (request) => {
    const input = lastUserText(request.messages);
    if (scheduling && input.includes('Schedule a digest job')) {
      scheduling = false;
      return fauxAssistantMessage([
        fauxToolCall('cron', {
          action: 'add',
          intent: 'digest',
          name: 'late digest',
          after_seconds: 2,
        }, { id: 'cron-add-late' }),
      ], { stopReason: 'toolUse' });
    }
    if (input.includes('Schedule a digest job')) return fauxAssistantMessage('Scheduled.');
    return answerNothing();
  }, { cron: { enabled: true } });
  const origin = await store.gateway.conversationFor(CRON_SESSION, context);
  await closedEpisode(store.gateway.harness, origin.id, [system('boot')]);
  const conversation = await store.gateway.harness.conversation(origin.id, context);
  const submission = await conversation.submit({ type: 'input', content: 'Schedule a digest job' }, context);
  await submission.wait(context);
  await conversation.waitForIdle(context);
  const jobs = async (harness) => (await harness.snapshot(CronJobsDoc, origin.id, context)).jobs;
  await waitFor(async () => (await jobs(store.gateway.harness)).length === 1, 'one late digest job');
  await store.gateway.close(context);

  const narrowed = configFor(fixture, { toolAllowlist: ['read'], cron: { enabled: true } });
  const reopened = await openGateway(narrowed, context, { models: store.models });
  t.after(async () => { await reopened.close(context).catch(() => undefined); });
  await waitFor(async () => {
    const [job] = await jobs(reopened.harness);
    return job.lastOutcome !== null;
  }, 'the late occurrence settled');
  const [job] = await jobs(reopened.harness);
  assert.equal(job.lastOutcome.status, 'error');
  assert.match(job.lastOutcome.error, /toolAllowlist/);
  assert.equal(job.lastOutcome.conversationId, origin.id, 'the occurrence ran against the origin, not a target');
  assert.equal((await digestTasks(reopened.harness, origin.id)).length, 0,
    'a refused narrowed run starts no digest task');
});
