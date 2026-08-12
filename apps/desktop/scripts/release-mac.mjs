import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
	access,
	chmod,
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_DOWNLOAD_BASE_URL = "https://downloads.fishmem.com";
const FORBIDDEN_MAC_INFO_KEYS = [
	"NSAppTransportSecurity",
	"NSBluetoothAlwaysUsageDescription",
	"NSBluetoothPeripheralUsageDescription",
	"NSCameraUsageDescription",
	"NSMicrophoneUsageDescription",
];

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = join(desktopRoot, "release");
const packageJson = JSON.parse(
	await readFile(join(desktopRoot, "package.json"), "utf8"),
);
const version = packageJson.version;
const productName = packageJson.build.productName;
const appId = packageJson.build.appId;
const identity = process.env.FISHMEM_MAC_IDENTITY ?? "";
const builderIdentityQualifier = identity.replace(
	/^Developer ID Application:\s*/,
	"",
);
const teamId = process.env.FISHMEM_APPLE_TEAM_ID ?? "";
const notaryProfile = process.env.FISHMEM_NOTARY_PROFILE ?? "";
const downloadBaseUrl = (
	process.env.FISHMEM_DOWNLOAD_BASE_URL ?? DEFAULT_DOWNLOAD_BASE_URL
).replace(/\/$/, "");

function printHelp() {
	console.log(`Build the production FishMem Desktop release for macOS.

Usage:
  pnpm --filter @fishmem/desktop release:mac
  pnpm --filter @fishmem/desktop release:mac:finalize
  node scripts/release-mac.mjs --smoke-app <path-to-FishMem.app>

The release is always Universal, Developer ID signed, notarized, stapled, and
validated. Required maintainer environment:
  FISHMEM_MAC_IDENTITY
  FISHMEM_APPLE_TEAM_ID
  FISHMEM_NOTARY_PROFILE

Optional release metadata:
  FISHMEM_DOWNLOAD_BASE_URL

Use release:mac:finalize only to resume from an already signed and notarized
FishMem.app plus the DMG/ZIP emitted by a release:mac run that was interrupted
after electron-builder completed.

Use --smoke-app to validate an already packaged app without signing or
notarization credentials. FishMem Desktop must not already be running.`);
}

function run(command, args, options = {}) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, {
			cwd: desktopRoot,
			env: process.env,
			stdio: "inherit",
			...options,
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) {
				resolveRun();
				return;
			}
			reject(
				new Error(
					`${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`,
				),
			);
		});
	});
}

function capture(command, args, options = {}) {
	return new Promise((resolveCapture, reject) => {
		const child = spawn(command, args, {
			cwd: desktopRoot,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
			...options,
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
		child.once("exit", (code, signal) => {
			if (code === 0) {
				resolveCapture({ stdout, stderr });
				return;
			}
			reject(
				new Error(
					`${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}\n${stdout}${stderr}`,
				),
			);
		});
	});
}

function stage(message) {
	console.log(`\n==> ${message}`);
}

async function sha256(filePath) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filePath)) hash.update(chunk);
	return hash.digest("hex");
}

async function assertArchitectures(filePath, expectedArchitectures) {
	const { stdout } = await capture("lipo", ["-archs", filePath]);
	const actual = new Set(stdout.trim().split(/\s+/).filter(Boolean));
	for (const architecture of expectedArchitectures) {
		if (!actual.has(architecture)) {
			throw new Error(
				`${filePath} is missing ${architecture}; found ${[...actual].join(", ")}`,
			);
		}
	}
}

async function walkFiles(root) {
	const files = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const candidate = join(root, entry.name);
		if (entry.isDirectory()) files.push(...(await walkFiles(candidate)));
		else if (entry.isFile()) files.push(candidate);
	}
	return files;
}

