// Agent file delivery into the app channel: the model-facing `app` tool's `send` and `artifact`
// actions, the one-commit durable assistant message and its attachment record, the sandboxed
// `?view=artifact` download, bounded refusals and the tool's scope.
//
// Real Gateway over a temporary store, faux provider, one real loopback listener on an ephemeral
// port and a synthetic WebSocket client speaking protocol v2. Every wait is event-driven; no test
// sleeps on a schedule, and every handle is cleaned up by the test that created it.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const packageRoot = process.env.PI_NANOBOT_CANDIDATE ?? new URL('../', import.meta.url).pathname;
const modules = join(packageRoot, 'node_modules/@earendil-works');
const [
  { parseConfig },
  { ToolResultEntry },
  { CronJobsDoc },
  { WorkerRecordsDoc },
  { createAppFiles },
] = await Promise.all([
  import(new URL('../dist/config.js', import.meta.url).href),
  import(`${modules}/pi-durable/dist/index.js`),
  import(new URL('../dist/automation/cron.js', import.meta.url).href),
  import(new URL('../dist/workers/worker-task.js', import.meta.url).href),
  import(new URL('../dist/channels/app-files.js', import.meta.url).href),
]);

import {
  APP_CHAT_SESSION_KEY,
  appFilesState,
  appState,
  context,
  deviceClient,
  fauxAssistantMessage,
  fauxToolCall,
  openAppStore,
  postPair,
  startApp,
  untilAsync,
} from './fixtures/app-harness.mjs';
import { fauxModels as dFauxModels } from './fixtures/discord-harness.mjs';

const ARTIFACT_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; " +
  "frame-ancestors 'self'";

const SVG_BYTES = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
const HTML_BYTES = '<!doctype html><html><body><h1>ARTIFACT</h1></body></html>';

/** Tool names of one agent, whether the harness reports names or registrations. */
function toolNames(agent) {
  return (agent.tools ?? []).map((tool) => (typeof tool === 'string' ? tool : tool.name));
}

/** One app channel with a paired device, hello'd stream and request/send helpers. */
async function withApp(label, options, body) {
  const store = await openAppStore(label, {
    tools: options.tools ?? ['read'],
    media: options.media ?? {},
    files: options.files,
    ...(options.rawConfig === undefined ? {} : { rawConfig: options.rawConfig }),
    ...(options.gatewayOptions === undefined ? {} : { gatewayOptions: options.gatewayOptions }),
  });
  if (options.script !== undefined) store.script(options.script);
  const app = startApp(store);
  let device;
  try {
    const base = `http://127.0.0.1:${await app.port}`;
    const created = await store.gateway.appConsole.console().pair('phone');
    assert.equal('refused' in created, false, `pairing was refused: ${JSON.stringify(created)}`);
    const exchange = await postPair(base, created.code, 'phone');
    assert.equal(exchange.status, 204, 'pairing exchange failed');
    const cookie = exchange.cookie.split(';')[0];
    device = deviceClient(base, cookie);
    await device.open();
    device.send({ type: 'req', id: 'hello', op: 'hello', v: 2, cursor: null });
    await device.wait(() => device.response('hello') !== undefined, 'hello reply');
    let counter = 0;
    const request = async (op, fields = {}) => {
      const id = `r${++counter}`;
      device.send({ type: 'req', id, op, ...fields });
      await device.wait(() => device.response(id) !== undefined, `${op} reply`);
      return device.response(id);
    };
    const send = async (key, text) => {
      const reply = await request('send', { key, text });
      assert.equal(reply.ok, true, `send failed: ${JSON.stringify(reply)}`);
      await device.wait(() => device.events('settled').some((event) => event.key === key), `${key} settled`);
    };
    await body({ store, base, cookie, device, request, send });
  } finally {
    await device?.close();
    await app.stop();
    await store.close();
  }
}

