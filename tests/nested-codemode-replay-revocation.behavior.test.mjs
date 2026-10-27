import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const testRoot = fileURLToPath(new URL('../', import.meta.url));
const packageRoot = process.env.PI_CODEMODE_REPLAY_CANDIDATE ?? testRoot;
const modules = join(packageRoot, 'node_modules/@earendil-works');
const fixtures = join(testRoot, 'tests/fixtures');
const [chord, ai, durable, sqlite, nativeCodeMode, nativeSearch, integrationModule] = await Promise.all([
  import(pathToFileURL(join(modules, 'chord/dist/context/index.js')).href),
  import(pathToFileURL(join(modules, 'pi-ai/dist/index.js')).href),
  import(pathToFileURL(join(modules, 'pi-durable/dist/index.js')).href),
  import(pathToFileURL(join(modules, 'pi-durable/dist/storage/sqlite/node.js')).href),
  import(pathToFileURL(join(modules, 'pi-durable/dist/codemode/index.js')).href),
  import(pathToFileURL(join(modules, 'pi-durable/dist/tool-search/index.js')).href),
  import(pathToFileURL(join(packageRoot, 'dist/extensions/codemode.js')).href),
]);

const { BACKGROUND_CONTEXT: context } = chord;
const { createModels, fauxAssistantMessage, fauxProvider, fauxText, Type } = ai;
const { Harness, ToolResultEntry, createRegistry, defineExtension, defineTool } = durable;
const { openNodeSqliteStorage } = sqlite;
const { CODEMODE_TOOL_NAME } = nativeCodeMode;
const { TOOL_SEARCH_TOOL_NAME } = nativeSearch;
const { createCodeModeIntegration } = integrationModule;

const within = (promise, ms, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  promise.then(
    (value) => { clearTimeout(timer); resolve(value); },
    (error) => { clearTimeout(timer); reject(error); },
  );
});

const count = (lines, label) => lines.filter((line) => line === label).length;

