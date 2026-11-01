import assert from 'node:assert/strict';
import { test } from 'node:test';

const packageRoot = process.env.PI_CODEMODE_CANDIDATE ?? new URL('../', import.meta.url).pathname;
const [{ parseConfig }, { openGateway }, { createHostExecutionEnv }, { BACKGROUND_CONTEXT }] = await Promise.all([
  import(new URL('../dist/config.js', import.meta.url).href),
  import(new URL('../dist/runtime.js', import.meta.url).href),
  import(new URL('../dist/execution/host.js', import.meta.url).href),
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

test('a workspace symlink swapped under a running read never reaches a file outside the roots', { timeout: 60_000 }, async () => {
  const { mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'nanobot-race-'));
  const workspace = join(root, 'ws');
  const privateDir = join(root, 'private');
  const target = join(workspace, 'shadow');
  const staged = join(workspace, 'shadow.next');
  const sentinel = join(privateDir, 'grant.json');
  const content = 'workspace-content';
  await mkdir(workspace);
  await mkdir(privateDir);
  await writeFile(sentinel, 'outside-private-content');
  await writeFile(target, content);
  const env = await createHostExecutionEnv({ workspaceRoot: workspace, shell: {} });
  let swapping = true;
  // The guard resolves the path before the operation; this loop replaces that path with a link to the
  // outside file, which is the race a resolved-path check alone loses. Both states are installed with
  // an atomic rename, so an allowed read always observes the complete workspace file.
  const swapper = (async () => {
    while (swapping) {
      await unlink(staged).catch(() => undefined);
      await symlink(sentinel, staged).catch(() => undefined);
      await rename(staged, target).catch(() => undefined);
      await writeFile(staged, content).catch(() => undefined);
      await rename(staged, target).catch(() => undefined);
    }
  })();
  try {
    for (let attempt = 0; attempt < 4_000; attempt += 1) {
      const result = await env.readTextFile('shadow', BACKGROUND_CONTEXT);
      // A refusal is the expected outcome while the swap is active; an allowed read must be the
      // workspace file. Anything else means the operation followed the swapped link.
      if (result.ok) assert.equal(result.value, content);
    }
  } finally {
    swapping = false;
    await swapper;
    await env.cleanup(BACKGROUND_CONTEXT);
    await rm(root, { recursive: true, force: true });
  }
});
