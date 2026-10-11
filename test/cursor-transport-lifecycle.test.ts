import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
for(const scenario of ['eof','status','json','cleanup','tool_fidelity','native_error','unary_timeout'])test('Cursor transport lifecycle and outcome: '+scenario,()=>{
  const output=execFileSync(process.execPath,['--import',new URL('./fixtures/typescript-loader.mjs',import.meta.url).href,new URL('./fixtures/cursor-transport-probe.mts',import.meta.url).pathname,scenario],{cwd:new URL('../',import.meta.url),encoding:'utf8',timeout:10000,stdio:'pipe'});
  assert.match(output,new RegExp('CURSOR_TRANSPORT_OK '+scenario));
});
