import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { supportsNativeTranscript } from '../google-transport/native.ts';

for(const bundled of [false,true]) test(`Google command through real ${bundled?'bundled':'node'} host: callback, storage, picker`,{skip:!supportsNativeTranscript || process.platform==='win32',timeout:30000},()=>{
 const dir=mkdtempSync(join(tmpdir(),'google-connect-host-'));
 try{
  const bin=join(dir,'bin');mkdirSync(bin);
  const launcher=`#!${process.execPath}\nconst fs=require('node:fs'),http=require('node:http');const args=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(join(dir,'opened.json'))},JSON.stringify(args));const u=new URL(args[0]);http.get('http://localhost:51121/oauth-callback?code=fixture&state='+encodeURIComponent(u.searchParams.get('state')),r=>{r.resume();r.on('end',()=>process.exit(r.statusCode===200?0:1));}).on('error',()=>process.exit(1));\n`;
  for(const command of ['open','xdg-open'])writeFileSync(join(bin,command),launcher,{mode:0o755});
  const host=bundled?new URL('./bundle/index.js',import.meta.resolve('@earendil-works/pi-coding-agent')).href:import.meta.resolve('@earendil-works/pi-coding-agent');
  const entry=fileURLToPath(new URL('../index.ts',import.meta.url));
  const script=`
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {DefaultResourceLoader,SettingsManager,ModelRuntime,ModelRegistry} from ${JSON.stringify(host)};
const dir=${JSON.stringify(dir)};let calls=[];
globalThis.fetch=async(url,init)=>{
 const u=String(url);calls.push(u);
 if(u==='https://oauth2.googleapis.com/token')return Response.json({token_type:'Bearer',access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:3600});
 if(u==='https://www.googleapis.com/oauth2/v1/userinfo?alt=json')return Response.json({id:'123'});
 if(u==='https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist')return Response.json({cloudaicompanionProject:'fixture-project'});
 if(u==='https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels')return Response.json({models:{'gemini-4-carbon':{maxTokens:100000,maxOutputTokens:8192}}});
 throw new Error('Unexpected external request');
};
const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:SettingsManager.inMemory(),noExtensions:true,noSkills:true,noPromptTemplates:true,additionalExtensionPaths:[${JSON.stringify(entry)}]});
await loader.reload();const loaded=loader.getExtensions();assert.deepEqual(loaded.errors,[]);
const runtime=await ModelRuntime.create({authPath:dir+'/auth.json',modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
for(const {provider} of loaded.runtime.pendingNativeProviderRegistrations)runtime.registerNativeProvider(provider);
const command=loaded.extensions.flatMap(e=>[...e.commands.values()]).find(c=>c.name==='google');assert.ok(command);
const notices=[];
await command.handler('connect',{hasUI:true,modelRegistry:new ModelRegistry(runtime),ui:{notify(m){notices.push(m);},async select(_title,options){return options.find(x=>x==='Accept risk and sign in');},async input(_title,_placeholder,{signal}){return new Promise(resolve=>{if(signal.aborted)resolve(undefined);else signal.addEventListener('abort',()=>resolve(undefined),{once:true});});}}});
const auth=JSON.parse(readFileSync(dir+'/auth.json','utf8'));assert.equal(auth['google-antigravity'].accountId,'google:123');
assert.equal(calls.filter(u=>u==='https://oauth2.googleapis.com/token').length,1);
const available=await runtime.getAvailable('google-antigravity');assert.ok(available.some(m=>m.id==='gemini-4-carbon'));
const args=JSON.parse(readFileSync(dir+'/opened.json','utf8'));assert.equal(args.length,1);assert.equal(new URL(args[0]).hostname,'accounts.google.com');
assert.ok(notices.some(m=>m.includes('AI Studio web allowance: not connected')));
console.log('GOOGLE_CONNECTION_VERIFIED');
`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:dir,timeout:25000,encoding:'utf8',env:{PATH:bin+':'+process.env.PATH,HOME:dir,PI_CODING_AGENT_DIR:dir}});
  assert.equal(result.status,0,result.stderr+'\n'+result.stdout);assert.match(result.stdout,/GOOGLE_CONNECTION_VERIFIED/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
