import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const packageRoot = process.env.PI_CODEMODE_CANDIDATE ?? new URL('../', import.meta.url).pathname;
const modules = join(packageRoot, 'node_modules/@earendil-works');
const [chord, ai, durable, sqlite, nativeCodeMode, nativeSearch, integrationModule] = await Promise.all([
  import(join(modules, 'chord/dist/context/index.js')),
  import(join(modules, 'pi-ai/dist/index.js')),
  import(join(modules, 'pi-durable/dist/index.js')),
  import(join(modules, 'pi-durable/dist/storage/sqlite/node.js')),
  import(join(modules, 'pi-durable/dist/codemode/index.js')),
  import(join(modules, 'pi-durable/dist/tool-search/index.js')),
  import(join(packageRoot, 'dist/extensions/codemode.js')),
]);

const { BACKGROUND_CONTEXT } = chord;
const { createModels, fauxAssistantMessage, fauxText, fauxToolCall, fauxProvider, Type } = ai;
const { configure, createRegistry, defineExtension, defineTool, Harness, ToolResultEntry } = durable;
const { openNodeSqliteStorage } = sqlite;
const { CODEMODE_TOOL_NAME } = nativeCodeMode;
const { TOOL_SEARCH_TOOL_NAME } = nativeSearch;
const { createCodeModeIntegration } = integrationModule;
const context = BACKGROUND_CONTEXT;
const model = { provider: 'faux', modelId: 'faux-1' };
const call = (name, args, id) => fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: 'toolUse' });
const final = (text) => fauxAssistantMessage([fauxText(text)]);
const within = (promise, ms = 20_000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`conversation probe exceeded ${ms}ms`)), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});

test('native Code Mode conversation requires exact host grant and is isolated per conversation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-codemode-conversation-'));
  const integration = createCodeModeIntegration();
  let executions = 0;
  const synthetic = defineTool({
    name: 'synthetic_counter',
    description: 'Increment an in-memory synthetic counter and return the requested label',
    parameters: Type.Object({ label: Type.String() }),
    structuredOutputSchema: Type.Object({ label: Type.String(), sequence: Type.Number() }),
    callers: ['tools'],
    replay: 'unsafe',
    execute: async ({ label }) => ({ structuredOutput: { label, sequence: ++executions } }),
  });
  const syntheticExtension = defineExtension({ name: 'synthetic-counter', tools: [synthetic] });
  const registry = createRegistry();
  for (const extension of integration.extensions) registry.install(extension);
  registry.install(syntheticExtension);
  const registrations = new Map(registry.snapshot().tools().map(({ tool }) => [tool.name, tool]));
  const requireTool = (name) => {
    const tool = registrations.get(name);
    assert.ok(tool, `registered tool ${name}`);
    return tool;
  };
  const codemode = requireTool(CODEMODE_TOOL_NAME);
  const toolSearch = requireTool(TOOL_SEARCH_TOOL_NAME);
  const effect = requireTool('synthetic_counter');
  const faux = fauxProvider();
  faux.setResponses([
    call(CODEMODE_TOOL_NAME, {
      code: `const matches = await searchTools('synthetic counter');
        if (!matches.some((tool) => tool.name === 'synthetic_counter')) throw new Error('tool not discoverable');
        return await tools.synthetic_counter({ label: 'approved conversation' });`,
    }, 'approved-code'),
    final('approved final answer'),
    fauxAssistantMessage([
      fauxToolCall(CODEMODE_TOOL_NAME, { code: `return await tools.synthetic_counter({ label: 'denied' });` }, { id: 'denied-code' }),
      fauxToolCall('synthetic_counter', { label: 'denied direct' }, { id: 'denied-direct' }),
      fauxToolCall(TOOL_SEARCH_TOOL_NAME, { query: 'synthetic counter' }, { id: 'denied-search' }),
    ], { stopReason: 'toolUse' }),
    final('ungranted final answer'),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  let harness;
  try {
    harness = await Harness.open(await openNodeSqliteStorage(join(directory, 'sessions.sqlite')), {
      models,
      registry,
      settings: { extensions: [] },
      conversationCreated: (tx, conversation) => configure(tx, conversation.id, {
        extensions: [], tools: [], modelTools: [],
      }),
    }, context);
    const approved = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model } }, context);
    const denied = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model } }, context);
    for (const conversation of [approved, denied]) {
      const agent = await conversation.agent(context);
      assert.deepEqual(agent.extensions, []);
      assert.deepEqual(agent.tools, []);
      assert.deepEqual(agent.callable, []);
      assert.deepEqual(agent.deferred, []);
    }

    // Grant exact installed registrations only to the approved conversation.
    await approved.configure({
      extensions: [...integration.extensions, syntheticExtension],
      tools: [codemode, toolSearch, effect],
      modelTools: [codemode, toolSearch],
    }, context);
    const granted = await approved.agent(context);
    assert.ok(granted.tools.some((tool) => tool.name === CODEMODE_TOOL_NAME));
    assert.ok(!granted.tools.some((tool) => tool.name === 'synthetic_counter'));
    assert.ok(granted.callable.some((tool) => tool.name === 'synthetic_counter'));
    assert.ok(!(await denied.agent(context)).tools.some((tool) => tool.name === CODEMODE_TOOL_NAME));

    harness.resume();
    const approvedRun = await within((await approved.submit({ type: 'input', content: 'use synthetic tool' }, context)).wait(context));
    assert.equal(approvedRun.status, 'done');
    assert.equal(executions, 1);
    const approvedEntries = [...(await approved.entries({}, 1000, undefined, context)).items].reverse();
    const approvedResults = approvedEntries.filter(ToolResultEntry.is).map((entry) => entry.model[0]);
    assert.deepEqual(approvedResults.map(({ toolName, isError }) => [toolName, isError]), [[CODEMODE_TOOL_NAME, false]]);
    assert.match(JSON.stringify(approvedResults[0].content), /approved conversation/);
    assert.ok(approvedEntries.some((entry) => entry.model?.some((message) =>
      message.role === 'assistant' && message.content?.some((part) => part.type === 'text' && part.text === 'approved final answer'))));

    const deniedRun = await within((await denied.submit({ type: 'input', content: 'try ungranted tools' }, context)).wait(context));
    assert.equal(deniedRun.status, 'done');
    assert.equal(executions, 1, 'ungranted conversation cannot invoke the synthetic effect');
    const deniedEntries = [...(await denied.entries({}, 1000, undefined, context)).items].reverse();
    const deniedResults = deniedEntries.filter(ToolResultEntry.is).map((entry) => entry.model[0]);
    assert.deepEqual(deniedResults.map(({ toolName, isError }) => [toolName, isError]), [
      [CODEMODE_TOOL_NAME, true], ['synthetic_counter', true], [TOOL_SEARCH_TOOL_NAME, true],
    ]);
    assert.ok(deniedResults.every(({ content }) => JSON.stringify(content).includes('not available')));
    assert.ok(deniedEntries.some((entry) => entry.model?.some((message) =>
      message.role === 'assistant' && message.content?.some((part) => part.type === 'text' && part.text === 'ungranted final answer'))));
  } finally {
    integration.stopAdmission();
    if (harness) await harness.close(context);
    await integration.close();
    await rm(directory, { recursive: true, force: true });
  }
}, { timeout: 30_000 });
