// Bounded ordinary background workers: native Durable tasks with their own conversation, a captured
// subset of the spawning conversation's configured tools, an explicit shared-or-worktree workspace,
// and exactly one durable internal result event back to the spawning agent.
//
// These checks run the real Gateway with a faux provider and temporary workspaces. They cover: the
// tool returns before the child finishes and the parent keeps its turn; the workspace mode really
// changes where writes land and leaves the owner's checkout untouched; an unsafe git base fails
// truthfully without copying or stashing; cancellation retires authority and never reports success
// even if the child finishes late; a worker cannot delegate and only its own spawning conversation
// can inspect it; a narrowed config on reopen cannot restore a removed tool; and a worker child
// reading an image still gets the configured vision handoff.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const packageRoot = process.env.PI_NANOBOT_CANDIDATE ?? new URL('../', import.meta.url).pathname;
const modules = join(packageRoot, 'node_modules/@earendil-works');
const [
  { parseConfig },
  { openGateway },
  {
    WORKER_INPUT_ENTRY_KIND,
    WORKER_RESULT_ENTRY_KIND,
    WORKER_STEER_ENTRY_KIND,
    WORKER_TASK_NAME,
    WorkerRecordsDoc,
    createWorkerFoundation,
    resolveWorkerTarget,
    workerResultRequestId,
    workerSteerRequestId,
    workerTaskPrompt,
  },
  { WORKER_TOOL_NAME, createWorkerTool },
  { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall },
  { BACKGROUND_CONTEXT },
  { AgentDoc, InboxDoc },
  { ConfigToolCaptureDoc },
  { CODEMODE_TOOL_NAME },
  { waitForTurnAnswer },
  { workerTask },
  { InterruptedRunReportsDoc, addInterruptedRunReport },
] = await Promise.all([
  import(new URL('../dist/config.js', import.meta.url).href),
  import(new URL('../dist/runtime.js', import.meta.url).href),
  import(new URL('../dist/workers/worker-task.js', import.meta.url).href),
  import(new URL('../dist/workers/tool.js', import.meta.url).href),
  import(`${modules}/pi-ai/dist/index.js`),
  import(`${modules}/chord/dist/context/index.js`),
  import(`${modules}/pi-durable/dist/index.js`),
  import(new URL('../dist/tools/index.js', import.meta.url).href),
  import(new URL('../dist/extensions/codemode.js', import.meta.url).href),
  import(new URL('../dist/tasks/background.js', import.meta.url).href),
  import(new URL('../dist/channels/app-tasks.js', import.meta.url).href),
  import(new URL('../dist/recovery/interruption.js', import.meta.url).href),
]);

const context = BACKGROUND_CONTEXT;
const WAIT_MS = 15_000;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function within(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Resolve on the next matching commit; bounded and always disposable. */
function changeWatcher(harness, predicate, label) {
  let settled = false;
  let timer;
  let settle;
  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(() => settle?.reject(new Error(`timed out waiting for ${label}`)), WAIT_MS);
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

/** Bounded poll for durable state that a later commit records. */
async function waitFor(predicate, label) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const workerResultCommitted = (conversationId) => (changes) => changes.some((change) =>
  change.type === 'entry'
  && change.value.conversationId === conversationId
  && change.value.kind === WORKER_RESULT_ENTRY_KIND);

const workerResultWatcher = (harness, conversationId, label) =>
  changeWatcher(harness, workerResultCommitted(conversationId), label);

function workerResultEntry(publication, conversationId) {
  return publication.changes.find((change) => change.type === 'entry'
    && change.value.conversationId === conversationId
    && change.value.kind === WORKER_RESULT_ENTRY_KIND)?.value;
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
    return typeof message.content === 'string'
      ? message.content
      : (message.content ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('');
  }
  return '';
}

function transcriptText(messages) {
  return JSON.stringify(messages);
}

function toolOutput(result) {
  return (result.output ?? []).map((part) => (typeof part.text === 'string' ? part.text : '')).join('');
}

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: 20_000 }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(`${command} ${args.join(' ')} failed: ${stderr || stdout}`));
      else resolve();
    });
  });
}

const git = (cwd, ...args) => run('git', [
  '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false',
  ...args,
], cwd);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('worker task prompt sends git identity failures back as a blocker, not an invented author', () => {
  const input = {
    requestId: 'synthetic-request',
    prompt: 'make the change',
    workspaceMode: 'worktree',
    model: { provider: 'worker-fixture', modelId: 'synthetic' },
    thinkingLevel: 'off',
  };
  const worktree = workerTaskPrompt(input, {
    mode: 'worktree',
    path: '/synthetic/worker-worktree',
    branch: 'nanobot/worker-7',
    baseCommit: '0123456789abcdef',
  });
  assert.match(worktree, /If Git refuses to create a commit because no author identity is configured/);
  assert.match(worktree, /do not invent a name or\s+email and do not write Git configuration/);
  assert.match(worktree, /report the missing identity as a\s+blocker/);
  assert.match(worktree, /Task:\nmake the change/);

  const shared = workerTaskPrompt({ ...input, workspaceMode: 'shared' }, {
    mode: 'shared',
    path: '/synthetic/workspace',
  });
  assert.match(shared, /no author identity is configured/);
  assert.match(shared, /Task:\nmake the change/);
});

