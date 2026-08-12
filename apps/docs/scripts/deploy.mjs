import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const docsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(docsRoot, "../..");

const status = await capture("git", [
	"status",
	"--porcelain",
	"--untracked-files=all",
], repositoryRoot);
if (status.trim()) {
	throw new Error(
		"FishMem Docs deployment requires a clean Git worktree so the published pages are reproducible",
	);
}

const commit = (await capture("git", ["rev-parse", "HEAD"], repositoryRoot)).trim();
await run("pnpm", ["run", "build"], docsRoot);
await Promise.all(
	[
		"out/index.html",
		"out/cloud/security.html",
		"out/cloud/migrate-from-zep.html",
		"out/cookbooks/memory-evaluation.html",
		"out/integrations/langgraph.html",
	].map((file) => access(resolve(docsRoot, file))),
);
await run(
	"pnpm",
	[
		"exec",
		"wrangler",
		"deploy",
		"--message",
		`fishmem docs ${commit.slice(0, 12)}`,
	],
	docsRoot,
);

function capture(command, args, cwd) {
	return new Promise((resolveCapture, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolveCapture(stdout);
			else reject(new Error(`${command} failed with exit code ${code}: ${stderr}`));
		});
	});
}

function run(command, args, cwd) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: process.env,
			stdio: "inherit",
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolveRun();
			else reject(new Error(`${command} failed with exit code ${code}`));
		});
	});
}
