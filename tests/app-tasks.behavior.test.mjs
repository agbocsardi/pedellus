// The app channel's Tasks view: one thread's own workers and scheduled jobs, listed and cancelled
// over wire protocol v2.
//
// A real gateway over a temporary store with a synthetic provider, the real listener on an
// ephemeral loopback port and a synthetic WebSocket client. The checks are event-driven (no
// schedules, no sleeps) and every handle is cleaned up by the test that created it:
//
// - the list is scoped to one thread's mapped conversation (another thread, and the unmapped main
//   thread, list nothing), newest first, bounded, with no host path in any field;
// - cancelling a worker aborts it durably and leaves one honest notice in that thread;
// - removing a scheduled job cancels it, and a second attempt reports `finished`;
// - an id from another thread reports `unknown` and changes nothing there;
// - a worker that already completed reports `finished`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  APP_LIMITS,
  context,
  deviceClient,
  fauxAssistantMessage,
  fauxToolCall,
  openAppStore,
  parseConfig,
  postPair,
  startApp,
  untilAsync,
} from './fixtures/app-harness.mjs';
import { createModels, deferred, fauxProvider } from './fixtures/discord-harness.mjs';

const MODEL = { provider: 'fixture', modelId: 'alpha' };
const WORKER_START = 'Start a worker in this thread: audit the build log.';
const CRON_ADD = 'standup reminder';
const WORKER_TASK = 'audit the build log';
const CRON_LABEL = 'Standup reminder';

function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    return typeof message.content === 'string'
      ? message.content
      : (message.content ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('');
  }
  return '';
}

