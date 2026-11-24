import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistGoogleConnection } from '../google-connect.ts';

test('a Google connection never overwrites a concurrently occupied slot', async () => {
 const dir=mkdtempSync(join(tmpdir(),'google-connect-'));
 try {
  const auth=join(dir,'auth.json'), sidecar=join(dir,'sidecar.json');
  const existing={type:'oauth',accountId:'google:456',access:'fixture-existing'};
  writeFileSync(auth,JSON.stringify({'google-antigravity':existing}));
  await assert.rejects(persistGoogleConnection(auth,sidecar,'google-antigravity',{type:'oauth',accountId:'google:123',access:'fixture-new'} as any,new AbortController().signal),/occupied/);
  assert.deepEqual(JSON.parse(readFileSync(auth,'utf8'))['google-antigravity'],existing);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
