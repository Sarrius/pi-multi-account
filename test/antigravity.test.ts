import assert from "node:assert/strict";
import { PUBLIC_INSTALLED_CLIENT as installedClient } from "../antigravity/oauth-client.ts";
import nodeTest from "node:test";
import { supportsNativeTranscript } from "../google-transport/native.ts";
const test = supportsNativeTranscript ? nodeTest : nodeTest.skip;
import { antigravityProvider } from "../antigravity/provider.ts";
import { authorization, REDIRECT } from "../antigravity/oauth.ts";
import { BASE, ID, STREAM, PROJECT_HEADER, project } from "../antigravity/transport.ts";
import { parseCatalog } from "../antigravity/catalog.ts";
nodeTest("unsupported hosts reject Antigravity without guessing transcript compatibility", {skip:supportsNativeTranscript}, () => {
 assert.throws(() => antigravityProvider(), /requires modern native transcript APIs/);
});
const catalog={models:{
 "gemini-4-argon-high":{displayName:"Argon",maxTokens:1000000,maxOutputTokens:65536,supportsImages:true,supportsThinking:true,quotaInfo:{remainingFraction:.8,resetTime:"2027-01-01T00:00:00Z"}},
 "claude-opus-4-6-thinking":{maxTokens:200000,maxOutputTokens:65536,supportsThinking:true,quotaInfo:{remainingFraction:.3}},
 "disabled-garbage":{maxTokens:1000},
}};
const credential={type:"oauth" as const,access:"fixture-access",refresh:"fixture-refresh",expires:Date.now()+3600000,antigravityVersion:1,accountId:"google:123",projectId:"fixture-project",catalog:parseCatalog(catalog),catalogAt:Date.now()};

test("Antigravity preserves opaque account-returned project names without accepting header controls",()=>{
 assert.equal(project("projects/fixture-project"),"projects/fixture-project");
 assert.throws(()=>project({}),/identifier/);assert.throws(()=>project("project\nInjected: secret"),/identifier/);
 assert.throws(()=>project(""),/identifier/);
});

test("Antigravity uses distinct OAuth client, scopes and callback; verifier not in state",()=>{
 const a=authorization(),url=new URL(a.url);
 assert.equal(url.searchParams.get("client_id"),installedClient.clientId);
 assert.equal(url.searchParams.get("redirect_uri"),REDIRECT);assert.match(url.searchParams.get("scope")!,/experimentsandconfigs/);
 assert.equal(url.searchParams.get("state"),a.state);assert.ok(!a.state.includes(a.verifier));
});

for(const onboarding of [false,true])test(`complete Antigravity login resolves account/catalog (onboarding=${onboarding})`,async()=>{
 const calls:string[]=[];let state="",consented=false;
 const provider=antigravityProvider({fetch:(async(url,init)=>{
  const u=String(url);calls.push(u);assert.equal(init?.redirect,"error");
  if(u.includes("oauth2.googleapis.com/token")) {
   const fields=new URLSearchParams(String(init?.body));assert.equal(fields.get("client_id"),installedClient.clientId);assert.ok(fields.get("client_secret")===installedClient.clientSecret);
   return Response.json({token_type:"Bearer",access_token:"fixture-access",refresh_token:"fixture-refresh",expires_in:3600});
  }
  if(u.includes("/userinfo?"))return Response.json({id:"123",email:"private@example.test"});
  assert.ok(u.startsWith(BASE)); assert.match(new Headers(init?.headers).get("user-agent")!,/antigravity\/hub/);
  const body=JSON.parse(String(init?.body));
  if(u.endsWith(":loadCodeAssist")){assert.deepEqual(body,{metadata:{ideType:"ANTIGRAVITY"}});return Response.json(onboarding?{allowedTiers:[{id:"free-tier",isDefault:true}]}:{cloudaicompanionProject:{id:"fixture-project"}});}
  if(u.endsWith(":onboardUser")){assert.ok(consented);assert.equal(body.tier_id,"free-tier");assert.equal(body.metadata.ide_type,"ANTIGRAVITY");assert.equal(body.tierId,undefined);return Response.json({done:true,response:{cloudaicompanionProject:{id:"fixture-project"}}});}
  assert.equal(u,`${BASE}/v1internal:fetchAvailableModels`);assert.deepEqual(body,{project:"fixture-project"});return Response.json(catalog);
 }) as typeof fetch});
 assert.deepEqual(provider.getModels(),[]);
 const c=await provider.auth.oauth!.login({signal:new AbortController().signal,notify(e){if(e.type==="auth_url")state=new URL(e.url).searchParams.get("state")!;},async prompt(p){if(p.type==="manual_code")return `${REDIRECT}?code=fixture&state=${state}`;if(p.message.startsWith("Initialize"))consented=true;return "yes";}});
 assert.equal(c.accountId,"google:123");assert.equal(c.projectId,"fixture-project");assert.equal(c.antigravityVersion,1);
 assert.equal(c.email,undefined);assert.equal(provider.getModels().length,2);
 assert.equal(provider.filterModels!([],c).length,2);
 assert.equal(provider.filterModels!([],{...c,accountId:"google:999"}).length,0);
 assert.ok(calls.every(u=>!u.startsWith("https://cloudcode-pa.googleapis.com")));
 const auth=await provider.auth.oauth!.toAuth(c);assert.equal(auth.baseUrl,BASE);assert.equal(auth.headers?.[PROJECT_HEADER],"fixture-project");
});

