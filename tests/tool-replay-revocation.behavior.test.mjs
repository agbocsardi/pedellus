import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const packageRoot = process.env.PI_TOOL_REPLAY_CANDIDATE
  ?? fileURLToPath(new URL('../', import.meta.url));
const modules = join(packageRoot, 'node_modules/@earendil-works');
const fixtures = join(packageRoot, 'tests/fixtures');
const [{ BACKGROUND_CONTEXT: context }, ai, durable, sqlite] = await Promise.all([
  import(pathToFileURL(join(modules, 'chord/dist/context/index.js')).href),
  import(pathToFileURL(join(modules, 'pi-ai/dist/index.js')).href),
  import(pathToFileURL(join(modules, 'pi-durable/dist/index.js')).href),
  import(pathToFileURL(join(modules, 'pi-durable/dist/storage/sqlite/node.js')).href),
]);

const { createModels, fauxAssistantMessage, fauxProvider, fauxText, Type } = ai;
const { Harness, ToolResultEntry, createRegistry, defineExtension, defineTool } = durable;
const { openNodeSqliteStorage } = sqlite;

const within = (promise, ms, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  promise.then(
    (value) => { clearTimeout(timer); resolve(value); },
    (error) => { clearTimeout(timer); reject(error); },
  );
});

const count = (lines, label) => lines.filter((line) => line === label).length;

