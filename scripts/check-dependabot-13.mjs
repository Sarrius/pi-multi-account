// Read-only check for GHSA-q2hr-2g5m-vwhr. No network, installs, dismissals or SDK edits.
import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function affectedBraceVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  if (!match) return undefined;
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major === 0) return true;
  if (major === 1) return minor < 1 || (minor === 1 && patch < 21);
  if (major === 2) return minor < 1 || (minor === 1 && patch < 7);
  if (major === 3) return minor === 0 && patch < 9;
  if (major === 4) return true;
  if (major === 5) return minor === 0 && patch < 12;
  return false;
}

export function inspectBraceLock(lock) {
  if (!lock || !lock.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages))
    throw new TypeError("Missing or malformed lock package index; no safe-version claim is possible");
  return Object.entries(lock.packages).filter(([path]) => path.endsWith("/brace-expansion"))
    .map(([path, entry]) => ({ path, version: entry?.version, development: entry?.dev === true,
      affected: affectedBraceVersion(entry?.version) ?? "unknown" }));
}

export function inspectBraceInstall(root, rows) {
  return rows.map(row => {
    const packagePath = resolve(root, row.path, "package.json");
    if (!packagePath.startsWith(`${resolve(root, "node_modules")}${sep}`)) throw new Error("Invalid dependency evidence path");
    let version;
    try { version = JSON.parse(readFileSync(packagePath, "utf8")).version; }
    catch { /* Missing/unreadable evidence is unknown, never patched. */ }
    return { path: row.path, version, affected: affectedBraceVersion(version) ?? "unknown", matchesLock: version === row.version };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const rows = inspectBraceLock(JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8")));
  const installed = inspectBraceInstall(root, rows);
  console.log(JSON.stringify({ advisory: "GHSA-q2hr-2g5m-vwhr", rows, installed,
    note: "An override or successful npm exit is not remediation. This check reads both resolved lock and actual installed manifests; run against a clean npm ci tree." }, null, 2));
  process.exitCode = rows.some(row => row.affected !== false) || installed.some(row => row.affected !== false || !row.matchesLock) ? 1 : 0;
}
