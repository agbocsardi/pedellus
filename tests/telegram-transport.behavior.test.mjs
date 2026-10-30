// grammY's Node build hands its own AbortSignal implementation to the custom fetch, while the adapter
// calls native fetch, which rejects any foreign signal. These checks use grammY's real Api and native
// fetch validation offline: the raw signal is rejected, the bridge is accepted, and an abort still
// reaches the in-flight native request. No credentials, network, sleeps or pending timers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Api, HttpError } from 'grammy';

const { telegramFetch } = await import(new URL('../dist/channels/telegram.js', import.meta.url).href);

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
