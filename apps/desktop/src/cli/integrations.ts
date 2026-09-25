import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export type IntegrationSources = {
	cliSourcePath: string;
	skillSourcePath: string;
};

/**
 * Locate the CLI binary and skill bundle to install from the terminal.
 *
 * The packaged app ships `Resources/bin/fishmem` next to
 * `Resources/skills/fishmem`. Candidates, in order: FISHMEM_RESOURCES_DIR,
 * the resources directory containing the running binary, then the standard
 * macOS application locations. The CLI source prefers the app bundle copy so
 * an install from `~/.fishmem/bin` upgrades to the app's version.
 */
export function resolveIntegrationSources(
	options: {
		execPath?: string;
		env?: Record<string, string | undefined>;
		home?: string;
		exists?: (path: string) => boolean;
		realpath?: (path: string) => string;
		platform?: NodeJS.Platform;
	} = {},
): IntegrationSources {
	const exists = options.exists ?? existsSync;
	const canonical = options.realpath ?? safeRealpath;
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const execPath = canonical(options.execPath ?? process.execPath);
	const cliName =
		(options.platform ?? process.platform) === "win32"
			? "fishmem.exe"
			: "fishmem";
	const candidates = [
		env.FISHMEM_RESOURCES_DIR,
		dirname(dirname(execPath)),
		"/Applications/FishMem.app/Contents/Resources",
		join(home, "Applications", "FishMem.app", "Contents", "Resources"),
	].filter((candidate): candidate is string => Boolean(candidate));
	const resources = candidates.find((candidate) =>
		exists(join(candidate, "skills", "fishmem", "SKILL.md")),
	);
	if (!resources) {
		throw new Error(
			"Cannot find the FishMem skill bundle. Install FishMem Desktop, or set FISHMEM_RESOURCES_DIR to its Resources directory.",
		);
	}
	const bundledCli = join(resources, "bin", cliName);
	const runningCompiledCli = !/^(bun|node)(\.exe)?$/i.test(basename(execPath));
	const cliSourcePath = exists(bundledCli)
		? bundledCli
		: runningCompiledCli
			? execPath
			: undefined;
	if (!cliSourcePath) {
		throw new Error(
			`Cannot find the FishMem CLI binary in ${join(resources, "bin")}. Build it with \`pnpm --filter @fishmem/desktop build:cli\` or install FishMem Desktop.`,
		);
	}
	return {
		cliSourcePath,
		skillSourcePath: join(resources, "skills", "fishmem"),
	};
}

function safeRealpath(path: string) {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}
