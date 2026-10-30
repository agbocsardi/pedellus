// Successful origin-mode scheduled answers reach the same durable cron outbox as isolated ones.
// The first case runs the real Gateway, a faux provider and a mocked Telegram transport: one
// inbound message schedules an origin job, the scheduled turn answers in that same conversation,
// and the adapter sends the committed answer exactly once without a duplicate ordinary reply.
// The other cases are smaller guards: an origin answer on a non-Telegram session is never queued,
// and isolated delivery keeps working.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const packageRoot = process.env.PI_NANOBOT_CANDIDATE ?? new URL('../', import.meta.url).pathname;
const modules = join(packageRoot, 'node_modules/@earendil-works');
const [
  { parseConfig },
  { openGateway },
  { CRON_JOBS_KIND, CronJobsDoc },
  { CRON_DELIVERIES_KIND, CronDeliveriesDoc },
  { runTelegram },
  { BACKGROUND_CONTEXT, withCancel },
  { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall },
  { ToolResultEntry },
] = await Promise.all([
  import(new URL('../dist/config.js', import.meta.url).href),
  import(new URL('../dist/runtime.js', import.meta.url).href),
  import(new URL('../dist/automation/cron.js', import.meta.url).href),
  import(new URL('../dist/automation/cron-delivery.js', import.meta.url).href),
  import(new URL('../dist/channels/telegram.js', import.meta.url).href),
  import(`${modules}/chord/dist/context/index.js`),
  import(`${modules}/pi-ai/dist/index.js`),
  import(`${modules}/pi-durable/dist/index.js`),
]);

const context = BACKGROUND_CONTEXT;
const WAIT_MS = 10_000;

