// Shared by the dev browser checks: the mock and `vite preview` on free ports
// (never 8791/4173/8452/43190), killed by PID afterwards, and pairing a page.
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";

export const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const APP_DIR = fileURLToPath(new URL("..", import.meta.url));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForPort(port, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const ok = await new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => { socket.destroy(); resolve(false); });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`port ${port} never opened`);
}

function start(args, env, name) {
  const child = spawn(args[0], args.slice(1), {
    cwd: APP_DIR, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  child.stdout.on("data", (d) => log.push(d.toString()));
  child.stderr.on("data", (d) => log.push(d.toString()));
  return { child, log, name };
}

/** Kill what this script started, by PID; a preview server ignores SIGTERM. */
async function stop({ child, log, name }) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
  if (process.env.DEBUG_CHILD) console.error(`--- ${name} ---\n${log.join("")}`);
}

/**
 * Start the mock (with `mockEnv`, paired by `code`) and a preview of the built dist/. Returns the
 * app's URL and `stopAll`, which the caller must await in a `finally`.
 */
export async function startStack(code, mockEnv = {}) {
  const mockPort = await freePort();
  const appPort = await freePort();
  const children = [
    start(["node", "dev/mock-gateway.mjs", code], { PORT: String(mockPort), NO_PUSH: "1", IDLE_ARCHIVE_MS: "0", ...mockEnv }, "mock"),
    start(
      ["node_modules/.bin/vite", "preview", "--host", "127.0.0.1", "--port", String(appPort), "--strictPort"],
      { MOCK_PORT: String(mockPort) },
      "preview",
    ),
  ];
  const stopAll = async () => { for (const handle of children.slice().reverse()) await stop(handle); };
  try {
    await waitForPort(mockPort);
    await waitForPort(appPort);
  } catch (err) {
    await stopAll();
    throw err;
  }
  return { url: `http://127.0.0.1:${appPort}/`, stopAll };
}

/** Pair a fresh page with the mock's code and wait for the composer. */
export async function pair(page, url, code) {
  await page.goto(url);
  // A fresh browser has no device cookie: the stream answers 4401 and the app
  // shows the pairing screen (which can briefly look like chat while booting).
  await page.waitForSelector("#pair-code", { timeout: 20_000 });
  await page.fill("#pair-code", code);
  await page.fill("#pair-label", "check");
  await page.click("button.primary");
  await page.waitForSelector('textarea[aria-label="Message"]', { timeout: 20_000 });
}
