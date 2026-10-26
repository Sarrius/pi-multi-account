export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export function record(value: unknown): value is Record<string, unknown> {
 return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function token(value: unknown): string {
 if(typeof value!=="string" || !value || value.length>16384 || /[\s\x00-\x1f\x7f]/.test(value))throw new Error("Invalid Google OAuth token");
 return value;
}
/** Race non-cooperating transports/UI/hooks, always removing the abort listener. */
export function cancellable<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
 signal.throwIfAborted();
 return new Promise<T>((resolve,reject)=>{
  const abort=()=>reject(signal.reason??new DOMException("Aborted","AbortError"));
  signal.addEventListener("abort",abort,{once:true});
  Promise.resolve(work).then(resolve,reject).finally(()=>signal.removeEventListener("abort",abort));
 });
}
export function operationSignal(signal?:AbortSignal,timeoutMs=120000):AbortSignal {
 if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw new Error("Invalid timeoutMs");
 return AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(timeoutMs)]);
}
/** OAuth token endpoint only; product-specific destinations belong to their own transport. */
export async function post(fetchImpl:typeof fetch,url:string,body:string|URLSearchParams,signal:AbortSignal,headers:HeadersInit):Promise<Response>{
 if(url!==TOKEN_URL)throw new Error("Foreign Google destination rejected");
 signal.throwIfAborted();
 const r=await cancellable(fetchImpl(url,{method:"POST",headers,body,signal,redirect:"error",credentials:"omit"}),signal);
 if(r.redirected||(r.url&&r.url!==url)||(r.status>=300&&r.status<400)){
  void r.body?.cancel().catch(()=>{});throw new Error("Google redirect/foreign response rejected");
 }
 return r;
}
/** Bounded fatal UTF-8 decoding; never echo raw token/account response bodies. */
export async function jsonResponse(response:Response,signal:AbortSignal,maxBytes=262144):Promise<unknown>{
 if(!response.ok){void response.body?.cancel().catch(()=>{});throw new Error(`Google request failed (HTTP ${response.status})`);}
 if(!response.body)throw new Error("Missing Google response body");
 const reader=response.body.getReader(),decoder=new TextDecoder("utf-8",{fatal:true});
 let size=0,text="",complete=false;
 const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener("abort",abort,{once:true});
 try{
  while(true){const chunk=await cancellable(reader.read(),signal);signal.throwIfAborted();if(chunk.done)break;
   size+=chunk.value.byteLength;if(size>maxBytes)throw new Error("Google JSON response exceeds limit");
   text+=decoder.decode(chunk.value,{stream:true});}
  text+=decoder.decode();let result:unknown;
  try{result=JSON.parse(text);}catch{throw new Error("Malformed Google JSON response");}
  complete=true;return result;
 }finally{signal.removeEventListener("abort",abort);if(!complete)void reader.cancel().catch(()=>{});reader.releaseLock();}
}