/** The tool results that reached one conversation's transcript, by call id. */
async function toolResults(conversation, id) {
  const items = (await conversation.entries({}, 300, undefined, context)).items;
  const results = items.filter(ToolResultEntry.is).map((entry) => {
    const message = entry.model?.[0];
    return {
      id: message?.toolCallId,
      isError: message?.isError === true,
      text: (message?.content ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('\n'),
    };
  });
  const result = results.find((candidate) => candidate.id === id);
  assert.ok(result, `synthetic ${id} call reached the transcript`);
  return result;
}

/** Every assistant message that carries an attachment, in cursor order. */
function agentFileMessages(state) {
  return state.events.filter((event) =>
    event.event === 'message' && event.role === 'assistant' && (event.attachments?.length ?? 0) > 0);
}

test('an agent send appends one durable assistant message with a downloadable attachment', { timeout: 30_000 }, async () => {
  await withApp('agent-send', {
    files: { 'notes/report.txt': 'REPORT-BYTES' },
    script: [
      () => fauxAssistantMessage([
        fauxToolCall('app', { action: 'send', path: 'notes/report.txt', caption: 'Here is the report' },
          { id: 'send-call' }),
      ], { stopReason: 'toolUse' }),
      () => fauxAssistantMessage('SENT-AND-DONE'),
    ],
  }, async ({ store, base, cookie, send }) => {
    await send('send-1', 'send the report');

    const chat = await store.gateway.conversationFor(APP_CHAT_SESSION_KEY, context);
    const receipt = await toolResults(chat, 'send-call');
    assert.equal(receipt.isError, false, receipt.text);
    assert.match(receipt.text, /Delivered the workspace file notes\/report\.txt as one attachment \(12 bytes\)/u);
    assert.ok(!receipt.text.includes(store.workspace), 'the receipt carries no host path');
    assert.doesNotMatch(receipt.text, /REPORT-BYTES/u, 'the receipt carries no file content');

    const state = await appState(store.gateway);
    const messages = agentFileMessages(state);
    assert.equal(messages.length, 1, 'exactly one assistant message was appended');
    const message = messages[0];
    assert.equal(message.text, 'Here is the report');
    assert.equal(message.thread ?? 'main', 'main');
    assert.match(message.id, /^agent:tool:\d+$/u, 'the message id is derived from the durable tool task');
    assert.equal(message.attachments.length, 1);
    const [info] = message.attachments;
    assert.equal(info.name, 'report.txt');
    assert.equal(info.type, 'text/plain');
    assert.equal(info.size, 12);
    assert.equal(info.kind, 'file');

    const files = await appFilesState(store.gateway);
    const record = files.uploads.find((entry) => entry.id === info.id);
    assert.ok(record !== undefined, 'the referenced record is durable');
    assert.equal(typeof record.referencedAtMs, 'number', 'the record is admitted referenced');
    assert.equal(record.messageId, message.id);
    assert.equal(record.kind, 'file');
    assert.ok(!record.path.startsWith('/'), 'the record stores a workspace-relative locator');

    // Any paired device may fetch it; the plain download keeps the fixed headers.
    const download = await fetch(`${base}/v1/files/${info.id}`, { headers: { cookie } });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), 'REPORT-BYTES');
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(download.headers.get('content-security-policy'), 'sandbox');
    assert.equal(download.headers.get('content-type'), 'text/plain');
    assert.match(download.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''report\.txt$/u);
    assert.equal(download.headers.get('cache-control'), 'private, max-age=31536000, immutable');

    // `?view=artifact` on a non-artifact behaves exactly like a normal download.
    const wrongView = await fetch(`${base}/v1/files/${info.id}?view=artifact`, { headers: { cookie } });
    assert.equal(wrongView.status, 200);
    assert.equal(wrongView.headers.get('content-security-policy'), 'sandbox');
    assert.match(wrongView.headers.get('content-disposition'), /^attachment;/u);
    assert.equal(await wrongView.text(), 'REPORT-BYTES');

    // An unknown id stays not found.
    assert.equal((await fetch(`${base}/v1/files/f_${'A'.repeat(22)}`, { headers: { cookie } })).status, 404);
  });
});

