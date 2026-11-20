#!/usr/bin/env node
// Browser check for the "Incomplete" marker on split ("long answer") messages
// (protocol v2, "Long messages"): ask the mock for a long answer N times on
// fresh threads, wait for the turn to go idle, then record every `.msg-partial`
// in the DOM, each row's message id and how many of its parts arrived, whether
// one message id produced duplicate rows, and whether the joined answer is
// rendered in full.
//
//   node dev/long-answer-partial.mjs [runs]
//
// Needs a built dist/ (`npm run build`). The mock and `vite preview` run on
// free ports (never 8791/4173/8452/43190) and are killed by PID afterwards.
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "/home/gergo/projects/mobile-pi/node_modules/playwright/index.mjs";

const RUNS = Number(process.argv[2] ?? 10);
const IDLE_GRACE_MS = 800;
const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const PAIR_CODE = "ABCDEFGH";

// The mock's long answer (`longAnswer` in mock-gateway.mjs): every paragraph
// carries this sentence, but the rendered markdown puts the list numbers in CSS
// markers, so the paragraphs themselves are what must all be there.
const UNIT = 'Absatz mit Grüßen, 🙂👋🏽 Emoji, "Zitat" und Umlauten — 日本語.';
const PARAGRAPHS = (() => {
  const rows = ["A deliberately long answer to x, sent as parts.", ""];
  while (rows.join("\n").length < 160_000) rows.push(`${rows.length}. ${UNIT}`);
  return rows.length - 2;
})();

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

const children = [];
function start(args, env, name) {
  const child = spawn(args[0], args.slice(1), {
    cwd: APP_DIR, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  child.stdout.on("data", (d) => log.push(d.toString()));
  child.stderr.on("data", (d) => log.push(d.toString()));
  const handle = { child, log, name };
  children.push(handle);
  return handle;
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

const mockPort = await freePort();
const appPort = await freePort();
start(["node", "dev/mock-gateway.mjs", PAIR_CODE], { PORT: String(mockPort), NO_PUSH: "1", IDLE_ARCHIVE_MS: "0" }, "mock");
start(
  ["node_modules/.bin/vite", "preview", "--host", "127.0.0.1", "--port", String(appPort), "--strictPort"],
  { MOCK_PORT: String(mockPort) },
  "preview",
);

let browser;
const results = [];
try {
  await waitForPort(mockPort);
  await waitForPort(appPort);
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("page error:", err.message));
  page.on("console", (msg) => { if (msg.type() === "error") console.error("console:", msg.text()); });

  await page.goto(`http://127.0.0.1:${appPort}/`);
  // A fresh browser has no device cookie: the stream answers 4401 and the app
  // shows the pairing screen (which can briefly look like chat while booting).
  await page.waitForSelector("#pair-code", { timeout: 20_000 });
  await page.fill("#pair-code", PAIR_CODE);
  await page.fill("#pair-label", "check");
  await page.click("button.primary");
  await page.waitForSelector('textarea[aria-label="Message"]', { timeout: 20_000 });

  for (let run = 1; run <= RUNS; run++) {
    await page.getByRole("button", { name: /New thread/ }).click();
    await page.fill("#thread-title", `long ${run}`);
    await page.getByRole("button", { name: "Create thread" }).click();
    // The new thread is open once its title is in the header.
    await page.waitForFunction(
      (title) => document.querySelector(".switch-title")?.textContent === title,
      `long ${run}`,
      { timeout: 20_000 },
    );
    await page.waitForSelector('textarea[aria-label="Message"]:not([disabled])');

    await page.fill('textarea[aria-label="Message"]', "please give me a long answer");
    const asked = Date.now();
    await page.click('button[aria-label="Send"]');
    // Idle means the turn is over: the joined answer and settled both applied.
    await page.waitForFunction(() => document.querySelector(".presence")?.textContent === "Online" &&
      !!document.querySelector(".msg.assistant[data-message-id]"), null, { timeout: 60_000 });
    await page.waitForTimeout(IDLE_GRACE_MS);

    const snap = await page.evaluate(async (paragraphs) => {
      const rows = [...document.querySelectorAll("[data-message-id]")].map((el) => ({
        id: el.getAttribute("data-message-id"),
        cursor: el.getAttribute("data-message-cursor"),
        chars: el.textContent?.length ?? 0,
        partial: !!el.querySelector(".msg-partial"),
        // All paragraphs of the answer, counted independent of the CSS list markers.
        full: ((el.textContent ?? "").match(/Absatz mit Grüßen/g) ?? []).length >= paragraphs,
      }));
      const counts = new Map();
      for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
      // The parts the app stored for each message, from its own event log.
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open("durable-app");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const events = await new Promise((resolve, reject) => {
        const req = db.transaction("events", "readonly").objectStore("events").getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      db.close();
      for (const row of rows) {
        const parts = events.filter((e) => e.event === "message" && e.id === row.id && e.part);
        const index = new Set(parts.map((e) => e.part.i));
        row.parts = { had: index.size, of: parts[0]?.part.n ?? 0 };
      }
      return {
        rows,
        duplicates: [...counts].filter(([, count]) => count > 1),
        markers: [...document.querySelectorAll(".msg-partial")].map((el) => ({
          rowId: el.closest("[data-message-id]")?.getAttribute("data-message-id") ?? null,
        })),
      };
    }, PARAGRAPHS);

    const strays = snap.rows.filter((row) => row.partial);
    const truncated = snap.rows.filter((row) => row.id.startsWith("a-") && !row.full);
    results.push({ run, strays, truncated, duplicates: snap.duplicates, markers: snap.markers });
    console.log(
      `run ${run}: rows=${snap.rows.length} partial=${strays.length} ` +
      `truncated=${truncated.length} duplicated=${snap.duplicates.length} took=${Date.now() - asked}ms`,
    );
    if (strays.length) console.log("  stray markers:", JSON.stringify(strays));
    if (truncated.length) console.log("  incomplete answers:", JSON.stringify(truncated));
    if (snap.duplicates.length) console.log("  duplicate rows:", JSON.stringify(snap.duplicates));
  }
} finally {
  await browser?.close().catch(() => {});
  for (const handle of children.slice().reverse()) await stop(handle);
}

const strays = results.reduce((sum, r) => sum + r.strays.length, 0);
const truncated = results.reduce((sum, r) => sum + r.truncated.length, 0);
const dupRuns = results.filter((r) => r.duplicates.length).length;
console.log(
  `\n${RUNS} runs: ${strays} stray .msg-partial marker(s), ` +
  `${truncated} incomplete answer(s), ${dupRuns} run(s) with duplicate rows`,
);
process.exitCode = strays || truncated || dupRuns ? 1 : 0;
