// Scheduled outcomes reach the same durable cron outbox whatever the run produced. The first case
// runs the real Gateway, a faux provider and a mocked Telegram transport: one inbound message
// schedules an origin job, the scheduled turn answers in that same conversation, and the adapter
// sends the committed answer exactly once without a duplicate ordinary reply. Smaller guards cover
// an origin answer on a non-Telegram session, isolated success delivery, a failed isolated run and an
// empty origin-mode answer (fixed sanitized notice text, one record across reopen), and an aborted
// run (silent). The silent-delivery cases cover a job-wide `silent` setting (success and empty
// suppressed, failure notice kept, legacy record still delivered, list/confirmation text, reopen),
// and the per-occurrence `[SILENT]` answer in both modes, including a later occurrence of the same
// job that still delivers and an ordinary chat answer that keeps its literal text.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { scheduledContent } from './fixtures/cron-input.mjs';

const packageRoot = process.env.PI_NANOBOT_CANDIDATE ?? new URL('../', import.meta.url).pathname;
const modules = join(packageRoot, 'node_modules/@earendil-works');
const [
  { parseConfig },
  { openGateway },
  { CRON_JOBS_KIND, CronJobsDoc },
  { CRON_DELIVERIES_KIND, CronDeliveriesDoc, cronOutcomeNotice },
  { runTelegram },
  { ConfigToolCaptureDoc },
  { BACKGROUND_CONTEXT, withCancel },
  { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall },
  { ToolResultEntry, AssistantEntry },
] = await Promise.all([
  import(new URL('../dist/config.js', import.meta.url).href),
  import(new URL('../dist/runtime.js', import.meta.url).href),
  import(new URL('../dist/automation/cron.js', import.meta.url).href),
  import(new URL('../dist/automation/cron-delivery.js', import.meta.url).href),
  import(new URL('../dist/channels/telegram.js', import.meta.url).href),
  import(new URL('../dist/tools/index.js', import.meta.url).href),
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
    return { directory, config, faux, models, gateway };
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

/** All `count` jobs in one origin document have recorded a settlement. */
const allJobsSettled = (conversationId, count) => (changes) => changes.some((change) => {
  if (change.type !== 'document' || change.record.kind !== CRON_JOBS_KIND
    || change.conversationId !== conversationId || change.value === null) return false;
  const jobs = change.value.jobs;
  return Array.isArray(jobs) && jobs.length === count
    && jobs.every((job) => job.lastOutcome !== null);
});

/** A delivery record whose stored text contains `text` was admitted for one origin conversation. */
const deliveryWithText = (conversationId, text) => (changes) => changes.some((change) =>
  change.type === 'document'
  && change.record.kind === CRON_DELIVERIES_KIND
  && change.conversationId === conversationId
  && Array.isArray(change.value?.deliveries)
  && change.value.deliveries.some((record) =>
    typeof record.text === 'string' && record.text.includes(text)));

/** The committed text of one tool result, matched by its assistant call ID. */
async function toolResultText(conversation, callId, context) {
  const entries = (await conversation.entries({}, 500, undefined, context)).items;
  const entry = entries.filter(ToolResultEntry.is)
    .find((candidate) => candidate.model?.[0]?.toolCallId === callId);
  if (entry === undefined) return undefined;
  return (entry.model?.[0]?.content ?? [])
    .map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}

/** Every committed assistant text block in one transcript, in order. */
function assistantTexts(entries) {
  return entries.filter(AssistantEntry.is).flatMap((entry) => (entry.model ?? [])
    .flatMap((message) => (message.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text)));
}

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
      if (when({ transcript, input })) return respond({ transcript, input });
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
    if (method === 'sendRichMessage') {
      const messageId = nextMessageId++;
      const rich = body.rich_message ?? {};
      sent.push({ chatId: body.chat_id, text: rich.markdown ?? '', messageId, rich });
      notify();
      return response({
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: body.chat_id, type: 'private' },
        rich_message: rich,
      });
    }
    if (method === 'sendChatAction') return response(true);
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
      { when: ({ input }) => input === scheduledContent(scheduledMessage), respond: () => fauxAssistantMessage(resultText) },
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
    { when: ({ input }) => input === scheduledContent(scheduledMessage), respond: () => fauxAssistantMessage('LOCAL-ORIGIN-RESULT') },
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
    { when: ({ input }) => input === scheduledContent(scheduledMessage), respond: () => fauxAssistantMessage('ISOLATED-RESULT') },
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
    // The settled isolated target retires its captured authority with its terminal commit.
    const jobs = await store.gateway.harness.snapshot(CronJobsDoc, chat.id, context);
    const capture = await store.gateway.harness.snapshot(
      ConfigToolCaptureDoc, jobs.jobs[0].lastOutcome.conversationId, context,
    );
    assert.equal(capture, undefined, 'no captured tools survive the isolated run');
  } finally {
    watcher.stop();
    await store.gateway.close(context);
    await rm(store.directory, { recursive: true, force: true });
  }
});

