import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createHostExecutionEnv } from "../dist/execution/host.js";

async function withEnv(run, shell) {
	const workspace = await mkdtemp(join(tmpdir(), "nanobot-host-deadline-"));
	const env = await createHostExecutionEnv({
		workspaceRoot: workspace,
		...(shell === undefined ? {} : { shell }),
	});
	try {
		await run(env, workspace);
	} finally {
		await env.cleanup(BACKGROUND_CONTEXT);
		await rm(workspace, { recursive: true, force: true });
	}
}

test("invalid or expired caller timeouts are refused by the shared policy", { timeout: 15_000 }, async () => {
	await withEnv(async (env, workspace) => {
		const marker = join(workspace, "invalid-options-ran");
		for (const timeout of [0, -1, NaN, Infinity, null, "1", {}]) {
			const result = await env.exec(`touch ${marker}`, { timeout }, BACKGROUND_CONTEXT);
			assert.equal(result.ok, false);
			assert.equal(result.error.code, "timeout");
		}
		const exists = await env.exists(marker, BACKGROUND_CONTEXT);
		assert.equal(exists.ok, true);
		assert.equal(exists.value, false, "invalid options must not spawn the shell command");

		const expired = await env.exec("sleep 2", { timeout: 0.1 }, BACKGROUND_CONTEXT);
		assert.equal(expired.ok, false);
		assert.equal(expired.error.code, "timeout");
	});
});

test("configured shell timeout is the default and zero disables it", { timeout: 20_000 }, async () => {
	await withEnv(
		async (env) => {
			const result = await env.exec("sleep 5", undefined, BACKGROUND_CONTEXT);
			assert.equal(result.ok, false);
			assert.equal(result.error.code, "timeout");
		},
		{ timeoutSeconds: 0.5 },
	);
	await withEnv(
		async (env) => {
			const result = await env.exec("sleep 2", undefined, BACKGROUND_CONTEXT);
			assert.equal(result.ok, true);
			assert.equal(result.value.exitCode, 0);
		},
		{ timeoutSeconds: 0 },
	);
});
