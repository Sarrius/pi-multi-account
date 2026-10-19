import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import test from "node:test";
const dir = mkdtempSync(join(tmpdir(), "pm-child-auth-"));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_OFFLINE = "1";
process.env.PI_NO_LOCAL_LLM = "1";
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { PROXY_PLACEHOLDER_JWT } = await import("../slot-proxy.ts");
const adapterPath = fileURLToPath(new URL("../child-provider.ts", import.meta.url));
const alias = "openai-codex-account-8";
const token = "owned." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-child-only" } })).toString("base64url") + ".fixture";
const effortMap = { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

async function open(credential: any, baseUrl: string, withAdapter = true, api = "openai-codex-responses", thinkingLevelMap: object = effortMap) {
	writeFileSync(join(dir, "auth.json"), JSON.stringify(credential ? { [alias]: credential } : {}));
	writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { [alias]: {
		api, baseUrl,
		models: [{ id: "gpt-6-astra", reasoning: true, thinkingLevelMap,
			input: ["text"], contextWindow: 200_000, maxTokens: 8192 }],
	} } }));
	let ctx: any;
	const savedArgv = process.argv;
	process.argv = [process.execPath, "owned-cli.js", "--no-extensions", "--model", `${alias}/gpt-6-astra`];
	try {
		const settings = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false }, ...({ cacheWarming: "off" } as Record<string, unknown>) });
		const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
			noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true,
			additionalExtensionPaths: withAdapter && process.env.PI_MULTI_ACCOUNT_TEST_CHILD_ADAPTER !== "none" ? [adapterPath] : [],
			extensionFactories: [pi => { pi.on("session_start", (_e, c) => { ctx = c; }); }] });
		await loader.reload();
		const result = await createAgentSession({ cwd: dir, agentDir: dir, settingsManager: settings,
			resourceLoader: loader, sessionManager: SessionManager.inMemory(dir) });
		assert.deepEqual(result.extensionsResult.errors, []);
		const session = result.session;
		await session.bindExtensions({ mode: "print", onError: e => { throw new Error(JSON.stringify(e)); } });
		return { session, ctx, close: async () => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); } };
	} finally { process.argv = savedArgv; }
}

