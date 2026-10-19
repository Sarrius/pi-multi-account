import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { createRecoverySource } from "../recovery-source.ts";
import { prepareRecoveryCheckpoint, type RecoveryPreparationOptions, type RecoverySourcePiece } from "../recovery-preparation.ts";
type Request = { previousSummary: string; pieces: readonly RecoverySourcePiece[] };
const response = (text = "checkpoint") => ({ text, stopReason: "stop", hasToolCalls: false });
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; };
function setup(text = "owner requirement"): RecoveryPreparationOptions<Request> {
	return { source: createRecoverySource({ scopeId: "preparation-test", records: [{id:"e",role:"user",kind:"original",text}], isCurrent:()=>true,maxSourceBytes:100000,maxReplyBytes:512 }),
		isCurrent:()=>true,timeoutMs:1000,maxPasses:100,maxRequestBytes:700,maxSummaryBytes:128,
		buildRequest:(previousSummary,pieces)=>({previousSummary,pieces}),generate:async()=>response(),validateFinal:()=>true };
}
function blocked(result: Awaited<ReturnType<typeof prepareRecoveryCheckpoint>>, reason: string) {
	assert.equal(result.status,"blocked");if(result.status!=="blocked")throw Error("expected block");assert.equal(result.reason,reason);assert.equal("summary" in result,false);return result;
}

test("complete multi-pass preparation delivers exact paged originals within each request budget", async()=>{
	const text='Original 😀 \\" evidence\n'.repeat(150),options=setup(text),delivered:RecoverySourcePiece[]=[];
	let expectedPrevious="",calls=0;
	options.generate=async request=>{assert.ok(Buffer.byteLength(JSON.stringify(request))<=options.maxRequestBytes);assert.equal(request.previousSummary,expectedPrevious);delivered.push(...request.pieces);expectedPrevious=`checkpoint ${++calls}`;return response(expectedPrevious);};
	const result=await prepareRecoveryCheckpoint(options);assert.equal(result.status,"prepared");if(result.status!=="prepared")return;
	assert.ok(calls>1);assert.equal(result.passes,calls);assert.equal(result.acceptedPieces,delivered.length);assert.equal(result.summary,expectedPrevious);assert.deepEqual(result.sourceIds,["e"]);
	assert.equal(delivered.map(p=>p.text).join(""),text);let offset=0;for(const p of delivered){assert.equal(p.offset,offset);offset+=p.text.length;}
	assert.equal(delivered.at(-1)!.nextOffset,null);await options.source.list();
});

test("nonmonotone builders never cause dispatch of an unchecked oversized candidate", async()=>{
	const options=setup("x".repeat(1800));let calls=0;
	options.buildRequest=(previousSummary,pieces)=>({previousSummary:pieces.length===2?"x".repeat(2000):previousSummary,pieces});
	options.generate=async request=>{calls++;assert.ok(Buffer.byteLength(JSON.stringify(request))<=700);assert.equal(request.pieces.length,1);return response();};
	assert.equal((await prepareRecoveryCheckpoint(options)).status,"prepared");assert.ok(calls>1);
});

test("numeric limits and pre-aborted work do not invoke the generator",async()=>{
	for(const [key,value] of [["timeoutMs",0],["timeoutMs",2147483648],["maxPasses",NaN],["maxRequestBytes",0],["maxSummaryBytes",-1]] as const){let calls=0;const o=setup();o[key]=value;o.generate=async()=>{calls++;return response();};blocked(await prepareRecoveryCheckpoint(o),"limits");assert.equal(calls,0);}
	const o=setup(),abort=new AbortController();abort.abort();o.signal=abort.signal;o.isCurrent=()=>{throw Error("must not run");};o.source.list=()=>{throw Error("must not run");};assert.equal(blocked(await prepareRecoveryCheckpoint(o),"cancelled").passes,0);
});

test("blank, oversized, truncated and tool-call responses never expose a checkpoint",async()=>{
	for(const value of [response(" \n"),response("😀".repeat(100)),{...response(),stopReason:"length"},{...response(),hasToolCalls:true}]){const o=setup();o.generate=async()=>value;const result=blocked(await prepareRecoveryCheckpoint(o),"response");assert.equal(result.passes,1);assert.equal(result.acceptedPieces,0);}
});

