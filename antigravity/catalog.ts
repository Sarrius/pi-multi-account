import type { Model, Api } from "@earendil-works/pi-ai";
import { jsonResponse, record } from "../google-transport/http.ts";
import { BASE, ID, headers, request } from "./transport.ts";
export interface Entry { id: string; name: string; context: number; output: number; images: boolean; thinking: boolean; remaining?: number; reset?: string }
const integer = (x: unknown) => typeof x === "number" && Number.isSafeInteger(x) && x > 0 && x <= 10000000;
/** Whitelist public model/quota fields; never retain server prompts/experiments. */
export function parseCatalog(data: unknown): Entry[] {
 if (!record(data) || !record(data.models) || Object.keys(data.models).length>2048) throw new Error("Invalid Antigravity model catalog");
 const visible = new Set<string>();
 if (Array.isArray(data.agentModelSorts)) for(const sort of data.agentModelSorts) {
  if(record(sort) && Array.isArray(sort.groups)) for(const group of sort.groups) {
   if(record(group) && Array.isArray(group.modelIds)) for(const id of group.modelIds) if(typeof id==="string") visible.add(id);
  }
 }
 if(visible.size && record(data.tieredModelIds)) for(const ids of Object.values(data.tieredModelIds)) if(Array.isArray(ids)) for(const id of ids) if(typeof id==="string") visible.add(id);
 const entries: Entry[]=[];
 for(const [id,m] of Object.entries(data.models)) {
  if(!record(m) || m.disabled===true || !/^(gemini-|claude-|gpt-oss-)[a-zA-Z0-9._-]+$/.test(id) || id.length>160 || /image|imagen|-(disabled|tiered)$/.test(id) || (visible.size && !visible.has(id))) continue;
  if(!integer(m.maxTokens)) continue; // Do not inherit an unrelated API's context limits.
  const q=record(m.quotaInfo)?m.quotaInfo:{};
  const reset=typeof q.resetTime==="string" && Number.isFinite(Date.parse(q.resetTime))?new Date(q.resetTime).toISOString():undefined;
  // This service omits the protobuf numeric default (zero) in exhausted quotaInfo.
  // Require a valid quota reset; absent quotaInfo and malformed/null fractions stay unknown.
  const remaining=typeof q.remainingFraction==="number" && Number.isFinite(q.remainingFraction) && q.remainingFraction>=0 && q.remainingFraction<=1?q.remainingFraction:
   (!Object.hasOwn(q,"remainingFraction") && reset!==undefined ? 0 : undefined);
  entries.push({id,name:typeof m.displayName==="string"?m.displayName.replace(/[\x00-\x1f\x7f]/g,"").slice(0,200):id,
   context:m.maxTokens as number,output:integer(m.maxOutputTokens)?Math.min(m.maxOutputTokens as number,m.maxTokens as number):Math.min(8192,m.maxTokens as number),
   images:m.supportsImages===true,thinking:m.supportsThinking===true,remaining,reset});
 }
 return entries;
}
export async function fetchCatalog(access: string, project: string, signal: AbortSignal, fetchImpl: typeof fetch): Promise<Entry[]> {
 const response=await request(fetchImpl,`${BASE}/v1internal:fetchAvailableModels`,{project},signal,headers(access));
 return parseCatalog(await jsonResponse(response,signal,2*1024*1024));
}
export function models(entries: Entry[], provider: string): Model<Api>[] {
 return entries.map(e=>({id:e.id,name:e.name,provider,api:ID,baseUrl:BASE,reasoning:e.thinking,
  input:e.images?["text","image"]:["text"],contextWindow:e.context,maxTokens:e.output,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}));
}
export function storedCatalog(value: unknown): Entry[] {
 if(!Array.isArray(value) || value.length>2048)return [];
 return value.filter((e):e is Entry=>record(e) && typeof e.id==="string" && /^(gemini-|claude-|gpt-oss-)[a-zA-Z0-9._-]+$/.test(e.id) && e.id.length<=160 && typeof e.name==="string" && e.name.length<=200 && integer(e.context) && integer(e.output) && typeof e.images==="boolean" && typeof e.thinking==="boolean")
  .map(e=>({id:e.id,name:e.name,context:e.context,output:e.output,images:e.images,thinking:e.thinking,
   remaining:typeof e.remaining==="number" && Number.isFinite(e.remaining) && e.remaining>=0 && e.remaining<=1?e.remaining:undefined,
   reset:typeof e.reset==="string" && Number.isFinite(Date.parse(e.reset))?e.reset:undefined}));
}
