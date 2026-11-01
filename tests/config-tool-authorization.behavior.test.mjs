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
  { boundedCapturedTools, createConfigToolHook },
  { BACKGROUND_CONTEXT },
  { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall },
  { ToolResultEntry },
] = await Promise.all([
  import(new URL('../dist/config.js', import.meta.url).href),
  import(new URL('../dist/runtime.js', import.meta.url).href),
  import(new URL('../dist/tools/index.js', import.meta.url).href),
  import(`${modules}/chord/dist/context/index.js`),
  import(`${modules}/pi-ai/dist/index.js`),
  import(`${modules}/pi-durable/dist/index.js`),
]);

const context = BACKGROUND_CONTEXT;
const CODING_TOOL_NAMES = ['read', 'write', 'edit', 'bash'];
const toolNames = (agent) => (agent.tools ?? []).map((tool) => (typeof tool === 'string' ? tool : tool.name));
const codingNames = (agent) => toolNames(agent).filter((name) => CODING_TOOL_NAMES.includes(name)).sort();

async function workspaceStore(label) {
  const directory = await mkdtemp(join(tmpdir(), `nanobot-config-tools-${label}-`));
  const workspace = join(directory, 'workspace');
  const dataDir = join(directory, 'state');
  await mkdir(workspace);
  await writeFile(join(workspace, 'note.txt'), 'CONFIG-READ-CONTENT\n');
  const model = { provider: 'config-tools', modelId: 'synthetic' };
  const config = (toolAllowlist) => parseConfig({ workspace, dataDir, model, toolAllowlist }, directory);
  return { directory, model, config };
}