test("source failure, duplicate metadata and non-progressing/inconsistent pages block",async()=>{
	const item={id:"e",handle:"h",role:"user",kind:"original"};
	const brokenSources=[
		{list:()=>({items:[],nextCursor:0}),read:()=>{throw Error("unused");}},
		{list:()=>({items:[item,item],nextCursor:null}),read:()=>{throw Error("unused");}},
		{list:()=>({items:[item],nextCursor:null}),read:()=>({id:"wrong",role:"user",kind:"original",offset:0,text:"a",nextOffset:null})},
		{list:()=>({items:[item],nextCursor:null}),read:()=>({id:"e",role:"user",kind:"original",offset:0,text:"a",nextOffset:0})},
		{list:()=>({items:[item],nextCursor:null}),read:()=>({id:"e",role:"user",kind:"original",offset:0,text:"a",nextOffset:2})},
		{list:()=>Promise.reject(Error("unavailable")),read:()=>{throw Error("unused");}},
		{list:()=>({items:[],nextCursor:null}),read:()=>{throw Error("unused");}},
	];
	for(const source of brokenSources){const o=setup();o.source=source;assert.equal(blocked(await prepareRecoveryCheckpoint(o),"source").passes,0);}
});

test("builder errors, one-page overflow and final rejection preserve originals",async()=>{
	const broken=setup();broken.buildRequest=()=>{throw Error("cannot serialize");};blocked(await prepareRecoveryCheckpoint(broken),"request_budget");
	const small=setup();small.maxRequestBytes=1;assert.equal(blocked(await prepareRecoveryCheckpoint(small),"request_budget").passes,0);
	for(const validateFinal of [()=>false,()=>{throw Error("final validation failed");}]){const o=setup();o.validateFinal=validateFinal;const result=blocked(await prepareRecoveryCheckpoint(o),"final_validation");assert.ok(result.acceptedPieces>0);await o.source.list();}
});

test("exhausted pass budget and generation failure do not publish partial summaries",async()=>{
	const o=setup("x".repeat(2000));o.maxPasses=1;o.maxRequestBytes=550;const result=blocked(await prepareRecoveryCheckpoint(o),"pass_budget");assert.equal(result.passes,1);assert.ok(result.acceptedPieces>0);
	const fail=setup();fail.generate=async()=>{throw Error("provider refused");};blocked(await prepareRecoveryCheckpoint(fail),"generation");
});

test("cancellation settles an abort-ignoring generator and observes its late rejection",async()=>{
	const o=setup(),abort=new AbortController(),started=deferred<void>(),pending=deferred<ReturnType<typeof response>>();o.signal=abort.signal;
	o.generate=async()=>{started.resolve();return pending.promise;};const work=prepareRecoveryCheckpoint(o);await started.promise;abort.abort();blocked(await work,"cancelled");pending.reject(Error("late refusal"));await yieldTurn();
});

test("scope change during generation, builder and final validation prevents publication",async()=>{
	const o=setup(),started=deferred<void>(),pending=deferred<ReturnType<typeof response>>();let current=true;o.isCurrent=()=>current;o.generate=async()=>{started.resolve();return pending.promise;};const work=prepareRecoveryCheckpoint(o);await started.promise;current=false;pending.resolve(response());blocked(await work,"stale");
	for(const phase of ["builder","final"]){const next=setup();let valid=true;next.isCurrent=()=>valid;if(phase==="builder")next.buildRequest=(previousSummary,pieces)=>{valid=false;return {previousSummary,pieces};};else next.validateFinal=()=>{valid=false;return true;};blocked(await prepareRecoveryCheckpoint(next),"stale");}
});

test("overall deadline locally settles a never-resolving generator",async()=>{
	const o=setup();o.timeoutMs=200;o.generate=()=>new Promise(()=>{});const result=blocked(await prepareRecoveryCheckpoint(o),"deadline");assert.equal(result.passes,1);
});

test("the initial current-owner callback is included in the overall deadline",async()=>{
	const o=setup();o.timeoutMs=5;let first=true;o.isCurrent=()=>{if(first){first=false;const until=performance.now()+25;while(performance.now()<until){/* simulate synchronous validation */}}return true;};
	const result=blocked(await prepareRecoveryCheckpoint(o),"deadline");assert.equal(result.passes,0);
});
