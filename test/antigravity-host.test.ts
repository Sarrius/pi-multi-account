import assert from "node:assert/strict";
import { mkdtempSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import nodeTest from "node:test";
import { supportsNativeTranscript } from "../google-transport/native.ts";
const test = supportsNativeTranscript ? nodeTest : nodeTest.skip;
import * as NativeHost from "@earendil-works/pi-coding-agent";
for(const bundled of [false,true])test(`Antigravity account catalog and stream through real ${bundled?"bundled":"node"} Pi loader`,async()=>{
 const host=bundled?await import(new URL("./bundle/index.js",import.meta.resolve("@earendil-works/pi-coding-agent")).href) as typeof NativeHost:NativeHost;
 const dir=mkdtempSync(join(tmpdir(),"ag-host-"));
 try{
  const path=fileURLToPath(new URL("../antigravity/provider.ts",import.meta.url)),entry=join(dir,"fixture.ts");
  const c={type:"oauth",access:"synthetic-access",refresh:"synthetic-refresh",expires:Date.now()+3600000,antigravityVersion:1,accountId:"google:123",projectId:"fixture-project",catalogAt:Date.now(),catalog:[{id:"gemini-4-argon-high",name:"fixture",context:1000000,output:65536,thinking:true,images:false,remaining:1}]};
  writeFileSync(entry,`import {antigravityProvider} from ${JSON.stringify(path)};
export default function(pi){pi.registerProvider(antigravityProvider({id:"google-antigravity-account-2",credential:${JSON.stringify(c)},fetch:async(url,init)=>{
if(String(url)!=="https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse")throw new Error("Foreign destination");
const body=JSON.parse(init.body);if(body.project!=="fixture-project"||body.enabled_credit_types.length!==0)throw new Error("Wrong binding");
return new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"OK"}]},"finishReason":"STOP"}]}}\\n\\n');}}));}`);
  const loader=new host.DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:host.SettingsManager.inMemory(),noExtensions:true,noSkills:true,noPromptTemplates:true,additionalExtensionPaths:[entry]});
  await loader.reload();const loaded=loader.getExtensions();assert.deepEqual(loaded.errors,[]);
  const p=loaded.runtime.pendingNativeProviderRegistrations[0]?.provider;assert.ok(p);
  assert.equal(p.id,"google-antigravity-account-2");assert.equal(p.auth.apiKey,undefined);
  assert.equal(p.getModels()[0].id,"gemini-4-argon-high");
  const opts=await p.auth.oauth!.toAuth(c as any);
  const result=await p.streamSimple(p.getModels()[0],{messages:[{role:"user",content:"fixture",timestamp:1}]} as any,opts).result();
  assert.equal(result.stopReason,"stop",result.errorMessage);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
