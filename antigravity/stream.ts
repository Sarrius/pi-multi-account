/** Antigravity native stream; protocol reference: LICENSE.reference. */
import { randomUUID } from "node:crypto";
import { createProvider, createAssistantMessageEventStream,
 type Model, type Api, type AssistantMessage, type ToolCall, type OAuthAuth } from "@earendil-works/pi-ai";
import { collapseSystemMessages, getCurrentTools, getCurrentSystemPrompt, requireNativeTranscript,
 type NativeContext as TranscriptContext, type NativeStreamOptions as SimpleStreamOptions } from "../google-transport/native.ts";
// Resolve the public import export explicitly: the host's legacy jiti prefix alias
// otherwise treats unknown pi-ai subpaths as children of compat.js.
const loadGoogleHelpers = () => import(new URL("./api/google-shared.js", import.meta.resolve("@earendil-works/pi-ai/compat")).href) as Promise<typeof import("@earendil-works/pi-ai/api/google-shared") & {
 usesGoogleThinkingLevel(model: Model<"google-generative-ai">): boolean;
 toGoogleThinkingLevel(level: "minimal" | "low" | "medium" | "high"): string;
 getDisabledGoogleThinkingConfig(model: Model<"google-generative-ai">): unknown;
}>;
import { createGoogleReplayCache } from "../google-transport/replay.ts";
import { events } from "../google-transport/sse.ts";
import { operationSignal, record, cancellable } from "../google-transport/http.ts";
import * as ag from "./transport.ts";