for(const modelId of ["gemini-4-argon-high","claude-opus-4-6-thinking"])test(`native signed tool/result/final round trip: ${modelId}`,async()=>{
 const bodies:any[]=[];
 const p=antigravityProvider({credential,fetch:(async(url,init)=>{
  assert.equal(url,STREAM);const body=JSON.parse(String(init?.body));bodies.push(body);
  assert.equal(body.project,"fixture-project");assert.equal(body.model,modelId);assert.equal(body.requestType,"agent");
  assert.deepEqual(body.enabled_credit_types,[]);assert.equal(body.request.enabledCreditTypes,undefined);assert.equal(body.request.enabled_credit_types,undefined);
  assert.equal(body.request.systemInstruction.role,"user");assert.ok(body.request.tools[0].functionDeclarations[0].parameters);
  assert.equal(new Headers(init?.headers).get(PROJECT_HEADER),null);
  const first=bodies.length===1;
  const frame={response:{candidates:[{content:{parts:first?[{functionCall:{name:"probe",args:{value:"ok"},id:"call_fixture"},thoughtSignature:"c2lnbmF0dXJl"}]:[{text:"DONE"}]},finishReason:"STOP"}]}};
  return new Response(`data: ${JSON.stringify(frame)}\n\n`);
 }) as typeof fetch});
 const m=p.getModels().find(m=>m.id===modelId)!;
 const ctx:any={messages:[{role:"system",content:"fixture",timestamp:0,toolsAdded:[{name:"probe",description:"fixture",parameters:{type:"object",properties:{value:{type:"string"}},required:["value"]}}]},{role:"user",content:"probe",timestamp:1}]};
 const opts={apiKey:credential.access,headers:{[PROJECT_HEADER]:credential.projectId},sessionId:"test-session",reasoning:"high" as const};
 const first=await p.streamSimple(m,ctx,opts).result();assert.equal(first.stopReason,"toolUse",first.errorMessage);
 const tool:any=first.content.find(x=>x.type==="toolCall");assert.equal(tool.thoughtSignature,"c2lnbmF0dXJl");
 ctx.messages.push(first,{role:"toolResult",toolCallId:tool.id,toolName:"probe",content:[{type:"text",text:"RESULT"}],isError:false,timestamp:2});
 const second=await p.streamSimple(m,ctx,opts).result();assert.equal(second.stopReason,"stop",second.errorMessage);
 assert.match(JSON.stringify(bodies[1]),/RESULT/);assert.match(JSON.stringify(bodies[1]),/c2lnbmF0dXJl/);assert.equal(bodies.length,2);
});

test("catalog keeps distinct per-model quota; no family buckets or private payload",()=>{
 const data=structuredClone(catalog) as any;data.models["gemini-3.8-flash"]={maxTokens:100000,quotaInfo:{remainingFraction:.1},systemPrompt:"PRIVATE"};
 const result=parseCatalog(data);assert.equal(result.length,3);assert.deepEqual(result.map(x=>x.remaining),[.8,.3,.1]);assert.ok(!JSON.stringify(result).includes("PRIVATE"));
 data.agentModelSorts=[{groups:[{modelIds:["gemini-4-argon-high"]}]}];assert.deepEqual(parseCatalog(data).map(x=>x.id),["gemini-4-argon-high"]);
});

test("exhausted protobuf quota defaults to zero only inside valid quotaInfo",()=>{
 const value=structuredClone(catalog) as any,model=value.models["gemini-4-argon-high"];
 delete model.quotaInfo.remainingFraction;
 assert.equal(parseCatalog(value)[0].remaining,0);
 model.quotaInfo.remainingFraction=null;assert.equal(parseCatalog(value)[0].remaining,undefined);
 delete model.quotaInfo;assert.equal(parseCatalog(value)[0].remaining,undefined);
 model.quotaInfo={resetTime:"invalid"};assert.equal(parseCatalog(value)[0].remaining,undefined);
});

test("zero quota and unknown account model prevent inference without paid fallback",async()=>{
 const c={...credential,catalog:credential.catalog.map(x=>({...x,remaining:0}))};let calls=0;
 const p=antigravityProvider({credential:c,fetch:(async()=>{calls++;throw new Error("unexpected");}) as typeof fetch});
 const m=p.getModels()[0],ctx:any={messages:[{role:"user",content:"x",timestamp:1}]};
 const result=await p.streamSimple(m,ctx,{apiKey:c.access,headers:{[PROJECT_HEADER]:c.projectId}}).result();
 assert.equal(result.stopReason,"error");assert.match(result.errorMessage!,/quota exhausted/);assert.equal(calls,0);
 const result2=await p.streamSimple({...m,id:"gemini-not-advertised"},ctx,{apiKey:c.access,headers:{[PROJECT_HEADER]:c.projectId}}).result();
 assert.match(result2.errorMessage!,/not in this account/);assert.equal(calls,0);
});

