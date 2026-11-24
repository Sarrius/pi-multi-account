import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest from "node:test";
import * as NativeHost from "@earendil-works/pi-coding-agent";
import { supportsNativeTranscript } from "../google-transport/native.ts";

const test = supportsNativeTranscript ? nodeTest : nodeTest.skip;
for (const bundled of [false, true]) for (const stalePeer of [false, true]) {
 test(`Antigravity tool/result round trip through ${bundled ? "bundled" : "node"} Pi with ${stalePeer ? "stale nested" : "no local"} pi-ai`, async () => {
  const host = bundled ? await import(new URL("./bundle/index.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as typeof NativeHost : NativeHost;
  const dir = mkdtempSync(join(tmpdir(), "ag-host-"));
  try {
   // #117: managed installs don't contain the host's peers. Importing from the
   // repository directly would let import.meta.resolve find its devDependency.
   for (const name of ["antigravity", "google-transport"]) cpSync(new URL(`../${name}/`, import.meta.url), join(dir, name), {recursive: true});
   if (stalePeer) {
    const nested = join(dir, "node_modules/@earendil-works/pi-ai");
    mkdirSync(join(nested, "api"), {recursive:true});
    writeFileSync(join(nested, "package.json"), JSON.stringify({name:"@earendil-works/pi-ai", type:"module", exports:{"./compat":"./compat.js"}}));
    writeFileSync(join(nested, "compat.js"), "export {};");
    writeFileSync(join(nested, "api/google-shared.js"), 'throw new Error("STALE_EXTENSION_PEER");');
   }
   const entry = join(dir,"fixture.ts");
   const credential = {type:"oauth",access:"synthetic-access",refresh:"synthetic-refresh",expires:Date.now()+3600000,antigravityVersion:1,accountId:"google:123",projectId:"fixture-project",catalogAt:Date.now(),catalog:[{id:"gemini-4-argon-high",name:"fixture",context:1000000,output:65536,thinking:true,images:false,remaining:1}]};
   writeFileSync(entry,`import {antigravityProvider} from './antigravity/provider.ts';
export default function(pi){let count=0;pi.registerProvider(antigravityProvider({id:"google-antigravity-account-2",credential:${JSON.stringify(credential)},fetch:async(url,init)=>{
 if(String(url)!=="https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse")throw new Error("Foreign destination");
 const body=JSON.parse(init.body);if(body.project!=="fixture-project"||body.enabled_credit_types.length!==0)throw new Error("Wrong binding");
 const fn=body.request.tools[0].functionDeclarations[0];if(fn.name!=="probe"||!fn.parameters.properties.value)throw new Error("Missing tool schema");
 const first=++count===1;if(!first && !JSON.stringify(body.request.contents).includes("RESULT_MARKER"))throw new Error("Missing replay");
 const parts=first?[{functionCall:{id:"call_fixture",name:"probe",args:{value:"ok"}},thoughtSignature:"c2ln"}]:[{text:"DONE"}];
 return new Response('data: '+JSON.stringify({response:{candidates:[{content:{parts},finishReason:"STOP"}]}})+'\\n\\n');}}));}`);
   const loader = new host.DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:host.SettingsManager.inMemory(),noExtensions:true,noSkills:true,noPromptTemplates:true,additionalExtensionPaths:[entry]});
   await loader.reload();const loaded=loader.getExtensions();assert.deepEqual(loaded.errors,[]);
   const p=loaded.runtime.pendingNativeProviderRegistrations[0]?.provider;assert.ok(p);
   assert.equal(p.id,"google-antigravity-account-2"); assert.equal(p.auth.apiKey,undefined);
   const model=p.getModels()[0];assert.equal(model.id,"gemini-4-argon-high");
   const opts={...await p.auth.oauth!.toAuth(credential as any),sessionId:"host-fixture"};
   const ctx:any={messages:[{role:"system",content:"fixture",timestamp:0,toolsAdded:[{name:"probe",description:"fixture",parameters:{type:"object",properties:{value:{type:"string"}},required:["value"]}}]},{role:"user",content:"use probe",timestamp:1}]};
   const first=await p.streamSimple(model,ctx,opts).result();assert.equal(first.stopReason,"toolUse",first.errorMessage);
   const call=first.content.find(b=>b.type==="toolCall");assert.ok(call && call.type==="toolCall"); assert.equal(call.name,"probe"); assert.deepEqual(call.arguments,{value:"ok"});
   ctx.messages.push(first,{role:"toolResult",toolCallId:call.id,toolName:call.name,content:[{type:"text",text:"RESULT_MARKER"}],isError:false,timestamp:2});
   const final=await p.streamSimple(model,ctx,opts).result();assert.equal(final.stopReason,"stop",final.errorMessage);assert.deepEqual(final.content.map(b=>b.type==="text" ? b.text : undefined),["DONE"]);
  } finally {rmSync(dir,{recursive:true,force:true});}
 });
}
