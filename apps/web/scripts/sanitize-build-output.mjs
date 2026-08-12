import { readdir, rm } from "node:fs/promises";
import path from "node:path";

const outputRoot = path.resolve(process.cwd(), "dist");

function isLocalEnvironmentFile(name) {
	return (
		name === ".env" ||
		name.startsWith(".env.") ||
		name === ".dev.vars" ||
		name.startsWith(".dev.vars.")
	);
}

async function sanitize(directory) {
	let removed = 0;
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (error?.code === "ENOENT") return 0;
		throw error;
	}

	for (const entry of entries) {
		const target = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			removed += await sanitize(target);
		} else if (isLocalEnvironmentFile(entry.name)) {
			await rm(target, { force: true });
			removed += 1;
		}
	}
	return removed;
}

const removed = await sanitize(outputRoot);
console.log(`Build output sanitized (${removed} local environment files removed)`);