test("catalog refresh preserves account scope and cannot publish over a newer credential",async()=>{
 let release!:(v:Response)=>void;
 const p=antigravityProvider({credential,fetch:(async()=>new Promise<Response>(r=>{release=r;})) as typeof fetch});
 const pending=p.refreshModels!({credential,allowNetwork:true,signal:new AbortController().signal,async publish(x){x.update?.();return true;}});
 await new Promise(r=>setImmediate(r));
 await p.auth.oauth!.toAuth({...credential,accountId:"google:456",access:"other-access",refresh:"other-refresh",projectId:"other-project",catalog:[]});
 release(Response.json(catalog));await assert.rejects(pending,/changed/);
 assert.deepEqual(p.getModels(),[]);
});

test("stale catalogue refresh and refreshed OAuth retain exact slot binding",async()=>{
 let calls=0;
 const p=antigravityProvider({credential:{...credential,catalogAt:0},fetch:(async url=>{
  calls++;assert.equal(url,`${BASE}/v1internal:fetchAvailableModels`);return Response.json(catalog);
 }) as typeof fetch});
 await p.refreshModels!({credential,allowNetwork:true,signal:new AbortController().signal,async publish(x){x.update?.();return true;}});
 assert.equal(calls,1);assert.equal(p.getModels().length,2);
 const bad=await p.streamSimple(p.getModels()[0],{messages:[]} as any,{apiKey:"other-access",headers:{[PROJECT_HEADER]:credential.projectId}}).result();
 assert.match(bad.errorMessage!,/does not match/);assert.equal(calls,1);
});

test("payload hooks cannot enable AI credit overages",async()=>{
 let calls=0;const p=antigravityProvider({credential,fetch:(async()=>{calls++;throw new Error("unexpected");}) as typeof fetch});
 const result=await p.streamSimple(p.getModels()[0],{messages:[]} as any,{apiKey:credential.access,headers:{[PROJECT_HEADER]:credential.projectId},onPayload:()=>({enabled_credit_types:["GOOGLE_ONE_AI"]})}).result();
 assert.match(result.errorMessage!,/credit overages/);assert.equal(calls,0);
});

for(const op of [{done:true,response:{cloudaicompanionProject:{}}},{done:false},{done:true,error:{message:"PRIVATE"}}]) test(`setup never fabricates a project or repeats POST: ${JSON.stringify(op)}`,async()=>{
 const calls:string[]=[];let state="";
 const p=antigravityProvider({fetch:(async url=>{
  const u=String(url);calls.push(u);
  if(u.includes("/token"))return Response.json({token_type:"Bearer",access_token:"fixture-access",refresh_token:"fixture-refresh",expires_in:3600});
  if(u.includes("/userinfo?"))return Response.json({id:"123"});
  if(u.endsWith(":loadCodeAssist"))return Response.json({allowedTiers:[{id:"standard-tier",isDefault:true,userDefinedCloudaicompanionProject:true}]});
  assert.ok(u.endsWith(":onboardUser"));return Response.json(op);
 }) as typeof fetch});
 await assert.rejects(p.auth.oauth!.login({signal:new AbortController().signal,notify(e){if(e.type==="auth_url")state=new URL(e.url).searchParams.get("state")!;},async prompt(q){return q.type==="manual_code"?`${REDIRECT}?state=${state}&code=fixture`:"yes";}}),error=>{
  assert.ok(error instanceof Error);assert.match(error.message,/Antigravity setup/);assert.doesNotMatch(error.message,/PRIVATE/);return true;
 });
 assert.equal(calls.filter(u=>u.endsWith(":onboardUser")).length,1);assert.equal(calls.length,4);assert.deepEqual(p.getModels(),[]);
});

test("declined or cancelled Antigravity login makes no external requests",async()=>{
 let calls=0;const p=antigravityProvider({fetch:(async()=>{calls++;throw new Error("unexpected");}) as typeof fetch});
 await assert.rejects(p.auth.oauth!.login({signal:new AbortController().signal,notify(){},async prompt(){return "no";}}),/cancelled/);
 const c=new AbortController();c.abort();await assert.rejects(p.auth.oauth!.login({signal:c.signal,notify(){},async prompt(){throw new Error("Unexpected prompt");}}));
 assert.equal(calls,0);
});

test("Code Assist credentials are not imported into Antigravity",async()=>{
 const p=antigravityProvider({credential:{...credential,antigravityVersion:undefined}});
 assert.deepEqual(p.getModels(),[]);await assert.rejects(p.auth.oauth!.toAuth({...credential,antigravityVersion:undefined}),/cannot be reused/);
});