test('an isolated scheduled run that errors queues one sanitized failure notice', { timeout: 25_000 }, async () => {
  const origin = 'telegram:7:chat:503';
  const store = await syntheticGateway('error-notice', { toolAllowlist: ['read'] });
  const chat = await store.gateway.conversationFor(origin, context);
  const scheduledMessage = 'run the failing reminder';
  const providerError = 'SYNTHETIC-PROVIDER-ERROR-TEXT';
  let toolCallIssued = false;
  store.faux.setResponses(Array.from({ length: 12 }, () => routeByContent([
    {
      when: ({ input }) => input === scheduledContent(scheduledMessage),
      respond: () => fauxAssistantMessage('', { stopReason: 'error', errorMessage: providerError }),
    },
    {
      when: ({ input }) => input === 'schedule the failing reminder' && !toolCallIssued,
      respond: () => {
        toolCallIssued = true;
        return fauxAssistantMessage([
          fauxToolCall('cron', {
            action: 'add',
            message: scheduledMessage,
            at: new Date(Date.now() + 1_500).toISOString(),
          }, { id: 'failing-cron-add' }),
        ], { stopReason: 'toolUse' });
      },
    },
    { when: () => true, respond: () => fauxAssistantMessage('Scheduled the failing reminder.') },
  ])));
  const watcher = changeWatcher(store.gateway.harness, deliveriesChanged(chat.id), 'failure notice');
  try {
    const submission = await chat.submit({ type: 'input', content: 'schedule the failing reminder' }, context);
    assert.equal((await submission.wait(context)).status, 'done');
    await watcher.promise;

    const jobs = await store.gateway.harness.snapshot(CronJobsDoc, chat.id, context);
    assert.equal(jobs.jobs.length, 1);
    const job = jobs.jobs[0];
    assert.equal(job.lastOutcome.status, 'error');
    const records = await store.gateway.cronOutbox.list(origin, context);
    assert.equal(records.length, 1, 'one outbox record for the failed occurrence');
    assert.equal(records[0].id, `cron:${job.id}:${job.lastOutcome.scheduledAtMs}`);
    assert.equal(records[0].sessionKey, origin);
    assert.equal(records[0].status, 'pending');
    assert.equal(records[0].text, cronOutcomeNotice('failed', job.id, job.lastOutcome.scheduledAtMs));
    assert.ok(records[0].text.includes(job.id), `the notice names the job ID: ${records[0].text}`);
    assert.ok(
      records[0].text.includes(new Date(job.lastOutcome.scheduledAtMs).toISOString()),
      `the notice names the occurrence instant: ${records[0].text}`,
    );
    assert.match(records[0].text, /list scheduled jobs/, 'the notice names the next action');
    assert.ok(!records[0].text.includes(providerError), `no raw provider error text: ${records[0].text}`);
    assert.ok(!records[0].text.includes(scheduledMessage), 'no job message text in the notice');

    // The finished isolated target retires its captured authority in the same terminal commit.
    const capture = await store.gateway.harness.snapshot(
      ConfigToolCaptureDoc, job.lastOutcome.conversationId, context,
    );
    assert.equal(capture, undefined, 'no captured tools survive the failed isolated run');
  } finally {
    watcher.stop();
    await store.gateway.close(context);
    await rm(store.directory, { recursive: true, force: true });
  }
});

