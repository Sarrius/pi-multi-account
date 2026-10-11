/** Pi-compatible cross-process auth lock and crash-safe OAuth shadow publication. */
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { AuthBlob } from "./slot-proxy-auth.ts";

const require = createRequire(import.meta.url);
type Auth = Record<string, AuthBlob>;
type Plan = { auth: Auth; sidecar: Auth; changed: boolean };

function read(path: string): Auth {
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("auth storage is not an object");
  return value;
}

function atomicWrite(path: string, data: Auth): void {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(data, null, "\t")}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

export function mutateProxyAuth(
  authPath: string,
  sidecarPath: string,
  transform: (auth: Auth, sidecar: Auth) => Plan,
  mode: "shadow" | "restore",
  write: (path: string, data: Auth) => void = atomicWrite,
): boolean {
  mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
  if (!existsSync(authPath)) {
    try { writeFileSync(authPath, "{}\n", { mode: 0o600, flag: "wx" }); }
    catch (error: any) { if (error?.code !== "EEXIST") throw error; }
  }
  // Same directory protocol as Pi; respect its 30s asynchronous stale bound.
  // Never read a snapshot before locking.
  const lockfile = require("proper-lockfile") as { lockSync(path: string, options: object): () => void };
  const release = lockfile.lockSync(authPath, { realpath: false, stale: 30_000 });
  try {
    const plan = transform(read(authPath), read(sidecarPath));
    if (!plan.changed) return false;
    if (mode === "shadow") {
      // Persist the only recoverable OAuth copy BEFORE replacing auth with a placeholder.
      write(sidecarPath, plan.sidecar);
      write(authPath, plan.auth);
    } else {
      // Restore the real credential BEFORE removing its recovery copy.
      write(authPath, plan.auth);
      write(sidecarPath, plan.sidecar);
    }
    return true;
  } finally { release(); }
}

/** Network refreshes share Pi's auth lock but commit both files only after joined work.
 * A 1s heartbeat stays below the older host's 10s synchronous stale threshold;
 * the 30s stale bound also respects existing host asynchronous transactions.
 */
export async function mutateProxyAuthAsync(
  authPath: string,
  sidecarPath: string,
  transform: (auth: Auth, sidecar: Auth, signal: AbortSignal) => Promise<Plan>,
  mode: "shadow" | "restore",
  options: { signal?: AbortSignal } = {},
): Promise<boolean> {
  mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
  if (!existsSync(authPath)) {
    try { writeFileSync(authPath, "{}\n", { mode: 0o600, flag: "wx" }); }
    catch (error: any) { if (error?.code !== "EEXIST") throw error; }
  }
  const leaseAbort = new AbortController();
  const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(30_000), leaseAbort.signal]);
  const lockPath = `${authPath}.lock`;
  const same = (a: { dev: bigint; ino: bigint; birthtimeNs: bigint; mtimeNs: bigint }, b: typeof a) =>
    a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs && a.mtimeNs === b.mtimeNs;
  // Use the same mkdir/mtime protocol as Pi, but no library-global exit unlink
  // registry. A killed owner leaves a bounded stale lease, never deletes a
  // replacement holder's lock. Contenders wait within their cancellation budget.
  for (;;) {
    signal.throwIfAborted();
    try { await mkdir(lockPath); break; }
    catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const previous = statSync(lockPath, { bigint: true });
        if (Date.now() - Number(previous.mtimeMs) > 30_000 && same(previous, statSync(lockPath, { bigint: true }))) {
          rmdirSync(lockPath); // Empty directory only; never recursive foreign cleanup.
        }
      } catch (inspect: any) {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(inspect?.code)) throw inspect;
      }
      await sleep(20, undefined, { signal });
    }
  }
  let identity: { dev: bigint; ino: bigint; birthtimeNs: bigint; mtimeNs: bigint } | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stillOwned = () => {
    if (!identity) return false;
    try { return same(identity, statSync(lockPath, { bigint: true })); }
    catch { return false; }
  };
  try {
    identity = statSync(lockPath, { bigint: true });
    heartbeat = setInterval(() => {
      try {
        if (!stillOwned()) throw new Error("Auth storage lock was replaced or compromised");
        const owned = identity!;
        const stamp = new Date(Math.ceil(Date.now() / 1000) * 1000);
        utimesSync(lockPath, stamp, stamp);
        const current = statSync(lockPath, { bigint: true });
        if (owned.dev !== current.dev || owned.ino !== current.ino || owned.birthtimeNs !== current.birthtimeNs) {
          throw new Error("Auth storage lock was replaced during heartbeat");
        }
        identity = { ...owned, mtimeNs: current.mtimeNs };
      } catch (error) {
        leaseAbort.abort(error);
        if (heartbeat) clearInterval(heartbeat);
      }
    }, 1000);
    heartbeat.unref();
    const assertOwned = () => {
      signal.throwIfAborted();
      if (!stillOwned()) throw new Error("Auth storage lock was replaced or disappeared before commit");
    };
    assertOwned();
    const auth = read(authPath), sidecar = read(sidecarPath);
    const authBefore = JSON.stringify(auth), sidecarBefore = JSON.stringify(sidecar);
    // Do not race this promise against cancellation: a refresh that ignores its
    // signal must retain ownership until its actual callback settles.
    const plan = await transform(structuredClone(auth), structuredClone(sidecar), signal);
    assertOwned();
    // Adopting a newer credential is a verified read-only outcome, not a write.
    // Only a real commit needs the snapshot CAS; rejecting read-only adoption
    // would prevent a 401 retry after a noncooperating writer's newer login.
    if (!plan.changed) return false;
    if (JSON.stringify(read(authPath)) !== authBefore || JSON.stringify(read(sidecarPath)) !== sidecarBefore) {
      throw new Error("Auth storage changed during refresh; refusing stale commit");
    }
    if (mode === "shadow") {
      atomicWrite(sidecarPath, plan.sidecar);
      assertOwned();
      atomicWrite(authPath, plan.auth);
    } else {
      atomicWrite(authPath, plan.auth);
      assertOwned();
      atomicWrite(sidecarPath, plan.sidecar);
    }
    return true;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (stillOwned()) {
      try { rmdirSync(lockPath); }
      catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    }
  }
}
