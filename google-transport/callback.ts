// Loopback lifecycle adapted from Heelc/pi-geminicli-oauth (MIT); see LICENSE.reference.
import { createServer } from "node:http";
/** Full callback only: accepting a bare code discards CSRF/state verification. */
export function callbackCode(input:string,state:string,redirect:string):string{
 const url=new URL(input.trim()),expected=new URL(redirect);
 if(url.origin!==expected.origin||url.pathname!==expected.pathname||url.hash||url.username||url.password)throw new Error("Invalid Google callback destination");
 for(const key of ["state","code","error"])if(url.searchParams.getAll(key).length>1)throw new Error("Duplicate OAuth callback parameter");
 if(url.searchParams.get("state")!==state)throw new Error("Google OAuth state mismatch");
 if(url.searchParams.has("error"))throw new Error("Google authorization denied; restart login");
 const code=url.searchParams.get("code");
 if(!code||code.length>8192||/[\x00-\x20\x7f]/.test(code))throw new Error("Invalid OAuth code");
 return code;
}
export async function listenForGoogleCallback(state:string,signal:AbortSignal,port:number,redirect:string){
 signal.throwIfAborted();let resolveCode!:(code:string)=>void,rejectCode!:(error:unknown)=>void;
 const code=new Promise<string>((resolve,reject)=>{resolveCode=resolve;rejectCode=reject;});void code.catch(()=>{});
 const server=createServer((request,response)=>{
  try{
   if(request.method!=="GET"||!request.url||request.url.length>16384)throw new Error("Invalid callback");
   const value=callbackCode(new URL(request.url,redirect).toString(),state,redirect);
   response.writeHead(200,{"Content-Type":"text/plain","Cache-Control":"no-store"});
   response.end("Google sign-in received. Return to Pi.");resolveCode(value);
  }catch{response.writeHead(400,{"Content-Type":"text/plain"});response.end("Invalid authorization callback.");}
 });
 const abort=()=>{rejectCode(signal.reason);server.close();server.closeAllConnections();};
 signal.addEventListener("abort",abort,{once:true});
 try{
  await new Promise<void>((resolve,reject)=>{
   server.once("error",reject);server.listen(port,"127.0.0.1",()=>{server.off("error",reject);resolve();});
  });signal.throwIfAborted();
 }catch(error){signal.removeEventListener("abort",abort);server.close();server.closeAllConnections();throw error;}
 server.on("error",rejectCode);const address=server.address();
 return {code,port:typeof address==="object"&&address?address.port:port,async close(){
  signal.removeEventListener("abort",abort);rejectCode(new Error("Google callback listener closed"));
  await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});
 }};
}
