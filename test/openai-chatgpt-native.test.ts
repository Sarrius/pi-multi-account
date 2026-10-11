import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import test from "node:test";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import * as AI from "@earendil-works/pi-ai";
import { cloneOpenAIChatGPTProvider, supportsOpenAIChatGPT } from "../openai-chatgpt.ts";

const native = builtinProviders().find(provider => supportsOpenAIChatGPT(provider));
const run = promisify(execFile);

test("issue92: native host emits dynamic-client/device/scope authorization and persists issued metadata", { skip: !native }, async () => {
  const credentials = new Map<string, any>();
  const api: any = AI;
  const models = api.createModels({ credentials: {
    read: async (id: string) => credentials.get(id),
    list: async () => [...credentials].map(([providerId, credential]) => ({ providerId, type: credential.type })),
    modify: async (id: string, callback: any) => { const next = await callback(credentials.get(id)); if (next) credentials.set(id, next); return credentials.get(id); },
    delete: async (id: string) => { credentials.delete(id); },
  }, authContext: { env: async () => "FORBIDDEN_PAID_KEY", fileExists: async () => false } });
  models.setProvider(cloneOpenAIChatGPTProvider(native, "openai-account-2", "https://api.openai.com/v1", value => value));
  const original = globalThis.fetch;
  const issued = "issued-native-fixture-client", device = "60466780-5ce8-4391-8390-f8f8f566660b";
  let authorization: URL | undefined, exchanges = 0, promptSignal: AbortSignal | undefined;
  globalThis.fetch = (async (url: any, init: any) => {
    assert.equal(String(url), "https://auth.openai.com/api/accounts/oauth/token"); exchanges++;
    const body = init.body as URLSearchParams;
    assert.equal(body.get("client_id"), issued); assert.equal(body.get("resource"), "https://api.openai.com/v1");
    assert.equal(body.get("grant_type"), "authorization_code"); assert.equal(body.get("code"), "synthetic-code");
    assert.ok(body.get("code_verifier")); assert.equal(body.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
    assert.ok(init.signal instanceof AbortSignal);
    return new Response(JSON.stringify({ access_token: "synthetic-direct", refresh_token: "synthetic-refresh", expires_in: 3600, id_token: "synthetic-id-presence-only", scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct" }));
  }) as typeof fetch;
  try {
    const credential = await models.login("openai-account-2", "oauth", {
      signal: AbortSignal.timeout(5000),
      notify(event: any) { if (event.type === "auth_url") authorization = new URL(event.url); },
      async prompt(prompt: any) {
        assert.equal(prompt.type, "manual_code"); assert.ok(authorization);
        promptSignal = prompt.signal;
        const callback = new URL("http://127.0.0.1:1455/auth/callback");
        callback.search = new URLSearchParams({ state: authorization!.searchParams.get("state")!, code: "synthetic-code", client_id: issued }).toString();
        return callback.toString();
      },
    }, { getDeviceId: () => device, agentName: "Native test host" });
    assert.equal(authorization!.pathname, "/api/accounts/authorize");
    assert.equal(authorization!.searchParams.get("client_id"), "dynamic_agent_client");
    assert.equal(authorization!.searchParams.get("ext_agent_host_id"), `urn:uuid:${device}`);
    // Earlier supporting hosts use a native literal name; newer ones forward agentName.
    assert.ok(["Pi", "Native test host"].includes(authorization!.searchParams.get("agent_name_hint")!));
    assert.match(authorization!.searchParams.get("scope")!, /chatgpt.tokens.use.direct/);
    assert.equal(authorization!.searchParams.get("resource"), "https://api.openai.com/v1");
    assert.equal(authorization!.searchParams.get("code_challenge_method"), "S256");
    assert.equal(credential.clientId, issued); assert.ok(credential.scopes.includes("chatgpt.tokens.use.direct"));
    assert.deepEqual(credentials.get("openai-account-2"), credential); assert.equal(exchanges, 1);
    assert.equal(promptSignal!.aborted, true, "the native prompt's own cancellation was retained");
    assert.equal((await models.getAuth("openai-account-2")).auth.apiKey, "synthetic-direct");
    await models.logout("openai-account-2");
    assert.equal(await models.getAuth("openai-account-2"), undefined, "no ambient paid fallback after logout");
  } finally { globalThis.fetch = original; }
  const listener = createServer(); await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(1455, "127.0.0.1", resolve); });
  await new Promise<void>(resolve => listener.close(() => resolve()));
});

test("issue92: native login cancellation joins its manual prompt and releases the callback listener", { skip: !native }, async () => {
  const alias = cloneOpenAIChatGPTProvider(native, "openai-account-2", "https://api.openai.com/v1", () => { throw new Error("must not publish a cancelled login"); });
  const controller = new AbortController(); let promptSignal: AbortSignal | undefined;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("cancelled login must not exchange a token"); }) as typeof fetch;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(alias.auth.oauth.login({ signal: controller.signal, notify() {}, prompt(prompt: any) {
      promptSignal = prompt.signal;
      timer = setTimeout(() => controller.abort(), 20);
      return new Promise((_, reject) => prompt.signal.addEventListener("abort", () => reject(new Error("prompt cancelled")), { once: true }));
    } }, { getDeviceId: () => "60466780-5ce8-4391-8390-f8f8f566660b" }), /Login cancelled/);
    assert.equal(promptSignal!.aborted, true);
  } finally { if (timer) clearTimeout(timer); globalThis.fetch = original; }
  const listener = createServer(); await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(1455, "127.0.0.1", resolve); });
  await new Promise<void>(resolve => listener.close(() => resolve()));
});

test("issue92: fresh native host publishes a Responses-only extension-free image/tool/replay/cancel route and restores it", { skip: !native, timeout: 60000 }, async () => {
  const { stdout, stderr } = await run(process.execPath, [new URL("./fixtures/openai-chatgpt-native-probe.mts", import.meta.url).pathname], { timeout: 50000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(stderr.includes("Extension error"), false, stderr);
  const report = JSON.parse(stdout.trim().split("\n").at(-1)!);
  assert.equal(report.accepted, true); assert.equal(report.childExtensionFree, true); assert.equal(report.responses, 3);
  assert.equal(report.tools, 1); assert.equal(report.image, true); assert.equal(report.toolReplay, true);
  assert.equal(report.cancellationClosedOriginal, true); assert.equal(report.restored, true);
});
