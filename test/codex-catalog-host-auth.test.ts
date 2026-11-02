import assert from "node:assert/strict";
import { after } from "node:test";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "codex-catalog-host-auth-"));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_OFFLINE = "1";
delete process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_WEB_SESSION;
delete process.env.PI_MULTI_ACCOUNT_INDEPENDENT_ROOTS;
const { default: multiAccount } = await import("../index.ts");
after(() => rmSync(dir, { recursive: true, force: true }));

const provider = "openai-codex-account-2";
const catalogId = "gpt-5.6-catalog-fixture";
const sentinel = "synthetic-loopback-placeholder";
const expired = {
	type: "oauth", access: "synthetic-expired-access", refresh: "synthetic-refresh",
	expires: 1, accountId: "synthetic-old-account",
};
const refreshed = {
	...expired, access: "synthetic-refreshed-access", refresh: "synthetic-rotated-refresh",
	expires: 4102444800000, accountId: "synthetic-refreshed-account",
};

type Scenario = {
	api: "modern" | "compat" | "none";
	result?: "sentinel" | "throw" | "missing" | "removed";
};

// Like failover.test.ts, drive the registered lifecycle with a scripted host. In
// particular, this registry deliberately has no authStorage or private runtime.
async function runStartup(scenario: Scenario) {
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const persist = (entry: typeof expired | undefined) => writeFileSync(
		join(dir, "auth.json"), JSON.stringify(entry ? { [provider]: entry } : {}),
	);
	persist(expired);
	writeFileSync(join(dir, "provider-failover.json"), JSON.stringify({
		enabled: false, childProxy: false, includeCursor: false,
		antigravitySubscription: false, showUsage: false, autoDiscoverModels: true,
		resumeAfterAllAccountsRecover: false,
	}));
	const events = new Map<string, Array<(event: any, ctx: any) => any>>();
	const models = new Map<string, any[]>();
	const calls: string[] = [];
	const order: string[] = [];
	const requests: Array<{ url: string; authorization: string | null; accountId: string | null }> = [];
	const unexpectedRequests: string[] = [];
	const notifications: string[] = [];
	const registry: any = {
		getAll: () => [...models.values()].flat(),
		find: (id: string, model: string) => models.get(id)?.find(item => item.id === model),
		getProviderAuthStatus: () => ({ configured: true }),
		refresh: async () => {},
	};
	async function resolveAuth(this: any, id: string) {
		assert.equal(this, registry, "host getter keeps its registry receiver");
		assert.equal(id, provider);
		assert.equal(requests.length, 0, "catalog must wait for host authentication");
		calls.push(scenario.api);
		order.push("resolve");
		await Promise.resolve();
		if (scenario.result === "throw") throw new Error("synthetic host auth failure");
		if (scenario.result === "missing") return undefined;
		persist(scenario.result === "removed" ? undefined : refreshed);
		order.push("persist");
		const key = scenario.result === "sentinel" ? sentinel : refreshed.access;
		return scenario.api === "modern" ? { auth: { apiKey: key }, source: "OAuth" } : key;
	}
	if (scenario.api === "modern") {
		registry.getProviderAuth = resolveAuth;
		registry.getApiKeyForProvider = async () => {
			calls.push("unexpected-compat");
			return expired.access;
		};
	} else if (scenario.api === "compat") {
		registry.getApiKeyForProvider = resolveAuth;
	}
	const ctx: any = {
		modelRegistry: registry, isIdle: () => true,
		signal: new AbortController().signal, hasPendingMessages: () => false,
		getContextUsage: () => undefined,
		ui: { notify: (message: string) => notifications.push(message), setStatus: () => {} },
	};
	const pi: any = {
		on: (name: string, handler: (event: any, ctx: any) => any) => {
			const handlers = events.get(name) ?? [];
			handlers.push(handler);
			events.set(name, handlers);
		},
		registerProvider: (name: any, config?: any) => {
			if (typeof name === "object") { config = { models: name.getModels() }; name = name.id; }
			if (config?.models) models.set(name, config.models.map((model: any) => ({ ...model, provider: name })));
		},
		registerCommand: () => {}, registerTool: () => {},
		setModel: async () => true, sendUserMessage: () => {},
		continueAgent: async () => {}, appendEntry: () => {},
		getThinkingLevel: () => "high", setThinkingLevel: () => {},
		events: { on: () => {}, emit: () => {} },
	};
	const fire = async (name: string) => {
		for (const handler of events.get(name) ?? []) await handler({ type: name }, ctx);
	};
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		if (!url.startsWith("https://chatgpt.com/backend-api/codex/models?")) {
			unexpectedRequests.push(url);
			throw new Error("Unexpected network request blocked by catalog fixture");
		}
		order.push("fetch");
		const headers = new Headers(init?.headers);
		requests.push({ url, authorization: headers.get("Authorization"), accountId: headers.get("ChatGPT-Account-Id") });
		return Response.json({ models: [{ slug: catalogId, visibility: "list", priority: 1 }] });
	};
	try {
		await multiAccount(pi);
		await fire("session_start");
		assert.ok(notifications.some(message => message.includes("loaded")), "startup completed");
		assert.equal("authStorage" in registry, false);
		assert.deepEqual(unexpectedRequests, [], "all non-catalog traffic is blocked");
		return { calls, order, requests, models: models.get(provider) ?? [] };
	} finally {
		try { await fire("session_shutdown"); }
		finally { globalThis.fetch = originalFetch; }
	}
}

for (const api of ["modern", "compat"] as const) {
	for (const result of [undefined, "sentinel"] as const) {
		test(`${api} host resolves and persists expired Codex auth before catalog${result ? " without sending its proxy sentinel" : ""}`, async () => {
			const observed = await runStartup({ api, result });
			assert.deepEqual(observed.calls, [api]);
			assert.deepEqual(observed.order, ["resolve", "persist", "fetch"]);
			assert.equal(observed.requests.length, 1);
			assert.equal(observed.requests[0].authorization, `Bearer ${refreshed.access}`);
			assert.equal(observed.requests[0].accountId, refreshed.accountId);
			assert.ok(!JSON.stringify(observed.requests).includes(sentinel));
			assert.ok(observed.models.some(model => model.id === catalogId), "live catalog reaches the numbered alias");
		});
	}
	for (const result of ["throw", "missing"] as const) {
		test(`${api} host auth ${result} does not retry another getter or send stale Codex auth`, async () => {
			const observed = await runStartup({ api, result });
			assert.deepEqual(observed.calls, [api]);
			assert.deepEqual(observed.order, ["resolve"]);
			assert.deepEqual(observed.requests, []);
			assert.ok(!observed.models.some(model => model.id === catalogId));
		});
	}
}

test("Codex catalog re-reads a credential removed during host auth rather than using a stale snapshot", async () => {
	const observed = await runStartup({ api: "modern", result: "removed" });
	assert.deepEqual(observed.calls, ["modern"]);
	assert.deepEqual(observed.order, ["resolve", "persist"]);
	assert.deepEqual(observed.requests, []);
});

test("old hosts without either public auth getter retain the original Codex catalog path", async () => {
	const observed = await runStartup({ api: "none" });
	assert.deepEqual(observed.calls, []);
	assert.deepEqual(observed.order, ["fetch"]);
	assert.equal(observed.requests.length, 1);
	assert.equal(observed.requests[0].authorization, `Bearer ${expired.access}`);
	assert.equal(observed.requests[0].accountId, expired.accountId);
	assert.ok(observed.models.some(model => model.id === catalogId));
});
