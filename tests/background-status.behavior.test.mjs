// Concise, read-only background summary inside the existing `/status` surfaces.
//
// One bounded snapshot says what is running for the one conversation being read: its own live
// workers, its own cron jobs (executing, queued, parked or merely scheduled) and whether the single
// workspace-global digestion run is live and whether it belongs to this chat. These checks use the
// real Gateway, a faux provider, a temporary workspace and the real private socket. They cover: the
// fixed renderer's wording for idle, executing, queued and sleeping work; that an idle read creates
// no document, task, cursor, tool-authority or model change; a running worker reported only inside
// its own spawning chat; a one-shot job reported as scheduled, then as executing only while its run
// actually runs; the shared digestion run labelled own or another chat without leaking an ID or
// evidence; and the CLI carrying the same summary over the private protocol.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';

const packageRoot = process.env.PI_NANOBOT_CANDIDATE ?? new URL('../', import.meta.url).pathname;
const modules = join(packageRoot, 'node_modules/@earendil-works');
const [
  { parseConfig },
  { openGateway },
  { BACKGROUND_STATUS_LIMITS, backgroundLabel, emptyBackgroundStatus, renderBackgroundStatus },
  { MemoryDigestNoticesDoc, renderMemoryDigestStatus },
  { DigestCursorDoc },
  { CronJobsDoc, CRON_RUN_TASK_NAME },
  { WorkerRecordsDoc },
  { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall },
  { BACKGROUND_CONTEXT },
  { prepareDataDirectory },
  { gatewaySocketPath, serveLocalGateway },
  { connectLocalGateway },
  { runTerminalConversation },
] = await Promise.all([
  import(new URL('../dist/config.js', import.meta.url).href),
  import(new URL('../dist/runtime.js', import.meta.url).href),
  import(new URL('../dist/background-status.js', import.meta.url).href),
  import(new URL('../dist/history/memory-digest.js', import.meta.url).href),
  import(new URL('../dist/history/digestion.js', import.meta.url).href),
  import(new URL('../dist/automation/cron.js', import.meta.url).href),
  import(new URL('../dist/workers/worker-task.js', import.meta.url).href),
  import(`${modules}/pi-ai/dist/index.js`),
  import(`${modules}/chord/dist/context/index.js`),
  import(new URL('../dist/store.js', import.meta.url).href),
  import(new URL('../dist/local/server.js', import.meta.url).href),
  import(new URL('../dist/local/client.js', import.meta.url).href),
  import(new URL('../dist/terminal/index.js', import.meta.url).href),
]);

const context = BACKGROUND_CONTEXT;
const WAIT_MS = 15_000;
const PROVIDER = 'status-fixture';
const MODEL = { provider: PROVIDER, modelId: 'synthetic' };
const SESSION = 'cli:background-status';
const OTHER = 'telegram:11:chat:502';
const FACT = 'STATUS-EVIDENCE-7715';

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

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  return (Array.isArray(message?.content) ? message.content : [])
    .flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
    .join('');
}

function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    return messageText(message);
  }
  return '';
}

const toolNames = (agent) => (agent.tools ?? []).map((tool) =>
  typeof tool === 'string' ? tool : tool.name).sort();

async function fixtureWorkspace(label) {
  const directory = await mkdtemp(join(tmpdir(), `nanobot-background-status-${label}-`));
  const workspace = join(directory, 'workspace');
  const dataDir = join(directory, 'state');
  await mkdir(workspace, { recursive: true });
  return { directory, workspace, dataDir };
}

/**
 * Real Gateway over a faux dispatcher. Every request is recorded, so a status read that spent a
 * model call cannot pass unnoticed.
 */
