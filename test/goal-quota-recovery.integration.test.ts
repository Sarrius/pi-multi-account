import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// Optional companion integration. No personal paths, credentials or network.
// PI_GOAL_TEST_ENTRY=/absolute/path/to/pi-goal/dist/index.ts node --test test/goal-quota-recovery.integration.test.ts
// Repeat with PI_GOAL_EXHAUST_ALL=1, then also PI_GOAL_RECOVER_ALL=1.
const entry = process.env.PI_GOAL_TEST_ENTRY;
const exhaustAll = process.env.PI_GOAL_EXHAUST_ALL === "1";
const recoverAll = process.env.PI_GOAL_RECOVER_ALL === "1";

test(`Goal and quota recovery: ${exhaustAll ? recoverAll ? "wait then recover" : "wait then pause" : "two exhausted fallbacks"}`,
	{ skip: !entry && "set PI_GOAL_TEST_ENTRY to run the optional companion integration", timeout: 15000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pmacct-goal-quota-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	process.env.PI_OFFLINE = "1";
	const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
	const { default: multiAccount } = await import("../index.ts");
	const providers = ["quota-a", "quota-b", "quota-c"];
	const requests: string[] = [];
	let quotaRestored = false;
	let session: any;
	const goal = () => session?.sessionManager.getEntries().filter((x: any) => x.customType === "goal-state").at(-1)?.data.goal;
	const completed = () => session?.sessionManager.getEntries().some((x: any) => x.customType === "goal-state" && x.data.goal?.status === "complete");
	const waitFor = async (predicate: () => boolean) => {
		const deadline = Date.now() + 8000;
		while (!predicate()) {
			assert.ok(Date.now() < deadline, `quota recovery timed out: requests=${requests.join(",")}, goal=${goal()?.status}, errors=${JSON.stringify(errors)}`);
			await new Promise(resolve => setTimeout(resolve, 10));
		}
	};
	const models = providers.map(provider => ({ provider, id: "fixture-model", name: provider,
		api: "openai-completions" as const, baseUrl: "http://127.0.0.1:1", reasoning: false,
		input: ["text" as const], contextWindow: 100000, maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
	writeFileSync(join(dir, "auth.json"), JSON.stringify(Object.fromEntries(providers.map(provider => [provider, { type: "api_key", key: `fixture-${provider}` }]))));
	writeFileSync(join(dir, "provider-failover.json"), JSON.stringify({
		includeCursor: false, childProxy: false, autoDiscoverModels: false, showUsage: false,
		includeOtherProviders: true, fallbacks: providers, autoContinue: true, contextGuard: false,
		...(recoverAll ? { cooldownMs: 1000, pendingPollMs: 100 } : {}), resumeAfterAllAccountsRecover: true,
	}));
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const errors: unknown[] = [];
	try {
		const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
			noExtensions: true, noSkills: true, noPromptTemplates: true,
			additionalExtensionPaths: [resolve(entry!)], extensionFactories: [pi => {
				for (const model of models) pi.registerProvider(model.provider, {
					api: model.api, baseUrl: model.baseUrl, apiKey: `fixture-${model.provider}`, models: [model],
					streamSimple: (selected: any) => {
						requests.push(selected.provider);
						const stream = createAssistantMessageEventStream();
						queueMicrotask(() => {
							const reject = exhaustAll ? !quotaRestored : selected.provider !== "quota-c";
							const active = goal();
							const completing = !reject && active?.status === "active";
							const message: any = { role: "assistant", api: selected.api, provider: selected.provider, model: selected.id,
								content: reject ? [] : completing ? [{ type: "toolCall", id: "fixture-complete", name: "goal_complete", arguments: { goal_id: active.id, summary: "Synthetic provider recovered and returned successfully." } }] : [{ type: "text", text: "OK" }],
								stopReason: reject ? "error" : completing ? "toolUse" : "stop", timestamp: Date.now(),
								...(reject ? { errorMessage: "You exceeded your current quota" } : {}),
								usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
							if (reject) stream.push({ type: "error", reason: "error", error: message });
							else stream.push({ type: "done", reason: message.stopReason, message });
							stream.end();
						});
						return stream;
					},
				});
			}, multiAccount],
		});
		await loader.reload();
		const result = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader,
			settingsManager: settings, sessionManager: SessionManager.inMemory(dir), model: models[0] });
		assert.deepEqual(result.extensionsResult.errors, []);
		session = result.session;
		await session.bindExtensions({ mode: "print", onError: (error: unknown) => errors.push(error) });
		await session.prompt("/goal Return OK after recovery");
		await waitFor(() => requests.length >= 3);
		assert.deepEqual(requests.slice(0, 3), providers);
		if (exhaustAll) {
			await waitFor(() => goal()?.waiting);
			assert.equal(goal().status, "active");
			assert.equal(requests.length, 3, "no busy retry while every account is exhausted");
			if (recoverAll) {
				quotaRestored = true;
				await waitFor(completed);
				assert.ok(requests.length > 3);
			} else {
				await session.prompt("/goal pause");
				assert.equal(goal().status, "paused");
				await new Promise(resolve => setTimeout(resolve, 150));
				assert.equal(requests.length, 3, "owner pause cancels continuation");
			}
		} else {
			await waitFor(completed);
			assert.ok(requests.slice(3).every(provider => provider === "quota-c"));
			assert.equal(session.model?.provider, "quota-c");
		}
		assert.deepEqual(errors, []);
	} finally {
		if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
		rmSync(dir, { recursive: true, force: true });
	}
});
