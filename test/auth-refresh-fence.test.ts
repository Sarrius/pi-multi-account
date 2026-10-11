import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as transactions from "../auth-file-transaction.ts";

const require = createRequire(import.meta.url);
const lockfile = require("proper-lockfile");
const credential = (name: string) => ({ type: "oauth" as const, access: `synthetic-${name}-access`, refresh: `synthetic-${name}-refresh`, expires: 4102444800000 });
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("forced refresh has a guarded same-file transaction rather than callback-side effects", () => {
  assert.equal(typeof (transactions as any).mutateProxyAuthAsync, "function");
});

for (const fault of ["abort", "replace-lock", "foreign-sidecar-write"]) {
  test(`forced refresh ${fault} fences both private sidecar and auth publication`, async () => {
    const root = mkdtempSync(join(tmpdir(), "pim-auth-fence-"));
    const auth = join(root, "auth.json"), sidecar = join(root, "sidecar.json");
    const placeholder = { type: "api_key", key: "fixture-proxy-placeholder" };
    writeFileSync(auth, JSON.stringify({ "anthropic-account-2": placeholder }));
    writeFileSync(sidecar, JSON.stringify({ "anthropic-account-2": credential("old") }));
    const controller = new AbortController();
    let enter!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { enter = resolve; });
    const complete = new Promise<void>(resolve => { finish = resolve; });
    let settled = false, foreignRelease: (() => Promise<void>) | undefined;
    try {
      const pending = (transactions as any).mutateProxyAuthAsync(auth, sidecar, async (current: any, recovery: any, signal: AbortSignal) => {
        assert.ok(signal instanceof AbortSignal);
        enter(); await complete; // Even a noncooperating callback must be joined before unlock.
        return { auth: current, sidecar: { ...recovery, "anthropic-account-2": credential("stale-refresh") }, changed: true };
      }, "shadow", { signal: controller.signal }).finally(() => { settled = true; });
      const rejected = assert.rejects(pending, /abort|lock|changed|compromis/i);
      await started;
      if (fault === "abort") controller.abort(new Error("synthetic refresh aborted"));
      else if (fault === "replace-lock") {
        rmSync(`${auth}.lock`, { recursive: true });
        foreignRelease = await lockfile.lock(auth, { realpath: false });
        writeFileSync(sidecar, JSON.stringify({ "anthropic-account-2": credential("winner") }));
      } else writeFileSync(sidecar, JSON.stringify({ "anthropic-account-2": credential("winner") }));
      await sleep(30);
      assert.equal(settled, false, "cancellation/compromise cannot release while callback work is unjoined");
      finish(); await rejected;
      if (foreignRelease) assert.equal(existsSync(`${auth}.lock`), true, "a stale release cannot remove the replacement holder's lock");
      assert.deepEqual(read(auth), { "anthropic-account-2": placeholder });
      assert.deepEqual(read(sidecar), { "anthropic-account-2": credential(fault === "abort" ? "old" : "winner") });
    } finally { finish?.(); await foreignRelease?.(); rmSync(root, { recursive: true, force: true }); }
  });
}

test("forced-refresh heartbeat cannot be reclaimed by the real host synchronous lock at its older 10s threshold", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pim-auth-heartbeat-"));
  const auth = join(root, "auth.json"), sidecar = join(root, "sidecar.json");
  writeFileSync(auth, JSON.stringify({ anthropic: credential("old") }));
  const { FileAuthStorageBackend } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js", import.meta.url).href);
  let enter!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { enter = resolve; });
  const complete = new Promise<void>(resolve => { finish = resolve; });
  let pending: Promise<any> | undefined;
  try {
    pending = transactions.mutateProxyAuthAsync(auth, sidecar, async (current, recovery) => {
      enter(); await complete;
      return { auth: { ...current, anthropic: credential("refreshed") }, sidecar: recovery, changed: true };
    }, "restore");
    await started; await sleep(11_000);
    const backend = new FileAuthStorageBackend(auth);
    let enteredSync = false;
    assert.throws(() => backend.withLock(() => { enteredSync = true; return { result: undefined }; }), /lock/i);
    assert.equal(enteredSync, false, "native synchronous writer cannot steal a live refresh lease");
    finish(); await pending;
    assert.deepEqual(read(auth).anthropic, credential("refreshed"));
  } finally { finish?.(); await pending?.catch(() => {}); rmSync(root, { recursive: true, force: true }); }
});

test("Cursor refresh propagates cancellation through response-body consumption", async (t) => {
  const { refreshCursorToken } = await import("../cursor/auth.ts");
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    seen = init.signal;
    assert.ok(seen instanceof AbortSignal, "the token exchange must receive the transaction signal");
    return { ok: true, json: () => new Promise((_resolve, reject) => {
      seen!.addEventListener("abort", () => reject(seen!.reason), { once: true });
      controller.abort(new Error("synthetic body abort"));
    }) } as any;
  });
  await assert.rejects((refreshCursorToken as any)("synthetic-refresh-token", controller.signal), /synthetic body abort/);
  assert.equal(seen, controller.signal);
});
