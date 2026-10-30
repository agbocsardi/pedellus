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
  { WORKER_RESULT_ENTRY_KIND, WORKER_TASK_NAME, WorkerRecordsDoc, workerResultRequestId },
  { WORKER_TOOL_NAME, createWorkerTool },
  { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall },
  { BACKGROUND_CONTEXT },
  { AgentDoc },
  { ConfigToolCaptureDoc },
  { CODEMODE_TOOL_NAME },
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
  assert.throws(() => parseConfig({ ...base, workers: { enabled: true, queue: true } }, '/'), /Unknown workers field: queue/);
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
    const stop = store.gateway.harness.subscribeCommits((publication) => {
      for (const change of publication.changes) {
        if (change.type === 'entry' && change.value.conversationId === conversation.id
          && change.value.kind === WORKER_RESULT_ENTRY_KIND) results.push(change.value);
      }
    });
    try {
      for (const message of ['spawn shared', 'spawn worktree']) {
        const submission = await conversation.submit({ type: 'input', content: message, requestId: message }, context);
        assert.equal((await submission.wait(context)).status, 'done');
      }
      await within((async () => {
        while (results.length < 2) await new Promise((resolve) => setTimeout(resolve, 25));
      })(), WAIT_MS, 'both workers never reported');
    } finally {
      stop();
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
    stop = store.gateway.harness.subscribeCommits((publication) => {
      for (const change of publication.changes) {
        if (change.type === 'entry' && change.value.conversationId === conversation.id
          && change.value.kind === WORKER_RESULT_ENTRY_KIND) results.push(change.value);
      }
    });
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
    stop?.();
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
    // The child inherits configured coding tools only: no worker tool, no cron, no history, no channel.
    assert.ok(childTools.includes('read'), `the captured ceiling still applies: ${childTools}`);
    for (const forbidden of [WORKER_TOOL_NAME, 'cron', 'history', 'telegram']) {
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

  const first = await syntheticStore(fixture, dispatcher);
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
    }, fixture.directory);
    const faux = fauxProvider({ provider: 'worker-fixture', models: [{ id: 'synthetic', name: 'Synthetic' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses(Array.from({ length: 40 }, () => dispatcher));
    reopened = await openGateway(config, context, { models });
    const child = await reopened.harness.conversation(childConversationId, context);
    assert.ok(child, 'the live worker target survives the reopen');
    const names = (await child.agent(context)).tools?.map((tool) => (tool && typeof tool === 'object' ? tool.name : tool)) ?? [];
    assert.equal(names.includes('read'), false, `a removed tool must not survive the reopen: ${names}`);
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
    for (const forbidden of [WORKER_TOOL_NAME, CODEMODE_TOOL_NAME, 'cron', 'history', 'telegram']) {
      assert.equal(childTools.includes(forbidden), false, `Code Mode composition must not widen the child: ${forbidden}`);
    }
  } finally {
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
