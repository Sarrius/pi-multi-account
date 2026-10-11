import assert from "node:assert/strict";
import test from "node:test";
import { createPayloadStream, cursorPayloadStream, shapeCursorPayload } from "../provider-payload-stream.ts";

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

test("Cursor provider's native HTTP serializer carries explicit tool errors rather than guessing from text", async () => {
	let body:any;
	const model={api:"openai-completions",provider:"cursor",id:"fixture",baseUrl:"https://fixture.invalid/v1",reasoning:false,input:["text"],contextWindow:10000,maxTokens:100,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
	const assistant={role:"assistant",api:model.api,provider:model.provider,model:model.id,content:[{type:"toolCall",id:"r1",name:"read",arguments:{path:"missing"}}],stopReason:"toolUse",usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:0};
	const stream=cursorPayloadStream(model,{messages:[{role:"user",content:"TASK_A",timestamp:0},assistant,{role:"toolResult",toolCallId:"r1",toolName:"read",content:[{type:"text",text:"explicit failure"}],isError:true,timestamp:0}]},{apiKey:"fixture",sessionId:"owner",cwd:"/project/a",maxRetries:0,fetch:async (_url:any,init:any)=>{body=JSON.parse(init.body);return new Response(JSON.stringify({error:{message:"fixture finished"}}),{status:400});}});
	await stream.result();assert.equal(body.pi_cwd,"/project/a");assert.equal(body.messages.find((message:any)=>message.role==="tool").pi_tool_error,true);
	const ambiguous=shapeCursorPayload({messages:[{role:"tool",tool_call_id:"duplicate",content:"not evidence"}]},{},{messages:[{role:"toolResult",toolCallId:"duplicate",isError:true},{role:"toolResult",toolCallId:"duplicate",isError:false}]});
	assert.equal(ambiguous.messages[0].pi_tool_error,undefined,"duplicate ids must not borrow another execution's outcome");
});

test("Cursor outcome forwarding matches the host's pipe-id normalization without sibling collisions", async () => {
	for(const ids of [["shared|item+one","shared|item/two"],["long-call|"+"a".repeat(300),"long-call|"+"b".repeat(300)]]){
		let body:any;const model:any={api:"openai-completions",provider:"cursor",id:"fixture",baseUrl:"https://fixture.invalid/v1",reasoning:false,input:["text"],contextWindow:10000,maxTokens:100,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
		const assistant={role:"assistant",api:model.api,provider:model.provider,model:model.id,content:ids.map(id=>({type:"toolCall",id,name:"read",arguments:{path:"fixture"}})),stopReason:"toolUse",usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{}},timestamp:0};
		const stream=cursorPayloadStream(model,{messages:[{role:"user",content:"TASK_A",timestamp:0},assistant,...ids.map((id,index)=>({role:"toolResult",toolCallId:id,toolName:"read",content:[{type:"text",text:"fixture"}],isError:index===0,timestamp:0}))]},{apiKey:"fixture",maxRetries:0,fetch:async (_url:any,init:any)=>{body=JSON.parse(init.body);return new Response(JSON.stringify({error:{message:"fixture finished"}}),{status:400});}});
		await stream.result();const messages=body.messages.filter((message:any)=>message.role==="tool");assert.equal(messages.length,2);assert.notEqual(messages[0].tool_call_id,messages[1].tool_call_id);assert.deepEqual(messages.map((message:any)=>message.pi_tool_error),[true,false]);
	}
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
