// grammY's Node build hands its own AbortSignal implementation to the custom fetch, while the adapter
// calls native fetch, which rejects any foreign signal. These checks use grammY's real Api and native
// fetch validation offline: the raw signal is rejected, the bridge is accepted, and an abort still
// reaches the in-flight native request. No credentials, network, sleeps or pending timers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Api, HttpError } from 'grammy';

const { telegramFetch, runTelegram } = await import(new URL('../dist/channels/telegram.js', import.meta.url).href);
const { failureDiagnostic } = await import(new URL('../dist/failure-diagnostics.js', import.meta.url).href);
const { BACKGROUND_CONTEXT, withCancel } = await import('@earendil-works/chord/context');

const getMeResult = {
  id: 1, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot',
  can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
};

const jsonResponse = (result) => new Response(JSON.stringify({ ok: true, result }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

const failureResponse = (status, description = 'Synthetic service outage') => new Response(
  JSON.stringify({ ok: false, error_code: status, description }),
  { status, headers: { 'content-type': 'application/json' } },
);

function methodOf(input) {
  const url = new URL(String(input));
  return url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
}

async function flush(rounds = 8) {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Drive the mocked clock until a real transport condition is observed; never a sleep-based wait. */
async function advanceUntil(t, predicate, label) {
  for (let round = 0; round < 60; round += 1) {
    await flush();
    if (predicate()) return;
    t.mock.timers.tick(120_000);
    await flush();
    if (predicate()) return;
  }
  throw new Error(`timed out waiting for ${label}`);
}

function heldRead(init) {
  return new Promise((_, reject) => {
    const aborted = () => reject(new DOMException('The operation was aborted', 'AbortError'));
    if (init?.signal?.aborted) return aborted();
    init?.signal?.addEventListener('abort', aborted, { once: true });
  });
}

/** Narrow host: one stable state conversation is all startup and an update-free polling loop need. */
function syntheticGateway(offset = 0) {
  let state = { offset, pending: [], controls: [], origins: {}, targets: [], actions: [] };
  const conversation = {
    id: 1,
    async commit(change) {
      const draft = JSON.parse(JSON.stringify(state));
      const result = await change({ doc: async () => draft });
      if (result !== undefined) state = result;
      return result;
    },
  };
  return {
    gateway: { async conversationFor() { return conversation; } },
    get state() { return state; },
  };
}

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

test('a non-transient Telegram transport failure preserves its native cause for safe journal diagnostics', { timeout: 10_000 }, async () => {
  const original = globalThis.fetch;
  const secret = 'PRIVATE-TRANSPORT-VALUE-8892';
  const native = Object.assign(new Error(secret), { code: 'ERR_INVALID_ARG_TYPE' });
  globalThis.fetch = async () => { throw new TypeError('synthetic local transport failure', { cause: native }); };
  try {
    await assert.rejects(runTelegram({}, { token: '123:synthetic-token', allowFrom: ['1'] }, BACKGROUND_CONTEXT), (error) => {
      assert.ok(error.cause instanceof HttpError);
      assert.equal(error.cause.error.cause, native);
      const log = failureDiagnostic(error, 'gateway.telegram');
      assert.match(log, /ERR_INVALID_ARG_TYPE/);
      assert.ok(!log.includes(secret) && !log.includes('123:synthetic-token'));
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('startup getMe survives more than five transport/5xx failures and reaches polling', { timeout: 15_000 }, async (t) => {
  const original = globalThis.fetch;
  const scope = withCancel(BACKGROUND_CONTEXT);
  let getMeCalls = 0;
  let pollingStarted = false;
  globalThis.fetch = async (input, init = {}) => {
    const method = methodOf(input);
    if (method === 'getMe') {
      getMeCalls += 1;
      if (getMeCalls === 2) return failureResponse(502);
      if (getMeCalls === 4) return new Response('{"message":"bad gateway"}', { status: 502 });
      if (getMeCalls <= 6) throw Object.assign(new Error('synthetic transport failure'), { code: 'ECONNRESET' });
      return jsonResponse(getMeResult);
    }
    if (method === 'getUpdates') {
      pollingStarted = true;
      return heldRead(init);
    }
    if (method === 'setMyCommands') return jsonResponse(true);
    throw new Error(`unexpected mocked Telegram method: ${method}`);
  };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const adapter = runTelegram(syntheticGateway().gateway, {
    token: '123:synthetic-token', allowFrom: ['1'], pollTimeoutSeconds: 1,
  }, scope.context);
  try {
    await advanceUntil(t, () => pollingStarted, 'startup retry recovery');
    assert.equal(getMeCalls, 7);
  } finally {
    scope.cancel(new DOMException('test finished', 'AbortError'));
    await adapter.catch(() => undefined);
    t.mock.timers.reset();
    globalThis.fetch = original;
  }
});

test('polling survives successive transport/5xx outages, resets backoff and preserves the durable offset', { timeout: 15_000 }, async (t) => {
  const original = globalThis.fetch;
  const warnings = console.warn;
  const infos = console.info;
  const messages = [];
  console.warn = (...args) => { messages.push(args.join(' ')); };
  console.info = (...args) => { messages.push(args.join(' ')); };
  const scope = withCancel(BACKGROUND_CONTEXT);
  const store = syntheticGateway(42);
  const offsets = [];
  let getUpdatesCalls = 0;
  let successfulPolls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const method = methodOf(input);
    if (method === 'getMe') return jsonResponse(getMeResult);
    if (method === 'getUpdates') {
      getUpdatesCalls += 1;
      offsets.push(JSON.parse(init.body).offset);
      if (getUpdatesCalls <= 8) {
        if (getUpdatesCalls === 6) {
          return new Response('<html>bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } });
        }
        if (getUpdatesCalls === 4 || getUpdatesCalls === 8) {
          return new Response(JSON.stringify({ ok: false, message: 'bad gateway' }), { status: 502 });
        }
        if (getUpdatesCalls % 2 === 0) return failureResponse(503);
        throw Object.assign(new Error('synthetic transport failure'), {
          code: getUpdatesCalls === 1 ? 'ECONNRESET' : 'ETIMEDOUT',
        });
      }
      if (getUpdatesCalls === 9 || getUpdatesCalls === 11) {
        successfulPolls += 1;
        return jsonResponse([]);
      }
      if (getUpdatesCalls === 10) return failureResponse(502);
      return heldRead(init);
    }
    if (method === 'setMyCommands') return jsonResponse(true);
    throw new Error(`unexpected mocked Telegram method: ${method}`);
  };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const adapter = runTelegram(store.gateway, {
    token: '123:synthetic-token', allowFrom: ['1'], pollTimeoutSeconds: 1,
  }, scope.context);
  try {
    await advanceUntil(t, () => getUpdatesCalls === 10, 'second polling outage');
    assert.equal(successfulPolls, 1);
    // The first episode reached the capped delay; the new one must restart at 1–1.2s.
    t.mock.timers.tick(999);
    await flush();
    assert.equal(getUpdatesCalls, 10, 'second outage retried before its base delay');
    t.mock.timers.tick(201);
    await flush();
    assert.equal(successfulPolls, 2, 'backoff did not reset after a successful poll');
    assert.equal(getUpdatesCalls, 12, 'recovered polling did not reach its next read');
    assert.equal(offsets.length, 12);
    assert.deepEqual([...new Set(offsets)], [42]);
    assert.equal(store.state.offset, 42);
    assert.deepEqual(store.state.pending, []);
    const log = messages.join('\n');
    assert.match(log, /Telegram getUpdates is retrying through a service outage\./);
    assert.equal((log.match(/is retrying through a service outage/g) ?? []).length, 2);
    assert.match(log, /Telegram getUpdates read recovered after the service outage\./);
    assert.equal((log.match(/read recovered after the service outage/g) ?? []).length, 2);
  } finally {
    scope.cancel(new DOMException('test finished', 'AbortError'));
    await adapter.catch(() => undefined);
    t.mock.timers.reset();
    globalThis.fetch = original;
    console.warn = warnings;
    console.info = infos;
  }
});

test('cancellation releases a startup retry backoff promptly and does not retry again', { timeout: 10_000 }, async (t) => {
  const original = globalThis.fetch;
  const scope = withCancel(BACKGROUND_CONTEXT);
  let getMeCalls = 0;
  globalThis.fetch = async (input) => {
    if (methodOf(input) !== 'getMe') throw new Error('unexpected mocked Telegram method');
    getMeCalls += 1;
    throw Object.assign(new Error('synthetic transport failure'), { code: 'ECONNRESET' });
  };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const adapter = runTelegram(syntheticGateway().gateway, {
    token: '123:synthetic-token', allowFrom: ['1'],
  }, scope.context);
  const stopped = new DOMException('test cancelled startup', 'AbortError');
  try {
    for (let round = 0; round < 20 && getMeCalls === 0; round += 1) await flush(1);
    assert.equal(getMeCalls, 1, 'startup read did not reach its first failed attempt');
    scope.cancel(stopped);
    await adapter;
    t.mock.timers.tick(120_000);
    await flush(20);
    assert.equal(getMeCalls, 1, 'cancelled startup retried after its backoff');
  } finally {
    scope.cancel(stopped);
    await adapter.catch(() => undefined);
    t.mock.timers.reset();
    globalThis.fetch = original;
  }
});

test('cancellation aborts an in-flight startup read instead of waiting for its timeout', { timeout: 10_000 }, async () => {
  const original = globalThis.fetch;
  const scope = withCancel(BACKGROUND_CONTEXT);
  let started = false;
  globalThis.fetch = async (_input, init = {}) => {
    started = true;
    return heldRead(init);
  };
  const adapter = runTelegram(syntheticGateway().gateway, {
    token: '123:synthetic-token', allowFrom: ['1'],
  }, scope.context);
  const stopped = new DOMException('test cancelled in-flight startup', 'AbortError');
  try {
    for (let round = 0; round < 20 && !started; round += 1) await flush(1);
    assert.ok(started, 'startup read did not start');
    scope.cancel(stopped);
    await adapter;
  } finally {
    scope.cancel(stopped);
    await adapter.catch(() => undefined);
    globalThis.fetch = original;
  }
});

for (const failedMethod of ['getMe', 'getUpdates']) {
  test(`a permanent ${failedMethod} auth failure stays fatal without an outage retry`, { timeout: 10_000 }, async () => {
    const original = globalThis.fetch;
    let failedCalls = 0;
    globalThis.fetch = async (input) => {
      const method = methodOf(input);
      if (method === failedMethod) {
        failedCalls += 1;
        return failureResponse(401, 'Unauthorized');
      }
      if (method === 'getMe') return jsonResponse(getMeResult);
      if (method === 'setMyCommands') return jsonResponse(true);
      throw new Error('unexpected mocked Telegram method');
    };
    try {
      await assert.rejects(runTelegram(syntheticGateway().gateway, {
        token: '123:synthetic-token', allowFrom: ['1'],
      }, BACKGROUND_CONTEXT), (error) => {
        assert.equal(failedCalls, 1);
        assert.equal(error.status, 401);
        assert.equal(error.method, failedMethod);
        const log = failureDiagnostic(error, 'gateway.telegram');
        assert.match(log, /401/);
        assert.ok(log.includes(failedMethod));
        assert.ok(!log.includes('123:synthetic-token'));
        return true;
      });
    } finally {
      globalThis.fetch = original;
    }
  });
}

test('non-JSON auth errors and malformed successful responses are not mistaken for outages', { timeout: 10_000 }, async () => {
  const original = globalThis.fetch;
  try {
    for (const [status, body] of [[401, '<html>unauthorized</html>'], [200, 'not JSON'],
      [200, '{"ok":false,"message":"invalid response"}']]) {
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        return new Response(body, { status });
      };
      await assert.rejects(runTelegram({}, {
        token: '123:synthetic-token', allowFrom: ['1'],
      }, BACKGROUND_CONTEXT));
      assert.equal(calls, 1, `HTTP ${status} with a malformed body was retried`);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test('cancellation releases a polling retry backoff without another read', { timeout: 10_000 }, async (t) => {
  const original = globalThis.fetch;
  const scope = withCancel(BACKGROUND_CONTEXT);
  let calls = 0;
  globalThis.fetch = async (input) => {
    const method = methodOf(input);
    if (method === 'getMe') return jsonResponse(getMeResult);
    if (method === 'setMyCommands') return jsonResponse(true);
    if (method === 'getUpdates') {
      calls += 1;
      return failureResponse(502);
    }
    throw new Error('unexpected mocked Telegram method');
  };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const adapter = runTelegram(syntheticGateway().gateway, {
    token: '123:synthetic-token', allowFrom: ['1'],
  }, scope.context);
  try {
    await flush(20);
    assert.equal(calls, 1);
    scope.cancel(new DOMException('test cancelled polling', 'AbortError'));
    await adapter;
    t.mock.timers.tick(120_000);
    await flush();
    assert.equal(calls, 1, 'cancelled polling retried after its backoff');
  } finally {
    scope.cancel(new DOMException('test finished', 'AbortError'));
    await adapter.catch(() => undefined);
    t.mock.timers.reset();
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
