// Protocol reference: NoeFabris/opencode-antigravity-auth, MIT,
// f212f7eb01aa904b5985895cf93f6d3074c5bc6d. See LICENSE.reference.
import { cancellable, token } from "../google-transport/http.ts";
export const ID = "google-antigravity";
export const BASE = "https://daily-cloudcode-pa.googleapis.com";
export const VERSION = "2.24.0";
// Pinned wire-compatibility identifier from the reference, not an installed-client claim.
const USER_AGENT = `antigravity/hub/${VERSION} (aidev_client; os_type=darwin; arch=arm64)`;
export const PROJECT_HEADER = "x-pi-antigravity-project";
export const STREAM = `${BASE}/v1internal:streamGenerateContent?alt=sse`;
/** Account-returned opaque identifier, never a URL destination or guessed Cloud project. */
export function project(value: unknown): string {
 if(typeof value!=="string" || !/^[\x21-\x7e]{1,1024}$/.test(value))throw new Error("Missing/invalid Antigravity project identifier");
 return value;
}
export function headers(access: string, supplied: Record<string, string | null> = {}, onboard = false): Headers {
 const out = new Headers({ "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token(access)}`,
  "user-agent": onboard ? `${USER_AGENT} google-api-nodejs-client/10.3.0` : USER_AGENT });
 if (onboard) out.set("x-goog-api-client", "gl-node/22.21.1");
 for (const [key,value] of Object.entries(supplied)) {
  if (["authorization","proxy-authorization","host","cookie","content-length","user-agent","x-goog-api-client","client-metadata","content-type"].includes(key.toLowerCase())) throw new Error("Reserved Antigravity header override");
  if (value !== null) out.set(key,value);
 }
 return out;
}
export async function request(fetchImpl: typeof fetch, url: string, body: unknown, signal: AbortSignal, hdr: Headers): Promise<Response> {
 if (![STREAM,...["loadCodeAssist","onboardUser","fetchAvailableModels"].map(m=>`${BASE}/v1internal:${m}`)].includes(url)) throw new Error("Foreign Antigravity destination rejected");
 signal.throwIfAborted();
 const response = await cancellable(fetchImpl(url,{method:"POST",headers:hdr,body:JSON.stringify(body),signal,redirect:"error",credentials:"omit"}),signal);
 if (response.redirected || (response.url && response.url!==url) || response.status>=300 && response.status<400) {
  void response.body?.cancel().catch(()=>{}); throw new Error("Antigravity redirect rejected");
 }
 return response;
}
