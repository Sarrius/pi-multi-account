import assert from "node:assert/strict";
import test from "node:test";
import { authorization, createAntigravityOAuth as createGoogleOAuth, REDIRECT as REDIRECT_URI } from "../antigravity/oauth.ts";
import { callbackCode as parseCallback, listenForGoogleCallback as listenCallback } from "../google-transport/callback.ts";
import { events } from "../google-transport/sse.ts";
import { post, TOKEN_URL } from "../google-transport/http.ts";
import { BASE as BASE_URL, PROJECT_HEADER } from "../antigravity/transport.ts";
import { createAntigravityStream } from "../antigravity/stream.ts";
import { createGoogleReplayCache } from "../google-transport/replay.ts";
const callbackCode=(input:string,state:string)=>parseCallback(input,state,REDIRECT_URI);
const listenForGoogleCallback=(state:string,signal:AbortSignal,port:number)=>listenCallback(state,signal,port,REDIRECT_URI);
const fixtureStream=(models:readonly Model<Api>[],options:{fetch:typeof fetch})=>createAntigravityStream(models,{...options,oauth:createGoogleOAuth(options.fetch)});
import type { Model, Api } from "@earendil-works/pi-ai";
import { normalizeContext, supportsNativeTranscript } from "../google-transport/native.ts";
const streamTest = supportsNativeTranscript ? test : test.skip;

const definition: Model<Api> = { id: "synthetic-gemini", name: "Synthetic fixture", provider: "google",
 api: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com", reasoning: false,
 input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 };
const context = supportsNativeTranscript ? normalizeContext({ systemPrompt: "Fixture system", tools: [{ name: "read", description: "Fixture read",
 parameters: { type: "object", properties: { path: { type: "string" } } } }],
 messages: [{ role: "user", content: "Read fixture", timestamp: 1 }] }) : null!;
const requestAuth = { sessionId: "synthetic-task", apiKey: "synthetic-access", headers: { [PROJECT_HEADER]: "fixture-project" }, maxRetries: 0 };
const sse = (frames: unknown[]) => frames.map(response => `data: ${JSON.stringify({ response })}\n\n`).join("");

streamTest("Google provider native transcript, hooks, signed tools and replay complete without hidden retries", async () => {
 let calls = 0, responseHooks = 0, frameHooks = 0; const requests: any[] = [];
 const provider = fixtureStream([definition], { fetch: (async (_url, options) => {
  calls++; requests.push(JSON.parse(String(options?.body)));
  assert.equal(new Headers(options?.headers).get(PROJECT_HEADER), null);
  return new Response(sse([{ candidates: [{ content: { parts: calls === 1
   ? [{text:"",thoughtSignature:"ZW1wdHk="}, { functionCall: { id: "tool1", name: "read", args: { path: "fixture" } }, thoughtSignature: "c2lnbmVk" }]
   : [{ text: "finished" }] }, finishReason: "STOP" }],
   usageMetadata: { promptTokenCount: 12, cachedContentTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 15 } }]));
 }) as typeof fetch });
 const model = provider.getModels()[0];
 const first = provider.streamSimple(model, context, { ...requestAuth,
  onPayload: payload => { assert.ok(JSON.stringify(payload).includes("Fixture system")); },
  onResponse: () => { responseHooks++; }, onProviderStreamEvent: () => { frameHooks++; } });
 const eventNames: string[] = []; for await (const event of first) {
  eventNames.push(event.type);
  if(event.type==="text_delta" || event.type==="thinking_delta")assert.ok(event.delta.length>0,"signature-only parts must not emit empty deltas");
  if(event.type==="toolcall_end")assert.deepEqual(Object.keys(event.toolCall).sort(),["arguments","id","name","type"],"private signatures stay in native replay only");
 }
 const result = await first.result(); assert.equal(result.stopReason, "toolUse");
 assert.equal(result.usage.input, 10); assert.equal(result.content.find(b=>b.type==="toolCall")?.thoughtSignature, "c2lnbmVk");
 assert.ok(eventNames.includes("toolcall_end")); assert.equal(responseHooks, 1); assert.equal(frameHooks, 1);
 const replay = normalizeContext({ messages: [...context.messages, result, { role: "toolResult", toolCallId: "tool1",
  toolName: "read", content: [{ type: "text", text: "fixture content" }], isError: false, timestamp: 2 }] });
 const next = provider.streamSimple(model, replay, requestAuth); for await (const _ of next) {}
 assert.equal((await next.result()).stopReason, "stop"); assert.equal(calls, 2);
 assert.match(JSON.stringify(requests[1]), /fixture content/); assert.match(JSON.stringify(requests[1]), /c2lnbmVk/);
 const canonical = { ...replay, messages: replay.messages.map(message => message.role !== "assistant" ? message : ({
  role: "assistant", content: message.content.filter(block => block.type !== "thinking").map(block => block.type === "toolCall"
   ? { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments } : { type: "text", text: (block as any).text })
 })) } as any;
 const childTurn = provider.streamSimple(model, canonical, requestAuth); for await (const _ of childTurn) {}
 assert.equal((await childTurn.result()).stopReason, "stop");
 assert.match(JSON.stringify(requests[2]), /c2lnbmVk/, "parent restores signed native tool call from exact broker projection");
 const cache = createGoogleReplayCache(() => 100);
 const binding = cache.binding(model.provider, model.id, "project", "access", "task");
 cache.retain(binding, result);
 const restored = cache.restore(binding, canonical);
 const assistantIndex = canonical.messages.findIndex((message: any) => message.role === "assistant");
 assert.equal((restored.messages[assistantIndex] as any).provider, model.provider);
 const other = cache.binding(model.provider, model.id, "project", "different-access", "task");
 assert.equal((cache.restore(other, canonical).messages[assistantIndex] as any).provider, undefined);
 const tampered = structuredClone(canonical); tampered.messages[assistantIndex].content.find((b:any)=>b.type==="toolCall").arguments.path = "other";
 assert.equal((cache.restore(binding, tampered).messages[assistantIndex] as any).provider, undefined);
});

