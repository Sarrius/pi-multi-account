import assert from "node:assert/strict";
import test from "node:test";
import { createPayloadStream, cursorPayloadStream } from "../provider-payload-stream.ts";

test("provider payload wrapper composes async caller replacement and forwards stream controls unchanged", async () => {
	const controller = new AbortController();
	let forwarded: any;
	const stream = {};
	const model = { api: "fixture" }, context = { messages: [] };
	const onResponse = () => {};
	const wrapped = createPayloadStream((payload) => ({ ...payload, shaped: true }), () => ({
		streamSimple: (m, c, options) => { assert.equal(m, model); assert.equal(c, context); forwarded = options; return stream; },
	}));
	assert.equal(wrapped(model, context, { signal: controller.signal, maxRetries: 0, onResponse,
		onPayload: async () => ({ replacement: true }) }), stream);
	assert.deepEqual(await forwarded.onPayload({ original: true }, model), { replacement: true, shaped: true });
	assert.equal(forwarded.signal, controller.signal);
	assert.equal(forwarded.maxRetries, 0);
	assert.equal(forwarded.onResponse, onResponse);
});

test("Cursor public provider stream keeps independent sessions isolated without host events", async () => {
	const bodies: any[] = [];
	for (const sessionId of ["child-one", "child-two"]) {
		const stream = cursorPayloadStream({ api: "openai-completions", provider: "cursor", id: "fixture",
			baseUrl: "https://fixture.invalid/v1", reasoning: false, input: ["text"], contextWindow: 10000,
			maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
		{ messages: [{ role: "user", content: "identical task", timestamp: 0 }] }, {
			apiKey: "fixture", sessionId, maxRetries: 0,
			fetch: async (_url: any, init: any) => {
				bodies.push(JSON.parse(init.body));
				return new Response(JSON.stringify({ error: { message: "fixture finished" } }), { status: 400 });
			},
		});
		await stream.result();
	}
	assert.deepEqual(bodies.map((body) => body.pi_session_id), ["child-one", "child-two"]);
});
