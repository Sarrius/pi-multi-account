import assert from 'node:assert/strict';
import {create,fromBinary,toBinary} from '@bufbuild/protobuf';
import {AgentClientMessageSchema,AgentServerMessageSchema,AgentRunRequestSchema} from '../../cursor/proto/agent_pb.ts';
import {setBridgeFactoryForTests,startProxy,stopProxy,resetConversationForSession,__testInternals,buildCursorRequest,deriveConversationKey,deriveBridgeKey} from '../../cursor/proxy.ts';
const runs:any[]=[];
function frame(message:any){const payload=toBinary(AgentServerMessageSchema,create(AgentServerMessageSchema,{message}));const bytes=Buffer.alloc(5+payload.length);bytes.writeUInt32BE(payload.length,1);bytes.set(payload,5);return bytes;}
setBridgeFactoryForTests(()=>{
  let receive:any,closed:any,run:any;
  const bridge:any={alive:true,proc:{kill(){}},end(){this.destroy();},destroy(){if(!this.alive)return;this.alive=false;closed?.(0);},onData(fn:any){receive=fn;},onClose(fn:any){closed=fn;},write(bytes:Uint8Array){
    const message=fromBinary(AgentClientMessageSchema,bytes.subarray(5)).message;
    if(message.case==='runRequest'){
      run={state:message.value.conversationState,conversationId:message.value.conversationId,action:JSON.stringify(message.value.action),root:''};runs.push(run);
      queueMicrotask(()=>{
        receive(frame({case:'conversationCheckpointUpdate',value:run.state}));
        receive(frame({case:'kvServerMessage',value:{id:1,message:{case:'getBlobArgs',value:{blobId:run.state.rootPromptMessagesJson[0]}}}}));
      });
    }else if(message.case==='kvClientMessage'&&message.value.message.case==='getBlobResult'){
      run.root=new TextDecoder().decode(message.value.message.value.blobData);
      receive(frame({case:'interactionUpdate',value:{message:{case:'textDelta',value:{text:'DONE_1 NEXT_2'}}}}));
      receive(frame({case:'interactionUpdate',value:{message:{case:'turnEnded',value:{}}}}));
    }
  }};return bridge;
});
const before=[{role:'system',content:'PROJECT_A /workspace/a CONSTRAINT_X'},{role:'user',content:'<summary>TASK_A DONE_1 NEXT_2</summary>'},{role:'user',content:'Continue NEXT_2; do not repeat DONE_1'}];
const reply={role:'assistant',content:'DONE_1 NEXT_2'};
const port=await startProxy(async()=> 'fixture-only');
async function send(messages:any[],session='owner-A',cwd='/workspace/a'){
  const response=await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'composer-2.5',stream:true,messages,pi_session_id:session||undefined,pi_cwd:cwd}),signal:AbortSignal.timeout(5000)});
  assert.equal(response.status,200);const text=await response.text();assert.match(text,/DONE_1 NEXT_2/);assert.match(text,/"finish_reason":"stop"/);
}
try{
  await send(before);
  assert.match(runs[0].root,/TASK_A/);assert.match(runs[0].root,/DONE_1/);assert.match(runs[0].root,/NEXT_2/);assert.match(runs[0].root,/CONSTRAINT_X/);
  assert.deepEqual(runs[0].state.previousWorkspaceUris,['file:///workspace/a']);
  await send([...before,reply,{role:'user',content:'Continue NEXT_2'}]);
  assert.equal(runs[1].conversationId,runs[0].conversationId,'known own response and normal next task retain the Cursor conversation');
  const foreign=[...before,reply,{role:'assistant',content:'Other provider completed DONE_2; now NEXT_3'},{role:'user',content:'Continue NEXT_3'}];
  await send(foreign);
  assert.notEqual(runs[2].conversationId,runs[1].conversationId,'same-turn foreign progress must rebuild');
  assert.match(runs[2].root,/DONE_2/);assert.match(runs[2].root,/NEXT_3/);assert.match(runs[2].root,/TASK_A/);
  resetConversationForSession('owner-A');
  await send([{role:'system',content:'PROJECT_A CONSTRAINT_X'},{role:'user',content:'<summary>TASK_A DONE_1 DONE_2 NEXT_3</summary>'},{role:'user',content:'Continue NEXT_3'}]);
  assert.notEqual(runs[3].conversationId,runs[2].conversationId);
  assert.match(runs[3].root,/TASK_A/);assert.match(runs[3].root,/NEXT_3/);assert.doesNotMatch(runs[3].root,/Other provider completed/);
  const shared='same-prefix '.repeat(25);
  await send([{role:'user',content:shared+'PROJECT_A'}],'');
  await send([{role:'user',content:shared+'PROJECT_B'}],'','/workspace/b');
  assert.notEqual(runs[4].conversationId,runs[5].conversationId,'identity-less background requests never share state');
  assert.match(runs[5].root+runs[5].action,/PROJECT_B/);assert.doesNotMatch(runs[5].root+runs[5].action,/PROJECT_A/);
  assert.deepEqual(runs[5].state.previousWorkspaceUris,['file:///workspace/b']);
  assert.equal(deriveConversationKey(before)===deriveConversationKey(before),false);
  assert.equal(deriveBridgeKey(before)===deriveBridgeKey(before),false);
  const unbound=buildCursorRequest('fixture','SYSTEM','TASK',[],'unbound',null);
  const parsed=fromBinary(AgentClientMessageSchema,unbound.requestBytes).message;
  assert.equal(parsed.case,'runRequest');assert.deepEqual(parsed.value.conversationState.previousWorkspaceUris,[],'unknown workspace is never invented from the proxy process cwd');
  assert.equal(__testInternals.activeBridges.size,0,'completed Runs leave no active bridges');
  console.log('CURSOR_CONTEXT_CONTINUITY_OK');
}finally{stopProxy();setBridgeFactoryForTests();}
