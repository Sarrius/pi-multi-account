/**
 * Cursor is an OPTIONAL provider that lives in a separate repo, on whatever Node the user runs.
 * It must never be able to damage the extension.
 *
 * This was found on a real machine: the cloned `pi-cursor-provider` imports a JSON file in a way
 * newer Node rejects, so loading it threw. That rejection (a) escaped from the fire-and-forget
 * discovery call as an unhandled rejection — which Node can turn into a process exit — and
 * (b) aborted `session_start` partway, skipping the reset that clears a previous session's
 * pending auto-resume. A stale resume surviving into a new session means silently restarting
 * work the user never asked to restart.
 *
 * Runs in a child process on purpose: the cursor bridge caches the loaded provider module, so an
 * in-process test would reuse whatever a previous test loaded.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION_ENTRY = join(REPO_ROOT, "index.ts");

const DRIVER = `const agentDir = process.argv[2];
const cursorRoot = process.argv[3];
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CURSOR_PROVIDER_ROOT = cursorRoot;

const rejections = [];
const registeredProviders = [];
const modelCounts = {};
const modelIds = {};
process.on("unhandledRejection", (reason) => {
	rejections.push(String(reason && reason.message ? reason.message : reason));
});

const mod = await import(process.argv[4]);

const events = {};
const notifies = [];
const pi = {
	registerProvider: (id, cfg) => { registeredProviders.push(id); modelCounts[id] = (cfg?.models ?? []).length; modelIds[id] = (cfg?.models ?? []).map((model) => model.id); },
	registerCommand: () => {},
	on: (name, handler) => { events[name] = handler; },
	setModel: async () => true,
	sendUserMessage: () => {},
	continueAgent: async () => {},
	appendEntry: () => {},
	getThinkingLevel: () => "high",
	setThinkingLevel: () => {},
};
const ctx = {
	model: { provider: "anthropic", id: "claude-opus-5" },
	isIdle: () => true,
	signal: { aborted: false },
	hasPendingMessages: () => false,
	ui: { notify: (m) => notifies.push(m), setStatus: () => {} },
	modelRegistry: {
		find: (provider, id) => ({ provider, id }),
		getAll: () => [{ provider: "anthropic", id: "claude-opus-5" }],
		authStorage: { reload: () => {}, hasAuth: () => true },
		getProviderAuthStatus: () => ({ configured: true }),
	},
	getContextUsage: () => undefined,
};

const factoryStart = Date.now();
await mod.default(pi);
const factoryElapsedMs = Date.now() - factoryStart;
const factoryModelIds = modelIds.cursor;
await events.session_start?.({}, ctx);
await new Promise((r) => setTimeout(r, 400));

// Optional second phase: the user fixes (or finally clones) the provider mid-session.
// A failed load must not be cached forever — the next discovery pass has to retry it.
const repairSource = process.argv[5];
if (repairSource) {
	const { writeFileSync: writeRepair, mkdirSync: mkdirRepair } = await import("node:fs");
	const { join: joinRepair } = await import("node:path");
	mkdirRepair(cursorRoot, { recursive: true });
	writeRepair(joinRepair(cursorRoot, "cursor-shared.ts"), repairSource);
	registeredProviders.length = 0;
	await events.session_start?.({}, ctx);
	await new Promise((r) => setTimeout(r, 400));
}

const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");
let state = {};
try { state = JSON.parse(readFileSync(join(agentDir, "provider-failover-state.json"), "utf8")); } catch {}
let log = [];
try {
	log = readFileSync(join(agentDir, "provider-failover-debug.log"), "utf8")
		.split("\\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
} catch {}

console.log("__RESULT__" + JSON.stringify({
	registeredProviders,
	modelCounts,
	factoryModelIds,
	factoryElapsedMs,
	sessionStartCompleted: notifies.some((m) => m.includes("loaded")),
	pendingFromAfter: state.pendingFrom,
	cursorNotices: notifies.filter((m) => /Cursor/.test(m) && /failed to load/.test(m)).length,
	loggedFailure: log.some((e) => e.kind === "cursor_setup_failed"),
	rejections,
}));
`;

function runSession(
	cursorProviderSource: string | undefined,
	repairSource?: string,
	extraAuth: Record<string, unknown> = {},
) {
	const agentDir = mkdtempSync(join(tmpdir(), "cursor-opt-"));
	const cursorRoot = join(agentDir, "cursor-provider");
	if (cursorProviderSource !== undefined) {
		mkdirSync(cursorRoot, { recursive: true });
		writeFileSync(join(cursorRoot, "cursor-shared.ts"), cursorProviderSource);
	}
	writeFileSync(
		join(agentDir, "auth.json"),
		JSON.stringify({
			anthropic: { type: "oauth", access: "a", refresh: "r" },
			...extraAuth,
		}),
	);
	writeFileSync(
		join(agentDir, "provider-failover.json"),
		JSON.stringify({
			enabled: true,
			includeCursor: true,
			showUsage: false,
			autoDiscoverModels: false,
			fallbacks: [],
		}),
	);
	// A leftover pending auto-resume from a previous session. session_start must clear it.
	writeFileSync(
		join(agentDir, "provider-failover-state.json"),
		JSON.stringify({
			stateVersion: 5,
			exhaustedUntilByProvider: {},
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			pendingFrom: "anthropic/claude-opus-5",
			pendingReason: "stale pending resume from a previous session",
			pendingSince: Date.now() - 60_000,
			lastSwitches: [],
		}),
	);

	const driver = join(agentDir, "driver.mjs");
	writeFileSync(driver, DRIVER);
	try {
		const stdout = execFileSync(
			process.execPath,
			[
				driver,
				agentDir,
				cursorRoot,
				EXTENSION_ENTRY,
				...(repairSource ? [repairSource] : []),
			],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
		const line = stdout.split("\n").find((l) => l.startsWith("__RESULT__"));
		assert.ok(line, `driver produced no result. stdout:\n${stdout}`);
		return JSON.parse(line.slice("__RESULT__".length));
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
}

const BROKEN_PROVIDER =
	'throw new Error("cursor-models-raw.json needs an import attribute of \\"type: json\\"");\n';

test("a Cursor provider that fails to load cannot abort session_start", () => {
	const result = runSession(BROKEN_PROVIDER);
	assert.equal(
		result.sessionStartCompleted,
		true,
		"session_start must run to completion despite the cursor failure",
	);
	assert.equal(
		result.pendingFromAfter,
		undefined,
		"a previous session's pending auto-resume must still be cleared",
	);
});

test("a Cursor provider that fails to load never escapes as an unhandled rejection", () => {
	const result = runSession(BROKEN_PROVIDER);
	// Node can terminate the process on an unhandled rejection — this must never reach it.
	assert.deepEqual(result.rejections, []);
});

test("a Cursor provider that fails to load is reported once, not silently swallowed", () => {
	const result = runSession(BROKEN_PROVIDER);
	// The user cloned it deliberately, so silence would be wrong; repeating it on every
	// discovery pass would be nagging. Exactly one notice, plus a black-box log entry.
	assert.equal(result.cursorNotices, 1);
	assert.equal(result.loggedFailure, true);
});

test("no Cursor provider installed stays completely silent", () => {
	const result = runSession(undefined);
	assert.equal(result.sessionStartCompleted, true);
	assert.equal(result.cursorNotices, 0);
	assert.equal(result.loggedFailure, false);
	assert.deepEqual(result.rejections, []);
});

// A working provider: the minimum surface the bridge drives.
const WORKING_PROVIDER = `export const FALLBACK_MODELS = [{ id: "cursor-model", name: "Cursor Model" }];
export async function ensureCursorProxy() { return 45678; }
export function registerCursorProvider(pi, id, port, models) {
	pi.registerProvider(id, { name: "Cursor (" + id + ")", baseUrl: "http://127.0.0.1:" + port + "/v1", models });
}
`;

test("a Cursor provider that loads registers every account slot", () => {
	const result = runSession(WORKING_PROVIDER);
	assert.deepEqual(result.rejections, []);
	assert.equal(result.loggedFailure, false);
	assert.ok(
		result.registeredProviders.includes("cursor"),
		`the base Cursor account must be registered, got: ${result.registeredProviders.join(", ")}`,
	);
	assert.ok(
		result.registeredProviders.includes("cursor-account-2"),
		"the next free Cursor slot must exist so /login can offer it",
	);
});

test("a Cursor provider repaired mid-session is picked up without a restart", () => {
	// The first load fails, so the module cache must NOT keep the failure: cloning or fixing
	// the provider has to take effect on the next discovery pass, not on the next Pi launch.
	const result = runSession(BROKEN_PROVIDER, WORKING_PROVIDER);
	assert.deepEqual(result.rejections, []);
	assert.ok(
		result.registeredProviders.includes("cursor"),
		`a repaired provider must register its accounts, got: ${result.registeredProviders.join(", ")}`,
	);
});

const DISCOVERING_PROVIDER = `export const FALLBACK_MODELS = [{ id: "fallback-only", name: "Fallback" }];
export async function ensureCursorProxy() { return 45679; }
export async function discoverCursorModels() { return [{ id: "cursor-grok-4.6" }, { id: "claude-4.6-opus-high" }]; }
export function registerCursorProvider(pi, id, port, models) {
	pi.registerProvider(id, { name: "Cursor (" + id + ")", baseUrl: "http://127.0.0.1:" + port + "/v1", models });
}
`;

test("a logged-in Cursor account gets its real catalog at startup, not the fallback list", () => {
	// Login-time discovery used to be the ONLY discovery: restart Pi and the account was back
	// to FALLBACK_MODELS until the next token refresh. Startup must re-read the catalog from
	// the first slot whose stored token answers.
	const result = runSession(DISCOVERING_PROVIDER, undefined, {
		cursor: { type: "oauth", access: "c1", refresh: "cr1" },
	});
	assert.deepEqual(result.rejections, []);
	assert.equal(
		result.modelCounts["cursor"],
		2,
		`the fallback list (1 model) must be replaced by the discovered catalog, got ${result.modelCounts["cursor"]}`,
	);
});

test("cold factory resolves a resumed Grok only after publishing its discovered catalog", () => {
	const slowDiscovery = DISCOVERING_PROVIDER.replace(
		'export async function discoverCursorModels() { return [{ id: "cursor-grok-4.6" }, { id: "claude-4.6-opus-high" }]; }',
		'export async function discoverCursorModels() { await new Promise((r) => setTimeout(r, 80)); return [{ id: "grok-4.7" }]; }',
	);
	const result = runSession(slowDiscovery, undefined, {
		cursor: { type: "oauth", access: "c1", refresh: "cr1" },
	});
	assert.ok(result.factoryModelIds.includes("grok-4.7"),
		"Pi restores saved cursor/grok-4.7 immediately after the awaited factory returns");
	assert.equal(result.factoryElapsedMs >= 70, true, "the discovery must actually be awaited");
});

test("cold factory has a bounded catalog wait when Cursor discovery never settles", () => {
	const stalledDiscovery = DISCOVERING_PROVIDER.replace(
		'export async function discoverCursorModels() { return [{ id: "cursor-grok-4.6" }, { id: "claude-4.6-opus-high" }]; }',
		'export async function discoverCursorModels() { return new Promise(() => {}); }',
	);
	const result = runSession(stalledDiscovery, undefined, {
		cursor: { type: "oauth", access: "c1", refresh: "cr1" },
	});
	assert.ok(result.factoryElapsedMs >= 1400 && result.factoryElapsedMs < 3500);
	assert.deepEqual(result.factoryModelIds, ["fallback-only"]);
	assert.equal(result.sessionStartCompleted, true);
});

test("startup without a logged-in Cursor account keeps the fallback list and stays quiet", () => {
	const result = runSession(DISCOVERING_PROVIDER);
	assert.deepEqual(result.rejections, []);
	assert.equal(
		result.modelCounts["cursor"],
		1,
		"no token to discover with — the fallback list stays, and nothing may throw",
	);
});
