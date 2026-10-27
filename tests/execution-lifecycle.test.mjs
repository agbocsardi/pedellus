import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

async function directories(store) {
	return {
		workspaces: await readdir(join(store, "workspaces")),
		admissions: await readdir(join(store, "admissions")),
		runs: await readdir(join(store, "runs")),
	};
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

test("a live published supervisor pid blocks open and removal until it exits", { timeout: 120_000 }, async () => {
	const store = await temporaryDirectory("nanobot-exec-marker-store-");
	let blocker;
	try {
		const first = await createExecutionEnv({ storageDirectory: store });
		const id = first.workspaceId;
		const marker = join(store, "runs", `${id}.launch`);
		const published = /^pid ([1-9]\d{0,9}) ([0-9a-f-]{36})$/.exec((await readFile(marker, "utf8")).trim());
		assert.ok(published, "launcher publishes its supervisor pid and nonce");
		const livePid = Number(published[1]);
		process.kill(livePid, 0);
		await first.cleanup(BACKGROUND_CONTEXT);
		assert.deepEqual(await readdir(join(store, "runs")), []);

		blocker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		await writeFile(marker, `pid ${blocker.pid} ${randomUUID()}\n`, { mode: 0o600 });
		await assert.rejects(openExecutionEnv(id, { storageDirectory: store }), /still have a live sandbox/);
		await assert.rejects(removeExecutionWorkspace(id, { storageDirectory: store }), /still have a live sandbox/);

		blocker.kill("SIGKILL");
		await new Promise((resolve) => blocker.once("exit", resolve));
		const reopened = await openExecutionEnv(id, { storageDirectory: store });
		try {
			const info = await reopened.fileInfo("/workspace", BACKGROUND_CONTEXT);
			assert.equal(info.ok, true);
		} finally {
			await reopened.cleanup(BACKGROUND_CONTEXT);
		}

		await writeFile(marker, "not-a-pid\n", { mode: 0o600 });
		await assert.rejects(openExecutionEnv(id, { storageDirectory: store }), /launch file is malformed/);
		await rm(marker);
	} finally {
		blocker?.kill("SIGKILL");
		await rm(store, { recursive: true, force: true });
	}
});

test("an unverified pending launch intent is never auto-recovered", { timeout: 120_000 }, async () => {
	const store = await temporaryDirectory("nanobot-exec-pending-store-");
	try {
		const first = await createExecutionEnv({ storageDirectory: store });
		const id = first.workspaceId;
		const marker = join(store, "runs", `${id}.launch`);
		await first.cleanup(BACKGROUND_CONTEXT);

		// Simulate an owner that died after writing the durable intent but before its launcher published a pid.
		await writeFile(marker, `pending ${randomUUID()}\n`, { mode: 0o600 });
		for (let attempt = 0; attempt < 3; attempt++) {
			await assert.rejects(openExecutionEnv(id, { storageDirectory: store }), /unverified launch intent/);
			await assert.rejects(removeExecutionWorkspace(id, { storageDirectory: store }), /unverified launch intent/);
		}
		await access(marker);
		await access(join(store, "admissions", `${id}.json`));

		// Only explicit manual reconciliation clears it.
		await rm(marker);
		const reopened = await openExecutionEnv(id, { storageDirectory: store });
		try {
			const info = await reopened.fileInfo("/workspace", BACKGROUND_CONTEXT);
			assert.equal(info.ok, true);
		} finally {
			await reopened.cleanup(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(store, { recursive: true, force: true });
	}
});

test("a failed setup rolls back its workspace and leaves no launch intent", { timeout: 120_000 }, async () => {
	const store = await temporaryDirectory("nanobot-exec-fail-store-");
	try {
		await assert.rejects(
			createExecutionEnv({ storageDirectory: store, cwd: "/workspace/does-not-exist" }),
			/cwd is not an allowed/,
		);
		const after = await directories(store);
		assert.deepEqual(after, { workspaces: [], admissions: [], runs: [] });

		const env = await createExecutionEnv({ storageDirectory: store });
		try {
			const info = await env.fileInfo("/workspace", BACKGROUND_CONTEXT);
			assert.equal(info.ok, true);
		} finally {
			await env.cleanup(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(store, { recursive: true, force: true });
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
		// The marker must outlive the owner; otherwise a crashed sandbox would be invisible to the next owner.
		await access(join(store, "runs", `${id}.launch`));
		// The owner lock is gone immediately, but the sandbox supervisor may still be alive for a moment.
		// Opening must either fail closed or wait until that supervisor is reaped; never race it silently.
		let env;
		const deadline = Date.now() + 15_000;
		while (env === undefined) {
			try {
				env = await openExecutionEnv(id, { storageDirectory: store });
			} catch (error) {
				assert.match(String(error.message), /still have a live sandbox|owned by another live process/);
				if (Date.now() > deadline) throw error;
				await delay(100);
			}
		}
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