test('an agent artifact is stored as kind artifact and previews inline under the sandbox policy', { timeout: 30_000 }, async () => {
  await withApp('agent-artifact', {
    files: {
      'artifacts/page.html': HTML_BYTES,
      'artifacts/chart.svg': SVG_BYTES,
      'artifacts/notes.htm': HTML_BYTES,
    },
    script: [
      () => fauxAssistantMessage([
        fauxToolCall('app', { action: 'artifact', path: 'artifacts/page.html', title: 'The explainer' },
          { id: 'html-artifact' }),
        fauxToolCall('app', { action: 'artifact', path: 'artifacts/chart.svg' }, { id: 'svg-artifact' }),
        fauxToolCall('app', { action: 'artifact', path: 'artifacts/notes.htm' }, { id: 'htm-artifact' }),
      ], { stopReason: 'toolUse' }),
      () => fauxAssistantMessage('ARTIFACTS-SENT'),
    ],
  }, async ({ store, base, cookie, send }) => {
    await send('artifact-1', 'draw me an explainer');

    const chat = await store.gateway.conversationFor(APP_CHAT_SESSION_KEY, context);
    for (const id of ['html-artifact', 'svg-artifact', 'htm-artifact']) {
      const receipt = await toolResults(chat, id);
      assert.equal(receipt.isError, false, receipt.text);
      assert.match(receipt.text, /as a sandboxed artifact/u);
      assert.ok(!receipt.text.includes(store.workspace));
    }

    const state = await appState(store.gateway);
    const messages = agentFileMessages(state);
    assert.equal(messages.length, 3);
    const byName = new Map(messages.map((message) => [message.attachments[0].name, message]));
    assert.equal(byName.get('page.html').text, 'The explainer', 'the title is the message text');
    assert.equal(byName.get('chart.svg').text, '', 'an artifact without a title has empty text');
    for (const message of messages) {
      assert.equal(message.attachments[0].kind, 'artifact');
      assert.match(message.id, /^agent:tool:\d+$/u);
    }

    const files = await appFilesState(store.gateway);
    const records = files.uploads.filter((entry) => entry.kind === 'artifact');
    assert.equal(records.length, 3);
    const infoFor = (name) => byName.get(name).attachments[0];
    const html = infoFor('page.html');
    const svg = infoFor('chart.svg');
    const htm = infoFor('notes.htm');
    const recordFor = (info) => records.find((entry) => entry.id === info.id);
    assert.deepEqual([html.type, recordFor(html).type], ['text/html', 'text/html']);
    assert.deepEqual([htm.type, recordFor(htm).type], ['text/html', 'text/html']);
    assert.deepEqual([svg.type, recordFor(svg).type], ['image/svg+xml', 'image/svg+xml']);

    // The artifact view: inline, exact CSP, nosniff, and the stored type and bytes.
    const preview = await fetch(`${base}/v1/files/${html.id}?view=artifact`, { headers: { cookie } });
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-security-policy'), ARTIFACT_CSP);
    assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(preview.headers.get('content-type'), 'text/html');
    assert.equal(preview.headers.get('content-disposition'), 'inline');
    assert.equal(await preview.text(), HTML_BYTES);
    const head = await fetch(`${base}/v1/files/${html.id}?view=artifact`, { method: 'HEAD', headers: { cookie } });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-security-policy'), ARTIFACT_CSP);

    const svgPreview = await fetch(`${base}/v1/files/${svg.id}?view=artifact`, { headers: { cookie } });
    assert.equal(svgPreview.headers.get('content-security-policy'), ARTIFACT_CSP);
    assert.equal(svgPreview.headers.get('content-type'), 'image/svg+xml');
    assert.equal(svgPreview.headers.get('content-disposition'), 'inline');
    assert.equal(await svgPreview.text(), SVG_BYTES);

    // Without `view=artifact` an artifact is an ordinary attachment download.
    for (const info of [html, svg]) {
      const plain = await fetch(`${base}/v1/files/${info.id}`, { headers: { cookie } });
      assert.equal(plain.status, 200);
      assert.equal(plain.headers.get('content-security-policy'), 'sandbox');
      assert.match(plain.headers.get('content-disposition'), /^attachment;/u);
    }
  });
});

