import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

for (const kind of ['safe', 'secret', 'client-id', 'private-file'] as const) test(`tracked privacy gate: ${kind}`, () => {
 const root = mkdtempSync(join(tmpdir(), 'privacy-gate-'));
 try {
  mkdirSync(join(root, 'scripts'));
  copyFileSync(new URL('../scripts/check-tracked-privacy.mjs', import.meta.url), join(root, 'scripts/check-tracked-privacy.mjs'));
  // Deliberately invalid, generated test strings; never credentials for a real application.
  const value = kind === 'secret' ? ['GOCSPX', 'a'.repeat(30)].join('-') : kind === 'client-id' ? ['1'.repeat(13), 'a'.repeat(32)].join('-') + '.apps.googleusercontent.com' : 'test-only-not-a-credential';
  writeFileSync(join(root, kind === 'private-file' ? 'antigravity-oauth-client.json' : 'candidate.ts'), value);
  execFileSync('git', ['init', '-q'], { cwd: root }); execFileSync('git', ['add', '.'], { cwd: root });
  const result = spawnSync(process.execPath, ['scripts/check-tracked-privacy.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, kind === 'safe' ? 0 : 1);
  if (kind !== 'safe') { assert.match(result.stderr, /Refusing private files, credentials/); assert.ok(!result.stderr.includes(value)); }
 } finally { rmSync(root, { recursive: true, force: true }); }
});
