import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorization, createAntigravityOAuth } from '../antigravity/oauth.ts';
import { readOAuthClient } from '../antigravity/client-config.ts';

const fixture = { clientId: 'test-only.apps.googleusercontent.com', clientSecret: 'test-only-not-a-valid-client-secret' };

for (const scenario of ['valid', 'malformed', 'public', 'symlink', 'oversize', 'unknown-key', 'control-character'] as const) {
 test(`private client configuration: ${scenario}`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-client-'));
  const file = join(dir, 'client.json'), previous = process.env.PI_ANTIGRAVITY_OAUTH_CLIENT_FILE;
  process.env.PI_ANTIGRAVITY_OAUTH_CLIENT_FILE = file;
  try {
   const data = scenario === 'unknown-key' ? { ...fixture, unexpected: true } : scenario === 'control-character' ? { ...fixture, clientSecret: 'private\nvalue' } : fixture;
   writeFileSync(file, scenario === 'malformed' ? '{private-parser-content' : scenario === 'oversize' ? 'x'.repeat(4097) : JSON.stringify(data), { mode: 0o600 });
   if (scenario === 'public') chmodSync(file, 0o644);
   if (scenario === 'symlink') { const link = join(dir, 'link.json'); symlinkSync(file, link); process.env.PI_ANTIGRAVITY_OAUTH_CLIENT_FILE = link; }
   if (scenario === 'valid') {
    assert.deepEqual(readOAuthClient(), fixture);
    const auth = authorization();
    assert.equal(new URL(auth.url).searchParams.get('client_id'), fixture.clientId);
    assert.ok(!JSON.stringify(auth).includes(fixture.clientSecret));
   } else assert.throws(() => readOAuthClient(), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /private OAuth client configuration/);
    assert.ok(!error.message.includes(fixture.clientSecret)); assert.ok(!error.message.includes(file)); assert.doesNotMatch(error.message, /private-parser-content/); return true;
   });
  } finally {
   if (previous === undefined) delete process.env.PI_ANTIGRAVITY_OAUTH_CLIENT_FILE; else process.env.PI_ANTIGRAVITY_OAUTH_CLIENT_FILE = previous;
   rmSync(dir, { recursive: true, force: true });
  }
 });
}

test('refresh sends configured application credentials only to the fixed token endpoint', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'ag-client-')), previous = process.env.PI_ANTIGRAVITY_OAUTH_CLIENT_FILE;
 const file = join(dir, 'client.json'); process.env.PI_ANTIGRAVITY_OAUTH_CLIENT_FILE = file;
 try {
  writeFileSync(file, JSON.stringify(fixture), { mode: 0o600 }); let calls = 0;
  const auth = createAntigravityOAuth((async (url, init) => {
   calls++; assert.equal(url, 'https://oauth2.googleapis.com/token'); assert.equal(init?.redirect, 'error');
   const fields = new URLSearchParams(String(init?.body)); assert.equal(fields.get('client_id'), fixture.clientId); assert.equal(fields.get('client_secret'), fixture.clientSecret);
   return Response.json({ token_type: 'Bearer', access_token: 'fixture-new-access', expires_in: 3600 });
  }) as typeof fetch);
  const credential = { type: 'oauth' as const, access: 'fixture-old-access', refresh: 'fixture-refresh', expires: 1, antigravityVersion: 1, projectId: 'fixture-project' };
  const refreshed = await auth.refresh!(credential, new AbortController().signal);
  assert.equal(calls, 1); assert.equal(refreshed.refresh, credential.refresh); assert.ok(!JSON.stringify(refreshed).includes(fixture.clientSecret));
  rmSync(file);
  await assert.rejects(auth.refresh!(credential, new AbortController().signal), /private OAuth client configuration/);
  assert.equal(calls, 1, 'missing configuration must not dispatch a refresh');
 } finally {
  if (previous === undefined) delete process.env.PI_ANTIGRAVITY_OAUTH_CLIENT_FILE; else process.env.PI_ANTIGRAVITY_OAUTH_CLIENT_FILE = previous;
  rmSync(dir, { recursive: true, force: true });
 }
});

test('missing private OAuth client configuration fails closed, without embedded fallback', () => {
 const dir = mkdtempSync(join(tmpdir(), 'ag-client-'));
 const previous = process.env.PI_ANTIGRAVITY_OAUTH_CLIENT_FILE;
 process.env.PI_ANTIGRAVITY_OAUTH_CLIENT_FILE = join(dir, 'missing.json');
 try { assert.throws(() => authorization(), /private OAuth client configuration/); }
 finally {
  if (previous === undefined) delete process.env.PI_ANTIGRAVITY_OAUTH_CLIENT_FILE;
  else process.env.PI_ANTIGRAVITY_OAUTH_CLIENT_FILE = previous;
  rmSync(dir, { recursive: true, force: true });
 }
});
