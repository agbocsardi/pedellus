// grammY's Node build hands its own AbortSignal implementation to the custom fetch, while the adapter
// calls native fetch, which rejects any foreign signal. These checks use grammY's real Api and native
// fetch validation offline: the raw signal is rejected, the bridge is accepted, and an abort still
// reaches the in-flight native request. No credentials, network, sleeps or pending timers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Api, HttpError } from 'grammy';

const { telegramFetch, runTelegram } = await import(new URL('../dist/channels/telegram.js', import.meta.url).href);
const { failureDiagnostic } = await import(new URL('../dist/failure-diagnostics.js', import.meta.url).href);
const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');

const getMeResult = {
  id: 1, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot',
  can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
};

const jsonResponse = (result) => new Response(JSON.stringify({ ok: true, result }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

test('native fetch rejects grammY\'s signal while the bridge is accepted', { timeout: 10_000 }, async () => {
  let foreign;
  const api = new Api('synthetic-token', {
    apiRoot: 'https://api.telegram.org',
    timeoutSeconds: 60,
    sensitiveLogs: false,
    fetch: async (_input, init) => {
      foreign = init.signal;
      return jsonResponse(getMeResult);
    },
  });
  await api.getMe();
  assert.ok(foreign, 'grammY supplied no signal to its fetch');

  // The live failure: native fetch refuses grammY's shim signal before any network I/O.
  await assert.rejects(globalThis.fetch('data:text/plain,raw', { signal: foreign }),
    (error) => error instanceof TypeError && /instance of AbortSignal/.test(error.message));

  const response = await telegramFetch('data:text/plain,bridged', { signal: foreign });
  assert.equal(await response.text(), 'bridged');
});

test('a failed Telegram transport preserves its native cause for safe journal diagnostics', { timeout: 10_000 }, async () => {
  const original = globalThis.fetch;
  const secret = 'PRIVATE-TRANSPORT-VALUE-8892';
  const native = Object.assign(new Error(secret), { code: 'ECONNREFUSED' });
  globalThis.fetch = async () => { throw new TypeError(secret, { cause: native }); };
  try {
    await assert.rejects(runTelegram({}, { token: '123:synthetic-token', allowFrom: ['1'] }, BACKGROUND_CONTEXT), (error) => {
      assert.ok(error.cause instanceof HttpError);
      assert.equal(error.cause.error.cause, native);
      const log = failureDiagnostic(error, 'gateway.telegram');
      assert.match(log, /ECONNREFUSED/);
      assert.ok(!log.includes(secret) && !log.includes('123:synthetic-token'));
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('grammY cancellation still aborts the in-flight native request', { timeout: 10_000 }, async () => {
  const original = globalThis.fetch;
  const cancellation = new AbortController();
  let seen;
  globalThis.fetch = async (_input, init = {}) => {
    seen = init;
    return new Promise((_, reject) => {
      const aborted = () => reject(new DOMException('The operation was aborted', 'AbortError'));
      if (init.signal.aborted) return aborted();
      init.signal.addEventListener('abort', aborted, { once: true });
    });
  };
  try {
    const api = new Api('synthetic-token', {
      apiRoot: 'https://api.telegram.org',
      timeoutSeconds: 1,
      sensitiveLogs: false,
      fetch: telegramFetch,
    });
    const pending = api.getMe(cancellation.signal);
    // Synchronous: grammY's controller aborts, the bridge forwards, the transport sees it.
    cancellation.abort();
    await assert.rejects(pending, (error) =>
      error instanceof HttpError && error.error?.name === 'AbortError');
    assert.ok(seen?.signal instanceof globalThis.AbortSignal);
    assert.equal(seen.redirect, 'error');
  } finally {
    globalThis.fetch = original;
  }
});