test('an empty origin-mode answer queues one notice and stays one record after reopen', { timeout: 25_000 }, async () => {
  const origin = 'telegram:7:chat:504';
  const store = await syntheticGateway('empty-notice');
  const chat = await store.gateway.conversationFor(origin, context);
  const scheduledMessage = 'deliver the empty reminder';
  let toolCallIssued = false;
  store.faux.setResponses(Array.from({ length: 12 }, () => routeByContent([
    { when: ({ input }) => input === scheduledContent(scheduledMessage), respond: () => fauxAssistantMessage('') },
    {
      when: ({ input }) => input === 'schedule the empty reminder' && !toolCallIssued,
      respond: () => {
        toolCallIssued = true;
        return fauxAssistantMessage([
          fauxToolCall('cron', {
            action: 'add',
            message: scheduledMessage,
            isolated: false,
            at: new Date(Date.now() + 1_500).toISOString(),
          }, { id: 'empty-cron-add' }),
        ], { stopReason: 'toolUse' });
      },
    },
    { when: () => true, respond: () => fauxAssistantMessage('Scheduled the empty reminder.') },
  ])));
  const watcher = changeWatcher(store.gateway.harness, deliveriesChanged(chat.id), 'empty-result notice');
  let reopened;
  try {
    const submission = await chat.submit({ type: 'input', content: 'schedule the empty reminder' }, context);
    assert.equal((await submission.wait(context)).status, 'done');
    await watcher.promise;

    const jobs = await store.gateway.harness.snapshot(CronJobsDoc, chat.id, context);
    const job = jobs.jobs[0];
    assert.equal(job.mode, 'origin');
    assert.equal(job.lastOutcome.status, 'ok');
    const records = await store.gateway.cronOutbox.list(origin, context);
    assert.equal(records.length, 1);
    assert.equal(records[0].text, cronOutcomeNotice('empty', job.id, job.lastOutcome.scheduledAtMs));
    assert.ok(records[0].text.includes(job.id), `the notice names the job ID: ${records[0].text}`);
    assert.ok(
      records[0].text.includes(new Date(job.lastOutcome.scheduledAtMs).toISOString()),
      `the notice names the occurrence instant: ${records[0].text}`,
    );
    assert.match(records[0].text, /without an answer/);
    assert.match(records[0].text, /list scheduled jobs/);
    const admitted = records[0];

    // Reopening the same store must not admit the occurrence a second time.
    await store.gateway.close(context);
    reopened = await openGateway(store.config, context, { models: store.models });
    await reopened.harness.waitForIdle(context).catch(() => undefined);
    const after = await reopened.cronOutbox.list(origin, context);
    assert.equal(after.length, 1, 'one durable record after reopen');
    assert.equal(after[0].id, admitted.id);
    assert.equal(after[0].text, admitted.text);
  } finally {
    watcher.stop();
    if (reopened !== undefined) await reopened.close(context).catch(() => undefined);
    else await store.gateway.close(context).catch(() => undefined);
    await rm(store.directory, { recursive: true, force: true });
  }
});

