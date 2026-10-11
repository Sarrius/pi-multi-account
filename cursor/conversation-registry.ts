/**
 * Where a Cursor conversation lives between requests.
 *
 * Cursor is stateful: once we hold a checkpoint for a conversation, the bridge replays that
 * checkpoint instead of the message list Pi sent, and Cursor answers from its own copy of the
 * history. That is fine while Pi and Cursor agree on what the history is — and wrong the moment
 * Pi compacts, because Pi's short summary never reaches Cursor and Cursor's `usedTokens` keeps
 * reporting the full pre-compaction size back to Pi.
 *
 * So the registry owns two things: the stored conversations, and a per-conversation generation
 * counter. Bumping the generation mints a new Cursor conversation id, which is how a compaction
 * is made to actually take effect — the checkpoint is dropped AND the old server-side
 * conversation is left behind rather than resumed under the same id.
 *
 * It is a separate module from proxy.ts on purpose: proxy.ts pulls in generated protobuf code
 * with non-erasable `enum`s, which Node's type stripping refuses to load, so nothing in it can
 * be unit-tested directly.
 */
import { createHash } from "node:crypto";

export interface StoredConversation {
  conversationId: string;
  checkpoint: Uint8Array | null;
  sessionScoped: boolean;
  blobStore: Map<string, Uint8Array>;
  lastAccessMs: number;
  /**
   * How many completed turns of Pi's transcript this conversation has actually seen. Cursor
   * answers from its own copy of the history, so anything that happened while the session was
   * on another provider is invisible to it — and rotation moves the session between accounts
   * constantly. See {@link isStaleForTranscript}.
   */
  turnsCovered: number;
  coveredTranscript?: string[];
  expectedAssistant?: string;
  expectedToolIds?: string[];
  requestGeneration?: number;
  workspaceCwd?: string;
}

/**
 * Has the session moved on without Cursor?
 *
 * Between two consecutive requests on this conversation the transcript grows by at most one
 * completed turn — the one we just answered. A bigger jump means turns were completed
 * somewhere Cursor never saw: a failover to another provider and back, a branch, another
 * client. Its checkpoint is then a conversation with a hole in it, and resuming from it hands
 * the model a past that is missing whatever happened while it was away.
 *
 * Rebuilding costs tokens; resuming a stale checkpoint costs correctness, silently. So the
 * doubt is resolved toward rebuilding.
 */
export function isStaleForTranscript(stored: StoredConversation, transcript: number | readonly Record<string, any>[]): boolean {
  // Legacy callers can still inspect the coarse heuristic. Actual proxy admission
  // supplies canonical messages and must prove exact coverage, not count user turns.
  if (typeof transcript === "number") return !!stored.checkpoint && transcript > stored.turnsCovered + 1;
  if (!stored.checkpoint && !stored.expectedAssistant) return false;
  const covered=stored.coveredTranscript;
  if(!covered || !stored.expectedAssistant || transcript.length<=covered.length)return true;
  if(covered.some((digest,i)=>digest!==messageDigest(transcript[i])))return true;
  if(messageDigest(transcript[covered.length])!==stored.expectedAssistant)return true;
  const suffix=transcript.slice(covered.length+1);
  const toolIds=stored.expectedToolIds??[];
  if(toolIds.length===0)return suffix.length!==1 || suffix[0].role!=="user";
  const seen=new Set<string>();
  return suffix.length===0 || suffix.some(message=>{
    const id=message.tool_call_id;
    if(message.role!=="tool" || !toolIds.includes(id) || seen.has(id))return true;
    seen.add(id);return false;
  });
}

function canonical(value:any):any {
  if(Array.isArray(value))return value.map(canonical);
  if(value && typeof value==="object")return Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonical(value[key])]));
  return value;
}
function messageDigest(message:Record<string,any>):string {
  let content=message.content??"";
  if(Array.isArray(content) && content.every(part=>part?.type==="text"))content=content.map(part=>part.text??"").join("");
  const tools=message.tool_calls?.map((call:any)=>{
    let args=call.function?.arguments;
    if(typeof args==="string"){try{args=JSON.parse(args);}catch{/* malformed data stays distinct */}}
    return {id:call.id,name:call.function?.name,arguments:args};
  });
  return createHash("sha256").update(JSON.stringify(canonical({role:message.role,content,tool_calls:tools?.length?tools:undefined,tool_call_id:message.tool_call_id}))).digest("hex");
}
export function coverTranscript(stored:StoredConversation,messages:readonly Record<string,any>[]):void {
  stored.coveredTranscript=messages.map(messageDigest);
  stored.expectedAssistant=undefined;stored.expectedToolIds=undefined;
}
export function recordAssistantResponse(stored:StoredConversation,message:Record<string,any>):void {
  stored.expectedAssistant=messageDigest(message);
  stored.expectedToolIds=(message.tool_calls??[]).map((call:any)=>call.id);
}
export interface ConversationReceipt {stored:StoredConversation;generation:number;}
export function captureConversation(convKey:string):ConversationReceipt|undefined {
  const stored=conversationStates.get(convKey);if(!stored)return undefined;
  const generation=(stored.requestGeneration??0)+1;stored.requestGeneration=generation;
  return {stored,generation};
}
export function ownsConversation(convKey:string,receipt:ConversationReceipt|undefined):boolean {
  return !!receipt && conversationStates.get(convKey)===receipt.stored && receipt.stored.requestGeneration===receipt.generation;
}

export const conversationStates = new Map<string, StoredConversation>();

/** How many times this conversation has been restarted (compaction, mostly). */
const conversationGenerations = new Map<string, number>();

export function deriveBridgeKeyFromSessionId(sessionId: string): string {
  return createHash("sha256").update(`bridge:${sessionId}`).digest("hex").slice(0, 16);
}

export function deriveConversationKeyFromSessionId(sessionId: string): string {
  return createHash("sha256").update(`conv:${sessionId}`).digest("hex").slice(0, 16);
}

export function conversationGeneration(convKey: string): number {
  return conversationGenerations.get(convKey) ?? 0;
}

/**
 * Stable per (conversation, generation) so a retried request rejoins the same Cursor
 * conversation, while a post-compaction request starts a new one.
 */
export function deterministicConversationId(convKey: string, generation = conversationGeneration(convKey)): string {
  const seed = generation > 0 ? `cursor-conv-id:${convKey}#${generation}` : `cursor-conv-id:${convKey}`;
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return [
    hex.slice(0, 8), hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${(0x8 | (parseInt(hex[16], 16) & 0x3)).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Forget everything Cursor is holding for this conversation and move to a fresh id.
 * Returns whether a conversation was actually stored, for logging.
 */
export function forgetConversation(convKey: string): boolean {
  const existed = conversationStates.delete(convKey);
  conversationGenerations.set(convKey, conversationGeneration(convKey) + 1);
  return existed;
}

/** Drop a conversation for good — the session itself is gone, so its generation is noise. */
export function dropConversation(convKey: string): boolean {
  conversationGenerations.delete(convKey);
  return conversationStates.delete(convKey);
}

export function clearConversationRegistry(): void {
  conversationStates.clear();
  conversationGenerations.clear();
}
