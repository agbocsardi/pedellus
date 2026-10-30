// Synthetic child for the removed-worker-model reopen regression. It opens the real Gateway with
// two named presets, selects the non-default one, starts a background worker whose child blocks in a
// live shell tool, publishes the durable IDs, and then waits to be SIGKILLed by the test. The kill
// leaves exactly the state under test: a live worker task with a prepared target and live child work
// that holds no saved provider dispatch. The parent then reopens with the child's model removed.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [directory] = process.argv.slice(2);
assert.ok(directory, 'test directory argument');

const packageRoot = process.env.PI_WORKER_CANDIDATE ?? fileURLToPath(new URL('../../', import.meta.url));
const modules = join(packageRoot, 'node_modules/@earendil-works');
const [{ BACKGROUND_CONTEXT: context }, ai, runtime, configModule, workers] = await Promise.all([
  import(pathToFileURL(join(modules, 'chord/dist/context/index.js')).href),
  import(pathToFileURL(join(modules, 'pi-ai/dist/index.js')).href),
  import(pathToFileURL(join(packageRoot, 'dist/runtime.js')).href),
  import(pathToFileURL(join(packageRoot, 'dist/config.js')).href),
  import(pathToFileURL(join(packageRoot, 'dist/workers/worker-task.js')).href),
]);

const { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } = ai;
const { parseConfig } = configModule;
const { openGateway } = runtime;
const { WorkerRecordsDoc } = workers;

const workspace = join(directory, 'workspace');
const dataDir = join(directory, 'state');
const session = 'telegram:21:chat:701';
const childPromptMarker = 'worker-model-removed-child-task';
const issued = new Set();

const lastUserText = (messages) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    return typeof message.content === 'string'
      ? message.content
      : (message.content ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('');
  }
  return '';
};

const faux = fauxProvider({ provider: 'worker-removed', models: [
  { id: 'primary', name: 'Primary', reasoning: false, input: ['text'] },
  { id: 'research', name: 'Research', reasoning: false, input: ['text'] },
] });
const models = createModels();
models.setProvider(faux.provider);
const dispatcher = async (transcript) => {
  const input = lastUserText(transcript.messages);
  if (input.includes('Background worker task.')) {
    if (issued.has('child')) return fauxAssistantMessage('child would continue');
    issued.add('child');
    // A live shell tool keeps the child generation in its non-prepared tool phase until the kill.
    return fauxAssistantMessage([
      fauxToolCall('bash', {
        command: 'for i in $(seq 1 200); do if [ -f release.txt ]; then exit 0; fi; sleep 0.05; done',
      }, { id: 'blocked-shell' }),
    ], { stopReason: 'toolUse' });
  }
  if (input === 'spawn a researcher' && !issued.has('spawn')) {
    issued.add('spawn');
    return fauxAssistantMessage([
      fauxToolCall('worker', { action: 'start', task: childPromptMarker, workspace_mode: 'shared' }, { id: 'removed-model-start' }),
    ], { stopReason: 'toolUse' });
  }
  if (input.includes('[internal worker result]')) return fauxAssistantMessage('noted');
  return fauxAssistantMessage('ok');
};
faux.setResponses(Array.from({ length: 40 }, () => dispatcher));

const config = parseConfig({
  workspace,
  dataDir,
  modelPresets: {
    primary: { provider: 'worker-removed', modelId: 'primary' },
    research: { provider: 'worker-removed', modelId: 'research' },
  },
  modelPreset: 'primary',
  toolAllowlist: ['read', 'bash'],
  workers: { enabled: true },
}, directory);
const gateway = await openGateway(config, context, { models });
const conversation = await gateway.conversationFor(session, context);
await gateway.selectModelPreset(session, 'research', context);
const submission = await conversation.submit({ type: 'input', content: 'spawn a researcher', requestId: 'spawn' }, context);
assert.equal((await submission.wait(context)).status, 'done');

// Wait for the live child tool task, so the kill cannot land during a saved provider dispatch.
let state;
for (let attempt = 0; attempt < 600; attempt += 1) {
  const records = await gateway.harness.snapshot(WorkerRecordsDoc, conversation.id, context);
  const record = records?.workers[0];
  if (record?.conversationId != null) {
    const inspection = await gateway.harness.inspect(context);
    const tool = inspection.tasks.find((entry) => entry.record.kind === 'pi.tool'
      && entry.record.conversationId === record.conversationId
      && entry.record.state.status !== 'terminal');
    if (tool !== undefined) {
      state = {
        session,
        chatConversationId: conversation.id,
        workerTaskId: record.taskId,
        childConversationId: record.conversationId,
      };
      break;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}
assert.ok(state, 'the child tool never became live');
await writeFile(join(directory, 'state.json'), JSON.stringify(state));
process.stdout.write(`CHILD-TOOL-RUNNING ${JSON.stringify(state)}\n`);
// Wait for SIGKILL; the parent owns the workspace and the store.
await new Promise(() => undefined);
