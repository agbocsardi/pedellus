import assert from "node:assert/strict";
import test from "node:test";
import { renderNanobotIdentity } from "../dist/context/index.js";

test("Nanobot identity rendering is deterministic and supports known channels", () => {
  const values = {
    runtime: "Linux x64, Python 3.12.1",
    workspacePath: "/workspace/demo",
    platformPolicy: "## Policy\nUse safe paths.",
    channel: "telegram",
  };
  const first = renderNanobotIdentity(values);
  assert.equal(renderNanobotIdentity({ ...values }), first);
  assert.match(first, /## Runtime\nLinux x64, Python 3\.12\.1/);
  assert.match(first, /\/workspace\/demo\/memory\/MEMORY\.md/);
  assert.match(first, /messaging app/);
  assert.match(first, /## Policy\nUse safe paths\./);
  assert.match(first, /untrusted external data/);
});

test("identity renderer omits unsupported channel hints and performs no template expansion", () => {
  const result = renderNanobotIdentity({
    runtime: "runtime {{ unresolved }}",
    workspacePath: "/safe/root",
    channel: "unknown",
  });
  assert.match(result, /runtime \{\{ unresolved \}\}/);
  assert.doesNotMatch(result, /## Format Hint/);
});
