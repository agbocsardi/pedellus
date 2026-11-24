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
  assert.deepEqual(parseConfig({ ...base, toolAllowlist: ['read', 'bash'] }).toolAllowlist, ['read', 'bash']);
  // Only the reviewed coding tools have registrations; config refuses anything else before gateway open.
  assert.throws(() => parseConfig({ ...base, toolAllowlist: ['reviewed_tool'] }), /toolAllowlist must name only coding tools/);
  for (const value of ['reviewed_tool', [' reviewed_tool'], ['read', 'read'], ['Read', 'read'], [null]]) {
    assert.throws(() => parseConfig({ ...base, toolAllowlist: value }), /toolAllowlist/);
  }
});

test('config is strict at the top level and in telegram, cross-checks in parseConfig and returns frozen values', () => {
  assert.throws(() => parseConfig({ ...base, restrictToWorkspce: false }), /^Error: config\.restrictToWorkspce is not a recognized option$/);
  const telegram = { tokenEnv: 'TELEGRAM_BOT_TOKEN', allowFrom: ['1'] };
  assert.throws(() => parseConfig({ ...base, telegram: { ...telegram, allowfrom: ['2'] } }), /telegram\.allowfrom is not a recognized option/);
  assert.throws(() => parseConfig({ ...base, idleRollover: { afterMinutes: 5 } }), /idleRollover requires classifierModel/);
  assert.equal(parseConfig({ ...base, classifierModel: base.model, idleRollover: { afterMinutes: 5 } }).idleRollover.afterMinutes, 5);
  assert.equal(parseConfig({ ...base, app: { port: 1, staticRoot: '/srv//pwa/../pwa/' } }).app.staticRoot, '/srv/pwa');

  const config = parseConfig({ ...base, toolAllowlist: ['read'], extraAllowedDirs: ['/tmp/extra'], telegram });
  for (const value of [config, config.toolAllowlist, config.allowedModels, config.model, config.extraAllowedDirs,
    config.telegram, config.telegram.allowFrom]) {
    assert.ok(Object.isFrozen(value));
  }
  // The parsed list is a copy, not the caller's array.
  assert.notEqual(config.telegram.allowFrom, telegram.allowFrom);
});

test('gateway rejects nonempty policy before provider or storage setup', async () => {
  // An SDK host can still hand the gateway a PortConfig it built itself; the runtime keeps its own refusal.
  const config = { ...parseConfig(base), toolAllowlist: ['synthetic_counter'] };
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

test('exclusive create stays in a verified parent and never follows a link out of the roots', { timeout: 60_000 }, async () => {
  const { mkdir, mkdtemp, readdir, rename, rm, symlink, unlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'nanobot-exclusive-'));
  const workspace = join(root, 'ws');
  const privateDir = join(root, 'private');
  const managed = join(workspace, 'managed');
  await mkdir(managed, { recursive: true });
  await mkdir(privateDir);
  const env = await createHostExecutionEnv({ workspaceRoot: workspace, protectedRoots: [managed], shell: {} });
  try {
    assert.equal((await env.createFileExclusive('nested/new.md', 'one', BACKGROUND_CONTEXT)).ok, true);
    const again = await env.createFileExclusive('nested/new.md', 'two', BACKGROUND_CONTEXT);
    assert.equal(again.ok, false);
    assert.equal(again.error.message, 'the file already exists');
    assert.equal(await env.readTextFile('nested/new.md', BACKGROUND_CONTEXT).then((r) => r.value), 'one');

    // Missing directories are created one component at a time, but never into a protected root:
    // a create under managed data with a missing tail is refused before any directory is created.
    const protectedCreate = await env.createFileExclusive('managed/deeper/new.md', 'x', BACKGROUND_CONTEXT);
    assert.equal(protectedCreate.ok, false);
    assert.deepEqual(await readdir(managed), []);

    // A dangling symlink component in the parent chain is refused, not resolved or created through.
    await symlink(join(privateDir, 'never-created'), join(workspace, 'dang'));
    const dangling = await env.createFileExclusive('dang/new.md', 'x', BACKGROUND_CONTEXT);
    assert.equal(dangling.ok, false);
    assert.equal(await env.readTextFile(join(privateDir, 'never-created', 'new.md'), BACKGROUND_CONTEXT).then((r) => r.ok), false);

    // A final-component link is the name O_EXCL refuses; a parent link out of the roots is denied.
    await symlink(join(privateDir, 'leaf.md'), join(workspace, 'leaf.md'));
    await symlink(privateDir, join(workspace, 'out'));
    assert.equal((await env.createFileExclusive('leaf.md', 'x', BACKGROUND_CONTEXT)).ok, false);
    assert.equal((await env.createFileExclusive('out/escape.md', 'x', BACKGROUND_CONTEXT)).ok, false);
    assert.equal((await env.createFileExclusive('managed/state.md', 'x', BACKGROUND_CONTEXT)).ok, false);

    // Retarget the parent link between a workspace directory and the private directory while
    // creating: the descriptor-pinned parent check must keep every create inside the workspace.
    const inside = join(workspace, 'inside');
    await mkdir(inside);
    await symlink(inside, join(workspace, 'swap'));
    let swapping = true;
    const swapper = (async () => {
      while (swapping) {
        for (const target of [privateDir, inside]) {
          await unlink(join(workspace, 'swap.next')).catch(() => undefined);
          await symlink(target, join(workspace, 'swap.next')).catch(() => undefined);
          await rename(join(workspace, 'swap.next'), join(workspace, 'swap')).catch(() => undefined);
        }
      }
    })();
    try {
      for (let attempt = 0; attempt < 1_500; attempt += 1) {
        await env.createFileExclusive(`swap/f-${attempt}.md`, 'x', BACKGROUND_CONTEXT);
      }
    } finally {
      swapping = false;
      await swapper;
    }
    assert.deepEqual(await readdir(privateDir), []);
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT);
    await rm(root, { recursive: true, force: true });
  }
});