/** A synthetic provider that branches on the transcript and can hold a worker child open. */
function scriptedModels(held) {
  const provider = fauxProvider({ provider: 'fixture', models: [{ id: 'alpha', name: 'Alpha' }] });
  const issued = new Set();
  const handler = async (request, options) => {
    const input = lastUserText(request.messages);
    if (input.includes('Background worker task.')) {
      held.childStarted?.resolve();
      // A cancellation must be able to stop this held run: resolve on the abort signal as well, so
      // the worker reaches its terminal aborted outcome without waiting for the release.
      await new Promise((resolve) => {
        const signal = options?.signal;
        if (signal?.aborted) return resolve();
        signal?.addEventListener('abort', () => resolve(), { once: true });
        held.release.promise.then(() => resolve());
      });
      return fauxAssistantMessage('WORKER-CHILD-ANSWER');
    }
    if (input.includes('start tasks') && !issued.has('tasks')) {
      issued.add('tasks');
      return fauxAssistantMessage([
        fauxToolCall('worker', { action: 'start', task: WORKER_TASK, workspace_mode: 'shared' }, { id: 'worker-start' }),
        fauxToolCall('cron', { action: 'add', message: CRON_ADD, name: CRON_LABEL, every_seconds: 3600 }, { id: 'cron-add' }),
      ], { stopReason: 'toolUse' });
    }
    if (input.includes('start other') && !issued.has('other')) {
      issued.add('other');
      return fauxAssistantMessage([
        fauxToolCall('worker', { action: 'start', task: 'other thread work', workspace_mode: 'shared' }, { id: 'other-start' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('SYNTHETIC-ANSWER');
  };
  provider.setResponses(Array.from({ length: 200 }, () => handler));
  const models = createModels();
  models.setProvider(provider.provider);
  return models;
}

/** One real gateway + listener with workers and cron enabled, and one paired device. */
async function openChannel(label) {
  const held = { childStarted: deferred(), release: deferred() };
  const models = scriptedModels(held);
  const rawConfig = (raw) => {
    const { model: _model, allowedModels: _allowed, ...rest } = raw;
    return parseConfig({ ...rest, model: MODEL, allowedModels: [MODEL], workers: { enabled: true }, cron: { enabled: true } }, '/tmp');
  };
  const store = await openAppStore(label, { rawConfig, gatewayOptions: { models } });
  const app = startApp(store, {});
  const port = await app.port;
  const base = `http://127.0.0.1:${port}`;
  const created = await store.gateway.appConsole.console().pair('phone');
  assert.equal('refused' in created, false, `pairing was refused: ${JSON.stringify(created)}`);
  const exchange = await postPair(base, created.code, 'phone');
  assert.equal(exchange.status, 204, 'pairing exchange failed');
  const device = deviceClient(base, exchange.cookie.split(';')[0]);
  await device.open();
  let counter = 0;
  const request = async (op, fields = {}) => {
    const id = `r${++counter}`;
    device.send({ type: 'req', id, op, ...fields });
    await device.wait(() => device.response(id) !== undefined, `${op} reply`);
    return device.response(id);
  };
  const tasks = async (thread) => {
    const reply = await request('tasks', thread === undefined ? {} : { thread });
    assert.equal(reply.ok, true, `tasks failed: ${JSON.stringify(reply)}`);
    return reply.tasks;
  };
  return {
    store, base, device, held, request, tasks,
    async close() {
      held.release.resolve();
      await device.close();
      await app.stop();
      await store.close();
    },
  };
}

async function createSide(channel, key, title) {
  const reply = await channel.request('thread.create', { key, title });
  assert.equal(reply.ok, true);
  assert.equal(reply.duplicate, false);
  return reply.thread;
}

const isoLike = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));

test('tasks lists one thread\'s own workers and scheduled jobs, newest first and bounded', { timeout: 30_000 }, async () => {
  const channel = await openChannel('tasks-list');
  try {
    assert.equal((await channel.request('hello', { v: 2, cursor: null })).v, 2);
    // The main thread has no mapped conversation until something arrives on it.
    assert.deepEqual(await channel.tasks(), []);
    const first = await createSide(channel, 'thread-first', 'First thread');
    const second = await createSide(channel, 'thread-second', 'Second thread');
    // A created-but-unused thread is mapped but has no work; the read creates nothing.
    assert.deepEqual(await channel.tasks(first), []);

    assert.equal((await channel.request('send', { thread: first, key: 'start-tasks', text: 'start tasks' })).ok, true);
    let listed = await channel.tasks(first);
    await untilAsync(async () => {
      listed = await channel.tasks(first);
      return listed.length === 2;
    }, 'the thread lists its worker and its scheduled job');

    // Exactly this thread's own two tasks: one worker, one scheduled job.
    assert.deepEqual(listed.map((task) => task.kind).sort(), ['cron', 'worker']);
    const worker = listed.find((task) => task.kind === 'worker');
    const job = listed.find((task) => task.kind === 'cron');
    assert.match(worker.id, /^w:[0-9]+$/u);
    assert.equal(worker.title, WORKER_TASK);
    assert.equal(worker.state, 'running');
    assert.ok(isoLike(worker.createdAt), 'a worker task carries an ISO creation time');
    assert.match(job.id, /^c:cron-[A-Za-z0-9-]+$/u);
    assert.equal(job.title, CRON_LABEL);
    assert.equal(job.state, 'scheduled');
    assert.ok(isoLike(job.nextAt), 'a scheduled job carries its next run');
    assert.ok(job.detail.includes('every 3600s'), 'the detail carries the bounded schedule summary');

    // Newest first, and every display field is bounded by the protocol.
    for (let index = 1; index < listed.length; index += 1) {
      assert.ok(Date.parse(listed[index - 1].createdAt) >= Date.parse(listed[index].createdAt), 'newest first');
    }
    for (const task of listed) {
      assert.ok([...task.title].length <= APP_LIMITS.taskTitleChars);
      assert.ok([...task.detail].length <= APP_LIMITS.taskDetailChars);
      assert.equal(typeof task.detail, 'string');
    }
    // No host path (URL-encoded or not) reaches the owner-facing view.
    const wire = JSON.stringify(listed);
    assert.equal(wire.includes(channel.store.workspace), false, 'a workspace path must not appear');
    assert.equal(wire.includes(encodeURIComponent(channel.store.workspace)), false);

    // Another thread lists nothing, and the list never leaks across threads.
    assert.deepEqual(await channel.tasks(second), []);
    assert.deepEqual(await channel.tasks(), []);
    // An unknown thread id is a bounded read, never a new mapping.
    assert.deepEqual(await channel.tasks('t_unknown-1'), []);
  } finally {
    await channel.close();
  }
});
