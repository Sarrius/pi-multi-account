import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

// Actual native1.1 event/context/admission path; only owned synthetic auth,
// providers, history and a read fixture. No real refresh or provider inference.
const dir = mkdtempSync(join(tmpdir(), "pm-auth-recovery-"));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_OFFLINE = "1";
process.env.PI_NO_LOCAL_LLM = "1";
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
const { default: multiAccount } = await import("../index.ts");
const providers = ["openai-codex-account-2", "openai-codex-account-4"];
const models = providers.map(provider => ({ provider, id: "gpt-6.1-sol", name: provider,
	api: "openai-codex-responses" as const, baseUrl: "http://127.0.0.1:1", reasoning: false,
	input: ["text" as const], contextWindow: 200_000, maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));

for (const quota of [false, true]) test(`native Pi recovers an ${quota ? "exhausted quota" : "expired access token plus WebSocket diagnostic"} to the same model on a sibling and reads once`, async () => {
	writeFileSync(join(dir, "auth.json"), JSON.stringify(Object.fromEntries(providers.map((provider, i) => [provider,
		{ type: "oauth", access: `synthetic-${i}`, refresh: `synthetic-refresh-${i}`, accountId: `owned-account-${i}`, expires: 4102444800000 }]))));
	writeFileSync(join(dir, "provider-failover.json"), JSON.stringify({ childProxy: false, autoDiscoverModels: false,
		showUsage: false, autoContinue: true, onlyActive: false, followLastSuccessfulModel: false,
		includeOtherProviders: false, fallbacks: providers, preferredModels: { "openai-codex": ["gpt-6.1-sol"] },
		pinnedModels: { "openai-codex": "gpt-6.1-sol" }, includeCursor: false }));
	writeFileSync(join(dir, "owned-proof.txt"), "OWNED_READ_PROOF");
	rmSync(join(dir, "provider-failover-state.json"), { force: true });
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () => { throw new Error("AUTH_RECOVERY_TEST_EXTERNAL_REQUEST_FORBIDDEN"); }) as typeof fetch;
	const requests: string[] = [], errors: any[] = [], toolResults: any[] = [];
	const settings = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false }, ...({ cacheWarming: "off" } as Record<string, unknown>) });
	let nativeRegistry: any;
	const registerFixtures = (pi: any) => {
		const register = () => { for (const model of models) pi.registerProvider(model.provider, {
			api: "openai-codex-responses", baseUrl: model.baseUrl, apiKey: "owned-synthetic-no-network", models: [model],
			streamSimple: stream }); };
		function stream(model: any, context: any) {
			requests.push(model.provider);
			const s = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const failed = model.provider === providers[0];
				const readDone = context.messages.some((m: any) => m.role === "toolResult" && m.toolName === "read");
				const result: any = { role: "assistant", provider: model.provider, model: model.id, api: model.api,
					stopReason: failed ? "error" : readDone ? "stop" : "toolUse", timestamp: Date.now(),
					content: failed ? [] : readDone ? [{ type: "text", text: "OWNED_RECOVERY_OK" }]
						: [{ type: "toolCall", id: "owned-read-once", name: "read", arguments: { path: "owned-proof.txt" } }],
					...(failed ? { errorMessage: quota
						? "You have hit your ChatGPT usage limit (plus plan). Try again in ~147 min."
						: "Provided authentication token is expired. Please try signing in again.",
						...(!quota ? { diagnostics: [{ error: { message: "WebSocket error" } }] } : {}) } : {}),
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				if (failed) s.push({ type: "error", reason: "error", error: result });
				else s.push({ type: "done", reason: result.stopReason, message: result });
				s.end(result);
			}); return s;
		}
		register();
		// Multi Account may enrich its provider catalog at startup. Re-register
		// the owned stream after that event without altering any routing policy.
		pi.on("session_start", (_e: any, ctx: any) => { register(); nativeRegistry = ctx.modelRegistry; });
	};
	const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
		extensionFactories: [async pi => { await multiAccount(pi); }, registerFixtures] });
	let session: any;
	try {
		await loader.reload();
		const result = await createAgentSession({ cwd: dir, agentDir: dir, settingsManager: settings, resourceLoader: loader,
			sessionManager: SessionManager.inMemory(dir), model: models[0] });
		assert.deepEqual(result.extensionsResult.errors, []); session = result.session;
		await session.bindExtensions({ mode: "print", onError: (error: any) => errors.push(error) });
		assert.equal("authStorage" in nativeRegistry, false, "exercise the real read-only native facade");
		session.subscribe((e: any) => { if (e.type === "tool_execution_end") toolResults.push(e); });
		await session.prompt("OWNED_ORIGINAL_REQUEST: read owned-proof.txt exactly once, then return OWNED_RECOVERY_OK");
		const until = Date.now() + 8000;
		while (session.getLastAssistantText() !== "OWNED_RECOVERY_OK") {
			assert.ok(Date.now() < until, `native recovery did not settle: ${JSON.stringify({ requests, last: session.messages.at(-1), errors })}`);
			await new Promise(r => setTimeout(r, 10));
		}
		await session.waitForIdle();
		assert.deepEqual(errors, []);
		assert.deepEqual(requests, [providers[0], providers[1], providers[1]]);
		assert.equal(toolResults.length, 1); assert.equal(toolResults[0].isError, false);
		assert.ok(JSON.stringify(toolResults[0]).includes("OWNED_READ_PROOF"));
		const originals = session.sessionManager.getEntries().filter((e: any) => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes("OWNED_ORIGINAL_REQUEST"));
		assert.equal(originals.length, 1, "original owner input is admitted once, not replayed");
		const state = JSON.parse(readFileSync(join(dir, "provider-failover-state.json"), "utf8"));
		assert.equal(state.pendingFrom, undefined);
		assert.equal(state.invalidatedByProvider?.[providers[0]], undefined);
		assert.ok((state.exhaustedUntilByProvider?.[providers[0]] ?? 0) > Date.now());
	} finally {
		if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
		globalThis.fetch = realFetch;
	}
});