async function assertCompiledMainBundle() {
	const mainOutput = join(desktopRoot, "out", "main");
	const forbiddenRuntimeImports =
		/\b(?:from\s*|import\s*\()["'](?:@fishmem\/application|@fishmem\/contracts)["']/;
	for (const filePath of await walkFiles(mainOutput)) {
		if (!filePath.endsWith(".js")) continue;
		const source = await readFile(filePath, "utf8");
		if (forbiddenRuntimeImports.test(source)) {
			throw new Error(
				`Desktop main bundle leaves a TypeScript workspace package external: ${filePath}`,
			);
		}
	}
	console.log("Validated compiled Desktop workspace dependencies");
}

async function waitForChildExit(child, timeoutMs) {
	if (child.exitCode !== null || child.signalCode !== null) return true;
	return Promise.race([
		new Promise((resolveExit) => child.once("exit", () => resolveExit(true))),
		delay(timeoutMs, false),
	]);
}

async function smokePackagedApp(appPath) {
	const mainExecutable = join(appPath, "Contents", "MacOS", productName);
	const cliExecutable = join(
		appPath,
		"Contents",
		"Resources",
		"bin",
		"fishmem",
	);
	const socketPath = join(
		tmpdir(),
		`fishmem-desktop-${process.getuid?.() ?? "user"}.sock`,
	);
	const descriptorPath = join(homedir(), ".fishmem", "desktop.json");
	const smokeRoot = await mkdtemp(join(tmpdir(), "fishmem-release-smoke-"));
	let previousDescriptor;
	let previousDescriptorMode = 0o600;
	try {
		previousDescriptor = await readFile(descriptorPath);
		previousDescriptorMode = (await stat(descriptorPath)).mode & 0o777;
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}

	await rm(socketPath, { force: true });
	await rm(descriptorPath, { force: true });

	let stdout = "";
	let stderr = "";
	const child = spawn(
		mainExecutable,
		[`--user-data-dir=${join(smokeRoot, "user-data")}`],
		{
			cwd: desktopRoot,
			env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	child.stdout.on("data", (chunk) => {
		stdout = `${stdout}${chunk}`.slice(-8_000);
	});
	child.stderr.on("data", (chunk) => {
		stderr = `${stderr}${chunk}`.slice(-8_000);
	});

	try {
		const timeoutMs = Number(
			process.env.FISHMEM_RELEASE_SMOKE_TIMEOUT_MS ?? 420_000,
		);
		if (!Number.isFinite(timeoutMs) || timeoutMs < 60_000) {
			throw new Error(
				"FISHMEM_RELEASE_SMOKE_TIMEOUT_MS must be at least 60000",
			);
		}
		const deadline = Date.now() + timeoutMs;
		let lastError;
		while (Date.now() < deadline) {
			if (child.exitCode !== null || child.signalCode !== null) {
				throw new Error(
					`Packaged FishMem exited before becoming ready\n${stdout}${stderr}`,
				);
			}
			try {
				const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
				if (
					descriptor.socketPath !== socketPath ||
					typeof descriptor.token !== "string" ||
					descriptor.token.length < 32
				) {
					throw new Error("Desktop connection descriptor is not ready");
				}
				const status = await capture(cliExecutable, ["status", "--json"]);
				const parsedStatus = JSON.parse(status.stdout);
				if (parsedStatus.configured !== true)
					throw new Error("Packaged Desktop status is not configured");
				if (parsedStatus.embeddingState !== "ready") {
					throw new Error(
						`Packaged Desktop embedding is ${parsedStatus.embeddingState ?? "unknown"}`,
					);
				}
				const marker = `packaged-release-smoke-${randomUUID()}`;
				const invoke = async (method, input) => {
					const args = ["call", method];
					if (input !== undefined) {
						args.push("--input", JSON.stringify(input));
					}
					return JSON.parse((await capture(cliExecutable, args)).stdout);
				};
				const added = await invoke("add", {
					content: `Remember ${marker}`,
					idempotency_key: `${marker}-add`,
				});
				const memoryId = added.results?.[0]?.id;
				if (typeof memoryId !== "string") {
					throw new Error("Packaged Desktop add did not return a memory id");
				}
				const found = await invoke("search", { query: marker, limit: 5 });
				if (!found.results?.some((memory) => memory.id === memoryId)) {
					throw new Error(
						"Packaged Desktop search did not recall the added memory",
					);
				}
				const fetched = await invoke("get", { id: memoryId });
				if (fetched.id !== memoryId) {
					throw new Error("Packaged Desktop get returned the wrong memory");
				}
				const updated = await invoke("update", {
					id: memoryId,
					content: `Updated ${marker}`,
					idempotency_key: `${marker}-update`,
				});
				if (updated.id !== memoryId || updated.event !== "UPDATE") {
					throw new Error("Packaged Desktop update did not commit");
				}
				const history = await invoke("history", { id: memoryId });
				if (!history.results?.some((entry) => entry.event === "UPDATE")) {
					throw new Error(
						"Packaged Desktop history is missing the update event",
					);
				}
				const deleted = await invoke("delete", {
					id: memoryId,
					idempotency_key: `${marker}-delete`,
				});
				if (deleted.id !== memoryId || deleted.deleted !== true) {
					throw new Error("Packaged Desktop delete did not commit");
				}
				console.log(
					"Validated packaged startup, local embedding, and add/search/get/update/history/delete lifecycle",
				);
				return;
			} catch (error) {
				lastError = error;
			}
			await delay(250);
		}
		throw new Error(
			`Packaged FishMem did not pass its lifecycle smoke test within ${timeoutMs / 1_000} seconds: ${lastError instanceof Error ? lastError.message : String(lastError)}\n${stdout}${stderr}`,
		);
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
			if (!(await waitForChildExit(child, 5_000))) {
				child.kill("SIGKILL");
				await waitForChildExit(child, 5_000);
			}
		}
		await rm(socketPath, { force: true });
		if (previousDescriptor !== undefined) {
			await mkdir(dirname(descriptorPath), { recursive: true });
			await writeFile(descriptorPath, previousDescriptor, {
				mode: previousDescriptorMode,
			});
			await chmod(descriptorPath, previousDescriptorMode);
		} else {
			await rm(descriptorPath, { force: true });
		}
		await rm(smokeRoot, { recursive: true, force: true });
	}
}

async function validateNativeArchitectures(appPath) {
	const nativeFiles = (await walkFiles(appPath)).filter(
		(filePath) => filePath.endsWith(".node") || filePath.endsWith(".dylib"),
	);
	if (nativeFiles.length === 0) {
		throw new Error(
			"No packaged native modules were found for architecture checks",
		);
	}

	for (const nativeFile of nativeFiles) {
		const normalized = nativeFile.replaceAll("\\", "/");
		if (normalized.includes("/linux/") || normalized.includes("/win32/")) {
			throw new Error(
				`Non-macOS native runtime leaked into the app: ${nativeFile}`,
			);
		}
		if (
			normalized.includes("darwin-arm64") ||
			normalized.includes("/darwin/arm64/")
		) {
			await assertArchitectures(nativeFile, ["arm64"]);
		} else if (
			normalized.includes("darwin-x64") ||
			normalized.includes("/darwin/x64/")
		) {
			await assertArchitectures(nativeFile, ["x86_64"]);
		} else {
			await assertArchitectures(nativeFile, ["arm64", "x86_64"]);
		}
	}
	console.log(`Validated ${nativeFiles.length} packaged native binaries`);
}

async function validateApp(appPath, { fullNativeCheck = false } = {}) {
	await run("codesign", [
		"--verify",
		"--deep",
		"--strict",
		"--verbose=4",
		appPath,
	]);
	const signature = await capture("codesign", ["-dv", "--verbose=4", appPath]);
	const signatureDetails = `${signature.stdout}${signature.stderr}`;
	if (!signatureDetails.includes(`Authority=${identity}`)) {
		throw new Error(
			`FishMem.app is not signed by the expected identity: ${identity}`,
		);
	}
	if (!signatureDetails.includes(`TeamIdentifier=${teamId}`)) {
		throw new Error(`FishMem.app does not carry TeamIdentifier ${teamId}`);
	}

	const mainExecutable = join(appPath, "Contents", "MacOS", productName);
	const cliExecutable = join(
		appPath,
		"Contents",
		"Resources",
		"bin",
		"fishmem",
	);
	await assertArchitectures(mainExecutable, ["arm64", "x86_64"]);
	await assertArchitectures(cliExecutable, ["arm64", "x86_64"]);
	if (fullNativeCheck) await validateNativeArchitectures(appPath);
	await assertHardenedInfoPlist(appPath);

	await run("xcrun", ["stapler", "validate", appPath]);
	await run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
}

async function validateDiskImage(dmgPath) {
	await run("hdiutil", ["verify", dmgPath]);
	await run("codesign", ["--verify", "--strict", "--verbose=4", dmgPath]);
	await run("xcrun", ["stapler", "validate", dmgPath]);
	await run("spctl", [
		"--assess",
		"--type",
		"open",
		"--context",
		"context:primary-signature",
		"--verbose=4",
		dmgPath,
	]);

	const temporaryRoot = await mkdtemp(join(tmpdir(), "fishmem-dmg-check-"));
	const mountPoint = join(temporaryRoot, "mounted");
	await mkdir(mountPoint);
	let mounted = false;
	try {
		await run("hdiutil", [
			"attach",
			"-nobrowse",
			"-readonly",
			"-mountpoint",
			mountPoint,
			dmgPath,
		]);
		mounted = true;
		await validateApp(join(mountPoint, `${productName}.app`));
	} finally {
		if (mounted) await run("hdiutil", ["detach", mountPoint]);
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}

async function validateZip(zipPath) {
	const temporaryRoot = await mkdtemp(join(tmpdir(), "fishmem-zip-check-"));
	try {
		await run("ditto", ["-x", "-k", zipPath, temporaryRoot]);
		await validateApp(join(temporaryRoot, `${productName}.app`));
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}

async function removeStaleUpdaterMetadata() {
	const entries = await readdir(releaseRoot);
	for (const entry of entries) {
		if (entry === "latest-mac.yml" || entry.endsWith(".blockmap")) {
			await rm(join(releaseRoot, entry), { force: true });
		}
	}
}

async function createReleaseMetadata(dmgPath, zipPath) {
	const versionPrefix = `desktop/mac/v${version}`;
	const latestPrefix = "desktop/mac/latest";
	const downloads = {};
	for (const [kind, filePath] of [
		["dmg", dmgPath],
		["zip", zipPath],
	]) {
		const fileName = basename(filePath);
		const fileStats = await stat(filePath);
		downloads[kind] = {
			fileName,
			size: fileStats.size,
			sha256: await sha256(filePath),
			url: `${downloadBaseUrl}/${versionPrefix}/${fileName}`,
			latestUrl: `${downloadBaseUrl}/${latestPrefix}/FishMem.${kind}`,
		};
	}

	const publishedAt = new Date().toISOString();
	const sourceCommit = (
		await capture("git", ["rev-parse", "HEAD"])
	).stdout.trim();
	const manifest = {
		schemaVersion: 1,
		product: "FishMem Desktop",
		appId,
		version,
		channel: "stable",
		platform: "darwin",
		architecture: "universal",
		sourceCommit,
		publishedAt,
		downloads,
	};
	const manifestPath = join(releaseRoot, "manifest.json");
	const checksumsPath = join(releaseRoot, "SHA256SUMS");
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	await writeFile(
		checksumsPath,
		`${downloads.dmg.sha256}  ${downloads.dmg.fileName}\n${downloads.zip.sha256}  ${downloads.zip.fileName}\n`,
	);
	return { manifestPath, checksumsPath, manifest };
}

async function assertPackagedVersions(appPath) {
	const appInfo = join(appPath, "Contents", "Info.plist");
	const electronInfo = join(
		appPath,
		"Contents",
		"Frameworks",
		"Electron Framework.framework",
		"Versions",
		"A",
		"Resources",
		"Info.plist",
	);
	const appVersion = (
		await capture("plutil", [
			"-extract",
			"CFBundleShortVersionString",
			"raw",
			appInfo,
		])
	).stdout.trim();
	const electronVersion = (
		await capture("plutil", [
			"-extract",
			"CFBundleVersion",
			"raw",
			electronInfo,
		])
	).stdout.trim();
	const expectedElectronVersion = packageJson.devDependencies.electron;
	if (appVersion !== version) {
		throw new Error(
			`Packaged app version ${appVersion} does not match package version ${version}`,
		);
	}
	if (electronVersion !== expectedElectronVersion) {
		throw new Error(
			`Packaged Electron ${electronVersion} does not match dependency ${expectedElectronVersion}`,
		);
	}
	console.log(`Validated FishMem ${appVersion} on Electron ${electronVersion}`);
}

async function assertHardenedInfoPlist(appPath) {
	const infoPath = join(appPath, "Contents", "Info.plist");
	const converted = await capture("plutil", [
		"-convert",
		"json",
		"-o",
		"-",
		infoPath,
	]);
	const info = JSON.parse(converted.stdout);
	const present = FORBIDDEN_MAC_INFO_KEYS.filter((key) =>
		Object.hasOwn(info, key),
	);
	if (present.length) {
		throw new Error(
			`Packaged Info.plist contains unused privacy or transport exceptions: ${present.join(", ")}`,
		);
	}
}

async function preflight() {
	if (process.platform !== "darwin") {
		throw new Error("release:mac must run on macOS");
	}
	const gitStatus = await capture("git", [
		"status",
		"--porcelain",
		"--untracked-files=all",
	]);
	if (gitStatus.stdout.trim()) {
		throw new Error(
			"release:mac requires a clean Git worktree so the manifest source commit is reproducible",
		);
	}
	for (const name of [
		"FISHMEM_MAC_IDENTITY",
		"FISHMEM_APPLE_TEAM_ID",
		"FISHMEM_NOTARY_PROFILE",
	]) {
		if (!process.env[name]?.trim()) {
			throw new Error(`${name} is required for a production macOS release`);
		}
	}
	const processes = await capture("ps", ["-axo", "command="]);
	const processList = `${processes.stdout}${processes.stderr}`;
	if (
		processList.includes(`${desktopRoot}/node_modules/.bin/../electron-vite`) ||
		processList.includes(`--app-path=${desktopRoot}`)
	) {
		throw new Error(
			"FishMem Desktop development mode is running. Stop it before release:mac so its hot rebuild cannot mutate out/ during packaging.",
		);
	}
	if (
		processList
			.split("\n")
			.some((command) =>
				command.includes(`/FishMem.app/Contents/MacOS/${productName}`),
			)
	) {
		throw new Error(
			"FishMem Desktop is running. Quit it before release:mac so the packaged startup smoke test has exclusive access to the local socket.",
		);
	}
	for (const tool of ["codesign", "hdiutil", "lipo", "spctl"]) {
		await capture("xcrun", ["--find", tool]);
	}
	const identities = await capture("security", [
		"find-identity",
		"-v",
		"-p",
		"codesigning",
	]);
	if (!`${identities.stdout}${identities.stderr}`.includes(identity)) {
		throw new Error(`Required signing identity is not installed: ${identity}`);
	}
	await capture("xcrun", [
		"notarytool",
		"history",
		"--keychain-profile",
		notaryProfile,
	]);
}

async function assertDesktopIsNotRunning() {
	const processes = await capture("ps", ["-axo", "command="]);
	const running = `${processes.stdout}${processes.stderr}`
		.split("\n")
		.some((command) =>
			command.includes(`/FishMem.app/Contents/MacOS/${productName}`),
		);
	if (running) {
		throw new Error(
			"FishMem Desktop is running. Quit it before a packaged app smoke test so the test cannot replace its local connection descriptor.",
		);
	}
}

async function main() {
	if (process.argv.includes("--help") || process.argv.includes("-h")) {
		printHelp();
		return;
	}
	const smokeAppIndex = process.argv.indexOf("--smoke-app");
	if (smokeAppIndex !== -1) {
		if (process.argv.length !== 4 || smokeAppIndex !== 2) {
			throw new Error(
				"Usage: node scripts/release-mac.mjs --smoke-app <path-to-FishMem.app>",
			);
		}
		if (process.platform !== "darwin") {
			throw new Error("--smoke-app must run on macOS");
		}
		const appPath = resolve(desktopRoot, process.argv[smokeAppIndex + 1]);
		await access(appPath);
		await assertDesktopIsNotRunning();
		await assertPackagedVersions(appPath);
		await assertHardenedInfoPlist(appPath);
		await smokePackagedApp(appPath);
		return;
	}
	const finalizeExisting = process.argv.includes("--finalize-existing");
	if (
		process.argv.length > 2 &&
		!(process.argv.length === 3 && finalizeExisting)
	) {
		throw new Error(`Unknown argument: ${process.argv.slice(2).join(" ")}`);
	}

	stage("Preflight Apple signing and notarization credentials");
	await preflight();

	if (!finalizeExisting) {
		stage("Run Desktop tests and type checks");
		await run("pnpm", ["run", "typecheck"]);
		await run("pnpm", ["run", "test"]);

		stage("Build renderer, main process, and Universal FishMem CLI");
		await run("pnpm", ["--filter", "fishmem", "build"]);
		await run("pnpm", ["exec", "electron-vite", "build"]);
		await assertCompiledMainBundle();
		await run("node", ["scripts/build-universal-cli.mjs"]);

		stage("Package, Developer ID sign, and notarize Universal FishMem.app");
		await rm(releaseRoot, { recursive: true, force: true });
		await run(
			"pnpm",
			[
				"exec",
				"electron-builder",
				"--mac",
				"--universal",
				"--publish",
				"never",
			],
			{
				env: {
					...process.env,
					// electron-builder 26 rejects the certificate-class prefix and chooses
					// the Developer ID Application certificate from this qualifier.
					CSC_NAME: builderIdentityQualifier,
					APPLE_TEAM_ID: teamId,
					APPLE_KEYCHAIN_PROFILE: notaryProfile,
					FISHMEM_MAC_UNIVERSAL: "1",
				},
			},
		);
	} else {
		stage("Resume finalization from existing electron-builder artifacts");
	}

	const appPath = join(releaseRoot, "mac-universal", `${productName}.app`);
	const dmgPath = join(releaseRoot, `${productName}-${version}-universal.dmg`);
	const zipPath = join(releaseRoot, `${productName}-${version}-universal.zip`);
	await Promise.all([access(appPath), access(dmgPath), access(zipPath)]);
	await assertPackagedVersions(appPath);

	stage("Launch packaged app and verify the embedded CLI connection");
	await smokePackagedApp(appPath);

	stage("Sign, notarize, and staple the final DMG bytes");
	await run("codesign", [
		"--force",
		"--timestamp",
		"--sign",
		identity,
		dmgPath,
	]);
	await run("xcrun", [
		"notarytool",
		"submit",
		dmgPath,
		"--keychain-profile",
		notaryProfile,
		"--wait",
	]);
	await run("xcrun", ["stapler", "staple", dmgPath]);

	stage("Validate app, DMG, ZIP, Gatekeeper, and both CPU architectures");
	await validateApp(appPath, { fullNativeCheck: true });
	await run("syspolicy_check", ["distribution", appPath]);
	await validateDiskImage(dmgPath);
	await validateZip(zipPath);

	// electron-builder generated updater metadata before the final DMG signature
	// and notarization changed its bytes. FishMem has no updater contract yet, so
	// never ship those stale sidecars as if they were usable.
	await removeStaleUpdaterMetadata();
	const metadata = await createReleaseMetadata(dmgPath, zipPath);

	stage("Release ready for R2 publication");
	console.log(`App:       ${appPath}`);
	console.log(`DMG:       ${dmgPath}`);
	console.log(`ZIP:       ${zipPath}`);
	console.log(`Manifest:  ${metadata.manifestPath}`);
	console.log(`Checksums: ${metadata.checksumsPath}`);
	console.log(`Latest:    ${metadata.manifest.downloads.dmg.latestUrl}`);
}

await main();
