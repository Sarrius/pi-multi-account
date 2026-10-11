import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http2';
import {spawn} from 'node:child_process';
import {createBridgeHandle,type BridgeStreams} from '../cursor/bridge-handle.ts';
import {safeTransportStatus,transportStatusError,transportStatusFromHeaders} from '../cursor/transport-status.mjs';

test('structured HTTP/protocol evidence separates auth, quota, model and transient failures without private data',()=>{
  for(const status of [{httpStatus:401},{code:'16'},{httpStatus:429},{code:'8'},{httpStatus:503},{code:'14'},{code:'5'}]){
    const safe=safeTransportStatus({...status,authorization:'PRIVATE_TOKEN',body:'PRIVATE_BODY'});
    assert.doesNotMatch(JSON.stringify(safe),/PRIVATE/);
    assert.ok(transportStatusError(safe));
  }
  assert.match(transportStatusError({httpStatus:503})!,/connection error/);
  assert.doesNotMatch(transportStatusError({httpStatus:503})!,/429|quota|authentication/i);
  assert.equal(transportStatusError({httpStatus:200,code:'ok'}),undefined);
  assert.deepEqual(safeTransportStatus(null),{});
  assert.deepEqual(transportStatusFromHeaders({':status':429,'retry-after':'2','set-cookie':'PRIVATE'}),{httpStatus:429,retryAfterMs:2000});
  assert.deepEqual(transportStatusFromHeaders({'grpc-status':'16'}),{code:'unauthenticated'});
});

test('actual H2 subprocess preserves stdout protobuf bytes and forwards only safe status/trailer metadata',async()=>{
  const server=createServer();
  let httpStatus=200,code='0';
  server.on('stream',stream=>{
    stream.respond({':status':httpStatus,'set-cookie':'PRIVATE_COOKIE'},{waitForTrailers:true});
    stream.on('wantTrailers',()=>stream.sendTrailers({'grpc-status':code,'grpc-message':'PRIVATE_BODY'}));
    stream.end(Buffer.from([10,2,111,107]));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    for(const pair of [[401,'16'],[429,'8'],[503,'14'],[200,'0']] as const){
      [httpStatus,code]=pair;
      const proc=spawn(process.execPath,[new URL('../cursor/h2-bridge.mjs',import.meta.url).pathname],{stdio:['pipe','pipe','pipe']});
      const handle=createBridgeHandle(proc as unknown as BridgeStreams);
      const frames:Buffer[]=[],statuses:unknown[]=[];let stderr='';
      proc.stderr.on('data',chunk=>stderr+=chunk.toString());
      handle.onData(chunk=>frames.push(chunk));handle.onStatus?.(status=>statuses.push(status));
      const finished=new Promise<number>(resolve=>handle.onClose(resolve));
      handle.write(Buffer.from(JSON.stringify({url:`http://127.0.0.1:${(server.address() as any).port}`,accessToken:'PRIVATE_TOKEN',path:'/fixture',unary:true})));
      handle.write(new Uint8Array([1]));
      const timeout=setTimeout(()=>handle.destroy(),5000);
      try{assert.equal(await finished,0);}finally{clearTimeout(timeout);handle.destroy();}
      assert.deepEqual(Buffer.concat(frames),Buffer.from([10,2,111,107]));
      assert.ok(statuses.some((status:any)=>status.httpStatus===httpStatus));
      assert.ok(statuses.some((status:any)=>status.code===(code==='0'?'ok':code==='16'?'unauthenticated':code==='8'?'resource_exhausted':'unavailable')));
      assert.doesNotMatch(stderr,/PRIVATE_TOKEN|PRIVATE_COOKIE|PRIVATE_BODY/);
      assert.equal(handle.alive,false);
    }
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
