import {execFileSync} from 'node:child_process';
import test from 'node:test';

function run(source: string) {
 execFileSync(process.execPath,['--import',new URL('./fixtures/typescript-loader.mjs',import.meta.url).href,'--input-type=module','-e',`
 import assert from 'node:assert/strict';
 import {metadataForDebug,sanitizeForDebug,startProxy,stopProxy} from './cursor/proxy.ts';
 ${source}
 `],{cwd:new URL('..',import.meta.url),stdio:'pipe',timeout:15000});
}

test('real local proxy diagnostics create private files and redact request credentials',()=>run(`
 const {mkdtempSync,readFileSync,statSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'cursor-private-log-')),log=join(root,'debug.log');
 process.env.PI_CURSOR_PROVIDER_DEBUG='1';
 process.env.PI_CURSOR_PROVIDER_DEBUG_FILE=log;
 delete process.env.PI_CURSOR_PROVIDER_DEBUG_METADATA_ONLY;
 try {
  const port=await startProxy(async()=>{throw new Error('unknown route must not request credentials')});
  await fetch('http://127.0.0.1:'+port+'/not-a-provider-route',{headers:{'x-api-key':'fixture-header-secret','cookie':'fixture-cookie-secret'}});
  const contents=readFileSync(log,'utf8');
  assert.match(contents,/http.request/);
  assert.ok(!contents.includes('fixture-header-secret'));
  assert.ok(!contents.includes('fixture-cookie-secret'));
  assert.equal(statSync(log).mode&0o777,0o600);
 } finally {stopProxy();rmSync(root,{recursive:true,force:true});}
`));

test('Cursor diagnostics redact credential field variants recursively',()=>run(`
 const keys=['authorization','Authorization','proxy-authorization','cookie','set-cookie','x-api-key','apiKey','api_key','accessToken','access_token','refreshToken','refresh_token','id_token','secret','clientSecret','password','key'];
 const original={nested:Object.fromEntries(keys.map(key=>[key,'private-fixture-value'])),ordinary:'safe'};
 const sanitized=JSON.stringify(sanitizeForDebug(original));
 assert.ok(!sanitized.includes('private-fixture-value'));
 assert.ok(sanitized.includes('safe'));
`));

test('metadata-only Cursor tracing drops text/headers/results and hashes correlation identifiers',()=>run(`
 const result=metadataForDebug({requestId:2,bridgeKey:'session-private-id',execCase:'shellStreamArgs',msgCase:'execServerMessage',silentForMs:60000,closed:true,
  headers:{authorization:'private-key'},body:{messages:['private-prompt']},toolResults:[{text:'private-result'}],
  pendingExecs:[{id:'private-id'}],exec:{id:'private-exec',type:'readArgs'},apiKey:123456,password:1234,event:'spoofed'});
 const text=JSON.stringify(result);
 assert.ok(!text.includes('private'));
 assert.ok(!text.includes('123456'));
 assert.ok(!text.includes('1234'));
 assert.equal(result.requestId,2);
 assert.equal(result.execCase,'shellStreamArgs');
 assert.equal(result.msgCase,'execServerMessage');
 assert.equal(result.toolResultsCount,1);
 assert.equal(result.pendingExecsCount,1);
 assert.match(String(result.bridgeKey),/^[a-f0-9]{16}$/);
 assert.equal(result.body,undefined);
 assert.equal(result.event,undefined);
`));