/** Callers must supply reviewed model metadata; no fabricated entitlement/catalog. */
export function createAntigravityStream(models: readonly Model<Api>[], options: {
 id?: string; fetch?: typeof fetch; assertConfiguration?: () => void;
 oauth: OAuthAuth;
 beforeRequest?: (model: Model<Api>, request: SimpleStreamOptions, signal: AbortSignal) => Promise<void>;
}) {
 requireNativeTranscript();
 const api = ag.ID, baseUrl = ag.BASE;
 const id = options.id ?? api;
 if (!/^google-antigravity(?:-account-[1-9]\d*)?$/.test(id)) throw new Error("Invalid Antigravity slot");
 const definitions: Model<Api>[] = models.map(model => ({ ...model, provider: id, api,
  baseUrl, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
 const oauth = options.oauth;
 const replay = createGoogleReplayCache();
 const fallbackSessionId = `pi-${randomUUID()}`;
 const transport = (model: Model<Api>, context: TranscriptContext, request: SimpleStreamOptions = {}) => {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = { role: "assistant", api, provider: id,
   model: model.id, timestamp: Date.now(), stopReason: "pending", content: [],
   usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  void (async () => {
   let signal = request.signal ?? new AbortController().signal;
   try {
    signal = operationSignal(signal, request.timeoutMs ?? 120000);
    signal.throwIfAborted(); options.assertConfiguration?.();
    const { convertMessages, convertTools, resolveGoogleThinkingLevel, usesGoogleThinkingLevel,
     toGoogleThinkingLevel, getDisabledGoogleThinkingConfig, retainThoughtSignature } = await loadGoogleHelpers();
    signal.throwIfAborted();
    if (model.provider !== id || model.api !== api || model.baseUrl !== baseUrl)
     throw new Error("Google subscription requires its exact route");
    await options.beforeRequest?.(model, request, signal);
    const headers = new Headers(request.headers as HeadersInit);
    const projectId = ag.project(headers.get(ag.PROJECT_HEADER)); headers.delete(ag.PROJECT_HEADER);
    const authHeaders = ag.headers(request.apiKey ?? "", Object.fromEntries(headers));
    const replayBinding = replay.binding(id, model.id, projectId, request.apiKey ?? "", request.sessionId);
    const normalized = collapseSystemMessages(replay.restore(replayBinding, context));
    const tools = getCurrentTools(normalized.messages);
    const nativeModel = model as Model<"google-generative-ai">;
    const generationConfig: Record<string, unknown> = {};
    if (request.maxTokens !== undefined) generationConfig.maxOutputTokens = request.maxTokens;
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
    if (model.reasoning) {
     if (request.reasoning) {
      const level = resolveGoogleThinkingLevel(nativeModel, request.reasoning);
      if (usesGoogleThinkingLevel(nativeModel)) {
       generationConfig.thinkingConfig = { thinkingLevel: toGoogleThinkingLevel(level), includeThoughts: true };
      } else {
       const budgets = { minimal: model.id.includes("flash-lite") ? 512 : 128, low: 2048, medium: 8192,
        high: model.id.includes("2.5-pro") ? 32768 : 24576 };
       generationConfig.thinkingConfig = { thinkingBudget: request.thinkingBudgets?.[level] ?? budgets[level], includeThoughts: true };
      }
     } else generationConfig.thinkingConfig = getDisabledGoogleThinkingConfig(nativeModel);
    }
    if (model.id.startsWith("claude-") && model.reasoning) {
     const budget = request.reasoning ? ({minimal:1024,low:2048,medium:8192,high:16384,xhigh:32768} as Record<string,number>)[request.reasoning] : 1024;
     const max = request.maxTokens ?? model.maxTokens;
     if (!budget || max <= budget) throw new Error("Antigravity Claude thinking requires an output limit larger than the selected thinking budget");
     generationConfig.maxOutputTokens = max;
     generationConfig.thinkingConfig = { include_thoughts:true, thinking_budget:budget };
     authHeaders.set("anthropic-beta", "interleaved-thinking-2025-05-14");
    }
    const payload = { contents: convertMessages(nativeModel, normalized),
     systemInstruction: { parts: [{ text: getCurrentSystemPrompt(normalized.messages) }] },
     tools: convertTools(tools, true), generationConfig,
     ...(request.toolChoice ? { toolConfig: { functionCallingConfig: { mode: request.toolChoice === "none" ? "NONE" : "AUTO" } } } : {}) };
    const replacement = await cancellable(Promise.resolve(request.onPayload?.(payload, model)), signal);
    options.assertConfiguration?.(); signal.throwIfAborted();
    const content = replacement ?? payload;
    if (!record(content) || content.enabledCreditTypes !== undefined || content.enabled_credit_types !== undefined) throw new Error("Antigravity payload cannot request credit overages");
    if (record(content)) {
     content.sessionId = request.sessionId ?? fallbackSessionId;
     if (record(content.systemInstruction)) content.systemInstruction.role = "user";
    }
    const response = await ag.request(options.fetch ?? fetch, ag.STREAM, { project:projectId, model:model.id, request:content,
       requestType:"agent", userAgent:"antigravity", requestId:`agent-${randomUUID()}`, enabled_credit_types:[] }, signal, authHeaders);
    await cancellable(Promise.resolve(request.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model)), signal);
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Antigravity HTTP ${response.status}`); }
    if (!response.body) throw new Error("Missing Google stream body");
    stream.push({ type: "start", partial: message });
    let terminal: string | undefined;
    const pendingTools: ToolCall[] = [];
    let current: Extract<AssistantMessage["content"][number], {type:"text"|"thinking"}> | undefined;
    let currentIndex = -1;
    const closeText = () => {
     if (!current) return;
     if(current.type==="text")stream.push({type:"text_end",contentIndex:currentIndex,content:current.text,partial:message});
     else stream.push({type:"thinking_end",contentIndex:currentIndex,content:current.thinking,partial:message});
     current=undefined;
    };
    for await (const frame of events(response.body, signal)) {
     await cancellable(Promise.resolve(request.onProviderStreamEvent?.(frame, model)), signal);
     if (!record(frame)) throw new Error("Malformed Google frame");
     const body = "response" in frame ? frame.response : frame;
     if (!record(body) || body.error) throw new Error("Malformed/error Google response");
     if (typeof body.responseId === "string") message.responseId ??= body.responseId;
     const candidates = body.candidates;
     if (candidates !== undefined && (!Array.isArray(candidates) || candidates.length > 1)) throw new Error("Unexpected Google candidates");
     const candidate = Array.isArray(candidates) ? candidates[0] : undefined;
     if (candidate !== undefined) {
      if (!record(candidate) || terminal) throw new Error("Invalid/duplicate Google terminal");
      const content = candidate.content;
      // Role/response metadata can precede the first actual part (e.g. GPT-OSS).
      if (content !== undefined && (!record(content) || (content.parts !== undefined && !Array.isArray(content.parts)))) throw new Error("Malformed Google parts");
      for (const part of record(content) && Array.isArray(content.parts) ? content.parts : []) {
       if (!record(part)) throw new Error("Malformed Google part");
       if (part.thoughtSignature !== undefined && typeof part.thoughtSignature !== "string") throw new Error("Malformed Google signature");
       const signature = part.thoughtSignature as string | undefined;
       if ("functionCall" in part) {
        closeText();
        if ("text" in part || !record(part.functionCall)) throw new Error("Malformed Google function call");
        const call = part.functionCall;
        if (typeof call.name !== "string" || !tools.some(t => t.name === call.name) || !record(call.args)) throw new Error("Invalid Google tool name/arguments");
        if (call.id !== undefined && (typeof call.id !== "string" || !call.id)) throw new Error("Invalid Google tool identity");
        const tool: ToolCall = { type: "toolCall", id: call.id as string || randomUUID(), name: call.name,
         arguments: call.args as ToolCall["arguments"], ...(signature ? { thoughtSignature: signature } : {}) };
        if (pendingTools.some(t => t.id === tool.id)) throw new Error("Duplicate Google tool identity");
        pendingTools.push(tool);
       } else if (typeof part.text === "string") {
        const kind=part.thought===true?"thinking":"text";
        if(current?.type!==kind){
         closeText();currentIndex=message.content.length;
         current=kind==="thinking"?{type:"thinking",thinking:""}:{type:"text",text:""};message.content.push(current);
         stream.push({type:kind==="thinking"?"thinking_start":"text_start",contentIndex:currentIndex,partial:message});
        }
        const block=current!;
        if(block.type==="thinking"){
         block.thinking+=part.text;block.thinkingSignature=retainThoughtSignature(block.thinkingSignature,signature);
         if(part.text.length)stream.push({type:"thinking_delta",contentIndex:currentIndex,delta:part.text,partial:message});
        }else{
         block.text+=part.text;block.textSignature=retainThoughtSignature(block.textSignature,signature);
         if(part.text.length)stream.push({type:"text_delta",contentIndex:currentIndex,delta:part.text,partial:message});
        }
       } else throw new Error("Unsupported Google response part");
      }
      if (candidate.finishReason !== undefined) {
       if (typeof candidate.finishReason !== "string" || !["STOP", "MAX_TOKENS"].includes(candidate.finishReason)) throw new Error("Unsupported Google finish reason");
       terminal = candidate.finishReason; message.rawStopReason = terminal;
      }
     }
     if (body.usageMetadata !== undefined) {
      if (!record(body.usageMetadata)) throw new Error("Malformed Google usage");
      const usage = body.usageMetadata;
      const count = (name: string) => { const n = usage[name] ?? 0;
       if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new Error("Malformed Google token count"); return n; };
      const cached = count("cachedContentTokenCount"), prompt = count("promptTokenCount");
      if (cached > prompt) throw new Error("Invalid Google cached token count");
      message.usage.input = prompt - cached; message.usage.cacheRead = cached;
      message.usage.output = count("candidatesTokenCount") + count("thoughtsTokenCount");
      message.usage.totalTokens = count("totalTokenCount") || prompt + message.usage.output;
     }
    }
    signal.throwIfAborted();
    if (!terminal) throw new Error("Google stream ended without finish reason");
    if (pendingTools.length && terminal !== "STOP") throw new Error("Google tool output truncated");
    closeText();
    // Tool events are admitted only after full framing and terminal validation.
    for (const tool of pendingTools) {
     const index = message.content.length; message.content.push(tool);
     stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
     stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(tool.arguments), partial: message });
     // Native signatures remain in the parent result/replay receipt, never in the
     // executable public tool event sent across the Broker boundary.
     stream.push({ type: "toolcall_end", contentIndex: index, toolCall: {
      type: "toolCall", id: tool.id, name: tool.name, arguments: tool.arguments,
     }, partial: message });
    }
    if (!message.content.length) throw new Error("Google returned an empty response");
    message.stopReason = pendingTools.length ? "toolUse" : terminal === "MAX_TOKENS" ? "length" : "stop";
    replay.retain(replayBinding, message);
    stream.push({ type: "done", reason: message.stopReason, message });
   } catch (error) {
    message.stopReason = signal.aborted ? "aborted" : "error";
    message.errorMessage = signal.aborted ? "Google request aborted" : error instanceof Error ? error.message : "Google request failed";
    stream.push({ type: "error", reason: message.stopReason, error: message });
   } finally { stream.end(); }
  })();
  return stream;
 };
 return Object.assign(createProvider<Api>({ id, name: "Google Antigravity (unofficial subscription)", baseUrl,
  auth: { oauth: { ...oauth, async toAuth(credential) { options.assertConfiguration?.(); return oauth.toAuth(credential); } } },
  models: definitions, api: { stream: transport, streamSimple: transport } }), { streamSimple: transport });
}
