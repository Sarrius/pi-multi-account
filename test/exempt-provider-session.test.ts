import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Isolated real Pi lifecycle, synthetic credentials and streams. No personal state or API calls.
const dir = mkdtempSync(join(tmpdir(), "multi-account-exempt-sdk-"));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_OFFLINE = "1";
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
const { default: multiAccount } = await import("../index.ts");

const models = ["cerebras", "fallback-fixture"].map((provider) => ({
	provider, id: "fixture-model", name: provider, api: "openai-completions" as const,
	baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text" as const],
	contextWindow: 100_000, maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}));

test("real Pi sends exempt Cerebras requests despite old cooldowns and leaves its errors alone", async () => {
	writeFileSync(join(dir, "auth.json"), JSON.stringify(Object.fromEntries(models.map((m) =>
		[m.provider, { type: "api_key", key: `fixture-only-${m.provider}` }]))));
	writeFileSync(join(dir, "provider-failover.json"), JSON.stringify({
		includeCursor: false, childProxy: false, autoDiscoverModels: false, showUsage: false,
		neverFailoverProviders: ["cerebras"], includeOtherProviders: true,
	}));
	const statePath = join(dir, "provider-failover-state.json");
	const until = Date.now() + 6 * 60 * 60 * 1000;
	writeFileSync(statePath, JSON.stringify({ stateVersion: 5,
		exhaustedUntilByProvider: { cerebras: until },
		exhaustedUntilByModel: { "cerebras/fixture-model": until },
	}));
	const requests: string[] = [];
	let reject = true;
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
		noExtensions: true, noSkills: true, noPromptTemplates: true,
		extensionFactories: [(pi) => {
			for (const model of models) pi.registerProvider(model.provider, {
				api: "openai-completions", baseUrl: model.baseUrl, apiKey: `fixture-only-${model.provider}`, models: [model],
				streamSimple: (selected: any) => {
					requests.push(selected.provider);
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() => {
						const message: any = { role: "assistant", content: reject ? [] : [{ type: "text", text: "OK" }],
							api: selected.api, provider: selected.provider, model: selected.id,
							stopReason: reject ? "error" : "stop", timestamp: Date.now(),
							...(reject ? { errorMessage: "429 status code (no body)" } : {}),
							usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
						if (reject) stream.push({ type: "error", reason: "error", error: message });
						else stream.push({ type: "done", reason: "stop", message });
						stream.end();
					});
					return stream;
				},
			});
		}, multiAccount],
	});
	await loader.reload();
	const result = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader,
		settingsManager: settings, sessionManager: SessionManager.inMemory(dir), model: models[0], tools: [] });
	assert.deepEqual(result.extensionsResult.errors, []);
	const session = result.session;
	try {
		await session.bindExtensions({ mode: "print", onError: (error: any) => { throw new Error(JSON.stringify(error)); } });
		const readLog = () => readFileSync(join(dir, "provider-failover-debug.log"), "utf8")
			.trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(readLog().find((event) => event.kind === "session_start")?.rotation, 2,
			"the fixture must offer a distinct healthy fallback, not a duplicate key");
		assert.equal(session.model?.provider, "cerebras", "startup must not switch");
		await session.prompt("Return OK");
		assert.deepEqual(requests, ["cerebras"], "preflights and final 429 must not route elsewhere");
		assert.equal(session.model?.provider, "cerebras");
		assert.equal(JSON.parse(readFileSync(statePath, "utf8")).pendingFrom, undefined);
		reject = false;
		await session.prompt("Try again");
		assert.deepEqual(requests, ["cerebras", "cerebras"]);
		assert.equal(session.model?.provider, "cerebras");
		const state = JSON.parse(readFileSync(statePath, "utf8"));
		assert.equal(state.exhaustedUntilByProvider?.cerebras, undefined, "real success clears stale health");
		assert.equal(state.exhaustedUntilByModel?.["cerebras/fixture-model"], undefined);
		assert.deepEqual(readLog().filter((event) =>
			["switch", "input_passthrough_while_cooling"].includes(event.kind)), []);
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
});
