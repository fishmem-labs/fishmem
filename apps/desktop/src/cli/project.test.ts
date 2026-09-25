import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectProject } from "./project";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function temp() {
	const root = await mkdtemp(join(tmpdir(), "fishmem-project-"));
	roots.push(root);
	return root;
}

describe("detectProject", () => {
	it("uses the git repository root name from any subdirectory", async () => {
		const root = await temp();
		const repo = join(root, "acme-api");
		await mkdir(join(repo, ".git"), { recursive: true });
		await mkdir(join(repo, "src", "routes"), { recursive: true });
		expect(detectProject(join(repo, "src", "routes"), { home: root })).toBe(
			"acme-api",
		);
	});

	it("maps a linked worktree to its main repository", async () => {
		const root = await temp();
		const main = join(root, "acme-api");
		const gitDir = join(main, ".git", "worktrees", "feature-x");
		await mkdir(gitDir, { recursive: true });
		await writeFile(join(gitDir, "commondir"), "../..\n");
		const worktree = join(root, "worktrees", "feature-x");
		await mkdir(worktree, { recursive: true });
		await writeFile(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
		expect(detectProject(worktree, { home: root })).toBe("acme-api");
	});

	it("falls back to the directory name outside git and to none at home", async () => {
		const root = await temp();
		const plain = join(root, "notes");
		await mkdir(plain);
		expect(detectProject(plain, { home: root })).toBe("notes");
		expect(detectProject(root, { home: root })).toBeUndefined();
		expect(detectProject("/", { home: root })).toBeUndefined();
	});
});
