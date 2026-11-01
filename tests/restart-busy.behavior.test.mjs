// Busy-restart protection: one host gate refuses `/restart` while live work would be interrupted.
//
// A refused restart must acknowledge nothing, tear nothing down and promise nothing, so the owner can
// finish or abort the work and ask again in the same process. A sleeping native timer is an armed
// schedule, not active work, so a configured cron job never keeps the gateway permanently busy.
// These checks use the real Gateway, a faux provider, a temporary workspace and the real private
// socket; no live runtime, store, configuration, credential or service is touched.
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
  { renderBackgroundStatus },
  { CronJobsDoc },
  { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall },
  { BACKGROUND_CONTEXT },
  { prepareDataDirectory },
  { gatewaySocketPath, serveLocalGateway },
  { connectLocalGateway },
  { runTerminalConversation },
  { createRestartCoordinator, RESTART_BUSY_MESSAGE, RestartBusyError },
] = await Promise.all([
  import(new URL('../dist/config.js', import.meta.url).href),
  import(new URL('../dist/runtime.js', import.meta.url).href),
  import(new URL('../dist/background-status.js', import.meta.url).href),
  import(new URL('../dist/automation/cron.js', import.meta.url).href),
  import(`${modules}/pi-ai/dist/index.js`),
  import(`${modules}/chord/dist/context/index.js`),
  import(new URL('../dist/store.js', import.meta.url).href),
  import(new URL('../dist/local/server.js', import.meta.url).href),
  import(new URL('../dist/local/client.js', import.meta.url).href),
  import(new URL('../dist/terminal/index.js', import.meta.url).href),
  import(new URL('../dist/restart.js', import.meta.url).href),
]);

const context = BACKGROUND_CONTEXT;
const WAIT_MS = 15_000;
const PROVIDER = 'restart-fixture';
const MODEL = { provider: PROVIDER, modelId: 'synthetic' };
const SESSION = 'cli:restart-busy';
const RESTART_LINE = /^Restart: blocked by (\d+) active tasks? gateway-wide; finish or abort that work first$/m;

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
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

async function fixtureWorkspace(label) {
  const directory = await mkdtemp(join(tmpdir(), `nanobot-restart-busy-${label}-`));
  const workspace = join(directory, 'workspace');
  const dataDir = join(directory, 'state');
  await mkdir(workspace, { recursive: true });
  return { directory, workspace, dataDir };
}

