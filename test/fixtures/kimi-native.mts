import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as sdk from '@earendil-works/pi-coding-agent';
const cwd=process.cwd(),agentDir=process.env.PI_CODING_AGENT_DIR!;
mkdirSync(agentDir,{recursive:false,mode:0o700});
const base='kimi-coding',alias='kimi-coding-account-2',id='k3.1-pro';
const path=(n:string)=>join(agentDir,n);
writeFileSync(path('auth.json'),JSON.stringify({[base]:{type:'api_key',key:'fixture-base'},[alias]:{type:'api_key',key:'fixture-alias'}}));
writeFileSync(path('provider-failover.json'),JSON.stringify({enabled:true,autoContinue:false,contextGuard:false,onlyActiveModels:false,childProxy:false,showUsage:false,autoDiscoverModels:false,antigravitySubscription:false,includeCursor:false}));
let attempts=0,account='',foreign=0;
globalThis.fetch=(async(input:any,init:any)=>{
 const req=new Request(input,init);
 if (req.url!=='https://api.kimi.com/coding/v1/chat/completions') {foreign++;throw Error('unexpected external destination');}
 attempts++;account=req.headers.get('authorization') ?? '';assert.equal((await req.json()).model,id);
 return Response.json({error:{message:'exceeded_current_quota_error',type:'exceeded_current_quota_error'}},{status:429,headers:{'retry-after':'120'}});
}) as typeof fetch;
const settingsManager=sdk.SettingsManager.inMemory({packages:[],compaction:{enabled:false,keepRecentTokens:1,reserveTokens:1024},retry:{enabled:false},providerRetry:{maxRetries:0},cacheWarming:'off'} as any);
const runtime=await sdk.ModelRuntime.create({authPath:path('auth.json'),modelsPath:path('models.json'),refreshOnCreate:false});
const resourceLoader=new sdk.DefaultResourceLoader({cwd,agentDir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,additionalExtensionPaths:[fileURLToPath(new URL('../../index.ts',import.meta.url))]});
await resourceLoader.reload();assert.deepEqual(resourceLoader.getExtensions().errors,[]);
const before=runtime.getModel(base,id)!;assert.ok(before);const baseIds=runtime.getModels(base).map(m=>m.id).sort();
const sessionManager=sdk.SessionManager.inMemory(cwd);
const {session}=await sdk.createAgentSession({cwd,agentDir,modelRuntime:runtime,settingsManager,resourceLoader,sessionManager,model:runtime.getModel(base,id),tools:[]});
try {
 const errors:any[]=[];await session.bindExtensions({mode:'rpc',onError:e=>errors.push(e)});assert.deepEqual(errors,[]);
 const a=runtime.getModel(base,id)!,b=runtime.getModel(alias,id)!;assert.ok(a&&b,'factory registered the numbered Pro model');
 assert.deepEqual(runtime.getModels(base).map(m=>m.id).sort(),baseIds,'base catalog is not replaced');assert.deepEqual(a,before);
 for(const field of ['id','api','baseUrl','contextWindow','maxTokens','input','cost'] as const)assert.deepEqual(b[field],a[field],`alias ${field}`);
 assert.equal(typeof runtime.getProvider(alias)?.auth?.oauth?.login,'function');
 await session.setModel(a);
 for(let i=0;i<4;i++) sessionManager.appendMessage({role:'user',content:('synthetic history '+i+' ').repeat(100),timestamp:i+1});
 await assert.rejects(session.compact(),/429|exceeded_current_quota_error/i);
 assert.ok(attempts>=1 && attempts<=3,`native attempts: ${attempts}`);assert.equal(account,'Bearer fixture-base');
 const state=JSON.parse(readFileSync(path('provider-failover-state.json'),'utf8'));assert.ok(state.limitRefusalByProvider?.[base]?.retryAt>Date.now(),'stock failure must persist the actual account cooldown');assert.equal(state.limitRefusalByProvider?.[alias],undefined);assert.equal(sessionManager.getEntries().some(e=>e.type==='compaction'),false);assert.equal(foreign,0,'unexpected fetch');console.log('KIMI_NATIVE_OK');
} finally {await session.extensionRunner.emit({type:'session_shutdown',reason:'shutdown'});session.dispose();}