async function syntheticGateway(label, script, overrides = {}) {
  const fixture = await fixtureWorkspace(label);
  const faux = fauxProvider({ provider: PROVIDER, models: [{ id: MODEL.modelId, name: 'Synthetic status model' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const calls = [];
  const dispatcher = (request, options) => {
    faux.appendResponses([dispatcher]);
    calls.push(lastUserText(request.messages));
    return script(request, options);
  };
  faux.setResponses([dispatcher]);
  const config = parseConfig({
    workspace: fixture.workspace,
    dataDir: fixture.dataDir,
    model: MODEL,
    allowedModels: [MODEL],
    toolAllowlist: ['read', 'write', 'edit'],
    // Digestion never inherits the foreground model; name one explicitly.
    digest: { model: MODEL },
    episodeSummary: { enabled: false },
    ...overrides,
  }, fixture.directory);
  const gateway = await openGateway(config, context, { models });
  return { ...fixture, config, gateway, calls, faux };
}

async function cleanup(store, extra = async () => undefined) {
  try { await extra(); } catch { /* the test already reported its own failure */ }
  await store.gateway.close(context).catch(() => undefined);
  await rm(store.directory, { recursive: true, force: true });
}

async function tasksOf(harness) {
  return harness.commit(async (tx) => (await tx.scanTasks({}, 100)).items, context);
}

function user(text) {
  return { kind: 'pi.user', model: [{ role: 'user', content: text, timestamp: 1_000 }] };
}

function assistant(text) {
  return { kind: 'pi.assistant', model: [fauxAssistantMessage(text)] };
}

async function closedEpisode(harness, conversationId, drafts) {
  await harness.commit(async (tx) => {
    for (const draft of drafts) await tx.appendEntry(conversationId, draft);
  }, context);
  const conversation = await harness.conversation(conversationId, context);
  assert.ok(conversation !== undefined);
  await conversation.reset(undefined, context);
}

function digestWriter(conversation) {
  return { id: conversation.id, commit: (change, ctx) => conversation.commit(change, ctx) };
}

test('the fixed renderer never calls queued, sleeping or parked work running', () => {
  assert.deepEqual(renderBackgroundStatus(undefined), [], 'an unreadable snapshot adds no claim');

  const idle = emptyBackgroundStatus();
  assert.deepEqual(renderBackgroundStatus(idle), ['Background: idle']);

  const busy = {
    workers: {
      live: 2,
      parked: 0,
      items: [
        { taskId: 41, status: 'running', task: 'summarize the inbox', workspace: 'shared' },
        { taskId: 42, status: 'pending', task: 'draft release notes', workspace: 'worktree' },
      ],
    },
    cron: {
      scheduled: 3,
      nextAtMs: Date.UTC(2026, 10, 1, 9, 0, 0),
      running: { total: 1, items: [{ name: 'nightly digest', status: 'running' }] },
      pending: 1,
      parked: 0,
    },
    digest: { live: 'own', parked: false },
  };
  assert.deepEqual(renderBackgroundStatus(busy), [
    'Background: 2 live workers, 1 cron run executing, 1 cron run queued, digest running in this chat',
    '  worker 41 (running): summarize the inbox — shared workspace',
    '  worker 42 (queued): draft release notes — isolated worktree',
    '  cron "nightly digest" (running)',
    'Cron: 3 scheduled jobs, next due 2026-11-01T09:00:00.000Z',
  ]);

  // Nothing above is executing: queued and parked work is named as such, and the shared run is not
  // presented as this chat's own.
  const notExecuting = {
    ...emptyBackgroundStatus(),
    cron: { scheduled: 0, nextAtMs: null, running: { total: 0, items: [] }, pending: 2, parked: 1 },
    digest: { live: 'shared', parked: false },
  };
  const lines = renderBackgroundStatus(notExecuting);
  assert.match(lines[0], /2 cron runs queued/);
  assert.match(lines[0], /1 parked cron job/);
  assert.match(lines[0], /digest running for another chat/);
  assert.doesNotMatch(lines.join('\n'), /executing|running in this chat/);
  assert.doesNotMatch(lines.join('\n'), /^Cron:/m, 'nothing is scheduled, so no due time is claimed');

  // Native states keep their own words; only `running` and `finishing` are execution.
  for (const [status, word] of [
    ['pending', 'queued'],
    ['running', 'running'],
    ['waiting', 'waiting for another task'],
    ['sleeping', 'sleeping until due'],
    ['completing', 'finishing'],
  ]) {
    const one = {
      ...emptyBackgroundStatus(),
      workers: { live: 1, parked: 0, items: [{ taskId: 7, status, task: 'probe', workspace: 'shared' }] },
    };
    assert.deepEqual(renderBackgroundStatus(one)[1], `  worker 7 (${word}): probe — shared workspace`);
  }

  // A native-blocked task is unfinished but cannot run: it is never counted as live or healthy, and
  // only the restart-limit reason may promise that a native retry clears it.
  const parkedWork = {
    ...emptyBackgroundStatus(),
    workers: {
      live: 0,
      parked: 1,
      items: [{ taskId: 8, status: 'parked', task: 'probe', workspace: 'shared' }],
    },
    digest: { live: 'own', parked: true },
  };
  const parkedLines = renderBackgroundStatus(parkedWork);
  assert.deepEqual(parkedLines[0], 'Background: 1 parked worker, digest run parked in this chat');
  assert.deepEqual(parkedLines[1], '  worker 8 (parked, blocked): probe — shared workspace');
  assert.doesNotMatch(parkedLines.join('\n'), /retry/,
    'a blocked reason a retry cannot clear never promises one');

  const retryablePark = {
    ...parkedWork,
    workers: {
      live: 0,
      parked: 1,
      items: [{ taskId: 9, status: 'parked', retryable: true, task: 'probe', workspace: 'shared' }],
    },
  };
  assert.deepEqual(renderBackgroundStatus(retryablePark)[1],
    '  worker 9 (parked, blocked until a native retry): probe — shared workspace');

  // Rows are capped; the count is not hidden, and no count is invented for what was not read.
  const many = {
    ...emptyBackgroundStatus(),
    workers: {
      live: 6,
      parked: 0,
      items: [7, 8, 9, 10].map((taskId) => ({ taskId, status: 'running', task: 'probe', workspace: 'shared' })),
    },
    cron: {
      scheduled: 0,
      nextAtMs: null,
      running: { total: 6, items: [{ name: 'a', status: 'running' }] },
      pending: 0,
      parked: 0,
    },
  };
  const capped = renderBackgroundStatus(many);
  assert.equal(capped.filter((line) => line.startsWith('  worker')).length, BACKGROUND_STATUS_LIMITS.rows);
  assert.match(capped.join('\n'), /… 2 unfinished workers not shown/);
  assert.match(capped.join('\n'), /… 5 executing cron runs not shown/);

  // The whole block keeps a character budget, so a channel notice stays under its own bound.
  const huge = {
    ...emptyBackgroundStatus(),
    workers: {
      live: 40,
      parked: 0,
      items: [1, 2, 3, 4].map((taskId) => ({ taskId, status: 'running', task: 'y'.repeat(200), workspace: 'shared' })),
    },
    cron: {
      scheduled: 7,
      nextAtMs: 0,
      running: {
        total: 2,
        items: [{ name: 'z'.repeat(200), status: 'running' }, { name: 'z'.repeat(200), status: 'running' }],
      },
      pending: 1,
      parked: 1,
    },
  };
  const hugeLines = renderBackgroundStatus(huge);
  assert.ok(hugeLines.join('\n').length <= BACKGROUND_STATUS_LIMITS.totalChars,
    'the rendered block stays inside its character budget');
  assert.equal(hugeLines.at(-1), '  … further background detail omitted');

  // Host-supplied descriptions are collapsed and bounded before they reach a status read.
  assert.equal(backgroundLabel('  first\n\tsecond\u0000 third '), 'first second third');
  const long = backgroundLabel('x'.repeat(500));
  assert.equal(long.length, BACKGROUND_STATUS_LIMITS.nameChars + 1);
  assert.ok(long.endsWith('…'));
});

test('an idle chat reads only its own records: no document, task, cursor, tool or model change', { timeout: 30_000 }, async (t) => {
  const store = await syntheticGateway('idle', () => {
    throw new Error('a read-only status must not call a model');
  });
  t.after(() => cleanup(store));
  const origin = await store.gateway.conversationFor(SESSION, context);
  const harness = store.gateway.harness;
  const docs = [MemoryDigestNoticesDoc, DigestCursorDoc, CronJobsDoc, WorkerRecordsDoc];
  const snapshotDocs = () => Promise.all(docs.map((doc) => harness.snapshot(doc, origin.id, context)));
  assert.deepEqual(await snapshotDocs(), [undefined, undefined, undefined, undefined]);
  const tasksBefore = (await tasksOf(harness)).map((task) => Number(task.id));
  const toolsBefore = toolNames(await origin.agent(context));

  const status = await store.gateway.backgroundStatus(SESSION, context);
  assert.deepEqual(status, emptyBackgroundStatus());
  assert.deepEqual(renderBackgroundStatus(status), ['Background: idle']);

  assert.deepEqual(await snapshotDocs(), [undefined, undefined, undefined, undefined],
    'a status read creates no worker, cron, digest-notice or digest-cursor document');
  assert.deepEqual((await tasksOf(harness)).map((task) => Number(task.id)), tasksBefore,
    'a status read creates no task');
  assert.equal(store.calls.length, 0, 'a status read makes no model request');
  assert.deepEqual(toolNames(await origin.agent(context)), toolsBefore, 'tool authority is unchanged');

  // A channel-state conversation is not a mapped chat: it learns nothing and reports nothing.
  const stateSession = 'telegram:11:chat:501:channel-state';
  await store.gateway.conversationFor(stateSession, context);
  assert.deepEqual(await store.gateway.backgroundStatus(stateSession, context), emptyBackgroundStatus());
  assert.equal(store.calls.length, 0);
});

test('a running worker is reported inside its own spawning chat and nowhere else', { timeout: 40_000 }, async (t) => {
  const childStarted = deferred();
  const releaseChild = deferred();
  let issued = false;
  const store = await syntheticGateway('worker', async (request) => {
    const input = lastUserText(request.messages);
    if (input.includes('Background worker task.')) {
      childStarted.resolve();
      await releaseChild.promise;
      return fauxAssistantMessage('WORKER-CHILD-RESULT');
    }
    if (input.includes('[internal worker result]')) return fauxAssistantMessage('PARENT-NOTED');
    if (input === 'spawn a worker' && !issued) {
      issued = true;
      return fauxAssistantMessage([
        fauxToolCall('worker', {
          action: 'start',
          task: 'read note.txt and report the count',
          workspace_mode: 'shared',
        }, { id: 'worker-start' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('PARENT-CONTINUED');
  }, { workers: { enabled: true } });
  t.after(() => cleanup(store, () => releaseChild.resolve()));
  const origin = await store.gateway.conversationFor(SESSION, context);
  const harness = store.gateway.harness;

  const submission = await origin.submit({ type: 'input', content: 'spawn a worker', requestId: 'spawn' }, context);
  assert.equal((await submission.wait(context)).status, 'done', 'the parent turn settles while the worker runs');
  await within(childStarted.promise, WAIT_MS, 'the worker child never started');
  const record = (await harness.snapshot(WorkerRecordsDoc, origin.id, context)).workers[0];
  const recordBefore = JSON.stringify(record);

  const status = await store.gateway.backgroundStatus(SESSION, context);
  assert.equal(status.workers.live, 1);
  const [worker] = status.workers.items;
  assert.equal(worker.taskId, record.taskId);
  assert.equal(worker.workspace, 'shared');
  assert.ok(['pending', 'running'].includes(worker.status), `native worker state: ${worker.status}`);
  assert.equal(worker.task, 'read note.txt and report the count');
  assert.equal(status.cron.scheduled, 0);
  assert.equal(status.cron.running.total, 0);
  assert.equal(status.digest.live, 'none');
  const rendered = renderBackgroundStatus(status).join('\n');
  assert.match(rendered, /^Background: 1 live worker$/m);
  assert.match(rendered, new RegExp(`worker ${record.taskId} \\((queued|running)\\): read note\\.txt and report the count — shared workspace`));
  assert.doesNotMatch(rendered, /cron|digest/i);

  // Reading status changed no worker record, no task and no model request of the worker's own.
  assert.equal(JSON.stringify((await harness.snapshot(WorkerRecordsDoc, origin.id, context)).workers[0]), recordBefore);
  assert.equal(await harness.snapshot(CronJobsDoc, origin.id, context), undefined,
    'reading a worker adds no cron document');
  assert.equal(JSON.stringify(status).includes('WORKER-CHILD-RESULT'), false);

  // Another authenticated chat sees none of it.
  await store.gateway.conversationFor(OTHER, context);
  const foreign = await store.gateway.backgroundStatus(OTHER, context);
  assert.deepEqual(foreign, emptyBackgroundStatus());
  assert.equal(JSON.stringify(foreign).includes(String(record.taskId)), false);

  releaseChild.resolve();
  await waitFor(async () => {
    const workers = (await harness.snapshot(WorkerRecordsDoc, origin.id, context))?.workers ?? [];
    return workers[0]?.notified === true;
  }, 'the worker result admission');
  const after = await store.gateway.backgroundStatus(SESSION, context);
  assert.equal(after.workers.live, 0);
  assert.deepEqual(renderBackgroundStatus(after), ['Background: idle']);
  assert.ok(await store.gateway.harness.getTask(record.taskId, context) !== undefined,
    'the terminal worker keeps its native record');
});

test('a one-shot job is scheduled until its run is genuinely executing', { timeout: 60_000 }, async (t) => {
  const runEntered = deferred();
  const releaseRun = deferred();
  let issued = false;
  const store = await syntheticGateway('cron', async (request, options) => {
    const input = lastUserText(request.messages);
    if (input === 'deliver the reminder') {
      runEntered.resolve();
      await new Promise((resolve) => {
        const abort = () => resolve();
        if (options?.signal?.aborted) return abort();
        options?.signal?.addEventListener('abort', abort, { once: true });
        releaseRun.promise.then(() => {
          options?.signal?.removeEventListener('abort', abort);
          resolve();
        });
      });
      return fauxAssistantMessage('SCHEDULED-RESULT');
    }
    if (input === 'schedule the reminder' && !issued) {
      issued = true;
      return fauxAssistantMessage([
        fauxToolCall('cron', {
          action: 'add',
          message: 'deliver the reminder',
          name: 'status reminder',
          at: new Date(Date.now() + 1_500).toISOString(),
        }, { id: 'cron-add' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('SCHEDULING-ACK');
  }, { cron: { enabled: true } });
  t.after(() => cleanup(store, () => releaseRun.resolve()));
  const origin = await store.gateway.conversationFor(SESSION, context);
  const harness = store.gateway.harness;

  const submission = await origin.submit({ type: 'input', content: 'schedule the reminder' }, context);
  assert.equal((await submission.wait(context)).status, 'done');
  await origin.waitForIdle(context);

  const jobs = async () => (await harness.snapshot(CronJobsDoc, origin.id, context))?.jobs ?? [];
  await waitFor(async () => (await jobs()).length === 1 && (await jobs())[0].timerTaskId !== null,
    'the armed timer');
  const [job] = await jobs();
  const timer = await harness.getTask(job.timerTaskId, context);
  assert.equal(timer.state.status, 'sleeping', 'the future occurrence is a sleeping native timer');

  const scheduled = await store.gateway.backgroundStatus(SESSION, context);
  assert.equal(scheduled.cron.scheduled, 1);
  assert.equal(scheduled.cron.nextAtMs, timer.input.scheduledAtMs);
  assert.equal(scheduled.cron.running.total, 0, 'an armed timer is not a running job');
  assert.equal(scheduled.cron.pending, 0);
  assert.equal(scheduled.cron.parked, 0);
  assert.equal(scheduled.workers.live, 0);
  assert.equal(scheduled.digest.live, 'none');
  const scheduledText = renderBackgroundStatus(scheduled).join('\n');
  assert.match(scheduledText, /^Background: idle$/m);
  assert.match(scheduledText, /^Cron: 1 scheduled job, next due /m);

  await within(runEntered.promise, WAIT_MS, 'the scheduled run never started');
  await waitFor(async () => (await jobs())[0].timerTaskId === null, 'the one-shot timer to settle');
  const running = await store.gateway.backgroundStatus(SESSION, context);
  assert.equal(running.cron.scheduled, 0, 'a fired one-shot has no future occurrence');
  assert.equal(running.cron.running.total, 1);
  assert.equal(running.cron.running.items[0].name, 'status reminder');
  assert.ok(['running', 'completing'].includes(running.cron.running.items[0].status));
  const runningText = renderBackgroundStatus(running).join('\n');
  assert.match(runningText, /^Background: 1 cron run executing$/m);
  assert.match(runningText, /cron "status reminder" \((running|finishing)\)/);
  assert.doesNotMatch(runningText, /scheduled job/);
  // Only the bounded job name is reported, never the job message or a run's text.
  for (const value of [scheduled, running]) {
    assert.equal(JSON.stringify(value).includes('deliver the reminder'), false);
    assert.equal(JSON.stringify(value).includes('SCHEDULED-RESULT'), false);
  }

  releaseRun.resolve();
  await waitFor(async () => (await jobs())[0].lastOutcome !== null, 'the scheduled run outcome');
  const settled = await store.gateway.backgroundStatus(SESSION, context);
  assert.deepEqual(settled, emptyBackgroundStatus());
  assert.deepEqual(renderBackgroundStatus(settled), ['Background: idle']);
  const run = (await tasksOf(harness)).find((task) => task.kind === CRON_RUN_TASK_NAME);
  assert.ok(run !== undefined && run.state.status === 'terminal');
  assert.equal(messageText(run.state.outcome.result?.error ?? ''), '');
});

test('the shared digestion run is labelled own or another chat without leaking either', { timeout: 40_000 }, async (t) => {
  const batchEntered = deferred();
  const releaseBatch = deferred();
  const store = await syntheticGateway('digest', async (request, options) => {
    if (lastUserText(request.messages).startsWith('[internal memory digest result]')) {
      return fauxAssistantMessage('Digest result noted.');
    }
    batchEntered.resolve();
    await new Promise((resolve) => {
      const abort = () => resolve();
      if (options?.signal?.aborted) return abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      releaseBatch.promise.then(() => {
        options.signal?.removeEventListener('abort', abort);
        resolve();
      });
    });
    return fauxAssistantMessage('No durable fact in this batch.');
  });
  t.after(() => cleanup(store, () => releaseBatch.resolve()));
  const origin = await store.gateway.conversationFor(SESSION, context);
  const harness = store.gateway.harness;
  await closedEpisode(harness, origin.id, [user(`Remember ${FACT}`), assistant('Noted.')]);

  const started = await store.gateway.memoryDigest.start(digestWriter(origin), context);
  assert.equal(started.status, 'started');
  await within(batchEntered.promise, WAIT_MS, 'the digest batch request');

  const cursorBefore = await harness.snapshot(DigestCursorDoc, origin.id, context);
  const noticesBefore = JSON.stringify(await harness.snapshot(MemoryDigestNoticesDoc, origin.id, context));
  const taskIdsBefore = (await tasksOf(harness)).map((task) => Number(task.id));

  const own = await store.gateway.backgroundStatus(SESSION, context);
  assert.equal(own.digest.live, 'own');
  assert.equal(own.workers.live, 0);
  assert.equal(own.cron.scheduled, 0);
  assert.equal(own.cron.running.total, 0);
  assert.match(renderBackgroundStatus(own)[0], /digest running in this chat/);
  assert.equal(JSON.stringify(own).includes(String(started.taskId)), false, 'the run ID is not reported');

  // Reading changed no cursor and no notice record, and added no task.
  assert.deepEqual(await harness.snapshot(DigestCursorDoc, origin.id, context), cursorBefore);
  assert.equal(JSON.stringify(await harness.snapshot(MemoryDigestNoticesDoc, origin.id, context)), noticesBefore);
  assert.deepEqual((await tasksOf(harness)).map((task) => Number(task.id)), taskIdsBefore,
    'a status read creates no task');

  // Another mapped chat sees only that one shared run is live, and nothing else about it.
  await store.gateway.conversationFor(OTHER, context);
  const shared = await store.gateway.backgroundStatus(OTHER, context);
  assert.deepEqual(shared, { ...emptyBackgroundStatus(), digest: { live: 'shared', parked: false } });
  assert.match(renderBackgroundStatus(shared)[0], /digest running for another chat/);
  assert.equal(JSON.stringify(shared).includes(FACT), false);

  releaseBatch.resolve();
  await waitFor(async () => (await harness.getTask(started.taskId, context))?.state.status === 'terminal',
    'the digest run to settle');
  assert.deepEqual(await store.gateway.backgroundStatus(SESSION, context), emptyBackgroundStatus());
  assert.deepEqual(await store.gateway.backgroundStatus(OTHER, context), emptyBackgroundStatus());
  assert.equal(store.calls.length, 1, 'only the digest batch reached the model');
  assert.equal((await harness.snapshot(MemoryDigestNoticesDoc, origin.id, context)) !== undefined, true,
    'the success record is retained and still silent');
});

test('the local CLI /status carries the background summary over the private socket', { timeout: 40_000 }, async (t) => {
  const batchEntered = deferred();
  const releaseBatch = deferred();
  const store = await syntheticGateway('socket', async (request, options) => {
    if (lastUserText(request.messages).startsWith('[internal memory digest result]')) {
      return fauxAssistantMessage('Digest result noted.');
    }
    batchEntered.resolve();
    await new Promise((resolve) => {
      const abort = () => resolve();
      if (options?.signal?.aborted) return abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      releaseBatch.promise.then(() => {
        options.signal?.removeEventListener('abort', abort);
        resolve();
      });
    });
    return fauxAssistantMessage('No durable fact in this batch.');
  });
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
    conversation: 'background-status',
    context,
  });
  t.after(() => cleanup(store, async () => {
    releaseBatch.resolve();
    await client.close();
    await server.close();
  }));

  const status = await client.status(context);
  assert.deepEqual(status.background, emptyBackgroundStatus(), 'the idle summary crosses the socket');

  const chunks = [];
  const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); } });
  await runTerminalConversation(client, context, {
    input: (async function* () { yield '/status'; })(),
    output,
  });
  const idle = chunks.join('');
  assert.match(idle, /Model: /);
  assert.match(idle, /Run: idle/);
  assert.match(idle, /Native inbox: 0 queued/);
  assert.match(idle, /^Background: idle$/m);
  assert.match(idle, /Provider-side charges or usage not recorded by Durable: unknown/);

  const origin = await store.gateway.conversationFor(SESSION, context);
  await closedEpisode(store.gateway.harness, origin.id, [user(`Remember ${FACT}`), assistant('Noted.')]);
  const started = await store.gateway.memoryDigest.start(digestWriter(origin), context);
  assert.equal(started.status, 'started');
  await within(batchEntered.promise, WAIT_MS, 'the digest batch request');

  // The local surface carries the bounded digest view only: the live run's origin conversation is
  // host-internal, so the socket never sees another chat's conversation ID.
  const localDigestStatus = await client.digestStatus(context);
  assert.equal(Object.hasOwn(localDigestStatus, 'liveConversationId'), false,
    'the live origin conversation never crosses the private socket');
  assert.ok(Number.isSafeInteger(localDigestStatus.liveTaskId));
  assert.match(renderMemoryDigestStatus(localDigestStatus), /Live memory digestion run: \d+/);
  const internalDigestStatus = await store.gateway.memoryDigest.status(digestWriter(origin), context);
  assert.equal(internalDigestStatus.liveConversationId, origin.id,
    'the host still knows the origin for its own own-versus-shared labelling');

  const busyChunks = [];
  const busyOutput = new Writable({ write(chunk, _encoding, callback) { busyChunks.push(chunk.toString()); callback(); } });
  await runTerminalConversation(client, context, {
    input: (async function* () { yield '/status'; })(),
    output: busyOutput,
  });
  const busy = busyChunks.join('');
  assert.match(busy, /^Background: digest running in this chat$/m);
  assert.doesNotMatch(busy, /cron|worker/i);
  assert.equal(busy.includes(FACT), false, 'the status line carries no digest evidence');
  assert.equal(store.calls.length, 1, 'reading status over the socket spent no model call');

  releaseBatch.resolve();
  await waitFor(async () => (await store.gateway.harness.getTask(started.taskId, context))?.state.status === 'terminal',
    'the digest run to settle');
  const settledChunks = [];
  const settledOutput = new Writable({ write(chunk, _encoding, callback) { settledChunks.push(chunk.toString()); callback(); } });
  await runTerminalConversation(client, context, {
    input: (async function* () { yield '/status'; })(),
    output: settledOutput,
  });
  assert.match(settledChunks.join(''), /^Background: idle$/m);
});
