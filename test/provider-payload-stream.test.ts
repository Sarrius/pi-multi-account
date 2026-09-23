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

test("lazy transport setup rejection reaches both stream consumers", async () => {
	const wrapped = createPayloadStream(payload => payload, async () => { throw new Error("fixture setup failure"); });
	const stream = wrapped({ api: "fixture" }, { messages: [] });
	await assert.rejects(stream.result(), /fixture setup failure/);
	await assert.rejects(async () => { for await (const _event of stream) { assert.fail("no events after setup failure"); } }, /fixture setup failure/);
});

test("cancellation during lazy initialization reaches one shared native stream", async () => {
	const controller = new AbortController();
	let release!: () => void;
	const ready = new Promise<void>(resolve => { release = resolve; });
	let starts = 0;
	const result = { stopReason: "aborted" };
	const wrapped = createPayloadStream(payload => payload, async () => {
		await ready;
		return { streamSimple: (_model, _context, options) => {
			starts++;
			assert.equal(options.signal, controller.signal);
			assert.equal(options.signal.aborted, true);
			return { async *[Symbol.asyncIterator]() { yield { type: "error", reason: "aborted", error: result }; }, async result() { return result; } };
		} };
	});
	const stream = wrapped({ api: "fixture" }, { messages: [] }, { signal: controller.signal });
	controller.abort(); release();
	const events: any[] = [];
	for await (const event of stream) events.push(event);
	assert.equal(await stream.result(), result);
	assert.equal(events[0].reason, "aborted");
	assert.equal(starts, 1);
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