function syntheticModels() {
  const faux = fauxProvider({ provider: 'config-tools', models: [{ id: 'synthetic', name: 'Synthetic' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

async function say(conversation, text) {
  const submission = await conversation.submit({ type: 'input', content: text }, context);
  const settled = await submission.wait(context);
  assert.equal(settled.status, 'done');
}

async function toolResults(conversation, id) {
  const items = (await conversation.entries({}, 200, undefined, context)).items;
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

test('config authority runs read and memory recall in a mapped chat while other scopes get no coding authority', { timeout: 10_000 }, async () => {
  const store = await workspaceStore('mapped');
  const { faux, models } = syntheticModels();
  const marker = 'CONFIG-HISTORY-MARKER';
  let callsIssued = false;
  faux.setResponses(Array.from({ length: 8 }, () => (request) => {
    if (JSON.stringify(request.messages).includes('recall the note') && !callsIssued) {
      callsIssued = true;
      return fauxAssistantMessage([
        fauxToolCall('read', { path: 'note.txt' }, { id: 'config-read' }),
        fauxToolCall('memory_search', { target: 'messages', query: marker }, { id: 'config-history' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('synthetic answer');
  }));
  let gateway;
  try {
    gateway = await openGateway(store.config(['read']), context, { models });
    const chat = await gateway.conversationFor('telegram:7:chat:501', context);
    assert.deepEqual(toolNames(await chat.agent(context)).sort(), ['memory_browse', 'memory_read', 'memory_search', 'read']);

    await say(chat, `remember ${marker}`);
    await say(chat, 'recall the note');

    const read = await toolResults(chat, 'config-read');
    assert.equal(read.isError, false, `read result: ${read.text.slice(0, 200)}`);
    assert.match(read.text, /CONFIG-READ-CONTENT/);
    assert.doesNotMatch(read.text, /outside the host tool ceiling/);
    const history = await toolResults(chat, 'config-history');
    assert.equal(history.isError, false, `memory search result: ${history.text.slice(0, 200)}`);
    assert.doesNotMatch(history.text, /outside the host tool ceiling/);
    const page = JSON.parse(history.text);
    const hit = page.hits[0];
    assert.ok(hit?.ref, JSON.stringify(page));
    const original = await gateway.memoryRead(chat.id, { ref: hit.ref }, context);
    assert.match(original.content, new RegExp(marker), 'the exact original evidence is available by locator');

    const raw = await gateway.harness.createConversation(
      { ownership: { kind: 'ownerless' }, agent: { model: store.model } }, context);
    assert.deepEqual(toolNames(await raw.agent(context)), []);
    const entries = (await chat.entries({}, 50, undefined, context)).items;
    assert.ok(entries.length > 0, 'the mapped chat has an entry to fork at');
    const fork = await chat.fork(entries[0].id, { ownership: { kind: 'ownerless' }, agent: { model: store.model } }, context);
    const forkNames = toolNames(await fork.agent(context));
    assert.ok(!forkNames.includes('read') && !forkNames.includes('memory_search') && !forkNames.includes('memory_browse') && !forkNames.includes('memory_read'), `fork tools: ${forkNames}`);
    const state = await gateway.conversationFor('telegram:7:channel-state', context);
    assert.deepEqual(toolNames(await state.agent(context)), []);
    const root = await gateway.harness.root(context);
    assert.deepEqual(toolNames(await root.agent(context)), []);
  } finally {
    if (gateway) await gateway.close(context);
    await rm(store.directory, { recursive: true, force: true });
  }
});

test('config reopen follows the configured ceiling, not persisted agent tool state', { timeout: 10_000 }, async () => {
  const store = await workspaceStore('reopen');
  const key = 'telegram:7:chat:601';
  let gateway;
  try {
    gateway = await openGateway(store.config(['read', 'write', 'bash']), context, { models: syntheticModels().models });
    const configured = await gateway.conversationFor(key, context);
    assert.deepEqual(codingNames(await configured.agent(context)), ['bash', 'read', 'write']);
    await gateway.close(context);
    gateway = undefined;

    // Reopening with a narrower ceiling removes the tools the new configuration does not name.
    gateway = await openGateway(store.config(['read']), context, { models: syntheticModels().models });
    const narrowed = await gateway.conversationFor(key, context);
    assert.deepEqual(codingNames(await narrowed.agent(context)), ['read']);
    await gateway.close(context);
    gateway = undefined;

    gateway = await openGateway(store.config([]), context, { models: syntheticModels().models });
    const emptied = await gateway.conversationFor(key, context);
    assert.deepEqual(codingNames(await emptied.agent(context)), []);
    const names = toolNames(await emptied.agent(context));
    for (const name of ['memory_search', 'memory_browse', 'memory_read']) assert.ok(names.includes(name), names.join(','));
    assert.ok(!names.includes('history'), names.join(','));
  } finally {
    if (gateway) await gateway.close(context);
    await rm(store.directory, { recursive: true, force: true });
  }
});

test('captured config authority is bounded by the current ceiling and a validated chat origin', { timeout: 5_000 }, async () => {
  const chatId = 11;
  const rawId = 12;
  const hook = createConfigToolHook(['read', 'bash'], (id) => id === chatId, ['history']);
  const beforeTool = hook.handlers.beforeTool;
  const call = (name) => ({ type: 'toolCall', id: `synthetic-${name}`, name, arguments: {} });
  const api = (conversationId, capture) => ({
    conversationId,
    async snapshot() {
      if (capture instanceof Error) throw capture;
      return capture;
    },
  });
  const verdict = async (conversationId, name, capture) =>
    beforeTool(call(name), api(conversationId, capture), context);

  // Ungated context tools never need authority (the read-only history regression).
  assert.equal(await verdict(rawId, 'history', undefined), undefined);
  // The ceiling still bounds an authenticated chat and the capture path.
  assert.equal(await verdict(chatId, 'read', undefined), undefined);
  assert.match((await verdict(rawId, 'write', undefined))?.block ?? '', /outside the host tool ceiling/);
  // A live run target holds only its captured names.
  assert.equal(await verdict(rawId, 'read', { originConversationId: chatId, tools: ['read'] }), undefined);
  assert.match(
    (await verdict(rawId, 'bash', { originConversationId: chatId, tools: ['read'] }))?.block ?? '',
    /not in this run's captured config authority/,
  );
  // A malformed capture, an unauthorized origin and an unreadable capture fail closed.
  assert.match(
    (await verdict(rawId, 'read', { originConversationId: chatId, tools: 'read' }))?.block ?? '',
    /not in this run's captured config authority/,
  );
  assert.match(
    (await verdict(rawId, 'read', { originConversationId: rawId, tools: ['read'] }))?.block ?? '',
    /origin is not an authenticated chat/,
  );
  assert.match(
    (await verdict(rawId, 'read', { originConversationId: 0, tools: ['read'] }))?.block ?? '',
    /invalid origin/,
  );
  assert.match((await verdict(rawId, 'read', undefined))?.block ?? '', /not enabled for this conversation/);
  assert.match(
    (await verdict(rawId, 'read', new Error('synthetic capture read failure')))?.block ?? '',
    /could not be read/,
  );

  assert.deepEqual(boundedCapturedTools(['bash', 'read', 'unknown'], ['read', 'bash'], true), ['read', 'bash']);
  assert.deepEqual(boundedCapturedTools(['read'], ['read'], false), []);
  assert.deepEqual(boundedCapturedTools('read', ['read'], true), []);
});