streamTest("SSE text fragments form one semantic block for native RPC/Broker extraction",async()=>{
 const p=fixtureStream([definition],{fetch:(async()=>new Response(sse([
  {candidates:[{content:{role:"model"}}],responseId:"fixture-metadata"},
  {candidates:[{content:{parts:[{text:"nonce-"}]}}]},
  {candidates:[{content:{parts:[{text:"value"}]},finishReason:"STOP"}]},
 ]))) as typeof fetch});
 const stream=p.streamSimple(p.getModels()[0],context,requestAuth);const types:string[]=[];
 for await(const e of stream)types.push(e.type);
 const result=await stream.result();assert.equal(result.stopReason,"stop",result.errorMessage);
 assert.equal(result.content.filter(p=>p.type==="text").map(p=>p.text).join("\n"),"nonce-value");
 assert.equal(types.filter(t=>t==="text_start").length,1);assert.equal(types.filter(t=>t==="text_end").length,1);
});

for (const scenario of ["truncated", "malformed", "unknown_finish", "rate_limit", "cancelled", "foreign_route"] as const) {
 streamTest(`Google provider rejects ${scenario} without executable tools or success terminal`, async () => {
  let calls = 0; const controller = new AbortController();
  const provider = fixtureStream([definition], { fetch: (async () => {
   calls++;
   if (scenario === "rate_limit") return new Response(null, { status: 429 });
   const call = { candidates: [{ content: { parts: [{ functionCall: { name: "read", args: {} } }] },
    ...(scenario === "unknown_finish" ? { finishReason: "SAFETY" } : {}) }] };
   return new Response(scenario === "malformed" ? 'data: not-json\n\n' : sse([call]));
  }) as typeof fetch });
  if (scenario === "cancelled") controller.abort();
  const original = provider.getModels()[0];
  const stream = provider.streamSimple(scenario === "foreign_route" ? { ...original, baseUrl: "https://evil.test" } : original,
   context, { ...requestAuth, signal: controller.signal });
  const types: string[] = []; for await (const event of stream) types.push(event.type);
  assert.ok(types.includes("error")); assert.ok(!types.includes("done")); assert.ok(!types.includes("toolcall_end"));
  assert.equal(calls, ["cancelled", "foreign_route"].includes(scenario) ? 0 : 1);
 });
}

