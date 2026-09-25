import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";

export type ProjectFileSystem = {
	isDirectory(path: string): boolean;
	isFile(path: string): boolean;
	readText(path: string): string | undefined;
};

const nodeFileSystem: ProjectFileSystem = {
	isDirectory(path) {
		try {
			return statSync(path).isDirectory();
		} catch {
			return false;
		}
	},
	isFile(path) {
		try {
			return statSync(path).isFile();
		} catch {
			return false;
		}
	},
	readText(path) {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return undefined;
		}
	},
};

/**
 * Derive the default Desktop project id from a working directory: the name
 * of the enclosing git repository's main worktree root (so linked worktrees
 * share one project), or the directory basename outside git. Returns
 * undefined for the home directory and filesystem root, where no project is
 * implied.
 */
export function detectProject(
	cwd: string,
	options: { home?: string; fs?: ProjectFileSystem } = {},
): string | undefined {
	const fs = options.fs ?? nodeFileSystem;
	const home = resolve(options.home ?? homedir());
	const start = resolve(cwd);
	let current = start;
	while (true) {
		const dotGit = join(current, ".git");
		if (fs.isDirectory(dotGit)) return nameOf(current, home);
		if (fs.isFile(dotGit)) {
			return nameOf(mainWorktreeRoot(current, dotGit, fs) ?? current, home);
		}
		const parent = dirname(current);
		if (parent === current || current === home) break;
		current = parent;
	}
	return nameOf(start, home);
}

function mainWorktreeRoot(
	worktree: string,
	dotGitFile: string,
	fs: ProjectFileSystem,
): string | undefined {
	const pointer = fs.readText(dotGitFile)?.match(/^gitdir:\s*(.+)\s*$/m)?.[1];
	if (!pointer) return undefined;
	const gitDir = isAbsolute(pointer) ? pointer : resolve(worktree, pointer);
	const common = fs.readText(join(gitDir, "commondir"))?.trim();
	if (!common) return undefined;
	const commonDir = isAbsolute(common) ? common : resolve(gitDir, common);
	return basename(commonDir) === ".git" ? dirname(commonDir) : undefined;
}

function nameOf(path: string, home: string): string | undefined {
	if (path === home || path === parse(path).root) return undefined;
	const name = basename(path).trim();
	return name || undefined;
}