async function fixtureWorkspace({ git: useGit = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-workers-'));
  const workspace = join(directory, 'workspace');
  const dataDir = join(directory, 'state');
  await mkdir(workspace);
  await writeFile(join(workspace, 'note.txt'), 'WORKER-NOTE-CONTENT\n');
  if (useGit) {
    await git(workspace, 'init', '-q', '-b', 'main');
    await git(workspace, 'add', 'note.txt');
    await git(workspace, 'commit', '-q', '-m', 'base');
  }
  return { directory, workspace, dataDir };
}

async function syntheticStore(fixture, dispatcher, overrides = {}) {
  const faux = fauxProvider({ provider: 'worker-fixture', models: [{ id: 'synthetic', name: 'Synthetic' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 60 }, () => dispatcher));
  const model = { provider: 'worker-fixture', modelId: 'synthetic' };
  const config = parseConfig({
    workspace: fixture.workspace,
    dataDir: fixture.dataDir,
    model,
    allowedModels: [model],
    toolAllowlist: ['read', 'write'],
    workers: { enabled: true },
    ...overrides,
  }, fixture.directory);
  const gateway = await openGateway(config, context, { models });
  return { faux, models, config, gateway };
}

const ORIGIN = 'telegram:11:chat:501';
const ELSEWHERE = 'telegram:11:chat:502';

test('worker config is a small finite opt-in, not an open registry', { timeout: 10_000 }, () => {
  const base = {
    workspace: '/synthetic/workspace',
    dataDir: '/synthetic/state',
    model: { provider: 'fixture', modelId: 'chat' },
    allowedModels: [{ provider: 'fixture', modelId: 'chat' }],
  };
  assert.deepEqual(parseConfig({ ...base, workers: { enabled: false } }, '/').workers, { enabled: false });
  assert.deepEqual(parseConfig({ ...base, workers: { enabled: true } }, '/').workers, { enabled: true });
  assert.equal(parseConfig({ ...base, workers: { enabled: true, maxConcurrent: 4 } }, '/').workers.maxConcurrent, 4);
  for (const bad of [0, 5, 1.5, '2']) {
    assert.throws(
      () => parseConfig({ ...base, workers: { enabled: true, maxConcurrent: bad } }, '/'),
      /workers\.maxConcurrent must be an integer from 1 to 4/,
      `maxConcurrent=${String(bad)} must be rejected`,
    );
  }
  assert.throws(() => parseConfig({ ...base, workers: { enabled: true, queue: true } }, '/'), /workers\.queue is not a recognized option/);
  assert.throws(() => parseConfig({ ...base, workers: { enabled: true, preset: 'fast' } }, '/'), /workers\.preset requires named modelPresets/);
  assert.throws(
    () => parseConfig({
      workspace: '/synthetic/workspace',
      dataDir: '/synthetic/state',
      modelPresets: { chat: { provider: 'fixture', modelId: 'chat' } },
      modelPreset: 'chat',
      workers: { enabled: true, preset: 'missing' },
    }, '/'),
    /workers\.preset must name an entry in modelPresets/,
  );
  const named = parseConfig({
    workspace: '/synthetic/workspace',
    dataDir: '/synthetic/state',
    modelPresets: { chat: { provider: 'fixture', modelId: 'chat' } },
    modelPreset: 'chat',
    workers: { enabled: true, preset: 'chat' },
  }, '/');
  assert.deepEqual(named.workers, { enabled: true, preset: 'chat' });
});

test('start returns immediately, the parent keeps its turn, and the result arrives once', { timeout: 30_000 }, async () => {
  const fixture = await fixtureWorkspace();
  const childStarted = deferred();
  const releaseChild = deferred();
  let childAnswered = false;
  const issued = new Set();
  const store = await syntheticStore(fixture, async (transcript, options) => {
    const input = lastUserText(transcript.messages);
    if (input.includes('Background worker task.')) {
      if (!childAnswered) {
        childStarted.resolve();
        await new Promise((resolve, reject) => {
          const signal = options?.signal;
          const abort = () => resolve();
          if (signal?.aborted) return abort();
          signal?.addEventListener('abort', abort, { once: true });
          releaseChild.promise.then(() => {
            signal?.removeEventListener('abort', abort);
            resolve();
          });
        });
        childAnswered = true;
      }
      return fauxAssistantMessage('WORKER-CHILD-RESULT');
    }
    if (input.includes('[internal worker result]')) return fauxAssistantMessage('PARENT-AFTER-WORKER');
    if (input === 'spawn a worker' && !issued.has(input)) {
      issued.add(input);
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, {
          action: 'start',
          task: 'read note.txt and report its exact content',
          workspace_mode: 'shared',
        }, { id: 'worker-start-call' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('PARENT-CONTINUED');
  });
  let resultWatcher;
  try {
    const conversation = await store.gateway.conversationFor(ORIGIN, context);
    const names = (await conversation.agent(context)).tools?.map((tool) => (typeof tool === 'string' ? tool : tool.name)) ?? [];
    assert.ok(names.includes(WORKER_TOOL_NAME), `a mapped chat must be offered the worker tool: ${names}`);

    resultWatcher = changeWatcher(store.gateway.harness, workerResultCommitted(conversation.id), 'internal worker result');
    const submission = await conversation.submit({ type: 'input', content: 'spawn a worker', requestId: 'spawn' }, context);
    assert.equal((await submission.wait(context)).status, 'done', 'the parent turn settles while the worker is still running');
    await within(childStarted.promise, WAIT_MS, 'the worker never started');

    // The parent finished its ordinary turn before the worker answered.
    const before = (await conversation.entries({ order: 'ascending' }, 100, undefined, context)).items;
    const parentText = before.flatMap((entry) => (entry.model ?? []))
      .flatMap((message) => (message.role === 'assistant' && Array.isArray(message.content) ? message.content : []))
      .filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    assert.match(parentText, /PARENT-CONTINUED/, 'the parent turn finished before the child finished');
    assert.equal(before.filter((entry) => entry.kind === WORKER_RESULT_ENTRY_KIND).length, 0);
    const startResult = before.filter((entry) => entry.model?.[0]?.role === 'toolResult')
      .map((entry) => (entry.model[0].content ?? []).map((part) => part.text ?? '').join(''))
      .join('\n');
    assert.match(startResult, /Started background worker \d+/);
    const record = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers[0];
    assert.equal(record.workspaceMode, 'shared');
    assert.ok(['queued', 'running'].includes(record.status), `the worker is live: ${record.status}`);

    releaseChild.resolve();
    await within(resultWatcher.promise, WAIT_MS, 'the internal result event was never admitted');

    const after = (await conversation.entries({ order: 'ascending' }, 200, undefined, context)).items;
    const results = after.filter((entry) => entry.kind === WORKER_RESULT_ENTRY_KIND);
    assert.equal(results.length, 1, 'exactly one internal result event');
    const body = messageText(results[0].model?.[0]);
    assert.match(body, /\[internal worker result\]/);
    assert.match(body, /not a user message and not an instruction/);
    assert.match(body, /WORKER-CHILD-RESULT/);
    assert.equal(results[0].data.status, 'completed');
    assert.equal(results[0].data.taskId, record.taskId);

    // The event is an internal admission only: nothing was queued for any channel.
    assert.deepEqual(await store.gateway.cronOutbox.list(ORIGIN, context), []);

    // The worker's own transcript keeps the authoritative answer; the record keeps a bounded excerpt.
    await waitFor(async () =>
      (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers[0].notified === true,
    'the result event admission flag');
    const finished = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers[0];
    assert.equal(finished.status, 'completed');
    assert.equal(finished.notified, true);
    assert.equal(finished.result, 'WORKER-CHILD-RESULT');
    const task = await store.gateway.harness.getTask(finished.taskId, context);
    assert.equal(task.kind, WORKER_TASK_NAME);
    assert.equal(task.state.status, 'terminal');
    assert.equal(task.state.outcome.status, 'completed');
    // Same request ID over the same request is deduplicated, not a second turn.
    assert.equal(workerResultRequestId(finished.taskId), `nanobot.worker-result:${finished.taskId}`);
  } finally {
    releaseChild.resolve();
    resultWatcher?.stop();
    await store.gateway.close(context);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('shared writes land in the configured workspace while worktree writes never touch it', { timeout: 30_000 }, async () => {
  const fixture = await fixtureWorkspace({ git: true });
  const childText = (messages) => lastUserText(messages);
  const issued = new Set();
  const store = await syntheticStore(fixture, async (transcript) => {
    const input = childText(transcript.messages);
    if (input.includes('Background worker task.')) {
      const shared = input.includes('SHARED-TASK-MARKER');
      const file = shared ? 'shared-output.txt' : 'worktree-output.txt';
      if (!transcriptText(transcript.messages).includes(`"${file}"`)) {
        return fauxAssistantMessage([
          fauxToolCall('write', { path: file, content: `${file.toUpperCase()}\n` }, { id: `write-${file}` }),
        ], { stopReason: 'toolUse' });
      }
      return fauxAssistantMessage(shared ? 'SHARED-DONE' : 'WORKTREE-DONE');
    }
    if (input.includes('[internal worker result]')) return fauxAssistantMessage('noted');
    if (input === 'spawn shared' && !issued.has(input)) {
      issued.add(input);
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, { action: 'start', task: 'SHARED-TASK-MARKER write the shared file', workspace_mode: 'shared' }, { id: 'shared-start' }),
      ], { stopReason: 'toolUse' });
    }
    if (input === 'spawn worktree' && !issued.has(input)) {
      issued.add(input);
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, { action: 'start', task: 'WORKTREE-TASK-MARKER write the isolated file', workspace_mode: 'worktree' }, { id: 'worktree-start' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('ok');
  }, { toolAllowlist: ['write'] });
  try {
    const conversation = await store.gateway.conversationFor(ORIGIN, context);
    const watcher = changeWatcher(store.gateway.harness, workerResultCommitted(conversation.id), 'two worker results');
    const results = [];
    const stop = store.gateway.harness.observeCommits({ advance: (publication) => {
      for (const change of publication.changes) {
        if (change.type === 'entry' && change.value.conversationId === conversation.id
          && change.value.kind === WORKER_RESULT_ENTRY_KIND) results.push(change.value);
      }
    }, end: () => {} })
    try {
      for (const message of ['spawn shared', 'spawn worktree']) {
        const submission = await conversation.submit({ type: 'input', content: message, requestId: message }, context);
        assert.equal((await submission.wait(context)).status, 'done');
      }
      await within((async () => {
        while (results.length < 2) await new Promise((resolve) => setTimeout(resolve, 25));
      })(), WAIT_MS, 'both workers never reported');
    } finally {
      stop.detach();
      watcher.stop();
    }
    assert.deepEqual(results.map((entry) => entry.data.status), ['completed', 'completed']);

    const record = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers;
    assert.equal(record.length, 2);
    const shared = record.find((entry) => entry.workspaceMode === 'shared');
    const isolated = record.find((entry) => entry.workspaceMode === 'worktree');
    assert.equal(shared.workspacePath, fixture.workspace);
    assert.equal(shared.branch, null);

    // The shared worker wrote the real configured workspace.
    assert.match(await readFile(join(fixture.workspace, 'shared-output.txt'), 'utf8'), /SHARED-OUTPUT/);
    // The worktree worker wrote its own checkout, not the owner's.
    assert.equal(await exists(join(fixture.workspace, 'worktree-output.txt')), false);
    assert.ok(await exists(join(isolated.workspacePath, 'worktree-output.txt')));
    assert.equal(isolated.branch, `nanobot/worker-${isolated.taskId}`);
    const head = await new Promise((resolve, reject) => {
      execFile('git', ['rev-parse', 'HEAD'], { cwd: fixture.workspace }, (error, stdout) => {
        if (error) reject(error); else resolve(stdout.trim());
      });
    });
    assert.equal(isolated.baseCommit, head, 'the worktree records the commit it started from');
    const branch = await new Promise((resolve, reject) => {
      execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: isolated.workspacePath }, (error, stdout) => {
        if (error) reject(error); else resolve(stdout.trim());
      });
    });
    assert.equal(branch, isolated.branch);
    assert.equal(await exists(join(fixture.workspace, 'shared-output.txt')), true,
      'shared mode deliberately writes the real configured workspace');
    assert.equal(await exists(join(fixture.workspace, 'worktree-output.txt')), false,
      'the isolated worker never wrote the owner checkout');
    // The owner's tracked state is untouched: no staging, commit, stash or copy happened there.
    const status = await new Promise((resolve, reject) => {
      execFile('git', ['status', '--porcelain=v1', '--untracked-files=no'], { cwd: fixture.workspace }, (error, stdout) => {
        if (error) reject(error); else resolve(stdout.trim());
      });
    });
    assert.equal(status, '', `no tracked owner file may change: ${status}`);
  } finally {
    await store.gateway.close(context);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('two independent turns reusing one provider tool-call ID start two distinct workers', { timeout: 30_000 }, async () => {
  const fixture = await fixtureWorkspace();
  const issued = new Set();
  const store = await syntheticStore(fixture, async (transcript) => {
    const input = lastUserText(transcript.messages);
    if (input.includes('Background worker task.')) return fauxAssistantMessage('CHILD-OK');
    if (input.includes('[internal worker result]')) return fauxAssistantMessage('noted');
    if (input === 'spawn alpha' && !issued.has(input)) {
      issued.add(input);
      // A provider may reuse one call ID across independent turns; it is not host identity.
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, { action: 'start', task: 'alpha task', workspace_mode: 'shared' }, { id: 'call_0' }),
      ], { stopReason: 'toolUse' });
    }
    if (input === 'spawn beta' && !issued.has(input)) {
      issued.add(input);
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, { action: 'start', task: 'beta task', workspace_mode: 'shared' }, { id: 'call_0' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('ok');
  });
  try {
    const conversation = await store.gateway.conversationFor(ORIGIN, context);
    for (const content of ['spawn alpha', 'spawn beta']) {
      const submission = await conversation.submit({ type: 'input', content, requestId: content }, context);
      assert.equal((await submission.wait(context)).status, 'done');
    }
    const entries = (await conversation.entries({ order: 'ascending' }, 200, undefined, context)).items;
    const results = entries.filter((entry) => entry.model?.[0]?.role === 'toolResult')
      .map((entry) => entry.model[0]).filter((message) => message.toolCallId === 'call_0');
    assert.equal(results.length, 2, 'both turns reached a tool result');
    const started = results.map((message) => (message.content ?? []).map((part) => part.text ?? '').join(''));
    assert.equal(results[0].isError ?? false, false, started[0]);
    assert.equal(results[1].isError ?? false, false, started[1]);
    assert.match(started[0], /Started background worker \d+/);
    assert.match(started[1], /Started background worker \d+/);
    assert.doesNotMatch(started[1], /already exists/);

    const records = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers;
    assert.equal(records.length, 2, 'two workers, not one silently swallowed');
    assert.equal(new Set(records.map((entry) => entry.taskId)).size, 2);
    assert.deepEqual(records.map((entry) => entry.prompt).sort(), ['alpha task', 'beta task']);
    assert.notEqual(records[0].requestId, records[1].requestId, 'each host tool task keeps its own identity');
  } finally {
    await store.gateway.close(context);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('an unsafe or non-git base is refused truthfully without copying, stashing or creating a task', { timeout: 20_000 }, async () => {
  const plain = await fixtureWorkspace();
  let plainIssued = false;
  const plainStore = await syntheticStore(plain, async (transcript) => {
    if (lastUserText(transcript.messages).includes('[internal worker result]')) return fauxAssistantMessage('noted');
    if (lastUserText(transcript.messages) === 'spawn worktree' && !plainIssued) {
      plainIssued = true;
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, { action: 'start', task: 'isolated work', workspace_mode: 'worktree' }, { id: 'plain-worktree' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('done');
  });
  try {
    const conversation = await plainStore.gateway.conversationFor(ORIGIN, context);
    const submission = await conversation.submit({ type: 'input', content: 'spawn worktree', requestId: 'plain' }, context);
    assert.equal((await submission.wait(context)).status, 'done');
    const entries = (await conversation.entries({ order: 'ascending' }, 100, undefined, context)).items;
    const toolResult = entries.filter((entry) => entry.model?.[0]?.role === 'toolResult')
      .map((entry) => entry.model[0]).find((message) => message.toolCallId === 'plain-worktree');
    assert.ok(toolResult, 'the refusal must be returned to the model');
    assert.equal(toolResult.isError, true);
    const refusal = (toolResult.content ?? []).map((part) => part.text ?? '').join('');
    assert.match(refusal, /requires the configured workspace to be a git work tree/);
    const records = await plainStore.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context);
    assert.equal(records, undefined, 'a refused request creates no worker record');
  } finally {
    await plainStore.gateway.close(context);
    await rm(plain.directory, { recursive: true, force: true });
  }

  // A dirty tracked base is refused, and the owner's uncommitted edit is left exactly as it was.
  const dirty = await fixtureWorkspace({ git: true });
  let dirtyIssued = false;
  const dirtyStore = await syntheticStore(dirty, async (transcript) => {
    if (lastUserText(transcript.messages).includes('[internal worker result]')) return fauxAssistantMessage('noted');
    if (lastUserText(transcript.messages) === 'spawn worktree' && !dirtyIssued) {
      dirtyIssued = true;
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, { action: 'start', task: 'isolated work', workspace_mode: 'worktree' }, { id: 'dirty-worktree' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('done');
  });
  try {
    await writeFile(join(dirty.workspace, 'note.txt'), 'PERSONAL-UNCOMMITTED-EDIT\n');
    const conversation = await dirtyStore.gateway.conversationFor(ORIGIN, context);
    const submission = await conversation.submit({ type: 'input', content: 'spawn worktree', requestId: 'dirty' }, context);
    assert.equal((await submission.wait(context)).status, 'done');
    const entries = (await conversation.entries({ order: 'ascending' }, 100, undefined, context)).items;
    const toolResult = entries.filter((entry) => entry.model?.[0]?.role === 'toolResult')
      .map((entry) => entry.model[0]).find((message) => message.toolCallId === 'dirty-worktree');
    assert.ok(toolResult);
    assert.equal(toolResult.isError, true);
    assert.match(
      (toolResult.content ?? []).map((part) => part.text ?? '').join(''),
      /requires a clean base/,
    );
    assert.equal(await readFile(join(dirty.workspace, 'note.txt'), 'utf8'), 'PERSONAL-UNCOMMITTED-EDIT\n');
    assert.equal(await exists(join(dirty.dataDir, 'worker-worktrees')), false, 'no checkout was created');
    const records = await dirtyStore.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context);
    assert.equal(records, undefined);
  } finally {
    await dirtyStore.gateway.close(context);
    await rm(dirty.directory, { recursive: true, force: true });
  }
});

test('cancellation retires the worker authority and a late child finish never reports success', { timeout: 30_000 }, async () => {
  const fixture = await fixtureWorkspace({ git: true });
  const childStarted = deferred();
  const releaseChild = deferred();
  let childAnswered = false;
  const issued = new Set();
  const store = await syntheticStore(fixture, async (transcript, options) => {
    const input = lastUserText(transcript.messages);
    if (input.includes('Background worker task.')) {
      if (!childAnswered) {
        childStarted.resolve();
        await new Promise((resolve) => {
          const signal = options?.signal;
          if (signal?.aborted) return resolve();
          signal?.addEventListener('abort', () => resolve(), { once: true });
          releaseChild.promise.then(() => resolve());
        });
        childAnswered = true;
      }
      return fauxAssistantMessage('LATE-WORKER-SUCCESS');
    }
    if (input.includes('[internal worker result]')) return fauxAssistantMessage('ACKNOWLEDGED');
    if (input === 'spawn a worker' && !issued.has(input)) {
      issued.add(input);
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, { action: 'start', task: 'work in an isolated tree', workspace_mode: 'worktree' }, { id: 'cancel-start' }),
      ], { stopReason: 'toolUse' });
    }
    if (input === 'cancel the worker' && !issued.has(input)) {
      issued.add(input);
      const transcriptTextValue = transcriptText(transcript.messages);
      const match = /Started background worker (\d+)/.exec(transcriptTextValue);
      assert.ok(match, 'the model needs the worker ID from the start result');
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, { action: 'cancel', worker_id: Number(match[1]) }, { id: 'cancel-call' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('ok');
  });
  const results = [];
  let stop;
  try {
    const conversation = await store.gateway.conversationFor(ORIGIN, context);
    stop = store.gateway.harness.observeCommits({ advance: (publication) => {
      for (const change of publication.changes) {
        if (change.type === 'entry' && change.value.conversationId === conversation.id
          && change.value.kind === WORKER_RESULT_ENTRY_KIND) results.push(change.value);
      }
    }, end: () => {} })
    const first = await conversation.submit({ type: 'input', content: 'spawn a worker', requestId: 'spawn' }, context);
    assert.equal((await first.wait(context)).status, 'done');
    await within(childStarted.promise, WAIT_MS, 'the worker never started');
    const record = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers[0];

    const cancel = await conversation.submit({ type: 'input', content: 'cancel the worker', requestId: 'cancel' }, context);
    assert.equal((await cancel.wait(context)).status, 'done');
    await within((async () => {
      while (results.length < 1) await new Promise((resolve) => setTimeout(resolve, 25));
    })(), WAIT_MS, 'the cancellation result was never admitted');

    const aborted = results[0];
    assert.equal(aborted.data.status, 'aborted');
    const body = messageText(aborted.model?.[0]);
    assert.match(body, /was cancelled/);
    assert.doesNotMatch(body, /LATE-WORKER-SUCCESS/);

    // Authority is retired in the terminal commit: no capture, no tools, no further admission.
    const childId = record.taskId;
    const task = await store.gateway.harness.getTask(childId, context);
    assert.equal(task.state.status, 'terminal');
    assert.equal(task.state.outcome.status, 'aborted');
    const childConversationId = record.conversationId;
    assert.ok(childConversationId, 'the prepared worker target is recorded before the result exists');
    const child = await store.gateway.harness.conversation(childConversationId, context);
    assert.ok(child, 'the cancelled worker target survives for inspection');
    const names = (await child.agent(context)).tools?.map((tool) => (typeof tool === 'string' ? tool : tool.name)) ?? [];
    assert.deepEqual(names, [], `a cancelled worker keeps no tools: ${names}`);

    // A late child completion cannot turn the cancelled task into a success or send another event.
    releaseChild.resolve();
    // Deterministic: wait until the cancelled worker's own child has no live work left.
    await waitFor(async () => {
      const inspection = await store.gateway.harness.inspect(context);
      return inspection.tasks.every((entry) => entry.record.conversationId !== childConversationId
        || entry.record.state.status === 'terminal');
    }, 'the cancelled child work to settle');
    assert.equal(results.length, 1, 'exactly one result event after a late child finish');
    assert.equal(
      (await store.gateway.harness.getTask(childId, context)).state.outcome.status,
      'aborted',
    );
    const finished = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers[0];
    assert.equal(finished.status, 'aborted');
  } finally {
    stop?.detach();
    releaseChild.resolve();
    await store.gateway.close(context);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('a worker cannot delegate and another conversation cannot inspect it', { timeout: 30_000 }, async () => {
  const fixture = await fixtureWorkspace();
  const issued = new Set();
  const store = await syntheticStore(fixture, async (transcript) => {
    const input = lastUserText(transcript.messages);
    if (input.includes('Background worker task.')) return fauxAssistantMessage('CHILD-DONE');
    if (input.includes('[internal worker result]')) return fauxAssistantMessage('noted');
    if (input.startsWith('spawn a worker') && !issued.has(input)) {
      issued.add(input);
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, { action: 'start', task: 'bounded child task', workspace_mode: 'shared' }, { id: `start-${input}` }),
      ], { stopReason: 'toolUse' });
    }
    if (input.startsWith('inspect worker') && !issued.has(input)) {
      issued.add(input);
      const workerId = Number(input.split(' ')[2]);
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, { action: 'inspect', worker_id: workerId }, { id: `inspect-${workerId}` }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('ok');
  });
  try {
    const conversation = await store.gateway.conversationFor(ORIGIN, context);
    const submission = await conversation.submit({ type: 'input', content: 'spawn a worker', requestId: 'spawn-worker' }, context);
    assert.equal((await submission.wait(context)).status, 'done');
    await waitFor(async () =>
      (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context))?.workers[0]?.conversationId != null,
    'the worker target conversation');
    const record = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers[0];
    const child = await store.gateway.harness.conversation(record.conversationId, context);
    const childTools = ((await child.agent(context)).tools ?? [])
      .map((tool) => (typeof tool === 'string' ? tool : tool.name));
    // Research recall is captured too, but scheduling, channel actions and delegation stay denied.
    assert.ok(childTools.includes('read'), `the captured ceiling still applies: ${childTools}`);
    for (const name of ['memory_search', 'memory_browse', 'memory_read']) assert.ok(childTools.includes(name), `the child can retrieve mapped-chat evidence: ${childTools}`);
    assert.equal(childTools.includes('history'), false, `model history is retired: ${childTools}`);
    for (const forbidden of [WORKER_TOOL_NAME, 'cron', 'telegram']) {
      assert.equal(childTools.includes(forbidden), false, `a worker child must not have ${forbidden}`);
    }

    // Another mapped chat holds no record for that task ID, so it cannot inspect the result.
    const other = await store.gateway.conversationFor(ELSEWHERE, context);
    const otherNames = (await other.agent(context)).tools?.map((tool) => (typeof tool === 'string' ? tool : tool.name)) ?? [];
    assert.ok(otherNames.includes(WORKER_TOOL_NAME), 'another mapped chat may manage its own workers');
    const inspect = await other.submit({ type: 'input', content: `inspect worker ${record.taskId}`, requestId: 'inspect' }, context);
    assert.equal((await inspect.wait(context)).status, 'done');
    const entries = (await other.entries({ order: 'ascending' }, 100, undefined, context)).items;
    const answer = entries.filter((entry) => entry.model?.[0]?.role === 'toolResult')
      .map((entry) => entry.model[0]).find((message) => message.toolCallId === `inspect-${record.taskId}`);
    assert.ok(answer, 'the inspect call must reach a tool result');
    assert.equal(answer.isError, true);
    assert.match((answer.content ?? []).map((part) => part.text ?? '').join(''), /No worker \d+ in this conversation/);
  } finally {
    await store.gateway.close(context);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('start dedupes on the host tool-task identity, not a reused provider call ID', { timeout: 10_000 }, async () => {
  const seen = [];
  const tool = createWorkerTool({
    foundation: {
      async start(_writer, request) {
        seen.push(request.requestId);
        return { taskId: seen.length, deduplicated: false };
      },
      async list() { return []; },
      async inspect() { return undefined; },
      async cancel() { return 'not_found'; },
      async recover() { return 0; },
      async record() { return undefined; },
    },
    spawnerFor: () => true,
    harness: () => ({}),
    precheckWorktree: async () => undefined,
  }).extension.tools[0];
  // Native Code Mode composes tools through nested calls; a model-only restriction would hide it
  // from scripts even though the hosting conversation and capture checks still apply.
  assert.ok(tool.callers === undefined || tool.callers.includes('tools'),
    `the worker tool must stay composable in Code Mode: ${JSON.stringify(tool.callers)}`);
  const api = (taskId, callId) => ({
    conversationId: 9,
    taskId,
    callId,
    commit: async (change) => change({}),
  });
  const start = (taskId, callId, task) => tool.execute(
    { action: 'start', task, workspace_mode: 'shared' },
    api(taskId, callId),
    context,
  );
  // Two independent tool tasks may carry the same provider call ID in one chat.
  await start(41, 'call_0', 'alpha');
  await start(42, 'call_0', 'beta');
  // A rerun of the same host tool task keeps the same identity, so a crash retry still dedupes.
  await start(41, 'call_0', 'alpha');
  // An explicit model request_id stays a deliberate cross-call key.
  await tool.execute(
    { action: 'start', task: 'gamma', workspace_mode: 'shared', request_id: 'shared-key' },
    api(43, 'call_0'),
    context,
  );
  assert.deepEqual(seen, ['tool:41', 'tool:42', 'tool:41', 'model:shared-key']);
});

test('list and inspect read this conversation\'s bounded worker record, and a repeated request_id does not start twice', { timeout: 25_000 }, async () => {
  const fixture = await fixtureWorkspace();
  const issued = new Set();
  const store = await syntheticStore(fixture, async (transcript) => {
    const input = lastUserText(transcript.messages);
    if (input.includes('Background worker task.')) return fauxAssistantMessage('INSPECTED-RESULT');
    if (input.includes('[internal worker result]')) return fauxAssistantMessage('noted');
    if (input === 'start keyed' && !issued.has(input)) {
      issued.add(input);
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, { action: 'start', task: 'keyed task', workspace_mode: 'shared', request_id: 'stable-key' }, { id: 'keyed-one' }),
      ], { stopReason: 'toolUse' });
    }
    if (input === 'start keyed again' && !issued.has(input)) {
      issued.add(input);
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, { action: 'start', task: 'keyed task', workspace_mode: 'shared', request_id: 'stable-key' }, { id: 'keyed-two' }),
      ], { stopReason: 'toolUse' });
    }
    if (input.startsWith('show workers') && !issued.has(input)) {
      issued.add(input);
      const match = /worker (\d+)/.exec(input);
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, match ? { action: 'inspect', worker_id: Number(match[1]) } : { action: 'list' }, { id: `show-${issued.size}` }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('ok');
  });
  try {
    const conversation = await store.gateway.conversationFor(ORIGIN, context);
    const first = await conversation.submit({ type: 'input', content: 'start keyed', requestId: 'keyed' }, context);
    assert.equal((await first.wait(context)).status, 'done');
    await waitFor(async () =>
      (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context))?.workers[0]?.status === 'completed',
    'the keyed worker to finish');

    const again = await conversation.submit({ type: 'input', content: 'start keyed again', requestId: 'keyed-again' }, context);
    assert.equal((await again.wait(context)).status, 'done');
    const records = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers;
    assert.equal(records.length, 1, 'the same request_id returns the existing worker');
    assert.equal(records[0].requestId, 'model:stable-key');

    const inspect = await conversation.submit({ type: 'input', content: `show workers worker ${records[0].taskId}`, requestId: 'inspect' }, context);
    assert.equal((await inspect.wait(context)).status, 'done');
    const list = await conversation.submit({ type: 'input', content: 'show workers list', requestId: 'list' }, context);
    assert.equal((await list.wait(context)).status, 'done');

    const entries = (await conversation.entries({ order: 'ascending' }, 200, undefined, context)).items;
    const results = entries.filter((entry) => entry.model?.[0]?.role === 'toolResult').map((entry) => entry.model[0]);
    const starts = results.filter((message) => message.toolCallId === 'keyed-one' || message.toolCallId === 'keyed-two');
    assert.equal(starts.length, 2);
    assert.match(starts[1].content.map((part) => part.text ?? '').join(''), /already exists for this request/);
    const inspected = results.find((message) => message.toolCallId.startsWith('show-'));
    assert.ok(inspected);
    const inspectText = inspected.content.map((part) => part.text ?? '').join('');
    assert.match(inspectText, new RegExp(`worker ${records[0].taskId}`));
  } finally {
    await store.gateway.close(context);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('a crash between the terminal commit and the internal event re-admits it once on reopen', { timeout: 30_000 }, async () => {
  const fixture = await fixtureWorkspace();
  const dispatcher = async (transcript) => {
    const input = lastUserText(transcript.messages);
    if (input.includes('Background worker task.')) return fauxAssistantMessage('RECOVERED-RESULT');
    if (input.includes('[internal worker result]')) return fauxAssistantMessage('noted');
    if (input === 'spawn one' && !dispatcher.issued) {
      dispatcher.issued = true;
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, { action: 'start', task: 'one result', workspace_mode: 'shared' }, { id: 'recover-start' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('ok');
  };
  const store = await syntheticStore(fixture, dispatcher);
  let conversationId;
  let taskId;
  try {
    const conversation = await store.gateway.conversationFor(ORIGIN, context);
    conversationId = conversation.id;
    const submission = await conversation.submit({ type: 'input', content: 'spawn one', requestId: 'spawn' }, context);
    assert.equal((await submission.wait(context)).status, 'done');
    await waitFor(async () =>
      (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context))?.workers[0]?.notified === true,
    'the first result admission');
    const record = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers[0];
    taskId = record.taskId;
    // Simulate the crash window: the outcome is durable and the event was admitted, but the record
    // flag never landed.
    await store.gateway.harness.commit(async (tx) => {
      const doc = await tx.doc(WorkerRecordsDoc, conversationId);
      doc.workers[0].notified = false;
      return undefined;
    }, context);
  } finally {
    await store.gateway.close(context);
  }
  let reopened;
  try {
    const model = { provider: 'worker-fixture', modelId: 'synthetic' };
    const config = parseConfig({
      workspace: fixture.workspace,
      dataDir: fixture.dataDir,
      model,
      allowedModels: [model],
      toolAllowlist: ['read', 'write'],
      workers: { enabled: true },
    }, fixture.directory);
    const faux = fauxProvider({ provider: 'worker-fixture', models: [{ id: 'synthetic', name: 'Synthetic' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses(Array.from({ length: 30 }, () => dispatcher));
    reopened = await openGateway(config, context, { models });
    await waitFor(async () =>
      (await reopened.harness.snapshot(WorkerRecordsDoc, conversationId, context))?.workers[0]?.notified === true,
    'the recovery admission flag');
    const conversation = await reopened.harness.conversation(conversationId, context);
    const entries = (await conversation.entries({ order: 'ascending' }, 200, undefined, context)).items;
    const results = entries.filter((entry) => entry.kind === WORKER_RESULT_ENTRY_KIND);
    assert.equal(results.length, 1, 'the retried admission must not duplicate the parent event');
    assert.equal(results[0].data.taskId, taskId);
    const record = (await reopened.harness.snapshot(WorkerRecordsDoc, conversationId, context)).workers[0];
    assert.equal(record.status, 'completed');
    assert.equal(record.result, 'RECOVERED-RESULT');
  } finally {
    if (reopened) await reopened.close(context);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('reopen recovery scans only terminal worker tasks', { timeout: 10_000 }, async () => {
  const queries = [];
  const foundation = createWorkerFoundation({
    now: () => 0,
    maxConcurrent: 1,
    allowModel: () => true,
    spawnModel: async () => { throw new Error('unused'); },
    workspace: {},
    prepare: async () => {},
    finalize: async () => ({ result: null, error: null }),
    trackWorkspace: () => {},
    commit: async () => { throw new Error('no admission expected'); },
  });
  const harness = {
    commit: async (change) => change({
      scanTasks: async (query) => {
        queries.push(query);
        return { items: [{ id: 9, kind: WORKER_TASK_NAME, conversationId: 5, state: { status: 'terminal' } }] };
      },
    }),
    snapshot: async () => ({ workers: [] }),
    conversation: async () => undefined,
  };
  assert.equal(await foundation.recover(harness, () => true, context), 0);
  assert.deepEqual(queries, [{ kind: WORKER_TASK_NAME, status: 'terminal' }]);
});

test('a foreign input holding the result request ID never marks the worker notified', { timeout: 30_000 }, async () => {
  const fixture = await fixtureWorkspace();
  const release = deferred();
  const dispatcher = async (transcript) => {
    const input = lastUserText(transcript.messages);
    if (input.includes('Background worker task.')) {
      await release.promise;
      return fauxAssistantMessage('COLLIDED-RESULT');
    }
    if (input === 'spawn one' && !dispatcher.issued) {
      dispatcher.issued = true;
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, { action: 'start', task: 'collide', workspace_mode: 'shared' }, { id: 'collide-start' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('ok');
  };
  const store = await syntheticStore(fixture, dispatcher);
  try {
    const conversation = await store.gateway.conversationFor(ORIGIN, context);
    const submission = await conversation.submit({ type: 'input', content: 'spawn one', requestId: 'spawn' }, context);
    assert.equal((await submission.wait(context)).status, 'done');
    const records = await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context);
    const taskId = records.workers[0].taskId;
    // An unrelated input already occupies the result request ID before the worker finishes.
    const foreign = await conversation.submit(
      { type: 'input', content: 'foreign input', requestId: workerResultRequestId(taskId) }, context);
    assert.equal((await foreign.wait(context)).status, 'done');
    release.resolve();
    const task = await store.gateway.harness.getTask(taskId, context);
    assert.ok(task);
    await waitFor(async () =>
      (await store.gateway.harness.getTask(taskId, context))?.state.status === 'terminal',
    'the worker terminal state');
  } finally {
    release.resolve();
    await store.gateway.close(context);
  }
  // Reopen recovery is awaited by open and retries the same request ID, still without proof.
  const reopened = await syntheticStore(fixture, dispatcher);
  try {
    const conversation = await reopened.gateway.conversationFor(ORIGIN, context);
    const record = (await reopened.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers[0];
    assert.equal(record.status, 'completed');
    assert.equal(record.notified, false, 'a deduplicated foreign submission is not this worker\'s admission');
    const entries = (await conversation.entries({ order: 'ascending' }, 200, undefined, context)).items;
    assert.equal(entries.filter((entry) => entry.kind === WORKER_RESULT_ENTRY_KIND).length, 0);
  } finally {
    await reopened.gateway.close(context);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function stopWithdrawalScenario({ foreignNextAttempt }) {
  const fixture = await fixtureWorkspace();
  const releaseWorker = deferred();
  const releaseParent = deferred();
  const busyStarted = deferred();
  const dispatcher = async (transcript) => {
    const input = lastUserText(transcript.messages);
    if (input.includes('Background worker task.')) {
      await releaseWorker.promise;
      return fauxAssistantMessage('WITHDRAWN-RESULT');
    }
    if (input.includes('[internal worker result]')) return fauxAssistantMessage('noted');
    if (input === 'busy') {
      busyStarted.resolve();
      await releaseParent.promise;
      return fauxAssistantMessage('busy done');
    }
    if (input === 'spawn one' && !dispatcher.issued) {
      dispatcher.issued = true;
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, { action: 'start', task: 'withdraw me', workspace_mode: 'shared' }, { id: 'withdraw-start' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('ok');
  };
  const recordOf = async (harness, conversationId) =>
    (await harness.snapshot(WorkerRecordsDoc, conversationId, context))?.workers[0];
  const submissionOf = (harness, conversationId, requestId) =>
    harness.commit((tx) => tx.submissionByRequest(conversationId, requestId), context);
  const store = await syntheticStore(fixture, dispatcher);
  let conversationId;
  let taskId;
  try {
    const conversation = await store.gateway.conversationFor(ORIGIN, context);
    conversationId = conversation.id;
    const spawn = await conversation.submit({ type: 'input', content: 'spawn one', requestId: 'spawn' }, context);
    assert.equal((await spawn.wait(context)).status, 'done');
    taskId = (await recordOf(store.gateway.harness, conversationId)).taskId;
    // Keep the parent busy so the result event queues behind its run.
    await conversation.submit({ type: 'input', content: 'busy', requestId: 'busy' }, context);
    await within(busyStarted.promise, WAIT_MS, 'the busy parent run');
    releaseWorker.resolve();
    await waitFor(async () => (await recordOf(store.gateway.harness, conversationId))?.resultSubmissionId !== undefined,
      'the queued result confirmed as ours');
    const queued = await recordOf(store.gateway.harness, conversationId);
    assert.equal(queued.status, 'completed');
    assert.equal(queued.notified, false, 'a queued result is not delivered yet');
    assert.equal((await submissionOf(store.gateway.harness, conversationId, workerResultRequestId(taskId))).status, 'queued');
    if (foreignNextAttempt) {
      // An unrelated input already holds the request ID the redelivery would use; the same Stop
      // withdraws it too, so it settles unanswered without an entry, like a withdrawn result.
      await conversation.submit(
        { type: 'input', content: 'foreign next attempt', requestId: workerResultRequestId(taskId, 1) }, context);
    }
    // Owner Stop: withdraws queued inputs, including the result event.
    const stopping = conversation.abort(context);
    releaseParent.resolve();
    await stopping;
    await waitFor(async () =>
      (await submissionOf(store.gateway.harness, conversationId, workerResultRequestId(taskId)))?.status === 'unanswered',
    'the Stop withdrawal');
    if (foreignNextAttempt) {
      assert.equal((await submissionOf(store.gateway.harness, conversationId, workerResultRequestId(taskId, 1)))?.status,
        'unanswered');
    }
    const withdrawn = await recordOf(store.gateway.harness, conversationId);
    assert.equal(withdrawn.notified, false, 'a withdrawn result must not count as delivered');
    const entries = (await conversation.entries({ order: 'ascending' }, 200, undefined, context)).items;
    assert.equal(entries.filter((entry) => entry.kind === WORKER_RESULT_ENTRY_KIND).length, 0,
      'nothing is redelivered live right after the Stop');
  } finally {
    releaseWorker.resolve();
    releaseParent.resolve();
    await store.gateway.close(context);
  }
  for (let round = 0; round < 2; round += 1) {
    const reopened = await syntheticStore(fixture, dispatcher);
    try {
      if (foreignNextAttempt) {
        // Reopen recovery is awaited by open: the foreign holder is unproven, so it is held.
        const held = await recordOf(reopened.gateway.harness, conversationId);
        assert.equal(held.notified, false);
        assert.equal(held.resultHeld, true, 'a foreign input at the next attempt is held, not claimed');
        assert.equal(held.resultAttempt, 1, 'the attempt never advances past an unproven holder');
        assert.equal(held.resultSubmissionId, undefined, 'the foreign submission is never recorded as ours');
        const conversation = await reopened.gateway.harness.conversation(conversationId, context);
        const entries = (await conversation.entries({ order: 'ascending' }, 200, undefined, context)).items;
        assert.equal(entries.filter((entry) => entry.kind === WORKER_RESULT_ENTRY_KIND).length, 0);
        continue;
      }
      await waitFor(async () => (await recordOf(reopened.gateway.harness, conversationId))?.notified === true,
        'the redelivered result');
      const conversation = await reopened.gateway.harness.conversation(conversationId, context);
      const entries = (await conversation.entries({ order: 'ascending' }, 200, undefined, context)).items;
      const results = entries.filter((entry) => entry.kind === WORKER_RESULT_ENTRY_KIND);
      assert.equal(results.length, 1, `exactly one delivered result after reopen ${round + 1}`);
      assert.equal(results[0].data.taskId, taskId);
      const redelivery = await submissionOf(reopened.gateway.harness, conversationId, workerResultRequestId(taskId, 1));
      assert.equal(redelivery?.entry, results[0].id);
    } finally {
      await reopened.gateway.close(context);
    }
  }
  await rm(fixture.directory, { recursive: true, force: true });
}

test('a queued result withdrawn by Stop stays unnotified and is redelivered once on reopen', { timeout: 40_000 },
  () => stopWithdrawalScenario({ foreignNextAttempt: false }));

test('a foreign input at the next attempt\'s request ID is held, never claimed or advanced past', { timeout: 40_000 },
  () => stopWithdrawalScenario({ foreignNextAttempt: true }));

test('a commit that fails after admission rolls the admission back with it', async () => {
  const fixture = await fixtureWorkspace();
  const store = await syntheticStore(fixture, async () => fauxAssistantMessage('ok'));
  try {
    const conversation = await store.gateway.conversationFor(ORIGIN, context);
    const harness = store.gateway.harness;
    // The admission and any later failure are one commit: the callback throwing after
    // `submit(tx, ...)` must leave no submission behind.
    await assert.rejects(
      harness.commit(async (tx) => {
        await conversation.submit(tx, {
          type: 'input',
          content: 'rollback probe',
          requestId: 'rollback-probe',
        });
        throw new Error('synthetic post-admission failure');
      }, context),
      /synthetic post-admission failure/,
    );
    const admitted = await harness.commit(
      (tx) => tx.submissionByRequest(conversation.id, 'rollback-probe'),
      context,
    );
    assert.equal(admitted, undefined, 'a failed commit leaves no admission behind');
  } finally {
    await store.gateway.close(context);
  }
  await rm(fixture.directory, { recursive: true, force: true });
});

test('a legacy row notified on queue admission is downgraded and delivered exactly once', { timeout: 40_000 }, async () => {
  const fixture = await fixtureWorkspace();
  const releaseWorker = deferred();
  const releaseParent = deferred();
  const busyStarted = deferred();
  const dispatcher = async (transcript, options) => {
    const input = lastUserText(transcript.messages);
    if (input.includes('Background worker task.')) {
      await releaseWorker.promise;
      return fauxAssistantMessage('LEGACY-CHILD-DONE');
    }
    if (input.includes('[internal worker result]')) return fauxAssistantMessage('noted');
    if (input === 'busy fail') {
      // The parent's run fails (Durable keeps its input and leaves the conversation idle), so the
      // queued result is never placed before the store closes. Retries within that failed run keep
      // failing; only a later boundary that replays the kept input is answered.
      if (dispatcher.busySignal !== undefined && dispatcher.busySignal !== options?.signal) {
        return fauxAssistantMessage('ok');
      }
      dispatcher.busySignal = options?.signal;
      busyStarted.resolve();
      await releaseParent.promise;
      throw new Error('synthetic busy failure');
    }
    if (input === 'spawn legacy' && !dispatcher.issued) {
      dispatcher.issued = true;
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, { action: 'start', task: 'legacy queued one', workspace_mode: 'shared' }, { id: 'legacy-start' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('ok');
  };
  const recordOf = async (harness, conversationId) =>
    (await harness.snapshot(WorkerRecordsDoc, conversationId, context))?.workers[0];
  const submissionOf = (harness, conversationId, requestId) =>
    harness.commit((tx) => tx.submissionByRequest(conversationId, requestId), context);
  const tamper = (harness, conversationId, taskId) =>
    harness.commit(async (tx) => {
      const doc = await tx.doc(WorkerRecordsDoc, conversationId);
      const record = doc.workers.find((candidate) => candidate.taskId === taskId);
      if (record === undefined) return;
      // The pre-atomic shape: queue admission marked notified, ownership was never recorded.
      record.notified = true;
      delete record.resultSubmissionId;
      delete record.resultAttempt;
    }, context);
  const store = await syntheticStore(fixture, dispatcher);
  let conversationId;
  let taskId;
  try {
    const conversation = await store.gateway.conversationFor(ORIGIN, context);
    conversationId = conversation.id;
    const spawn = await conversation.submit({ type: 'input', content: 'spawn legacy', requestId: 'spawn' }, context);
    assert.equal((await spawn.wait(context)).status, 'done');
    taskId = (await recordOf(store.gateway.harness, conversationId)).taskId;
    await conversation.submit({ type: 'input', content: 'busy fail', requestId: 'busy' }, context);
    await within(busyStarted.promise, WAIT_MS, 'the busy parent run');
    releaseWorker.resolve();
    await waitFor(async () => (await recordOf(store.gateway.harness, conversationId))?.resultSubmissionId !== undefined,
      'the queued result confirmed as ours');
    // Let the busy run fail: the conversation goes idle with the result still queued, so the
    // store closes cleanly and the reopen pass meets the legacy row as queued, never placed.
    releaseParent.resolve();
    await conversation.waitForIdle(context);
    await tamper(store.gateway.harness, conversationId, taskId);
  } finally {
    releaseWorker.resolve();
    releaseParent.resolve();
    await store.gateway.close(context);
  }
  const reopened = await syntheticStore(fixture, dispatcher);
  try {
    // The reopen pass reconciles the legacy row: queued is not delivered, so it is downgraded
    // back to pending with recorded ownership instead of being trusted or resubmitted.
    await waitFor(async () => {
      const record = await recordOf(reopened.gateway.harness, conversationId);
      return record?.notified === false && record?.resultSubmissionId !== undefined;
    }, 'the legacy downgrade to pending');
    assert.equal(
      (await submissionOf(reopened.gateway.harness, conversationId, workerResultRequestId(taskId))).status,
      'queued',
      'the downgrade reuses the queued admission, never a new request ID',
    );
    assert.equal(
      await submissionOf(reopened.gateway.harness, conversationId, workerResultRequestId(taskId, 1)),
      undefined,
    );
    // A new parent turn places and answers the queued result; delivery is confirmed once.
    const conversation = await reopened.gateway.conversationFor(ORIGIN, context);
    const go = await conversation.submit({ type: 'input', content: 'go', requestId: 'go' }, context);
    await go.wait(context);
    await waitFor(async () => (await recordOf(reopened.gateway.harness, conversationId))?.notified === true,
      'the delivered legacy result');
    const harness = reopened.gateway.harness;
    const entries = (await harness.conversation(conversationId, context)
      .then((target) => target.entries({ order: 'ascending' }, 200, undefined, context))).items;
    assert.equal(entries.filter((entry) => entry.kind === WORKER_RESULT_ENTRY_KIND).length, 1,
      'exactly one delivered result');
  } finally {
    await reopened.gateway.close(context);
  }
  await rm(fixture.directory, { recursive: true, force: true });
});

test('a legacy row withdrawn without ownership proof is held, never redelivered', { timeout: 40_000 }, async () => {
  const fixture = await fixtureWorkspace();
  const releaseWorker = deferred();
  const releaseParent = deferred();
  const busyStarted = deferred();
  const dispatcher = async (transcript) => {
    const input = lastUserText(transcript.messages);
    if (input.includes('Background worker task.')) {
      await releaseWorker.promise;
      return fauxAssistantMessage('HELD-CHILD-DONE');
    }
    if (input.includes('[internal worker result]')) return fauxAssistantMessage('noted');
    if (input === 'busy') {
      busyStarted.resolve();
      await releaseParent.promise;
      return fauxAssistantMessage('busy done');
    }
    if (input === 'spawn held' && !dispatcher.issued) {
      dispatcher.issued = true;
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, { action: 'start', task: 'held withdrawn one', workspace_mode: 'shared' }, { id: 'held-start' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('ok');
  };
  const recordOf = async (harness, conversationId) =>
    (await harness.snapshot(WorkerRecordsDoc, conversationId, context))?.workers[0];
  const submissionOf = (harness, conversationId, requestId) =>
    harness.commit((tx) => tx.submissionByRequest(conversationId, requestId), context);
  const tamper = (harness, conversationId, taskId) =>
    harness.commit(async (tx) => {
      const doc = await tx.doc(WorkerRecordsDoc, conversationId);
      const record = doc.workers.find((candidate) => candidate.taskId === taskId);
      if (record === undefined) return;
      // The legacy stranding shape: queue admission marked notified, then a Stop withdrew the
      // still-queued input before any ownership was ever recorded.
      record.notified = true;
      delete record.resultSubmissionId;
      delete record.resultAttempt;
    }, context);
  const store = await syntheticStore(fixture, dispatcher);
  let conversationId;
  let taskId;
  try {
    const conversation = await store.gateway.conversationFor(ORIGIN, context);
    conversationId = conversation.id;
    const spawn = await conversation.submit({ type: 'input', content: 'spawn held', requestId: 'spawn' }, context);
    assert.equal((await spawn.wait(context)).status, 'done');
    taskId = (await recordOf(store.gateway.harness, conversationId)).taskId;
    await conversation.submit({ type: 'input', content: 'busy', requestId: 'busy' }, context);
    await within(busyStarted.promise, WAIT_MS, 'the busy parent run');
    releaseWorker.resolve();
    await waitFor(async () => (await recordOf(store.gateway.harness, conversationId))?.resultSubmissionId !== undefined,
      'the queued result confirmed as ours');
    const stopping = conversation.abort(context);
    releaseParent.resolve();
    await stopping;
    await waitFor(async () =>
      (await submissionOf(store.gateway.harness, conversationId, workerResultRequestId(taskId)))?.status === 'unanswered',
    'the Stop withdrawal');
    await tamper(store.gateway.harness, conversationId, taskId);
  } finally {
    releaseWorker.resolve();
    releaseParent.resolve();
    await store.gateway.close(context);
  }
  for (let round = 0; round < 2; round += 1) {
    const reopened = await syntheticStore(fixture, dispatcher);
    try {
      // The reopen pass holds the unprovable row instead of trusting its legacy claim or
      // resubmitting under a fresh attempt: an unknown outcome is never replayed.
      await waitFor(async () => (await recordOf(reopened.gateway.harness, conversationId))?.resultHeld === true,
        `the held legacy row after reopen ${round + 1}`);
      const record = await recordOf(reopened.gateway.harness, conversationId);
      assert.equal(record.resultAttempt, undefined, 'a held row never moves to a redelivery attempt');
      assert.equal(
        await submissionOf(reopened.gateway.harness, conversationId, workerResultRequestId(taskId, 1)),
        undefined,
        'nothing is ever resubmitted for a held row',
      );
      assert.equal(
        (await submissionOf(reopened.gateway.harness, conversationId, workerResultRequestId(taskId))).status,
        'unanswered',
      );
      const harness = reopened.gateway.harness;
      const entries = (await harness.conversation(conversationId, context)
        .then((target) => target.entries({ order: 'ascending' }, 200, undefined, context))).items;
      assert.equal(entries.filter((entry) => entry.kind === WORKER_RESULT_ENTRY_KIND).length, 0,
        'no result event is ever placed for a held row');
    } finally {
      await reopened.gateway.close(context);
    }
  }
  await rm(fixture.directory, { recursive: true, force: true });
});

test('a turn wait reconciles a withdrawal that lost the race to placement or an answer', async () => {
  const fakeSubmission = ({ statuses, abort, settleOnWait }) => {
    let reads = 0;
    let waits = 0;
    return {
      aborts: 0,
      wait() {
        waits += 1;
        return settleOnWait !== undefined && waits > 1 ? Promise.resolve(settleOnWait) : new Promise(() => {});
      },
      async status() { return statuses[Math.min(reads++, statuses.length - 1)]; },
      async abort() {
        this.aborts += 1;
        if (abort === 'reject') throw new Error('withdrawal outcome unknown');
        return abort;
      },
    };
  };
  const idle = { waitForIdle: async () => {} };
  const queued = { type: 'input', id: 1, status: 'queued' };
  const placed = { type: 'input', id: 1, status: 'placed', entry: 5 };
  const done = { type: 'input', id: 1, status: 'done', entry: 5, answer: 6 };

  // Answered between the status read and the abort: the fresh settlement wins.
  const answered = fakeSubmission({ statuses: [queued, done], abort: 'settled' });
  assert.deepEqual(await waitForTurnAnswer(answered, idle, context), { kind: 'settled', record: done });

  // Placed by a successor run first: wait for that run instead of reporting it unanswered.
  const raced = fakeSubmission({ statuses: [queued, placed], abort: 'already_placed', settleOnWait: done });
  assert.deepEqual(await waitForTurnAnswer(raced, idle, context), { kind: 'settled', record: done });

  // A confirmed withdrawal is the only `ended` outcome for a queued input.
  const withdrawn = fakeSubmission({ statuses: [queued], abort: 'aborted' });
  assert.deepEqual(await waitForTurnAnswer(withdrawn, idle, context), { kind: 'ended', record: queued });

  // A rejected withdrawal is unresolved, never a reported failure: the input may still run.
  const abortFailed = fakeSubmission({ statuses: [queued], abort: 'reject' });
  assert.equal((await waitForTurnAnswer(abortFailed, idle, context)).kind, 'unresolved');
  assert.equal(abortFailed.aborts, 1);

  // Still queued after every bounded re-wait: unresolved, not a withdrawal and not a failure.
  const persistent = fakeSubmission({ statuses: [queued], abort: 'already_placed' });
  assert.equal((await waitForTurnAnswer(persistent, idle, context)).kind, 'unresolved');

  // A placed input that never settles is bounded, not waited on forever, and never aborted.
  const stuck = fakeSubmission({ statuses: [placed], abort: 'already_placed' });
  assert.equal((await waitForTurnAnswer(stuck, idle, context)).kind, 'unresolved');
  assert.equal(stuck.aborts, 0, 'a placed input is never aborted');
});

test('a faulted withdrawal or status read stays unresolved; only the caller\'s cancellation throws', async () => {
  const fault = () => Promise.reject(new Error('synthetic storage fault'));
  const idle = { waitForIdle: async () => {} };
  const queued = { type: 'input', id: 1, status: 'queued' };
  let reads = 0;
  // Abort rejects and so does the follow-up status read: no proof either way.
  const doubleFault = {
    wait: () => new Promise(() => {}),
    status: () => (reads++ === 0 ? Promise.resolve(queued) : fault()),
    abort: fault,
  };
  assert.deepEqual(await waitForTurnAnswer(doubleFault, idle, context), { kind: 'unresolved', record: queued });
  // The very first status read after idle faults: still admitted, still unknown.
  const unreadable = { wait: () => new Promise(() => {}), status: fault, abort: fault };
  assert.deepEqual(await waitForTurnAnswer(unreadable, idle, context), { kind: 'unresolved', record: undefined });
  // The wait itself faults without a cancellation: unknown, never a failure receipt.
  const brokenWait = { wait: fault, status: fault, abort: fault };
  assert.equal((await waitForTurnAnswer(brokenWait, { waitForIdle: () => new Promise(() => {}) }, context)).kind,
    'unresolved');
  // The caller's own cancellation still propagates, so a cancelled task stops cleanly.
  const cancelled = Object.create(context, { abortSignal: { value: AbortSignal.abort() } });
  await assert.rejects(waitForTurnAnswer(brokenWait, { waitForIdle: () => new Promise(() => {}) }, cancelled),
    /synthetic storage fault/);
});

test('list and inspect show an unresolved worker as orphaned, and a real cancellation as aborted', async () => {
  const foundation = createWorkerFoundation({
    now: () => 0,
    maxConcurrent: 1,
    allowModel: () => true,
    spawnModel: async () => { throw new Error('unused'); },
    workspace: {},
    prepare: async () => {},
    finalize: async () => ({ result: null, error: null }),
    trackWorkspace: () => {},
    commit: async () => { throw new Error('unused'); },
  });
  const row = (taskId, status) => ({
    taskId, requestId: `tool:${taskId}`, prompt: 'synthetic', workspaceMode: 'shared', createdAtMs: 0,
    finishedAtMs: 1, status, result: null, error: null, conversationId: null, workspacePath: null,
    branch: null, baseCommit: null, notified: false,
  });
  const harness = {
    // An unresolved turn and an owner cancellation both end natively `aborted`.
    snapshot: async () => ({ workers: [row(7, 'orphaned'), row(8, 'aborted')] }),
    getTask: async (id) => ({ id, kind: WORKER_TASK_NAME, conversationId: 3,
      state: { status: 'terminal', outcome: { status: 'aborted', reason: 'x' } } }),
  };
  const listed = await foundation.list(harness, 3, context);
  assert.deepEqual(listed.map((view) => [view.taskId, view.status]), [[7, 'orphaned'], [8, 'aborted']]);
  assert.equal((await foundation.inspect(harness, 3, 7, context)).status, 'orphaned');
  assert.equal((await foundation.inspect(harness, 3, 8, context)).status, 'aborted');
  assert.deepEqual(listed.map((view) => workerTask(view).state), ['failed', 'cancelled'],
    'the app Tasks view never labels an unresolved worker cancelled');
});

test('a cancelled worker whose report startup suppressed keeps evictable suppression proof', { timeout: 30_000 }, async () => {
  const fixture = await fixtureWorkspace();
  const childStarted = deferred();
  const dispatcher = async (transcript, options) => {
    const input = lastUserText(transcript.messages);
    if (input.includes('Background worker task.')) {
      childStarted.resolve();
      await new Promise((resolve) => {
        if (options?.signal?.aborted) return resolve();
        options?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return fauxAssistantMessage('CANCELLED-CHILD');
    }
    if (input === 'spawn one' && !dispatcher.issued) {
      dispatcher.issued = true;
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, { action: 'start', task: 'suppress me', workspace_mode: 'shared' }, { id: 'suppress-start' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('ok');
  };
  const recordOf = async (harness, conversationId) =>
    (await harness.snapshot(WorkerRecordsDoc, conversationId, context))?.workers[0];
  const store = await syntheticStore(fixture, dispatcher);
  let conversationId;
  try {
    const conversation = await store.gateway.conversationFor(ORIGIN, context);
    conversationId = conversation.id;
    const spawn = await conversation.submit({ type: 'input', content: 'spawn one', requestId: 'spawn' }, context);
    assert.equal((await spawn.wait(context)).status, 'done');
    await within(childStarted.promise, WAIT_MS, 'the worker child turn');
    const live = await recordOf(store.gateway.harness, conversationId);
    assert.ok(live.conversationId !== null);
    // Startup recovery recorded this exact run as interrupted before cancelling it.
    await store.gateway.harness.commit(async (tx) => {
      addInterruptedRunReport(await tx.doc(InterruptedRunReportsDoc), {
        runTaskId: live.taskId, targetConversationId: live.conversationId, recordedAtMs: 0,
      });
      return undefined;
    }, context);
    await store.gateway.harness.abortTask(live.taskId, context);
    await waitFor(async () => (await recordOf(store.gateway.harness, conversationId))?.status === 'aborted',
      'the cancellation commit');
    const cancelled = await recordOf(store.gateway.harness, conversationId);
    assert.equal(cancelled.notified, true);
    assert.equal(cancelled.resultSuppressed, true, 'the abort path persists suppression proof');
  } finally {
    await store.gateway.close(context);
  }
  const reopened = await syntheticStore(fixture, dispatcher);
  try {
    const record = await recordOf(reopened.gateway.harness, conversationId);
    assert.equal(record.notified, true);
    assert.notEqual(record.resultHeld, true, 'a deliberately suppressed row is never held as ambiguous');
    const conversation = await reopened.gateway.harness.conversation(conversationId, context);
    const entries = (await conversation.entries({ order: 'ascending' }, 200, undefined, context)).items;
    assert.equal(entries.filter((entry) => entry.kind === WORKER_RESULT_ENTRY_KIND).length, 0);
  } finally {
    await reopened.gateway.close(context);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('the active-worker bound refuses an extra start instead of queueing it', { timeout: 25_000 }, async () => {
  const fixture = await fixtureWorkspace();
  const release = deferred();
  const gate = async (options) => {
    await new Promise((resolve) => {
      const signal = options?.signal;
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', () => resolve(), { once: true });
      release.promise.then(() => resolve());
    });
    return fauxAssistantMessage('GATED-CHILD-DONE');
  };
  const issued = new Set();
  const store = await syntheticStore(fixture, async (transcript, options) => {
    const input = lastUserText(transcript.messages);
    if (input.includes('Background worker task.')) return gate(options);
    if (input === 'spawn guarded one' && !issued.has(input)) {
      issued.add(input);
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, { action: 'start', task: 'guarded task one', workspace_mode: 'shared' }, { id: 'guarded-start-one' }),
      ], { stopReason: 'toolUse' });
    }
    if (input === 'spawn guarded two' && !issued.has(input)) {
      issued.add(input);
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, { action: 'start', task: 'guarded task two', workspace_mode: 'shared' }, { id: 'guarded-start-two' }),
      ], { stopReason: 'toolUse' });
    }
    if (input.includes('[internal worker result]')) return fauxAssistantMessage('noted');
    return fauxAssistantMessage('ok');
  }, { workers: { enabled: true, maxConcurrent: 1 } });
  try {
    const conversation = await store.gateway.conversationFor(ORIGIN, context);
    const first = await conversation.submit({ type: 'input', content: 'spawn guarded one', requestId: 'first' }, context);
    const firstSettled = await first.wait(context);
    assert.equal(firstSettled.status, 'done', JSON.stringify(firstSettled));
    await within((async () => {
      const records = await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context);
      while ((records?.workers.length ?? 0) < 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        const next = await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context);
        if ((next?.workers.length ?? 0) >= 1) return;
      }
    })(), WAIT_MS, 'the first worker was never recorded');
    // A second start while the first is live is refused by the tool, not silently queued.
    const second = await conversation.submit({ type: 'input', content: 'spawn guarded two', requestId: 'second' }, context);
    assert.equal((await second.wait(context)).status, 'done');
    const entries = (await conversation.entries({ order: 'ascending' }, 200, undefined, context)).items;
    const results = entries.filter((entry) => entry.model?.[0]?.role === 'toolResult')
      .map((entry) => entry.model[0]);
    const refusals = results.filter((message) => message.toolCallId === 'guarded-start-one'
      || message.toolCallId === 'guarded-start-two');
    assert.equal(refusals.length, 2, 'both start calls are represented');
    assert.equal(refusals[0].isError ?? false, false);
    assert.equal(refusals[1].isError, true);
    assert.match(
      (refusals[1].content ?? []).map((part) => part.text ?? '').join(''),
      new RegExp(`limit is 1`),
    );
    const records = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers;
    assert.equal(records.length, 1, 'a refused start creates no record and no task');
    release.resolve();
  } finally {
    release.resolve();
    await store.gateway.close(context);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('a narrowed config on reopen cannot restore a live worker tool the ceiling removed', { timeout: 40_000 }, async () => {
  const fixture = await fixtureWorkspace();
  const firstChildStarted = deferred();
  let gated = true;
  const gate = async (options) => {
    if (!gated) return fauxAssistantMessage('RESUMED-CHILD-DONE');
    firstChildStarted.resolve();
    await new Promise((resolve) => {
      const signal = options?.signal;
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    // A close legitimately interrupts this attempt; the resumed invocation answers normally.
    return fauxAssistantMessage('INTERRUPTED-CHILD-DONE');
  };
  const issued = new Set();
  const dispatcher = async (transcript, options) => {
    const input = lastUserText(transcript.messages);
    if (input.includes('Background worker task.')) return gate(options);
    if (input === 'spawn a reader' && !issued.has(input)) {
      issued.add(input);
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, { action: 'start', task: 'read note.txt', workspace_mode: 'shared' }, { id: 'reader-start' }),
      ], { stopReason: 'toolUse' });
    }
    if (input.includes('[internal worker result]')) return fauxAssistantMessage('noted');
    return fauxAssistantMessage('ok');
  };

  const first = await syntheticStore(fixture, dispatcher, { codemode: { enabled: true } });
  let reopened;
  let childConversationId;
  try {
    const conversation = await first.gateway.conversationFor(ORIGIN, context);
    const submission = await conversation.submit({ type: 'input', content: 'spawn a reader', requestId: 'reader' }, context);
    assert.equal((await submission.wait(context)).status, 'done');
    await within(firstChildStarted.promise, WAIT_MS, 'the worker child never started');
    const record = (await first.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers[0];
    childConversationId = record.conversationId;
    assert.ok(childConversationId, 'the worker target conversation must be recorded');
    const live = await first.gateway.harness.getTask(record.taskId, context);
    assert.notEqual(live.state.status, 'terminal');
  } finally {
    gated = false;
    await first.gateway.close(context);
  }

  try {
    // The reopened ceiling no longer includes `read`: the live worker may keep no captured authority.
    const model = { provider: 'worker-fixture', modelId: 'synthetic' };
    const config = parseConfig({
      workspace: fixture.workspace,
      dataDir: fixture.dataDir,
      model,
      allowedModels: [model],
      toolAllowlist: ['write'],
      workers: { enabled: true },
      codemode: { enabled: true },
    }, fixture.directory);
    const faux = fauxProvider({ provider: 'worker-fixture', models: [{ id: 'synthetic', name: 'Synthetic' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses(Array.from({ length: 40 }, () => dispatcher));
    reopened = await openGateway(config, context, { models });
    const child = await reopened.harness.conversation(childConversationId, context);
    assert.ok(child, 'the live worker target survives the reopen');
    const agent = await child.agent(context);
    const names = (agent.tools ?? []).map((tool) => (tool && typeof tool === 'object' ? tool.name : tool));
    assert.equal(names.includes('read'), false, `a removed tool must not survive the reopen: ${names}`);
    // The compositor itself survives for a live child, but the narrowed capture leaves nothing to
    // compose and no worker path to discover: stale Code Mode authority stays scoped to the capture.
    assert.ok(names.includes(CODEMODE_TOOL_NAME), `a live child keeps the compositor: ${names}`);
    const callable = (agent.callable ?? []).map((tool) => (tool && typeof tool === 'object' ? tool.name : tool));
    assert.equal(callable.includes('read'), false, `narrowed capture cannot compose read: ${callable}`);
    assert.ok(callable.includes('write'), `a still-configured captured tool stays composable: ${callable}`);
    assert.equal(callable.includes(WORKER_TOOL_NAME), false, `a child cannot compose a worker: ${callable}`);
    assert.deepEqual(agent.deferred ?? [], [], 'no unconfigured deferred MCP tool is discoverable in a child');
  } finally {
    if (reopened) await reopened.close(context);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('native Code Mode composes the worker tool from a mapped chat without widening the child', { timeout: 45_000 }, async () => {
  const fixture = await fixtureWorkspace();
  const issued = new Set();
  const store = await syntheticStore(fixture, async (transcript) => {
    const input = lastUserText(transcript.messages);
    if (input.includes('Background worker task.')) return fauxAssistantMessage('NESTED-CHILD-DONE');
    if (input.includes('[internal worker result]')) return fauxAssistantMessage('noted');
    if (input === 'compose a worker' && !issued.has(input)) {
      issued.add(input);
      // A general Code Mode script composes the worker tool like any other agent tool.
      return fauxAssistantMessage([
        fauxToolCall(CODEMODE_TOOL_NAME, {
          code: 'return await tools.worker({ action: "start", task: "nested code mode worker", workspace_mode: "shared" });',
        }, { id: 'nested-worker-code' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('ok');
  }, { toolAllowlist: ['read'], codemode: { enabled: true } });
  try {
    const conversation = await store.gateway.conversationFor(ORIGIN, context);
    const offered = ((await conversation.agent(context)).tools ?? [])
      .map((tool) => (typeof tool === 'string' ? tool : tool.name));
    assert.ok(offered.includes(CODEMODE_TOOL_NAME), `a mapped chat composes Code Mode: ${offered}`);

    const submission = await conversation.submit({ type: 'input', content: 'compose a worker', requestId: 'compose' }, context);
    assert.equal((await submission.wait(context)).status, 'done');
    const entries = (await conversation.entries({ order: 'ascending' }, 200, undefined, context)).items;
    const codeResult = entries.filter((entry) => entry.model?.[0]?.role === 'toolResult')
      .map((entry) => entry.model[0]).find((message) => message.toolCallId === 'nested-worker-code');
    assert.ok(codeResult, 'the Code Mode call reached a tool result');
    assert.equal(codeResult.isError ?? false, false, JSON.stringify(codeResult.content));
    assert.match((codeResult.content ?? []).map((part) => part.text ?? '').join(''), /Started background worker \d+/);

    const records = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers;
    assert.equal(records.length, 1, 'the nested start created exactly one worker');
    assert.equal(records[0].prompt, 'nested code mode worker');
    assert.match(records[0].requestId, /^tool:\d+$/, 'the nested call uses its own host tool-task identity');
    await waitFor(async () =>
      (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context))?.workers[0]?.conversationId != null,
    'the nested worker target');
    const record = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers[0];
    const child = await store.gateway.harness.conversation(record.conversationId, context);
    const childTools = ((await child.agent(context)).tools ?? [])
      .map((tool) => (typeof tool === 'string' ? tool : tool.name));
    assert.ok(childTools.includes('read'), `the captured ceiling still applies: ${childTools}`);
    for (const name of ['memory_search', 'memory_browse', 'memory_read']) assert.ok(childTools.includes(name), `the child retains captured research tools: ${childTools}`);
    assert.equal(childTools.includes('history'), false, `model history is retired: ${childTools}`);
    for (const forbidden of [WORKER_TOOL_NAME, 'cron', 'telegram']) {
      assert.equal(childTools.includes(forbidden), false, `Code Mode composition must not widen the child: ${forbidden}`);
    }
    // The child does hold the compositor itself (owner-corrected scope); the next test proves it
    // composes only captured tools and cannot reach the worker tool.
    assert.ok(childTools.includes(CODEMODE_TOOL_NAME), `a live child composes its capture: ${childTools}`);
  } finally {
    await store.gateway.close(context);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('a worker child composes its captured tools through Code Mode and cannot spawn a worker', { timeout: 45_000 }, async () => {
  const fixture = await fixtureWorkspace();
  const issued = new Set();
  const store = await syntheticStore(fixture, async (transcript) => {
    const input = lastUserText(transcript.messages);
    const transcriptBody = transcriptText(transcript.messages);
    if (input.includes('Background worker task.')) {
      if (transcriptBody.includes('"child-code"')) return fauxAssistantMessage('CHILD-COMPOSED');
      return fauxAssistantMessage([
        fauxToolCall(CODEMODE_TOOL_NAME, {
          code: [
            "const hits = await searchTools('worker');",
            "const read = await tools.read({ path: 'note.txt' });",
            "let spawn = null;",
            "try { await tools.worker({ action: 'start', task: 'recursive', workspace_mode: 'shared' }); }",
            "catch (error) { spawn = String((error && error.message) || error); }",
            'return { hits: hits.map((hit) => hit.name), read, spawn };',
          ].join('\n'),
        }, { id: 'child-code' }),
      ], { stopReason: 'toolUse' });
    }
    if (input.includes('[internal worker result]')) return fauxAssistantMessage('noted');
    if (input === 'spawn a composing worker' && !issued.has(input)) {
      issued.add(input);
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, { action: 'start', task: 'compose captured tools', workspace_mode: 'shared' }, { id: 'compose-start' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('ok');
  }, { toolAllowlist: ['read'], codemode: { enabled: true } });
  let resultWatcher;
  try {
    const conversation = await store.gateway.conversationFor(ORIGIN, context);
    resultWatcher = changeWatcher(store.gateway.harness, workerResultCommitted(conversation.id), 'composed worker result');
    const submission = await conversation.submit({ type: 'input', content: 'spawn a composing worker', requestId: 'compose' }, context);
    assert.equal((await submission.wait(context)).status, 'done');
    await within(resultWatcher.promise, WAIT_MS, 'the composing worker never reported');

    const records = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers;
    assert.equal(records.length, 1, 'the child never started another worker');
    const childConversationId = records[0].conversationId;
    assert.ok(childConversationId, 'the child target is recorded');

    // The child's own transcript carries the Code Mode composition result.
    const child = await store.gateway.harness.conversation(childConversationId, context);
    const childEntries = (await child.entries({ order: 'ascending' }, 200, undefined, context)).items;
    const composed = childEntries.filter((entry) => entry.model?.[0]?.role === 'toolResult')
      .map((entry) => entry.model[0]).find((message) => message.toolCallId === 'child-code');
    assert.ok(composed, 'the child reached a Code Mode result');
    assert.equal(composed.isError ?? false, false, JSON.stringify(composed.content));
    const composedText = (composed.content ?? []).map((part) => part.text ?? '').join('');
    assert.match(composedText, /WORKER-NOTE-CONTENT/, 'the captured read tool really ran through Code Mode');
    assert.match(composedText, /"hits":\[\]/, 'tool_search exposes no worker (or other) grant to the child');
    assert.match(composedText, /spawn":/, 'the script attempted a nested spawn');

    // Terminal retirement revokes the compositor with the capture: nothing left to compose.
    const terminal = (await store.gateway.harness.getTask(records[0].taskId, context)).state;
    assert.equal(terminal.status, 'terminal');
    const retired = await store.gateway.harness.conversation(childConversationId, context);
    const retiredTools = ((await retired.agent(context)).tools ?? [])
      .map((tool) => (typeof tool === 'string' ? tool : tool.name));
    assert.deepEqual(retiredTools, [], `a finished child keeps no compositor: ${retiredTools}`);
    assert.equal(await store.gateway.harness.snapshot(ConfigToolCaptureDoc, childConversationId, context), undefined);
  } finally {
    resultWatcher?.stop();
    await store.gateway.close(context);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('a reopen that removed a live worker model fails closed without substitution or dispatch', { timeout: 55_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-worker-removed-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'note.txt'), 'REMOVED-MODEL-NOTE\n');
  let child;
  let childExit;
  let gateway;
  let stderr = '';
  try {
    child = spawn(process.execPath, [
      join(packageRoot, 'tests/fixtures/worker-model-removed-child.mjs'),
      directory,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Synthetic child: no inherited credentials or host configuration.
      env: {
        HOME: directory,
        TMPDIR: directory,
        PATH: process.env.PATH ?? '',
        PI_WORKER_CANDIDATE: packageRoot,
      },
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    childExit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    await within(new Promise((resolve, reject) => {
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout.includes('CHILD-TOOL-RUNNING')) resolve(stdout);
      });
      child.once('error', reject);
      void childExit.then((exit) => reject(
        new Error(`fixture exited before readiness (${JSON.stringify(exit)}): ${stderr}`),
      ));
    }), 40_000, 'fixture readiness');
    // Kill while the child holds a live, non-prepared tool task: no saved provider dispatch exists.
    assert.equal(child.kill('SIGKILL'), true);
    assert.deepEqual(await within(childExit, 10_000, 'SIGKILL exit'), { code: null, signal: 'SIGKILL' });
    child = undefined;
    const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));

    // The reopened catalog no longer contains the non-default preset the worker captured.
    const faux = fauxProvider({ provider: 'worker-removed', models: [{ id: 'primary', name: 'Primary' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const calls = [];
    const dispatcher = (transcript, _options, _state, model) => {
      calls.push({ modelId: model?.id, body: transcriptText(transcript.messages) });
      const input = lastUserText(transcript.messages);
      if (input.includes('[internal worker result]')) return fauxAssistantMessage('noted');
      return fauxAssistantMessage('ok');
    };
    faux.setResponses(Array.from({ length: 20 }, () => dispatcher));
    const config = parseConfig({
      workspace,
      dataDir: join(directory, 'state'),
      modelPresets: { primary: { provider: 'worker-removed', modelId: 'primary' } },
      modelPreset: 'primary',
      toolAllowlist: ['read', 'bash'],
      workers: { enabled: true },
    }, directory);
    // The non-prepared case must open: no saved dispatch names the removed model.
    gateway = await openGateway(config, context, { models });

    await waitFor(async () => {
      const task = await gateway.harness.getTask(state.workerTaskId, context);
      return task?.state.status === 'terminal';
    }, 'the worker terminal outcome');
    const task = await gateway.harness.getTask(state.workerTaskId, context);
    assert.equal(task.state.outcome.status, 'failed');
    assert.match(task.state.outcome.error.message, /no longer in the configured model catalog/);

    await waitFor(async () =>
      (await gateway.harness.snapshot(WorkerRecordsDoc, state.chatConversationId, context))?.workers[0]?.notified === true,
    'the failure admission');
    const record = (await gateway.harness.snapshot(WorkerRecordsDoc, state.chatConversationId, context)).workers[0];
    assert.equal(record.status, 'failed');
    assert.equal(record.result, null);

    // The pin stays honest: the captured model is not silently replaced by the configured default.
    const agent = await gateway.harness.snapshot(AgentDoc, state.childConversationId, context);
    assert.equal(agent.model?.provider, 'worker-removed');
    assert.equal(agent.model?.modelId, 'research');
    // No captured authority survives, and no child work remains.
    assert.equal(await gateway.harness.snapshot(ConfigToolCaptureDoc, state.childConversationId, context), undefined);
    const childConversation = await gateway.harness.conversation(state.childConversationId, context);
    const tools = (await childConversation.agent(context)).tools ?? [];
    assert.deepEqual(tools.map((tool) => (typeof tool === 'string' ? tool : tool.name)), []);
    const inspection = await gateway.harness.inspect(context);
    assert.deepEqual(
      inspection.tasks.filter((entry) => entry.record.conversationId === state.childConversationId)
        .map((entry) => `${entry.record.kind}:${entry.record.state.status}`),
      [],
      'the removed-model worker leaves no live child work',
    );
    // Wait deterministically for the parent's own result-event turn: the reopen must resume the
    // spawning agent as normal model work, and only then does the negative check below have a
    // meaningful set of dispatches to inspect.
    await waitFor(() => calls.some((call) => call.body.includes('[internal worker result]')),
      'the parent result-event turn');
    // Neither the removed model nor a fallback ran the child: the only dispatch is the parent turn
    // answering the internal result event on the configured preset. That event echoes the spawning
    // agent's own task text by design, so the child's own prompt wrapper and tool call are the markers
    // that must never appear again.
    assert.equal(calls.filter((call) => call.modelId === 'research').length, 0);
    assert.equal(calls.filter((call) => call.body.includes('Background worker task.')).length, 0,
      'the child conversation must never dispatch after the reopen');
    assert.equal(calls.filter((call) => call.body.includes('seq 1 200')).length, 0,
      'the blocked child tool must not run again');
    assert.equal(calls.length, 1, 'exactly the parent result-event turn dispatched');
    assert.equal(calls[0].modelId, 'primary');
  } finally {
    // Release the bounded synthetic shell loop the killed fixture left running.
    await writeFile(join(workspace, 'release.txt'), 'release\n').catch(() => undefined);
    if (gateway) await gateway.close(context);
    if (child !== undefined) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});

test('a worker child reading an image still gets the flagged-preset vision handoff', { timeout: 30_000 }, async () => {
  const fixture = await fixtureWorkspace();
  const mediaDir = join(fixture.workspace, 'media');
  await mkdir(mediaDir);
  await writeFile(join(mediaDir, 'photo.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ));
  const provider = fauxProvider({ provider: 'vision-worker', models: [
    { id: 'chat', name: 'Chat', reasoning: false, input: ['text'] },
    { id: 'eyes', name: 'Eyes', reasoning: false, input: ['text', 'image'] },
  ] });
  const models = createModels();
  models.setProvider(provider.provider);
  const calls = [];
  const issued = new Set();
  const systemText = (messages) => {
    const first = messages?.[0];
    if (first?.role !== 'system') return '';
    return typeof first.content === 'string'
      ? first.content
      : (Array.isArray(first.content) ? first.content : []).map((part) => (part.type === 'text' ? part.text : '')).join('');
  };
  const dispatcher = (transcript) => {
    const describer = systemText(transcript.messages).includes('precise vision assistant');
    const images = transcript.messages.flatMap((message) => Array.isArray(message.content)
      ? message.content.filter((block) => block.type === 'image') : []);
    const body = transcript.messages.flatMap((message) => Array.isArray(message.content)
      ? message.content.filter((block) => block.type === 'text').map((block) => block.text) : []).join('\n');
    calls.push({ kind: describer ? 'describer' : 'generation', images: images.length, body });
    if (describer) return fauxAssistantMessage('WORKER-DESCRIBED-IMAGE');
    const input = lastUserText(transcript.messages);
    if (body.includes('read tool path')) return fauxAssistantMessage('IMAGE-ANSWER');
    if (input.includes('Background worker task.') && !transcriptText(transcript).includes('worker-read-image')) {
      return fauxAssistantMessage([
        fauxToolCall('read', { path: 'media/photo.png' }, { id: 'worker-read-image' }),
      ], { stopReason: 'toolUse' });
    }
    if (input === 'spawn an image reader' && !issued.has(input)) {
      issued.add(input);
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, { action: 'start', task: 'inspect media/photo.png', workspace_mode: 'shared' }, { id: 'image-start' }),
      ], { stopReason: 'toolUse' });
    }
    if (input.includes('[internal worker result]')) return fauxAssistantMessage('noted');
    return fauxAssistantMessage('ok');
  };
  provider.setResponses(Array.from({ length: 40 }, () => dispatcher));
  const config = parseConfig({
    workspace: fixture.workspace,
    dataDir: fixture.dataDir,
    modelPresets: {
      chat: { provider: 'vision-worker', modelId: 'chat', needsVisionHandoff: true },
      eyes: { provider: 'vision-worker', modelId: 'eyes' },
    },
    modelPreset: 'chat',
    visionHandoff: { describerPreset: 'eyes' },
    toolAllowlist: ['read'],
    workers: { enabled: true },
  }, fixture.directory);
  let gateway;
  try {
    gateway = await openGateway(config, context, { models, agentHistory: false });
    const conversation = await gateway.conversationFor(ORIGIN, context);
    const watcher = changeWatcher(gateway.harness, workerResultCommitted(conversation.id), 'image worker result');
    const submission = await conversation.submit({ type: 'input', content: 'spawn an image reader', requestId: 'image' }, context);
    assert.equal((await submission.wait(context)).status, 'done');
    await within(watcher.promise, WAIT_MS, 'the image worker never reported');
    watcher.stop();

    const imageGeneration = calls.find((call) => call.kind === 'generation' && call.body.includes('read tool path'));
    assert.ok(imageGeneration, 'the worker child must reach a generation after the read-tool image');
    assert.equal(imageGeneration.images, 0, 'a flagged child model keeps zero raw images');
    assert.match(imageGeneration.body, /WORKER-DESCRIBED-IMAGE/, imageGeneration.body);
    assert.equal(calls.filter((call) => call.kind === 'describer').length, 1);
  } finally {
    if (gateway) await gateway.close(context);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function toolResultFor(conversation, callId) {
  const entries = (await conversation.entries({ order: 'ascending' }, 400, undefined, context)).items;
  const message = entries
    .filter((entry) => entry.model?.[0]?.role === 'toolResult')
    .map((entry) => entry.model[0])
    .find((candidate) => candidate.toolCallId === callId);
  assert.ok(message, `the ${callId} call must reach a tool result`);
  return {
    message,
    text: (message.content ?? []).map((part) => part.text ?? '').join(''),
  };
}

const rowIds = (text) => [...text.matchAll(/^#(\d+) \[/gm)].map((match) => Number(match[1]));

test('transcript reads a live then finished worker, renders its task prompt and tool records, pages older entries and writes nothing', { timeout: 45_000 }, async () => {
  const fixture = await fixtureWorkspace();
  const childStarted = deferred();
  const releaseChild = deferred();
  const childDispatches = [];
  let childTurns = 0;
  const issued = new Set();
  const store = await syntheticStore(fixture, async (transcript) => {
    const input = lastUserText(transcript.messages);
    if (input.includes('Background worker task.')) {
      childDispatches.push(input);
      childTurns += 1;
      if (childTurns === 1) {
        childStarted.resolve();
        await releaseChild.promise;
        return fauxAssistantMessage([
          fauxToolCall('write', { path: 'transcript-note.txt', content: 'TOOL-RESULT-MARKER\n' }, { id: 'child-write' }),
        ], { stopReason: 'toolUse' });
      }
      return fauxAssistantMessage(`LONG-ANSWER-MARKER ${'x'.repeat(2_000)}`);
    }
    if (input.includes('[internal worker result]')) return fauxAssistantMessage('noted');
    if (input === 'spawn transcript worker' && !issued.has(input)) {
      issued.add(input);
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, {
          action: 'start',
          task: 'WORKER-TASK-MARKER write the transcript note then report',
          workspace_mode: 'shared',
        }, { id: 'transcript-start' }),
      ], { stopReason: 'toolUse' });
    }
    if (input.startsWith('read transcript') && !issued.has(input)) {
      issued.add(input);
      const worker = /worker (\d+)/.exec(input);
      const before = /before (\d+)/.exec(input);
      const limit = /limit (\d+)/.exec(input);
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, {
          action: 'transcript',
          worker_id: Number(worker[1]),
          ...(before === null ? {} : { before: Number(before[1]) }),
          ...(limit === null ? {} : { limit: Number(limit[1]) }),
        }, { id: input.replace(/\s+/gu, '-') }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('ok');
  });
  let conversation;
  try {
    conversation = await store.gateway.conversationFor(ORIGIN, context);
    const spawn = await conversation.submit({ type: 'input', content: 'spawn transcript worker', requestId: 'spawn-transcript' }, context);
    assert.equal((await spawn.wait(context)).status, 'done');
    await within(childStarted.promise, WAIT_MS, 'the worker child never started');
    await waitFor(async () =>
      (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context))?.workers[0]?.conversationId != null,
    'the worker target conversation');
    const live = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers[0];
    assert.ok(['queued', 'running'].includes(live.status));
    const liveCall = `read-transcript-worker-${live.taskId}-limit-20`;
    const liveRead = await conversation.submit({
      type: 'input',
      content: `read transcript worker ${live.taskId} limit 20`,
      requestId: 'read-live',
    }, context);
    assert.equal((await liveRead.wait(context)).status, 'done');
    const liveText = (await toolResultFor(conversation, liveCall)).text;
    assert.match(liveText, /Status: (queued|running)/);
    assert.match(liveText, /user \(worker task\)/);
    assert.match(liveText, new RegExp(`kind=${WORKER_INPUT_ENTRY_KIND}`));
    assert.match(liveText, /WORKER-TASK-MARKER/);
    assert.match(liveText, /untrusted data/);
    assert.match(liveText, /Read-only: this call ran no model/);
    assert.equal(rowIds(liveText).length, 1, 'the live page shows exactly the committed worker task input entry');

    releaseChild.resolve();
    await waitFor(async () => {
      const record = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers[0];
      return record.status === 'completed' && record.notified === true;
    }, 'the worker to finish and notify');
    const finished = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers[0];
    const child = await store.gateway.harness.conversation(finished.conversationId, context);
    const childEntriesBefore = (await child.entries({ order: 'ascending' }, 100, undefined, context)).items;
    const dispatchesBefore = childDispatches.length;

    const pageOneCall = `read-transcript-worker-${finished.taskId}-limit-2`;
    const pageOne = await conversation.submit({
      type: 'input',
      content: `read transcript worker ${finished.taskId} limit 2`,
      requestId: 'read-page-one',
    }, context);
    assert.equal((await pageOne.wait(context)).status, 'done');
    const pageOneText = (await toolResultFor(conversation, pageOneCall)).text;
    const firstIds = rowIds(pageOneText);
    assert.equal(firstIds.length, 2);
    assert.deepEqual(firstIds, [...firstIds].sort((a, b) => a - b), 'a page is shown oldest to newest');
    assert.match(pageOneText, /\[assistant\] kind=pi\.assistant/);
    assert.match(pageOneText, /LONG-ANSWER-MARKER/);
    assert.match(pageOneText, /\[truncated\]/);
    assert.equal(pageOneText.includes('x'.repeat(1_300)), false, 'one long answer is bounded per entry');
    assert.ok(Buffer.byteLength(pageOneText, 'utf8') < 64 * 1024, 'the rendered page stays under the tool limit');
    assert.match(pageOneText, /\[tool write\] kind=pi\.tool-result/);
    const before = /before=(\d+)/.exec(pageOneText);
    assert.ok(before, `the page must offer the strictly older cursor: ${pageOneText.slice(-400)}`);

    const pageTwoCall = `read-transcript-worker-${finished.taskId}-before-${before[1]}-limit-3`;
    const pageTwo = await conversation.submit({
      type: 'input',
      content: `read transcript worker ${finished.taskId} before ${before[1]} limit 3`,
      requestId: 'read-page-two',
    }, context);
    assert.equal((await pageTwo.wait(context)).status, 'done');
    const pageTwoText = (await toolResultFor(conversation, pageTwoCall)).text;
    const secondIds = rowIds(pageTwoText);
    assert.deepEqual(secondIds, [...secondIds].sort((a, b) => a - b));
    assert.ok(secondIds.length >= 2, `the older page shows the prompt and the tool call: ${pageTwoText}`);
    assert.equal(firstIds.some((id) => secondIds.includes(id)), false, 'pages never overlap');
    assert.ok(Math.max(...secondIds) < Math.min(...firstIds), 'the older page is strictly below the first');
    assert.match(pageTwoText, /user \(worker task\)/);
    assert.match(pageTwoText, /kind=nanobot\.worker-task/);
    assert.match(pageTwoText, /\[tool call write /);

    // Read-only: no child model dispatch, no child entry, no record or notification change.
    assert.equal(childDispatches.length, dispatchesBefore, 'transcript runs no worker model turn');
    const childEntriesAfter = (await child.entries({ order: 'ascending' }, 100, undefined, context)).items;
    assert.deepEqual(childEntriesAfter.map((entry) => entry.id), childEntriesBefore.map((entry) => entry.id));
    const afterRead = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers[0];
    assert.deepEqual(afterRead, finished, 'transcript writes no worker record, status or cursor');
    const parentEntries = (await conversation.entries({ order: 'ascending' }, 400, undefined, context)).items;
    assert.equal(parentEntries.filter((entry) => entry.kind === WORKER_RESULT_ENTRY_KIND).length, 1);
  } finally {
    releaseChild.resolve();
    if (store.gateway !== undefined) await store.gateway.close(context);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('transcript resolution refuses forged child ownership, other chats, root and raw conversations', { timeout: 40_000 }, async () => {
  const fixture = await fixtureWorkspace();
  const issued = new Set();
  const store = await syntheticStore(fixture, async (transcript) => {
    const input = lastUserText(transcript.messages);
    if (input.includes('Background worker task.')) return fauxAssistantMessage('BOUNDED-CHILD-DONE');
    if (input.includes('[internal worker result]')) return fauxAssistantMessage('noted');
    if (input === 'spawn one worker' && !issued.has(input)) {
      issued.add(input);
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, { action: 'start', task: 'bounded child task', workspace_mode: 'shared' }, { id: 'spawn-one' }),
      ], { stopReason: 'toolUse' });
    }
    if (input.startsWith('read transcript') && !issued.has(input)) {
      issued.add(input);
      const worker = /worker (\d+)/.exec(input);
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, {
          action: 'transcript',
          worker_id: Number(worker[1]),
          limit: 2,
        }, { id: input.replace(/\s+/gu, '-') }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('ok');
  });
  try {
    const conversation = await store.gateway.conversationFor(ORIGIN, context);
    const submission = await conversation.submit({ type: 'input', content: 'spawn one worker', requestId: 'spawn-one' }, context);
    assert.equal((await submission.wait(context)).status, 'done');
    await waitFor(async () => {
      const record = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context))?.workers[0];
      return record?.status === 'completed' && record.notified === true;
    }, 'the worker to finish');
    const record = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers[0];

    const resolved = await resolveWorkerTarget(store.gateway.harness, conversation.id, record.taskId, context);
    assert.ok(resolved, 'the owning conversation resolves its own worker');
    assert.equal(resolved.targetConversationId, record.conversationId);
    assert.equal(resolved.status, 'completed');

    const other = await store.gateway.conversationFor(ELSEWHERE, context);
    const root = await store.gateway.harness.root(context);
    const raw = await store.gateway.harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
    for (const [id, label] of [
      [other.id, 'another mapped chat'],
      [root.id, 'the root conversation'],
      [raw.id, 'a raw conversation'],
      [record.conversationId, 'the worker child itself'],
      [Number.MAX_SAFE_INTEGER, 'an unknown task ID'],
    ]) {
      assert.equal(
        await resolveWorkerTarget(store.gateway.harness, id, record.taskId, context),
        undefined,
        `${label} must not resolve this worker`,
      );
    }

    // A record forged into another chat does not resolve: the native task belongs here, not there.
    await store.gateway.harness.commit(async (tx) => {
      const doc = await tx.doc(WorkerRecordsDoc, other.id);
      doc.workers.push({ ...record, requestId: 'forged-cross-spawner' });
    }, context);
    assert.equal(await resolveWorkerTarget(store.gateway.harness, other.id, record.taskId, context), undefined);

    // A worker record whose child conversation is not owned by that task is refused.
    await store.gateway.harness.commit(async (tx) => {
      const doc = await tx.doc(WorkerRecordsDoc, conversation.id);
      const stored = doc.workers.find((candidate) => candidate.taskId === record.taskId);
      stored.conversationId = raw.id;
    }, context);
    assert.equal(await resolveWorkerTarget(store.gateway.harness, conversation.id, record.taskId, context), undefined);

    // A record that survives but whose native task kind is not a worker task is refused.
    const tasks = await store.gateway.harness.commit(async (tx) =>
      (await tx.scanTasks({ conversationId: conversation.id }, 200)).items, context);
    const foreign = tasks.find((task) => task.kind !== WORKER_TASK_NAME);
    assert.ok(foreign, 'the parent holds at least one tool task');
    await store.gateway.harness.commit(async (tx) => {
      const doc = await tx.doc(WorkerRecordsDoc, conversation.id);
      const stored = doc.workers.find((candidate) => candidate.taskId === record.taskId);
      stored.conversationId = record.conversationId;
      stored.taskId = Number(foreign.id);
    }, context);
    assert.equal(await resolveWorkerTarget(store.gateway.harness, conversation.id, Number(foreign.id), context), undefined);

    // The tool path maps an unresolved worker to an ordinary not-found answer, not a leak.
    const missing = await conversation.submit({ type: 'input', content: 'read transcript worker 999999 limit 2', requestId: 'read-missing' }, context);
    assert.equal((await missing.wait(context)).status, 'done');
    const missingText = (await toolResultFor(conversation, 'read-transcript-worker-999999-limit-2')).text;
    assert.match(missingText, /No worker 999999 in this conversation/);
  } finally {
    await store.gateway.close(context);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('the transcript action handles an unstarted worker and rejects bad bounds without touching a task', { timeout: 10_000 }, async () => {
  const calls = [];
  const view = {
    taskId: 7,
    status: 'queued',
    prompt: 'unstarted bounded task',
    workspaceMode: 'shared',
    createdAtMs: 0,
    finishedAtMs: null,
    result: null,
    error: null,
    conversationId: null,
    workspacePath: null,
    branch: null,
    baseCommit: null,
  };
  let answer;
  const foundation = {
    async start() { throw new Error('start must not be called'); },
    async list() { return []; },
    async inspect() { return undefined; },
    async cancel() { return 'not_found'; },
    async recover() { return 0; },
    async record() { return undefined; },
    async transcript(_harness, _conversationId, _taskId, query) {
      calls.push(query);
      return answer;
    },
  };
  const tool = createWorkerTool({
    foundation,
    spawnerFor: () => true,
    harness: () => ({}),
    precheckWorktree: async () => undefined,
  }).extension.tools[0];
  const api = { conversationId: 9, taskId: 71, callId: 'call', commit: async (change) => change({}) };
  const output = (result) => (result.output ?? []).map((part) => part.text ?? '').join('');

  answer = { worker: view, targetConversationId: null, items: [], nextBefore: null };
  const unstarted = await tool.execute({ action: 'transcript', worker_id: 7 }, api, context);
  assert.equal(unstarted.isError, undefined);
  assert.match(output(unstarted), /has not started a transcript/);
  assert.match(output(unstarted), /No transcript entries yet/);
  assert.deepEqual(calls.at(-1), { limit: 20 }, 'the default page is bounded at 20 entries');

  answer = {
    worker: { ...view, status: 'completed', conversationId: 12 },
    targetConversationId: 12,
    items: [],
    nextBefore: null,
  };
  calls.length = 0;
  const empty = await tool.execute({ action: 'transcript', worker_id: 7, before: 4, limit: 3 }, api, context);
  assert.equal(empty.isError, undefined);
  assert.match(output(empty), /No committed entries older than that boundary/);
  assert.deepEqual(calls.at(-1), { before: 4, limit: 3 });

  answer = undefined;
  const missing = await tool.execute({ action: 'transcript', worker_id: 77 }, api, context);
  assert.equal(missing.isError, true);
  assert.match(output(missing), /No worker 77 in this conversation/);

  for (const [args, pattern] of [
    [{ action: 'transcript' }, /requires worker_id/],
    [{ action: 'transcript', worker_id: 7, limit: 0 }, /limit must be an integer from 1 to 20/],
    [{ action: 'transcript', worker_id: 7, limit: 21 }, /limit must be an integer from 1 to 20/],
    [{ action: 'transcript', worker_id: 7, before: 0 }, /before must be a positive entry ID/],
  ]) {
    const rejected = await tool.execute(args, api, context);
    assert.equal(rejected.isError, true, `${JSON.stringify(args)} must be rejected`);
    assert.match(output(rejected), pattern);
  }

  // Existing actions keep their shape: a fake foundation is enough; no task is created or mutated.
  assert.equal((await tool.execute({ action: 'list' }, api, context)).isError, undefined);
  assert.equal((await tool.execute({ action: 'inspect', worker_id: 7 }, api, context)).isError, true);
});

test('steering a live worker at a tool round changes its final answer', { timeout: 30_000 }, async () => {
  const fixture = await fixtureWorkspace();
  const childStarted = deferred();
  const releaseChild = deferred();
  let gated = false;
  const issued = new Set();
  const store = await syntheticStore(fixture, async (transcript) => {
    const input = lastUserText(transcript.messages);
    if (input.includes('Background worker task.') || input.includes('[internal steering message for worker ')) {
      if (!gated) {
        gated = true;
        childStarted.resolve();
        await releaseChild.promise;
      }
      if (!transcriptText(transcript.messages).includes('STEER-MARKER')) {
        return fauxAssistantMessage([
          fauxToolCall('read', { path: 'note.txt' }, { id: 'child-read' }),
        ], { stopReason: 'toolUse' });
      }
      return fauxAssistantMessage('CHILD-STEERED-ANSWER');
    }
    if (input.includes('[internal worker result]')) return fauxAssistantMessage('noted');
    if (input === 'spawn steered worker' && !issued.has(input)) {
      issued.add(input);
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, {
          action: 'start',
          task: 'STEER-TASK read note.txt and report the steered direction',
          workspace_mode: 'shared',
        }, { id: 'steer-start' }),
      ], { stopReason: 'toolUse' });
    }
    if (input.startsWith('steer worker ') && !issued.has(input)) {
      issued.add(input);
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, {
          action: 'steer',
          worker_id: Number(input.split(' ')[2]),
          message: 'STEER-MARKER: report the steered direction instead.',
        }, { id: 'parent-steer-call' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('ok');
  });
  let resultWatcher;
  try {
    const conversation = await store.gateway.conversationFor(ORIGIN, context);
    resultWatcher = workerResultWatcher(store.gateway.harness, conversation.id, 'the steered worker result');
    const first = await conversation.submit({ type: 'input', content: 'spawn steered worker', requestId: 'spawn' }, context);
    assert.equal((await first.wait(context)).status, 'done');
    await within(childStarted.promise, WAIT_MS, 'the worker never reached its first model request');
    const record = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers[0];

    // The child model request is still in flight: the steer is admitted into that live run and is
    // placed at the tool round boundary that follows it, before the next generation.
    const steerTurn = await conversation.submit({
      type: 'input', content: `steer worker ${record.taskId}`, requestId: 'steer',
    }, context);
    assert.equal((await steerTurn.wait(context)).status, 'done');
    const parentEntries = (await conversation.entries({ order: 'ascending' }, 200, undefined, context)).items;
    const steerResult = parentEntries.filter((entry) => entry.model?.[0]?.role === 'toolResult')
      .map((entry) => entry.model[0]).find((message) => message.toolCallId === 'parent-steer-call');
    assert.ok(steerResult, 'the steer action must reach a tool result');
    assert.equal(steerResult.isError ?? false, false);
    assert.match(messageText(steerResult), /Steering message accepted for worker \d+/);
    const accepted = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers[0];
    assert.equal(accepted.steers.length, 1, 'the admission is recorded before the run continues');
    assert.equal(accepted.steers[0].sourceTaskId > 0, true);

    releaseChild.resolve();
    const publication = await within(resultWatcher.promise, WAIT_MS, 'the steered worker never reported');
    const resultEntry = workerResultEntry(publication, conversation.id);
    assert.equal(resultEntry.data.status, 'completed');
    const body = messageText(resultEntry.model?.[0]);
    assert.match(body, /CHILD-STEERED-ANSWER/);
    assert.match(body, /Steering messages accepted while live: 1/);

    const resultEntries = (await conversation.entries({ order: 'ascending' }, 300, undefined, context)).items
      .filter((entry) => entry.kind === WORKER_RESULT_ENTRY_KIND);
    assert.equal(resultEntries.length, 1, 'exactly one result event for the worker');
    const child = await store.gateway.harness.conversation(record.conversationId, context);
    const childEntries = (await child.entries({ order: 'ascending' }, 200, undefined, context)).items;
    const steerEntry = childEntries.find((entry) => entry.kind === WORKER_STEER_ENTRY_KIND);
    assert.ok(steerEntry, 'the steer is a native committed entry in the worker transcript');
    assert.equal(steerEntry.data.source, 'spawning-assistant');
    assert.match(messageText(steerEntry.model?.[0]), /STEER-MARKER/);
    const readResult = childEntries.find((entry) => entry.model?.[0]?.role === 'toolResult'
      && entry.model[0].toolName === 'read');
    assert.ok(readResult, 'the worker kept its captured read tool');
    assert.match(JSON.stringify(readResult.model), /WORKER-NOTE-CONTENT/);

    const finished = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers[0];
    assert.equal(finished.status, 'completed');
    assert.equal(finished.result, 'CHILD-STEERED-ANSWER');
    assert.equal(finished.steers.length, 1);
    const names = ((await child.agent(context)).tools ?? [])
      .map((tool) => (typeof tool === 'string' ? tool : tool.name));
    assert.deepEqual(names, [], 'the completed worker keeps no tools');
  } finally {
    releaseChild.resolve();
    resultWatcher?.stop();
    await store.gateway.close(context);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('a steer that loses the final-answer boundary is joined into the same worker outcome', { timeout: 30_000 }, async () => {
  const fixture = await fixtureWorkspace();
  const childStarted = deferred();
  const releaseChild = deferred();
  let firstAnswer = false;
  let steeredRead = false;
  const issued = new Set();
  const store = await syntheticStore(fixture, async (transcript) => {
    const input = lastUserText(transcript.messages);
    if (input.includes('Background worker task.') || input.includes('[internal steering message for worker ')) {
      if (!firstAnswer) {
        firstAnswer = true;
        childStarted.resolve();
        await releaseChild.promise;
        return fauxAssistantMessage('FIRST-ANSWER');
      }
      if (!steeredRead) {
        steeredRead = true;
        return fauxAssistantMessage([
          fauxToolCall('read', { path: 'note.txt' }, { id: 'steered-read' }),
        ], { stopReason: 'toolUse' });
      }
      return fauxAssistantMessage('STEERED-ANSWER');
    }
    if (input.includes('[internal worker result]')) return fauxAssistantMessage('noted');
    if (input === 'spawn racing worker' && !issued.has(input)) {
      issued.add(input);
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, {
          action: 'start',
          task: 'RACE-TASK answer first, then follow any steering message',
          workspace_mode: 'shared',
        }, { id: 'race-start' }),
      ], { stopReason: 'toolUse' });
    }
    if (input.startsWith('steer worker ') && !issued.has(input)) {
      issued.add(input);
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, {
          action: 'steer',
          worker_id: Number(input.split(' ')[2]),
          message: 'STEER-MARKER: answer STEERED-ANSWER instead.',
        }, { id: 'race-steer-call' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('ok');
  });
  let resultWatcher;
  try {
    const conversation = await store.gateway.conversationFor(ORIGIN, context);
    resultWatcher = workerResultWatcher(store.gateway.harness, conversation.id, 'the joined worker result');
    const first = await conversation.submit({ type: 'input', content: 'spawn racing worker', requestId: 'spawn' }, context);
    assert.equal((await first.wait(context)).status, 'done');
    await within(childStarted.promise, WAIT_MS, 'the worker never reached its final answer request');
    const record = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers[0];

    // The steer is admitted during the final generation. That generation's final boundary places it
    // as the next run's first input; the worker must join that run instead of finishing and leaving
    // an orphan turn under retired tools.
    const steerTurn = await conversation.submit({
      type: 'input', content: `steer worker ${record.taskId}`, requestId: 'steer',
    }, context);
    assert.equal((await steerTurn.wait(context)).status, 'done');
    releaseChild.resolve();
    const publication = await within(resultWatcher.promise, WAIT_MS, 'the joined worker never reported');
    const resultEntry = workerResultEntry(publication, conversation.id);
    assert.equal(resultEntry.data.status, 'completed');
    const body = messageText(resultEntry.model?.[0]);
    assert.match(body, /STEERED-ANSWER/);
    assert.doesNotMatch(body, /FIRST-ANSWER/);
    const resultEntries = (await conversation.entries({ order: 'ascending' }, 300, undefined, context)).items
      .filter((entry) => entry.kind === WORKER_RESULT_ENTRY_KIND);
    assert.equal(resultEntries.length, 1, 'exactly one outcome for the whole worker task');

    const child = await store.gateway.harness.conversation(record.conversationId, context);
    const childEntries = (await child.entries({ order: 'ascending' }, 200, undefined, context)).items;
    const steerEntry = childEntries.find((entry) => entry.kind === WORKER_STEER_ENTRY_KIND);
    const readResult = childEntries.find((entry) => entry.model?.[0]?.role === 'toolResult'
      && entry.model[0].toolName === 'read');
    assert.ok(steerEntry && readResult);
    assert.ok(readResult.id > steerEntry.id, 'the joined successor run still had its captured tool');
    assert.match(JSON.stringify(readResult.model), /WORKER-NOTE-CONTENT/);
    const assistantTexts = childEntries.filter((entry) => entry.model?.[0]?.role === 'assistant')
      .map((entry) => messageText(entry.model[0]));
    assert.ok(assistantTexts.includes('FIRST-ANSWER'));
    assert.ok(assistantTexts.includes('STEERED-ANSWER'));

    const finished = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers[0];
    assert.equal(finished.status, 'completed');
    assert.equal(finished.result, 'STEERED-ANSWER');
    assert.equal(finished.steers.length, 1);
    const inspection = await store.gateway.harness.inspect(context);
    assert.equal(inspection.tasks.every((entry) => entry.record.conversationId !== record.conversationId
      || entry.record.state.status === 'terminal'), true, 'no orphan child work remains');
    const names = ((await child.agent(context)).tools ?? [])
      .map((tool) => (typeof tool === 'string' ? tool : tool.name));
    assert.deepEqual(names, [], 'the completed worker keeps no tools');
  } finally {
    releaseChild.resolve();
    resultWatcher?.stop();
    await store.gateway.close(context);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('steering dedupes on the host tool-task identity and refuses terminal or foreign workers', { timeout: 30_000 }, async () => {
  const fixture = await fixtureWorkspace();
  const childStarted = deferred();
  const releaseChild = deferred();
  let gated = false;
  const issued = new Set();
  const store = await syntheticStore(fixture, async (transcript) => {
    const input = lastUserText(transcript.messages);
    if (input.includes('Background worker task.') || input.includes('[internal steering message for worker ')) {
      if (!gated) {
        gated = true;
        childStarted.resolve();
        await releaseChild.promise;
      }
      return fauxAssistantMessage('CHILD-AFTER-STEERS');
    }
    if (input.includes('[internal worker result]')) return fauxAssistantMessage('noted');
    if (input === 'spawn dedupe worker' && !issued.has(input)) {
      issued.add(input);
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, {
          action: 'start',
          task: 'DEDUPE-TASK accept two distinct steering directions',
          workspace_mode: 'shared',
        }, { id: 'dedupe-start' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('ok');
  });
  let resultWatcher;
  try {
    const conversation = await store.gateway.conversationFor(ORIGIN, context);
    resultWatcher = workerResultWatcher(store.gateway.harness, conversation.id, 'the dedupe worker result');
    const first = await conversation.submit({ type: 'input', content: 'spawn dedupe worker', requestId: 'spawn' }, context);
    assert.equal((await first.wait(context)).status, 'done');
    await within(childStarted.promise, WAIT_MS, 'the worker never reached its first model request');
    const record = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers[0];
    const tool = ((await conversation.agent(context)).tools ?? [])
      .find((candidate) => (typeof candidate === 'string' ? candidate : candidate.name) === WORKER_TOOL_NAME);
    assert.ok(tool, 'the mapped chat is offered the worker tool');
    // Provider call IDs are not identity: both requests use the same call ID but different host task IDs.
    const api = (taskId) => ({ conversationId: conversation.id, taskId, callId: 'same-provider-call' });
    const firstSteer = await tool.execute({
      action: 'steer', worker_id: record.taskId, message: 'FIRST-DIRECTION',
    }, api(9001), context);
    assert.equal(firstSteer.isError ?? false, false);
    assert.match(toolOutput(firstSteer), /Steering message accepted/);
    const replay = await tool.execute({
      action: 'steer', worker_id: record.taskId, message: 'FIRST-DIRECTION',
    }, api(9001), context);
    assert.equal(replay.isError ?? false, false);
    assert.match(toolOutput(replay), /already accepted/);
    // The same host tool-task identity with a different payload is refused, not silently deduped.
    const changed = await tool.execute({
      action: 'steer', worker_id: record.taskId, message: 'CHANGED-DIRECTION',
    }, api(9001), context);
    assert.equal(changed.isError, true);
    assert.match(toolOutput(changed), /different text/);
    const afterMismatch = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers[0];
    assert.equal(afterMismatch.steers.length, 1, 'a changed payload added no steering request');
    const inboxAfterMismatch = await store.gateway.harness.snapshot(InboxDoc, record.conversationId, context);
    assert.equal((inboxAfterMismatch?.items ?? []).filter((item) => item.mode === 'steer').length, 1,
      'a changed payload added no second inbox item');
    const secondSteer = await tool.execute({
      action: 'steer', worker_id: record.taskId, message: 'SECOND-DIRECTION',
    }, api(9002), context);
    assert.equal(secondSteer.isError ?? false, false);
    assert.match(toolOutput(secondSteer), /Steering message accepted/);

    const empty = await tool.execute({
      action: 'steer', worker_id: record.taskId, message: '   ',
    }, api(9005), context);
    assert.equal(empty.isError, true);
    assert.match(toolOutput(empty), /requires a non-empty message/);
    const tooLong = await tool.execute({
      action: 'steer', worker_id: record.taskId, message: 'x'.repeat(2_001),
    }, api(9006), context);
    assert.equal(tooLong.isError, true);
    assert.match(toolOutput(tooLong), /longer than 2000 characters/);
    const accepted = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers[0];
    assert.equal(accepted.steers.length, 2, 'the replay added no third request');
    assert.deepEqual(accepted.steers.map((steer) => steer.sourceTaskId), [9001, 9002]);
    assert.notEqual(accepted.steers[0].requestId, accepted.steers[1].requestId);
    assert.equal(accepted.steers[0].requestId, workerSteerRequestId(record.taskId, 9001));
    for (const steer of accepted.steers) assert.match(steer.textDigest, /^[0-9a-f]{64}$/);
    assert.notEqual(accepted.steers[0].textDigest, accepted.steers[1].textDigest);
    const inboxAccepted = await store.gateway.harness.snapshot(InboxDoc, record.conversationId, context);
    assert.equal((inboxAccepted?.items ?? []).filter((item) => item.mode === 'steer').length, 2);

    releaseChild.resolve();
    const publication = await within(resultWatcher.promise, WAIT_MS, 'the steered worker never reported');
    const resultEntry = workerResultEntry(publication, conversation.id);
    assert.equal(resultEntry.data.status, 'completed');
    assert.match(messageText(resultEntry.model?.[0]), /CHILD-AFTER-STEERS/);
    const resultEntries = (await conversation.entries({ order: 'ascending' }, 300, undefined, context)).items
      .filter((entry) => entry.kind === WORKER_RESULT_ENTRY_KIND);
    assert.equal(resultEntries.length, 1);

    const child = await store.gateway.harness.conversation(record.conversationId, context);
    const before = (await child.entries({ order: 'ascending' }, 300, undefined, context)).items;
    const late = await tool.execute({
      action: 'steer', worker_id: record.taskId, message: 'TOO-LATE',
    }, api(9003), context);
    assert.equal(late.isError, true);
    assert.match(toolOutput(late), /already finished/);
    const other = await store.gateway.conversationFor(ELSEWHERE, context);
    const otherTool = ((await other.agent(context)).tools ?? [])
      .find((candidate) => (typeof candidate === 'string' ? candidate : candidate.name) === WORKER_TOOL_NAME);
    const foreign = await otherTool.execute({
      action: 'steer', worker_id: record.taskId, message: 'FOREIGN',
    }, { conversationId: other.id, taskId: 9004, callId: 'same-provider-call' }, context);
    assert.equal(foreign.isError, true);
    assert.match(toolOutput(foreign), /No worker \d+ in this conversation/);

    const after = (await child.entries({ order: 'ascending' }, 300, undefined, context)).items;
    assert.equal(after.length, before.length, 'terminal and foreign steering wrote nothing');
    const finished = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers[0];
    assert.equal(finished.steers.length, 2);
    assert.equal(finished.status, 'completed');
  } finally {
    releaseChild.resolve();
    resultWatcher?.stop();
    await store.gateway.close(context);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('cancelling a worker with an accepted steer withdraws the queued message instead of orphaning a turn', { timeout: 30_000 }, async () => {
  const fixture = await fixtureWorkspace();
  const childStarted = deferred();
  const releaseChild = deferred();
  let gated = false;
  const issued = new Set();
  const store = await syntheticStore(fixture, async (transcript, options) => {
    const input = lastUserText(transcript.messages);
    if (input.includes('Background worker task.') || input.includes('[internal steering message for worker ')) {
      if (!gated) {
        gated = true;
        childStarted.resolve();
        await new Promise((resolve) => {
          const signal = options?.signal;
          if (signal?.aborted) return resolve();
          signal?.addEventListener('abort', () => resolve(), { once: true });
          releaseChild.promise.then(() => resolve());
        });
      }
      return fauxAssistantMessage('LATE-CANCELLED-ANSWER');
    }
    if (input.includes('[internal worker result]')) return fauxAssistantMessage('noted');
    if (input === 'spawn cancel-steer worker' && !issued.has(input)) {
      issued.add(input);
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, {
          action: 'start',
          task: 'CANCEL-STEER-TASK wait while a steer is accepted',
          workspace_mode: 'shared',
        }, { id: 'cancel-steer-start' }),
      ], { stopReason: 'toolUse' });
    }
    if (input.startsWith('steer worker ') && !issued.has(input)) {
      issued.add(input);
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, {
          action: 'steer',
          worker_id: Number(input.split(' ')[2]),
          message: 'STEER-BEFORE-CANCEL',
        }, { id: 'cancel-steer-call' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('ok');
  });
  let resultWatcher;
  try {
    const conversation = await store.gateway.conversationFor(ORIGIN, context);
    resultWatcher = workerResultWatcher(store.gateway.harness, conversation.id, 'the cancelled worker result');
    const first = await conversation.submit({ type: 'input', content: 'spawn cancel-steer worker', requestId: 'spawn' }, context);
    assert.equal((await first.wait(context)).status, 'done');
    await within(childStarted.promise, WAIT_MS, 'the worker never reached its first model request');
    const record = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers[0];

    const steerTurn = await conversation.submit({
      type: 'input', content: `steer worker ${record.taskId}`, requestId: 'steer',
    }, context);
    assert.equal((await steerTurn.wait(context)).status, 'done');
    assert.equal(
      (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers[0].steers.length,
      1,
    );

    // Cancel while the child model request still holds the run: the queued steer belongs to a live
    // worker, so cancellation must withdraw it rather than let it start a turn after retirement.
    await store.gateway.harness.abortTask(record.taskId, context);
    const publication = await within(resultWatcher.promise, WAIT_MS, 'the cancelled worker never reported');
    const resultEntry = workerResultEntry(publication, conversation.id);
    assert.equal(resultEntry.data.status, 'aborted');
    const body = messageText(resultEntry.model?.[0]);
    assert.match(body, /was cancelled/);
    assert.doesNotMatch(body, /LATE-CANCELLED-ANSWER/);

    const inbox = await store.gateway.harness.snapshot(InboxDoc, record.conversationId, context);
    assert.equal((inbox?.items ?? []).some((item) => item.mode === 'steer'), false,
      'the accepted steer was withdrawn from the inbox');

    releaseChild.resolve();
    await waitFor(async () => {
      const inspection = await store.gateway.harness.inspect(context);
      return inspection.tasks.every((entry) => entry.record.conversationId !== record.conversationId
        || entry.record.state.status === 'terminal');
    }, 'the cancelled child work to settle');
    const resultEntries = (await conversation.entries({ order: 'ascending' }, 300, undefined, context)).items
      .filter((entry) => entry.kind === WORKER_RESULT_ENTRY_KIND);
    assert.equal(resultEntries.length, 1, 'one cancellation event, no orphan result');
    const child = await store.gateway.harness.conversation(record.conversationId, context);
    const childEntries = (await child.entries({ order: 'ascending' }, 300, undefined, context)).items;
    assert.equal(childEntries.some((entry) => entry.kind === WORKER_STEER_ENTRY_KIND), false,
      'the withdrawn steer was never placed into the child transcript');
    const names = ((await child.agent(context)).tools ?? [])
      .map((tool) => (typeof tool === 'string' ? tool : tool.name));
    assert.deepEqual(names, [], 'the cancelled worker keeps no tools');
    const finished = (await store.gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context)).workers[0];
    assert.equal(finished.status, 'aborted');
    assert.equal(finished.steers.length, 1, 'the accepted request stays visible for inspection');
  } finally {
    releaseChild.resolve();
    resultWatcher?.stop();
    await store.gateway.close(context);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
