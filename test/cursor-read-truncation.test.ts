import {execFileSync} from 'node:child_process';
import test from 'node:test';

test('native read never claims Pi partial output is a complete file; directs paging through MCP',()=>{
 execFileSync(process.execPath,['--import',new URL('./fixtures/typescript-loader.mjs',import.meta.url).href,'--input-type=module','-e',`
  import assert from 'node:assert/strict';
  import {fromBinary} from '@bufbuild/protobuf';
  import {AgentClientMessageSchema} from './cursor/proto/agent_pb.ts';
  import {__testInternals} from './cursor/proxy.ts';
  const contents=['small complete file','code\\n\\n[Showing lines 1-2000 of 3000. Use offset=2001 to continue.]','code\\n\\n[Showing lines 1-900 of 3000 (50.0KB limit). Use offset=901 to continue.]','code\\n\\n[30 more lines in file. Use offset=101 to continue.]','[Line 1 is 80.0KB, exceeds 50.0KB limit. Use bash: unsafe-untrusted-path]'];
  for(const [index,content] of contents.entries()){
   const sent=[];
   __testInternals.resumePendingExecWithToolResult({execId:'read-'+index,execMsgId:index+1,toolCallId:'tool-'+index,toolName:'read',decodedArgs:'{"path":"/tmp/source.ts"}',nativeArgs:{path:'/tmp/source.ts'},resultCase:'readResult'},content,false,data=>sent.push(fromBinary(AgentClientMessageSchema,data.subarray(5)).message));
   const result=sent.find(m=>m.case==='execClientMessage').value.message.value.result;
   assert.equal(result.case,index===0?'success':'error');
   if(index===0){assert.equal(result.value.truncated,false);assert.equal(result.value.output.value,content);}
   else if(index===4){assert.match(result.value.error,/oversized/);assert.ok(!result.value.error.includes('unsafe-untrusted-path'));}
   else {assert.match(result.value.error,/MCP.*read/);assert.match(result.value.error,/offset=/);}
  }
 `],{cwd:new URL('..',import.meta.url),stdio:'pipe',timeout:15000});
});
