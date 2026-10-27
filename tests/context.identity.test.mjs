import assert from "node:assert/strict";
import test from "node:test";
import { CONTEXT_LIMITS, renderNanobotIdentity } from "../dist/context/index.js";

test("identity rendering is deterministic and supports known channel hints", () => {
  const values = {
    runtime: "Linux x64, Python 3.12.1",
    workspacePath: "/workspace/demo",
    platformPolicy: "## Policy\nUse safe paths.",
    channel: "telegram",
  };
  const first = renderNanobotIdentity(values);
  assert.equal(renderNanobotIdentity({ ...values }), first);
  assert.match(first, /## Runtime\nLinux x64, Python 3\.12\.1/);
  assert.match(first, /Your workspace is at: \/workspace\/demo/);
  assert.match(first, /messaging app/);
  assert.match(first, /## Policy\nUse safe paths\./);
  assert.doesNotMatch(first, /Dream|memory\/MEMORY|history\.jsonl|skills\//i);
  assert.doesNotMatch(first, /\b(?:message|generate_image|read_file|web_fetch|web_search)\b/i);
});

test("identity renderer rejects over-limit input/output and unsafe workspace paths", () => {
  assert.throws(() => renderNanobotIdentity({
    runtime: "x".repeat(CONTEXT_LIMITS.sectionChars + 1),
    workspacePath: "/safe/root",
  }), /Identity runtime exceeds/);

  const platformPolicy = "P".repeat(CONTEXT_LIMITS.sectionChars - 20);
  assert.throws(() => renderNanobotIdentity({
    runtime: "runtime",
    workspacePath: "/safe/root",
    platformPolicy,
  }), /Rendered identity exceeds/);

  const policy = "## Policy\nNever omit this policy.";
  const accepted = renderNanobotIdentity({ runtime: "runtime", workspacePath: "/safe/root", platformPolicy: policy });
  assert.ok(accepted.endsWith(policy));

  for (const workspacePath of ["/safe\n## injected", "/safe\rroot", "/safe\u0000root", "/safe\u007froot"]) {
    assert.throws(() => renderNanobotIdentity({ runtime: "runtime", workspacePath }), /control characters/);
  }
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
