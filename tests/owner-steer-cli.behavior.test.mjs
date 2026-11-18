// Owner busy-mode for the CLI: `followUpMode: "steer"` places a message admitted while a turn is
// running into that turn after its tool round, and every input the turn consumes settles with the
// same committed answer entry — so the terminal prints that answer once. The default follow-up mode
// keeps its historical queueing, and a steer that arrives at the final boundary starts the next run.
//
// No live process, bot, credential, provider or network: the model is a faux provider over a
// temporary store, the CLI attaches through the real local gateway socket, and every wait is an
// explicit predicate with a deadline.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Writable } from 'node:stream';
import { test } from 'node:test';

const pkg = join(import.meta.dirname, '..');
const modules = `${pkg}/node_modules/@earendil-works`;
const { parseConfig } = await import(pathToFileURL(`${pkg}/dist/config.js`).href);
const { openGateway } = await import(pathToFileURL(`${pkg}/dist/runtime.js`).href);
const { prepareDataDirectory } = await import(pathToFileURL(`${pkg}/dist/store.js`).href);
const { gatewaySocketPath, serveLocalGateway } = await import(pathToFileURL(`${pkg}/dist/local/server.js`).href);
const { connectLocalGateway } = await import(pathToFileURL(`${pkg}/dist/local/client.js`).href);
const { runTerminalConversation } = await import(pathToFileURL(`${pkg}/dist/terminal/index.js`).href);
const { inProcessTerminalConversation } = await import(pathToFileURL(`${pkg}/dist/terminal/conversation.js`).href);
const { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } = await import(
  pathToFileURL(`${modules}/pi-ai/dist/index.js`).href
);
const { BACKGROUND_CONTEXT } = await import(pathToFileURL(`${modules}/chord/dist/context/index.js`).href);

const context = BACKGROUND_CONTEXT;
const timeoutMs = 15_000;

// Polling waits use the real timer (not a busy setImmediate spin, which starves parallel test files of CPU),
// captured at load so a test that mocks setTimeout cannot stall them.
const realSetTimeout = globalThis.setTimeout;

async function eventually(check, label) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => realSetTimeout(resolve, 2));
  }
}

function deferred() {
  const box = {};
  box.promise = new Promise((resolve) => { box.resolve = resolve; });
  return box;
}

/** Yield so already-queued watch callbacks and their serialized render steps can run. */
async function flush(rounds = 10) {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** A line source the test feeds one prompt at a time, so each admission is timed against a held turn. */
function pushableInput() {
  const values = [];
  let waiting;
  let ended = false;
  const wake = () => {
    const resume = waiting;
    waiting = undefined;
    resume?.();
  };
  return {
    async *iterate() {
      for (;;) {
        if (values.length > 0) {
          yield values.shift();
          continue;
        }
        if (ended) return;
        await new Promise((resolve) => { waiting = resolve; });
      }
    },
    push(value) {
      values.push(value);
      wake();
    },
    end() {
      ended = true;
      wake();
    },
  };
}

function capture(chunks) {
  return new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); } });
}

function userTexts(messages) {
  return messages
    .filter((message) => message.role === 'user')
    .map((message) => (typeof message.content === 'string'
      ? message.content
      : message.content.filter((part) => part.type === 'text').map((part) => part.text).join('')));
}

/**
 * A real gateway on a temporary store plus its private local socket, wired as `cli.ts` wires it,
 * with a faux provider whose requests the test scripts.
 */
