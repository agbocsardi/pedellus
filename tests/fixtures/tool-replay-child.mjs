// Synthetic child for the interrupted-tool replay/revocation test. It starts two
// model-issued calls against fake tools, records that both bodies have begun,
// publishes the conversation/submission IDs, and then waits to be SIGKILLed.
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [directory] = process.argv.slice(2);
assert.ok(directory, 'test directory argument');

const packageRoot = process.env.PI_TOOL_REPLAY_CANDIDATE
  ?? fileURLToPath(new URL('../../', import.meta.url));
const modules = join(packageRoot, 'node_modules/@earendil-works');
const [{ BACKGROUND_CONTEXT: context }, ai, durable, sqlite] = await Promise.all([
  import(pathToFileURL(join(modules, 'chord/dist/context/index.js')).href),
  import(pathToFileURL(join(modules, 'pi-ai/dist/index.js')).href),
  import(pathToFileURL(join(modules, 'pi-durable/dist/index.js')).href),
  import(pathToFileURL(join(modules, 'pi-durable/dist/storage/sqlite/node.js')).href),
]);

const { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } = ai;
const { Harness, createRegistry, defineExtension, defineTool } = durable;
const { openNodeSqliteStorage } = sqlite;

await mkdir(directory, { recursive: true });
const effects = join(directory, 'effects.log');
const stateFile = join(directory, 'state.json');

const synthetic = (name) => defineTool({
  name,
  description: `Synthetic ${name} for restart replay classification checks`,
  parameters: Type.Object({ label: Type.String() }),
  callers: ['model'],
  replay: 'safe',
  execute: async ({ label }) => {
    await appendFile(effects, `${name}:${label}\n`);
    // The parent observes the journaled intent, then sends SIGKILL.
    return await new Promise(() => {});
  },
});
const revokedTool = synthetic('revoked_effect');
const grantedTool = synthetic('granted_effect');
const downgradedTool = synthetic('downgraded_effect');
const extension = defineExtension({
  name: 'tool-replay-synthetic',
  tools: [revokedTool, grantedTool, downgradedTool],
});
const registry = createRegistry();
registry.install(extension);

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
  if (input.includes('revoked')) {
    return fauxAssistantMessage(
      fauxToolCall('revoked_effect', { label: 'revoked' }, { id: 'revoked-call' }),
      { stopReason: 'toolUse' },
    );
  }
  if (input.includes('granted')) {
    return fauxAssistantMessage(
      fauxToolCall('granted_effect', { label: 'granted' }, { id: 'granted-call' }),
      { stopReason: 'toolUse' },
    );
  }
  if (input.includes('downgraded')) {
    return fauxAssistantMessage(
      fauxToolCall('downgraded_effect', { label: 'downgraded' }, { id: 'downgraded-call' }),
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
const revokedConversation = await create();
const grantedConversation = await create();
const downgradedConversation = await create();
await revokedConversation.configure({
  extensions: [extension],
  tools: [revokedTool],
  modelTools: [revokedTool],
}, context);
await grantedConversation.configure({
  extensions: [extension],
  tools: [grantedTool],
  modelTools: [grantedTool],
}, context);
await downgradedConversation.configure({
  extensions: [extension],
  tools: [downgradedTool],
  modelTools: [downgradedTool],
}, context);

const revokedSubmission = await revokedConversation.submit(
  { type: 'input', content: 'run revoked synthetic effect', requestId: 'revoked-request' },
  context,
);
const grantedSubmission = await grantedConversation.submit(
  { type: 'input', content: 'run granted synthetic effect', requestId: 'granted-request' },
  context,
);
const downgradedSubmission = await downgradedConversation.submit(
  { type: 'input', content: 'run downgraded synthetic effect', requestId: 'downgraded-request' },
  context,
);

const deadline = Date.now() + 10_000;
while (Date.now() < deadline) {
  const log = await readFile(effects, 'utf8').catch(() => '');
  if (log.trim().split('\n').filter(Boolean).length >= 3) break;
  await new Promise((resolve) => setTimeout(resolve, 20));
}
const lines = (await readFile(effects, 'utf8')).trim().split('\n').filter(Boolean);
assert.equal(lines.length, 3, `all synthetic bodies must have started: ${JSON.stringify(lines)}`);

await writeFile(stateFile, JSON.stringify({
  revoked: { conversation: revokedConversation.id, submission: revokedSubmission.id },
  granted: { conversation: grantedConversation.id, submission: grantedSubmission.id },
  downgraded: { conversation: downgradedConversation.id, submission: downgradedSubmission.id },
}));
process.stdout.write('READY\n');
await new Promise(() => {});
