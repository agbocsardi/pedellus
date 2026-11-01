import assert from "node:assert/strict";
import test from "node:test";
import { createRegistry } from "@earendil-works/pi-durable";
import { createContextExtension, renderNanobotIdentity } from "../dist/context/index.js";

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

test("identity rejects unsupported policy and unsafe paths", () => {
  assert.throws(() => renderNanobotIdentity({
    runtime: "runtime",
    workspacePath: "/safe/root",
    platformPolicy: "## Policy\\nMust not silently disappear",
  }), /Platform policy is not part/);

  for (const workspacePath of ["/safe\n## injected", "/safe\rroot", "/safe\u0000root", "/safe\u007froot"]) {
    assert.throws(() => renderNanobotIdentity({ runtime: "runtime", workspacePath }), /control characters/);
  }
});

test("large identity survives native context composition including escaped provenance", () => {
  const runtimeTail = "RUNTIME_END";
  const identity = renderNanobotIdentity({
    runtime: `${"x".repeat(60_000)}${runtimeTail}`,
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
  assert.ok([...composed].filter((character) => character === "x").length === 60_000);
  assert.ok(composed.includes(runtimeTail));
  assert.ok(composed.includes("Your workspace is at: /safe/root"));
  assert.doesNotMatch(composed, /truncated/);
});

test("snapshots map only to their conversation and are copied at construction", () => {
  const snapshots = [{
    conversationId: 1,
    identity: { source: "synthetic:first", content: "first-only identity" },
    memory: [{ source: "synthetic:first-memory", content: "first-only memory" }],
  }, {
    conversationId: 2,
    identity: { source: "synthetic:second", content: "second-only identity" },
  }];
  const extension = createContextExtension(snapshots);
  snapshots[0].identity.content = "mutated after construction";

  const render = (key, conversationId) => {
    const promptSection = extension.sections.find(({ key: sectionKey }) => sectionKey === key);
    assert.ok(promptSection);
    return promptSection.render({ conversationId, agent: { tools: [] } }, undefined) ?? "";
  };
  assert.match(render("nanobot_identity", 1), /first-only identity/);
  assert.doesNotMatch(render("nanobot_identity", 1), /second-only|mutated/);
  assert.match(render("nanobot_identity", 2), /second-only identity/);
  assert.doesNotMatch(render("nanobot_identity", 2), /first-only/);
  assert.equal(render("nanobot_identity", 3), "");
  assert.match(render("nanobot_memory", 1), /first-only memory/);
  assert.equal(render("nanobot_memory", 2), "");
});

test("skills render as a name/description summary only, never bodies, and tools stay visibility-only", () => {
  const extension = createContextExtension([{
    conversationId: 7,
    skills: [
      { name: "always-guide", source: "synthetic:always", enabled: true, content: "---\ndescription: guide\n---\nAlways body" },
      { name: "plain-guide", source: "synthetic:plain", enabled: true, content: "Plain body" },
      { name: "disabled-guide", source: "synthetic:disabled", enabled: false, content: "Disabled body" },
    ],
    skillSummary: [
      "- **always-guide** — Always guide  `skills/always-guide/SKILL.md`",
      "- **plain-guide** — Plain guide  `skills/plain-guide/SKILL.md`",
    ].join("\n"),
  }]);
  const render = (key, agent = { tools: [] }) => {
    const promptSection = extension.sections.find(({ key: sectionKey }) => sectionKey === key);
    assert.ok(promptSection);
    return promptSection.render({ conversationId: 7, agent }, undefined) ?? "";
  };

  const skills = render("nanobot_skills");
  assert.match(skills, /## Available skills/);
  assert.match(skills, /always-guide/);
  assert.match(skills, /plain-guide/);
  assert.doesNotMatch(skills, /Always body|Plain body|Disabled body|description: guide|disabled-guide/);
  const tools = render("nanobot_tools", { tools: [{ name: "host_read" }] });
  assert.match(tools, /host_read/);
  assert.match(tools, /does not enable tools/);
  assert.doesNotMatch(tools, /read_file|web_search|Dream/i);
});

test("same Durable IDs remain isolated in dedicated registries", () => {
  const firstRegistry = createRegistry();
  const secondRegistry = createRegistry();
  const firstExtension = createContextExtension([{
    conversationId: 1,
    identity: { source: "synthetic:store-a", content: "store A" },
  }]);
  const secondExtension = createContextExtension([{
    conversationId: 1,
    identity: { source: "synthetic:store-b", content: "store B" },
  }]);
  firstRegistry.install(firstExtension);
  secondRegistry.install(secondExtension);

  const render = (registry) => {
    const selected = registry.snapshot().extension("nanobot-context");
    assert.ok(selected);
    const promptSection = selected.sections.find(({ key }) => key === "nanobot_identity");
    assert.ok(promptSection);
    return promptSection.render({ conversationId: 1, agent: { tools: [] } }, undefined);
  };
  assert.match(render(firstRegistry), /store A/);
  assert.doesNotMatch(render(firstRegistry), /store B/);
  assert.match(render(secondRegistry), /store B/);
  assert.doesNotMatch(render(secondRegistry), /store A/);
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
