import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Real Pi print-mode lifecycle with a no-op UI, synthetic credentials and streams. No API calls.
const dir = mkdtempSync(join(tmpdir(), "multi-account-wait-headless-"));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_OFFLINE = "1";
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
const { default: multiAccount } = await import("../index.ts");

const model = {
	provider: "claude-code", id: "fixture-model", name: "claude-code", api: "openai-completions" as const,
	baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text" as const],
	contextWindow: 100_000, maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

test("real Pi print mode rejects a prompt during an unmanaged wait visibly, not silently", async () => {
	writeFileSync(join(dir, "auth.json"), JSON.stringify({ "claude-code": { type: "api_key", key: "fixture-only" } }));
	writeFileSync(join(dir, "provider-failover.json"), JSON.stringify({
		includeCursor: false, childProxy: false, autoDiscover: false, autoDiscoverModels: false, showUsage: false,
		autoContinue: false, fallbacks: ["claude-code"],
	}));
	const requests: string[] = [];
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
		noExtensions: true, noSkills: true, noPromptTemplates: true,
		extensionFactories: [(pi) => {
			pi.registerProvider(model.provider, {
				api: "openai-completions", baseUrl: model.baseUrl, apiKey: "fixture-only", models: [model],
				streamSimple: (selected: any, _context: any, options: any) => {
					requests.push(selected.provider);
					const stream = createAssistantMessageEventStream();
					queueMicrotask(async () => {
						await options?.onResponse?.({ status: 429, headers: { "retry-after": "120" } }, selected);
						const message: any = { role: "assistant", content: [], api: selected.api,
							provider: selected.provider, model: selected.id, stopReason: "error", timestamp: Date.now(),
							errorMessage: "429 This request would exceed your account's rate limit.",
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
						stream.push({ type: "error", reason: "error", error: message });
						stream.end();
					});
					return stream;
				},
			});
		}, multiAccount],
	});
	await loader.reload();
	const result = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader,
		settingsManager: settings, sessionManager: SessionManager.inMemory(dir), model, tools: [] });
	assert.deepEqual(result.extensionsResult.errors, []);
	const session = result.session;
	const stderr: string[] = [];
	const realWrite = process.stderr.write;
	const realExit = process.exitCode;
	try {
		await session.bindExtensions({ mode: "print", onError: (error: any) => { throw new Error(JSON.stringify(error)); } });
		assert.equal(session.extensionRunner.hasUI(), false, "print mode runs with Pi's no-op UI");
		await session.prompt("First request");
		assert.deepEqual(requests, ["claude-code"]);
		process.stderr.write = ((chunk: any) => { stderr.push(String(chunk)); return true; }) as any;
		await session.prompt("Second request text");
		process.stderr.write = realWrite;
		assert.deepEqual(requests, ["claude-code"], "the second prompt is not sent during Retry-After");
		const output = stderr.join("");
		assert.match(output, /prompt was not sent because claude-code/);
		assert.doesNotMatch(output, /Second request text/);
		assert.equal(process.exitCode, 1, "print mode reports the rejection through its exit status");
		const log = readFileSync(join(dir, "provider-failover-debug.log"), "utf8");
		assert.match(log, /prompt_rejected_during_wait/);
		assert.doesNotMatch(log, /Second request text|First request/, "prompt content never reaches the log");
	} finally {
		process.stderr.write = realWrite;
		process.exitCode = realExit;
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
});