test('an aborted scheduled run queues nothing', { timeout: 25_000 }, async () => {
  const origin = 'telegram:7:chat:505';
  const store = await syntheticGateway('cancelled');
  const chat = await store.gateway.conversationFor(origin, context);
  const scheduledMessage = 'run the cancelled reminder';
  let scheduleIssued = false;
  let releaseHeld;
  let markHeld;
  const held = new Promise((resolve) => { markHeld = resolve; });
  store.faux.setResponses(Array.from({ length: 12 }, () => routeByContent([
    {
      when: ({ input }) => input === scheduledContent(scheduledMessage),
      respond: () => new Promise((_resolve, reject) => {
        // The occurrence holds here until the test aborts its task, so the abort lands mid-run.
        releaseHeld = () => reject(new Error('held response released'));
        markHeld();
      }),
    },
    {
      when: ({ input }) => input === 'schedule the cancelled reminder' && !scheduleIssued,
      respond: () => {
        scheduleIssued = true;
        return fauxAssistantMessage([
          fauxToolCall('cron', {
            action: 'add',
            message: scheduledMessage,
            at: new Date(Date.now() + 1_500).toISOString(),
          }, { id: 'cancelled-cron-add' }),
        ], { stopReason: 'toolUse' });
      },
    },
    { when: () => true, respond: () => fauxAssistantMessage('Scheduled.') },
  ])));
  try {
    const schedule = await chat.submit({ type: 'input', content: 'schedule the cancelled reminder' }, context);
    assert.equal((await schedule.wait(context)).status, 'done');
    const scheduled = await store.gateway.harness.snapshot(CronJobsDoc, chat.id, context);
    assert.equal(scheduled.jobs.length, 1);
    assert.equal(scheduled.jobs[0].lastOutcome, null);

    // Wait for the scheduled occurrence to reach the model, then abort that run mid-flight.
    await held;
    const jobs = await store.gateway.harness.snapshot(CronJobsDoc, chat.id, context);
    const runTaskId = jobs.jobs[0].executionTaskId;
    assert.ok(Number.isSafeInteger(runTaskId), 'the occurrence has an active run task');
    const target = (await store.gateway.harness.getTask(runTaskId, context)).state.checkpoint.targetConversationId;
    assert.ok(Number.isSafeInteger(target), 'the run prepared a separate target');
    const aborted = await store.gateway.harness.abortTask(runTaskId, context);
    releaseHeld?.();
    if (aborted === 'marked') await store.gateway.harness.waitForTask(runTaskId, context);

    const run = await store.gateway.harness.getTask(runTaskId, context);
    assert.equal(run?.state.status, 'terminal');
    assert.equal(run.state.outcome.status, 'aborted');
    const after = await store.gateway.harness.snapshot(CronJobsDoc, chat.id, context);
    assert.equal(after.jobs[0].lastOutcome, null, 'the aborted run records no settlement');
    const deliveries = await store.gateway.harness.snapshot(CronDeliveriesDoc, chat.id, context);
    assert.equal(deliveries, undefined, 'an aborted run queues no notice');
    const capture = await store.gateway.harness.snapshot(ConfigToolCaptureDoc, target, context);
    assert.equal(capture, undefined, 'the aborted target still retires its captured tools');
    assert.equal((await store.gateway.cronOutbox.list(origin, context)).length, 0);
  } finally {
    releaseHeld?.();
    await store.gateway.close(context);
    await rm(store.directory, { recursive: true, force: true });
  }
});