async function syntheticGateway(label, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), `nanobot-cron-origin-${label}-`));
  try {
    const workspace = join(directory, 'workspace');
    const dataDir = join(directory, 'state');
    await mkdir(workspace);
    await writeFile(join(workspace, 'note.txt'), 'ORIGIN-READ-CONTENT\n');
    const faux = fauxProvider({ provider: 'cron-origin', models: [{ id: 'synthetic', name: 'Synthetic' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const model = { provider: 'cron-origin', modelId: 'synthetic' };
    const config = parseConfig({
      workspace,
      dataDir,
      model,
      allowedModels: [model],
      toolAllowlist: options.toolAllowlist ?? [],
      cron: { enabled: true },
      ...(options.telegram === false
        ? {}
        : { telegram: { tokenEnv: 'SYNTHETIC_TELEGRAM_TOKEN', allowFrom: ['501'] } }),
    }, directory);
    const gateway = await openGateway(config, context, { models });
    return { directory, config, faux, gateway };
  } catch (error) {
    // Setup failed before the test owned a gateway to close; still remove this store's directory.
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Resolve on the next commit that matches, with a bounded deadline. `stop()` always clears that
 * deadline and cancels the observer, whether the watcher settled, failed or was never awaited.
 */
function changeWatcher(harness, predicate, label) {
  let settled = false;
  let settle;
  let timer;
  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(() => settle.reject(new Error(`timed out waiting for ${label}`)), WAIT_MS);
    settle = {
      resolve: (publication) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(publication);
      },
      reject: (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    };
  });
  // A failing test may stop before awaiting; keep that rejection from surfacing as unhandled.
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

const deliveriesChanged = (conversationId) => (changes) => changes.some((change) =>
  change.type === 'document'
  && change.record.kind === CRON_DELIVERIES_KIND
  && change.conversationId === conversationId
  && change.value !== null);

const jobSettled = (conversationId) => (changes) => changes.some((change) => {
  if (change.type !== 'document' || change.record.kind !== CRON_JOBS_KIND
    || change.conversationId !== conversationId || change.value === null) return false;
  const jobs = change.value.jobs;
  return Array.isArray(jobs) && jobs.some((job) => job.lastOutcome !== null);
});

/** The last user input in a request, so a tool call's arguments never impersonate a new turn. */
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

function routeByContent(handlers) {
  return (request) => {
    const transcript = JSON.stringify(request.messages);
    const input = lastUserText(request.messages);
    for (const { when, respond } of handlers) {
      if (when({ transcript, input })) return respond();
    }
    return fauxAssistantMessage('synthetic fallback');
  };
}

const toolNames = (agent) => (agent.tools ?? []).map((tool) =>
  typeof tool === 'string' ? tool : tool.name).sort();

function telegramFetchMock(identity, updates) {
  const original = globalThis.fetch;
  const sent = [];
  const listeners = new Set();
  let polled = false;
  let nextMessageId = 900;
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const response = (result) => new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    const signal = init.signal;
    if (method === 'getMe') {
      return response({
        id: identity, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot',
        can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
      });
    }
    if (method === 'getUpdates') {
      if (!polled) {
        polled = true;
        return response(updates);
      }
      // The adapter's long poll: hold until the test stops it, then reject like a real abort.
      return await new Promise((_, reject) => {
        const aborted = () => reject(new DOMException('The operation was aborted', 'AbortError'));
        if (signal?.aborted) return aborted();
        signal?.addEventListener('abort', aborted, { once: true });
      });
    }
    if (method === 'sendMessage') {
      const messageId = nextMessageId++;
      sent.push({ chatId: body.chat_id, text: body.text ?? '', messageId });
      notify();
      return response({
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: body.chat_id, type: 'private' },
        text: body.text ?? '',
      });
    }
    if (method === 'editMessageText' || method === 'deleteMessage') return response(true);
    throw new Error(`unexpected mocked Telegram method: ${method}`);
  };
  return {
    sent,
    restore() { globalThis.fetch = original; },
    waitForText(predicate, label) {
      const existing = sent.find((entry) => predicate(entry.text));
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const listener = () => {
          const match = sent.find((entry) => predicate(entry.text));
          if (match === undefined) return;
          listeners.delete(listener);
          clearTimeout(timer);
          resolve(match);
        };
        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(new Error(`timed out waiting for ${label}: ${JSON.stringify(sent)}`));
        }, WAIT_MS);
        listeners.add(listener);
      });
    },
  };
}

