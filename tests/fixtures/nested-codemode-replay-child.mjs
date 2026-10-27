// Synthetic child for the nested Code Mode interrupted-tool replay/revocation
// test. It starts three model-issued Code Mode calls whose scripts invoke one
// harmless nested synthetic tool each. Every nested body appends one line to a
// synthetic effect log and then waits to be SIGKILLed.
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [directory] = process.argv.slice(2);
assert.ok(directory, 'test directory argument');

const packageRoot = process.env.PI_CODEMODE_REPLAY_CANDIDATE
  ?? fileURLToPath(new URL('../../', import.meta.url));
const modules = join(packageRoot, 'node_modules/@earendil-works');
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
const { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } = ai;
const { Harness, createRegistry, defineExtension, defineTool } = durable;
const { openNodeSqliteStorage } = sqlite;
const { CODEMODE_TOOL_NAME } = nativeCodeMode;
const { TOOL_SEARCH_TOOL_NAME } = nativeSearch;
const { createCodeModeIntegration } = integrationModule;

await mkdir(directory, { recursive: true });
const effects = join(directory, 'effects.log');
const stateFile = join(directory, 'state.json');

const synthetic = (name) => defineTool({
  name,
  description: `Synthetic ${name} for nested Code Mode replay classification checks`,
  parameters: Type.Object({ label: Type.String() }),
  structuredOutputSchema: Type.Object({ label: Type.String(), sequence: Type.Number() }),
  callers: ['tools'],
  replay: 'safe',
  execute: async ({ label }) => {
    await appendFile(effects, `${name}:${label}\n`);
    // The parent observes the journaled Code Mode intent and nested intent, then sends SIGKILL.
    return await new Promise(() => {});
  },
});
const revokedTool = synthetic('nested_revoked_effect');
const grantedTool = synthetic('nested_granted_effect');
const downgradedTool = synthetic('nested_downgraded_effect');
const pendingTool = synthetic('nested_pending_effect');
const extension = defineExtension({
  name: 'nested-tool-replay-synthetic',
  tools: [revokedTool, grantedTool, downgradedTool, pendingTool],
});
const integration = createCodeModeIntegration();
const registry = createRegistry();
for (const installed of integration.extensions) registry.install(installed);
registry.install(extension);

const registrations = new Map(registry.snapshot().tools().map(({ tool }) => [tool.name, tool]));
const requireTool = (name) => {
  const tool = registrations.get(name);
  assert.ok(tool, `registered tool ${name}`);
  return tool;
};
const codemode = requireTool(CODEMODE_TOOL_NAME);
const toolSearch = requireTool(TOOL_SEARCH_TOOL_NAME);

const lastUserText = (messages) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    return message.content.filter((part) => part.type === 'text').map((part) => part.text).join(' ');
  }
  return '';
};

const route = (transcript) => {
  const input = lastUserText(transcript.messages);
  if (input.includes('mixed')) {
    return fauxAssistantMessage(
      fauxToolCall(CODEMODE_TOOL_NAME, {
        code: `const settled = await Promise.allSettled([
          tools.nested_revoked_effect({ label: 'revoked' }),
          tools.nested_downgraded_effect({ label: 'downgraded' }),
        ]);
        return settled.map((result) => result.status === 'fulfilled'
          ? { ok: true, value: result.value }
          : { ok: false, reason: String(result.reason) });`,
      }, { id: 'mixed-code' }),
      { stopReason: 'toolUse' },
    );
  }
  if (input.includes('granted')) {
    return fauxAssistantMessage(
      fauxToolCall(CODEMODE_TOOL_NAME, {
        code: `const first = await tools.nested_granted_effect({ label: 'granted' });
        try {
          const pending = await tools.nested_pending_effect({ label: 'pending' });
          return { first, pending };
        } catch (error) {
          return { first, pending: String(error) };
        }`,
      }, { id: 'granted-code' }),
      { stopReason: 'toolUse' },
    );
  }
  return fauxAssistantMessage('child must not reach a final answer');
};
const faux = fauxProvider();
// One queued response is consumed per request; keep a few for all conversations.
faux.setResponses(Array.from({ length: 6 }, () => route));
const models = createModels();
models.setProvider(faux.provider);

const harness = await Harness.open(await openNodeSqliteStorage(join(directory, 'state.sqlite')), {
  models,
  registry,
  settings: { extensions: [] },
}, context);
const model = { provider: 'faux', modelId: 'faux-1' };
const create = () => harness.createConversation({
  ownership: { kind: 'ownerless' },
  agent: { model },
}, context);
// The integration caps Code Mode at two workers, so one script makes both the
// revoked and downgraded nested calls, and the second script makes the granted one.
const conversations = {
  mixed: await create(),
  granted: await create(),
};
await conversations.mixed.configure({
  extensions: [...integration.extensions, extension],
  tools: [codemode, toolSearch, revokedTool, downgradedTool],
  modelTools: [codemode, toolSearch],
}, context);
// The pending tool is granted at first run but is called only after the first
// nested effect resolves. It is therefore still pending at SIGKILL.
await conversations.granted.configure({
  extensions: [...integration.extensions, extension],
  tools: [codemode, toolSearch, grantedTool, pendingTool],
  modelTools: [codemode, toolSearch],
}, context);

const submissions = {
  mixed: await conversations.mixed.submit(
    { type: 'input', content: 'run mixed nested synthetic effects', requestId: 'nested-mixed-request' },
    context,
  ),
  granted: await conversations.granted.submit(
    { type: 'input', content: 'run granted nested synthetic effect', requestId: 'nested-granted-request' },
    context,
  ),
};

const deadline = Date.now() + 15_000;
while (Date.now() < deadline) {
  const log = await readFile(effects, 'utf8').catch(() => '');
  if (log.trim().split('\n').filter(Boolean).length >= 3) break;
  await new Promise((resolve) => setTimeout(resolve, 20));
}
const lines = (await readFile(effects, 'utf8')).trim().split('\n').filter(Boolean);
assert.equal(lines.length, 3, `all nested synthetic bodies must have started: ${JSON.stringify(lines)}`);

await writeFile(stateFile, JSON.stringify(Object.fromEntries(
  Object.entries(conversations).map(([key, conversation]) => [
    key,
    { conversation: conversation.id, submission: submissions[key].id },
  ]),
)));
process.stdout.write('READY\n');
await new Promise(() => {});
