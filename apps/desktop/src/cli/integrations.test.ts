import { describe, expect, it } from "vitest";
import { resolveIntegrationSources } from "./integrations";

describe("resolveIntegrationSources", () => {
	const app = "/Applications/FishMem.app/Contents/Resources";

	it("uses the app bundle next to a packaged CLI", () => {
		const files = new Set([`${app}/skills/fishmem/SKILL.md`, `${app}/bin/fishmem`]);
		expect(
			resolveIntegrationSources({
				execPath: `${app}/bin/fishmem`,
				env: {},
				home: "/Users/ada",
				exists: (path) => files.has(path),
				realpath: (path) => path,
				platform: "darwin",
			}),
		).toEqual({
			cliSourcePath: `${app}/bin/fishmem`,
			skillSourcePath: `${app}/skills/fishmem`,
		});
	});

	it("falls back to the installed app when run from ~/.fishmem/bin", () => {
		const files = new Set([`${app}/skills/fishmem/SKILL.md`, `${app}/bin/fishmem`]);
		expect(
			resolveIntegrationSources({
				execPath: "/Users/ada/.fishmem/bin/fishmem",
				env: {},
				home: "/Users/ada",
				exists: (path) => files.has(path),
				realpath: (path) => path,
				platform: "darwin",
			}).cliSourcePath,
		).toBe(`${app}/bin/fishmem`);
	});

	it("explains how to proceed when no skill bundle exists", () => {
		expect(() =>
			resolveIntegrationSources({
				execPath: "/usr/local/bin/bun",
				env: {},
				home: "/Users/ada",
				exists: () => false,
				realpath: (path) => path,
			}),
		).toThrow("FISHMEM_RESOURCES_DIR");
		expect(() =>
			resolveIntegrationSources({
				execPath: "/usr/local/bin/bun",
				env: { FISHMEM_RESOURCES_DIR: "/dev/resources" },
				home: "/Users/ada",
				exists: (path) => path === "/dev/resources/skills/fishmem/SKILL.md",
				realpath: (path) => path,
			}),
		).toThrow("build:cli");
	});
});