test('an origin-mode scheduled answer is delivered once through the durable outbox', { timeout: 25_000 }, async () => {
  const origin = 'telegram:7:chat:501';
  const store = await syntheticGateway('channel', { toolAllowlist: ['read'] });
  const resultText = 'SCHEDULED-ORIGIN-RESULT';
  const scheduledMessage = 'deliver the origin reminder';
  let transport;
  let scope;
  let adapter;
  let deliveryWatcher;
  let deliveredWatcher;
  try {
    const chat = await store.gateway.conversationFor(origin, context);
    let toolCallIssued = false;
    store.faux.setResponses(Array.from({ length: 20 }, () => routeByContent([
      // The scheduled occurrence answer, identified by its own instruction text.
      { when: ({ input }) => input === scheduledMessage, respond: () => fauxAssistantMessage(resultText) },
      { when: ({ transcript }) => transcript.includes('origin-read'), respond: () => fauxAssistantMessage('ORIGIN-READ-OK') },
      { when: ({ input }) => input === 'read the origin note', respond: () => fauxAssistantMessage([
        fauxToolCall('read', { path: 'note.txt' }, { id: 'origin-read' }),
      ], { stopReason: 'toolUse' }) },
      {
        when: ({ input }) => input === 'schedule the reminder' && !toolCallIssued,
        respond: () => {
          toolCallIssued = true;
          return fauxAssistantMessage([
            fauxToolCall('cron', {
              action: 'add',
              message: scheduledMessage,
              name: 'origin reminder',
              isolated: false,
              at: new Date(Date.now() + 1_500).toISOString(),
            }, { id: 'origin-cron-add' }),
          ], { stopReason: 'toolUse' });
        },
      },
      { when: () => true, respond: () => fauxAssistantMessage('Scheduled.') },
    ])));

    transport = telegramFetchMock(7, [{
      update_id: 500,
      message: {
        message_id: 50,
        date: Math.floor(Date.now() / 1000),
        text: 'schedule the reminder',
        chat: { id: 501, type: 'private', first_name: 'Synthetic' },
        from: { id: 501, is_bot: false, first_name: 'Synthetic' },
      },
    }]);
    scope = withCancel(context);
    adapter = runTelegram(store.gateway, {
      token: '123456:synthetic-token', allowFrom: ['501'], pollTimeoutSeconds: 1,
    }, scope.context);
    deliveryWatcher = changeWatcher(store.gateway.harness, deliveriesChanged(chat.id), 'outbox admission');
    deliveredWatcher = changeWatcher(
      store.gateway.harness,
      (changes) => changes.some((change) => change.type === 'document'
        && change.record.kind === CRON_DELIVERIES_KIND
        && change.conversationId === chat.id
        && Array.isArray(change.value?.deliveries)
        && change.value.deliveries.some((record) => record.status === 'delivered')),
      'delivered outbox record',
    );

    await transport.waitForText((text) => text.includes('Scheduled.'), 'the ordinary schedule reply');
    await transport.waitForText((text) => text.includes(resultText), 'the scheduled Telegram send');
    await deliveryWatcher.promise;
    await deliveredWatcher.promise;

    const records = await store.gateway.cronOutbox.list(origin, context);
    assert.equal(records.length, 1, 'one outbox record for the origin occurrence');
    const record = records[0];
    assert.equal(record.text, resultText);
    assert.equal(record.status, 'delivered');
    assert.equal(record.sessionKey, origin);
    const jobs = await store.gateway.harness.snapshot(CronJobsDoc, chat.id, context);
    assert.equal(jobs.jobs.length, 1);
    assert.equal(jobs.jobs[0].mode, 'origin');
    assert.equal(jobs.jobs[0].lastOutcome.status, 'ok');
    assert.equal(record.id, `cron:${jobs.jobs[0].id}:${jobs.jobs[0].lastOutcome.scheduledAtMs}`);

    // The scheduled answer was sent once by the outbox, never as a second ordinary reply.
    assert.equal(transport.sent.filter((entry) => entry.text.includes(resultText)).length, 1);

    // An origin run is not a finished task-owned target: the configured tools and cron ownership stay.
    const names = toolNames(await chat.agent(context));
    assert.ok(names.includes('read'), `origin tools after the run: ${names}`);
    assert.ok(names.includes('cron'), `cron ownership after the run: ${names}`);
    const read = await chat.submit({ type: 'input', content: 'read the origin note', requestId: 'origin-read-request' }, context);
    assert.equal((await read.wait(context)).status, 'done');
    const entries = (await chat.entries({}, 200, undefined, context)).items;
    const readResult = entries.filter(ToolResultEntry.is)
      .find((entry) => entry.model?.[0]?.toolCallId === 'origin-read');
    assert.ok(readResult, 'the post-run read call reached the origin transcript');
    const readText = (readResult.model?.[0]?.content ?? [])
      .map((part) => (part.type === 'text' ? part.text : '')).join('\n');
    assert.match(readText, /ORIGIN-READ-CONTENT/);
  } finally {
    deliveryWatcher?.stop();
    deliveredWatcher?.stop();
    scope?.cancel(new DOMException('test finished', 'AbortError'));
    if (adapter !== undefined) await adapter.catch(() => undefined);
    transport?.restore();
    await store.gateway.close(context);
    await rm(store.directory, { recursive: true, force: true });
  }
});

