import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeStateDeltas, mutateConfigFile, mutateStateFile } from "../state-file-transaction.ts";

for (const content of ["{broken", "[]", "null", '"not an object"']) {
  test(`config transactions never replace malformed user-authored content: ${content}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "multi-config-invalid-")), path = join(dir, "config.json");
    let transforms = 0;
    try {
      writeFileSync(path, content);
      assert.throws(() => mutateConfigFile(path, () => { transforms++; return {}; }));
      assert.equal(transforms, 0);
      assert.equal(readFileSync(path, "utf8"), content);
      assert.deepEqual(readdirSync(dir), ["config.json"], "failed write releases its lock and leaves no temp file");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("config transactions merge against the latest disk object and publish privately", () => {
  const dir = mkdtempSync(join(tmpdir(), "multi-config-")), path = join(dir, "config.json");
  try {
    writeFileSync(path, JSON.stringify({ excludedProviders: ["first"], unrelated: { keep: true } }));
    mutateConfigFile(path, disk => ({ ...disk, excludedProviders: [...disk.excludedProviders, "second"] }));
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { excludedProviders: ["first", "second"], unrelated: { keep: true } });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), ["config.json"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("shared state preserves other sessions' cooldowns and deliberate local clearing", () => {
  const base: { exhaustedUntilByProvider: Record<string, number> } = { exhaustedUntilByProvider: { a: 1, b: 2 } };
  const local = { exhaustedUntilByProvider: { a: 1, c: 3 } };
  const disk = { exhaustedUntilByProvider: { a: 9, b: 2, d: 4 } };
  assert.deepEqual(mergeStateDeltas(base, local, disk).exhaustedUntilByProvider, { a: 9, c: 3, d: 4 });
  const before = { usageByProvider: { a: { credentialHash: "same", fetchedAt: 1 } } };
  assert.equal(mergeStateDeltas(before,
    { usageByProvider: { a: { credentialHash: "same", fetchedAt: 2 } } },
    { usageByProvider: { a: { credentialHash: "same", fetchedAt: 3 } } }).usageByProvider.a.fetchedAt, 3);
});

test("quota QA: stale clearing cannot erase a newer sibling refusal or cooldown", () => {
  const old = { observedAt: 1, retryAt: 100, reportedUntil: 1000 };
  const newer = { observedAt: 2, retryAt: 200, reportedUntil: 2000 };
  const base = { limitRefusalByProvider: { a: old }, exhaustedUntilByProvider: { a: 100 } };
  const cleared = { limitRefusalByProvider: {}, exhaustedUntilByProvider: {} };
  const disk = { limitRefusalByProvider: { a: newer }, exhaustedUntilByProvider: { a: 200 } };
  const retained = mergeStateDeltas(base, cleared, disk);
  assert.deepEqual(retained.limitRefusalByProvider, disk.limitRefusalByProvider);
  assert.deepEqual(retained.exhaustedUntilByProvider, disk.exhaustedUntilByProvider);
  const deliberate = mergeStateDeltas(base, cleared, base);
  assert.deepEqual(deliberate.limitRefusalByProvider, {});
  assert.deepEqual(deliberate.exhaustedUntilByProvider, {}, "deliberately clearing the same observed value remains allowed");
  assert.equal(mergeStateDeltas(base, { ...base, exhaustedUntilByProvider: { a: 50 } }, disk).exhaustedUntilByProvider.a, 200);
  assert.deepEqual(mergeStateDeltas<Record<string, any>>({}, { limitRefusalByProvider: { a: old } }, disk).limitRefusalByProvider.a, newer);
});

test("busy state lock fails boundedly without mutation and permits a later retry", () => {
  const dir = mkdtempSync(join(tmpdir(), "multi-state-busy-")), path = join(dir, "state.json");
  const lockfile = createRequire(import.meta.url)("proper-lockfile");
  mutateStateFile(path, () => ({ existing: true }));
  const release = lockfile.lockSync(path, { realpath: false });
  let transforms = 0;
  try {
    const start = Date.now();
    assert.throws(() => mutateStateFile(path, () => { transforms++; return {}; }), { code: "ELOCKED" });
    assert.ok(Date.now() - start < 5000, "busy storage cannot block the host indefinitely");
    assert.equal(transforms, 0, "never read/transform outside the lock");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { existing: true });
  } finally { release(); }
  try {
    mutateStateFile(path, disk => ({ ...disk, retried: true }));
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { existing: true, retried: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("four real processes retain every independent state update without torn JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "multi-state-")), path = join(dir, "state.json");
  const module = new URL("../state-file-transaction.ts", import.meta.url).href;
  try {
    mutateStateFile(path, () => ({ exhaustedUntilByProvider: {} }));
    await Promise.all(Array.from({ length: 4 }, (_, worker) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", `
        import { mutateStateFile, mergeStateDeltas } from ${JSON.stringify(module)};
        import { setTimeout as sleep } from 'node:timers/promises';
        // Production deliberately yields with ELOCKED after 250ms rather than blocking
        // Pi indefinitely. A saturated Linux runner may hit that contract; retry the
        // same independent delta at an async boundary, never weaken the lock bound.
        for(let i=0;i<30;i++) {
          const deadline = Date.now() + 10_000;
          while (true) {
            try {
              mutateStateFile(${JSON.stringify(path)}, disk =>
                mergeStateDeltas({}, { exhaustedUntilByProvider: { [${worker} + ':' + i]: i + 1 } }, disk));
              break;
            } catch (error) {
              if (error.code !== 'ELOCKED' || Date.now() >= deadline) throw error;
              await sleep(10);
            }
          }
        }
      `], { stdio: ["ignore", "ignore", "pipe"] });
      let error = ""; child.stderr.on("data", chunk => error += chunk);
      child.on("error", reject); child.on("close", code => code === 0 ? resolve() : reject(new Error(error)));
    })));
    assert.equal(Object.keys(JSON.parse(readFileSync(path, "utf8")).exhaustedUntilByProvider).length, 120);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), ["state.json"]);
    assert.throws(() => mutateStateFile(path, () => { throw new Error("interrupted"); }), /interrupted/);
    assert.equal(Object.keys(JSON.parse(readFileSync(path, "utf8")).exhaustedUntilByProvider).length, 120);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