const credential = { type: "oauth" as const, access: "old-access", refresh: "old-refresh", expires: 1, projectId: "account-project", antigravityVersion:1, accountId:"google:123" };
test("Google browser callback rejects wrong state then joins its loopback listener", async () => {
 const controller = new AbortController(); const listener = await listenForGoogleCallback("expected", controller.signal, 0);
 try {
  const base = `http://127.0.0.1:${listener.port}/oauth-callback`;
  assert.equal((await fetch(base + "?code=synthetic&state=wrong")).status, 400);
  assert.equal((await fetch(base + "?code=synthetic&state=expected")).status, 200);
  assert.equal(await listener.code, "synthetic");
 } finally { await listener.close(); }
 await assert.rejects(fetch(`http://127.0.0.1:${listener.port}/`));
 const pending = await listenForGoogleCallback("expected", controller.signal, 0);
 controller.abort(); await assert.rejects(pending.code); await pending.close();
});

test("Google OAuth PKCE binds callback state and exact destination", () => {
 const auth = authorization(); const url = new URL(auth.url);
 assert.equal(url.searchParams.get("code_challenge_method"), "S256");
 assert.equal(url.searchParams.get("state"), auth.state);
 const callback = `${REDIRECT_URI}?code=code&state=${auth.state}`;
 assert.equal(callbackCode(callback, auth.state), "code");
 for (const bad of ["bare-code", callback.replace("localhost", "evil.test"), callback + "&state=other", callback.replace(auth.state, "wrong")]) assert.throws(() => callbackCode(bad, auth.state));
});
test("Google refresh preserves per-account metadata and never dispatches to an override", async () => {
 let calls = 0;
 const oauth = createGoogleOAuth((async (url, options) => {
  calls++; assert.equal(url, TOKEN_URL); assert.equal(options?.redirect, "error");
  assert.match(String(options?.body), /refresh_token=old-refresh/);
  return Response.json({ access_token: "new-access", token_type: "Bearer", expires_in: 3600 });
 }) as typeof fetch);
 const refreshed = await oauth.refresh(credential, new AbortController().signal);
 assert.equal(refreshed.projectId, "account-project"); assert.equal(refreshed.refresh, "old-refresh");
 const auth = await oauth.toAuth(refreshed);
 assert.deepEqual(auth, { apiKey: "new-access", baseUrl: BASE_URL, headers: { [PROJECT_HEADER]: "account-project" } });
 assert.equal(calls, 1); assert.ok(!JSON.stringify(auth).includes("old-refresh"));
 await assert.rejects(post((async () => { calls++; return new Response(); }) as typeof fetch, "https://evil.test", "", new AbortController().signal, {}), /Foreign/);
 assert.equal(calls, 1);
});
test("Google malformed token response and redirected bearer response fail closed", async () => {
 const oauth = createGoogleOAuth((async () => Response.json({ access_token: "new", token_type: "Bearer", expires_in: "3600" })) as typeof fetch);
 await assert.rejects(oauth.refresh(credential, new AbortController().signal), /Malformed/);
 await assert.rejects(post((async () => new Response(null, { status: 302, headers: { Location: "https://evil.test" } })) as typeof fetch, TOKEN_URL, "", new AbortController().signal, {}), /redirect/);
});
test("Google cancellation refuses token dispatch", async () => {
 let calls = 0; const controller = new AbortController(); controller.abort();
 const oauth = createGoogleOAuth((async () => { calls++; return new Response(); }) as typeof fetch);
 await assert.rejects(oauth.refresh(credential, controller.signal)); assert.equal(calls, 0);
});
async function parse(text: string) {
 const result = []; const body = new Response(text).body!;
 for await (const event of events(body, new AbortController().signal)) result.push(event);
 return result;
}
test("Google SSE supports framed data and rejects malformed/truncated or post-terminal frames", async () => {
 assert.deepEqual(await parse('data: {"response":\ndata: {"ok":true}}\n\n'), [{ response: { ok: true } }]);
 await assert.rejects(parse('data: {broken}\n\n'), /Malformed/);
 await assert.rejects(parse('data: {"ok":true}'), /Truncated/);
 await assert.rejects(parse('data: [DONE]\n\ndata: {}\n\n'), /after terminator/);
});
test("Google SSE bounds unterminated frames and cancels blocked reads", async () => {
 const signal = new AbortController().signal;
 await assert.rejects(async () => { for await (const _ of events(new Response("data: " + "x".repeat(50)).body!, signal, 20)) {} }, /exceeds/);
 const controller = new AbortController(); let cancelled = false;
 const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
 const pending = (async () => { for await (const _ of events(body, controller.signal)) {} })();
 controller.abort(); await assert.rejects(pending); assert.equal(cancelled, true);
});