/** Real Gateway over a faux dispatcher; every model request is recorded. */
async function syntheticGateway(label, script, overrides = {}) {
  const fixture = await fixtureWorkspace(label);
  const faux = fauxProvider({ provider: PROVIDER, models: [{ id: MODEL.modelId, name: 'Synthetic restart model' }] });
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

function outputCapture() {
  const chunks = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { output, text: () => chunks.join('') };
}

test('a busy restart is refused before any acknowledgement or teardown, and a later retry works', async () => {
  const events = [];
  let active = { interrupting: 2 };
  const coordinator = createRestartCoordinator({
    activeWork: async () => active,
    context,
    teardown: () => events.push('teardown'),
  });

  await assert.rejects(coordinator.request(async () => { events.push('ack'); }), RestartBusyError);
  assert.deepEqual(events, [], 'a busy refusal acknowledges nothing and tears nothing down');
  assert.equal(coordinator.accepted(), false, 'a refusal is not a restart claim');
  assert.equal(new RestartBusyError().message, RESTART_BUSY_MESSAGE);
  assert.match(RESTART_BUSY_MESSAGE, /nothing was restarted/i, 'the fixed reason carries the no-effect guarantee');
  assert.doesNotMatch(RESTART_BUSY_MESSAGE, /chat|conversation|task \d/, 'no chat or task identifier is named');

  // The same host gate may restart once the work settled: a refusal is not latched.
  active = { interrupting: 0 };
  await coordinator.request(async () => { events.push('ack'); });
  assert.deepEqual(events, ['ack', 'teardown'], 'the acknowledgement is flushed before the teardown');
  assert.equal(coordinator.accepted(), true);

  // A second request while the first is stopping the gateway refuses without another ack or teardown.
  await assert.rejects(coordinator.request(async () => { events.push('again'); }), /already in progress/);
  assert.deepEqual(events, ['ack', 'teardown']);
});

test('a live generation blocks a restart, an armed timer does not, and idle succeeds', { timeout: 60_000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  let issued = false;
  const store = await syntheticGateway('gateway', async (request, options) => {
    const input = lastUserText(request.messages);
    if (input === 'schedule the reminder' && !issued) {
      issued = true;
      return fauxAssistantMessage([
        fauxToolCall('cron', {
          action: 'add',
          message: 'deliver the reminder',
          name: 'restart timer',
          at: new Date(Date.now() + 3_600_000).toISOString(),
        }, { id: 'cron-add' }),
      ], { stopReason: 'toolUse' });
    }
    if (input !== 'hold this turn') return fauxAssistantMessage('IDLE-RESULT');
    entered.resolve();
    await new Promise((resolve) => {
      const abort = () => resolve();
      if (options?.signal?.aborted) return abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      release.promise.then(() => {
        options.signal?.removeEventListener('abort', abort);
        resolve();
      });
    });
    return fauxAssistantMessage('HELD-RESULT');
  }, { cron: { enabled: true } });
  t.after(() => cleanup(store, () => release.resolve()));

  const origin = await store.gateway.conversationFor(SESSION, context);
  const harness = store.gateway.harness;
  const events = [];
  const coordinator = createRestartCoordinator({
    activeWork: (ctx) => store.gateway.activeWork(ctx),
    context,
    teardown: () => events.push('teardown'),
  });

  // One generation is genuinely in flight: the restart would cut into it.
  const submission = await origin.submit({ type: 'input', content: 'hold this turn' }, context);
  await waitFor(() => store.calls.includes('hold this turn'), 'the held generation');
  await entered.promise;
  const busy = await store.gateway.activeWork(context);
  assert.ok(busy.interrupting >= 1, 'a running generation is active work');
  const busyStatus = await store.gateway.backgroundStatus(SESSION, context);
  assert.equal(busyStatus.active.interrupting, busy.interrupting, 'status reports the same active count');
  const busyText = renderBackgroundStatus(busyStatus).join('\n');
  assert.match(busyText, RESTART_LINE);
  assert.equal(JSON.stringify(busyStatus).includes('hold this turn'), false,
    'the status carries a count, never the turn text');

  await assert.rejects(coordinator.request(async () => { events.push('ack'); }), RestartBusyError);
  assert.deepEqual(events, [], 'a busy refusal claims no restart');
  assert.equal(coordinator.accepted(), false);

  // Idle again: nothing is active and the same gate may restart.
  release.resolve();
  assert.equal((await submission.wait(context)).status, 'done');
  await origin.waitForIdle(context);
  await waitFor(async () => (await store.gateway.activeWork(context)).interrupting === 0, 'idle active work');
  const idleStatus = await store.gateway.backgroundStatus(SESSION, context);
  assert.deepEqual(idleStatus.active, { interrupting: 0 });
  assert.doesNotMatch(renderBackgroundStatus(idleStatus).join('\n'), /^Restart:/m);

  // An armed cron timer is sleeping, not active: it must not keep the gateway permanently busy.
  const scheduling = await origin.submit({ type: 'input', content: 'schedule the reminder' }, context);
  assert.equal((await scheduling.wait(context)).status, 'done');
  await origin.waitForIdle(context);
  const jobs = async () => (await harness.snapshot(CronJobsDoc, origin.id, context))?.jobs ?? [];
  await waitFor(async () => {
    const [job] = await jobs();
    if (job?.timerTaskId === null || job?.timerTaskId === undefined) return false;
    return (await harness.getTask(job.timerTaskId, context))?.state.status === 'sleeping';
  }, 'the armed sleeping timer');
  const timerStatus = await store.gateway.backgroundStatus(SESSION, context);
  assert.equal(timerStatus.cron.scheduled, 1, 'the job is scheduled');
  assert.deepEqual(timerStatus.active, { interrupting: 0 }, 'a sleeping timer is not active work');
  assert.doesNotMatch(renderBackgroundStatus(timerStatus).join('\n'), /^Restart:/m);

  await coordinator.request(async () => { events.push('ack'); });
  assert.deepEqual(events, ['ack', 'teardown'], 'an armed timer does not block the restart');
  assert.equal(coordinator.accepted(), true);
  assert.equal(store.calls.includes('deliver the reminder'), false, 'nothing fired a model call');
});

test('the local CLI /restart prints the fixed refusal and restarts once the work is done', { timeout: 60_000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  const store = await syntheticGateway('socket', async (_request, options) => {
    entered.resolve();
    await new Promise((resolve) => {
      const abort = () => resolve();
      if (options?.signal?.aborted) return abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      release.promise.then(() => {
        options.signal?.removeEventListener('abort', abort);
        resolve();
      });
    });
    return fauxAssistantMessage('HELD-RESULT');
  });
  const prepared = await prepareDataDirectory(store.config);
  const socketPath = gatewaySocketPath(prepared.canonicalDataDir);
  const events = [];
  const coordinator = createRestartCoordinator({
    activeWork: (ctx) => store.gateway.activeWork(ctx),
    context,
    teardown: () => events.push('teardown'),
  });
  const server = await serveLocalGateway({
    socketPath,
    gateway: store.gateway,
    context,
    tools: ['read', 'write', 'edit'],
    contextRefresh: false,
    presets: false,
    restart: { supported: true, request: (acknowledge) => coordinator.request(acknowledge) },
  });
  const client = await connectLocalGateway({ socketPath, conversation: 'restart-busy', context });
  t.after(() => cleanup(store, async () => {
    release.resolve();
    await client.close();
    await server.close();
  }));

  const origin = await store.gateway.conversationFor(SESSION, context);
  const submission = await origin.submit({ type: 'input', content: 'hold this turn' }, context);
  await entered.promise;

  const refused = outputCapture();
  await runTerminalConversation(client, context, {
    input: (async function* () { yield '/restart'; })(),
    output: refused.output,
    restart: () => client.restart(context),
  });
  assert.match(refused.text(), /Gateway restart refused: live work would be interrupted/);
  assert.match(refused.text(), /nothing was restarted/i, 'the refusal carries the no-effect guarantee');
  assert.doesNotMatch(refused.text(), /Gateway restarting/, 'no restart is claimed');
  assert.deepEqual(events, [], 'the refusal tore nothing down');
  assert.equal(coordinator.accepted(), false);
  assert.equal((await store.gateway.harness.inspect(context)).scheduling, 'running',
    'the gateway is still serving after the refusal');

  release.resolve();
  assert.equal((await submission.wait(context)).status, 'done');
  await origin.waitForIdle(context);
  await waitFor(async () => (await store.gateway.activeWork(context)).interrupting === 0, 'idle active work');

  const accepted = outputCapture();
  await runTerminalConversation(client, context, {
    input: (async function* () { yield '/restart'; })(),
    output: accepted.output,
    restart: () => client.restart(context),
  });
  assert.match(accepted.text(), /Gateway restarting; this terminal disconnects\./);
  assert.deepEqual(events, ['teardown'], 'the accepted restart tears down exactly once');
  assert.equal(coordinator.accepted(), true);
});
