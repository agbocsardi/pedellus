import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, opendir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

interface ImportEntry {
	source: string;
	destination: string;
	kind: "file" | "directory";
}

const MAX_IMPORT_FILES = 10_000;
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const MAX_IMPORT_DEPTH = 64;
let importedFiles = 0;
let importedBytes = 0;

function fail(message: string): never {
	throw new Error(message);
}

function verifyEntry(entry: ImportEntry): void {
	if (entry.kind !== "file" && entry.kind !== "directory") fail("Unsupported import kind");
	if (!entry.source.startsWith("/imports/")) fail("Invalid import source path");
	const destination = relative("/workspace", join("/workspace", entry.destination));
	if (
		isAbsolute(entry.destination) ||
		destination === ".." ||
		destination.startsWith(`..${sep}`) ||
		!destination.startsWith(`imports${sep}`)
	) {
		fail("Invalid import destination path");
	}
}

async function copyRegularFile(source: string, destination: string): Promise<void> {
	const before = await lstat(source, { bigint: true });
	if (!before.isFile() || before.nlink !== 1n) fail("Imports must contain regular files without hard-link aliases");
	if (before.size > BigInt(MAX_IMPORT_BYTES)) fail("Import size limit exceeded");
	const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	let destinationHandle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const opened = await sourceHandle.stat({ bigint: true });
		if (
			!opened.isFile() ||
			opened.nlink !== 1n ||
			opened.dev !== before.dev ||
			opened.ino !== before.ino
		) {
			fail("Import file changed or has a hard-link alias");
		}
		const mode = (opened.mode & 0o111n) !== 0n ? 0o700 : 0o600;
		destinationHandle = await open(
			destination,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			mode,
		);
		const buffer = Buffer.alloc(64 * 1024);
		let offset = 0;
		while (true) {
			const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, offset);
			if (bytesRead === 0) break;
			importedBytes += bytesRead;
			if (importedBytes > MAX_IMPORT_BYTES) fail("Import size limit exceeded");
			let written = 0;
			while (written < bytesRead) {
				const result = await destinationHandle.write(buffer, written, bytesRead - written, offset + written);
				if (result.bytesWritten === 0) fail("Import copy made no write progress");
				written += result.bytesWritten;
			}
			offset += bytesRead;
		}
		const after = await sourceHandle.stat({ bigint: true });
		if (
			after.size !== opened.size ||
			after.mtimeNs !== opened.mtimeNs ||
			after.ctimeNs !== opened.ctimeNs ||
			BigInt(offset) !== opened.size
		) {
			fail("Import file changed while being copied");
		}
		await destinationHandle.chmod(mode);
		await destinationHandle.sync();
	} finally {
		await destinationHandle?.close().catch(() => undefined);
		await sourceHandle.close();
	}
}

async function copyDirectory(source: string, destination: string, depth: number): Promise<void> {
	if (depth > MAX_IMPORT_DEPTH) fail("Import directory depth limit exceeded");
	const before = await lstat(source, { bigint: true });
	if (!before.isDirectory()) fail("Imports cannot follow symbolic links or special files");
	const handle = await open(source, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const opened = await handle.stat({ bigint: true });
		if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
			fail("Import directory changed while being opened");
		}
		await mkdir(destination, { mode: 0o700 });
		const pinnedDirectory = `/proc/self/fd/${handle.fd}`;
		const directory = await opendir(pinnedDirectory);
		try {
			for await (const entry of directory) {
				importedFiles++;
				if (importedFiles > MAX_IMPORT_FILES) fail("Import file-count limit exceeded");
				const sourceChild = join(pinnedDirectory, entry.name);
				const destinationChild = join(destination, entry.name);
				const child = await lstat(sourceChild, { bigint: true });
				if (child.isDirectory()) await copyDirectory(sourceChild, destinationChild, depth + 1);
				else if (child.isFile()) await copyRegularFile(sourceChild, destinationChild);
				else fail("Imports cannot contain symbolic links or special files");
			}
		} finally {
			await directory.close().catch(() => undefined);
		}
		const after = await handle.stat({ bigint: true });
		if (
			after.dev !== opened.dev ||
			after.ino !== opened.ino ||
			after.mtimeNs !== opened.mtimeNs ||
			after.ctimeNs !== opened.ctimeNs
		) {
			fail("Import directory changed while being copied");
		}
		await chmod(destination, 0o700);
	} finally {
		await handle.close();
	}
}

async function copyImport(entry: ImportEntry): Promise<void> {
	verifyEntry(entry);
	const destination = join("/workspace", entry.destination);
	if (entry.kind === "directory") {
		await copyDirectory(entry.source, destination, 0);
		return;
	}
	const before = await lstat(entry.source, { bigint: true });
	if (!before.isFile()) fail("Imports cannot follow symbolic links or special files");
	importedFiles++;
	if (importedFiles > MAX_IMPORT_FILES) fail("Import file-count limit exceeded");
	await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
	await copyRegularFile(entry.source, destination);
}

async function main(): Promise<void> {
	const manifestPath = process.argv[2];
	if (!manifestPath || !manifestPath.startsWith("/run/")) fail("Missing import manifest");
	const manifestHandle = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
	let manifestText: string;
	try {
		manifestText = await manifestHandle.readFile("utf8");
	} finally {
		await manifestHandle.close();
	}
	const manifest = JSON.parse(manifestText) as ImportEntry[];
	if (!Array.isArray(manifest) || manifest.length > 32) fail("Invalid import manifest");
	await mkdir("/workspace/imports", { recursive: true, mode: 0o700 });
	for (const entry of manifest) await copyImport(entry);
}

if (["import-worker.js", "import-worker.mjs", "import-worker.ts"].some((suffix) => process.argv[1]?.endsWith(suffix))) {
	main().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : "unknown import failure";
		process.stderr.write(`Import rejected: ${message.slice(0, 1000)}\n`);
		process.exitCode = 1;
	});
}
