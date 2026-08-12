import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifests = [
	"packages/fishmem/package.json",
	"packages/application/package.json",
	"packages/contracts/package.json",
	"packages/dashboard/package.json",
	"packages/sdk/package.json",
	"packages/python-sdk/package.json",
	"apps/desktop/package.json",
	"apps/web/package.json",
];

const values = await Promise.all(
	manifests.map(async (path) => {
		const manifest = JSON.parse(await readFile(resolve(root, path), "utf8"));
		return { path, name: manifest.name, version: manifest.version };
	}),
);
const expected = values[0]?.version;
const mismatches = values.filter((entry) => entry.version !== expected);

const pythonProject = await readFile(
	resolve(root, "packages/python-sdk/pyproject.toml"),
	"utf8",
);
const pythonVersion = pythonProject.match(/^version = "([^"]+)"$/m)?.[1];
if (pythonVersion !== expected) {
	mismatches.push({
		path: "packages/python-sdk/pyproject.toml",
		name: "fishmem (Python)",
		version: pythonVersion,
	});
}

if (!expected || mismatches.length) {
	const details = mismatches
		.map(
			(entry) =>
				`${entry.path}: ${entry.version ?? "missing"} (expected ${expected ?? "missing"})`,
		)
		.join("\n");
	throw new Error(`FishMem release versions are not aligned:\n${details}`);
}

console.log(`FishMem release manifests are aligned at ${expected}`);