test('SIGKILL mid-nested Code Mode: revoked host grant never reruns, explicit safe grant replays, unsafe downgrade stays interrupted', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-nested-codemode-replay-'));
  const effects = join(directory, 'effects.log');
  const stateFile = join(directory, 'state.json');
  let child;
  let childExit;
  let harness;
  let integration;
  let stderr = '';
  try {
    child = spawn(process.execPath, [
      '--max-old-space-size=256',
      join(fixtures, 'nested-codemode-replay-child.mjs'),
      directory,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Keep the child synthetic: no inherited API keys or other host credentials.
      env: {
        HOME: directory,
        TMPDIR: directory,
        PATH: process.env.PATH ?? '',
        PI_CODEMODE_REPLAY_CANDIDATE: packageRoot,
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
    }), 30_000, 'child readiness');

    assert.equal(child.kill('SIGKILL'), true);
    assert.deepEqual(await within(childExit, 10_000, 'SIGKILL exit'), { code: null, signal: 'SIGKILL' });
    child = undefined;

    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    const before = (await readFile(effects, 'utf8')).trim().split('\n').filter(Boolean);
    assert.deepEqual([...before].sort(), [
      'nested_downgraded_effect:downgraded',
      'nested_granted_effect:granted',
      'nested_revoked_effect:revoked',
    ]);

    // Parent-side fake nested implementations: each effect appends once when its body runs.
    const sequences = new Map();
    const synthetic = (name, replay = 'safe') => defineTool({
      name,
      description: `Synthetic ${name} for nested Code Mode restart replay verification`,
      parameters: Type.Object({ label: Type.String() }),
      structuredOutputSchema: Type.Object({ label: Type.String(), sequence: Type.Number() }),
      callers: ['tools'],
      replay,
      execute: async ({ label }) => {
        await appendFile(effects, `${name}:${label}\n`);
        const sequence = (sequences.get(name) ?? 0) + 1;
        sequences.set(name, sequence);
        return { structuredOutput: { label, sequence } };
      },
    });
    const revokedTool = synthetic('nested_revoked_effect');
    const grantedTool = synthetic('nested_granted_effect');
    // Persisted Code Mode/nested intent says safe; the current registration says unsafe. Recovery must not rerun.
    const downgradedTool = synthetic('nested_downgraded_effect', 'unsafe');
    // Issued only after the granted nested effect resolves, so it was still pending at SIGKILL.
    const pendingTool = synthetic('nested_pending_effect');
    const extension = defineExtension({
      name: 'nested-tool-replay-synthetic',
      tools: [revokedTool, grantedTool, downgradedTool, pendingTool],
    });
    integration = createCodeModeIntegration();
    const registry = createRegistry();
    for (const installed of integration.extensions) registry.install(installed);
    registry.install(extension);
    const registered = new Map(registry.snapshot().tools().map(({ tool }) => [tool.name, tool]));
    const codemode = registered.get(CODEMODE_TOOL_NAME);
    const toolSearch = registered.get(TOOL_SEARCH_TOOL_NAME);
    assert.ok(codemode && toolSearch, 'native Code Mode and tool search registrations');

    const faux = fauxProvider();
    faux.setResponses(Array.from({ length: 4 }, () => () =>
      fauxAssistantMessage([fauxText('nested recovery settled without another effect round')])));
    const models = createModels();
    models.setProvider(faux.provider);

    harness = await Harness.open(await openNodeSqliteStorage(join(directory, 'state.sqlite')), {
      models,
      registry,
      settings: { extensions: [] },
    }, context);
    const mixed = await harness.conversation(state.mixed.conversation, context);
    const granted = await harness.conversation(state.granted.conversation, context);
    assert.ok(mixed && granted, 'both conversations reopen');

    const extensions = [...integration.extensions, extension];
    // Revoke the host grant for the revoked nested effect before scheduling resumes,
    // while keeping the downgraded nested grant. Native Code Mode may replay its
    // script, but the canceled nested task must resolve no current tool and the
    // stored-safe/current-unsafe nested task must not rerun.
    await mixed.configure({
      extensions,
      tools: [codemode, toolSearch, downgradedTool],
      modelTools: [codemode, toolSearch],
    }, context);
    const mixedAgent = await mixed.agent(context);
    assert.ok(mixedAgent.tools.some((tool) => tool.name === CODEMODE_TOOL_NAME));
    assert.ok(!mixedAgent.callable.some((tool) => tool.name === 'nested_revoked_effect'));
    assert.ok(mixedAgent.callable.some((tool) => tool.name === 'nested_downgraded_effect'));
    assert.equal(downgradedTool.replay, 'unsafe');
    const afterRevocation = (await readFile(effects, 'utf8')).trim().split('\n').filter(Boolean);
    assert.deepEqual([...afterRevocation].sort(), [...before].sort(), 'revocation itself executes nothing');

    // Positive case: the explicit nested grant remains, so Code Mode's safe replay reruns the nested body once.
    // The pending nested tool's grant is revoked before the replayed script reaches its second call.
    const grantedAgent = await granted.agent(context);
    assert.ok(grantedAgent.callable.some((tool) => tool.name === 'nested_granted_effect'));
    assert.ok(grantedAgent.callable.some((tool) => tool.name === 'nested_pending_effect'));
    assert.equal(pendingTool.replay, 'safe');
    await granted.configure({
      extensions,
      tools: [codemode, toolSearch, grantedTool],
      modelTools: [codemode, toolSearch],
    }, context);
    const reconfiguredGranted = await granted.agent(context);
    assert.ok(reconfiguredGranted.callable.some((tool) => tool.name === 'nested_granted_effect'));
    assert.ok(!reconfiguredGranted.callable.some((tool) => tool.name === 'nested_pending_effect'));

    harness.resume();
    const settled = await within(Promise.all([
      (await harness.submission(state.mixed.submission, context))?.wait(context),
      (await harness.submission(state.granted.submission, context))?.wait(context),
    ]), 40_000, 'nested restart settlement');
    assert.deepEqual(settled.map((record) => record?.status), ['done', 'done']);

    const toolResults = async (conversation) => {
      const entries = [...(await conversation.entries({}, 1000, undefined, context)).items].reverse();
      return {
        results: entries.filter(ToolResultEntry.is).map((entry) => entry.model[0]),
        entries,
      };
    };
    const assertFinalAnswer = (view) => assert.ok(view.entries.some((entry) => entry.model?.some((message) =>
      message.role === 'assistant' && message.content?.some((part) =>
        part.type === 'text' && part.text === 'nested recovery settled without another effect round'))));
    const nestedCalls = (result) => result.details?.calls?.filter((call) => call.name.startsWith('nested_')) ?? [];

    const mixedView = await toolResults(mixed);
    // The script observes both nested failures through Promise.allSettled.
    assert.deepEqual(mixedView.results.map(({ toolName, isError }) => [toolName, isError]), [
      [CODEMODE_TOOL_NAME, false],
    ]);
    // Both nested tasks were already admitted and checkpointed before SIGKILL, so
    // native recovery reports the interrupted/non-replay outcome for each. The
    // revoked grant is observable as the absence of any current nested tool.
    assert.match(JSON.stringify(mixedView.results[0].content), /interrupted and may have partially run/i);
    const mixedCalls = new Map(nestedCalls(mixedView.results[0]).map((call) => [call.name, call]));
    assert.deepEqual([...mixedCalls.values()].map(({ name, status }) => [name, status]), [
      ['nested_revoked_effect', 'error'],
      ['nested_downgraded_effect', 'error'],
    ]);
    assert.match(mixedCalls.get('nested_revoked_effect').error, /interrupted and may have partially run/i);
    assert.match(mixedCalls.get('nested_downgraded_effect').error, /interrupted and may have partially run/i);
    assertFinalAnswer(mixedView);

    const grantedView = await toolResults(granted);
    assert.deepEqual(grantedView.results.map(({ toolName, isError }) => [toolName, isError]), [
      [CODEMODE_TOOL_NAME, false],
    ]);
    assert.match(JSON.stringify(grantedView.results[0].content), /granted/);
    assert.match(JSON.stringify(grantedView.results[0].content), /not available/i);
    assert.deepEqual(nestedCalls(grantedView.results[0]).map(({ name, status }) => [name, status]), [
      ['nested_granted_effect', 'ok'],
      ['nested_pending_effect', 'error'],
    ]);
    const grantedCalls = new Map(nestedCalls(grantedView.results[0]).map((call) => [call.name, call]));
    assert.match(grantedCalls.get('nested_pending_effect').error, /not available/i);
    assertFinalAnswer(grantedView);

    const after = (await readFile(effects, 'utf8')).trim().split('\n').filter(Boolean);
    assert.equal(count(after, 'nested_revoked_effect:revoked'), 1, 'revoked nested body never executes after revocation');
    assert.equal(count(after, 'nested_granted_effect:granted'), 2, 'explicitly granted safe nested body reruns once');
    assert.equal(count(after, 'nested_downgraded_effect:downgraded'), 1, 'unsafe nested downgrade must not rerun');
    assert.equal(count(after, 'nested_pending_effect:pending'), 0, 'pending revoked nested body never executes');
    assert.deepEqual(after, [...before, 'nested_granted_effect:granted']);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      if (childExit) await within(childExit, 5_000, 'cleanup child exit').catch(() => {});
    }
    try {
      if (harness) await harness.close(context);
    } finally {
      if (integration) {
        integration.stopAdmission();
        await integration.close();
      }
      await rm(directory, { recursive: true, force: true });
    }
  }
});
