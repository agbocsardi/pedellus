// Shared offline harness for the app channel checks.
//
// No network beyond one loopback listener: the Gateway is real over a temporary store with a faux
// provider, the listener binds 127.0.0.1 on an ephemeral port, and a synthetic WebSocket client
// (the `ws` package itself) speaks wire protocol v2 against it. Every wait is event-driven, the
// clock is controllable for pairing expiry and the rate limit, and every handle is cleaned up by
// the test that created it.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { context, fauxModels } from './discord-harness.mjs';
export { context, fauxAssistantMessage, fauxToolCall } from './discord-harness.mjs';

const modules = join(new URL('../../', import.meta.url).pathname, 'node_modules/@earendil-works');
export const { withCancel } = await import(`${modules}/chord/dist/context/index.js`);
export const { parseConfig, loadConfig } = await import(new URL('../../dist/config.js', import.meta.url).href);
export const { openGateway } = await import(new URL('../../dist/runtime.js', import.meta.url).href);
export const { runApp, AppState, APP_CHAT_SESSION_KEY, validateOptions } = await import(
  new URL('../../dist/channels/app.js', import.meta.url).href
);
export const { APP_LIMITS, APP_CLOSE, resolveStaticPath, staticMimeType } = await import(
  new URL('../../dist/channels/app-protocol.js', import.meta.url).href
);
export const WebSocket = (await import('ws')).default;

export const WAIT_MS = 15_000;

