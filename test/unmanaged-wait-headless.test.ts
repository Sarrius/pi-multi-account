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

const commandRuns: string[] = [];

async function waitingSession() {
	writeFileSync(join(dir, "auth.json"), JSON.stringify({ "claude-code": { type: "api_key", key: "fixture-only" } }));
	writeFileSync(join(dir, "provider-failover.json"), JSON.stringify({
		includeCursor: false, childProxy: false, autoDiscover: false, autoDiscoverModels: false, showUsage: false,
		autoContinue: false, fallbacks: ["claude-code"],
	}));
	writeFileSync(join(dir, "provider-failover-state.json"), "{}\n");
	const requests: string[] = [];
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
		noExtensions: true, noSkills: true, noPromptTemplates: true,
		extensionFactories: [(pi) => {
			pi.registerCommand("fixture-cmd", { description: "fixture", handler: async (args: string) => { commandRuns.push(args); } });
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
	return { session: result.session, requests };
}

function captureStderr() {
	const chunks: string[] = [];
	const realWrite = process.stderr.write;
	process.stderr.write = ((chunk: any) => { chunks.push(String(chunk)); return true; }) as any;
	return { output: () => chunks.join(""), restore: () => { process.stderr.write = realWrite; } };
}

test("real Pi print mode rejects a prompt during an unmanaged wait visibly, not silently", async () => {
	const { session, requests } = await waitingSession();
	const realExit = process.exitCode;
	let stderr: ReturnType<typeof captureStderr> | undefined;
	try {
		await session.bindExtensions({ mode: "print", onError: (error: any) => { throw new Error(JSON.stringify(error)); } });
		assert.equal(session.extensionRunner.hasUI(), false, "print mode runs with Pi's no-op UI");
		await session.prompt("First request");
		assert.deepEqual(requests, ["claude-code"]);
		stderr = captureStderr();
		await session.prompt("Second request text");
		// Print mode sends a leading slash path as a prompt, so it faces the same gate.
		await session.prompt("/tmp/Second request text");
		stderr.restore();
		assert.deepEqual(requests, ["claude-code"], "neither prompt is sent during Retry-After");
		const output = stderr.output();
		assert.equal(output.match(/prompt was not sent because claude-code/g)?.length, 2);
		assert.doesNotMatch(output, /Second request text/);
		// pi -p and an SDK host that binds print mode without a UI look the same to an extension.
		assert.equal(process.exitCode, realExit, "the exit status is left to the host");
		const log = readFileSync(join(dir, "provider-failover-debug.log"), "utf8");
		assert.match(log, /prompt_rejected_during_wait/);
		assert.doesNotMatch(log, /Second request text|First request/, "prompt content never reaches the log");
	} finally {
		stderr?.restore();
		process.exitCode = realExit;
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
});

test("an embedding SDK host in print mode with its own UI gets the notice and keeps its exit status", async () => {
	const { session, requests } = await waitingSession();
	const realExit = process.exitCode;
	const notices: string[] = [];
	const ui: any = new Proxy({ notify: (message: string) => { notices.push(message); },
		getEditorText: () => "", setEditorText: () => {} }, {
		get: (target, key) => key in target ? (target as any)[key] : () => undefined,
	});
	let stderr: ReturnType<typeof captureStderr> | undefined;
	try {
		await session.bindExtensions({ mode: "print", uiContext: ui,
			onError: (error: any) => { throw new Error(JSON.stringify(error)); } });
		assert.equal(session.extensionRunner.hasUI(), true);
		await session.prompt("First request");
		process.exitCode = undefined;
		stderr = captureStderr();
		await session.prompt("Second request text");
		stderr.restore();
		assert.deepEqual(requests, ["claude-code"]);
		assert.ok(notices.some(notice => /prompt was not sent because claude-code/.test(notice)), "the host UI is told");
		assert.doesNotMatch(stderr.output(), /prompt was not sent/);
		assert.equal(process.exitCode, undefined, "an embedding host owns process.exitCode");
	} finally {
		stderr?.restore();
		process.exitCode = realExit;
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
});

test("real Pi: a registered command runs before the gate; command-looking text that reaches it is held", async () => {
	const { session, requests } = await waitingSession();
	let stderr: ReturnType<typeof captureStderr> | undefined;
	try {
		await session.bindExtensions({ mode: "print", onError: (error: any) => { throw new Error(JSON.stringify(error)); } });
		await session.prompt("First request");
		assert.deepEqual(requests, ["claude-code"]);
		commandRuns.length = 0;
		stderr = captureStderr();
		// Pi consumes the real command before any input hook runs.
		await session.prompt("/fixture-cmd real");
		assert.deepEqual(commandRuns, ["real"]);
		// These reach the hook, and Pi would send each to the model as text.
		await session.prompt(" /fixture-cmd leading space");
		await session.prompt("\t/fixture-cmd leading tab");
		await session.prompt("/fixture-cmd raw", { expandPromptTemplates: false });
		stderr.restore();
		assert.deepEqual(commandRuns, ["real"], "none of them ran the command");
		assert.deepEqual(requests, ["claude-code"], "and none reached the waiting provider");
		assert.equal(stderr.output().match(/prompt was not sent because claude-code/g)?.length, 3);
	} finally {
		stderr?.restore();
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
});
