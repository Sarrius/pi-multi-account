/** Shared JSON transactions: lock before reading, merge local deltas, publish atomically. */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const pause = new Int32Array(new SharedArrayBuffer(4));
const MAP_FIELDS = ["exhaustedUntilByProvider", "exhaustedUntilByModel", "invalidatedByProvider",
  "usageUntrustedUntilByProvider", "limitRefusalByProvider", "usageByProvider", "codexModelCatalogByProvider", "lastProbeAtByProvider"];
type State = Record<string, any>;

export function mergeStateDeltas<T extends State>(base: T, local: T, disk: T): T {
  const merged = { ...local };
  for (const field of MAP_FIELDS) {
    const before = base[field] ?? {}, after = local[field] ?? {};
    const values = { ...(disk[field] ?? {}) };
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
      if (Object.hasOwn(after, key)) {
        // A slower fetch must not overwrite a newer observation of the same credential.
        const newer = values[key], candidate = after[key];
        if ((field === "usageByProvider" || field === "codexModelCatalogByProvider") &&
            newer?.credentialHash === candidate?.credentialHash && newer?.fetchedAt > candidate?.fetchedAt) continue;
        if (field === "limitRefusalByProvider" && newer?.observedAt > candidate?.observedAt) continue;
        // A local shorten based on an older snapshot cannot roll back a newer sibling refusal.
        if (["exhaustedUntilByProvider", "usageUntrustedUntilByProvider"].includes(field) &&
            JSON.stringify(newer) !== JSON.stringify(before[key]) && newer > candidate) continue;
        values[key] = candidate;
      } else if (JSON.stringify(values[key]) === JSON.stringify(before[key])) {
        // CAS deletion: an old meter/cleanup may clear what it saw, never a newer observation.
        delete values[key];
      }
    }
    (merged as State)[field] = values;
  }
  return merged;
}

export function mutateStateFile<T extends State>(path: string, transform: (disk: T) => T): T {
  return mutateJsonFile(path, transform, true);
}

/** User-authored config is not a derived cache: malformed data must never be replaced. */
export function mutateConfigFile<T extends State>(path: string, transform: (disk: T) => T): T {
  return mutateJsonFile(path, transform, false);
}

function mutateJsonFile<T extends State>(path: string, transform: (disk: T) => T, recoverMalformed: boolean): T {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    try { writeFileSync(path, "{}\n", { mode: 0o600, flag: "wx" }); }
    catch (error: any) { if (error?.code !== "EEXIST") throw error; }
  }
  const lockfile = require("proper-lockfile") as { lockSync(path: string, options: object): () => void };
  let release: (() => void) | undefined;
  // Writes are synchronous and short. Bound contention rather than hanging the Pi event loop.
  const deadline = Date.now() + 250;
  while (!release) {
    try { release = lockfile.lockSync(path, { realpath: false }); }
    catch (error: any) {
      if (error?.code !== "ELOCKED" || Date.now() >= deadline) throw error;
      Atomics.wait(pause, 0, 0, 5);
    }
  }
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    let disk: T;
    try {
      disk = JSON.parse(readFileSync(path, "utf8"));
      if (!disk || typeof disk !== "object" || Array.isArray(disk)) {
        if (!recoverMalformed) throw new Error("Config must be a JSON object");
        disk = {} as T;
      }
    } catch (error) {
      if (!recoverMalformed || !(error instanceof SyntaxError)) throw error;
      disk = {} as T; // Derived state is recoverable; credentials never enter this file.
    }
    const next = transform(disk);
    writeFileSync(temp, `${JSON.stringify(next, null, "\t")}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
    return next;
  } finally {
    try { rmSync(temp, { force: true }); } finally { release(); }
  }
}
