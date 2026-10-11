import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { affectedBraceVersion, inspectBraceInstall, inspectBraceLock } from "../scripts/check-dependabot-13.mjs";

test("Dependabot 13: each published affected and first-patched version boundary", () => {
  for (const version of ["0.9.0", "1.1.18", "1.1.20", "2.1.4", "2.1.6", "3.0.6", "3.0.8", "4.0.0", "5.0.9", "5.0.11"])
    assert.equal(affectedBraceVersion(version), true, version);
  for (const version of ["1.1.21", "2.1.7", "3.0.9", "5.0.12", "5.1.0", "6.0.0"])
    assert.equal(affectedBraceVersion(version), false, version);
  for (const version of [undefined, "unknown", "5.0.12-rc.1"])
    assert.equal(affectedBraceVersion(version), undefined, "no guessed prerequisite/version safety");
});
test("Dependabot 13: an override must not hide a nested vulnerable locked version", () => {
  const lock = { packages: { "": { overrides: { "brace-expansion": "5.0.12" } },
    "node_modules/brace-expansion": { version: "5.0.12" },
    "node_modules/host/node_modules/brace-expansion": { version: "5.0.9", dev: true } } };
  assert.deepEqual(inspectBraceLock(lock).map(row => row.affected), [false, true]);
  assert.equal(inspectBraceLock(lock)[1].development, true);
});
test("Dependabot 13: patched lock cannot hide vulnerable, missing or mismatched installed evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "pim-advisory-"));
  const module = join(root, "node_modules/brace-expansion"); mkdirSync(module, { recursive: true });
  const rows = inspectBraceLock({ packages: { "node_modules/brace-expansion": { version: "5.0.12", dev: true } } });
  try {
    assert.equal(inspectBraceInstall(root, rows)[0].affected, "unknown");
    writeFileSync(join(module, "package.json"), JSON.stringify({ version: "5.0.9" }));
    assert.equal(inspectBraceInstall(root, rows)[0].affected, true);
    assert.equal(inspectBraceInstall(root, rows)[0].matchesLock, false);
    writeFileSync(join(module, "package.json"), JSON.stringify({ version: "5.0.12" }));
    assert.equal(inspectBraceInstall(root, rows)[0].affected, false);
    assert.equal(inspectBraceInstall(root, rows)[0].matchesLock, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Dependabot 13: malformed evidence cannot report safe absence", () => {
  for (const lock of [undefined, {}, { packages: "invalid" }, { packages: [] }])
    assert.throws(() => inspectBraceLock(lock), /malformed lock package index/);
  assert.equal(inspectBraceLock({ packages: { "node_modules/brace-expansion": null } })[0].affected, "unknown");
});