async function makeEnvironment(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-owner-steer-cli-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'note.md'), '# Synthetic note\n\nfixture body\n');
  const config = parseConfig({
    workspace,
    dataDir: join(directory, 'state'),
    model: { provider: 'fixture', modelId: 'alpha' },
    allowedModels: [{ provider: 'fixture', modelId: 'alpha' }],
    toolAllowlist: options.tools ?? [],
    episodeSummary: { enabled: false },
    ...(options.followUpMode === undefined ? {} : { followUpMode: options.followUpMode }),
  }, directory);
  const faux = fauxProvider({ provider: 'fixture', models: [{ id: 'alpha', name: 'Alpha' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const prepared = await prepareDataDirectory(config);
  const gateway = await openGateway(config, context, { models });
  const socketPath = gatewaySocketPath(prepared.canonicalDataDir);
  const server = await serveLocalGateway({
    socketPath,
    gateway,
    context,
    tools: config.toolAllowlist ?? [],
    contextRefresh: false,
    presets: false,
    followUpMode: config.followUpMode,
  });
  t.after(async () => {
    await server.close();
    await gateway.close(context);
    await rm(directory, { recursive: true, force: true });
  });
  return { gateway, faux, config, socketPath };
}

/** The attached CLI chat's own durable queue, read through the same surface the terminal uses. */
async function inbox(environment) {
  const conversation = await environment.gateway.conversationFor('cli:steer', context);
  const surface = inProcessTerminalConversation(conversation, environment.config.followUpMode);
  return (await surface.status(context)).inbox;
}

/**
 * Attach one CLI over the local socket and let `drive` admit prompts. The returned text is exactly
 * what the terminal printed.
 */
async function runCli(environment, drive) {
  const chunks = [];
  const client = await connectLocalGateway({
    socketPath: environment.socketPath,
    context,
    conversation: 'steer',
  });
  const input = pushableInput();
  const terminal = runTerminalConversation(client, context, { input: input.iterate(), output: capture(chunks) });
  try {
    await drive(input, () => chunks.join(''));
    input.end();
    await terminal;
  } finally {
    input.end();
    await client.close();
    await Promise.allSettled([terminal]);
  }
  return chunks.join('');
}

/** The attached chat's native run and queue, read through the same surface the terminal uses. */
async function chatStatus(environment) {
  const conversation = await environment.gateway.conversationFor('cli:steer', context);
  const surface = inProcessTerminalConversation(conversation, environment.config.followUpMode);
  return surface.status(context);
}

/** Record every request's user messages, holding the first until `release`. */
function scriptedRequests(faux, steps) {
  const requests = [];
  const entered = deferred();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  faux.setResponses(steps.map((step, index) => async (transcript) => {
    requests.push(userTexts(transcript.messages));
    if (index !== 0) return step();
    entered.resolve();
    await held;
    return step();
  }));
  return { requests, entered: entered.promise, release: () => release() };
}

test('followUpMode parses to a fixed spelling and defaults to follow-up queueing', { timeout: 5_000 }, () => {
  const base = {
    workspace: '/synthetic/workspace',
    dataDir: '/synthetic/state',
    model: { provider: 'fixture', modelId: 'alpha' },
    toolAllowlist: [],
  };
  assert.equal(parseConfig(base).followUpMode, 'followUp');
  assert.equal(parseConfig({ ...base, followUpMode: 'steer' }).followUpMode, 'steer');
  assert.equal(parseConfig({ ...base, followUpMode: 'followUp' }).followUpMode, 'followUp');
  assert.throws(() => parseConfig({ ...base, followUpMode: 'steerAll' }), /followUpMode must be one of followUp, steer/);
  assert.throws(() => parseConfig({ ...base, followUpMode: true }), /followUpMode must be one of followUp, steer/);
});

test('two steered prompts are consumed in order after the tool rounds and their one answer is printed once', { timeout: 30_000 }, async (t) => {
  const environment = await makeEnvironment(t, { followUpMode: 'steer', tools: ['read'] });
  const toolCall = (id) => () => fauxAssistantMessage(fauxToolCall('read', { path: 'note.md' }, { id }), { stopReason: 'toolUse' });
  // Round one is held so both prompts are admitted into the running turn; the next boundary
  // places the entire steering burst in order.
  const script = scriptedRequests(environment.faux, [
    toolCall('read-1'),
    toolCall('read-2'),
    () => fauxAssistantMessage('SHARED-STEER-ANSWER'),
  ]);
  const printed = await runCli(environment, async (input) => {
    input.push('first steered prompt');
    await script.entered;
    input.push('second steered prompt');
    input.push('third steered prompt');
    await eventually(async () => (await inbox(environment)).steer === 2, 'both later prompts to queue as steers');
    script.release();
  });
  assert.deepEqual(script.requests[0], ['first steered prompt']);
  assert.deepEqual(script.requests[1], ['first steered prompt', 'second steered prompt', 'third steered prompt']);
  assert.deepEqual(script.requests[2], ['first steered prompt', 'second steered prompt', 'third steered prompt']);
  assert.equal(printed.split('SHARED-STEER-ANSWER').length - 1, 1, 'the shared answer is printed once');
});

test('the default follow-up mode still queues each later prompt into its own answered turn', { timeout: 30_000 }, async (t) => {
  const environment = await makeEnvironment(t);
  const script = scriptedRequests(environment.faux, [
    () => fauxAssistantMessage('FIRST-QUEUED-ANSWER'),
    () => fauxAssistantMessage('SECOND-QUEUED-ANSWER'),
  ]);
  const printed = await runCli(environment, async (input) => {
    input.push('first queued prompt');
    await script.entered;
    input.push('second queued prompt');
    await eventually(async () => (await inbox(environment)).followUp === 1, 'the second prompt to queue behind the turn');
    script.release();
  });
  assert.deepEqual(script.requests[0], ['first queued prompt']);
  // The queued follow-up starts its own run, whose context still shows the earlier turn as history.
  assert.deepEqual(script.requests[1], ['first queued prompt', 'second queued prompt']);
  assert.equal(script.requests[1].at(-1), 'second queued prompt');
  assert.equal(printed.split('FIRST-QUEUED-ANSWER').length - 1, 1);
  assert.equal(printed.split('SECOND-QUEUED-ANSWER').length - 1, 1);
});

test('a steer that arrives at the final boundary starts the next run instead of interrupting it', { timeout: 30_000 }, async (t) => {
  const environment = await makeEnvironment(t, { followUpMode: 'steer' });
  const script = scriptedRequests(environment.faux, [
    () => fauxAssistantMessage('TOO-LATE-ANSWER'),
    () => fauxAssistantMessage('NEXT-RUN-ANSWER'),
  ]);
  const printed = await runCli(environment, async (input) => {
    input.push('held prompt');
    await script.entered;
    input.push('late steer');
    await eventually(async () => (await inbox(environment)).steer === 1, 'the late steer to queue');
    script.release();
  });
  // The held turn was already answering, so the steer is placed at the final boundary and answered by
  // the following run: that run's newest input is the late steer, and the first answer is neither
  // regenerated nor interrupted. A steer that cannot join a tool round therefore answers a beat later.
  assert.deepEqual(script.requests[0], ['held prompt']);
  assert.deepEqual(script.requests[1], ['held prompt', 'late steer']);
  assert.equal(script.requests[1].at(-1), 'late steer');
  assert.equal(printed.split('TOO-LATE-ANSWER').length - 1, 1);
  assert.equal(printed.split('NEXT-RUN-ANSWER').length - 1, 1);
});

test('a shared failed turn reports its ended turn once', { timeout: 30_000 }, async (t) => {
  const environment = await makeEnvironment(t, { followUpMode: 'steer', tools: ['read'] });
  const entered = deferred();
  const secondEntered = deferred();
  let release;
  let failSecond;
  const held = new Promise((resolve) => { release = resolve; });
  const secondGate = new Promise((resolve) => { failSecond = resolve; });
  environment.faux.setResponses([
    async () => {
      entered.resolve();
      await held;
      return fauxAssistantMessage(fauxToolCall('read', { path: 'note.md' }, { id: 'read-1' }), { stopReason: 'toolUse' });
    },
    // The steer is placed at the first tool round, so this second request consumes both prompts; it is
    // held until the terminal has observed that shared run, then fails for both of them at once.
    async () => {
      secondEntered.resolve();
      await secondGate;
      throw new Error('synthetic provider failure');
    },
  ]);
  const printed = await runCli(environment, async (input, output) => {
    input.push('first failing prompt');
    await entered.promise;
    input.push('second failing prompt');
    await eventually(async () => (await inbox(environment)).steer === 1, 'the second prompt to queue as a steer');
    release();
    await secondEntered.promise;
    await eventually(async () => (await chatStatus(environment)).run?.inputs === 2, 'the shared run to hold both prompts');
    // The committed frame carrying both inputs is already queued for the terminal's watch callback; yield
    // until it has run, so the shared run identity is observed before the turn fails.
    await flush();
    failSecond();
  });
  assert.equal(printed.split('Turn ended:').length - 1, 1, 'the shared turn reports its end once');
  assert.match(printed, /Turn ended: model_error/);
});

test('distinct failed turns each report their own ended turn', { timeout: 30_000 }, async (t) => {
  const environment = await makeEnvironment(t);
  const entered = deferred();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  environment.faux.setResponses([
    async () => {
      entered.resolve();
      await held;
      throw new Error('synthetic provider failure');
    },
    () => { throw new Error('synthetic provider failure'); },
  ]);
  const printed = await runCli(environment, async (input, output) => {
    input.push('first failing prompt');
    await entered.promise;
    release();
    // The first turn ends before the second prompt is admitted, so they are two distinct runs with the
    // same model error: each reports its own end and neither collapses into the other.
    await eventually(() => output().includes('Turn ended:'), 'the first ended turn');
    input.push('second failing prompt');
    await eventually(() => output().split('Turn ended:').length - 1 === 2, 'the second ended turn');
  });
  assert.equal(printed.split('Turn ended:').length - 1, 2);
});

test('aborting a shared steered turn reports its ended turn once', { timeout: 30_000 }, async (t) => {
  const environment = await makeEnvironment(t, { followUpMode: 'steer', tools: ['read'] });
  const entered = deferred();
  const secondEntered = deferred();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  environment.faux.setResponses([
    async () => {
      entered.resolve();
      await held;
      return fauxAssistantMessage(fauxToolCall('read', { path: 'note.md' }, { id: 'read-1' }), { stopReason: 'toolUse' });
    },
    // A cooperative provider: the native abort cancels this request instead of waiting on it.
    async (_transcript, options) => {
      secondEntered.resolve();
      await new Promise((_resolve, reject) => {
        const signal = options?.signal;
        if (signal === undefined) return;
        const stop = () => reject(new DOMException('aborted', 'AbortError'));
        if (signal.aborted) return stop();
        signal.addEventListener('abort', stop, { once: true });
      });
      return fauxAssistantMessage('NEVER-DELIVERED');
    },
  ]);
  const printed = await runCli(environment, async (input) => {
    input.push('first prompt');
    await entered.promise;
    input.push('second prompt');
    await eventually(async () => (await inbox(environment)).steer === 1, 'the second prompt to queue as a steer');
    release();
    // The steer is placed at the tool-round boundary, so both prompts belong to the live turn.
    await secondEntered.promise;
    input.push('/abort');
  });
  assert.equal(printed.split('Turn ended:').length - 1, 1, 'one shared turn reports one end');
  assert.match(printed, /Turn ended: aborted/);
  assert.equal(printed.split('NEVER-DELIVERED').length - 1, 0);
});

test('a CLI message does not steer into a run the terminal did not start', { timeout: 30_000 }, async (t) => {
  const environment = await makeEnvironment(t, { followUpMode: 'steer' });
  const entered = deferred();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  environment.faux.setResponses([
    async () => {
      entered.resolve();
      await held;
      return fauxAssistantMessage('FOREIGN-RUN-ANSWER');
    },
    () => fauxAssistantMessage('OWNER-OWN-ANSWER'),
  ]);
  // A non-terminal submitter owns the current run, exactly as a scheduled origin-mode turn does.
  const conversation = await environment.gateway.conversationFor('cli:steer', context);
  const foreign = await conversation.submit(
    { type: 'input', content: 'scheduled origin prompt', requestId: 'cron:synthetic-occurrence' },
    context,
  );
  await entered.promise;
  const printed = await runCli(environment, async (input, output) => {
    input.push('owner prompt');
    await eventually(async () => (await inbox(environment)).followUp === 1 && (await inbox(environment)).steer === 0,
      'the owner prompt to queue behind the foreign run');
    release();
    await eventually(() => output().includes('OWNER-OWN-ANSWER'), 'the owner answer');
  });
  assert.equal((await foreign.wait(context)).status, 'done');
  // The foreign turn's answer stays its own delivery, and the owner prompt is answered once by its own turn.
  assert.equal(printed.split('FOREIGN-RUN-ANSWER').length - 1, 1);
  assert.equal(printed.split('OWNER-OWN-ANSWER').length - 1, 1);
});
