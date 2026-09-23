import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// This file pins TERMINAL-Pi semantics: a second concurrent in-process session goes passive.
// When the test runner itself is hosted by pi-web (PI_WEB_SESSION=1) the extension would
// correctly treat every session as an independent root, breaking these expectations — so the
// host markers are scrubbed here, exactly like the harness in failover.test.ts does per setup().
delete process.env.PI_WEB_SESSION;
delete process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_MULTI_ACCOUNT_INDEPENDENT_ROOTS;

// A fresh node:test process, real Pi SDK and real event ordering; no personal auth/config.
const dir = mkdtempSync(join(tmpdir(), "multi-account-session-sdk-"));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_OFFLINE = "1";
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
const { default: multiAccount } = await import("../index.ts");

const models = ["model-a", "model-b"].map((id) => ({
  provider: "session-fixture", id, name: id, api: "openai-completions" as const,
  baseUrl: "http://127.0.0.1:1", reasoning: true, input: ["text" as const],
  contextWindow: 100_000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}));

async function open(model = models[0]) {
  const settings = SettingsManager.inMemory({
    modelThinkingLevels: { "session-fixture/model-a": "low", "session-fixture/model-b": "high" },
    compaction: { enabled: false }, retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true,
    extensionFactories: [(pi) => {
      pi.registerProvider("session-fixture", { api: "openai-completions", baseUrl: "http://127.0.0.1:1",
        apiKey: "fixture-only", models,
        streamSimple: (selected: any) => {
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => {
            const message: any = { role: "assistant", content: [{ type: "text", text: "SESSION_OK" }],
              api: selected.api, provider: selected.provider, model: selected.id, stopReason: "stop", timestamp: Date.now(),
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
            stream.push({ type: "done", reason: "stop", message }); stream.end();
          });
          return stream;
        },
      });
    }, multiAccount],
  });
  await loader.reload();
  const result = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader,
    settingsManager: settings, sessionManager: SessionManager.inMemory(dir), model, tools: [] });
  assert.deepEqual(result.extensionsResult.errors, []);
  await result.session.bindExtensions({ mode: "print", onError: (error: any) => { throw new Error(JSON.stringify(error)); } });
  return result.session;
}
async function close(session: Awaited<ReturnType<typeof open>>) {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}

test("real Pi sessions keep launch models, per-model thinking and ownership through child teardown/reload", async () => {
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ "session-fixture": { type: "api_key", key: "fixture-only" } }));
  writeFileSync(join(dir, "provider-failover.json"), JSON.stringify({
    includeCursor: false, childProxy: false, autoDiscover: false, autoDiscoverModels: false, showUsage: false,
  }));
  const statePath = join(dir, "provider-failover-state.json");
  const remembered = { provider: "session-fixture", id: "model-b" };
  writeFileSync(statePath, JSON.stringify({ lastUserModel: remembered, lastUserThinkingLevel: "max" }));
  const root = await open();
  try {
    assert.equal(root.model?.id, "model-a");
    assert.equal(root.thinkingLevel, "low");
    const child = await open(models[1]);
    try {
      assert.equal(child.model?.id, "model-b");
      await child.prompt("Return SESSION_OK");
      assert.equal(child.model?.id, "model-b");
      assert.equal(child.thinkingLevel, "high");
    } finally { await close(child); }
    await root.setModel(models[1]);
    await root.prompt("Return SESSION_OK");
    assert.equal(root.thinkingLevel, "high");
    await root.setModel(models[0]);
    await root.prompt("Return SESSION_OK");
    assert.equal(root.thinkingLevel, "low");
    assert.equal(root.model?.id, "model-a");
  } finally { await close(root); }
  const reloaded = await open();
  try {
    await reloaded.prompt("Return SESSION_OK");
    const log = readFileSync(join(dir, "provider-failover-debug.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(log.filter((event) => event.kind === "session_start").map((event) => event.mode),
      ["interactive", "subagent-child-passive", "interactive"]);
    assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")).lastUserModel, remembered);
  } finally { await close(reloaded); rmSync(dir, { recursive: true, force: true }); }
});

test("pi-web hosted sibling sessions are independent roots (real SDK)", async () => {
  // pi-web's session daemon sets PI_WEB_SESSION=1 and hosts many root sessions in one
  // process. Every one of them must activate: the terminal-Pi in-process lease must not
  // demote siblings to subagent-child-passive.
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ "session-fixture": { type: "api_key", key: "fixture-only" } }));
  writeFileSync(join(dir, "provider-failover.json"), JSON.stringify({
    includeCursor: false, childProxy: false, autoDiscover: false, autoDiscoverModels: false, showUsage: false,
  }));
  const previousPiWebHost = process.env.PI_WEB_SESSION;
  process.env.PI_WEB_SESSION = "1";
  const first = await open();
  try {
    const second = await open(models[1]);
    try {
      await second.prompt("Return SESSION_OK");
      const log = readFileSync(join(dir, "provider-failover-debug.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(log.filter((event) => event.kind === "session_start").map((event) => event.mode),
        ["interactive", "interactive"],
        "pi-web sibling sessions are independent roots, never subagent-child-passive");
    } finally { await close(second); }
  } finally {
    await close(first);
    if (previousPiWebHost === undefined) delete process.env.PI_WEB_SESSION;
    else process.env.PI_WEB_SESSION = previousPiWebHost;
    rmSync(dir, { recursive: true, force: true });
  }
});
