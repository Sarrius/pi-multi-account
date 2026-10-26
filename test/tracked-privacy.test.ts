import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

for (const kind of ['safe', 'secret', 'client-id', 'private-file', 'public-profile', 'wrong-file', 'extra-secret'] as const) test(`tracked privacy gate: ${kind}`, () => {
 const root = mkdtempSync(join(tmpdir(), 'privacy-gate-'));
 try {
  mkdirSync(join(root, 'scripts'));
  copyFileSync(new URL('../scripts/check-tracked-privacy.mjs', import.meta.url), join(root, 'scripts/check-tracked-privacy.mjs'));
  // Deliberately invalid, generated test strings; never credentials for a real application.
  const value = kind === 'secret' ? ['GOCSPX', 'a'.repeat(30)].join('-') : kind === 'client-id' ? ['1'.repeat(13), 'a'.repeat(32)].join('-') + '.apps.googleusercontent.com' : 'test-only-not-a-credential';
  writeFileSync(join(root, kind === 'private-file' ? 'antigravity-oauth-client.json' : 'candidate.ts'), value);
  if (['public-profile','wrong-file','extra-secret'].includes(kind)) {
   mkdirSync(join(root, 'antigravity'));
   const target=join(root, kind==='wrong-file' ? 'candidate.ts' : 'antigravity/oauth-client.ts');
   copyFileSync(new URL('../antigravity/oauth-client.ts', import.meta.url),target);
   if(kind==='extra-secret')appendFileSync(target,'\n'+['GOCSPX','b'.repeat(30)].join('-'));
  }
  execFileSync('git', ['init', '-q'], { cwd: root }); execFileSync('git', ['add', '.'], { cwd: root });
  const result = spawnSync(process.execPath, ['scripts/check-tracked-privacy.mjs'], { cwd: root, encoding: 'utf8' });
  const accepted=kind==='safe'||kind==='public-profile';
  assert.equal(result.status, accepted ? 0 : 1);
  if (!accepted) { assert.match(result.stderr, /Refusing private files, credentials/); if(!['wrong-file','extra-secret'].includes(kind))assert.ok(!result.stderr.includes(value)); }
 } finally { rmSync(root, { recursive: true, force: true }); }
});
