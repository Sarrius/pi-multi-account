import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("actual Cursor HTTP/KV/root-blob replay preserves tasks, foreign progress and workspace ownership", () => {
  const output=execFileSync(process.execPath,["--import",new URL("./fixtures/typescript-loader.mjs",import.meta.url).href,new URL("./fixtures/cursor-context-probe.mts",import.meta.url).pathname],
    {cwd:new URL('../',import.meta.url),encoding:'utf8',stdio:'pipe',timeout:15000});
  assert.match(output,/CURSOR_CONTEXT_CONTINUITY_OK/);
});

test("old Cursor stream callbacks cannot overwrite or delete post-compaction task state", () => {
  const output=execFileSync(process.execPath,["--import",new URL("./fixtures/typescript-loader.mjs",import.meta.url).href,"--input-type=module","-e",`
    import assert from 'node:assert/strict';
    import {EventEmitter} from 'node:events';
    import {create,toBinary} from '@bufbuild/protobuf';
    import {AgentServerMessageSchema} from './cursor/proto/agent_pb.ts';
    import {writeSSEStreamForTests,__testInternals} from './cursor/proxy.ts';
    import {forgetConversation,deterministicConversationId} from './cursor/conversation-registry.ts';
    const key='generation-fence';
    const state=checkpoint=>({conversationId:deterministicConversationId(key),checkpoint,sessionScoped:true,blobStore:new Map(),lastAccessMs:0,turnsCovered:0});
    function frame(value,flags=0){const bytes=Buffer.alloc(5+value.length);bytes[0]=flags;bytes.writeUInt32BE(value.length,1);bytes.set(value,5);return bytes;}
    for(const terminal of ['checkpoint','end-error']){
      let receive,close;
      const old=state(new Uint8Array([1]));__testInternals.conversationStates.set(key,old);
      const bridge={alive:true,proc:{kill(){}},write(){},end(){this.alive=false},destroy(){this.alive=false},onData(fn){receive=fn},onClose(fn){close=fn}};
      const req=new EventEmitter();const res=Object.assign(new EventEmitter(),{writeHead(){},flushHeaders(){},write(){},end(){this.emit('close')}});
      const blobStore=new Map([['OLD_TASK_BLOB',new Uint8Array([3])]]);
      writeSSEStreamForTests({bridge,heartbeatTimer:setInterval(()=>{},5000),blobStore,modelId:'fixture',bridgeKey:key,convKey:key,completedTurns:[],currentTurn:{userText:'OLD_TASK',steps:[]},req,res});
      forgetConversation(key);
      const fresh=state(new Uint8Array([9]));fresh.blobStore.set('CURRENT_TASK_BLOB',new Uint8Array([4]));
      __testInternals.conversationStates.set(key,fresh);
      if(terminal==='checkpoint') receive(frame(toBinary(AgentServerMessageSchema,create(AgentServerMessageSchema,{message:{case:'conversationCheckpointUpdate',value:{previousWorkspaceUris:['file:///OLD_PROJECT']}}}))));
      else receive(frame(Buffer.from(JSON.stringify({error:{message:'old request failed',code:'internal'}})),2));
      close(0);
      assert.equal(__testInternals.conversationStates.get(key),fresh,'late errors cannot delete the new conversation');
      assert.deepEqual(fresh.checkpoint,new Uint8Array([9]),'late checkpoint cannot replace compacted task state');
      assert.equal(fresh.blobStore.has('OLD_TASK_BLOB'),false,'old task blobs cannot contaminate new generation');
      assert.equal(fresh.blobStore.has('CURRENT_TASK_BLOB'),true);
    }
    console.log('GENERATION_FENCED');
  `],{cwd:new URL('../',import.meta.url),encoding:'utf8',stdio:'pipe',timeout:10000});
  assert.match(output,/GENERATION_FENCED/);
});