test('silent jobs suppress success and empty answers but keep failure notices and legacy delivery', { timeout: 35_000 }, async () => {
  const origin = 'telegram:7:chat:506';
  const store = await syntheticGateway('silent-combinations', { toolAllowlist: ['read'] });
  const chat = await store.gateway.conversationFor(origin, context);
  const providerError = 'SYNTHETIC-SILENT-FAILURE-TEXT';
  let released = false;
  let markReleased;
  const release = new Promise((resolve) => { markReleased = resolve; });
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  // Hold every scheduled model request until the test has inspected the live target's authority.
  const gate = async (message) => {
    if (!released) {
      markStarted();
      await release;
    }
    return message;
  };
  let scheduled = false;
  let listed = false;
  store.faux.setResponses(Array.from({ length: 40 }, () => routeByContent([
    { when: ({ input }) => input === scheduledContent('silent empty reminder'), respond: () => gate(fauxAssistantMessage('')) },
    {
      when: ({ input }) => input === scheduledContent('silent failing reminder'),
      respond: () => gate(fauxAssistantMessage('', { stopReason: 'error', errorMessage: providerError })),
    },
    { when: ({ input }) => input === scheduledContent('legacy reminder'), respond: () => gate(fauxAssistantMessage('LEGACY-DELIVERED')) },
    {
      when: ({ input }) => input === 'schedule silent jobs' && !scheduled,
      respond: () => {
        scheduled = true;
        const at = new Date(Date.now() + 1_500).toISOString();
        return fauxAssistantMessage([
          fauxToolCall('cron', {
            action: 'add', message: 'silent empty reminder', name: 'silent empty', silent: true, at,
          }, { id: 'silent-empty-add' }),
          fauxToolCall('cron', {
            action: 'add', message: 'silent failing reminder', name: 'silent failing', silent: true, at,
          }, { id: 'silent-failing-add' }),
          fauxToolCall('cron', {
            action: 'add', message: 'legacy reminder', name: 'legacy reminder', at,
          }, { id: 'legacy-add' }),
        ], { stopReason: 'toolUse' });
      },
    },
    {
      when: ({ input }) => input === 'list the silent jobs' && !listed,
      respond: () => {
        listed = true;
        return fauxAssistantMessage([
          fauxToolCall('cron', { action: 'list' }, { id: 'silent-list' }),
        ], { stopReason: 'toolUse' });
      },
    },
    { when: () => true, respond: () => fauxAssistantMessage('synthetic cron fallback') },
  ])));
  const settledWatcher = changeWatcher(store.gateway.harness, allJobsSettled(chat.id, 3), 'silent jobs settled');
  let reopened;
  try {
    const submission = await chat.submit({ type: 'input', content: 'schedule silent jobs' }, context);
    assert.equal((await submission.wait(context)).status, 'done');

    // Confirmation and list text both name the silence, so the setting is visible, not implied.
    const confirmation = await toolResultText(chat, 'silent-empty-add', context);
    assert.match(confirmation ?? '', /delivery: silent/);
    const legacyConfirmation = await toolResultText(chat, 'legacy-add', context);
    assert.ok(legacyConfirmation !== undefined, 'the legacy job has a confirmation');
    assert.ok(!legacyConfirmation.includes('delivery: silent'), legacyConfirmation);

    // A job document written before `silent` existed lacks the field; absence must mean false.
    await store.gateway.harness.commit(async (tx) => {
      const doc = await tx.doc(CronJobsDoc, chat.id);
      const legacy = doc.jobs.find((job) => job.name === 'legacy reminder');
      assert.ok(legacy !== undefined);
      delete legacy.silent;
    }, context);
    assert.equal(
      (await store.gateway.harness.snapshot(CronJobsDoc, chat.id, context))
        .jobs.find((job) => job.name === 'legacy reminder').silent,
      undefined,
    );

    const listing = await chat.submit({ type: 'input', content: 'list the silent jobs' }, context);
    assert.equal((await listing.wait(context)).status, 'done');
    const listText = await toolResultText(chat, 'silent-list', context);
    assert.match(listText ?? '', /delivery: silent/);
    assert.match(listText ?? '', /legacy reminder/);

    // The first scheduled request is held, so the background target's live authority is observable.
    await started;
    const running = (await store.gateway.harness.snapshot(CronJobsDoc, chat.id, context)).jobs;
    let target;
    for (const job of running) {
      if (job.executionTaskId === null) continue;
      const record = await store.gateway.harness.getTask(job.executionTaskId, context);
      const candidate = record?.state.checkpoint?.targetConversationId;
      if (Number.isSafeInteger(candidate)) {
        target = candidate;
        break;
      }
    }
    assert.ok(Number.isSafeInteger(target), 'the background run prepared a reachable target');
    const targetHandle = await store.gateway.harness.conversation(target, context);
    const targetTools = toolNames(await targetHandle.agent(context));
    assert.ok(targetTools.includes('read'), `the target holds the captured read tool: ${targetTools}`);
    for (const forbidden of ['telegram', 'cron', 'write', 'bash', 'worker', 'mcp']) {
      assert.ok(!targetTools.includes(forbidden), `a background target must not hold ${forbidden}: ${targetTools}`);
    }
    const capture = await store.gateway.harness.snapshot(ConfigToolCaptureDoc, target, context);
    assert.deepEqual([...capture.tools].sort(), ['read']);

    released = true;
    markReleased();
    await settledWatcher.promise;

    const jobs = (await store.gateway.harness.snapshot(CronJobsDoc, chat.id, context)).jobs;
    const byName = (name) => jobs.find((job) => job.name === name);
    assert.equal(byName('silent empty').silent, true);
    assert.equal(byName('silent failing').silent, true);
    assert.equal(byName('legacy reminder').silent, undefined);
    assert.equal(byName('silent empty').lastOutcome.status, 'ok');
    assert.equal(byName('silent failing').lastOutcome.status, 'error');
    assert.equal(byName('legacy reminder').lastOutcome.status, 'ok');

    const records = await store.gateway.cronOutbox.list(origin, context);
    assert.equal(
      records.length, 2,
      `only the failure notice and the legacy answer are queued: ${JSON.stringify(records.map((record) => record.text))}`,
    );
    const failing = byName('silent failing');
    const failure = records.find((record) => record.id.startsWith(`cron:${failing.id}:`));
    assert.ok(failure !== undefined, 'a silent job still queues its sanitized failure notice');
    assert.equal(failure.text, cronOutcomeNotice('failed', failing.id, failing.lastOutcome.scheduledAtMs));
    assert.ok(!failure.text.includes(providerError));
    assert.ok(!failure.text.includes('silent failing reminder'));
    assert.ok(records.some((record) => record.text === 'LEGACY-DELIVERED'), 'a legacy job still delivers');
    const empty = byName('silent empty');
    assert.ok(!records.some((record) =>
      record.text === cronOutcomeNotice('empty', empty.id, empty.lastOutcome.scheduledAtMs)),
    'a silent empty answer queues no empty-result notice');

    // Each settled one-off target retired its capture; the shared catch-all holds no tools after.
    for (const job of jobs) {
      assert.equal(
        await store.gateway.harness.snapshot(ConfigToolCaptureDoc, job.lastOutcome.conversationId, context),
        undefined,
      );
    }
    const targetAfter = await store.gateway.harness.conversation(jobs[0].lastOutcome.conversationId, context);
    assert.deepEqual((await targetAfter.agent(context)).tools, []);

    // Reopen: suppressed occurrences are not re-admitted and the stored setting survives.
    await store.gateway.close(context);
    reopened = await openGateway(store.config, context, { models: store.models });
    await reopened.harness.waitForIdle(context).catch(() => undefined);
    const afterReopen = await reopened.cronOutbox.list(origin, context);
    assert.equal(afterReopen.length, 2);
    assert.deepEqual(
      afterReopen.map((record) => record.id).sort(),
      records.map((record) => record.id).sort(),
      'the same two records, no second admission after reopen',
    );
    const jobsAfter = (await reopened.harness.snapshot(CronJobsDoc, chat.id, context)).jobs;
    assert.equal(jobsAfter.find((job) => job.name === 'silent empty').silent, true);
    assert.equal(jobsAfter.find((job) => job.name === 'legacy reminder').silent, undefined);
  } finally {
    released = true;
    markReleased?.();
    settledWatcher.stop();
    if (reopened !== undefined) await reopened.close(context).catch(() => undefined);
    else await store.gateway.close(context).catch(() => undefined);
    await rm(store.directory, { recursive: true, force: true });
  }
});

