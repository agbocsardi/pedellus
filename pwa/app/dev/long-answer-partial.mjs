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
import { chromium, pair, startStack } from "./browser-harness.mjs";

const RUNS = Number(process.argv[2] ?? 10);
const IDLE_GRACE_MS = 800;
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

const stack = await startStack(PAIR_CODE);
let browser;
const results = [];
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("page error:", err.message));
  page.on("console", (msg) => { if (msg.type() === "error") console.error("console:", msg.text()); });
  await pair(page, stack.url, PAIR_CODE);

  for (let run = 1; run <= RUNS; run++) {
    // New threads are created untitled, without a form.
    await page.getByRole("button", { name: /^New thread Start/ }).click();
    // The new thread is open once the header names it and it has no messages yet.
    await page.waitForFunction(
      () => document.querySelector(".switch-title")?.textContent === "New thread" &&
        !document.querySelector(".msg[data-message-id]"),
      null,
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
  await stack.stopAll();
}

const strays = results.reduce((sum, r) => sum + r.strays.length, 0);
const truncated = results.reduce((sum, r) => sum + r.truncated.length, 0);
const dupRuns = results.filter((r) => r.duplicates.length).length;
console.log(
  `\n${RUNS} runs: ${strays} stray .msg-partial marker(s), ` +
  `${truncated} incomplete answer(s), ${dupRuns} run(s) with duplicate rows`,
);
process.exitCode = strays || truncated || dupRuns ? 1 : 0;