function response(text: string) {
	const item = { type: "message", role: "assistant", id: "owned-child-response", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
	return [
		{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
		{ type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { id: "owned-complete", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
	].map(e => `data: ${JSON.stringify(e)}\n\n`).join("");
}

test("restricted child resolves only its explicit numbered Codex OAuth alias through native auth", async () => {
	const f = await open({ type: "oauth", access: token, refresh: "retained-synthetic-refresh", expires: 4102444800000 }, `http://127.0.0.1:1/${alias}`);
	try {
		const model = f.ctx.modelRegistry.find(alias, "gpt-6-astra"); assert.ok(model);
		const before = readFileSync(join(dir, "auth.json"), "utf8");
		let requests = 0;
		const result = await f.ctx.modelRegistry.complete(model, { messages: [{ role: "user", content: "Owned child OAuth probe", timestamp: 0 }] }, {
			transport: "sse", reasoningEffort: "low", maxRetries: 0,
			fetch: async (_url: any, init: any) => { requests++; assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${token}`);
				return new Response(response("OWNED_AUTH_OK"), { headers: { "content-type": "text/event-stream" } }); },
		});
		assert.equal(result.stopReason, "stop", JSON.stringify(result)); assert.equal(requests, 1);
		assert.equal(model.thinkingLevelMap.off, null);
		assert.equal(readFileSync(join(dir, "auth.json"), "utf8"), before, "valid native OAuth requires no credential copying or mutation");
		assert.deepEqual(f.ctx.modelRegistry.getRegisteredProviderIds(), [alias], "do not load parent rotation or register sibling accounts");
		assert.ok(!f.session.extensionRunner.getRegisteredCommands().some((c: any) => c.name === "multi-account"));
	} finally { await f.close(); }
});

test("child helper preserves a parent-published loopback placeholder and native wire effort", async () => {
	const seen: any[] = [];
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
		let bytes = Buffer.concat(chunks); if (req.headers["content-encoding"] === "zstd") bytes = zstdDecompressSync(bytes);
		seen.push({ url: req.url, body: JSON.parse(bytes.toString()), bearer: req.headers.authorization });
		res.writeHead(200, { "content-type": "text/event-stream" }); res.end(response("OWNED_CHILD_OK"));
	});
	await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as any).port;
	const f = await open({ type: "api_key", key: PROXY_PLACEHOLDER_JWT }, `http://127.0.0.1:${port}/${alias}`);
	try {
		const model = f.ctx.modelRegistry.find(alias, "gpt-6-astra");
		const result = await f.ctx.modelRegistry.complete(model, { messages: [{ role: "user", content: "Owned synthetic child", timestamp: 0 }] }, {
			transport: "sse", reasoningEffort: "low", maxRetries: 0, timeoutMs: 2000,
		});
		assert.equal(result.stopReason, "stop", JSON.stringify(result)); assert.equal(seen.length, 1);
		assert.equal(seen[0].url, `/${alias}/codex/responses`);
		assert.equal(seen[0].bearer, `Bearer ${PROXY_PLACEHOLDER_JWT}`);
		assert.equal(seen[0].body.reasoning.effort, "low");
	} finally { await f.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test("a child preserves unmarked composed-map semantics without inventing legacy provenance", async () => {
	const { off: _off, ...legacyMap } = effortMap;
	const f = await open({ type: "oauth", access: token, refresh: "retained-refresh", expires: 4102444800000 }, `http://127.0.0.1:1/${alias}`, true, "openai-codex-responses", legacyMap);
	try {
		const before = readFileSync(join(dir, "models.json"), "utf8");
		const model = f.ctx.modelRegistry.find(alias, "gpt-6-astra");
		assert.equal(model.thinkingLevelMap.off, undefined, "must exercise the old composed metadata, not a rewritten publication");
		let body: any;
		const result = await f.session.modelRuntime.streamSimple(model, { messages: [{ role: "user", content: "Owned legacy metadata probe", timestamp: 0 }] }, {
			transport: "sse", maxRetries: 0, fetch: async (_url: any, init: any) => {
				const bytes = new Headers(init.headers).get("content-encoding") === "zstd" ? zstdDecompressSync(init.body) : init.body;
				body = JSON.parse(Buffer.from(bytes).toString());
				return new Response(response("OWNED_LEGACY_METADATA_OK"), { headers: { "content-type": "text/event-stream" } });
			},
		}).result();
		assert.equal(result.stopReason, "stop", JSON.stringify(result)); assert.ok(body.reasoning === undefined || body.reasoning.effort === "none", "native off remains off (omitted on older hosts), not an invented low requirement");
		assert.equal(readFileSync(join(dir, "models.json"), "utf8"), before);
	} finally { await f.close(); }
});

for (const level of ["medium", "high"] as const) test(`child sparse native map preserves ${level} wire effort`, async () => {
	const f = await open({ type: "oauth", access: token, refresh: "retained-refresh", expires: 4102444800000 }, `http://127.0.0.1:1/${alias}`, true, "openai-codex-responses", { minimal: "low", xhigh: "xhigh" });
	try {
		const model = f.ctx.modelRegistry.find(alias, "gpt-6-astra");
		let body: any;
		const result = await f.session.modelRuntime.streamSimple(model, { messages: [{ role: "user", content: "Owned sparse map probe", timestamp: 0 }] }, {
			transport: "sse", reasoning: level, maxRetries: 0, fetch: async (_url: any, init: any) => {
				const bytes = new Headers(init.headers).get("content-encoding") === "zstd" ? zstdDecompressSync(init.body) : init.body;
				body = JSON.parse(Buffer.from(bytes).toString());
				return new Response(response("SPARSE_OK"), { headers: { "content-type": "text/event-stream" } });
			},
		}).result();
		assert.equal(result.stopReason, "stop", JSON.stringify(result));
		assert.equal(body.reasoning.effort, level);
	} finally { await f.close(); }
});

test("missing alias credentials do not inherit an ambient paid OpenAI key or another account", async () => {
	const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "synthetic-paid-key-must-not-be-used";
	const f = await open(undefined, "https://chatgpt.com/backend-api");
	try {
		const model = f.ctx.modelRegistry.find(alias, "gpt-6-astra");
		let requests = 0;
		const result = await f.ctx.modelRegistry.complete(model, { messages: [{ role: "user", content: "Owned missing auth", timestamp: 0 }] }, {
			transport: "sse", maxRetries: 0, fetch: async () => { requests++; throw new Error("No auth must not reach transport"); },
		});
		assert.equal(result.stopReason, "error"); assert.match(result.errorMessage ?? "", /not configured|No API key/i);
		assert.equal(requests, 0);
		assert.ok(!readFileSync(join(dir, "auth.json"), "utf8").includes("synthetic-paid-key"));
	} finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; await f.close(); }
});

test("models.json cannot bypass the child placeholder guard by switching to a generic API", async () => {
	const f = await open({ type: "api_key", key: PROXY_PLACEHOLDER_JWT }, "https://api.openai.com/v1", true, "openai-completions");
	let fetches = 0;
	try {
		const model = f.ctx.modelRegistry.find(alias, "gpt-6-astra");
		let result: any, thrown: unknown;
		try { result = await f.ctx.modelRegistry.complete(model, { messages: [{ role: "user", content: "Owned generic API guard", timestamp: 0 }] }, {
			maxRetries: 0, timeoutMs: 1000, fetch: async () => { fetches++; throw new Error("No external requests"); },
		}); } catch (e) { thrown = e; }
		assert.equal(fetches, 0, "auth must reject before a generic serializer bypasses native stream guards");
		assert.ok(thrown || result?.stopReason === "error");
	} finally { await f.close(); }
});

test("a placeholder at a public endpoint is refused before transport dispatch", async () => {
	const f = await open({ type: "api_key", key: PROXY_PLACEHOLDER_JWT }, "https://chatgpt.com/backend-api");
	let fetches = 0;
	try {
		const model = f.ctx.modelRegistry.find(alias, "gpt-6-astra");
		let result: any, thrown: unknown;
		try { result = await f.ctx.modelRegistry.complete(model, { messages: [{ role: "user", content: "Owned guard", timestamp: 0 }] }, {
			transport: "sse", maxRetries: 0, fetch: async () => { fetches++; throw new Error("External requests forbidden"); },
		}); } catch (e) { thrown = e; }
		assert.equal(fetches, 0); assert.ok(thrown || result?.stopReason === "error");
	} finally { await f.close(); }
});