test('silent and [SILENT] origin runs stay undelivered while an ordinary chat answer keeps its text', { timeout: 25_000 }, async () => {
  const origin = 'telegram:7:chat:507';
  const store = await syntheticGateway('silent-origin');
  const chat = await store.gateway.conversationFor(origin, context);
  let scheduled = false;
  const scheduledInputs = [];
  store.faux.setResponses(Array.from({ length: 20 }, () => routeByContent([
    {
      when: ({ input }) => input.startsWith('silent origin reminder'),
      respond: ({ input }) => {
        scheduledInputs.push(input);
        return fauxAssistantMessage('SILENT-ORIGIN-ANSWER');
      },
    },
    {
      when: ({ input }) => input.startsWith('marker origin reminder'),
      respond: ({ input }) => {
        scheduledInputs.push(input);
        return fauxAssistantMessage('  [SILENT]  ');
      },
    },
    {
      when: ({ input }) => input === 'schedule silent origin jobs' && !scheduled,
      respond: () => {
        scheduled = true;
        const at = new Date(Date.now() + 1_500).toISOString();
        return fauxAssistantMessage([
          fauxToolCall('cron', {
            action: 'add', message: 'silent origin reminder', name: 'silent origin', isolated: false, silent: true, at,
          }, { id: 'silent-origin-add' }),
          fauxToolCall('cron', {
            action: 'add', message: 'marker origin reminder', name: 'marker origin', isolated: false, at,
          }, { id: 'marker-origin-add' }),
        ], { stopReason: 'toolUse' });
      },
    },
    { when: ({ input }) => input === 'ordinary echo', respond: () => fauxAssistantMessage('  [SILENT]  ') },
    { when: () => true, respond: () => fauxAssistantMessage('Scheduled the origin jobs.') },
  ])));
  const settledWatcher = changeWatcher(store.gateway.harness, allJobsSettled(chat.id, 2), 'origin jobs settled');
  try {
    const submission = await chat.submit({ type: 'input', content: 'schedule silent origin jobs' }, context);
    assert.equal((await submission.wait(context)).status, 'done');
    await settledWatcher.promise;

    assert.deepEqual(
      scheduledInputs.sort(),
      [scheduledContent('silent origin reminder'), scheduledContent('marker origin reminder')].sort(),
      'each origin run receives the appended marker instruction',
    );
    const jobs = (await store.gateway.harness.snapshot(CronJobsDoc, chat.id, context)).jobs;
    assert.equal(jobs.length, 2);
    for (const job of jobs) {
      assert.equal(job.mode, 'origin');
      assert.equal(job.lastOutcome.status, 'ok');
      assert.equal(job.lastOutcome.conversationId, chat.id);
    }
    assert.equal(jobs.find((job) => job.name === 'silent origin').silent, true);
    assert.equal(jobs.find((job) => job.name === 'marker origin').silent, false);
    assert.equal(
      await store.gateway.harness.snapshot(CronDeliveriesDoc, chat.id, context),
      undefined,
      'neither suppressed origin result creates an outbox document',
    );
    assert.equal((await store.gateway.cronOutbox.list(origin, context)).length, 0);

    // Both answers remain in the origin transcript, marker text included; only delivery is suppressed.
    const before = (await chat.entries({}, 500, undefined, context)).items;
    const textsBefore = assistantTexts(before);
    assert.ok(textsBefore.includes('SILENT-ORIGIN-ANSWER'));
    assert.equal(
      textsBefore.filter((text) => text.trim() === '[SILENT]').length,
      1,
      'the marker occurrence kept one answer in the origin transcript',
    );

    // The marker has no meaning in an ordinary chat turn: the answer stays exactly as written.
    const ordinary = await chat.submit({ type: 'input', content: 'ordinary echo' }, context);
    assert.equal((await ordinary.wait(context)).status, 'done');
    const after = (await chat.entries({}, 500, undefined, context)).items;
    const textsAfter = assistantTexts(after);
    assert.equal(
      textsAfter.filter((text) => text.trim() === '[SILENT]').length,
      2,
      'an ordinary chat answer is neither suppressed nor rewritten',
    );
    assert.equal(
      textsAfter.filter((text) => text === '  [SILENT]  ').length,
      2,
      'the ordinary answer keeps its exact literal text',
    );
    assert.equal(
      await store.gateway.harness.snapshot(CronDeliveriesDoc, chat.id, context),
      undefined,
      'an ordinary chat answer never enters the cron outbox',
    );
  } finally {
    settledWatcher.stop();
    await store.gateway.close(context);
    await rm(store.directory, { recursive: true, force: true });
  }
});