test('shell commands naming managed data are refused even inside an allowed root', async () => {
  const { createExecutionPolicy } = await import(new URL('../dist/execution/policy.js', import.meta.url).href);
  // Full-host mode: `/` is an allowed root and the shell path guard is off, but dataDir stays managed.
  const host = createExecutionPolicy({
    roots: ['/srv/ws', '/'],
    protectedRoots: ['/srv/data'],
    shell: { environment: { HOME: '/srv/data' } },
  });
  assert.match(host.checkCommand('cat /srv/data/nanobot.sqlite'), /managed gateway data/);
  // An argv array keeps element boundaries: every element is checked whole, so a protected-root
  // argument is refused as exactly one token.
  assert.match(host.checkCommand(['cat', '/srv/data/nanobot.sqlite']), /managed gateway data/);
  assert.equal(host.checkCommand(['cat', '/srv/ws/notes.md']), undefined);
  // The joined-text scan stays as the best-effort shell-string guard, including inside argv elements.
  assert.match(host.checkCommand(['printf', '%s', ' /srv/data/x ']), /managed gateway data/);
  assert.match(host.checkCommand('ls ~/backups'), /managed gateway data/);
  assert.equal(host.checkCommand('cat /srv/ws/notes.md && ls /home/owner/projects'), undefined);
  assert.equal(host.checkCommand('ls /srv/database'), undefined);

  const scoped = createExecutionPolicy({
    roots: ['/srv'],
    protectedRoots: ['/srv/data'],
    shell: { restrictToWorkspace: true, environment: { HOME: '/srv' } },
  });
  assert.match(scoped.checkCommand('echo x > /srv/data/x'), /managed gateway data/);
  assert.match(scoped.checkCommand(['cp', 'notes.md', '/srv/data/notes.md']), /managed gateway data/);
  assert.match(scoped.checkCommand(['cp', 'notes.md', '/outside/notes.md']), /path outside working dir/);
  assert.equal(scoped.checkCommand(['cp', 'notes.md', '/srv/ws/notes.md']), undefined);
  // A relative argv element is resolved against the cwd: only the element-boundary check can see
  // that it names managed data, because the joined text holds no absolute path at all.
  const cwdScoped = createExecutionPolicy({
    roots: ['/srv/ws'],
    protectedRoots: ['/srv/ws/data'],
    shell: { restrictToWorkspace: true, environment: { HOME: '/srv/ws' } },
  });
  assert.match(cwdScoped.checkCommand(['cp', 'data/secret.md', 'out.md'], { cwd: '/srv/ws' }), /managed gateway data/);
  assert.equal(cwdScoped.checkCommand('cp data/secret.md out.md', { cwd: '/srv/ws' }), undefined);
  assert.equal(scoped.checkCommand('echo x > /srv/ws/x'), undefined);
  assert.match(scoped.checkCommand('cat /etc/hosts'), /path outside working dir/);
  assert.doesNotMatch(scoped.checkCommand('cat /etc/hosts'), /restrict_to_workspace/);
});

test('a replaced bwrap executable is re-validated by identity, not by pathname', { timeout: 30_000 }, async () => {
  if (process.platform !== 'linux') return; // Bubblewrap resolution is Linux-only.
  const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { resolveDirectBwrapPath, buildDirectBwrapArgsWithBinary, revalidateBwrapBinary } =
    await import(new URL('../dist/execution/direct-bwrap.js', import.meta.url).href);
  const root = await mkdtemp(join(tmpdir(), 'nanobot-bwrap-revalidate-'));
  const fake = join(root, 'bwrap');
  const workspace = join(root, 'ws');
  const writeFake = (text) => writeFile(fake, `#!/bin/sh\necho ${text}\n`, { mode: 0o755 });
  const argvFor = () => buildDirectBwrapArgsWithBinary(resolved, { workspace, command: ['/bin/sh', '-c', 'true'] });
  let resolved;
  try {
    await mkdir(workspace);
    await writeFake('"bubblewrap 0.10.0"');
    resolved = resolveDirectBwrapPath(fake);
    assert.equal(argvFor()[0], resolved);
    // The pinned identity validates the same file on a later launch.
    assert.equal(revalidateBwrapBinary(resolved), resolved);

    // A different but still-valid executable replaces the file at the same path: the pathname
    // cache is not trusted across the swap; the new file is fully re-validated.
    await writeFake('"bubblewrap 0.10.1"');
    assert.equal(revalidateBwrapBinary(resolved), resolved);
    assert.equal(argvFor()[0], resolved);

    // Defensive verification only: a non-bwrap executable at the validated path fails the launch
    // closed instead of executing whatever now answers to the cached pathname.
    await writeFake('"definitely not bubblewrap"');
    assert.throws(() => revalidateBwrapBinary(resolved), /Bubblewrap validation failed/);
    assert.throws(() => argvFor(), /Bubblewrap validation failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
