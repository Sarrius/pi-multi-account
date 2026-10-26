import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { supportsNativeTranscript } from "../google-transport/native.ts";

test("fresh installation offers Antigravity browser login without config or client file", {timeout:30000}, () => {
 const dir=mkdtempSync(join(tmpdir(),"ag-fresh-install-"));
 try {
  const host=import.meta.resolve("@earendil-works/pi-coding-agent");
  const entry=fileURLToPath(new URL("../index.ts",import.meta.url));
  const script=`
import {DefaultResourceLoader,SettingsManager} from ${JSON.stringify(host)};
let state='',exchanges=0;
globalThis.fetch=async (url,init)=>{
 const u=String(url);
 if(u==='https://oauth2.googleapis.com/token'){
  exchanges++;const form=new URLSearchParams(String(init.body));
  if(!form.get('client_id')||!form.get('client_secret')||!form.get('code_verifier'))throw new Error('missing installed-client/PKCE fields');
  return Response.json({token_type:'Bearer',access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600});
 }
 if(u==='https://www.googleapis.com/oauth2/v1/userinfo?alt=json')return Response.json({id:'123'});
 if(u==='https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist')return Response.json({cloudaicompanionProject:'fixture-project'});
 if(u==='https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels')return Response.json({models:{'gemini-3.8-flash-low':{maxTokens:100000,maxOutputTokens:8192}}});
 throw new Error('unexpected network request');
};
const dir=${JSON.stringify(dir)};
const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:SettingsManager.inMemory(),noExtensions:true,noSkills:true,noPromptTemplates:true,additionalExtensionPaths:[${JSON.stringify(entry)}]});
await loader.reload();const loaded=loader.getExtensions();
if(loaded.errors.length)throw new Error('extension loading failed: '+JSON.stringify(loaded.errors));
const provider=loaded.runtime.pendingNativeProviderRegistrations.find(x=>x.provider.id==='google-antigravity')?.provider;
if(${supportsNativeTranscript}){
 if(!provider)throw new Error('Antigravity login missing on fresh installation');
 const credential=await provider.auth.oauth.login({signal:new AbortController().signal,notify(event){if(event.type==='auth_url')state=new URL(event.url).searchParams.get('state');},async prompt(request){return request.type==='manual_code'?'http://localhost:51121/oauth-callback?code=fixture&state='+state:'yes';}});
 if(credential.accountId!=='google:123'||provider.getModels().length!==1||exchanges!==1)throw new Error('browser login did not complete');
}else if(provider)throw new Error('unsupported host registered Antigravity');
console.log('FRESH_LOGIN_VERIFIED');
`;
  const result=spawnSync(process.execPath,["--input-type=module","-e",script],{cwd:dir,timeout:25000,encoding:"utf8",env:{PATH:process.env.PATH,HOME:dir,PI_CODING_AGENT_DIR:dir,PI_ANTIGRAVITY_OAUTH_CLIENT_FILE:join(dir,"does-not-exist.json")}});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/FRESH_LOGIN_VERIFIED/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
