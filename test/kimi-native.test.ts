import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import test from 'node:test';
import {VERSION} from '@earendil-works/pi-coding-agent';

test('stock Pi: cold Kimi catalog keeps the Pro model and an actual native summary refusal persists its backoff', {skip:!/^1\.6\./.test(VERSION), timeout:30000}, async()=>{
 const home=mkdtempSync(join(tmpdir(),'pi-kimi-native-'));
 try {
  const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('./fixtures/kimi-native.mts',import.meta.url))],{cwd:home,env:{PATH:process.env.PATH,HOME:home,PI_CODING_AGENT_DIR:join(home,'agent'),PI_OFFLINE:'1',PI_NO_LOCAL_LLM:'1',PI_TELEMETRY:'0'},timeout:25000});
  assert.match(stdout,/KIMI_NATIVE_OK/);
 } finally {rmSync(home,{recursive:true,force:true});}
});
