import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "node:net";

const reservation = createServer();
await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
const port = (reservation.address() as { port: number }).port;
await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
process.env.PI_MULTI_ACCOUNT_SLOT_PROXY_PORT = String(port);

const dir = mkdtempSync(join(tmpdir(), "codex-startup-registry-"));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_OFFLINE = "1";
delete process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_WEB_SESSION;
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { default: multiAccount } = await import("../index.ts");

test("fresh Codex startup authenticates its published placeholder through the host registry", async () => {
  const provider = "openai-codex-account-2";
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ [provider]: {
    type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: 4102444800000,
  } }));
  writeFileSync(join(dir, "provider-failover.json"), JSON.stringify({
    includeCursor: false, showUsage: false, autoDiscoverModels: false,
    enabled: false, childProxy: true,
  }));
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  let registry: any;
  let authAtPublication: any;
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true,
    extensionFactories: [multiAccount, (pi) => {
      pi.on("session_start", async (_event, ctx) => {
        registry = ctx.modelRegistry;
        const model = registry.getAll().find((m: any) => m.provider === provider);
        assert.ok(model, "numbered model is registered");
        authAtPublication = await registry.getApiKeyAndHeaders(model);
      });
    }],
  });
  let session: any;
  try {
    await loader.reload();
    const result = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader,
      settingsManager, sessionManager: SessionManager.inMemory(dir), tools: [] });
    session = result.session;
    assert.deepEqual(result.extensionsResult.errors, []);
    await session.bindExtensions({ mode: "print", onError: (error: any) => { throw new Error(JSON.stringify(error)); } });
    assert.equal(authAtPublication?.ok, true, JSON.stringify(authAtPublication));
    assert.match(registry.getAll().find((m: any) => m.provider === provider).baseUrl, /^http:\/\/127\.0\.0\.1:/);
    assert.notEqual(authAtPublication.apiKey, "synthetic-access");
  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