test('[SILENT] suppresses only its own background occurrence and a later occurrence still delivers', { timeout: 25_000 }, async () => {
  const origin = 'telegram:7:chat:508';
  const store = await syntheticGateway('silent-marker-background');
  const chat = await store.gateway.conversationFor(origin, context);
  let occurrences = 0;
  let scheduled = false;
  const scheduledInputs = [];
  store.faux.setResponses(Array.from({ length: 40 }, () => routeByContent([
    {
      when: ({ input }) => input.startsWith('marker background reminder'),
      respond: ({ input }) => {
        scheduledInputs.push(input);
        occurrences += 1;
        // The first occurrence is a trimmed marker with surrounding whitespace; the second is real.
        return fauxAssistantMessage(occurrences === 2 ? 'MARKER-SECOND-RESULT' : '  [SILENT]  ');
      },
    },
    {
      when: ({ input }) => input === 'schedule the marker background job' && !scheduled,
      respond: () => {
        scheduled = true;
        return fauxAssistantMessage([
          fauxToolCall('cron', {
            action: 'add', message: 'marker background reminder', name: 'marker background', every_seconds: 1,
          }, { id: 'marker-background-add' }),
        ], { stopReason: 'toolUse' });
      },
    },
    { when: () => true, respond: () => fauxAssistantMessage('Scheduled the marker background job.') },
  ])));
  const watcher = changeWatcher(
    store.gateway.harness, deliveryWithText(chat.id, 'MARKER-SECOND-RESULT'), 'second occurrence delivery',
  );
  try {
    const submission = await chat.submit({ type: 'input', content: 'schedule the marker background job' }, context);
    assert.equal((await submission.wait(context)).status, 'done');
    await watcher.promise;

    assert.equal(scheduledInputs.length, 2, 'both background occurrences reached the model');
    for (const input of scheduledInputs) {
      assert.equal(
        input,
        scheduledContent('marker background reminder'),
        'each background run receives the appended marker instruction',
      );
    }
    const jobs = (await store.gateway.harness.snapshot(CronJobsDoc, chat.id, context)).jobs;
    assert.equal(jobs.length, 1);
    const job = jobs[0];
    assert.equal(job.mode, 'background');
    assert.equal(job.silent, false, 'the marker suppresses one occurrence, not the job');
    const firstAt = job.createdAtMs + 1000;
    const secondAt = firstAt + 1000;
    const records = await store.gateway.cronOutbox.list(origin, context);
    assert.equal(
      records.length, 1,
      `only the second occurrence is queued: ${JSON.stringify(records.map((record) => record.text))}`,
    );
    assert.equal(records[0].text, 'MARKER-SECOND-RESULT');
    assert.equal(records[0].id, `cron:${job.id}:${secondAt}`);
    assert.ok(!records.some((record) => record.id === `cron:${job.id}:${firstAt}`));
  } finally {
    watcher.stop();
    await store.gateway.close(context);
    await rm(store.directory, { recursive: true, force: true });
  }
});