export async function until(predicate, label, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export async function untilAsync(predicate, label, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A real Gateway over a temporary store, configured with an app block (no channel auto-start). */
export async function openAppStore(label, options = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), `nanobot-app-${label}-`));
  try {
    const workspace = join(directory, 'workspace');
    const staticRoot = options.staticRoot ?? await makeStaticRoot(directory);
    await mkdir(workspace, { recursive: true });
    for (const [relativePath, content] of Object.entries(options.files ?? {})) {
      const path = join(workspace, ...relativePath.split('/'));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
    const captured = [];
    const { models, gate } = fauxModels(captured, options);
    const model = { provider: 'fixture', modelId: 'alpha' };
    const raw = {
      workspace,
      dataDir: join(directory, 'state'),
      model,
      allowedModels: [model],
      toolAllowlist: options.tools ?? [],
      ...(options.cron === true ? { cron: { enabled: true } } : {}),
      ...(options.followUpMode === undefined ? {} : { followUpMode: options.followUpMode }),
      app: { port: 43190, staticRoot, ...(options.appBlock ?? {}) },
    };
    let config;
    if (options.rawConfig !== undefined) {
      config = options.rawConfig(raw, staticRoot);
    } else {
      config = parseConfig(raw, directory);
    }
    const gateway = await openGateway(config, context, { models, ...options.gatewayOptions });
    return {
      directory,
      workspace,
      staticRoot,
      config,
      gateway,
      captured,
      gate,
      setAnswer(text) { gate.setAnswer(text); },
      script(steps) { gate.script(steps); },
      async close() {
        await gateway.close(context).catch(() => undefined);
        if (!options.keepDirectory) await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** A built PWA directory: index.html, sw.js, one script and one icon. */
export async function makeStaticRoot(directory) {
  const root = join(directory, 'pwa');
  await mkdir(join(root, 'icons'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<!doctype html><title>synthetic app</title>\n');
  await writeFile(join(root, 'sw.js'), 'self.addEventListener("install", () => {});\n');
  await writeFile(join(root, 'app.js'), 'console.log("synthetic");\n');
  await writeFile(join(root, 'style.css'), 'body { margin: 0; }\n');
  await writeFile(join(root, 'manifest.webmanifest'), JSON.stringify({ name: 'synthetic' }));
  await writeFile(join(root, 'icons', 'icon.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  return root;
}

/** Start the real adapter over the real gateway with a controllable clock and ephemeral port. */
export function startApp(store, options = {}) {
  const scope = withCancel(context);
  const clock = { now: options.now ?? Date.now() };
  let portResolve;
  const port = new Promise((resolvePort) => { portResolve = resolvePort; });
  const adapter = runApp(options.gateway ?? store.gateway, {
    port: options.port ?? 0,
    staticRoot: options.staticRoot ?? store.staticRoot,
    ...(options.followUpMode === undefined ? {} : { followUpMode: options.followUpMode }),
    autoArchiveDays: options.autoArchiveDays ?? store.config.app.autoArchiveDays,
    agentName: options.agentName ?? store.config.app.agentName,
    ...(options.scanIntervalMs === undefined ? {} : { scanIntervalMs: options.scanIntervalMs }),
    ...(options.restart === undefined ? {} : { restart: options.restart }),
    now: () => clock.now,
    onListening: (bound) => portResolve(bound),
  }, scope.context);
  return {
    scope,
    adapter,
    port,
    clock,
    async stop() {
      scope.cancel(new DOMException('test finished', 'AbortError'));
      await adapter.catch(() => undefined);
    },
  };
}

/** POST /v1/pair over real loopback HTTP; returns status, body and the raw set-cookie header. */
export async function postPair(base, code, label) {
  const response = await fetch(`${base}/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, label }),
  });
  let body = null;
  if (response.status !== 204) {
    body = await response.json().catch(() => null);
  }
  return { status: response.status, body, cookie: response.headers.get('set-cookie') };
}

/**
 * One synthetic device client over a real WebSocket: frames in, frames out, with event-driven
 * collection and helpers for requests. `cookie` authenticates; absent connects unpaired.
 */
export function deviceClient(base, cookie) {
  const socket = cookie === undefined
    ? new WebSocket(`${base.replace(/^http/, 'ws')}/v1/stream`)
    : new WebSocket(`${base.replace(/^http/, 'ws')}/v1/stream`, { headers: { cookie } });
  const frames = [];
  const closed = { code: undefined, reason: undefined };
  const waiters = [];
  const collect = () => {
    for (;;) {
      const index = waiters.findIndex((waiter) => waiter.predicate());
      if (index < 0) return;
      waiters.splice(index, 1)[0].resolve();
    }
  };
  socket.on('message', (data) => {
    frames.push(JSON.parse(data.toString()));
    collect();
  });
  socket.on('close', (code, reason) => {
    closed.code = code;
    closed.reason = reason.toString();
    collect();
  });
  socket.on('unexpected-response', () => collect());
  return {
    socket,
    frames,
    closed,
    send(value) {
      socket.send(typeof value === 'string' ? value : JSON.stringify(value));
    },
    async open() {
      await new Promise((resolveOpen, rejectOpen) => {
        socket.once('open', resolveOpen);
        socket.once('error', rejectOpen);
        socket.once('unexpected-response', rejectOpen);
      });
    },
    events(name) {
      return frames.filter((frame) => frame.type === 'event' && frame.event === name);
    },
    response(id) {
      return frames.find((frame) => frame.type === 'res' && frame.id === id);
    },
    async wait(predicate, label, timeoutMs = WAIT_MS) {
      await until(predicate, label, timeoutMs);
    },
    async close() {
      await new Promise((resolveClose) => {
        if (socket.readyState === WebSocket.CLOSED) resolveClose();
        else socket.once('close', resolveClose);
        socket.close();
      });
    },
  };
}

/** The committed app channel state, for direct assertions and seeding. */
export async function appState(gateway) {
  const conversation = await gateway.conversationFor('app:channel-state', context);
  return conversation.commit(async (tx) => {
    const doc = await tx.doc(AppState, conversation.id);
    return JSON.parse(JSON.stringify(doc));
  }, context);
}

/** Seed durable events directly, as an earlier session of this channel would have left them. */
export async function seedEvents(gateway, count) {
  const conversation = await gateway.conversationFor('app:channel-state', context);
  await conversation.commit(async (tx) => {
    const doc = await tx.doc(AppState, conversation.id);
    for (let index = 0; index < count; index += 1) {
      const cursor = doc.nextCursor;
      doc.nextCursor = cursor + 1;
      doc.events.push({
        event: 'message',
        cursor,
        id: `seed:${cursor}`,
        role: 'notice',
        text: `seeded event ${cursor}`,
        at: new Date(0).toISOString(),
      });
    }
  }, context);
}

export function userTexts(captured) {
  return captured
    .filter((entry) => entry.messages.at(-1)?.role === 'user')
    .map((entry) => {
      const message = entry.messages.at(-1);
      return typeof message.content === 'string'
        ? message.content
        : message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
    });
}

export { assert };
