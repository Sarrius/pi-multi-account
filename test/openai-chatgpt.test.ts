import assert from "node:assert/strict";
import test from "node:test";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { cloneOpenAIChatGPTProvider, isOpenAIChatGPTCredential, supportsOpenAIChatGPT } from "../openai-chatgpt.ts";
import { placeholderKeyFor, proxyFamilyFor, shapeOpenAIChatGPTPayload, shapeUpstreamRequest } from "../slot-proxy.ts";
import { applyShadowPlan, applyRestorePlan, mergeParentAuth } from "../slot-proxy-auth.ts";
import { usageFamily } from "../usage.ts";

const credential = { type: "oauth", access: "synthetic-direct-access", refresh: "synthetic-direct-refresh", expires: 4102444800000, clientId: "issued-client", scopes: ["resource.invoke", "chatgpt.tokens.use.direct"] };
function nativeFixture() {
  const calls: any[] = [];
  const chat = { provider: "openai", id: "native-frontier", api: "openai-responses", baseUrl: "https://api.openai.com/v1", type: "chat", reasoning: true, thinkingLevelMap: { high: "high", xhigh: "xhigh" }, input: ["text", "image"], contextWindow: 200000, maxTokens: 4096, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
  const classifier = { ...chat, id: "classifier", type: "classifier", api: "openai-decisions" };
  const provider: any = { id: "openai", name: "OpenAI", baseUrl: chat.baseUrl, headers: { "native-header": "preserve" }, getModels: () => [chat], getAllModels: () => [chat, classifier], stream: (...args: any[]) => { calls.push(args); return "native-stream"; }, streamSimple: (...args: any[]) => { calls.push(args); return "native-simple"; }, auth: { apiKey: { resolve: () => { throw new Error("must not inherit ambient OPENAI_API_KEY"); } }, oauth: { name: "ChatGPT subscription", isSubscription: true, login: async (interaction: any, options: any) => { calls.push([interaction, options]); return credential; }, refresh: async (current: any, signal: any) => { calls.push([current, signal]); return { ...current, access: "rotated" }; }, toAuth: async (current: any) => ({ apiKey: current.access }) } }, filterAllModels: (models: any[], current: any) => current?.type === "oauth" ? models.filter(model => model.type !== "classifier") : models };
  return { provider, chat, calls };
}

test("new OpenAI OAuth is capability-gated, not inferred from a host version or legacy Codex", () => {
  const { provider } = nativeFixture();
  assert.equal(supportsOpenAIChatGPT(provider), true);
  assert.equal(supportsOpenAIChatGPT({ ...provider, auth: { apiKey: provider.auth.apiKey } }), false);
  assert.equal(supportsOpenAIChatGPT({ ...provider, id: "openai-codex" }), false);
  assert.equal(supportsOpenAIChatGPT({ ...provider, getModels: () => [{ ...provider.getModels()[0], api: "openai-codex-responses" }] }), false);
});

test("native clone retains Responses/model metadata, filtering, login options and prompt cancellation", async () => {
  const { provider, chat, calls } = nativeFixture();
  const alias = cloneOpenAIChatGPTProvider(provider, "openai-account-2", "https://api.openai.com/v1", value => value);
  const signal = AbortSignal.timeout(5000), promptSignal = AbortSignal.timeout(5000);
  const interaction = { signal, notify() {}, async prompt(input: any) { assert.equal(input.signal, promptSignal); return "manual"; } };
  const options = { getDeviceId: () => "9d8b098f-04ef-4559-985f-86c1a60ca835", agentName: "Native host" };
  assert.deepEqual(await alias.auth.oauth.login(interaction, options), credential);
  assert.deepEqual(calls[0], [interaction, options]);
  assert.deepEqual(alias.getModels()[0], { ...chat, provider: "openai-account-2" });
  assert.deepEqual(alias.getAllModels().map((model: any) => model.id), [chat.id]);
  assert.equal(alias.streamSimple(alias.getModels()[0], { messages: [] }, { signal }), "native-simple");
  assert.equal(calls.at(-1)[2].signal, signal);
  assert.equal(alias.auth.oauth.isSubscription, true);
  assert.deepEqual(await alias.auth.oauth.toAuth(credential), { apiKey: credential.access, baseUrl: "https://api.openai.com/v1" });
  assert.deepEqual(await alias.auth.oauth.refresh(credential, signal), { ...credential, access: "rotated" });
  assert.equal(calls.at(-1)[1], signal);
});

test("subscription aliases cannot inherit stored or ambient paid API keys", async () => {
  const { provider } = nativeFixture();
  for (const base of ["https://api.openai.com/v1", "http://127.0.0.1:41977/openai-account-2/v1"]) {
    const alias = cloneOpenAIChatGPTProvider(provider, "openai-account-2", base, value => value);
    for (const stored of [undefined, { type: "api_key", key: "real-paid-key" }, { type: "api_key", key: "pi-multi-account-proxy" }]) {
      let ambientReads = 0;
      const args = { credential: stored, signal: AbortSignal.timeout(1000), ctx: { env: async () => { ambientReads++; return "ambient-paid-key"; } } };
      const expected = base.startsWith("http://127.0.0.1:") && stored?.key === "pi-multi-account-proxy";
      assert.equal(!!(await alias.auth.apiKey.resolve(args)), expected);
      assert.equal(!!(await alias.auth.apiKey.check(args)), expected);
      assert.equal(ambientReads, 0);
    }
    await assert.rejects(alias.auth.apiKey.login(), /subscription-only/);
  }
});

test("native clone refuses a foreign URL or another slot's placeholder route", () => {
  const { provider } = nativeFixture();
  for (const url of ["https://foreign.example/v1", "http://127.0.0.1:41977/openai-account-3/v1", "http://localhost:41977/openai-account-2/v1", "http://user@127.0.0.1:41977/openai-account-2/v1"]) {
    assert.throws(() => cloneOpenAIChatGPTProvider(provider, "openai-account-2", url, value => value), /exact parent-owned/);
  }
});

test("effective host/model overrides cannot dispatch a subscription grant to another route", () => {
  const { provider, calls } = nativeFixture();
  const alias = cloneOpenAIChatGPTProvider(provider, "openai-account-2", "https://api.openai.com/v1", value => value);
  for (const patch of [{ baseUrl: "https://foreign.example/v1" }, { api: "openai-codex-responses" }, { provider: "openai" }]) {
    for (const method of ["stream", "streamSimple"]) assert.throws(() => alias[method]({ ...alias.getModels()[0], ...patch }, { messages: [] }, {}), /exact native Responses route/);
  }
  assert.equal(calls.length, 0);
});

test("direct credentials require issued client/scopes and survive shadow/restore without Codex migration", () => {
  assert.equal(isOpenAIChatGPTCredential(credential), true);
  assert.equal(isOpenAIChatGPTCredential({ ...credential, clientId: undefined }), false);
  assert.equal(isOpenAIChatGPTCredential({ ...credential, scopes: ["openid"] }), false);
  assert.equal(isOpenAIChatGPTCredential({ type: "api_key", key: "paid" }), false);
  const codex = { type: "oauth", access: "legacy", refresh: "legacy-refresh", accountId: "legacy-workspace" };
  const original = { "openai-account-2": credential, "openai-codex": codex };
  const shadow = applyShadowPlan("openai-account-2", original, {});
  assert.deepEqual(shadow.auth["openai-account-2"], { type: "api_key", key: placeholderKeyFor("openai") });
  assert.deepEqual(mergeParentAuth(shadow.auth, shadow.sidecar), original);
  assert.deepEqual(applyRestorePlan("openai-account-2", shadow.auth, shadow.sidecar).auth, original);
});

test("native Responses proxy is separate from Codex and refuses metered or unrelated endpoints", () => {
  assert.equal(proxyFamilyFor("openai-account-2"), "openai");
  assert.equal(proxyFamilyFor("openai-codex-account-2"), "codex");
  const route = { slotId: "openai-account-2", family: "openai" as const };
  const shaped = shapeUpstreamRequest({ route, rest: "/v1/responses", credential, headers: { authorization: "Bearer pi-multi-account-proxy", "chatgpt-account-id": "placeholder", originator: "pi", "content-type": "application/json" } });
  assert.equal(shaped.ok, true);
  if (shaped.ok) {
    assert.equal(shaped.url, "https://api.openai.com/v1/responses");
    assert.equal(shaped.headers.authorization, `Bearer ${credential.access}`);
    assert.equal(shaped.headers["chatgpt-account-id"], undefined);
    assert.equal(shaped.headers.originator, undefined);
  }
  for (const rest of ["/codex/responses", "/wham/usage", "/v1/classify", "/v1/images/generations", "/v1/../responses", "/v1/responses?redirect=elsewhere"]) assert.equal(shapeUpstreamRequest({ route, rest, credential, headers: {} }).ok, false, rest);
  assert.equal(shapeUpstreamRequest({ route, rest: "/v1/responses", credential: { type: "api_key", key: "paid" }, headers: {} }).ok, false);
  assert.equal(usageFamily("openai-account-2"), undefined, "unknown usage must not call legacy Codex quota");
});

test("native subscription payload shaping is immutable, narrow and rejects non-object requests", () => {
  const input = { model: "gpt-fixture", input: [{ role: "user", content: "KEEP" }], stream: true, max_output_tokens: 123, temperature: 0.5, prompt_cache_options: { ttl: "30m" }, prompt_cache_retention: "24h", reasoning: { effort: "high" }, tools: [{ name: "read" }] };
  const original = structuredClone(input);
  assert.deepEqual(shapeOpenAIChatGPTPayload(input), { model: input.model, input: input.input, stream: true, reasoning: input.reasoning, tools: input.tools });
  assert.deepEqual(input, original);
  for (const malformed of [null, [], "payload"]) assert.throws(() => shapeOpenAIChatGPTPayload(malformed), /JSON object/);
});

test("actual host contract either supplies native new OpenAI OAuth or remains gated", () => {
  const native = builtinProviders().find(provider => provider.id === "openai");
  if (!supportsOpenAIChatGPT(native)) return;
  const clone = cloneOpenAIChatGPTProvider(native, "openai-account-2", "https://api.openai.com/v1", value => value);
  assert.ok(clone.getModels().length > 0);
  for (const model of clone.getAllModels()) { assert.equal(model.provider, "openai-account-2"); assert.equal(model.api, "openai-responses"); assert.ok(!model.type || model.type === "chat"); }
  assert.deepEqual(clone.getModels().map((model: any) => ({ ...model, provider: "openai" })), native!.getModels());
});
