import assert from "node:assert/strict";
import test from "node:test";
import { authorization, createAntigravityOAuth } from "../antigravity/oauth.ts";
import { PUBLIC_INSTALLED_CLIENT } from "../antigravity/oauth-client.ts";

test("browser authorization works without private client files and never includes client secret or account tokens in URL", () => {
 const previous=process.env.PI_ANTIGRAVITY_OAUTH_CLIENT_FILE;
 process.env.PI_ANTIGRAVITY_OAUTH_CLIENT_FILE="/does-not-exist/private-client.json";
 try {
  const auth=authorization(),url=new URL(auth.url);
  assert.equal(url.origin,"https://accounts.google.com");
  assert.equal(url.searchParams.get("client_id"),PUBLIC_INSTALLED_CLIENT.clientId);
  assert.equal(url.searchParams.get("client_secret"),null);assert.equal(url.searchParams.get("access_token"),null);
  assert.equal(url.searchParams.get("code_challenge_method"),"S256");
  assert.ok(!JSON.stringify(auth).includes(PUBLIC_INSTALLED_CLIENT.clientSecret));
 } finally {if(previous===undefined)delete process.env.PI_ANTIGRAVITY_OAUTH_CLIENT_FILE;else process.env.PI_ANTIGRAVITY_OAUTH_CLIENT_FILE=previous;}
});

test("refresh uses the same installed application identity without configuration or native credential mutation",async()=>{
 const credential={type:"oauth" as const,access:"synthetic-old-access",refresh:"synthetic-refresh",expires:1,antigravityVersion:1,projectId:"fixture-project"};
 const before=structuredClone(credential);let calls=0;
 const auth=createAntigravityOAuth((async(url,init)=>{
  calls++;assert.equal(url,"https://oauth2.googleapis.com/token");assert.equal(init?.redirect,"error");
  const fields=new URLSearchParams(String(init?.body));
  assert.equal(fields.get("client_id"),PUBLIC_INSTALLED_CLIENT.clientId);
  assert.ok(fields.get("client_secret")===PUBLIC_INSTALLED_CLIENT.clientSecret);
  assert.equal(fields.get("refresh_token"),credential.refresh);
  return Response.json({token_type:"Bearer",access_token:"synthetic-new-access",expires_in:3600});
 }) as typeof fetch);
 const result=await auth.refresh!(credential,new AbortController().signal);
 assert.equal(calls,1);assert.deepEqual(credential,before);assert.equal(result.refresh,credential.refresh);
 assert.ok(!JSON.stringify(result).includes(PUBLIC_INSTALLED_CLIENT.clientSecret));
 const stopped=new AbortController();stopped.abort();await assert.rejects(auth.refresh!(credential,stopped.signal));assert.equal(calls,1);
});
