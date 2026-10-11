import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mock} from 'node:test';
import {create,fromBinary,toBinary} from '@bufbuild/protobuf';
import {AgentClientMessageSchema,AgentServerMessageSchema} from '../../cursor/proto/agent_pb.ts';
import {writeSSEStreamForTests,resumeCursorToolResultsForTests,cleanupSessionState,__testInternals,callCursorUnaryRpc,setBridgeFactoryForTests,startProxy,stopProxy} from '../../cursor/proxy.ts';
import {deriveBridgeKeyFromSessionId,deriveConversationKeyFromSessionId} from '../../cursor/conversation-registry.ts';
import {shapeCursorPayload,cursorPayloadStream} from '../../provider-payload-stream.ts';
import {parseMessages} from '../../cursor/message-parsing.ts';
process.env.PI_CURSOR_UPSTREAM_STALL_MS='200';process.env.PI_CURSOR_TRANSPORT_STALL_MS='200';process.env.PI_CURSOR_TOOL_COALESCE_MS='20';
mock.timers.enable({apis:['setTimeout','setInterval','Date']});mock.method(performance,'now',()=>Date.now());
function frame(message:any){const body=toBinary(AgentServerMessageSchema,create(AgentServerMessageSchema,{message}));const bytes=Buffer.alloc(5+body.length);bytes.writeUInt32BE(body.length,1);bytes.set(body,5);return bytes;}
function response(){let output='',status=0,ends=0;const res:any=Object.assign(new EventEmitter(),{writableEnded:false,destroyed:false,headersSent:false,writeHead(code:number){status=code;this.headersSent=true;},flushHeaders(){},write(data:string){output+=data;},end(data=''){if(this.writableEnded)return;output+=data;ends++;this.writableEnded=true;this.emit('close');}});return {req:new EventEmitter(),res,output:()=>output,status:()=>status,ends:()=>ends};}
let n=0;
function open(stream=true,session='session-'+(++n),tools=['read','write','bash']){
  let receive:any,onClose:any,onStatus:any;const sent:any[]=[];
  const bridge:any={alive:true,proc:{kill(){}},onData(fn:any){receive=fn;},onClose(fn:any){onClose=fn;},onStatus(fn:any){onStatus=fn;},write(bytes:Uint8Array){sent.push(fromBinary(AgentClientMessageSchema,bytes.subarray(5)).message);},destroy(){if(!this.alive)return;this.alive=false;onClose?.(1);},end(){this.alive=false;}};
  const out=response(),key=deriveBridgeKeyFromSessionId(session),conv=deriveConversationKeyFromSessionId(session);
  writeSSEStreamForTests({bridge,heartbeatTimer:setInterval(()=>{},5000),mcpTools:tools.map(name=>({name,toolName:name})),modelId:'fixture',bridgeKey:key,convKey:conv,completedTurns:[],currentTurn:{userText:'TASK_A',steps:[]},req:out.req as any,res:out.res,stream} as any);
  return {...out,bridge,key,conv,sent,receive:(bytes:Buffer)=>receive(bytes),fail:(code:number)=>{bridge.alive=false;onClose(code);},emitStatus:(value:any)=>onStatus?.(value)};
}
const text=(value='partial')=>frame({case:'interactionUpdate',value:{message:{case:'textDelta',value:{text:value}}}});
const ended=()=>frame({case:'interactionUpdate',value:{message:{case:'turnEnded',value:{}}}});
const native=(kind:string,args:any)=>frame({case:'execServerMessage',value:{id:17,execId:'exec17',message:{case:kind,value:{...args,toolCallId:'r1'}}}});
try{
 const scenario=process.argv[2];
 if(scenario==='eof'){
   for(const code of [0,1])for(const truncated of [false,true]){
    const run=open();run.receive(text());if(truncated)run.receive(Buffer.from([0,0,0,0,50,10]));run.fail(code);
    assert.match(run.output(),/partial/);assert.match(run.output(),/"finish_reason":"error"/);assert.doesNotMatch(run.output(),/"finish_reason":"stop"/);assert.equal(run.ends(),1);assert.equal(__testInternals.activeBridges.has(run.key),false);
   }
   const good=open();good.receive(text());good.receive(ended());good.fail(0);assert.equal(good.ends(),1);assert.match(good.output(),/"finish_reason":"stop"/);
 }else if(scenario==='status'){
   for(const [metadata,expected] of [[{httpStatus:401},/authentication/],[{httpStatus:429},/rate limit/],[{httpStatus:503},/connection error/],[{code:'unavailable'},/connection error/]]){
     const run=open();run.emitStatus(metadata);assert.equal(run.res.writableEnded,true);assert.match(run.output(),expected as RegExp);assert.doesNotMatch(run.output(),/"finish_reason":"stop"/);
   }
   const run=open();const body=Buffer.from(JSON.stringify({error:{code:'unavailable',message:'fixture'}}));const bytes=Buffer.alloc(5+body.length);bytes[0]=2;bytes.writeUInt32BE(body.length,1);bytes.set(body,5);run.receive(bytes);assert.match(run.output(),/connection error/);assert.equal(__testInternals.activeBridges.has(run.key),false);
 }else if(scenario==='json'){
   const run=open(false);run.receive(native('readArgs',{path:'/tmp/a'}));mock.timers.tick(20);
   assert.equal(run.status(),200);assert.doesNotMatch(run.output(),/data:/);const first=JSON.parse(run.output());assert.equal(first.choices[0].finish_reason,'tool_calls');
   const active=__testInternals.activeBridges.get(run.key)!;assert.ok(active);const resumed=response();
   resumeCursorToolResultsForTests(active,[{toolCallId:'r1',content:'file text'}],resumed.req as any,resumed.res,{modelId:'fixture',bridgeKey:run.key,convKey:run.conv,stream:false} as any);
   run.receive(text('after-read'));run.receive(ended());assert.doesNotMatch(resumed.output(),/data:/);assert.equal(JSON.parse(resumed.output()).choices[0].message.content,'after-read');assert.equal(resumed.ends(),1);
   const stale=open(false);for(let i=0;i<6;i++){stale.receive(frame({case:'conversationCheckpointUpdate',value:{}}));mock.timers.tick(50);}
   assert.equal(stale.res.writableEnded,true);assert.equal(stale.status(),502);assert.match(stale.output(),/stream timed out/);assert.equal(__testInternals.activeBridges.has(stale.key),false);
   const cancelled=open(false);cancelled.req.emit('close');assert.equal(cancelled.res.writableEnded,true);assert.equal(cancelled.bridge.alive,false);assert.equal(__testInternals.activeBridges.has(cancelled.key),false);
 }else if(scenario==='cleanup'){
   for(const phase of ['streaming','paused','resumed']){
    const run=open(true,'owner-'+phase),other=open(true,'peer-'+phase);
    if(phase!=='streaming'){run.receive(native('readArgs',{path:'/tmp/a'}));mock.timers.tick(20);if(phase==='resumed'){const active=__testInternals.activeBridges.get(run.key)!;const next=response();resumeCursorToolResultsForTests(active,[{toolCallId:'r1',content:'ok'}],next.req as any,next.res,{modelId:'fixture',bridgeKey:run.key,convKey:run.conv});Object.assign(run,{res:next.res,output:next.output});}}
    cleanupSessionState('owner-'+phase);assert.equal(run.bridge.alive,false);assert.equal(run.res.writableEnded,true);assert.equal(__testInternals.activeBridges.has(run.key),false);assert.equal(other.bridge.alive,true);assert.equal(other.res.writableEnded,false);other.receive(text('peer-alive'));other.receive(ended());assert.match(other.output(),/peer-alive/);
   }
 }else if(scenario==='tool_fidelity'){
   for(const kind of ['readArgs','shellStreamArgs','mcpArgs']){
    const run=open();const args=kind==='mcpArgs'?{name:'read',args:{}}:kind==='readArgs'?{path:'/tmp/missing'}:{command:'false'};
    run.receive(native(kind,args));mock.timers.tick(20);assert.match(run.output(),/"finish_reason":"tool_calls"/);
    const payload=shapeCursorPayload({messages:[{role:'user',content:'TASK_A'},{role:'assistant',content:null,tool_calls:[{id:'r1',type:'function',function:{name:'read',arguments:'{}'}}]},{role:'tool',tool_call_id:'r1',content:'explicit failure'}]}, {}, {messages:[{role:'toolResult',toolCallId:'r1',isError:true}]});
    const parsed=parseMessages(payload.messages);assert.equal(parsed.toolResults[0].isError,true);
    const active=__testInternals.activeBridges.get(run.key)!;assert.ok(active);const next=response();resumeCursorToolResultsForTests(active,parsed.toolResults,next.req as any,next.res,{modelId:'fixture',bridgeKey:run.key,convKey:run.conv});
    const execs=run.sent.filter(msg=>msg.case==='execClientMessage');const result=execs.at(-1)!.value.message;
    if(kind==='readArgs')assert.equal(result.value.result.case,'error');
    if(kind==='shellStreamArgs'){assert.equal(result.value.event.case,'exit');assert.equal(result.value.event.value.code,1);assert.equal(run.sent.filter(msg=>msg.case==='execClientControlMessage'&&msg.value.message.case==='streamClose').length,1);}
    if(kind==='mcpArgs')assert.equal(result.value.result.value.isError,true);
    run.receive(ended());
   }
   const run=open();const written='α\nUTF-8 text\n';run.receive(native('writeArgs',{path:'/tmp/write',fileText:written}));mock.timers.tick(20);const active=__testInternals.activeBridges.get(run.key)!;const next=response();resumeCursorToolResultsForTests(active,[{toolCallId:'r1',content:'Successfully wrote to /tmp/write'}],next.req as any,next.res,{modelId:'fixture',bridgeKey:run.key,convKey:run.conv});const result=run.sent.find(msg=>msg.case==='execClientMessage')!.value.message.value.result;assert.equal(result.case,'success');assert.equal(result.value.fileContentAfterWrite,written);assert.equal(result.value.fileSize,Buffer.byteLength(written));run.receive(ended());
 }else if(scenario==='native_error'){
   mock.timers.reset();
   for(const [metadata,expected] of [[{httpStatus:401},/authentication/],[{httpStatus:429},/rate limit/],[{httpStatus:503},/connection error/],[{eof:true},/connection error.*before turnEnded/]]){
     setBridgeFactoryForTests(()=>{let receive:any,onClose:any,status:any;const bridge:any={alive:true,proc:{kill(){}},onData(fn:any){receive=fn;},onClose(fn:any){onClose=fn;},onStatus(fn:any){status=fn;},end(){},destroy(){if(!this.alive)return;this.alive=false;onClose?.(1);},write(bytes:Uint8Array){const request=fromBinary(AgentClientMessageSchema,bytes.subarray(5)).message;if(request.case!=='runRequest')return;queueMicrotask(()=>{if((metadata as any).eof){receive(text('partial text preserved'));onClose(1);}else status(metadata);});}};return bridge;});
     const port=await startProxy(async()=> 'fixture-only');
     try{
       const model:any={api:'openai-completions',provider:'cursor',id:'fixture',baseUrl:`http://127.0.0.1:${port}/v1`,name:'fixture',reasoning:false,input:['text'],contextWindow:10000,maxTokens:100,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
       const stream=cursorPayloadStream(model,{messages:[{role:'user',content:'synthetic request',timestamp:0}]},{apiKey:'fixture-only',maxRetries:0,sessionId:'native-'+(metadata as any).httpStatus,signal:AbortSignal.timeout(5000)});
       const result=await stream.result();assert.equal(result.stopReason,'error');assert.match(result.errorMessage,expected as RegExp);if((metadata as any).eof)assert.match(JSON.stringify(result.content),/partial text preserved/);
     }finally{stopProxy();}
   }
 }else if(scenario==='unary_timeout'){
   let destroyed=0;setBridgeFactoryForTests(()=>({alive:true,proc:{kill(){}},write(){},end(){},destroy(){destroyed++;},onData(){},onClose(){}}));
   const result=callCursorUnaryRpc({accessToken:'fixture',rpcPath:'/fixture',requestBody:new Uint8Array([1]),timeoutMs:100});mock.timers.tick(110);assert.equal((await result).timedOut,true);assert.equal(destroyed,1);setBridgeFactoryForTests();
 }else throw new Error('unknown scenario '+scenario);
 console.log('CURSOR_TRANSPORT_OK '+scenario);
}finally{setBridgeFactoryForTests();mock.timers.reset();}
