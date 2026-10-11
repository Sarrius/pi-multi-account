import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import * as Host from "@earendil-works/pi-coding-agent";

// Fresh process: neither this parent nor either extension-free child can see live settings/auth.
const root = mkdtempSync(join(tmpdir(), "pmacct-direct-native-"));
const agentDir = join(root, "agent");
const cwd = join(root, "work");
mkdirSync(agentDir); mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.OPENAI_API_KEY = "FORBIDDEN_AMBIENT_PAID_KEY";
process.env.PI_MULTI_ACCOUNT_INDEPENDENT_ROOTS = "1";
const authPath = join(agentDir, "auth.json");
const modelsPath = join(agentDir, "models.json");
const grant = { type: "oauth", access: "synthetic-direct-access", refresh: "synthetic-direct-refresh", expires: 4102444800000, clientId: "issued-canary-client", scopes: ["openid", "resource.invoke", "chatgpt.tokens.use.direct"] };
const legacy = { type: "oauth", access: "legacy-codex-access", refresh: "legacy-codex-refresh", expires: 4102444800000, accountId: "legacy-workspace" };
const originalAuth = { "openai-account-2": grant, "openai-codex": legacy, openai: { type: "api_key", key: "FORBIDDEN_STORED_PAID_KEY" } };
writeFileSync(authPath, JSON.stringify(originalAuth));
writeFileSync(join(agentDir, "provider-failover.json"), JSON.stringify({ showUsage: false, autoDiscoverModels: false, autoContinue: false, includeOtherProviders: false, childProxy: true, showStatus: false }));
writeFileSync(modelsPath, JSON.stringify({ providers: { openai: { modelOverrides: { "gpt-6.1-sol": { samplingParams: { temperature: 0.2 } } } }, "openai-account-2": { modelOverrides: { "gpt-6.1-sol": { maxTokens: 4096 } } } } }));
writeFileSync(join(cwd, "read-marker.txt"), "DIRECT_TOOL_RESULT_MARKER\n");
const image = join(cwd, "pixel.png");
function pngChunk(type: string, bytes: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), bytes]); let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  const prefix = Buffer.alloc(4), suffix = Buffer.alloc(4); prefix.writeUInt32BE(bytes.length); suffix.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([prefix, body, suffix]);
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(16, 0); ihdr.writeUInt32BE(16, 4); ihdr[8] = 8; ihdr[9] = 2;
const rows = Buffer.alloc(16 * 49); for (let row = 0; row < 16; row++) for (let pixel = 0; pixel < 16; pixel++) rows[row * 49 + 1 + pixel * 3] = 255;
writeFileSync(image, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(rows)), pngChunk("IEND", Buffer.alloc(0))]));
const sdk: any = Host;
const offlineFetch = globalThis.fetch;
const requests: any[] = [];
let blocking = false, aborted = false, blockingStarted!: () => void;
const started = new Promise<void>(resolve => { blockingStarted = resolve; });
const tools: any[] = [];
let upstreamFailure: unknown;
function sse(events: any[]) { return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""); }
function responseEvents(first: boolean) {
  const id = `native-${first ? "tool" : "finish"}`;
  const item = first ? { type: "function_call", id: "fc_canary", call_id: "call_canary", name: "read", arguments: '{"path":"read-marker.txt"}', status: "completed" } : { type: "message", id: "msg_canary", role: "assistant", status: "completed", content: [{ type: "output_text", text: "DIRECT_NATIVE_DONE", annotations: [] }] };
  const events: any[] = [
    { type: "response.created", response: { id, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: first ? { ...item, arguments: "", status: "in_progress" } : { ...item, content: [], status: "in_progress" } },
  ];
  if (first) events.push({ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments }, { type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: item.arguments });
  else events.push({ type: "response.content_part.added", output_index: 0, content_index: 0, item_id: item.id, part: { type: "output_text", text: "", annotations: [] } }, { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: "DIRECT_NATIVE_DONE" }, { type: "response.output_text.done", output_index: 0, content_index: 0, item_id: item.id, text: "DIRECT_NATIVE_DONE" });
  events.push({ type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
  return sse(events);
}
const upstream = createServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v1/responses"); assert.equal(req.method, "POST");
    assert.equal(req.headers.authorization, `Bearer ${grant.access}`);
    assert.equal(req.headers["chatgpt-account-id"], undefined);
    assert.equal(req.headers.originator, undefined);
    let bytes = ""; for await (const part of req) bytes += part;
    const body = JSON.parse(bytes); requests.push(body);
    assert.equal(body.model, "gpt-6.1-sol"); assert.equal(body.stream, true);
    for (const field of ["max_output_tokens", "temperature", "prompt_cache_retention", "prompt_cache_options"]) assert.equal(body[field], undefined, `subscription rejects ${field}`);
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (blocking) { res.write(sse([{ type: "response.created", response: { id: "blocked", status: "in_progress", output: [] } }])); res.once("close", () => { aborted = true; }); blockingStarted(); return; }
    res.end(responseEvents(requests.length === 1));
  } catch (error) { upstreamFailure = error; res.writeHead(500); res.end(String(error)); }
});
await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as any).port}/v1/responses`;
const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
const port = (reservation.address() as any).port;
await new Promise<void>(resolve => reservation.close(() => resolve()));
process.env.PI_MULTI_ACCOUNT_SLOT_PROXY_PORT = String(port);
globalThis.fetch = (async (url: any, init?: any) => {
  const value = String(url?.url ?? url);
  if (value === "https://api.openai.com/v1/responses") return offlineFetch(upstreamUrl, init);
  if (value.startsWith("http://127.0.0.1:")) return offlineFetch(url, init);
  throw new Error(`OFFLINE_FIXTURE_REFUSES_EXTERNAL_ROUTE: ${value}`);
}) as typeof fetch;
let session: any, sibling: any;
let child: ReturnType<typeof spawn> | undefined;
async function settled(process: ReturnType<typeof spawn>, deadlineMs = 20000): Promise<{ code: number | null, signal: string | null, stdout: string, stderr: string }> {
  let stdout = "", stderr = "";
  process.stdout?.on("data", bytes => { stdout += bytes; }); process.stderr?.on("data", bytes => { stderr += bytes; });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { process.kill("SIGKILL"); reject(new Error(`child deadline: ${stderr}`)); }, deadlineMs);
    process.once("error", error => { clearTimeout(timer); reject(error); });
    process.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}
try {
  const settingsManager = sdk.SettingsManager.create(cwd, agentDir);
  const runtime = await sdk.ModelRuntime.create({ authPath, modelsPath, refreshOnCreate: false });
  const entry = fileURLToPath(new URL("../../index.ts", import.meta.url));
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, additionalExtensionPaths: [entry] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, modelRuntime: runtime, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(cwd), tools: [] }));
  const errors: any[] = [];
  await session.bindExtensions({ mode: "rpc", onError: (error: any) => { errors.push(error); } });
  assert.equal(errors.length, 0);
  const model = runtime.getModel("openai-account-2", "gpt-6.1-sol"); assert.ok(model);
  assert.equal(model.api, "openai-responses"); assert.equal(model.baseUrl, `http://127.0.0.1:${port}/openai-account-2/v1`);
  assert.equal(runtime.getProvider("openai-account-2").auth.oauth.isSubscription, true);
  assert.ok(model.input.includes("image"));
  assert.ok(model.thinkingLevelMap);
  assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8"))["openai-account-2"], { type: "api_key", key: "pi-multi-account-proxy" });
  assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")).openai, originalAuth.openai);
  const published = JSON.parse(readFileSync(modelsPath, "utf8")).providers["openai-account-2"];
  assert.equal(published.api, "openai-responses"); assert.equal(published.apiKey, "pi-multi-account-proxy");
  assert.equal(published.modelOverrides["gpt-6.1-sol"].maxTokens, 4096);
  assert.ok(published.models.every((model: any) => model.api === "openai-responses"));
  const sourceModel = runtime.getModel("openai", "gpt-6.1-sol");
  const publishedModel = published.models.find((entry: any) => entry.id === sourceModel.id);
  assert.deepEqual(publishedModel.samplingParams, { temperature: 0.2 });
  for (const key of ["inputLimits", "promptCache", "samplingParamsByThinkingLevel", "cost", "thinkingLevelMap"]) {
    if (sourceModel[key] !== undefined) assert.deepEqual(publishedModel[key], sourceModel[key], `native ${key} preserved`);
  }
  const wire = JSON.stringify(published); assert.ok(!wire.includes(grant.access)); assert.ok(!wire.includes(grant.refresh)); assert.ok(!wire.includes(grant.clientId));
  assert.equal((await runtime.getAuth(model)).auth.apiKey, "pi-multi-account-proxy");
  await assert.rejects(runtime.login("openai-account-2", "api_key", { signal: AbortSignal.timeout(1000), prompt: async () => { throw new Error("must not ask for paid key"); }, notify() {} }), /subscription-only/);

  const siblingRuntime = await sdk.ModelRuntime.create({ authPath, modelsPath, refreshOnCreate: false });
  const siblingLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, additionalExtensionPaths: [entry] });
  await siblingLoader.reload(); assert.deepEqual(siblingLoader.getExtensions().errors, []);
  ({ session: sibling } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, modelRuntime: siblingRuntime, resourceLoader: siblingLoader, sessionManager: sdk.SessionManager.inMemory(cwd), tools: [] }));
  await sibling.bindExtensions({ mode: "rpc", onError: (error: any) => { errors.push(error); } }); assert.equal(errors.length, 0);
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "shutdown" });
  session.dispose(); session = undefined;
  assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8"))["openai-account-2"], { type: "api_key", key: "pi-multi-account-proxy" }, "closing one root cannot restore its surviving sibling's grant");
  assert.equal(JSON.parse(readFileSync(modelsPath, "utf8")).providers["openai-account-2"].baseUrl, published.baseUrl);
  assert.equal((await siblingRuntime.getAuth(siblingRuntime.getModel("openai-account-2", "gpt-6.1-sol"))).auth.apiKey, "pi-multi-account-proxy");

  const guard = fileURLToPath(new URL("./openai-child-offline-guard.mjs", import.meta.url));
  const target = process.env.PI_MULTI_ACCOUNT_CHILD_CLI ?? join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
  const args = [target, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-session", "--model", "openai-account-2/gpt-6.1-sol", "--thinking", "high", "--tools", "read", "--mode", "json", "--print", `@${image}`, "DIRECT_CANARY_REQUEST"];
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, NODE_OPTIONS: `--import=${guard}` };
  child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const result = await settled(child); child = undefined;
  if (upstreamFailure) throw upstreamFailure;
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /DIRECT_NATIVE_DONE/);
  const events = result.stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
  for (const event of events) if (event.type === "tool_execution_end") tools.push(event);
  assert.equal(tools.length, 1); assert.equal(tools[0].toolName, "read");
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[0]), /DIRECT_CANARY_REQUEST/); assert.match(JSON.stringify(requests[0]), /data:image\/png;base64/);
  assert.match(JSON.stringify(requests[0].tools), /"name":"read"/);
  assert.match(JSON.stringify(requests[1]), /function_call_output/); assert.match(JSON.stringify(requests[1]), /DIRECT_TOOL_RESULT_MARKER/);
  assert.match(JSON.stringify(requests[1]), /call_canary/);

  blocking = true;
  child = spawn(process.execPath, args.slice(0, -2).concat("CANCEL_CANARY_REQUEST"), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const stopped = settled(child);
  await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error("blocking request not reached")), 10000).unref())]);
  child.kill("SIGTERM"); await stopped; child = undefined;
  for (let i = 0; i < 200 && !aborted; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(aborted, true, "terminating the original child closes its upstream body");
  assert.equal(requests.length, 3, "no cancellation replay");

  await sibling.extensionRunner.emit({ type: "session_shutdown", reason: "shutdown" });
  sibling.dispose(); sibling = undefined;
  assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")), originalAuth, "exact issued grant and legacy credentials restored");
  assert.deepEqual(JSON.parse(readFileSync(modelsPath, "utf8")).providers["openai-account-2"], { modelOverrides: { "gpt-6.1-sol": { maxTokens: 4096 } } });
  await assert.rejects(offlineFetch(`http://127.0.0.1:${port}/openai-account-2/v1/responses`, { method: "POST" }));
  console.log(JSON.stringify({ accepted: true, host: sdk.VERSION, childCli: target, nativeProvider: true, childExtensionFree: true, responses: requests.length, tools: tools.length, image: true, toolReplay: true, cancellationClosedOriginal: aborted, paidFallback: false, joinedRoots: true, restored: true }));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child!.once("exit", resolve));
    child.kill("SIGKILL"); await exited;
  }
  if (session) { await session.extensionRunner?.emit({ type: "session_shutdown", reason: "shutdown" }); session.dispose(); }
  if (sibling) { await sibling.extensionRunner?.emit({ type: "session_shutdown", reason: "shutdown" }); sibling.dispose(); }
  globalThis.fetch = offlineFetch;
  upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
}
