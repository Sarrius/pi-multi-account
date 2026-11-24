import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { googleBrowserCommand, persistGoogleConnection, registerGoogleConnection } from '../google-connect.ts';

const credential = {type:'oauth',accountId:'google:123',access:'fixture-access',refresh:'fixture-refresh',expires:Date.now()+3600000,antigravityVersion:1};
function fixture(login?: (interaction: any) => Promise<any>) {
 const dir=mkdtempSync(join(tmpdir(),'google-connect-flow-'));
 const authPath=join(dir,'auth.json'), sidecarPath=join(dir,'sidecar.json');
 const notices:string[]=[], launches:any[]=[], refreshes:any[]=[], hooks = new Map<string, any>();
 let handler:any;
 const provider={auth:{oauth:{login: login ?? (async interaction => {
  const choice = await interaction.prompt({type:'select', message:'Explicit risk consent',options:[{id:'no',label:'Cancel'},{id:'yes',label:'Accept risk'}]});
  assert.equal(choice,'yes');
  interaction.notify({type:'auth_url',url:'https://accounts.google.com/o/oauth2/v2/auth?state=fixture'});
  return credential;
 })}},quotaSnapshot:()=>({updatedAt:1000,models:[{id:'fixture-model',remaining:undefined}]})};
 const providers = new Map([['google-antigravity',provider]]);
 const pi:any={registerCommand(name:string, command:any){assert.equal(name,'google'); handler=command.handler;},on(name:string,fn:any){hooks.set(name,fn);},async exec(command:string,argv:string[]){launches.push([command,argv]);return {code:0};}};
 const ctx:any={hasUI:true,ui:{notify(message:string){notices.push(message);},async select(){return 'Accept risk';},async input(){return undefined;}},modelRegistry:{async refresh(opts:any){refreshes.push(opts);return {errors:new Map()};}}};
 registerGoogleConnection(pi,{authPath,sidecarPath,accounts:()=>existsSync(authPath)?JSON.parse(readFileSync(authPath,'utf8')):{},providers:()=>providers as any});
 return {dir,authPath,sidecarPath,notices,launches,refreshes,ctx,handler,hooks,cleanup(){rmSync(dir,{recursive:true,force:true});}};
}

test('connection uses the normal browser, preserves risk consent, persists once and refreshes only its service',async()=>{
 const f=fixture();try {
  await f.handler('connect',f.ctx);
  assert.equal(f.launches.length,1);
  assert.deepEqual(f.launches[0],googleBrowserCommand('https://accounts.google.com/o/oauth2/v2/auth?state=fixture'));
  assert.deepEqual(JSON.parse(readFileSync(f.authPath,'utf8')),{'google-antigravity':credential});
  assert.equal(f.refreshes.length,1);assert.deepEqual(f.refreshes[0].providers,['google-antigravity']);assert.equal(f.refreshes[0].allowNetwork,false);
  assert.ok(f.notices.some(n=>n.includes('AI Studio web allowance: not connected')));
  assert.ok(f.notices.some(n=>n.includes('remaining quota unknown')));
 }finally{f.cleanup();}
});

test('cancelled UI never saves credentials or launches another browser',async()=>{
 const f=fixture();try{f.ctx.ui.select=async()=>undefined;await f.handler('connect',f.ctx);assert.equal(existsSync(f.authPath),false);assert.deepEqual(f.launches,[]);}finally{f.cleanup();}
});

test('out-of-band callback cancellation closes the manual prompt without cancelling successful login',async()=>{
 const f=fixture(async interaction=>{
  const manual=new AbortController();
  const pending=interaction.prompt({type:'manual_code',message:'Waiting for browser',signal:manual.signal});
  manual.abort(); await assert.rejects(pending);
  assert.equal(interaction.signal.aborted,false);
  return credential;
 });
 try{f.ctx.ui.input=async (_title:string,_placeholder:string,opts:any)=>new Promise(resolve=>{if(opts.signal.aborted)resolve(undefined);else opts.signal.addEventListener('abort',()=>resolve(undefined),{once:true});});await f.handler('connect',f.ctx);assert.equal(existsSync(f.authPath),true);}finally{f.cleanup();}
});

