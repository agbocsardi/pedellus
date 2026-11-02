// Explicit local-transcription backends.
//
// No bot, credential, network, uv environment, model or speech engine is used:
// every external program is a controlled shell stub on a temporary path, and the
// real engines are never invoked. Every wait is an explicit outcome, not a sleep.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const [{ createTranscriber, TRANSCRIPTION_LIMITS }, { parseConfig }] = await Promise.all([
  import(new URL('../dist/media/transcription.js', import.meta.url).href),
  import(new URL('../dist/config.js', import.meta.url).href),
]);

const TEMP_PREFIX = 'nanobot-transcribe-';

async function scratch(label) {
  const directory = await mkdtemp(join(tmpdir(), `nanobot-transcription-${label}-`));
  return {
    directory,
    path: (name) => join(directory, name),
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** A shell stub: `body` runs with the real argv; `mode` optional. */
async function stub(area, name, body, extra = {}) {
  const file = area.path(name);
  await writeFile(file, ['#!/bin/sh', body, ''].join('\n'), { mode: 0o755, ...extra });
  return file;
}

async function leftoverTempDirs() {
  return (await readdir(tmpdir())).filter((entry) => entry.startsWith(TEMP_PREFIX));
}

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * One complete fake engine set. Behaviour is baked into the stubs because the
 * transcriber deliberately passes only a small environment to its children.
 */
async function engineSet(area, options = {}) {
  const {
    duration = '11.0',
    probeExit = 0,
    pcmBytes = 1024,
    decodeExit = 0,
    text = 'EXPECTED-TRANSCRIPT',
    engineExit = 0,
    sleepSeconds = 0,
  } = options;
  const argsFile = area.path('engine.args');
  const probeArgs = area.path('probe.args');
  const decodeArgs = area.path('decode.args');
  const engineMarker = area.path('engine.ran');
  const decodeMarker = area.path('decode.ran');
  const prelude = sleepSeconds > 0 ? `sleep ${sleepSeconds}` : ':';

  const ffprobe = await stub(area, 'fake-ffprobe', [
    `printf '%s\\n' "$@" > "${probeArgs}"`,
    prelude,
    `printf '%s\\n' "${duration}"`,
    `exit ${probeExit}`,
  ].join('\n'));

  const ffmpeg = await stub(area, 'fake-ffmpeg', [
    `printf '%s\\n' "$@" > "${decodeArgs}"`,
    prelude,
    'for last; do :; done',
    `dd if=/dev/zero of="$last" bs=1000 count=${Math.max(1, Math.ceil(pcmBytes / 1000))} 2>/dev/null`,
    `: > "${decodeMarker}"`,
    `exit ${decodeExit}`,
  ].join('\n'));

  const whisperCli = await stub(area, 'fake-whisper-cli', [
    `printf '%s\\n' "$@" > "${argsFile}"`,
    prelude,
    `: > "${engineMarker}"`,
    `printf '%s' "${text}"`,
    `exit ${engineExit}`,
  ].join('\n'));

  return {
    engine: { binary: whisperCli, model: area.path('model.bin'), vadModel: area.path('vad.bin'), ffmpeg, ffprobe },
    paths: { argsFile, probeArgs, decodeArgs, engineMarker, decodeMarker, ffprobe, ffmpeg, whisperCli },
    async args(file) {
      return (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '');
    },
  };
}

async function audioFile(area, bytes = 2048) {
  const file = area.path('voice.oga');
  await writeFile(file, Buffer.alloc(bytes, 7));
  return file;
}

test('an existing config without backend keeps the legacy uv helper', { timeout: 20_000 }, async () => {
  const area = await scratch('legacy');
  try {
    const uv = await stub(area, 'fake-uv', 'printf "%s" "LEGACY-OK"');
    const audio = await audioFile(area);
    const transcriber = createTranscriber({ uvPath: uv });
    assert.equal(transcriber.enabled, true);
    assert.deepEqual(await transcriber.transcribe(audio), { ok: true, text: 'LEGACY-OK' });
    // The same option object is what the config parser produces for a config that
    // never mentions the new route.
    const parsed = parseConfig({
      workspace: area.path('ws'),
      dataDir: area.path('state'),
      model: { provider: 'p', modelId: 'm' },
      media: { directory: 'media', transcription: { language: 'en' } },
    }, area.directory);
    assert.deepEqual({ ...parsed.media.transcription }, { language: 'en' });
    assert.equal(parsed.media.transcription.backend, undefined);
  } finally {
    await area.cleanup();
  }
});

test('config rejects ambiguous or partial whisper-cli selection', async () => {
  const area = await scratch('config');
  const base = {
    workspace: area.path('ws'),
    dataDir: area.path('state'),
    model: { provider: 'p', modelId: 'm' },
  };
  const engine = {
    binary: '/opt/whisper/whisper-cli',
    model: '/opt/whisper/ggml-small-q5_1.bin',
    vadModel: '/opt/whisper/ggml-silero-v6.2.0.bin',
    ffmpeg: '/opt/ffmpeg/bin/ffmpeg',
    ffprobe: '/opt/ffmpeg/bin/ffprobe',
  };
  try {
    const accepted = parseConfig({
      ...base,
      media: { directory: 'media', transcription: { backend: 'whisper-cli', whisperCli: engine } },
    }, area.directory);
    assert.equal(accepted.media.transcription.backend, 'whisper-cli');
    assert.deepEqual({ ...accepted.media.transcription.whisperCli }, engine);

    const explicitLegacy = parseConfig({
      ...base,
      media: { directory: 'media', transcription: { backend: 'faster-whisper' } },
    }, area.directory);
    assert.equal(explicitLegacy.media.transcription.backend, 'faster-whisper');

    assert.throws(
      () => parseConfig({ ...base, media: { directory: 'media', transcription: { whisperCli: engine } } }, area.directory),
      /required exactly when backend is whisper-cli/,
    );
    assert.throws(
      () => parseConfig({ ...base, media: { directory: 'media', transcription: { backend: 'whisper-cli' } } }, area.directory),
      /required exactly when backend is whisper-cli/,
    );
    assert.throws(
      () => parseConfig({
        ...base,
        media: { directory: 'media', transcription: { backend: 'faster-whisper', whisperCli: engine } },
      }, area.directory),
      /required exactly when backend is whisper-cli/,
    );
    assert.throws(
      () => parseConfig({
        ...base,
        media: { directory: 'media', transcription: { backend: 'whisper-cli', whisperCli: { ...engine, ffmpeg: 'ffmpeg' } } },
      }, area.directory),
      /whisperCli\.ffmpeg must be an absolute path/,
    );
    assert.throws(
      () => parseConfig({
        ...base,
        media: { directory: 'media', transcription: { backend: 'whisper-cli', whisperCli: { ...engine, extra: '/x' } } },
      }, area.directory),
      /Unknown media\.transcription\.whisperCli field: extra/,
    );
    assert.throws(
      () => parseConfig({
        ...base,
        media: { directory: 'media', transcription: { backend: 'nope' } },
      }, area.directory),
      /backend must be faster-whisper, whisper-cli or hex/,
    );
    // A legacy config with no backend field behaves exactly as before.
    const legacy = parseConfig({
      ...base,
      media: { directory: 'media', transcription: { enabled: false, maxDurationSeconds: 30 } },
    }, area.directory);
    assert.deepEqual({ ...legacy.media.transcription }, { enabled: false, maxDurationSeconds: 30 });
  } finally {
    await area.cleanup();
  }
});

test('whisper-cli route probes, decodes locally and runs the engine with VAD', { timeout: 20_000 }, async () => {
  const area = await scratch('happy');
  const before = await leftoverTempDirs();
  try {
    const set = await engineSet(area);
    const audio = await audioFile(area);
    const transcriber = createTranscriber({ backend: 'whisper-cli', whisperCli: set.engine });
    assert.deepEqual(await transcriber.transcribe(audio), { ok: true, text: 'EXPECTED-TRANSCRIPT' });

    const probeArgs = await set.args(set.paths.probeArgs);
    assert.equal(probeArgs.at(-1), audio);
    assert.ok(probeArgs.includes('-protocol_whitelist'));

    const decodeArgs = await set.args(set.paths.decodeArgs);
    assert.equal(decodeArgs.includes('-protocol_whitelist'), true);
    assert.equal(decodeArgs[decodeArgs.indexOf('-protocol_whitelist') + 1], 'file');
    assert.ok(decodeArgs.includes('-nostdin'));
    assert.ok(decodeArgs.includes('-fs'));
    assert.equal(decodeArgs[decodeArgs.indexOf('-i') + 1], audio);

    const engineArgs = await set.args(set.paths.argsFile);
    assert.equal(engineArgs[engineArgs.indexOf('-m') + 1], set.engine.model);
    assert.equal(engineArgs[engineArgs.indexOf('-vm') + 1], set.engine.vadModel);
    assert.ok(engineArgs.includes('--vad'));
    assert.ok(engineArgs.includes('-np'));
    assert.ok(engineArgs.includes('-nt'));
    // The CLI default is English; an absent hint must stay auto-detect.
    assert.equal(engineArgs[engineArgs.indexOf('-l') + 1], 'auto');
    // The decoded WAV is a private temporary file, and it is gone afterwards.
    assert.notEqual(engineArgs[engineArgs.indexOf('-f') + 1], audio);
    assert.ok(engineArgs[engineArgs.indexOf('-f') + 1].includes(TEMP_PREFIX));
    assert.deepEqual(await leftoverTempDirs(), before);
  } finally {
    await area.cleanup();
  }
});

test('a configured language hint reaches the engine', { timeout: 20_000 }, async () => {
  const area = await scratch('language');
  try {
    const set = await engineSet(area);
    const audio = await audioFile(area);
    const transcriber = createTranscriber({ backend: 'whisper-cli', whisperCli: set.engine, language: 'de' });
    assert.equal((await transcriber.transcribe(audio)).ok, true);
    const engineArgs = await set.args(set.paths.argsFile);
    assert.equal(engineArgs[engineArgs.indexOf('-l') + 1], 'de');
  } finally {
    await area.cleanup();
  }
});

test('duration metadata is refused, not truncated, before decoding', { timeout: 20_000 }, async () => {
  const area = await scratch('duration');
  try {
    const set = await engineSet(area, { duration: '500.0' });
    const audio = await audioFile(area);
    const transcriber = createTranscriber({
      backend: 'whisper-cli',
      whisperCli: set.engine,
      maxDurationSeconds: 120,
    });
    assert.deepEqual(await transcriber.transcribe(audio), { ok: false, reason: 'too-large' });
    assert.equal(await exists(set.paths.decodeMarker), false);
    assert.equal(await exists(set.paths.engineMarker), false);
  } finally {
    await area.cleanup();
  }
});

test('the decoded PCM size is itself a refusal fence when metadata lies', { timeout: 20_000 }, async () => {
  const area = await scratch('pcm');
  try {
    // Metadata claims half a second; the decoder writes far more than one second allows.
    const set = await engineSet(area, { duration: '0.5', pcmBytes: 64_000 });
    const audio = await audioFile(area);
    const transcriber = createTranscriber({
      backend: 'whisper-cli',
      whisperCli: set.engine,
      maxDurationSeconds: 1,
    });
    assert.deepEqual(await transcriber.transcribe(audio), { ok: false, reason: 'too-large' });
    assert.equal(await exists(set.paths.decodeMarker), true);
    // The bound is enforced before any transcript can be produced or accepted.
    assert.equal(await exists(set.paths.engineMarker), false);
  } finally {
    await area.cleanup();
  }
});

test('unparseable metadata does not skip the size fence', { timeout: 20_000 }, async () => {
  const area = await scratch('noduration');
  try {
    const set = await engineSet(area, { duration: 'N/A', pcmBytes: 64_000 });
    const audio = await audioFile(area);
    const transcriber = createTranscriber({
      backend: 'whisper-cli',
      whisperCli: set.engine,
      maxDurationSeconds: 1,
    });
    assert.deepEqual(await transcriber.transcribe(audio), { ok: false, reason: 'too-large' });
    assert.equal(await exists(set.paths.engineMarker), false);
  } finally {
    await area.cleanup();
  }
});

test('the input size cap applies to every caller, not just Telegram', { timeout: 20_000 }, async () => {
  const area = await scratch('input');
  try {
    const set = await engineSet(area);
    const audio = area.path('huge.oga');
    await writeFile(audio, Buffer.alloc(16, 1));
    await truncate(audio, TRANSCRIPTION_LIMITS.maxInputBytes + 1);
    const transcriber = createTranscriber({ backend: 'whisper-cli', whisperCli: set.engine });
    assert.deepEqual(await transcriber.transcribe(audio), { ok: false, reason: 'too-large' });
    assert.equal(await exists(set.paths.probeArgs), false);
  } finally {
    await area.cleanup();
  }
});

test('a missing engine or decoder is unavailable, never a transcript', { timeout: 20_000 }, async () => {
  const area = await scratch('missing');
  try {
    const set = await engineSet(area);
    const audio = await audioFile(area);
    await rm(set.engine.binary, { force: true });
    await rm(set.paths.ffmpeg, { force: true });
    const transcriber = createTranscriber({ backend: 'whisper-cli', whisperCli: set.engine });
    assert.deepEqual(await transcriber.transcribe(audio), { ok: false, reason: 'unavailable' });
  } finally {
    await area.cleanup();
  }
});

test('engine exit codes map honestly, and 4 is not too-large', { timeout: 30_000 }, async () => {
  for (const [code, reason] of [[3, 'unavailable'], [4, 'failed'], [10, 'failed'], [11, 'failed'], [1, 'failed']]) {
    const area = await scratch(`exit-${code}`);
    try {
      const set = await engineSet(area, { engineExit: code });
      const audio = await audioFile(area);
      const transcriber = createTranscriber({ backend: 'whisper-cli', whisperCli: set.engine });
      assert.deepEqual(await transcriber.transcribe(audio), { ok: false, reason }, `exit ${code}`);
    } finally {
      await area.cleanup();
    }
  }
});

test('an empty transcript is reported as empty, not as success', { timeout: 20_000 }, async () => {
  const area = await scratch('empty');
  try {
    const set = await engineSet(area, { text: '   ' });
    const audio = await audioFile(area);
    const transcriber = createTranscriber({ backend: 'whisper-cli', whisperCli: set.engine });
    assert.deepEqual(await transcriber.transcribe(audio), { ok: false, reason: 'empty' });
  } finally {
    await area.cleanup();
  }
});

test('the transcript is bounded by the output cap', { timeout: 20_000 }, async () => {
  const area = await scratch('overflow');
  try {
    const set = await engineSet(area, { text: 'x'.repeat(200) });
    const audio = await audioFile(area);
    const transcriber = createTranscriber({
      backend: 'whisper-cli',
      whisperCli: set.engine,
      maxOutputBytes: 64,
    });
    assert.deepEqual(await transcriber.transcribe(audio), { ok: false, reason: 'failed' });
  } finally {
    await area.cleanup();
  }
});

test('one deadline spans probe, decode and engine', { timeout: 30_000 }, async () => {
  const area = await scratch('deadline');
  try {
    const set = await engineSet(area, { sleepSeconds: 1 });
    const audio = await audioFile(area);
    const transcriber = createTranscriber({
      backend: 'whisper-cli',
      whisperCli: set.engine,
      timeoutMs: 1_200,
    });
    const started = Date.now();
    const outcome = await transcriber.transcribe(audio);
    const elapsed = Date.now() - started;
    assert.deepEqual(outcome, { ok: false, reason: 'timeout' });
    // Three one-second legs would need ~3 s; the single deadline stops it near 1.2 s.
    assert.ok(elapsed >= 900, `elapsed ${elapsed}`);
    assert.ok(elapsed < 2_600, `elapsed ${elapsed}`);
  } finally {
    await area.cleanup();
  }
});

test('cancellation kills the running leg and removes the temporary directory', { timeout: 20_000 }, async () => {
  const area = await scratch('cancel');
  const before = await leftoverTempDirs();
  try {
    const pidFile = area.path('leg.pid');
    const set = await engineSet(area);
    // Replace the probe with one that records its pid and blocks.
    await writeFile(set.paths.ffprobe, ['#!/bin/sh', `printf '%s' "$$" > "${pidFile}"`, 'sleep 30', ''].join('\n'), { mode: 0o755 });
    const audio = await audioFile(area);
    const transcriber = createTranscriber({ backend: 'whisper-cli', whisperCli: set.engine });
    const controller = new AbortController();
    const pending = transcriber.transcribe(audio, { signal: controller.signal });
    // Abort once the stub has actually started, so the running leg is the one killed.
    const deadline = Date.now() + 5_000;
    let pid = 0;
    while (pid === 0) {
      assert.ok(Date.now() < deadline, 'the probe stub never started');
      try {
        pid = Number(await readFile(pidFile, 'utf8'));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    controller.abort();
    assert.deepEqual(await pending, { ok: false, reason: 'cancelled' });
    assert.ok(pid > 0);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    assert.deepEqual(await leftoverTempDirs(), before);
  } finally {
    await area.cleanup();
  }
});

test('children get a small environment without inherited credentials', { timeout: 20_000 }, async () => {
  const area = await scratch('env');
  const dump = area.path('engine.env');
  const previous = { secret: process.env.NANOBOT_TEST_SECRET, ld: process.env.LD_LIBRARY_PATH };
  process.env.NANOBOT_TEST_SECRET = 'must-not-leak';
  process.env.LD_LIBRARY_PATH = '/opt/private-libs';
  try {
    const set = await engineSet(area);
    await writeFile(set.engine.binary, [
      '#!/bin/sh',
      `env > "${dump}"`,
      'printf "%s" "ENV-OK"',
      '',
    ].join('\n'), { mode: 0o755 });
    const audio = await audioFile(area);
    const transcriber = createTranscriber({ backend: 'whisper-cli', whisperCli: set.engine });
    assert.deepEqual(await transcriber.transcribe(audio), { ok: true, text: 'ENV-OK' });
    const seen = await readFile(dump, 'utf8');
    assert.equal(seen.includes('must-not-leak'), false);
    assert.equal(seen.includes('private-libs'), false);
    assert.equal(/^HOME=/m.test(seen), false);
    assert.equal(/^HF_HUB_OFFLINE=/m.test(seen), false);
  } finally {
    if (previous.secret === undefined) delete process.env.NANOBOT_TEST_SECRET;
    else process.env.NANOBOT_TEST_SECRET = previous.secret;
    if (previous.ld === undefined) delete process.env.LD_LIBRARY_PATH;
    else process.env.LD_LIBRARY_PATH = previous.ld;
    await area.cleanup();
  }
});

test('the backend is opt-in for direct callers too', { timeout: 20_000 }, async () => {
  const area = await scratch('optin');
  try {
    const set = await engineSet(area);
    assert.throws(
      () => createTranscriber({ whisperCli: set.engine }),
      /requires backend "whisper-cli"/,
    );
    assert.throws(
      () => createTranscriber({ backend: 'whisper-cli' }),
      /requires media\.transcription\.whisperCli/,
    );
    assert.throws(
      () => createTranscriber({ backend: 'other' }),
      /unknown media\.transcription\.backend/,
    );
    assert.throws(
      () => createTranscriber({ backend: 'whisper-cli', whisperCli: { ...set.engine, binary: 'whisper-cli' } }),
      /must be an absolute path/,
    );
    // The legacy route never gains the new engine implicitly.
    const uv = await stub(area, 'fake-uv', 'printf "%s" "LEGACY"');
    assert.deepEqual(await createTranscriber({ uvPath: uv }).transcribe(await audioFile(area)), { ok: true, text: 'LEGACY' });
  } finally {
    await area.cleanup();
  }
});

test('a disabled transcriber spawns nothing on either route', { timeout: 20_000 }, async () => {
  const area = await scratch('disabled');
  try {
    const set = await engineSet(area);
    const audio = await audioFile(area);
    for (const options of [
      { backend: 'whisper-cli', whisperCli: set.engine, enabled: false },
      { uvPath: set.paths.whisperCli, enabled: false },
    ]) {
      const transcriber = createTranscriber(options);
      assert.equal(transcriber.enabled, false);
      assert.deepEqual(await transcriber.transcribe(audio), { ok: false, reason: 'unavailable' });
    }
    assert.equal(await exists(set.paths.probeArgs), false);
  } finally {
    await area.cleanup();
  }
});

// --- Hex route -------------------------------------------------------------

/**
 * One fake Hex install: the engine binary plus the same controlled decoder stubs.
 * `hex` is driven only through `model transcribe`, so its argv is the contract.
 */
async function hexEngineSet(area, options = {}) {
  const {
    duration = '11.0',
    probeExit = 0,
    pcmBytes = 1024,
    decodeExit = 0,
    text = 'HEX-TRANSCRIPT',
    engineExit = 0,
  } = options;
  const argsFile = area.path('hex.args');
  const probeArgs = area.path('probe.args');
  const decodeArgs = area.path('decode.args');
  const engineMarker = area.path('hex.ran');

  const ffprobe = await stub(area, 'fake-ffprobe', [
    `printf '%s\\n' "$@" > "${probeArgs}"`,
    `printf '%s\\n' "${duration}"`,
    `exit ${probeExit}`,
  ].join('\n'));

  const ffmpeg = await stub(area, 'fake-ffmpeg', [
    `printf '%s\\n' "$@" > "${decodeArgs}"`,
    'for last; do :; done',
    `dd if=/dev/zero of="$last" bs=1000 count=${Math.max(1, Math.ceil(pcmBytes / 1000))} 2>/dev/null`,
    `exit ${decodeExit}`,
  ].join('\n'));

  const binary = await stub(area, 'fake-hex', [
    `printf '%s\\n' "$@" > "${argsFile}"`,
    `: > "${engineMarker}"`,
    `printf '%s' "${text}"`,
    `exit ${engineExit}`,
  ].join('\n'));

  return {
    engine: { binary, ffmpeg, ffprobe, model: 'parakeet_unified_en' },
    paths: { argsFile, probeArgs, decodeArgs, engineMarker, ffprobe, ffmpeg, binary },
    async args(file) {
      return (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '');
    },
  };
}

test('config accepts an explicit hex engine and rejects a partial one', async () => {
  const area = await scratch('hex-config');
  const base = {
    workspace: area.path('ws'),
    dataDir: area.path('state'),
    model: { provider: 'p', modelId: 'm' },
  };
  const engine = {
    binary: '/opt/hex/hex',
    ffmpeg: '/opt/ffmpeg/bin/ffmpeg',
    ffprobe: '/opt/ffmpeg/bin/ffprobe',
    model: 'parakeet_unified_en',
  };
  try {
    const accepted = parseConfig({
      ...base,
      media: { directory: 'media', transcription: { backend: 'hex', hex: engine } },
    }, area.directory);
    assert.equal(accepted.media.transcription.backend, 'hex');
    assert.deepEqual({ ...accepted.media.transcription.hex }, engine);

    // The model id is optional: Hex then uses its own selection.
    const noModel = parseConfig({
      ...base,
      media: {
        directory: 'media',
        transcription: { backend: 'hex', hex: { binary: engine.binary, ffmpeg: engine.ffmpeg, ffprobe: engine.ffprobe } },
      },
    }, area.directory);
    assert.equal(noModel.media.transcription.hex.model, undefined);

    assert.throws(
      () => parseConfig({ ...base, media: { directory: 'media', transcription: { hex: engine } } }, area.directory),
      /required exactly when backend is hex/,
    );
    assert.throws(
      () => parseConfig({ ...base, media: { directory: 'media', transcription: { backend: 'hex' } } }, area.directory),
      /required exactly when backend is hex/,
    );
    assert.throws(
      () => parseConfig({
        ...base,
        media: { directory: 'media', transcription: { backend: 'faster-whisper', hex: engine } },
      }, area.directory),
      /required exactly when backend is hex/,
    );
    assert.throws(
      () => parseConfig({
        ...base,
        media: { directory: 'media', transcription: { backend: 'hex', hex: { ...engine, binary: 'hex' } } },
      }, area.directory),
      /hex\.binary must be an absolute path/,
    );
    assert.throws(
      () => parseConfig({
        ...base,
        media: { directory: 'media', transcription: { backend: 'hex', hex: { ...engine, extra: '/x' } } },
      }, area.directory),
      /Unknown media\.transcription\.hex field: extra/,
    );
    assert.throws(
      () => parseConfig({
        ...base,
        media: { directory: 'media', transcription: { backend: 'hex', hex: { ...engine, model: 'a b' } } },
      }, area.directory),
      /hex\.model must be a Hex model id/,
    );
    // Duration and timeout bounds are generous enough for long voice notes,
    // and both stay bounded.
    const long = parseConfig({
      ...base,
      media: { directory: 'media', transcription: { maxDurationSeconds: 3_600, timeoutMs: 900_000 } },
    }, area.directory);
    assert.equal(long.media.transcription.maxDurationSeconds, 3_600);
    assert.equal(long.media.transcription.timeoutMs, 900_000);
    assert.throws(
      () => parseConfig({
        ...base,
        media: { directory: 'media', transcription: { timeoutMs: 3_600_001 } },
      }, area.directory),
      /timeoutMs must be an integer from 1 to 3600000/,
    );
    assert.throws(
      () => parseConfig({
        ...base,
        media: { directory: 'media', transcription: { maxDurationSeconds: 3_601 } },
      }, area.directory),
      /maxDurationSeconds must be an integer from 1 to 3600/,
    );
  } finally {
    await area.cleanup();
  }
});

test('the hex route decodes locally and drives `hex model transcribe`', { timeout: 20_000 }, async () => {
  const area = await scratch('hex-happy');
  const before = await leftoverTempDirs();
  try {
    const set = await hexEngineSet(area);
    const audio = await audioFile(area);
    const transcriber = createTranscriber({ backend: 'hex', hex: set.engine });
    assert.deepEqual(await transcriber.transcribe(audio), { ok: true, text: 'HEX-TRANSCRIPT' });

    const decodeArgs = await set.args(set.paths.decodeArgs);
    assert.equal(decodeArgs[decodeArgs.indexOf('-protocol_whitelist') + 1], 'file');
    assert.equal(decodeArgs[decodeArgs.indexOf('-i') + 1], audio);
    assert.ok(decodeArgs.includes('-fs'));

    const engineArgs = await set.args(set.paths.argsFile);
    assert.deepEqual(engineArgs.slice(0, 2), ['model', 'transcribe']);
    assert.equal(engineArgs[engineArgs.indexOf('--model') + 1], 'parakeet_unified_en');
    // No language hint is configured, so none is invented.
    assert.equal(engineArgs.includes('--language'), false);
    // Hex is given the decoded temporary WAV, not the stored original.
    assert.notEqual(engineArgs.at(-1), audio);
    assert.ok(engineArgs.at(-1).includes(TEMP_PREFIX));
    assert.deepEqual(await leftoverTempDirs(), before);
  } finally {
    await area.cleanup();
  }
});

test('a hex model and language hint reach the engine, and a long note is not refused', { timeout: 20_000 }, async () => {
  const area = await scratch('hex-long');
  try {
    // Ten minutes exactly: refused just above the configured bound, accepted below it.
    const set = await hexEngineSet(area, { duration: '601.0' });
    const audio = await audioFile(area);
    const transcriber = createTranscriber({
      backend: 'hex',
      hex: set.engine,
      language: 'en',
      maxDurationSeconds: 600,
    });
    assert.deepEqual(await transcriber.transcribe(audio), { ok: false, reason: 'too-large' });
    assert.equal(await exists(set.paths.engineMarker), false);

    const generous = await scratch('hex-longer');
    try {
      const allowed = await hexEngineSet(generous, { duration: '599.0' });
      const longer = createTranscriber({
        backend: 'hex',
        hex: allowed.engine,
        language: 'en',
        maxDurationSeconds: 600,
      });
      assert.deepEqual(await longer.transcribe(audio), { ok: true, text: 'HEX-TRANSCRIPT' });
      const engineArgs = await allowed.args(allowed.paths.argsFile);
      assert.equal(engineArgs[engineArgs.indexOf('--language') + 1], 'en');
    } finally {
      await generous.cleanup();
    }
  } finally {
    await area.cleanup();
  }
});

test('hex failures map honestly and a missing binary is unavailable', { timeout: 20_000 }, async () => {
  for (const [code, reason] of [[1, 'failed'], [2, 'failed']]) {
    const area = await scratch(`hex-exit-${code}`);
    try {
      const set = await hexEngineSet(area, { engineExit: code });
      const transcriber = createTranscriber({ backend: 'hex', hex: set.engine });
      assert.deepEqual(await transcriber.transcribe(await audioFile(area)), { ok: false, reason }, `exit ${code}`);
    } finally {
      await area.cleanup();
    }
  }
  const area = await scratch('hex-missing');
  try {
    const set = await hexEngineSet(area);
    const audio = await audioFile(area);
    await rm(set.engine.binary, { force: true });
    assert.deepEqual(
      await createTranscriber({ backend: 'hex', hex: set.engine }).transcribe(audio),
      { ok: false, reason: 'unavailable' },
    );
  } finally {
    await area.cleanup();
  }
});

test('an empty hex transcript is empty, not success', { timeout: 20_000 }, async () => {
  const area = await scratch('hex-empty');
  try {
    const set = await hexEngineSet(area, { text: '  \n ' });
    assert.deepEqual(
      await createTranscriber({ backend: 'hex', hex: set.engine }).transcribe(await audioFile(area)),
      { ok: false, reason: 'empty' },
    );
  } finally {
    await area.cleanup();
  }
});

test('hex children keep HOME for their model store but inherit no credentials', { timeout: 20_000 }, async () => {
  const area = await scratch('hex-env');
  const dump = area.path('hex.env');
  const previous = { secret: process.env.NANOBOT_TEST_SECRET, ld: process.env.LD_LIBRARY_PATH };
  process.env.NANOBOT_TEST_SECRET = 'must-not-leak';
  process.env.LD_LIBRARY_PATH = '/opt/private-libs';
  try {
    const set = await hexEngineSet(area);
    await writeFile(set.engine.binary, [
      '#!/bin/sh',
      `env > "${dump}"`,
      'printf "%s" "ENV-OK"',
      '',
    ].join('\n'), { mode: 0o755 });
    const transcriber = createTranscriber({ backend: 'hex', hex: set.engine });
    assert.deepEqual(await transcriber.transcribe(await audioFile(area)), { ok: true, text: 'ENV-OK' });
    const seen = await readFile(dump, 'utf8');
    // Hex resolves its own data directory (and models) from the operator's home.
    if (process.env.HOME !== undefined) assert.equal(/^HOME=/m.test(seen), true);
    assert.equal(seen.includes('must-not-leak'), false);
    assert.equal(seen.includes('private-libs'), false);
    assert.equal(/^HF_HUB_OFFLINE=/m.test(seen), false);
  } finally {
    if (previous.secret === undefined) delete process.env.NANOBOT_TEST_SECRET;
    else process.env.NANOBOT_TEST_SECRET = previous.secret;
    if (previous.ld === undefined) delete process.env.LD_LIBRARY_PATH;
    else process.env.LD_LIBRARY_PATH = previous.ld;
    await area.cleanup();
  }
});

test('the hex backend stays opt-in and never widens the other routes', { timeout: 20_000 }, async () => {
  const area = await scratch('hex-optin');
  try {
    const set = await hexEngineSet(area);
    assert.throws(() => createTranscriber({ hex: set.engine }), /requires backend "hex"/);
    assert.throws(() => createTranscriber({ backend: 'hex' }), /requires media\.transcription\.hex/);
    assert.throws(
      () => createTranscriber({ backend: 'whisper-cli', hex: set.engine }),
      /hex requires backend "hex"/,
    );
    assert.throws(
      () => createTranscriber({ backend: 'hex', hex: { ...set.engine, ffprobe: 'ffprobe' } }),
      /must be an absolute path/,
    );
    const audio = await audioFile(area);
    const disabled = createTranscriber({ backend: 'hex', hex: set.engine, enabled: false });
    assert.deepEqual(await disabled.transcribe(audio), { ok: false, reason: 'unavailable' });
    assert.equal(await exists(set.paths.probeArgs), false);
  } finally {
    await area.cleanup();
  }
});
