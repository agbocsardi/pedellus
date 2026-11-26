#!/usr/bin/env node
// Browser check for the phone's thread bubbles, against the mock's DEMO_THREADS:
// Main open shows the five newest open side threads (archived and the sixth left
// out); a side thread open shows Main first and leaves itself out; a focused
// composer hides the row; from 900px there is no row.
//
//   node dev/thread-bubbles.mjs [screenshot-dir]
//
// Needs a built dist/ (`npm run build`). With a directory, it also saves phone
// screenshots (light and dark, Main and a side thread open) and a wide one.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, pair, startStack } from "./browser-harness.mjs";

const PAIR_CODE = "BCDEFGHJ";
const SHOTS = process.argv[2];
const PHONE = { width: 390, height: 844 };
const failures = [];

function expect(what, actual, wanted) {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted);
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what), console.log(`     got  ${JSON.stringify(actual)}\n     want ${JSON.stringify(wanted)}`);
}

const bubbles = (page) => page.$$eval(".thread-bubbles .thread-bubble", (els) =>
  els.map((el) => [el.querySelector(".thread-bubble-face")?.firstChild?.textContent,
    el.querySelector(".thread-bubble-caption")?.textContent, el.getAttribute("aria-label")]));

async function shoot(page, name) {
  if (!SHOTS) return;
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({ path: join(SHOTS, `${name}-${colorScheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const stack = await startStack(PAIR_CODE, { DEMO_THREADS: "1" });
let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, hasTouch: true });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("page error:", err.message));
  await pair(page, stack.url, PAIR_CODE);
  // Statuses follow the replay, so the running thread is the last thing to settle.
  await page.waitForSelector('.thread-bubble[data-signal="running"]', { timeout: 20_000 });

  expect("Main open: five newest open side threads, archived and sixth left out", await bubbles(page), [
    ["🪪", "Check", "🪪 Check, Unread"],
    ["✈️", "Book", "Flights to Lisbon, Unread, Running"],
    ["T", "Tax receipts 2026", "Tax receipts 2026, Unread"],
    ["🚲", "Bike repair", "🚲 Bike repair"],
    ["🧾", "Compare", "Phone plans"],
  ]);
  await shoot(page, "phone-main");

  await page.getByRole("button", { name: "Tax receipts 2026, Unread" }).click();
  await page.waitForFunction(() => document.querySelector(".switch-title")?.textContent === "Tax receipts 2026");
  await page.waitForFunction(() => document.querySelector(".thread-bubbles .thread-bubble")?.getAttribute("aria-label")?.startsWith("Main"));
  expect("side thread open: Main first, the open thread left out", (await bubbles(page)).map(([face]) => face),
    ["🏠", "🪪", "✈️", "🚲", "🧾"]);
  await shoot(page, "phone-side");

  await page.focus('textarea[aria-label="Message"]');
  expect("focused composer hides the row", await page.isVisible(".thread-bubbles"), false);
  await page.evaluate(() => document.activeElement?.blur());
  expect("row is back after blur", await page.isVisible(".thread-bubbles"), true);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForSelector(".sidebar");
  expect("no row from 900px", await page.$(".thread-bubbles"), null);
  await shoot(page, "wide");
} finally {
  await browser?.close().catch(() => {});
  await stack.stopAll();
}
process.exitCode = failures.length ? 1 : 0;