test('shutdown cancels and joins login; parallel connect never opens a second flow',async()=>{
 let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
 const f=fixture(async interaction=>{entered();await new Promise<void>(r=>interaction.signal.addEventListener('abort',()=>r(),{once:true}));return credential;});
 try{const work=f.handler('connect',f.ctx);await ready;await f.handler('connect',f.ctx);await f.hooks.get('session_shutdown')();await work;assert.equal(existsSync(f.authPath),false);assert.ok(f.notices.some(n=>n.includes('already in progress')));}finally{f.cleanup();}
});

test('headless sign-in does not request input, open browser or mutate storage',async()=>{
 const f=fixture();try{f.ctx.hasUI=false;await f.handler('connect',f.ctx);assert.equal(existsSync(f.authPath),false);assert.deepEqual(f.launches,[]);}finally{f.cleanup();}
});

test('normal browser commands do not use a shell, automation flags or a new profile',()=>{
 const url='https://accounts.google.com/o/oauth2/v2/auth?state=fixture&code_challenge=fixture';
 for(const platform of ['darwin','linux','win32'] as const){const [cmd,args]=googleBrowserCommand(url,platform);assert.ok(!['sh','bash','cmd.exe'].includes(cmd));assert.equal(args.at(-1),url);assert.ok(!args.some(a=>a.startsWith('--')));}
 for(const url of ['http://accounts.google.com/o/oauth2/v2/auth','https://accounts.google.com.evil.test/o/oauth2/v2/auth','https://other.test/','https://accounts.google.com/o/oauth2/v2/auth#fragment'])assert.throws(()=>googleBrowserCommand(url));
});

test('duplicate account in shadow storage cannot create another slot; unrelated credentials survive',async()=>{
 const f=fixture();try{
  const other={'other-provider':{type:'api_key',key:'fixture-key'}};
  writeFileSync(f.authPath,JSON.stringify(other));writeFileSync(f.sidecarPath,JSON.stringify({'google-antigravity-account-2':credential}));
  await assert.rejects(persistGoogleConnection(f.authPath,f.sidecarPath,'google-antigravity',credential as any,new AbortController().signal),/already connected/);
  assert.deepEqual(JSON.parse(readFileSync(f.authPath,'utf8')),other);
  assert.deepEqual(JSON.parse(readFileSync(f.sidecarPath,'utf8')),{'google-antigravity-account-2':credential});
 }finally{f.cleanup();}
});

test('concurrent same-account connections have exactly one persisted winner',async()=>{
 const f=fixture();try{
  const outcomes=await Promise.allSettled(['google-antigravity','google-antigravity-account-2'].map(id=>persistGoogleConnection(f.authPath,f.sidecarPath,id,credential as any,new AbortController().signal)));
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(Object.keys(JSON.parse(readFileSync(f.authPath,'utf8'))).length,1);
 }finally{f.cleanup();}
});

test('shutdown joins refresh without publishing into the retired UI',async()=>{
 let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
 const f=fixture();try{
  writeFileSync(f.authPath,JSON.stringify({'google-antigravity':credential}));
  f.ctx.modelRegistry.refresh=async({signal}:any)=>{entered();await new Promise<void>(r=>signal.addEventListener('abort',()=>r(),{once:true}));return {errors:new Map()};};
  const work=f.handler('refresh',f.ctx);await ready;await f.hooks.get('session_shutdown')();await work;
  assert.deepEqual(f.notices,[]);
 }finally{f.cleanup();}
});

test('refresh never touches unrelated or unconnected providers',async()=>{
 const f=fixture();try{writeFileSync(f.authPath,JSON.stringify({'google-antigravity':credential,'google':{type:'api_key',key:'fixture-key'}}));await f.handler('refresh',f.ctx);assert.deepEqual(f.refreshes[0].providers,['google-antigravity']);assert.equal(f.refreshes[0].allowNetwork,true);assert.deepEqual(f.launches,[]);}finally{f.cleanup();}
});
