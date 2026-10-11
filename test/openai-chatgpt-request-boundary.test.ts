import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import * as Host from "@earendil-works/pi-coding-agent";
import { assertOpenAIChatGPTConfiguration, cloneOpenAIChatGPTProvider, supportsOpenAIChatGPT } from "../openai-chatgpt.ts";

const native = builtinProviders().find(provider => supportsOpenAIChatGPT(provider));
const grant = { type: "oauth", access: "synthetic-direct-grant", refresh: "synthetic-refresh", expires: 4102444800000, clientId: "issued-fixture-client", scopes: ["openid", "chatgpt.tokens.use.direct"] };
const unsupported = ["max_output_tokens", "temperature", "prompt_cache_retention", "prompt_cache_options"];

for (const baseUrl of ["https://api.openai.com/v1", "http://127.0.0.1:41977/openai-account-2/v1"]) {
  test(`issue92: actual native subscription payload restrictions survive aliasing (${baseUrl})`, { skip: !native }, async () => {
    const options = { apiKey: grant.access, maxRetries: 0, maxTokens: 512, temperature: 0.5, cacheRetention: "long", sessionId: "fixture" };
    let original: any, cloned: any;
    const model: any = native!.getModels().find(model => model.id === "gpt-6.1-sol") ?? native!.getModels()[0];
    await native!.streamSimple(model, { messages: [] } as any, { ...options, fetch: async (_url: any, init: any) => { original = JSON.parse(init.body); throw new Error("OFFLINE_PAYLOAD_CAPTURE_ONLY"); } } as any).result();
    const alias = cloneOpenAIChatGPTProvider(native, "openai-account-2", baseUrl, value => value);
    await alias.streamSimple(alias.getModels().find((entry: any) => entry.id === model.id), { messages: [] }, { ...options, fetch: async (_url: any, init: any) => { cloned = JSON.parse(init.body); throw new Error("OFFLINE_PAYLOAD_CAPTURE_ONLY"); } }).result();
    assert.ok(original); assert.ok(cloned);
    let afterHook: any;
    await alias.streamSimple(alias.getModels().find((entry: any) => entry.id === model.id), { messages: [] }, { ...options,
      onPayload: (payload: any) => ({ ...payload, max_output_tokens: 777, temperature: 1, prompt_cache_retention: "24h", prompt_cache_options: { ttl: "30m" }, ownerMarker: "PRESERVED" }),
      fetch: async (_url: any, init: any) => { afterHook = JSON.parse(init.body); throw new Error("OFFLINE_PAYLOAD_CAPTURE_ONLY"); },
    }).result();
    assert.equal(afterHook.ownerMarker, "PRESERVED");
    for (const field of unsupported) {
      assert.equal(original[field], undefined, `native base suppresses ${field}`);
      assert.equal(cloned[field], undefined, `native subscription alias suppresses ${field}`);
      assert.equal(afterHook[field], undefined, `final guard suppresses ${field} after caller hook`);
    }
  });
}

for (const api of ["openai-responses", "openai-completions"]) {
  test(`issue92: real host composition cannot redirect a direct grant via ${api}`, { skip: !native }, async () => {
    const root = mkdtempSync(join(tmpdir(), "pmacct-auth-binding-"));
    const modelsPath = join(root, "models.json");
    writeFileSync(modelsPath, JSON.stringify({ providers: { "openai-account-2": { models: [{ id: "foreign", api, baseUrl: "https://foreign.example/v1", reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 100 }] } } }));
    const sdk: any = Host;
    let sent = 0;
    try {
      const runtime = await sdk.ModelRuntime.create({ modelsPath, refreshOnCreate: false, credentials: {
        read: async (id: string) => id === "openai-account-2" ? grant : undefined,
        list: async () => [{ providerId: "openai-account-2", type: "oauth" }],
        modify: async (_id: string, fn: any) => await fn(grant) ?? grant,
        delete: async () => {},
      } });
      runtime.registerNativeProvider(cloneOpenAIChatGPTProvider(native, "openai-account-2", "https://api.openai.com/v1", value => value, undefined,
        () => assertOpenAIChatGPTConfiguration(undefined, "openai-account-2", "https://api.openai.com/v1", runtime.getModels("openai-account-2"))));
      const model = runtime.getModel("openai-account-2", "foreign"); assert.ok(model, "actual composed custom model exists");
      const result = await runtime.streamSimple(model, { messages: [{ role: "user", content: "route-boundary", timestamp: 0 }] }, { maxRetries: 0, fetch: async (_url: any, _init: any) => { sent++; throw new Error("NO_EXTERNAL_NETWORK"); } }).result();
      assert.equal(result.stopReason, "error"); assert.equal(sent, 0, "route refusal before any grant dispatch, even generic API branch");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test(`issue92: actual extension rejects composed ${api} foreign destinations before grant dispatch`, { skip: !native, timeout: 20000 }, async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [new URL("./fixtures/openai-composed-boundary-probe.mts", import.meta.url).pathname, api], { timeout: 15000, maxBuffer: 1024 * 1024 });
    const report = JSON.parse(stdout.trim().split("\n").at(-1)!);
    assert.equal(report.accepted, true); assert.equal(report.dispatched, 0); assert.equal(report.credentialPreserved, true);
  });
}
