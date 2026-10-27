import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createExecutionEnv,
	openExecutionEnv,
	removeExecutionWorkspace,
} from "../dist/execution/index.js";

const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url));

async function temporaryDirectory(prefix) {
	return mkdtemp(join(tmpdir(), prefix));
}

async function text(env, path) {
	const result = await env.readTextFile(path, BACKGROUND_CONTEXT);
	assert.equal(result.ok, true, result.ok ? "" : result.error.message);
	return result.value;
}

test("one live owner per workspace and guarded deletion", { timeout: 120_000 }, async () => {
	const store = await temporaryDirectory("nanobot-exec-store-");
	const inputs = await temporaryDirectory("nanobot-exec-inputs-");
	try {
		await writeFile(join(inputs, "hello.txt"), "hello\n");
		const env = await createExecutionEnv({ storageDirectory: store, imports: [join(inputs, "hello.txt")] });
		const id = env.workspaceId;
		try {
			assert.equal(await text(env, "/workspace/imports/hello.txt"), "hello\n");
			await assert.rejects(openExecutionEnv(id, { storageDirectory: store }), /owned by another live process/);
			await assert.rejects(removeExecutionWorkspace(id, { storageDirectory: store }), /owned by another live process/);
		} finally {
			await env.cleanup(BACKGROUND_CONTEXT);
		}

		// Cleanup retains the workspace for reopen; it must not be re-imported or reset.
		const reopened = await openExecutionEnv(id, { storageDirectory: store });
		try {
			assert.equal(await text(reopened, "/workspace/imports/hello.txt"), "hello\n");
			await assert.rejects(removeExecutionWorkspace(id, { storageDirectory: store }), /owned by another live process/);
		} finally {
			await reopened.cleanup(BACKGROUND_CONTEXT);
		}

		await removeExecutionWorkspace(id, { storageDirectory: store });
		await assert.rejects(access(join(store, "workspaces", id)));
		await assert.rejects(access(join(store, "admissions", `${id}.json`)));
		assert.deepEqual(await readdir(join(store, "workspaces")), []);
		assert.deepEqual(await readdir(join(store, "admissions")), []);
		await assert.rejects(openExecutionEnv(id, { storageDirectory: store }));
	} finally {
		await rm(store, { recursive: true, force: true });
		await rm(inputs, { recursive: true, force: true });
	}
});

test("a killed owner releases its kernel lock without stale takeover", { timeout: 120_000 }, async () => {
	const store = await temporaryDirectory("nanobot-exec-crash-store-");
	let child;
	try {
		child = spawn(process.execPath, [join(fixtures, "hold-workspace.mjs"), store], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const id = await new Promise((resolve, reject) => {
			let output = "";
			let errors = "";
			const timer = setTimeout(() => reject(new Error(`fixture startup timed out: ${errors}`)), 60_000);
			child.stdout.on("data", (chunk) => {
				output += chunk.toString("utf8");
				const newline = output.indexOf("\n");
				if (newline !== -1) {
					clearTimeout(timer);
					resolve(JSON.parse(output.slice(0, newline)).id);
				}
			});
			child.stderr.on("data", (chunk) => {
				if (errors.length < 4096) errors += chunk.toString("utf8");
			});
			child.once("exit", (code, signal) => {
				if (code !== 0 && signal === null) {
					clearTimeout(timer);
					reject(new Error(`fixture exited ${code}: ${errors}`));
				}
			});
		});
		child.kill("SIGKILL");
		await new Promise((resolve) => child.once("exit", resolve));
		const env = await openExecutionEnv(id, { storageDirectory: store });
		try {
			const info = await env.fileInfo("/workspace", BACKGROUND_CONTEXT);
			assert.equal(info.ok, true);
			assert.equal(info.value.kind, "directory");
		} finally {
			await env.cleanup(BACKGROUND_CONTEXT);
		}
		await removeExecutionWorkspace(id, { storageDirectory: store });
		assert.deepEqual(await readdir(join(store, "workspaces")), []);
	} finally {
		child?.kill("SIGKILL");
		await rm(store, { recursive: true, force: true });
	}
});
