import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeStateDeltas, mutateStateFile } from "../state-file-transaction.ts";

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

test("four real processes retain every independent state update without torn JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "multi-state-")), path = join(dir, "state.json");
  const module = new URL("../state-file-transaction.ts", import.meta.url).href;
  try {
    mutateStateFile(path, () => ({ exhaustedUntilByProvider: {} }));
    await Promise.all(Array.from({ length: 4 }, (_, worker) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", `
        import { mutateStateFile, mergeStateDeltas } from ${JSON.stringify(module)};
        for(let i=0;i<30;i++) mutateStateFile(${JSON.stringify(path)}, disk =>
          mergeStateDeltas({}, { exhaustedUntilByProvider: { [${worker} + ':' + i]: i + 1 } }, disk));
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