test('a non-Telegram origin never queues an origin-mode result', { timeout: 20_000 }, async () => {
  const origin = 'sdk:local-origin';
  // Telegram delivery is enabled in this store; only the origin's session-key prefix keeps it silent.
  const store = await syntheticGateway('nonchannel', { telegram: true });
  assert.notEqual(store.config.telegram, undefined, 'delivery channel is enabled for this guard');
  const chat = await store.gateway.conversationFor(origin, context);
  const scheduledMessage = 'deliver the local reminder';
  let toolCallIssued = false;
  store.faux.setResponses(Array.from({ length: 12 }, () => routeByContent([
    { when: ({ input }) => input === scheduledMessage, respond: () => fauxAssistantMessage('LOCAL-ORIGIN-RESULT') },
    {
      when: ({ input }) => input === 'schedule the local reminder' && !toolCallIssued,
      respond: () => {
        toolCallIssued = true;
        return fauxAssistantMessage([
          fauxToolCall('cron', {
            action: 'add',
            message: scheduledMessage,
            isolated: false,
            at: new Date(Date.now() + 1_500).toISOString(),
          }, { id: 'local-cron-add' }),
        ], { stopReason: 'toolUse' });
      },
    },
    { when: () => true, respond: () => fauxAssistantMessage('Scheduled locally.') },
  ])));
  const watcher = changeWatcher(store.gateway.harness, jobSettled(chat.id), 'job settlement');
  try {
    const submission = await chat.submit({ type: 'input', content: 'schedule the local reminder' }, context);
    assert.equal((await submission.wait(context)).status, 'done');
    await watcher.promise;
    const jobs = await store.gateway.harness.snapshot(CronJobsDoc, chat.id, context);
    assert.equal(jobs.jobs[0].mode, 'origin');
    assert.equal(jobs.jobs[0].lastOutcome.status, 'ok');
    const deliveries = await store.gateway.harness.snapshot(CronDeliveriesDoc, chat.id, context);
    assert.equal(deliveries, undefined, 'no outbox document is created for a non-enabled channel');
  } finally {
    watcher.stop();
    await store.gateway.close(context);
    await rm(store.directory, { recursive: true, force: true });
  }
});

test('isolated-mode delivery remains admitted for a Telegram origin', { timeout: 20_000 }, async () => {
  const origin = 'telegram:7:chat:502';
  const store = await syntheticGateway('isolated');
  const chat = await store.gateway.conversationFor(origin, context);
  const scheduledMessage = 'deliver the isolated reminder';
  let toolCallIssued = false;
  store.faux.setResponses(Array.from({ length: 12 }, () => routeByContent([
    { when: ({ input }) => input === scheduledMessage, respond: () => fauxAssistantMessage('ISOLATED-RESULT') },
    {
      when: ({ input }) => input === 'schedule the isolated reminder' && !toolCallIssued,
      respond: () => {
        toolCallIssued = true;
        return fauxAssistantMessage([
          fauxToolCall('cron', {
            action: 'add',
            message: scheduledMessage,
            at: new Date(Date.now() + 1_500).toISOString(),
          }, { id: 'isolated-cron-add' }),
        ], { stopReason: 'toolUse' });
      },
    },
    { when: () => true, respond: () => fauxAssistantMessage('Scheduled in the background.') },
  ])));
  const watcher = changeWatcher(store.gateway.harness, deliveriesChanged(chat.id), 'isolated admission');
  try {
    const submission = await chat.submit({ type: 'input', content: 'schedule the isolated reminder' }, context);
    assert.equal((await submission.wait(context)).status, 'done');
    await watcher.promise;
    const records = await store.gateway.cronOutbox.list(origin, context);
    assert.equal(records.length, 1);
    assert.equal(records[0].text, 'ISOLATED-RESULT');
    assert.equal(records[0].status, 'pending');
  } finally {
    watcher.stop();
    await store.gateway.close(context);
    await rm(store.directory, { recursive: true, force: true });
  }
});
