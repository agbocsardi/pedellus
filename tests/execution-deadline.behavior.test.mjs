import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createExecutionEnv } from "../dist/execution/index.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withEnv(run) {
	const store = await mkdtemp(join(tmpdir(), "nanobot-exec-deadline-"));
	const env = await createExecutionEnv({ storageDirectory: store });
	try {
		await run(env, store);
	} finally {
		await env.cleanup(BACKGROUND_CONTEXT);
		await rm(store, { recursive: true, force: true });
	}
}

test("omitted and oversized deadlines are capped by the host", { timeout: 15_000 }, async () => {
	await withEnv(async (env) => {
		for (const options of [undefined, { timeout: 60 }]) {
			const started = Date.now();
			const result = await env.exec("sleep 8", options, BACKGROUND_CONTEXT);
			assert.equal(result.ok, false);
			assert.equal(result.error.code, "timeout");
			assert.ok(Date.now() - started < 7_000, "adapter deadline should be five seconds");
		}
	});
});

test("caller cancellation remains prompt and reaps a delayed descendant", { timeout: 5_000 }, async () => {
	await withEnv(async (env, store) => {
		const marker = join(store, "descendant-survived");
		const controller = new AbortController();
		const context = { ...BACKGROUND_CONTEXT, abortSignal: controller.signal };
		const pending = env.exec(`(sleep 1; touch '${marker}') & wait`, undefined, context);
		setTimeout(() => controller.abort(), 100);
		const result = await pending;
		assert.equal(result.ok, false);
		assert.equal(result.error.code, "aborted");
		await delay(1_200);
		await assert.rejects(readFile(marker));
	});
});

test("caller timeout and output window limits are never relaxed", { timeout: 3_000 }, async () => {
	await withEnv(async (env) => {
		const short = await env.exec("sleep 2", { timeout: 0.1 }, BACKGROUND_CONTEXT);
		assert.equal(short.ok, false);
		assert.equal(short.error.code, "timeout");
		const output = [];
		const result = await env.exec("printf 'bounded\\n'", {
			timeout: 0.5,
			window: { maxBytes: 8, maxLines: 1, minIntervalMs: 100, bytesPerSecond: 32 },
			onOutput: (chunk) => output.push(chunk),
		}, BACKGROUND_CONTEXT);
		assert.equal(result.ok, true);
		assert.equal(result.value.exitCode, 0);
		assert.ok(output.join("").includes("bounded"));
	});
});