test('unsafe, oversize and wrong-extension agent files are refused with nothing appended', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-app-agent-refusals-'));
  const outside = join(directory, 'outside.txt');
  await writeFile(outside, 'OUTSIDE-SECRET');
  try {
    await withApp('agent-refusals', {
      files: {
        'notes/report.txt': 'REPORT-BYTES',
        'artifacts/big.html': Buffer.alloc(2 * 1024 * 1024 + 1, 0x61),
        'artifacts/big.bin': Buffer.alloc(20 * 1024 * 1024 + 1, 0x62),
      },
      script: [
        () => fauxAssistantMessage([
          fauxToolCall('app', { action: 'send', path: '../outside.txt' }, { id: 'traversal-send' }),
          fauxToolCall('app', { action: 'send', path: '/etc/hostname' }, { id: 'absolute-send' }),
          fauxToolCall('app', { action: 'send', path: 'linked.txt' }, { id: 'symlink-send' }),
          fauxToolCall('app', { action: 'artifact', path: 'notes/report.txt' }, { id: 'wrong-extension' }),
          fauxToolCall('app', { action: 'artifact', path: 'artifacts/big.html' }, { id: 'oversize-artifact' }),
          fauxToolCall('app', { action: 'send', path: 'artifacts/big.bin' }, { id: 'oversize-send' }),
        ], { stopReason: 'toolUse' }),
        () => fauxAssistantMessage('REFUSALS-DONE'),
      ],
    }, async ({ store, send }) => {
      // The symlink escapes the workspace even though its name is a plain relative path.
      await symlink(outside, join(store.workspace, 'linked.txt'));
      const before = agentFileMessages(await appState(store.gateway)).length;
      const recordsBefore = (await appFilesState(store.gateway)).uploads.length;

      await send('refusals-1', 'send everything');

      const chat = await store.gateway.conversationFor(APP_CHAT_SESSION_KEY, context);
      const expectations = {
        'traversal-send': /workspace-relative path/u,
        'absolute-send': /workspace-relative path/u,
        'symlink-send': /existing regular file inside the configured workspace/u,
        'wrong-extension': /must be a \.html, \.htm or \.svg file/u,
        'oversize-artifact': /larger than 2 MiB/u,
        'oversize-send': /larger than 20 MiB/u,
      };
      for (const [id, pattern] of Object.entries(expectations)) {
        const result = await toolResults(chat, id);
        assert.equal(result.isError, true, `${id} was refused: ${result.text}`);
        assert.match(result.text, pattern, id);
        assert.ok(!result.text.includes(store.workspace), `${id} leaks no host path`);
        assert.doesNotMatch(result.text, /OUTSIDE-SECRET|REPORT-BYTES/u, `${id} leaks no file content`);
      }

      const state = await appState(store.gateway);
      assert.equal(agentFileMessages(state).length, before,
        'a refused agent file appends no assistant file message');
      assert.equal((await appFilesState(store.gateway)).uploads.length, recordsBefore,
        'a refused agent file stores no record');
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the app tool exists only in mapped app chat conversations', { timeout: 60_000 }, async () => {
  const faux = dFauxModels([], {});
  const rawConfig = (raw) => {
    const { model: _model, allowedModels: _allowed, ...rest } = raw;
    return parseConfig({
      ...rest,
      model: { provider: 'fixture', modelId: 'alpha' },
      allowedModels: [{ provider: 'fixture', modelId: 'alpha' }],
      workers: { enabled: true },
      cron: { enabled: true },
    }, '/tmp');
  };
  await withApp('agent-scope', {
    rawConfig,
    gatewayOptions: { models: faux.models },
  }, async ({ store, send }) => {
    const chat = await store.gateway.conversationFor(APP_CHAT_SESSION_KEY, context);
    assert.ok(toolNames(await chat.agent(context)).includes('app'),
      `a mapped app chat is offered the app tool: ${toolNames(await chat.agent(context))}`);

    // The channel's own state conversation, the terminal chat, the root and an ownerless raw
    // conversation never become app chats.
    for (const key of ['app:channel-state', 'cli:default']) {
      const other = await store.gateway.conversationFor(key, context);
      assert.ok(!toolNames(await other.agent(context)).includes('app'), `${key} gets no app tool`);
    }
    const root = await store.gateway.harness.root(context);
    assert.ok(!toolNames(await root.agent(context)).includes('app'));
    const raw = await store.gateway.harness.createConversation(
      { ownership: { kind: 'ownerless' }, agent: { model: { provider: 'fixture', modelId: 'alpha' } } }, context);
    assert.ok(!toolNames(await raw.agent(context)).includes('app'));

    // A real worker child and a real scheduled run's automation conversation are never offered it.
    faux.gate.script([
      () => fauxAssistantMessage([
        fauxToolCall('worker', { action: 'start', task: 'read note.txt', workspace_mode: 'shared' },
          { id: 'worker-start' }),
        fauxToolCall('cron', {
          action: 'add', message: 'synthetic reminder', at: new Date(Date.now() + 500).toISOString(),
        }, { id: 'cron-add' }),
      ], { stopReason: 'toolUse' }),
      () => fauxAssistantMessage('SYNTHETIC-ANSWER'),
    ]);
    await send('background-1', 'start background work');

    let workerConversationId;
    await untilAsync(async () => {
      const record = await store.gateway.harness.snapshot(WorkerRecordsDoc, chat.id, context);
      workerConversationId = record?.workers?.[0]?.conversationId;
      return typeof workerConversationId === 'number';
    }, 'the worker child conversation to be recorded');
    const worker = await store.gateway.harness.conversation(workerConversationId, context);
    assert.ok(worker !== undefined);
    const workerTools = toolNames(await worker.agent(context));
    assert.ok(!workerTools.includes('app'), `a worker child gets no app tool: ${workerTools}`);

    let automationId;
    await untilAsync(async () => {
      const jobs = await store.gateway.harness.snapshot(CronJobsDoc, chat.id, context);
      automationId = jobs?.oneOffConversationId;
      return typeof automationId === 'number';
    }, 'the scheduled run to claim its automation conversation');
    const automation = await store.gateway.harness.conversation(automationId, context);
    const automationTools = toolNames(await automation.agent(context));
    assert.ok(!automationTools.includes('app'), `a scheduled run gets no app tool: ${automationTools}`);
    await untilAsync(async () => {
      const inspection = await store.gateway.harness.inspect(context);
      return inspection.tasks.every((entry) => entry.record.conversationId !== automationId
        || entry.record.state.status === 'terminal');
    }, 'the scheduled run to settle');
  });
});

test('a replayed app tool execution keeps its committed outcome when the file changed or vanished', { timeout: 30_000 }, async () => {
  await withApp('agent-replay', {
    files: { 'notes/report.txt': 'REPORT-BYTES' },
    script: [
      () => fauxAssistantMessage([
        fauxToolCall('app', { action: 'send', path: 'notes/report.txt', caption: 'Here is the report' },
          { id: 'send-call' }),
      ], { stopReason: 'toolUse' }),
      () => fauxAssistantMessage('SENT-AND-DONE'),
    ],
  }, async ({ store, send }) => {
    await send('replay-1', 'send the report');

    const message = agentFileMessages(await appState(store.gateway))[0];
    assert.ok(message !== undefined);
    // pi-durable replays the tool with its original task id, so the call identity is the message's.
    const callId = message.id.slice('agent:'.length);
    const recordsBefore = (await appFilesState(store.gateway)).uploads.length;
    const host = store.gateway.appActions.current();
    assert.ok(host !== undefined, 'the running adapter attached its action host');
    const request = { action: 'send', path: 'notes/report.txt', caption: 'Here is the report' };

    // The workspace file is gone, but the effect already happened: the replay reports it again
    // without reading the file or storing another copy.
    await rm(join(store.workspace, 'notes', 'report.txt'));
    const deleted = await host.act(APP_CHAT_SESSION_KEY, callId, request, context);
    assert.equal(deleted.ok, true, deleted.text);
    assert.match(deleted.text, /Delivered the workspace file notes\/report\.txt as one attachment \(12 bytes\)/u);
    assert.equal((await appFilesState(store.gateway)).uploads.length, recordsBefore, 'no second record');
    assert.equal(agentFileMessages(await appState(store.gateway)).length, 1, 'no second message');

    // A changed file is not the delivered file: the receipt still reports the committed copy.
    await writeFile(join(store.workspace, 'notes', 'report.txt'), 'CHANGED-BYTES-NOT-DELIVERED');
    const changed = await host.act(APP_CHAT_SESSION_KEY, callId, request, context);
    assert.equal(changed.ok, true, changed.text);
    assert.match(changed.text, /\(12 bytes\)/u, 'the receipt reports the committed size');
    assert.equal((await appFilesState(store.gateway)).uploads.length, recordsBefore, 'no orphan copy');
    assert.equal(agentFileMessages(await appState(store.gateway)).length, 1, 'still one message');
  });
});

test('a replayed storage adopts its existing copy instead of deleting bytes a record references', { timeout: 30_000 }, async () => {
  const store = await openAppStore('agent-adopt', { media: {} });
  try {
    const conversation = await store.gateway.conversationFor(APP_CHAT_SESSION_KEY, context);
    const files = createAppFiles({
      media: { workspace: store.workspace }, conversation, context, now: () => Date.now(),
    });
    const request = {
      identity: 'app:agent:tool:7', messageId: 'agent:tool:7', name: 'report.txt', type: 'text/plain',
      kind: 'file', bytes: Buffer.from('COMMITTED-BYTES'), maxBytes: 1 << 20,
    };
    const first = await files.storeAgent(request);
    assert.equal(first.status, 'stored');
    assert.equal(first.file.adopted, false, 'the first store created the bytes');
    await conversation.commit(async (tx) => { await files.admitAgent(tx, first.file); }, context);

    // The same execution runs again after a crash: it adopts the same locator, and a commit that
    // then fails must not delete the bytes the admitted record still references.
    const replay = await files.storeAgent(request);
    assert.equal(replay.status, 'stored');
    assert.equal(replay.file.adopted, true, 'the replay adopted the existing copy');
    assert.equal(replay.file.record.path, first.file.record.path);
    await replay.file.discard();

    const kept = await files.download(first.file.record.id);
    assert.ok(kept !== undefined, 'the committed record still downloads');
    assert.equal(await readFile(kept.absolutePath, 'utf8'), 'COMMITTED-BYTES');

    // Bytes this execution stored itself are still removed when its commit does not happen.
    const fresh = await files.storeAgent({ ...request, identity: 'app:agent:tool:8', messageId: 'agent:tool:8' });
    assert.equal(fresh.file.adopted, false);
    await fresh.file.discard();
    await assert.rejects(readFile(join(store.workspace, ...fresh.file.record.path.split('/'))), /ENOENT/u);
  } finally {
    await store.close();
  }
});

test('an admitted app side-thread fork is offered the app tool and can send', { timeout: 30_000 }, async () => {
  await withApp('agent-fork', {
    files: { 'notes/report.txt': 'REPORT-BYTES' },
    script: [
      () => fauxAssistantMessage('committed anchor answer'),
      () => fauxAssistantMessage([
        fauxToolCall('app', { action: 'send', path: 'notes/report.txt', caption: 'Fork file' },
          { id: 'fork-send' }),
      ], { stopReason: 'toolUse' }),
      () => fauxAssistantMessage('FORK-SENT'),
    ],
  }, async ({ store, device, request, send }) => {
    await send('anchor', 'context before fork');
    const answer = device.events('message').find((event) => event.role === 'assistant' && event.key === 'anchor');
    const created = await request('thread.create', {
      key: 'fork', from: { thread: 'main', messageId: answer.id }, title: 'Branch',
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    const child = await store.gateway.conversationFor(`${APP_CHAT_SESSION_KEY}:${created.thread}`, context);
    assert.ok(toolNames(await child.agent(context)).includes('app'),
      'the admitted fork is offered the app tool');

    const reply = await request('send', { thread: created.thread, key: 'child', text: 'send it here' });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    await device.wait(() => device.events('settled').some((event) => event.key === 'child'
      && event.outcome === 'answered'), 'fork answer');
    const receipt = await toolResults(child, 'fork-send');
    assert.equal(receipt.isError, false, receipt.text);
    assert.match(receipt.text, /Delivered the workspace file notes\/report\.txt as one attachment \(12 bytes\)/u);

    const messages = agentFileMessages(await appState(store.gateway));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].thread, created.thread, 'the file lands in the fork thread');
  });
});