test('SIGKILL mid-tool: deselected tool and unsafe downgrade stay interrupted while a selected safe tool replays', { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-tool-replay-'));
  const effects = join(directory, 'effects.log');
  const stateFile = join(directory, 'state.json');
  let child;
  let childExit;
  let harness;
  let stderr = '';
  try {
    child = spawn(process.execPath, [
      '--max-old-space-size=256',
      join(fixtures, 'tool-replay-child.mjs'),
      directory,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Keep the child synthetic: no inherited API keys or other host credentials.
      env: {
        HOME: directory,
        TMPDIR: directory,
        PATH: process.env.PATH ?? '',
        PI_TOOL_REPLAY_CANDIDATE: packageRoot,
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
        if (stdout.includes('READY')) resolve();
      });
      child.once('error', reject);
      void childExit.then((exit) => reject(new Error(`child exited before READY (${JSON.stringify(exit)}): ${stderr}`)));
    }), 20_000, 'child readiness');

    assert.equal(child.kill('SIGKILL'), true);
    assert.deepEqual(await within(childExit, 10_000, 'SIGKILL exit'), { code: null, signal: 'SIGKILL' });
    child = undefined;

    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    const before = (await readFile(effects, 'utf8')).trim().split('\n').filter(Boolean);
    assert.deepEqual([...before].sort(), [
      'downgraded_effect:downgraded',
      'granted_effect:granted',
      'revoked_effect:revoked',
    ]);

    // Parent-side fake implementations: a replay-safe tool appends, then completes.
    const synthetic = (name, replay = 'safe') => defineTool({
      name,
      description: `Synthetic ${name} for restart replay verification`,
      parameters: Type.Object({ label: Type.String() }),
      callers: ['model'],
      replay,
      execute: async ({ label }) => {
        await appendFile(effects, `${name}:${label}\n`);
        return { output: [fauxText(`${name} replayed after an explicit host tool selection`)] };
      },
    });
    const revokedTool = synthetic('revoked_effect');
    const grantedTool = synthetic('granted_effect');
    // Persisted intent says safe; the current registration says unsafe. Recovery must not rerun.
    const downgradedTool = synthetic('downgraded_effect', 'unsafe');
    const extension = defineExtension({
      name: 'tool-replay-synthetic',
      tools: [revokedTool, grantedTool, downgradedTool],
    });
    const registry = createRegistry();
    registry.install(extension);
    const faux = fauxProvider();
    faux.setResponses(Array.from({ length: 4 }, () => () =>
      fauxAssistantMessage('restart settled without another model round')));
    const models = createModels();
    models.setProvider(faux.provider);

    harness = await Harness.open(await openNodeSqliteStorage(join(directory, 'state.sqlite')), {
      models,
      registry,
      settings: { extensions: [] },
    }, context);
    const revoked = await harness.conversation(state.revoked.conversation, context);
    const granted = await harness.conversation(state.granted.conversation, context);
    const downgraded = await harness.conversation(state.downgraded.conversation, context);
    assert.ok(revoked && granted && downgraded, 'all conversations reopen');

    // The tool is deselected from the host configuration before scheduling resumes, so recovery
    // must not re-execute.
    await revoked.configure({ tools: [], modelTools: [] }, context);
    assert.ok(!(await revoked.agent(context)).tools.some((tool) => tool.name === 'revoked_effect'));
    const afterRevocation = (await readFile(effects, 'utf8')).trim().split('\n').filter(Boolean);
    assert.deepEqual([...afterRevocation].sort(), [...before].sort(), 'deselection itself executes nothing');

    // Positive case: the tool stays selected before resume, so the safe call reruns.
    assert.ok((await granted.agent(context)).tools.some((tool) => tool.name === 'granted_effect'));
    await granted.configure({ extensions: [extension], tools: [grantedTool], modelTools: [grantedTool] }, context);

    // The downgraded tool stays selected; only its current replay classification is unsafe.
    assert.ok((await downgraded.agent(context)).tools.some((tool) => tool.name === 'downgraded_effect'));
    assert.equal(downgradedTool.replay, 'unsafe');
    await downgraded.configure({
      extensions: [extension],
      tools: [downgradedTool],
      modelTools: [downgradedTool],
    }, context);

    harness.resume();
    const settled = await within(Promise.all([
      (await harness.submission(state.revoked.submission, context))?.wait(context),
      (await harness.submission(state.granted.submission, context))?.wait(context),
      (await harness.submission(state.downgraded.submission, context))?.wait(context),
    ]), 25_000, 'restart settlement');
    assert.deepEqual(settled.map((record) => record?.status), ['done', 'done', 'done']);

    const toolResults = async (conversation) => {
      const entries = [...(await conversation.entries({}, 1000, undefined, context)).items].reverse();
      return {
        results: entries.filter(ToolResultEntry.is).map((entry) => entry.model[0]),
        entries,
      };
    };
    const assertFinalAnswer = (view) => assert.ok(view.entries.some((entry) => entry.model?.some((message) =>
      message.role === 'assistant' && message.content?.some((part) =>
        part.type === 'text' && part.text === 'restart settled without another model round'))));

    const revokedView = await toolResults(revoked);
    assert.deepEqual(revokedView.results.map(({ toolName, isError }) => [toolName, isError]), [
      ['revoked_effect', true],
    ]);
    assert.match(JSON.stringify(revokedView.results[0].content), /interrupted and may have partially run/);
    assertFinalAnswer(revokedView);

    const grantedView = await toolResults(granted);
    assert.deepEqual(grantedView.results.map(({ toolName, isError }) => [toolName, isError]), [
      ['granted_effect', false],
    ]);
    assert.match(JSON.stringify(grantedView.results[0].content), /replayed after an explicit host tool selection/);
    assertFinalAnswer(grantedView);

    const downgradedView = await toolResults(downgraded);
    assert.deepEqual(downgradedView.results.map(({ toolName, isError }) => [toolName, isError]), [
      ['downgraded_effect', true],
    ]);
    assert.match(JSON.stringify(downgradedView.results[0].content), /interrupted and may have partially run/);
    assertFinalAnswer(downgradedView);

    const after = (await readFile(effects, 'utf8')).trim().split('\n').filter(Boolean);
    assert.equal(count(after, 'revoked_effect:revoked'), 1, 'revoked body never executes after revocation');
    assert.equal(count(after, 'granted_effect:granted'), 2, 'selected safe body reruns once after restart');
    assert.equal(count(after, 'downgraded_effect:downgraded'), 1, 'unsafe downgrade must not rerun the body');
    assert.deepEqual(after, [...before, 'granted_effect:granted']);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      if (childExit) await within(childExit, 5_000, 'cleanup child exit').catch(() => {});
    }
    try {
      if (harness) await harness.close(context);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
