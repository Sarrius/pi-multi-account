import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "pm-context-recovery-"));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_OFFLINE = "1";
process.env.PI_NO_LOCAL_LLM = "1";
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
const { getApiProvider, registerApiProvider } = await import("@earendil-works/pi-ai/compat");
const { default: multiAccount } = await import("../index.ts");
const { createRecoveryArchives } = await import("../recovery-archive.ts");
// Use a catalog ID present on every qualified host. Otherwise startup can
// legitimately choose a different model before our fixture replaces metadata.
const fixtureModels = (providers: string[]) => providers.map((provider, i) => ({ provider, id: "gpt-6-sol", name: provider,
	api: "openai-codex-responses" as const, baseUrl: "http://127.0.0.1:1", reasoning: false,
	input: ["text" as const], contextWindow: i ? 64000 : 400000, maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
const supported = typeof (SessionManager.inMemory(dir) as any).buildSessionProjection === "function";
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

for (const mode of ["success", "base_provider", "delayed_quota", "preflight", "invalid_summary", "late_edit", "late_abort", "late_input", "coverage_replaced"] as const) test(`native automatic smaller-window recovery: ${mode}`, { skip: !supported }, async () => {
	const providers = ["openai-codex-account-2", mode === "base_provider" ? "openai-codex" : "openai-codex-account-4"];
	const models = fixtureModels(providers);
	const failPreparation = mode === "invalid_summary", expectFailure = !["success", "base_provider", "delayed_quota", "preflight"].includes(mode);
	writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: Object.fromEntries(models.map(model => [model.provider, { modelOverrides: { [model.id]: { contextWindow: model.contextWindow } } }])) }));
	writeFileSync(join(dir, "auth.json"), JSON.stringify(Object.fromEntries(providers.map((p, i) => [p,
		{ type: "oauth", access: `synthetic-${i}`, refresh: `synthetic-refresh-${i}`, accountId: `owned-${i}`, expires: 4102444800000 }]))));
	writeFileSync(join(dir, "provider-failover.json"), JSON.stringify({ childProxy: false, autoDiscoverModels: false,
		showUsage: false, autoContinue: true, onlyActive: false, followLastSuccessfulModel: false,
		includeOtherProviders: false, fallbacks: providers, preferredModels: { "openai-codex": ["gpt-6-sol"] },
		pinnedModels: { "openai-codex": "gpt-6-sol" }, includeCursor: false }));
	writeFileSync(join(dir, "owned-proof.txt"), "OWNED_READ_PROOF");
	rmSync(join(dir, "provider-failover-state.json"), { force: true });
	if (mode === "delayed_quota") writeFileSync(join(dir, "provider-failover-state.json"), JSON.stringify({ exhaustedUntilByProvider: { [providers[1]]: Date.now() + 750 } }));
	if (mode === "preflight") writeFileSync(join(dir, "provider-failover-state.json"), JSON.stringify({ exhaustedUntilByProvider: { [providers[0]]: Date.now() + 60000 } }));
	const realFetch = globalThis.fetch, realApi = getApiProvider("openai-codex-responses");
	globalThis.fetch = (async () => { throw new Error("RECOVERY_TEST_EXTERNAL_REQUEST_FORBIDDEN"); }) as typeof fetch;
	const dispatched: { provider: string; preparation: boolean; bytes: number }[] = [], blocked: string[] = [], errors: any[] = [], effects: any[] = [];
	let summaries = 0, foreignCalls = 0;
	function stream(model: any, context: any, options: any = {}) {
		const s = createAssistantMessageEventStream();
		queueMicrotask(async () => {
			let message: any = { role: "assistant", provider: model.provider, model: model.id, api: model.api,
				timestamp: Date.now(), usage, content: [], stopReason: "stop" };
			try {
				// A synthetic transport, but the production registration wrapper and its
				// post-replacement admission really run before any accepted request.
				const payload = { messages: context.messages, tools: context.tools ?? [] };
				const replacement = await options.onPayload?.(payload, model);
				const bytes = Buffer.byteLength(JSON.stringify(replacement ?? payload));
				const preparation = JSON.stringify(context).includes("Prepare a coherent current-work handoff");
				dispatched.push({ provider: model.provider, preparation, bytes });
				if (model.provider === providers[0]) throw new Error("You have hit your ChatGPT usage limit (plus plan). Try again in ~147 min.");
				if (preparation) {
					summaries++;
					message.content = [{ type: "text", text: failPreparation ? " " : "Current task: read owned-proof.txt exactly once, then return OWNED_RECOVERY_OK. Historical BACKGROUND_FACT=ember is retained in the original archive. No deployment or provisioning is authorized. No read has yet occurred. Check the original evidence before acting." }];
				} else {
					const results = context.messages.filter((m: any) => m.role === "toolResult");
					if (!results.some((m: any) => m.toolName === "ma_history_search")) {
						message.stopReason = "toolUse";
						message.content = [{ type: "toolCall", id: "search-original-once", name: "ma_history_search", arguments: { query: "BACKGROUND_FACT ember" } }];
					} else if (!results.some((m: any) => m.toolName === "read")) {
						message.stopReason = "toolUse";
						message.content = [{ type: "toolCall", id: "owned-read-once", name: "read", arguments: { path: "owned-proof.txt" } }];
					} else message.content = [{ type: "text", text: "OWNED_RECOVERY_OK" }];
				}
			} catch (error) {
				message = { ...message, stopReason: "error", errorMessage: String(error) };
				if (String(error).includes("destination admission")) blocked.push(model.provider);
			}
			if (message.stopReason === "error") s.push({ type: "error", reason: "error", error: message });
			else s.push({ type: "done", reason: message.stopReason, message });
			s.end(message);
		}); return s;
	}
	registerApiProvider({ api: "openai-codex-responses", stream, streamSimple: stream } as any);
	const settings = SettingsManager.inMemory({ packages: [], compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 4096 }, retry: { enabled: false }, ...({ cacheWarming: "off" } as Record<string, unknown>) });
	const manager = SessionManager.create(dir, join(dir, "sessions"));
	for (let i = 0; i < 20; i++) {
		manager.appendMessage({ role: "user", content: `BACKGROUND_FACT=ember; historical note ${i}: ${"background ".repeat(400)}`, timestamp: i * 2 });
		manager.appendMessage({ role: "assistant", provider: providers[0], model: models[0].id, api: models[0].api,
			content: [{ type: "text", text: `Noted ${i}` }], stopReason: "stop", usage, timestamp: i * 2 + 1 });
	}
	const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
		extensionFactories: [async pi => { await multiAccount(pi); }, (pi: any) => {
			pi.on("model_select", (_event: any, ctx: any) => {
				if (mode === "coverage_replaced" && ctx.model?.provider === providers[1]) {
					const cfg = ctx.modelRegistry.getRegisteredProviderConfig(providers[1]);
					ctx.modelRegistry.registerProvider(providers[1], { ...cfg, streamSimple: () => { foreignCalls++; throw new Error("unmanaged dispatch forbidden"); } });
				}
			});
			pi.on("session_before_compact", async (_event: any, ctx: any) => {
				await new Promise(resolve => setTimeout(resolve, 1)); // after Multi Account has returned its prepared result
				if (mode === "late_edit") {
					const original = manager.getEntries().find((e: any) => e.type === "message" && e.message.role === "user")!;
					(manager as any).appendContextEdit(original.id, { content: "redacted" });
				}
				if (mode === "late_input") manager.appendMessage({ role: "user", content: "New owner direction: stop", timestamp: Date.now() });
				if (mode === "late_abort") void Promise.resolve(ctx.abort()).catch(() => {});
			});
			pi.on("session_start", (_event: any, ctx: any) => {
				for (const model of models) {
					const config = ctx.modelRegistry.getRegisteredProviderConfig(model.provider);
					assert.equal(typeof config.streamSimple, "function", "retain production admission stream");
					ctx.modelRegistry.registerProvider(model.provider, { ...config, apiKey: "owned-no-network", models: [model] });
				}
			});
		}] });
	let session: any;
	try {
		await loader.reload();
		const result = await createAgentSession({ cwd: dir, agentDir: dir, settingsManager: settings, resourceLoader: loader,
			sessionManager: manager, model: models[0], thinkingLevel: "off" });
		assert.deepEqual(result.extensionsResult.errors, []); session = result.session;
		await session.bindExtensions({ mode: "print", onError: (e: any) => errors.push(e) });
		assert.equal(session.model?.id, models[0].id, "startup must retain the declared fixture model ID");
		session.subscribe((e: any) => { if (e.type === "tool_execution_end") effects.push(e); });
		await session.prompt("OWNED_ORIGINAL_REQUEST: read owned-proof.txt exactly once, then return OWNED_RECOVERY_OK. Do not deploy or provision anything.");
		const until = Date.now() + 8000;
		while (!expectFailure && session.getLastAssistantText() !== "OWNED_RECOVERY_OK") {
			assert.ok(Date.now() < until, JSON.stringify({ dispatched, blocked, summaries, errors, last: session.messages.at(-1) }));
			await new Promise(r => setTimeout(r, 10));
		}
		await session.waitForIdle();
		assert.deepEqual(errors, []);
		assert.equal(dispatched.filter(d => d.provider === providers[0]).length, mode === "preflight" ? 0 : 1);
		assert.equal(foreignCalls, 0, "a wrapper replaced during activation cannot dispatch");
		assert.equal(blocked.length, mode === "coverage_replaced" ? 0 : 1, "one rejected oversized attempt, no provider dispatch");
		if (mode !== "coverage_replaced") assert.ok(summaries >= 1);
		else assert.equal(dispatched.filter(d => d.provider === providers[1]).length, 0);
		assert.ok(dispatched.filter(d => d.provider === providers[1]).every(d => d.bytes <= 44800));
		const compactions = manager.getEntries().filter((e: any) => e.type === "compaction");
		assert.equal(compactions.length, expectFailure ? 0 : 1);
		assert.equal(effects.filter(e => e.toolName === "read").length, expectFailure ? 0 : 1);
		assert.equal(manager.getEntries().filter((e: any) => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes("OWNED_ORIGINAL_REQUEST")).length, 1);
		if (!expectFailure) {
			assert.ok(summaries > 1, "whole source exceeds a single preparation request");
			assert.equal(effects.find(e => e.toolName === "ma_history_search")?.isError, false);
			assert.ok(JSON.stringify(effects).includes("BACKGROUND_FACT"));
			const restored = SessionManager.open(manager.getSessionFile()!);
			const archive = createRecoveryArchives(() => restored);
			assert.equal(archive.list().items.length, 1);
			assert.ok(archive.query("BACKGROUND_FACT ember").items.length > 0, "restore references from native journal, without replay");
			archive.close();
		} else assert.ok(manager.buildSessionContext().messages.some((m: any) => JSON.stringify(m).includes("BACKGROUND_FACT")), "failed preparation retains the original context");
	} finally {
		if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
		if (realApi) registerApiProvider(realApi);
		globalThis.fetch = realFetch;
	}
});
