import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Chat-versus-imported scope rules: the digest source skips legacy-imported chats so already
// consumed history is never re-derived, while recall and search keep them.
const pkg = process.env.PI_MODEL_CANDIDATE ?? resolve(import.meta.dirname, "..");
const scope = await import(pathToFileURL(`${pkg}/dist/history/scope.js`).href);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("imported legacy session keys are recognised by their channel segment", () => {
  const legacy = [
    "telegram-legacy:8713648758",
    "websocket-legacy:0311d315-e622-4aee-8f3e-9f7a540880a5",
    "cli-legacy:direct",
  ];
  for (const key of legacy) assert.equal(scope.isLegacySessionKey(key), true, key);
});

test("current chats are not mistaken for imported history", () => {
  const current = [
    "telegram:8340077683:chat:8713648758",
    "telegram:8937654552:chat:8713648758",
    "cli:default",
    "discord:1234",
    "telegram:1:channel-state",
  ];
  for (const key of current) assert.equal(scope.isLegacySessionKey(key), false, key);
});

test("a discussion about legacy work is not an imported session", () => {
  assert.equal(scope.isLegacySessionKey("telegram:1:chat:legacy"), false);
  assert.equal(scope.isLegacySessionKey("legacy"), false);
});

test("state-only conversations remain excluded from chat scope", () => {
  assert.equal(scope.isChatSessionKey("telegram:1:channel-state"), false);
  assert.equal(scope.isChatSessionKey("telegram:1:chat:2"), true);
});

for (const { name, fn } of tests) {
  await fn();
  console.log(`✔ ${name}`);
}
console.log(`\n${tests.length} passed`);
