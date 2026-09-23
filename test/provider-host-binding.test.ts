import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DefaultResourceLoader, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";

// Exercise Pi's REAL loader rather than importing the wrapper in this test process.
// A deliberately incompatible nested package must never supply the transport.
for (const api of ["anthropic-messages", "openai-completions"]) {
	test(`host-bound ${api} preserves system and tools despite a stale nested pi-ai`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "pmacct-host-binding-"));
		try {
			cpSync(new URL("../provider-payload-stream.ts", import.meta.url), join(dir, "provider-payload-stream.ts"));
			const nested = join(dir, "node_modules/@earendil-works/pi-ai");
			mkdirSync(nested, { recursive: true });
			writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", version: "0.85.1", type: "module", exports: { ".": "./compat.js", "./compat": "./compat.js" } }));
			writeFileSync(join(nested, "compat.js"), 'export function getApiProvider() { throw new Error("STALE_NESTED_TRANSPORT"); }');
			const entry = join(dir, "fixture.ts");
			writeFileSync(entry, `import { createPayloadStream } from "./provider-payload-stream.ts";
export default function(pi) { pi.registerProvider("fixture", { api: ${JSON.stringify(api)}, baseUrl: "https://fixture.invalid", apiKey: "fixture", streamSimple: createPayloadStream(payload => ({ ...payload, shaped: true })) }); }`);
			const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir,
				settingsManager: SettingsManager.inMemory(), noExtensions: true, noSkills: true,
				noPromptTemplates: true, additionalExtensionPaths: [entry] });
			await loader.reload();
			const loaded = loader.getExtensions();
			assert.deepEqual(loaded.errors, []);
			const streamSimple = loaded.runtime.pendingProviderRegistrations.find(r => r.name === "fixture")!.config.streamSimple!;
			const tool = { name: "probe", description: "fixture", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } };
			const modern = Number(VERSION.split(".")[1]) >= 86;
			const context: any = modern ? { messages: [
				{ role: "system", content: "SYSTEM_MARKER", toolsAdded: [{ ...tool, name: "obsolete" }], timestamp: 0 },
				{ role: "system", content: "UPDATED_MARKER", toolsRemoved: [{ name: "obsolete" }], toolsAdded: [tool], timestamp: 1 },
				{ role: "user", content: "Use probe", timestamp: 2 },
			] } : { systemPrompt: "SYSTEM_MARKER UPDATED_MARKER", tools: [tool], messages: [{ role: "user", content: "Use probe", timestamp: 2 }] };
			const original = structuredClone(context);
			const model: any = { api, provider: "fixture", id: "fixture-model", baseUrl: "https://fixture.invalid/v1", reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
			const bodies: any[] = [];
			const options: any = { apiKey: "fixture", maxRetries: 0, onPayload: (payload: any) => ({ ...payload, caller: true }), fetch: async (_url: any, init: any) => {
				const body = JSON.parse(init.body); bodies.push(body);
				const first = bodies.length === 1;
				const data = api === "anthropic-messages" ? [
					{ type: "message_start", message: { id: "fixture", type: "message", role: "assistant", model: model.id, content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
					{ type: "content_block_start", index: 0, content_block: first ? { type: "tool_use", id: "call_fixture", name: "probe", input: {} } : { type: "text", text: "" } },
					{ type: "content_block_delta", index: 0, delta: first ? { type: "input_json_delta", partial_json: '{"value":"ok"}' } : { type: "text_delta", text: "DONE" } },
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: first ? "tool_use" : "end_turn" }, usage: { output_tokens: 1 } },
					{ type: "message_stop" },
				].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("") : [
					{ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: first ? { role: "assistant", tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: "probe", arguments: '{"value":"ok"}' } }] } : { role: "assistant", content: "DONE" }, finish_reason: null }] },
					{ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }] },
				].map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
				return new Response(data, { headers: { "content-type": "text/event-stream" } });
			} };
			const first = await streamSimple(model, context, options).result();
			assert.equal(first.stopReason, "toolUse", first.errorMessage);
			const call: any = first.content.find((block: any) => block.type === "toolCall");
			assert.equal(call?.name, "probe");
			assert.deepEqual(call?.arguments, { value: "ok" });
			assert.deepEqual(context, original, "caller context is not rewritten");
			context.messages.push(first, { role: "toolResult", toolCallId: call.id, toolName: "probe", content: [{ type: "text", text: "RESULT_MARKER" }], isError: false, timestamp: 3 });
			const second = streamSimple(model, context, options);
			const events: any[] = [];
			for await (const event of second) events.push(event);
			assert.equal((await second.result()).stopReason, "stop");
			assert.ok(events.some(event => event.type === "done"));
			assert.equal(bodies.length, 2);
			for (const body of bodies) {
				assert.equal(body.caller, true); assert.equal(body.shaped, true);
				const tools = body.tools.map((t: any) => t.function ?? t);
				assert.deepEqual(tools.map((t: any) => t.name), ["probe"]);
				assert.deepEqual(tools[0].parameters ?? tools[0].input_schema, tool.parameters);
				assert.match(JSON.stringify(body), /SYSTEM_MARKER/);
				assert.match(JSON.stringify(body), /UPDATED_MARKER/);
			}
			assert.match(JSON.stringify(bodies[1]), /RESULT_MARKER/);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
}
