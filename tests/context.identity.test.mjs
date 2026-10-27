import assert from "node:assert/strict";
import test from "node:test";
import { CONTEXT_LIMITS, createContextExtension, renderNanobotIdentity } from "../dist/context/index.js";

const identityLimit = CONTEXT_LIMITS.sectionChars - 1_600;

test("identity rendering is deterministic and supports known channel hints", () => {
  const values = {
    runtime: "Linux x64, Python 3.12.1",
    workspacePath: "/workspace/demo",
    channel: "telegram",
  };
  const first = renderNanobotIdentity(values);
  assert.equal(renderNanobotIdentity({ ...values }), first);
  assert.match(first, /## Runtime\nLinux x64, Python 3\.12\.1/);
  assert.match(first, /Your workspace is at: \/workspace\/demo/);
  assert.match(first, /messaging app/);
  assert.doesNotMatch(first, /Dream|memory\/MEMORY|history\.jsonl|skills\//i);
  assert.doesNotMatch(first, /\b(?:message|generate_image|read_file|web_fetch|web_search)\b/i);
});

test("identity rejects unsupported policy, oversized input, and unsafe paths", () => {
  assert.throws(() => renderNanobotIdentity({
    runtime: "runtime",
    workspacePath: "/safe/root",
    platformPolicy: "## Policy\\nMust not silently disappear",
  }), /Platform policy is not part/);

  assert.throws(() => renderNanobotIdentity({
    runtime: "x".repeat(identityLimit + 1),
    workspacePath: "/safe/root",
  }), /Identity runtime exceeds/);

  for (const workspacePath of ["/safe\n## injected", "/safe\rroot", "/safe\u0000root", "/safe\u007froot"]) {
    assert.throws(() => renderNanobotIdentity({ runtime: "runtime", workspacePath }), /control characters/);
  }
});

test("near-limit identity survives native context composition including escaped provenance", () => {
  const runtimeTail = "RUNTIME_END";
  const identity = renderNanobotIdentity({
    runtime: `${"x".repeat(identityLimit - 200)}${runtimeTail}`,
    workspacePath: "/safe/root",
  });
  const extension = createContextExtension([{
    conversationId: 1,
    identity: { source: "\u2028".repeat(256), content: identity },
  }]);
  const identitySection = extension.sections.find(({ key }) => key === "nanobot_identity");
  assert.ok(identitySection);
  const composed = identitySection.render({ conversationId: 1, agent: { tools: [] } }, undefined);
  assert.ok(composed);
  assert.ok([...composed].length <= CONTEXT_LIMITS.sectionChars);
  assert.ok(composed.includes(runtimeTail));
  assert.ok(composed.includes("Your workspace is at: /safe/root"));
});

test("unknown channel hints and unknown template values remain unexpanded", () => {
  const result = renderNanobotIdentity({
    runtime: "runtime {{ unresolved }}",
    workspacePath: "/safe/root",
    channel: "unknown",
  });
  assert.match(result, /runtime \{\{ unresolved \}\}/);
  assert.doesNotMatch(result, /## Format Hint/);
});
