import { randomBytes, createHash } from "node:crypto";
import timers from "node:timers/promises";
import type { OAuthAuth, OAuthCredential, AuthInteraction } from "@earendil-works/pi-ai";
import { callbackCode, listenForGoogleCallback } from "../google-transport/callback.ts";
import { TOKEN_URL, post, jsonResponse, operationSignal, cancellable, record, token } from "../google-transport/http.ts";
import { BASE, VERSION, PROJECT_HEADER, headers, request, project } from "./transport.ts";
import { fetchCatalog } from "./catalog.ts";
import { PUBLIC_INSTALLED_CLIENT, type OAuthClient } from "./oauth-client.ts";
export const REDIRECT = "http://localhost:51121/oauth-callback";
const INFO = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
export function authorization(client: OAuthClient = PUBLIC_INSTALLED_CLIENT) {
 const verifier=randomBytes(64).toString("base64url"),state=randomBytes(32).toString("hex");
 const url=new URL("https://accounts.google.com/o/oauth2/v2/auth");
 url.search=new URLSearchParams({client_id:client.clientId,redirect_uri:REDIRECT,response_type:"code",access_type:"offline",prompt:"consent select_account",state,
  code_challenge_method:"S256",code_challenge:createHash("sha256").update(verifier).digest("base64url"),
  scope:["cloud-platform","userinfo.email","userinfo.profile","cclog","experimentsandconfigs"].map(s=>`https://www.googleapis.com/auth/${s}`).join(" ")}).toString();
 return {verifier,state,url:url.toString()};
}
function extractedProject(value: unknown): string | undefined {
 const id=typeof value==="string"?value:record(value)?value.id:undefined;
 if(id===undefined || id===null || id==="")return undefined;
 return project(typeof id==="string"?id.trim():id);
}
export function requireCredential(c: OAuthCredential): string {
 if(c.type!=="oauth" || c.antigravityVersion!==1)throw new Error("Sign in to google-antigravity; Code Assist credentials cannot be reused");
 if(typeof c.expires!=="number" || !Number.isFinite(c.expires) || c.expires<=0)throw new Error("Invalid Antigravity credential expiry");
 token(c.access);token(c.refresh);return project(c.projectId);
}
async function resolveProject(access:string, interaction:AuthInteraction, signal:AbortSignal, fetchImpl:typeof fetch):Promise<string> {
 const data=await jsonResponse(await request(fetchImpl,`${BASE}/v1internal:loadCodeAssist`,{metadata:{ideType:"ANTIGRAVITY"}},signal,headers(access)),signal);
 if(!record(data))throw new Error("Malformed Antigravity account response");
 const existing=extractedProject(data.cloudaicompanionProject); if(existing)return existing;
 const tiers=Array.isArray(data.allowedTiers)?data.allowedTiers.filter(record):[];
 const defaults=tiers.filter(t=>t.isDefault===true);
 if(defaults.length>1)throw new Error("Ambiguous Antigravity default tiers");
 const tier=defaults[0]??tiers[0]??(record(data.currentTier)?data.currentTier:{id:"free-tier"});
 if(typeof tier.id!=="string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(tier.id))throw new Error("Invalid Antigravity setup tier");
 if(Array.isArray(data.ineligibleTiers) && data.ineligibleTiers.some(t=>record(t)&&t.reasonCode==="VALIDATION_REQUIRED"))throw new Error("Antigravity requires Google account verification; no setup was sent");
 const choice=await cancellable(interaction.prompt({type:"select",signal,message:`Initialize Antigravity access using the server-selected tier ${tier.id}? This changes service enrollment. No Cloud billing setup or subscription purchase is requested.`,options:[{id:"no",label:"Cancel"},{id:"yes",label:"Initialize Antigravity access"}]}),signal);
 if(choice!=="yes")throw new Error("Antigravity setup cancelled");
 let op=await jsonResponse(await request(fetchImpl,`${BASE}/v1internal:onboardUser`,{tier_id:tier.id,metadata:{ide_type:"ANTIGRAVITY",ide_version:VERSION,ide_name:"antigravity"}},signal,headers(access,{},true)),signal);
 const name=record(op)?op.name:undefined;
 for(let i=0;i<12 && record(op)&&op.done!==true&&!op.error;i++) {
  // Never repeat onboarding POST or invent a project after an uncertain response.
  if(typeof name!=="string" || name.length>1024 || !/^(?:[A-Za-z0-9_-]+\/)*operations\/[A-Za-z0-9_-][A-Za-z0-9._~-]*$/.test(name))throw new Error("Antigravity setup is pending without a pollable operation. Check setup in the official app; no onboarding retry was sent.");
  await timers.setTimeout(5000,undefined,{signal});
  const url=`${BASE}/v1internal/${name}`;
  const r=await cancellable(fetchImpl(url,{method:"GET",headers:headers(access),signal,redirect:"error",credentials:"omit"}),signal);
  if(r.redirected || (r.url&&r.url!==url) || r.status>=300&&r.status<400){void r.body?.cancel().catch(()=>{});throw new Error("Antigravity operation redirect rejected");}
  op=await jsonResponse(r,signal);
 }
 if(!record(op)||op.error||op.done!==true||!record(op.response))throw new Error("Antigravity setup failed or remains pending; no credentials saved");
 const id=extractedProject(op.response.cloudaicompanionProject);
 if(!id)throw new Error(`Antigravity setup completed without a project (tier=${tier.id}, userProject=${tier.userDefinedCloudaicompanionProject===true}, projectShape=${typeof op.response.cloudaicompanionProject}). No fallback project was invented.`);
 return id;
}
export function createAntigravityOAuth(fetchImpl:typeof fetch=fetch):OAuthAuth {
 async function exchange(fields:Record<string,string>,signal:AbortSignal,client:OAuthClient,previous?:OAuthCredential):Promise<OAuthCredential> {
  const data=await jsonResponse(await post(fetchImpl,TOKEN_URL,new URLSearchParams({client_id:client.clientId,client_secret:client.clientSecret,...fields}),signal,{"content-type":"application/x-www-form-urlencoded"}),signal);
  if(!record(data)||String(data.token_type).toLowerCase()!=="bearer"||typeof data.expires_in!=="number"||!Number.isFinite(data.expires_in)||data.expires_in<=0||data.expires_in>604800)throw new Error("Malformed Antigravity token response");
  return {...previous,type:"oauth",access:token(data.access_token),refresh:token(data.refresh_token??previous?.refresh),expires:Date.now()+data.expires_in*1000,antigravityVersion:1};
 }
 return {name:"Google Antigravity (unofficial subscription)",isSubscription:true,loginLabel:"Browser sign-in (account suspension risk)",
  async login(interaction) {
   const signal=operationSignal(interaction.signal,300000);signal.throwIfAborted();
   const choice=await cancellable(interaction.prompt({type:"select",signal,message:"Google prohibits third-party Antigravity clients and warns of account suspension. This is an unofficial adapter, not Google-approved. Accept this account risk?",options:[{id:"no",label:"Cancel"},{id:"yes",label:"Accept risk and sign in"}]}),signal);
   if(choice!=="yes")throw new Error("Antigravity login cancelled");
   const client=PUBLIC_INSTALLED_CLIENT,auth=authorization(client), listener=await listenForGoogleCallback(auth.state,signal,51121,REDIRECT),manual=new AbortController();
   let code:string;
   try {
    interaction.notify({type:"auth_url",url:auth.url,instructions:"Sign in with your Antigravity account. The local callback is automatic; remote users can paste the full callback URL."});
    code=await Promise.race([listener.code,cancellable(interaction.prompt({type:"manual_code",signal:AbortSignal.any([signal,manual.signal]),message:"Waiting for Google; alternatively paste the full callback URL:"}),signal).then(v=>callbackCode(v,auth.state,REDIRECT))]);
   } finally {manual.abort();await listener.close();}
   const c=await exchange({grant_type:"authorization_code",code,code_verifier:auth.verifier,redirect_uri:REDIRECT},signal,client);
   const r=await cancellable(fetchImpl(INFO,{headers:{authorization:`Bearer ${c.access}`},signal,redirect:"error",credentials:"omit"}),signal);
   if(r.redirected || (r.url&&r.url!==INFO) || r.status>=300&&r.status<400){void r.body?.cancel().catch(()=>{});throw new Error("Antigravity identity redirect rejected");}
   const identity=await jsonResponse(r,signal);
   if(!record(identity)||typeof identity.id!=="string"||!/^\d{1,64}$/.test(identity.id))throw new Error("Antigravity account identity unavailable; refusing ambiguous account storage");
   const projectId=await resolveProject(c.access,interaction,signal,fetchImpl);
   const catalog=await fetchCatalog(c.access,projectId,signal,fetchImpl);
   if(!catalog.length)throw new Error("Antigravity returned no supported selectable models; no catalog was invented");
   signal.throwIfAborted();
   interaction.notify({type:"info",message:`Antigravity account resolved; ${catalog.length} models discovered. This is not yet a live inference qualification.`});
   return {...c,accountId:`google:${identity.id}`,projectId,catalog,catalogAt:Date.now()};
  },
  async refresh(c,signal){requireCredential(c);const active=operationSignal(signal);active.throwIfAborted();return exchange({grant_type:"refresh_token",refresh_token:c.refresh},active,PUBLIC_INSTALLED_CLIENT,c);},
  async toAuth(c){const id=requireCredential(c);return {apiKey:c.access,baseUrl:BASE,headers:{[PROJECT_HEADER]:id}};},
 };
}
