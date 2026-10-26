import { createHash } from "node:crypto";
import type { Api, Model, OAuthCredential, RefreshModelsContext } from "@earendil-works/pi-ai";
import { createAntigravityStream } from "./stream.ts";
import { operationSignal } from "../google-transport/http.ts";
import { createAntigravityOAuth, requireCredential } from "./oauth.ts";
import { storedCatalog, fetchCatalog, models, type Entry } from "./catalog.ts";
import { ID, PROJECT_HEADER, project } from "./transport.ts";

export function antigravityProvider(options: { id?:string; fetch?:typeof fetch; credential?:OAuthCredential; assertConfiguration?:()=>void } = {}) {
 const id=options.id??ID, fetchImpl=options.fetch??fetch;
 let entries:Entry[]=[],account="",accountProject="",updatedAt=0,requestBinding="",generation=0;
 const binding=(access:string,p:string)=>createHash("sha256").update(`${access}\0${p}`).digest("hex");
 const publish=(c:OAuthCredential,list=storedCatalog(c.catalog),at=typeof c.catalogAt==="number"?c.catalogAt:0)=>{
  requireCredential(c); if(typeof c.accountId!=="string" || !/^google:\d+$/.test(c.accountId))throw new Error("Antigravity account identity missing");
  entries=list;account=c.accountId;accountProject=project(c.projectId);updatedAt=at;requestBinding=binding(c.access,project(c.projectId));generation++;
 };
 if(options.credential?.antigravityVersion===1) {try{publish(options.credential);}catch{/* Invalid stored credentials never create a catalog. */}}
 const oauth=createAntigravityOAuth(fetchImpl), originalLogin=oauth.login.bind(oauth), originalAuth=oauth.toAuth.bind(oauth);
 oauth.toAuth=async c=>{
  const auth=await originalAuth(c);
  const key=binding(c.access,project(c.projectId));
  if(c.accountId!==account || c.projectId!==accountProject) publish(c);
  else if(key!==requestBinding) {requestBinding=key;updatedAt=0;generation++;}
  return auth;
 };
 oauth.login=async(...args:Parameters<typeof originalLogin>)=>{ options.assertConfiguration?.();const c=await originalLogin(...args);args[0].signal.throwIfAborted();publish(c);return c; };
 const provider=createAntigravityStream([], {id,oauth,fetch:fetchImpl,assertConfiguration:options.assertConfiguration,
  async beforeRequest(model,req,signal) {
   const p=project(new Headers(req.headers as HeadersInit).get(PROJECT_HEADER)),key=binding(req.apiKey??"",p);
   if(key!==requestBinding || p!==accountProject)throw new Error("Antigravity request does not match this slot's resolved OAuth credential");
   const now=Date.now();
   if(!updatedAt || now<updatedAt || now-updatedAt>60000) {
    const epoch=++generation;
    const fresh=await fetchCatalog(req.apiKey??"",p,signal,fetchImpl);signal.throwIfAborted();
    if(epoch!==generation)throw new Error("Antigravity account/catalog changed during request preparation");
    entries=fresh;updatedAt=Date.now();requestBinding=key;
   }
   const advertised=entries.find(e=>e.id===model.id);
   if(!advertised)throw new Error("Antigravity model is not in this account's current catalog");
   if(advertised.remaining===0)throw new Error(`Antigravity model quota exhausted: ${model.id}; no credit overage request sent`);
  },
 });
 provider.getModels=()=>models(entries,id);
 provider.filterModels=(_models,c)=>{
  if(c?.type!=="oauth" || c.antigravityVersion!==1 || c.accountId!==account || c.projectId!==accountProject)return [];
  return models(entries,id);
 };
 const allModels = {getAllModels:provider.getModels,filterAllModels:(all:readonly unknown[],c?:Parameters<NonNullable<typeof provider.filterModels>>[1])=>provider.filterModels!(all as Model<Api>[],c)};
 provider.refreshModels=async(ctx:RefreshModelsContext)=>{
  const c=ctx.credential;
  if(c?.type!=="oauth" || c.antigravityVersion!==1) {await ctx.publish({update(){entries=[];account="";accountProject="";updatedAt=0;requestBinding="";generation++;}});return;}
  const p=requireCredential(c);
  if(!ctx.allowNetwork) {await ctx.publish({update(){publish(c);}});return;}
  options.assertConfiguration?.();
  const epoch=++generation;
  const fresh=await fetchCatalog(c.access,p,operationSignal(ctx.signal),fetchImpl);
  if(epoch!==generation)throw new Error("Antigravity credential changed during catalog refresh");
  await ctx.publish({update(){if(epoch===generation)publish(c,fresh,Date.now());}});
 };
 return Object.assign(provider, allModels, { quotaSnapshot:()=>({updatedAt,models:entries.map(e=>({id:e.id,remaining:e.remaining,reset:e.reset}))}) });
}
