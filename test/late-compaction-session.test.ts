import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Real SDK and bundled host ordering, synthetic streams only. The old fake
// ctx.compact() kept isIdle() true and therefore missed the late-success defect.
const dir = mkdtempSync(join(tmpdir(), "pmacct-late-summary-"));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_OFFLINE = "1";
delete process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_WEB_SESSION;
delete process.env.PI_MULTI_ACCOUNT_INDEPENDENT_ROOTS;
const NativeHost = await import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
const { default: multiAccount } = await import("../index.ts");
const model = {
	provider: "late-summary-fixture", id: "fixture-model", name: "Owned fixture",
	api: "openai-completions" as const, baseUrl: "http://127.0.0.1:1",
	reasoning: false, input: ["text" as const], contextWindow: 12000, maxTokens: 256,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = {
	input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

for (const bundled of [false, true]) {
	test(`${bundled ? "bundled" : "SDK"} Pi resumes a late guard summary exactly once and executes the next tool`, { timeout: 10_000 }, async () => {
		const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = bundled
			? await import(new URL("./bundle/index.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as typeof NativeHost
			: NativeHost;
		writeFileSync(join(dir, "auth.json"), JSON.stringify({ [model.provider]: { type: "api_key", key: "fixture-only" } }));
		writeFileSync(join(dir, "provider-failover.json"), JSON.stringify({
			enabled: true, autoContinue: true, continueAfterCompaction: true, compactionWatchdogMs: 30,
			childProxy: false, includeCursor: false, includeOllama: false, autoDiscover: false,
			autoDiscoverModels: false, showUsage: false, fallbacks: [], contextGuard: true,
		}));
		writeFileSync(join(dir, "provider-failover-debug.log"), "");
		const originalFetch = globalThis.fetch;
		let networkAttempts = 0, requests = 0, summaries = 0, tools = 0;
		const errors: unknown[] = [];
		globalThis.fetch = async () => { networkAttempts++; throw new Error("Fixture forbids network"); };
		const settings = SettingsManager.inMemory({
			compaction: { enabled: false, keepRecentTokens: 20, reserveTokens: 1000 }, retry: { enabled: false },
		});
		const manager = SessionManager.inMemory(dir);
		manager.appendMessage({ role: "user", content: "Old owned history " + "x".repeat(64000), timestamp: Date.now() - 2000 });
		manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Old action complete" }],
			api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now() - 1000, usage });
		const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
			systemPromptOverride: () => "Owned fixture system",
			extensionFactories: [(pi) => {
				pi.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: "fixture-only", models: [model],
					streamSimple: (selected: any) => {
						const number = ++requests, stream = createAssistantMessageEventStream();
						queueMicrotask(() => {
							const tool = number === 2;
							const message: any = { role: "assistant", api: selected.api, provider: selected.provider, model: selected.id,
								stopReason: tool ? "toolUse" : "stop", timestamp: Date.now(), usage,
								content: tool ? [{ type: "toolCall", id: "fixture-call", name: "fixture_progress", arguments: {} }]
									: [{ type: "text", text: number === 1 ? "BEFORE_SUMMARY" : "PROGRESS_OK" }] };
							stream.push({ type: "done", reason: message.stopReason, message }); stream.end();
						});
						return stream;
					},
				});
				pi.registerTool({ name: "fixture_progress", label: "Fixture", description: "Owned fixture progress",
					parameters: { type: "object", properties: {}, required: [] } as any,
					execute: async () => { tools++; return { content: [{ type: "text", text: "TOOL_OK" }], details: {} }; } });
				pi.on("session_before_compact", async (event, ctx) => {
					summaries++;
					assert.equal(ctx.isIdle(), false, "the real host must be busy during its summary");
					await new Promise(resolve => setTimeout(resolve, 150));
					return { compaction: { summary: "Old history complete. Continue the original fixture task.",
						firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
				});
			}, multiAccount] });
		let session: InstanceType<typeof NativeHost.AgentSession> | undefined;
		try {
			await loader.reload();
			const result = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings,
				sessionManager: manager, model, tools: ["fixture_progress"] });
			assert.deepEqual(result.extensionsResult.errors, []);
			session = result.session;
			await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
			await session.prompt("Original task: after its summary run fixture_progress once, then PROGRESS_OK.");
			const deadline = Date.now() + 4000;
			while ((tools !== 1 || requests < 3 || session.isStreaming || session.isCompacting) && Date.now() < deadline)
				await new Promise(resolve => setTimeout(resolve, 10));
			const logs = readFileSync(join(dir, "provider-failover-debug.log"), "utf8").trim().split("\n").map(line => JSON.parse(line));
			assert.equal(summaries, 1);
			assert.ok(logs.some(entry => entry.kind === "context_guard_compaction_waiting"));
			assert.equal(tools, 1, "late completion must actually execute the next tool, not only enqueue a wake");
			assert.equal(requests, 3);
			assert.equal(logs.filter(entry => entry.kind === "compaction_continue").length, 1);
			assert.equal(networkAttempts, 0);
			assert.deepEqual(errors, []);
			assert.equal(session.model?.provider, model.provider);
			assert.equal(session.messages.filter(message => message.role === "assistant").at(-1)?.content[0]?.type, "text");
		} finally {
			if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
			globalThis.fetch = originalFetch;
		}
	});
}

test.after(() => rmSync(dir, { recursive: true, force: true }));
