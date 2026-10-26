import { createHash } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { NativeContext as TranscriptContext } from "./native.ts";

/** Parent-only, bounded native replay receipts. Never accepts private metadata from children. */
export function createGoogleReplayCache(now = Date.now) {
 const receipts = new Map<string, { message: AssistantMessage; at: number; bytes: number }>();
 let bytes = 0;
 const hash = (value: string) => createHash("sha256").update(value).digest("hex");
 function projection(message: any) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  const content: any[] = [];
  for (const block of message.content) {
   if (block.type === "thinking") continue;
   if (block.type === "text") {
    if (content.at(-1)?.type === "text") content.at(-1).text += block.text;
    else content.push({ type: "text", text: block.text });
   } else if (block.type === "toolCall") content.push({ type: "toolCall", id: block.id, name: block.name, arguments: block.arguments });
   else return undefined;
  }
  return hash(JSON.stringify(content));
 }
 function prune() {
  for (const [key, receipt] of receipts) {
   if (now() - receipt.at > 30 * 60_000 || receipts.size > 128 || bytes > 8 * 1024 * 1024) {
    receipts.delete(key); bytes -= receipt.bytes;
   }
  }
 }
 return {
  binding(provider: string, model: string, project: string, access: string, session: string | undefined) {
   return session ? hash(JSON.stringify([provider, model, project, hash(access), session])) : undefined;
  },
  restore(binding: string | undefined, context: TranscriptContext): TranscriptContext {
   prune(); if (!binding) return context;
   return { ...context, messages: context.messages.map(message => {
    // Direct Pi transcripts already have native provenance. Restore only the broker's
    // exact credentialless projection, never overwrite a different provider's history.
    if (message.role !== "assistant" || message.provider || message.model) return message;
    const key = projection(message); const receipt = key && receipts.get(`${binding}:${key}`);
    return receipt ? structuredClone(receipt.message) : message;
   }) };
  },
  retain(binding: string | undefined, message: AssistantMessage) {
   if (!binding || !["stop", "toolUse", "length"].includes(message.stopReason)) return;
   const key = projection(message); if (!key) return;
   const size = Buffer.byteLength(JSON.stringify(message)); if (size > 1024 * 1024) return;
   const id = `${binding}:${key}`, old = receipts.get(id); if (old) bytes -= old.bytes;
   receipts.delete(id); receipts.set(id, { message: structuredClone(message), at: now(), bytes: size });
   bytes += size; prune();
  },
 };
}
