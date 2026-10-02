import assert from "node:assert/strict";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	DefaultResourceLoader,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUPPORTED_PI_RANGE = ">=0.85.1 <0.88.0 || >=0.99.0 <0.100.0 || >=1.0.0 <2.0.0";

test("Pi host SDKs are peers, never extension-local runtime dependencies", () => {
	const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
	for (const packageName of [
		"@earendil-works/pi-ai",
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-tui",
	]) {
		assert.equal(
			manifest.dependencies?.[packageName],
			undefined,
			`${packageName} must be supplied by the running Pi host`,
		);
	}
	assert.equal(manifest.peerDependencies?.["@earendil-works/pi-ai"], SUPPORTED_PI_RANGE);
	assert.equal(
		manifest.peerDependencies?.["@earendil-works/pi-coding-agent"],
		SUPPORTED_PI_RANGE,
	);
});

test("OAuth uses Pi's host-bound pi-ai when the extension has no private SDK copy", async () => {
	const root = mkdtempSync(join(tmpdir(), "pmacct-pi099-host-sdk-"));
	const extensionDir = join(root, "extension");
	const agentDir = join(root, "agent");
	mkdirSync(extensionDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	for (const name of readdirSync(REPO_ROOT)) {
		if (name.endsWith(".ts")) cpSync(join(REPO_ROOT, name), join(extensionDir, name));
	}
	writeFileSync(
		join(agentDir, "auth.json"),
		JSON.stringify({
			"openai-codex": {
				type: "oauth",
				access: "fake-base-access",
				refresh: "fake-base-refresh",
				accountId: "fake-base-account",
			},
			"openai-codex-account-2": {
				type: "oauth",
				access: "fake-slot-access",
				refresh: "fake-slot-refresh",
				accountId: "fake-slot-account",
			},
		}),
	);
	writeFileSync(
		join(agentDir, "provider-failover.json"),
		JSON.stringify({
			enabled: true,
			autoContinue: false,
			showUsage: false,
			childProxy: false,
			autoDiscoverModels: false,
			includeCursor: false,
		}),
	);

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousCursorRoot = process.env.PI_CURSOR_PROVIDER_ROOT;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_CURSOR_PROVIDER_ROOT = join(root, "no-cursor");
	try {
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			additionalExtensionPaths: [join(extensionDir, "index.ts")],
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		assert.deepEqual(loaded.errors, []);
		const slot = loaded.runtime.pendingProviderRegistrations.find(
			(registration) => registration.name === "openai-codex-account-2",
		);
		assert.ok(slot, "the fake numbered Codex account must register");
		assert.equal(
			slot.config.oauth?.getApiKey({
				type: "oauth",
				access: "fake-access",
				refresh: "fake-refresh",
				expires: Date.now() + 60_000,
			}),
			"fake-access",
		);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousCursorRoot === undefined) delete process.env.PI_CURSOR_PROVIDER_ROOT;
		else process.env.PI_CURSOR_PROVIDER_ROOT = previousCursorRoot;
		rmSync(root, { recursive: true, force: true });
	}
});
