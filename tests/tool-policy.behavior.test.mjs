import assert from 'node:assert/strict';
import { test } from 'node:test';

const packageRoot = process.env.PI_CODEMODE_CANDIDATE ?? new URL('../', import.meta.url).pathname;
const [{ parseConfig }, { openGateway }, { BACKGROUND_CONTEXT }] = await Promise.all([
  import(new URL('../dist/config.js', import.meta.url).href),
  import(new URL('../dist/runtime.js', import.meta.url).href),
  import(`${packageRoot}/node_modules/@earendil-works/chord/dist/context/index.js`),
]);

const base = {
  workspace: '/tmp/nanobot-policy-workspace',
  dataDir: '/tmp/nanobot-policy-data',
  model: { provider: 'faux', modelId: 'faux-1' },
};

test('tool policy defaults to empty and rejects malformed or ambiguous names', () => {
  assert.deepEqual(parseConfig(base).toolAllowlist, []);
  assert.deepEqual(parseConfig({ ...base, toolAllowlist: ['reviewed_tool'] }).toolAllowlist, ['reviewed_tool']);
  for (const value of ['reviewed_tool', [' reviewed_tool'], ['reviewed_tool', 'reviewed_tool'], ['Tool', 'tool'], [null]]) {
    assert.throws(() => parseConfig({ ...base, toolAllowlist: value }), /toolAllowlist/);
  }
});

test('gateway rejects nonempty policy before provider or storage setup', async () => {
  const config = parseConfig({ ...base, toolAllowlist: ['synthetic_counter'] });
  await assert.rejects(openGateway(config, BACKGROUND_CONTEXT), /no approved registered tools/);
});
