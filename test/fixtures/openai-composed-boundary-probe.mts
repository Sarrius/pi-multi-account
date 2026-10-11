import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Host from "@earendil-works/pi-coding-agent";

const root = mkdtempSync(join(tmpdir(), "pmacct-composed-boundary-"));
const agentDir = join(root, "agent"), cwd = join(root, "work"); mkdirSync(agentDir); mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.OPENAI_API_KEY = "FORBIDDEN_PAID_KEY";
const grant = { type: "oauth", access: "synthetic-direct-access", refresh: "synthetic-direct-refresh", expires: 4102444800000, clientId: "issued-canary-client", scopes: ["chatgpt.tokens.use.direct"] };
const alias = "openai-account-2", api = process.argv[2];
assert.ok(["openai-responses", "openai-completions"].includes(api));
const authPath = join(agentDir, "auth.json"), modelsPath = join(agentDir, "models.json");
writeFileSync(authPath, JSON.stringify({ [alias]: grant }));
writeFileSync(modelsPath, JSON.stringify({ providers: { [alias]: { models: [{ id: "foreign", api, baseUrl: "https://foreign.example/v1", contextWindow: 10000, maxTokens: 100 }] } } }));
writeFileSync(join(agentDir, "provider-failover.json"), JSON.stringify({ childProxy: false, showUsage: false, autoDiscoverModels: false, autoContinue: false, showStatus: false }));
const sdk: any = Host;
const originalFetch = globalThis.fetch; let sent = 0, session: any;
globalThis.fetch = (async () => { sent++; throw new Error("OFFLINE_ROUTE_REPRODUCTION_ONLY"); }) as typeof fetch;
try {
  const settingsManager = sdk.SettingsManager.create(cwd, agentDir);
  const runtime = await sdk.ModelRuntime.create({ authPath, modelsPath, refreshOnCreate: false });
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, additionalExtensionPaths: [fileURLToPath(new URL("../../index.ts", import.meta.url))] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, modelRuntime: runtime, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(cwd), tools: [] }));
  const errors: any[] = []; await session.bindExtensions({ mode: "rpc", onError: (error: any) => errors.push(error) }); assert.equal(errors.length, 0);
  const model = runtime.getModel(alias, "foreign"); assert.ok(model);
  const result = await runtime.streamSimple(model, { messages: [{ role: "user", content: "BOUNDARY_PROBE", timestamp: 0 }] }, { maxRetries: 0 }).result();
  assert.equal(result.stopReason, "error", result.errorMessage);
  assert.equal(sent, 0, "actual extension/host composition must fail before handing any grant to any transport");
  assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8"))[alias], grant);
  console.log(JSON.stringify({ accepted: true, api, dispatched: sent, actualExtension: true, credentialPreserved: true }));
} finally {
  if (session) { await session.extensionRunner?.emit({ type: "session_shutdown", reason: "shutdown" }); session.dispose(); }
  globalThis.fetch = originalFetch;
  rmSync(root, { recursive: true, force: true });
}
