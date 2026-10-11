/**
 * Local OpenAI-compatible proxy: translates /v1/chat/completions to Cursor's gRPC protocol.
 *
 * Based on https://github.com/ephraimduncan/opencode-cursor by Ephraim Duncan.
 * Uses Node's http2 via a child process bridge (h2-bridge.mjs).
 */
import { create, fromBinary, fromJson, type JsonValue, toBinary, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve as pathResolve, dirname, join as pathJoin, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { estimatePromptTokens, resolveCursorUsage } from "./prompt-usage.ts";
import { type BridgeHandle, type BridgeStreams, createBridgeHandle } from "./bridge-handle.ts";
import { transportStatusError } from "./transport-status.mjs";
import { startSSEResponse } from "./sse-keepalive.ts";
import {
  formatStallDuration,
  resolveTransportStallTimeoutMs,
  resolveUpstreamStallTimeoutMs,
  startUpstreamWatchdog,
} from "./upstream-watchdog.ts";
import {
  classifyCursorFrame,
  mapNativeExecToPiTool,
  NATIVE_TOOL_UNAVAILABLE,
  resolveToolCallCoalesceMs,
  type CursorFrameClass,
} from "./stream-lifecycle.ts";
import {
  requestActionText,
  historyForRebuild,
  isToolCallStep,
  parseMessages as parseMessagesPure,
  parseToolCallArguments,
  systemPromptForRebuild,
  textContent,
  type ContentPart,
  type OpenAIMessage,
  type OpenAIToolCall,
  type ParsedAssistantTextStep,
  type ParsedMessages,
  type ParsedToolCallStep,
  type ParsedToolResult,
  type ParsedTurn,
  type ParsedTurnStep,
  type ToolResultInfo,
} from "./message-parsing.ts";
import {
  clearConversationRegistry,
  conversationStates,
  isStaleForTranscript,
  coverTranscript,
  recordAssistantResponse,
  captureConversation,
  ownsConversation,
  type ConversationReceipt,
  deriveBridgeKeyFromSessionId,
  deriveConversationKeyFromSessionId,
  deterministicConversationId,
  dropConversation,
  forgetConversation,
  type StoredConversation,
} from "./conversation-registry.ts";
import {
  AgentClientMessageSchema,
  AgentRunRequestSchema,
  AgentServerMessageSchema,
  AskQuestionInteractionResponseSchema,
  AskQuestionRejectedSchema,
  AskQuestionResultSchema,
  CancelActionSchema,
  ClientHeartbeatSchema,
  ConversationActionSchema,
  ConversationStateStructureSchema,
  ConversationStepSchema,
  AgentConversationTurnStructureSchema,
  ConversationTurnStructureSchema,
  AssistantMessageSchema,
  CreatePlanErrorSchema,
  CreatePlanRequestResponseSchema,
  CreatePlanResultSchema,

  BackgroundShellSpawnResultSchema,
  DeleteErrorSchema,
  DeleteResultSchema,
  DeleteRejectedSchema,
  DeleteSuccessSchema,
  DiagnosticsResultSchema,
  ExecClientControlMessageSchema,
  ExecClientMessageSchema,
  ExecClientStreamCloseSchema,
  ExecClientThrowSchema,
  ExaFetchRequestResponseSchema,
  ExaFetchRequestResponse_RejectedSchema,
  ExaSearchRequestResponseSchema,
  ExaSearchRequestResponse_RejectedSchema,
  FetchErrorSchema,
  FetchResultSchema,
  GetBlobResultSchema,
  GrepContentMatchSchema,
  GrepContentResultSchema,
  GrepErrorSchema,
  GrepFileMatchSchema,
  GrepResultSchema,
  GrepSuccessSchema,
  GrepUnionResultSchema,
  InteractionResponseSchema,
  KvClientMessageSchema,
  LsDirectoryTreeNodeSchema,
  LsDirectoryTreeNode_FileSchema,
  LsErrorSchema,
  LsRejectedSchema,
  LsResultSchema,
  LsSuccessSchema,
  McpArgsSchema,
  McpErrorSchema,
  McpResultSchema,
  McpSuccessSchema,
  McpTextContentSchema,
  McpToolCallSchema,
  McpToolDefinitionSchema,
  McpToolResultContentItemSchema,
  ModelDetailsSchema,
  ReadErrorSchema,
  ReadRejectedSchema,
  ReadResultSchema,
  ReadSuccessSchema,
  RequestContextResultSchema,
  RequestContextSchema,
  RequestContextSuccessSchema,
  SelectedContextSchema,
  SetBlobResultSchema,
  SetupVmEnvironmentResultSchema,
  SetupVmEnvironmentSuccessSchema,
  ShellRejectedSchema,
  ShellResultSchema,
  ShellStreamExitSchema,
  ShellStreamSchema,
  ShellStreamStdoutSchema,
  ShellSuccessSchema,
  SwitchModeRequestResponseSchema,
  SwitchModeRequestResponse_RejectedSchema,
  ToolCallSchema,
  UserMessageActionSchema,
  UserMessageSchema,
  WebSearchRequestResponseSchema,
  WebSearchRequestResponse_RejectedSchema,
  WriteErrorSchema,
  WriteRejectedSchema,
  WriteResultSchema,
  WriteSuccessSchema,
  WriteShellStdinErrorSchema,
  WriteShellStdinResultSchema,
  GetUsableModelsRequestSchema,
  GetUsableModelsResponseSchema,
  type AgentServerMessage,
  type ConversationStateStructure,
  type ExecServerMessage,
  type InteractionQuery,
  type InteractionResponse,
  type KvServerMessage,
  type McpToolDefinition,
  type ShellStream,
  type UserMessage,
} from "./proto/agent_pb.ts";

const CURSOR_API_URL = "https://api2.cursor.sh";
const CONNECT_END_STREAM_FLAG = 0b00000010;
// Use import.meta.url for bridge path resolution (jiti supports this)
const BRIDGE_PATH = pathResolve(dirname(fileURLToPath(import.meta.url)), "h2-bridge.mjs");

// ── Types ──

interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface ChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: OpenAIToolDef[];
  tool_choice?: unknown;
  reasoning_effort?: string;
  user?: string;
  pi_session_id?: string;
  pi_cwd?: string;
}

interface CursorRequestPayload {
  requestBytes: Uint8Array;
  blobStore: Map<string, Uint8Array>;
  mcpTools: McpToolDefinition[];
}

interface PendingExec {
  execId: string;
  execMsgId: number;
  toolCallId: string;
  toolName: string;
  decodedArgs: string;
  resultCase?: string;
  nativeArgs?: Record<string, unknown>;
}

export type { BridgeHandle };

export type BridgeFactory = (options: SpawnBridgeOptions) => BridgeHandle;

interface ActiveBridge {
  bridge: BridgeHandle;
  heartbeatTimer: ReturnType<typeof setInterval>;
  blobStore: Map<string, Uint8Array>;
  mcpTools: McpToolDefinition[];
  pendingExecs: PendingExec[];
  currentTurn: ParsedTurn;
  receipt?: ConversationReceipt;
  paused?: boolean;
  dispose?: () => void;
}

export type { StoredConversation };
export type {
  ContentPart, OpenAIMessage, OpenAIToolCall, ParsedAssistantTextStep, ParsedMessages,
  ParsedToolCallStep, ParsedToolResult, ParsedTurn, ParsedTurnStep, ToolResultInfo,
};

interface StreamState {
  toolCallIndex: number;
  pendingExecs: PendingExec[];
  outputTokens: number;
  totalTokens: number;
  promptTokenEstimate: number;
}

// ── State ──

const activeBridges = new Map<string, ActiveBridge>();
const CONVERSATION_TTL_MS = 30 * 60 * 1000;
let bridgeFactory: BridgeFactory = spawnBridge;
let debugRequestCounter = 0;
let debugLogFilePath: string | undefined;

function isProxyDebugEnabled(): boolean {
  const raw = process.env.PI_CURSOR_PROVIDER_DEBUG?.trim().toLowerCase();
  return !!raw && raw !== "0" && raw !== "false" && raw !== "off";
}

function truncateDebugString(value: string, max = 4000): string {
  return value.length > max ? `${value.slice(0, max)}…<truncated ${value.length - max} chars>` : value;
}

export function sanitizeForDebug(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") return truncateDebugString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    return {
      __type: value instanceof Uint8Array ? "Uint8Array" : "Buffer",
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
    };
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeForDebug(item));
  if (value instanceof Map) {
    return {
      __type: "Map",
      size: value.size,
      entries: Array.from(value.entries()).slice(0, 20).map(([k, v]) => [sanitizeForDebug(k), sanitizeForDebug(v)]),
    };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, inner]) => {
      if (/^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|key|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|client[_-]?secret|password)$/i.test(key)) {
        return [key, "<redacted>"] as const;
      }
      if (key === "data" && typeof inner === "string") return [key, `<redacted base64 ${inner.length} chars>`] as const;
      return [key, sanitizeForDebug(inner)] as const;
    });
    return Object.fromEntries(entries);
  }
  return String(value);
}

/** Metadata-only diagnostics never write prompts, tool results, headers or raw session identifiers. */
export function metadataForDebug(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (/token|secret|password|authorization|cookie|api[_-]?key|^key$/i.test(key)) continue;
    if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (["execCase", "msgCase", "updateCase", "terminalEvent", "case", "missing", "kind", "control"].includes(key) && typeof value === "string" && /^[a-zA-Z_.-]{1,80}$/.test(value)) out[key] = value;
    else if (["bridgeKey", "convKey", "rpcId", "execId", "execMsgId", "sessionId", "conversationId"].includes(key) && typeof value === "string") out[key] = createHash("sha256").update(value).digest("hex").slice(0,16);
    else if (["toolResults", "pendingExecs", "unresolvedExecs"].includes(key) && Array.isArray(value)) out[`${key}Count`] = value.length;
    else if (key === "exec" && value && typeof value === "object") {
      const exec = value as { id?: unknown; execId?: unknown; type?: unknown };
      out.exec = metadataForDebug({ execId: exec.execId, execMsgId: exec.id, execCase: exec.type });
    }
  }
  return out;
}

function getDebugLogFilePath(): string {
  const configured = process.env.PI_CURSOR_PROVIDER_DEBUG_FILE?.trim();
  if (configured) return configured;
  if (debugLogFilePath) return debugLogFilePath;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  debugLogFilePath = pathJoin(tmpdir(), `pi-cursor-provider-debug-${stamp}-${process.pid}.log`);
  return debugLogFilePath;
}

function debugLog(event: string, data?: Record<string, unknown>): void {
  if (!isProxyDebugEnabled()) return;
  const line = JSON.stringify({
    ...(data ? (process.env.PI_CURSOR_PROVIDER_DEBUG_METADATA_ONLY === "1" ? metadataForDebug(data) : sanitizeForDebug(data)) : {}),
    ts: new Date().toISOString(),
    pid: process.pid,
    event,
  });
  const file = getDebugLogFilePath();
  try {
    appendFileSync(file, `${line}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    console.error("[pi-cursor-provider] failed to write debug log", error);
    console.error(`[pi-cursor-provider] ${line}`);
  }
}

function nextDebugRequestId(): string {
  debugRequestCounter += 1;
  return `req-${debugRequestCounter}`;
}

export const __testInternals = {
  activeBridges,
  conversationStates,
  resumePendingExecWithToolResult,
};

export function setBridgeFactoryForTests(factory?: BridgeFactory): void {
  bridgeFactory = factory ?? spawnBridge;
}

let proxyServer: ReturnType<typeof createServer> | undefined;
let proxyPort: number | undefined;
let proxyAccessTokenProvider: ((req?: IncomingMessage) => Promise<string>) | undefined;

// ── Bridge spawn ──

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
  const frame = Buffer.alloc(5 + data.length);
  frame[0] = flags;
  frame.writeUInt32BE(data.length, 1);
  frame.set(data, 5);
  return frame;
}

interface SpawnBridgeOptions {
  accessToken: string;
  rpcPath: string;
  url?: string;
  unary?: boolean;
}

function spawnBridge(options: SpawnBridgeOptions): BridgeHandle {
  debugLog("bridge.spawn", { rpcPath: options.rpcPath, url: options.url ?? CURSOR_API_URL, unary: options.unary ?? false });
  const proc = spawn("node", [BRIDGE_PATH], {
    stdio: ["pipe", "pipe", "ignore"],
  });

  const config = JSON.stringify({
    accessToken: options.accessToken,
    url: options.url ?? CURSOR_API_URL,
    path: options.rpcPath,
    unary: options.unary ?? false,
  });
  // Built before the config frame goes out, so even the very first write is covered by the
  // handle's error listeners rather than being able to throw at the host.
  const handle = createBridgeHandle(proc as unknown as BridgeStreams, {
    debug: (event, data) => debugLog(event, { rpcPath: options.rpcPath, ...data }),
  });
  handle.write(new TextEncoder().encode(config));
  return handle;
}

// ── Unary RPC (for model discovery) ──

export async function callCursorUnaryRpc(options: {
  accessToken: string;
  rpcPath: string;
  requestBody: Uint8Array;
  url?: string;
  timeoutMs?: number;
}): Promise<{ body: Uint8Array; exitCode: number; timedOut: boolean }> {
  const bridge = bridgeFactory({
    accessToken: options.accessToken,
    rpcPath: options.rpcPath,
    url: options.url,
    unary: true,
  });
  const chunks: Buffer[] = [];
  return new Promise((resolve) => {
    let timedOut = false, settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const settle = (exitCode:number) => {
      if(settled)return;settled=true;
      if(timeout)clearTimeout(timeout);
      resolve({body:Buffer.concat(chunks),exitCode,timedOut});
    };
    const timeoutMs = options.timeoutMs ?? 5_000;
    if(timeoutMs>0)timeout=setTimeout(()=>{timedOut=true;settle(1);bridge.destroy();},timeoutMs);

    bridge.onData((chunk) => { if(!settled)chunks.push(Buffer.from(chunk)); });
    bridge.onStatus?.(status=>{if(transportStatusError(status)){settle(1);bridge.destroy();}});
    bridge.onClose(settle);

    bridge.write(options.requestBody);
    bridge.end();
  });
}

// ── Model discovery ──

export interface CursorModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

let cachedModels: CursorModel[] | null = null;

export async function getCursorModels(apiKey: string): Promise<CursorModel[]> {
  if (cachedModels) return cachedModels;
  let failure = "unknown";
  try {
    const requestPayload = create(GetUsableModelsRequestSchema, {});
    const requestBody = toBinary(GetUsableModelsRequestSchema, requestPayload);
    const response = await callCursorUnaryRpc({
      accessToken: apiKey,
      rpcPath: "/agent.v1.AgentService/GetUsableModels",
      requestBody,
      // 5s is fine mid-session but not at process start, when the host is spawning
      // bridges and probing every account at once — a cold h2-bridge plus TLS handshake
      // routinely exceeds it there, and the caller mistook the empty result for an
      // account with no models.
      timeoutMs: 20_000,
    });
    if (!response.timedOut && response.exitCode === 0 && response.body.length > 0) {
      let decoded: any = null;
      try {
        decoded = fromBinary(GetUsableModelsResponseSchema, response.body);
      } catch {
        // Try Connect framing
        const body = decodeConnectUnaryBody(response.body);
        if (body) {
          try { decoded = fromBinary(GetUsableModelsResponseSchema, body); } catch {}
        }
      }
      if (decoded?.models?.length) {
        const models = normalizeCursorModels(decoded.models);
        if (models.length > 0) {
          cachedModels = models;
          return models;
        }
      }
      failure = `undecodable response (${response.body.length} bytes)`;
    } else {
      failure = `timedOut=${response.timedOut} exitCode=${response.exitCode} bytes=${response.body.length}`;
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    console.error("[cursor-provider] Model discovery failed:", failure);
  }
  console.warn("[cursor-provider] Model discovery returned no models");
  throw new Error(`GetUsableModels failed: ${failure}`);
}

function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | null {
  if (payload.length < 5) return null;
  let offset = 0;
  while (offset + 5 <= payload.length) {
    const flags = payload[offset]!;
    const view = new DataView(payload.buffer, payload.byteOffset + offset, payload.byteLength - offset);
    const messageLength = view.getUint32(1, false);
    const frameEnd = offset + 5 + messageLength;
    if (frameEnd > payload.length) return null;
    if ((flags & 0b0000_0001) !== 0) return null;
    if ((flags & 0b0000_0010) === 0) return payload.subarray(offset + 5, frameEnd);
    offset = frameEnd;
  }
  return null;
}

function normalizeCursorModels(models: readonly unknown[]): CursorModel[] {
  const byId = new Map<string, CursorModel>();
  for (const model of models) {
    const m = model as any;
    const id = m?.modelId?.trim?.();
    if (!id) continue;
    const name = m.displayName || m.displayNameShort || m.displayModelId || id;
    byId.set(id, {
      id,
      name,
      reasoning: Boolean(m.thinkingDetails),
      contextWindow: 200_000,
      maxTokens: 64_000,
    });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// ── Proxy server ──

export function getProxyPort(): number | undefined {
  return proxyPort;
}

export async function startProxy(
  getAccessToken: (req?: IncomingMessage) => Promise<string>,
): Promise<number> {
  proxyAccessTokenProvider = getAccessToken;
  if (proxyServer && proxyPort) return proxyPort;

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost`);
      const requestId = nextDebugRequestId();
      // Same rule as the bridge pipe: a socket that dies under us is a logged event, never an
      // uncaught exception in the host process.
      res.on("error", (error) => debugLog("http.response_error", { requestId, error: String(error) }));
      req.on("error", (error) => debugLog("http.request_error", { requestId, error: String(error) }));
      debugLog("http.request", { requestId, method: req.method, pathname: url.pathname, headers: req.headers });

      if (req.method === "GET" && url.pathname === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [] }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        try {
          const body = await readBody(req);
          const parsed = JSON.parse(body) as ChatCompletionRequest;
          debugLog("http.chat.body", { requestId, body: parsed });
          if (!proxyAccessTokenProvider) throw new Error("No access token provider");
          // The request is handed to the provider so a multi-account host can pick the
          // account THIS request authenticated as. Single-account callers ignore it.
          const accessToken = await proxyAccessTokenProvider(req);
          await handleChatCompletion(parsed, accessToken, req, res, requestId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          debugLog("http.chat.error", { requestId, message, stack: err instanceof Error ? err.stack : undefined });
          // Streaming may already have sent headers — writing them again throws from inside
          // the catch, and that throw escapes as an unhandled rejection.
          if (res.headersSent || res.writableEnded) {
            if (!res.writableEnded) res.end();
            return;
          }
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message, type: "server_error", code: "internal_error" } }));
        }
        return;
      }

      res.writeHead(404);
      res.end("Not Found");
    });

    server.on("clientError", (error, socket) => {
      debugLog("http.client_error", { error: String(error) });
      socket.destroy();
    });
    server.on("error", (error) => debugLog("http.server_error", { error: String(error) }));

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) {
        proxyPort = addr.port;
        proxyServer = server;
        // The listener is process-scoped, not session-scoped. Do not let an idle
        // one-shot Pi process hang just because the proxy is ready; the OS will
        // close it when the process exits. This also lets the listener survive
        // `/new` and other in-process session changes.
        server.unref();
        debugLog("proxy.start", { port: proxyPort, debugLogFile: isProxyDebugEnabled() ? getDebugLogFilePath() : undefined });
        resolve(proxyPort);
      } else {
        reject(new Error("Failed to bind proxy"));
      }
    });
  });
}

export function cleanupAllSessionState(): void {
  debugLog("session.cleanup_all", { activeBridgeCount: activeBridges.size, conversationCount: conversationStates.size });
  for (const [bridgeKey, active] of activeBridges) {
    cleanupBridge(active.bridge, active.heartbeatTimer, bridgeKey);
  }
  clearConversationRegistry();
}

export function stopProxy(): void {
  debugLog("proxy.stop", { port: proxyPort });
  if (proxyServer) {
    proxyServer.close();
    proxyServer = undefined;
    proxyPort = undefined;
    proxyAccessTokenProvider = undefined;
  }
  cleanupAllSessionState();
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ── Request handling ──

export function evictStaleConversations(now = Date.now()): void {
  for (const [key, stored] of conversationStates) {
    if (!stored.sessionScoped && now - stored.lastAccessMs > CONVERSATION_TTL_MS) {
      debugLog("conversation.evict", { key, stored, now });
      conversationStates.delete(key);
    }
  }
}

/**
 * Insert reasoning effort into model ID, before -fast/-thinking suffix.
 * e.g. model="gpt-5.4" + effort="medium" → "gpt-5.4-medium"
 *      model="gpt-5.4-fast" + effort="high" → "gpt-5.4-high-fast"
 * If no effort provided, returns model as-is.
 */
export function resolveModelId(model: string, reasoningEffort?: string): string {
  if (!reasoningEffort) return model;

  let suffix = "";
  let base = model;
  if (base.endsWith("-fast")) {
    suffix = "-fast";
    base = base.slice(0, -5);
  } else if (base.endsWith("-thinking")) {
    suffix = "-thinking";
    base = base.slice(0, -9);
  }

  return `${base}-${reasoningEffort}${suffix}`;
}

/**
 * Effort-folded ids ("cursor-grok-4.6") exist only in this provider's registry — Cursor's
 * API knows the suffixed variants ("cursor-grok-4.6-medium"). A request without an effort
 * (e.g. thinking off) would otherwise be sent under the bare folded id and die with
 * `not_found`. Map it to the closest variant the account actually listed.
 */
const EFFORT_FALLBACK_ORDER = ["medium", "high", "low", "xhigh", "max", "none"];

export function resolveUsableModelId(modelId: string): string {
  const known = cachedModels;
  if (!known || known.length === 0) return modelId;
  if (known.some((m) => m.id === modelId)) return modelId;
  let suffix = "";
  let base = modelId;
  if (base.endsWith("-fast")) {
    suffix = "-fast";
    base = base.slice(0, -5);
  } else if (base.endsWith("-thinking")) {
    suffix = "-thinking";
    base = base.slice(0, -9);
  }
  for (const effort of EFFORT_FALLBACK_ORDER) {
    const candidate = `${base}-${effort}${suffix}`;
    if (known.some((m) => m.id === candidate)) return candidate;
  }
  return modelId;
}

async function handleChatCompletion(
  body: ChatCompletionRequest,
  accessToken: string,
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
): Promise<void> {
  const parsed = parseMessages(body.messages);
  const { systemPrompt, userText, turns, toolResults } = parsed;
  const modelId = resolveUsableModelId(resolveModelId(body.model, body.reasoning_effort));
  const tools = body.tools ?? [];

  debugLog("chat.parsed_messages", {
    requestId,
    systemPrompt,
    userText,
    turns,
    toolResults,
    messageCount: body.messages.length,
    model: body.model,
    resolvedModelId: modelId,
    stream: body.stream !== false,
  });

  if (!userText && toolResults.length === 0) {
    debugLog("chat.no_user_message", { requestId, messages: body.messages });
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "No user message found", type: "invalid_request_error" } }));
    return;
  }

  const explicitSessionId = derivePiSessionId(body);
  // Prompt text is not caller identity. Direct/background calls without an owner
  // id get isolated state, even when two projects have identical prompt prefixes.
  const sessionId = explicitSessionId ?? `isolated:${crypto.randomUUID()}`;
  const workspaceCwd = typeof body.pi_cwd === "string" && isAbsolute(body.pi_cwd) ? body.pi_cwd : undefined;
  const bridgeKey = deriveBridgeKey(body.messages, sessionId);
  const convKey = deriveConversationKey(body.messages, sessionId);
  let activeBridge = activeBridges.get(bridgeKey);
  let stored = conversationStates.get(convKey);
  if ((stored && (stored.workspaceCwd !== workspaceCwd || isStaleForTranscript(stored, body.messages))) ||
      (activeBridge?.receipt && !ownsConversation(convKey,activeBridge.receipt))) {
    forgetConversation(convKey);
    if(activeBridge)cleanupBridge(activeBridge.bridge,activeBridge.heartbeatTimer,bridgeKey);
    activeBridge=undefined;stored=undefined;
    debugLog("conversation.stale_checkpoint", {requestId,convKey});
  }
  debugLog("chat.session_keys", {
    requestId,
    sessionId,
    bridgeKey,
    convKey,
    hasActiveBridge: !!activeBridge,
  });

  const promptTokens = estimatePromptTokens(body.messages, body.tools);

  if (activeBridge && activeBridge.paused !== false && toolResults.length > 0) {
    if(stored)coverTranscript(stored,body.messages);
    debugLog("chat.resume_tool_results", { requestId, bridgeKey, toolResults, pendingExecs: activeBridge.pendingExecs });
    activeBridges.delete(bridgeKey);
    if (activeBridge.bridge.alive) {
      handleToolResultResume(activeBridge, toolResults, modelId, bridgeKey, convKey, turns, req, res, body.stream !== false, requestId, promptTokens);
      return;
    }
    cleanupBridge(activeBridge.bridge, activeBridge.heartbeatTimer, bridgeKey);
  }

  if (activeBridge && activeBridges.has(bridgeKey)) {
    cleanupBridge(activeBridge.bridge, activeBridge.heartbeatTimer, bridgeKey);
  }

  debugLog("chat.stored_state.before", { requestId, convKey, stored });
  if (!stored) {
    stored = {
      conversationId: deterministicConversationId(convKey),
      checkpoint: null,

      sessionScoped: !!explicitSessionId,
      workspaceCwd,
      blobStore: new Map(),
      lastAccessMs: Date.now(),
      turnsCovered: parsed.turns.length,
    };
    conversationStates.set(convKey, stored);
  }
  stored.turnsCovered = parsed.turns.length;
  coverTranscript(stored,body.messages);
  stored.lastAccessMs = Date.now();
  evictStaleConversations();

  const mcpTools = buildMcpToolDefinitions(tools);
  // Cursor's own conversation is not available here, so the whole session is replayed from
  // Pi's transcript. The turn that is still in flight — the assistant's tool calls and the
  // results that just came back — is part of that history: dropping it and re-sending the
  // original question makes the model redo work it already did, and dropping the question and
  // sending raw tool output leaves it with no task at all.
  const rebuiltTurns = historyForRebuild(parsed);
  const hasCheckpoint = !!stored.checkpoint;
  const effectiveUserText = requestActionText(parsed, { hasCheckpoint });
  const effectiveSystemPrompt = systemPromptForRebuild(systemPrompt, parsed, { hasCheckpoint });
  if (!stored.checkpoint) {
    debugLog("chat.no_checkpoint", { requestId, convKey, conversationId: stored.conversationId });
  }
  const payload = buildCursorRequest(
    modelId, effectiveSystemPrompt, effectiveUserText, rebuiltTurns,
    stored.conversationId, stored.checkpoint, stored.blobStore, workspaceCwd,
  );
  debugLog("chat.cursor_request", {
    requestId,
    conversationId: stored.conversationId,
    effectiveUserText,
    restoredSystemPromptChars: effectiveSystemPrompt.length - systemPrompt.length,
    turnCount: turns.length,
    hasCheckpoint,
    payload,
  });
  payload.mcpTools = mcpTools;

  const currentTurn: ParsedTurn = {
    userText: effectiveUserText,
    steps: [],
  };

  if (body.stream === false) {
    debugLog("chat.dispatch_nonstream", { requestId, convKey });
    handleStreamingResponse(payload, accessToken, modelId, bridgeKey, convKey, turns, currentTurn, req, res, requestId, promptTokens, false);
  } else {
    debugLog("chat.dispatch_stream", { requestId, bridgeKey, convKey });
    handleStreamingResponse(payload, accessToken, modelId, bridgeKey, convKey, turns, currentTurn, req, res, requestId, promptTokens);
  }
}

// ── Message parsing ──

function getTurnToolCallResults(turn: ParsedTurn): Map<string, ParsedToolResult> {
  const results = new Map<string, ParsedToolResult>();
  for (const step of turn.steps) {
    if (step.kind === "toolCall" && step.result) results.set(step.toolCallId, step.result);
  }
  return results;
}

function appendAssistantTextToTurn(turn: ParsedTurn, text: string): void {
  if (!text) return;
  const last = turn.steps.at(-1);
  if (last?.kind === "assistantText") {
    last.text += text;
  } else {
    turn.steps.push({ kind: "assistantText", text });
  }
}

export function parseMessages(messages: OpenAIMessage[]): ParsedMessages {
  return parseMessagesPure(messages, debugLog);
}

// ── Tool definitions ──

function buildMcpToolDefinitions(tools: OpenAIToolDef[]): McpToolDefinition[] {
  return tools.map((t) => {
    const fn = t.function;
    const jsonSchema: JsonValue = fn.parameters && typeof fn.parameters === "object"
      ? (fn.parameters as JsonValue)
      : { type: "object", properties: {}, required: [] };
    const inputSchema = toBinary(ValueSchema, fromJson(ValueSchema, jsonSchema));
    return create(McpToolDefinitionSchema, {
      name: fn.name,
      description: fn.description || "",
      providerIdentifier: "pi",
      toolName: fn.name,
      inputSchema,
    });
  });
}

function decodeMcpArgValue(value: Uint8Array): unknown {
  try {
    const parsed = fromBinary(ValueSchema, value);
    return toJson(ValueSchema, parsed);
  } catch {}
  return new TextDecoder().decode(value);
}

function decodeMcpArgsMap(args: Record<string, Uint8Array>): Record<string, unknown> {
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) decoded[key] = decodeMcpArgValue(value);
  return decoded;
}

// ── Build Cursor protobuf request ──

function encodeMcpArgValue(value: unknown): Uint8Array {
  try {
    return toBinary(ValueSchema, fromJson(ValueSchema, value as JsonValue));
  } catch {
    return new TextEncoder().encode(String(value));
  }
}

function encodeMcpArgsMap(args: Record<string, unknown>): Record<string, Uint8Array> {
  const encoded: Record<string, Uint8Array> = {};
  for (const [key, value] of Object.entries(args)) encoded[key] = encodeMcpArgValue(value);
  return encoded;
}

// No generated schema for selectedContextBlob; emit raw wire format for the two
// fields Cursor actually reads: field 1 (repeated bytes) rootPromptMessagesJson
// refs, field 22 (string) clientName. blobId.length < 128 (SHA256 = 32 bytes).
function buildSelectedContextBlob(rootPromptBlobIds: Uint8Array[], clientName: string): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const blobId of rootPromptBlobIds) {
    parts.push(new Uint8Array([0x0A, blobId.length, ...blobId]));
  }
  const clientBytes = new TextEncoder().encode(clientName);
  parts.push(new Uint8Array([0xB2, 0x01, clientBytes.length, ...clientBytes]));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { result.set(p, offset); offset += p.length; }
  return result;
}

function storeAsBlob(data: Uint8Array, blobStore: Map<string, Uint8Array>): Uint8Array {
  const id = new Uint8Array(createHash("sha256").update(data).digest());
  blobStore.set(Buffer.from(id).toString("hex"), data);
  return id;
}

function createUserMessage(text: string, selectedContextBlob: Uint8Array): UserMessage {
  const messageId = crypto.randomUUID();
  return create(UserMessageSchema, {
    text,
    messageId,
    selectedContext: create(SelectedContextSchema, {}),
    mode: 1,
    selectedContextBlob,
    correlationId: messageId,
  });
}

function buildTurnStepBytes(step: ParsedTurnStep): Uint8Array {
  if (step.kind === "assistantText") {
    return toBinary(ConversationStepSchema, create(ConversationStepSchema, {
      message: {
        case: "assistantMessage",
        value: create(AssistantMessageSchema, { text: step.text }),
      },
    }));
  }

  const toolName = step.toolName || "tool";
  const mcpToolCall = create(McpToolCallSchema, {
    args: create(McpArgsSchema, {
      name: toolName,
      args: encodeMcpArgsMap(step.arguments),
      toolCallId: step.toolCallId,
      providerIdentifier: "pi",
      toolName,
    }),
    ...(step.result && {
      result: create(McpResultSchema, {
        result: step.result.isError
          ? {
              case: "error",
              value: create(McpErrorSchema, { error: step.result.content }),
            }
          : {
              case: "success",
              value: create(McpSuccessSchema, {
                content: [
                  create(McpToolResultContentItemSchema, {
                    content: {
                      case: "text",
                      value: create(McpTextContentSchema, { text: step.result.content }),
                    },
                  }),
                ],
                isError: false,
              }),
            },
      }),
    }),
  });

  return toBinary(ConversationStepSchema, create(ConversationStepSchema, {
    message: {
      case: "toolCall",
      value: create(ToolCallSchema, {
        tool: {
          case: "mcpToolCall",
          value: mcpToolCall,
        },
      }),
    },
  }));
}

export function buildCursorRequest(
  modelId: string,
  systemPrompt: string,
  userText: string,
  turns: ParsedTurn[],
  conversationId: string,
  checkpoint: Uint8Array | null,
  existingBlobStore?: Map<string, Uint8Array>,
  workspaceCwd?: string,
): CursorRequestPayload {
  debugLog("cursor_request.build.start", {
    modelId,
    systemPrompt,
    userText,
    turns,
    conversationId,
    checkpoint,
    existingBlobStore,
  });
  const blobStore = new Map<string, Uint8Array>(existingBlobStore ?? []);

  const systemBytes = new TextEncoder().encode(JSON.stringify({ role: "system", content: systemPrompt }));
  const systemBlobId = storeAsBlob(systemBytes, blobStore);
  const selectedCtxBlob = storeAsBlob(
    buildSelectedContextBlob([systemBlobId], "pi"), blobStore,
  );

  let conversationState;
  if (checkpoint) {
    conversationState = fromBinary(ConversationStateStructureSchema, checkpoint);
  } else {
    const turnBlobIds: Uint8Array[] = [];
    for (const turn of turns) {
      const userMsg = createUserMessage(turn.userText, selectedCtxBlob);
      const userMsgBlobId = storeAsBlob(toBinary(UserMessageSchema, userMsg), blobStore);
      const stepBlobIds = turn.steps.map(s => storeAsBlob(buildTurnStepBytes(s), blobStore));

      const agentTurn = create(AgentConversationTurnStructureSchema, {
        userMessage: userMsgBlobId,
        steps: stepBlobIds,
        requestId: crypto.randomUUID(),
      });
      const turnStructure = create(ConversationTurnStructureSchema, {
        turn: { case: "agentConversationTurn", value: agentTurn },
      });
      turnBlobIds.push(storeAsBlob(toBinary(ConversationTurnStructureSchema, turnStructure), blobStore));
    }

    conversationState = create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: [systemBlobId],
      turns: turnBlobIds,
      todos: [],
      pendingToolCalls: [],
      previousWorkspaceUris: workspaceCwd ? [pathToFileURL(workspaceCwd).href] : [],
      mode: 1,
      fileStates: {},
      fileStatesV2: {},
      summaryArchives: [],
      turnTimings: [],
      subagentStates: {},
      selfSummaryCount: 0,
      readPaths: [],
      clientName: "pi",
    });
  }

  const userMessage = createUserMessage(userText, selectedCtxBlob);
  const action = create(ConversationActionSchema, {
    action: { case: "userMessageAction", value: create(UserMessageActionSchema, { userMessage }) },
  });
  const modelDetails = create(ModelDetailsSchema, { modelId, displayModelId: modelId, displayName: modelId });
  const runRequest = create(AgentRunRequestSchema, { conversationState, action, modelDetails, conversationId });
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "runRequest", value: runRequest },
  });

  const payload = { requestBytes: toBinary(AgentClientMessageSchema, clientMessage), blobStore, mcpTools: [] };
  debugLog("cursor_request.build.end", payload);
  return payload;
}

// ── Server message processing ──

function processServerMessage(
  msg: AgentServerMessage,
  blobStore: Map<string, Uint8Array>,
  mcpTools: McpToolDefinition[],
  sendFrame: (data: Uint8Array) => void,
  state: StreamState,
  onText: (text: string, isThinking?: boolean) => void,
  onMcpExec: (exec: PendingExec) => void,
  onCheckpoint?: (checkpointBytes: Uint8Array) => void,
  onTurnEnded?: () => void,
): CursorFrameClass {
  const msgCase = msg.message.case;
  const updateCase = msgCase === "interactionUpdate" ? (msg.message.value as { message?: { case?: string } }).message?.case : undefined;
  const execCase = msgCase === "execServerMessage" ? (msg.message.value as { message?: { case?: string } }).message?.case : undefined;
  let classified = classifyCursorFrame({ messageCase: msgCase, updateCase, execCase });
  debugLog("server_message", { msgCase, updateCase, execCase, classified });

  if (msgCase === "interactionUpdate") {
    const update = msg.message.value as any;
    if (updateCase === "textDelta") {
      const delta = update.message.value.text || "";
      if (delta) onText(delta, false);
    } else if (updateCase === "thinkingDelta") {
      const delta = update.message.value.text || "";
      if (delta) onText(delta, true);
    } else if (updateCase === "tokenDelta") {
      state.outputTokens += update.message.value.tokens ?? 0;
    } else if (classified.completesTurn) {
      onTurnEnded?.();
    }
  } else if (msgCase === "kvServerMessage") {
    handleKvMessage(msg.message.value as KvServerMessage, blobStore, sendFrame);
  } else if (msgCase === "execServerMessage") {
    if (handleExecMessage(msg.message.value as ExecServerMessage, mcpTools, sendFrame, onMcpExec)) {
      classified = { kind: execCase === "mcpArgs" ? "mcpExec" : "nativeExec", countsAsProgress: true, completesTurn: false };
    }
  } else if (msgCase === "conversationCheckpointUpdate") {
    const stateStructure = msg.message.value as ConversationStateStructure;
    if ((stateStructure as any).tokenDetails) {
      state.totalTokens = (stateStructure as any).tokenDetails.usedTokens;
    }
    if (onCheckpoint) {
      onCheckpoint(toBinary(ConversationStateStructureSchema, stateStructure));
    }
  } else if (msgCase === "interactionQuery") {
    handleInteractionQuery(msg.message.value as InteractionQuery, sendFrame);
  } else if (msgCase === "execServerControlMessage") {
    debugLog("exec.control", { control: (msg.message.value as { message?: { case?: string } }).message?.case });
  }
  return classified;
}

function sendKvResponse(
  kvMsg: KvServerMessage,
  messageCase: string,
  value: unknown,
  sendFrame: (data: Uint8Array) => void,
): void {
  const response = create(KvClientMessageSchema, {
    id: (kvMsg as any).id,
    message: { case: messageCase as any, value: value as any },
  });
  const clientMsg = create(AgentClientMessageSchema, {
    message: { case: "kvClientMessage", value: response },
  });
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMsg)));
}

function handleKvMessage(
  kvMsg: KvServerMessage,
  blobStore: Map<string, Uint8Array>,
  sendFrame: (data: Uint8Array) => void,
): void {
  const kvCase = (kvMsg as any).message.case;
  if (kvCase === "getBlobArgs") {
    const blobId = (kvMsg as any).message.value.blobId;
    const blobIdKey = Buffer.from(blobId).toString("hex");
    const blobData = blobStore.get(blobIdKey);
    // A blob we do not hold is answered with an empty result and no error, so a hole in the
    // conversation looks exactly like a healthy one. Never let that be silent again.
    if (!blobData) {
      debugLog("kv.blob_miss", { blobIdKey, knownBlobs: blobStore.size });
    }
    sendKvResponse(kvMsg, "getBlobResult", create(GetBlobResultSchema, blobData ? { blobData } : {}), sendFrame);
  } else if (kvCase === "setBlobArgs") {
    const { blobId, blobData } = (kvMsg as any).message.value;
    blobStore.set(Buffer.from(blobId).toString("hex"), blobData);
    sendKvResponse(kvMsg, "setBlobResult", create(SetBlobResultSchema, {}), sendFrame);
  }
}

function piToolNames(mcpTools: McpToolDefinition[]): Set<string> {
  const names = new Set<string>();
  for (const tool of mcpTools) {
    if (tool.name) names.add(tool.name);
    if (tool.toolName) names.add(tool.toolName);
  }
  return names;
}

function handleInteractionQuery(query: InteractionQuery, sendFrame: (data: Uint8Array) => void): void {
  const queryCase = query.query.case;
  const reason = NATIVE_TOOL_UNAVAILABLE;
  let result: InteractionResponse["result"];
  switch (queryCase) {
    case "webSearchRequestQuery":
      result = {
        case: "webSearchRequestResponse",
        value: create(WebSearchRequestResponseSchema, {
          result: { case: "rejected", value: create(WebSearchRequestResponse_RejectedSchema, { reason }) },
        }),
      };
      break;
    case "askQuestionInteractionQuery":
      result = {
        case: "askQuestionInteractionResponse",
        value: create(AskQuestionInteractionResponseSchema, {
          result: create(AskQuestionResultSchema, {
            result: { case: "rejected", value: create(AskQuestionRejectedSchema, { reason }) },
          }),
        }),
      };
      break;
    case "switchModeRequestQuery":
      result = {
        case: "switchModeRequestResponse",
        value: create(SwitchModeRequestResponseSchema, {
          result: { case: "rejected", value: create(SwitchModeRequestResponse_RejectedSchema, { reason }) },
        }),
      };
      break;
    case "exaSearchRequestQuery":
      result = {
        case: "exaSearchRequestResponse",
        value: create(ExaSearchRequestResponseSchema, {
          result: { case: "rejected", value: create(ExaSearchRequestResponse_RejectedSchema, { reason }) },
        }),
      };
      break;
    case "exaFetchRequestQuery":
      result = {
        case: "exaFetchRequestResponse",
        value: create(ExaFetchRequestResponseSchema, {
          result: { case: "rejected", value: create(ExaFetchRequestResponse_RejectedSchema, { reason }) },
        }),
      };
      break;
    case "createPlanRequestQuery":
      result = {
        case: "createPlanRequestResponse",
        value: create(CreatePlanRequestResponseSchema, {
          result: create(CreatePlanResultSchema, {
            planUri: "",
            result: { case: "error", value: create(CreatePlanErrorSchema, { error: reason }) },
          }),
        }),
      };
      break;
    case "setupVmEnvironmentArgs":
      result = {
        case: "setupVmEnvironmentResult",
        value: create(SetupVmEnvironmentResultSchema, {
          result: { case: "success", value: create(SetupVmEnvironmentSuccessSchema, {}) },
        }),
      };
      break;
    case undefined:
      debugLog("interaction_query.unhandled", { queryCase });
      return;
    default: {
      const _never: never = queryCase;
      debugLog("interaction_query.unhandled", { queryCase: _never });
      return;
    }
  }
  const response = create(InteractionResponseSchema, { id: query.id, result });
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, {
    message: { case: "interactionResponse", value: response },
  }))));
}

function handleExecMessage(
  execMsg: ExecServerMessage,
  mcpTools: McpToolDefinition[],
  sendFrame: (data: Uint8Array) => void,
  onMcpExec: (exec: PendingExec) => void,
): boolean {
  const execCase = (execMsg as any).message.case;
  const REJECT_REASON = NATIVE_TOOL_UNAVAILABLE;

  if (execCase === "requestContextArgs") {
    const requestContext = create(RequestContextSchema, {
      rules: [], repositoryInfo: [], tools: mcpTools, gitRepos: [],
      projectLayouts: [], mcpInstructions: [], fileContents: {}, customSubagents: [],
    });
    const result = create(RequestContextResultSchema, {
      result: { case: "success", value: create(RequestContextSuccessSchema, { requestContext }) },
    });
    sendExecResult(execMsg, "requestContextResult", result, sendFrame);
    return false;
  }

  if (execCase === "mcpArgs") {
    const mcpArgs = (execMsg as any).message.value;
    const decoded = decodeMcpArgsMap(mcpArgs.args ?? {});
    onMcpExec({
      execId: (execMsg as any).execId,
      execMsgId: (execMsg as any).id,
      toolCallId: mcpArgs.toolCallId || crypto.randomUUID(),
      toolName: mcpArgs.toolName || mcpArgs.name,
      decodedArgs: JSON.stringify(decoded),
      resultCase: "mcpResult",
    });
    return true;
  }

  const nativeArgs = protoRecord((execMsg as any).message.value);
  const mapped = mapNativeExecToPiTool(String(execCase ?? ""), nativeArgs, piToolNames(mcpTools));
  if (mapped) {
    onMcpExec({
      execId: (execMsg as any).execId,
      execMsgId: (execMsg as any).id,
      toolCallId: typeof nativeArgs.toolCallId === "string" && nativeArgs.toolCallId
        ? nativeArgs.toolCallId
        : crypto.randomUUID(),
      toolName: mapped.toolName,
      decodedArgs: JSON.stringify(mapped.args),
      resultCase: mapped.resultCase,
      nativeArgs,
    });
    return true;
  }

  if (execCase === "readArgs") {
    const args = (execMsg as any).message.value;
    sendExecResult(execMsg, "readResult", create(ReadResultSchema, {
      result: { case: "rejected", value: create(ReadRejectedSchema, { path: args.path, reason: REJECT_REASON }) },
    }), sendFrame);
    return false;
  }
  if (execCase === "lsArgs") {
    const args = (execMsg as any).message.value;
    sendExecResult(execMsg, "lsResult", create(LsResultSchema, {
      result: { case: "rejected", value: create(LsRejectedSchema, { path: args.path, reason: REJECT_REASON }) },
    }), sendFrame);
    return false;
  }
  if (execCase === "grepArgs") {
    sendExecResult(execMsg, "grepResult", create(GrepResultSchema, {
      result: { case: "error", value: create(GrepErrorSchema, { error: REJECT_REASON }) },
    }), sendFrame);
    return false;
  }
  if (execCase === "writeArgs") {
    const args = (execMsg as any).message.value;
    sendExecResult(execMsg, "writeResult", create(WriteResultSchema, {
      result: { case: "rejected", value: create(WriteRejectedSchema, { path: args.path, reason: REJECT_REASON }) },
    }), sendFrame);
    return false;
  }
  if (execCase === "deleteArgs") {
    const args = (execMsg as any).message.value;
    sendExecResult(execMsg, "deleteResult", create(DeleteResultSchema, {
      result: { case: "rejected", value: create(DeleteRejectedSchema, { path: args.path, reason: REJECT_REASON }) },
    }), sendFrame);
    return false;
  }
  if (execCase === "shellArgs") {
    const args = (execMsg as any).message.value;
    sendExecResult(execMsg, "shellResult", create(ShellResultSchema, {
      result: { case: "rejected", value: create(ShellRejectedSchema, {
        command: args.command ?? "", workingDirectory: args.workingDirectory ?? "",
        reason: REJECT_REASON, isReadonly: false,
      }) },
    }), sendFrame);
    return false;
  }
  if (execCase === "shellStreamArgs") {
    const args = (execMsg as any).message.value;
    sendExecResult(execMsg, "shellStream", create(ShellStreamSchema, {
      event: { case: "rejected", value: create(ShellRejectedSchema, {
        command: args.command ?? "", workingDirectory: args.workingDirectory ?? "",
        reason: REJECT_REASON, isReadonly: false,
      }) },
    }), sendFrame);
    return false;
  }
  if (execCase === "backgroundShellSpawnArgs") {
    const args = (execMsg as any).message.value;
    sendExecResult(execMsg, "backgroundShellSpawnResult", create(BackgroundShellSpawnResultSchema, {
      result: { case: "rejected", value: create(ShellRejectedSchema, {
        command: args.command ?? "", workingDirectory: args.workingDirectory ?? "",
        reason: REJECT_REASON, isReadonly: false,
      }) },
    }), sendFrame);
    return false;
  }
  if (execCase === "writeShellStdinArgs") {
    sendExecResult(execMsg, "writeShellStdinResult", create(WriteShellStdinResultSchema, {
      result: { case: "error", value: create(WriteShellStdinErrorSchema, { error: REJECT_REASON }) },
    }), sendFrame);
    return false;
  }
  if (execCase === "fetchArgs") {
    const args = (execMsg as any).message.value;
    sendExecResult(execMsg, "fetchResult", create(FetchResultSchema, {
      result: { case: "error", value: create(FetchErrorSchema, { url: args.url ?? "", error: REJECT_REASON }) },
    }), sendFrame);
    return false;
  }
  if (execCase === "diagnosticsArgs") {
    sendExecResult(execMsg, "diagnosticsResult", create(DiagnosticsResultSchema, {}), sendFrame);
    return false;
  }

  const miscCaseMap: Record<string, string> = {
    listMcpResourcesExecArgs: "listMcpResourcesExecResult",
    readMcpResourceExecArgs: "readMcpResourceExecResult",
    recordScreenArgs: "recordScreenResult",
    computerUseArgs: "computerUseResult",
  };
  const resultCase = miscCaseMap[execCase as string];
  if (resultCase) {
    sendExecResult(execMsg, resultCase, create(McpResultSchema, {}), sendFrame);
    return false;
  }

  throwUnhandledExec(execMsg, execCase, sendFrame);
  return false;
}

function throwUnhandledExec(
  execMsg: ExecServerMessage,
  execCase: unknown,
  sendFrame: (data: Uint8Array) => void,
): void {
  console.error(`[cursor-provider] UNHANDLED exec case: "${String(execCase)}". Rejecting so the bridge cannot stall.`);
  const control = create(ExecClientControlMessageSchema, {
    message: {
      case: "throw",
      value: create(ExecClientThrowSchema, {
        id: (execMsg as any).id,
        error: `${NATIVE_TOOL_UNAVAILABLE} (unhandled ${String(execCase ?? "exec")})`,
      }),
    },
  });
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, {
    message: { case: "execClientControlMessage", value: control },
  }))));
}

function sendExecResult(
  execMsg: ExecServerMessage,
  messageCase: string,
  value: unknown,
  sendFrame: (data: Uint8Array) => void,
): void {
  const execClientMessage = create(ExecClientMessageSchema, {
    id: (execMsg as any).id,
    execId: (execMsg as any).execId,
    message: { case: messageCase as any, value: value as any },
  });
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "execClientMessage", value: execClientMessage },
  });
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
  if (messageCase === "shellStream") {
    const event = (value as ShellStream).event.case;
    if (event === "exit" || event === "rejected" || event === "permissionDenied" || event === "backgrounded") {
      // The exit event describes the process, not the end of the streaming exec
      // RPC. Without streamClose Cursor keeps draining that RPC forever while
      // Run heartbeats continue, so Pi stalls after an already completed bash.
      sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, {
        message: {
          case: "execClientControlMessage",
          value: create(ExecClientControlMessageSchema, {
            message: { case: "streamClose", value: create(ExecClientStreamCloseSchema, { id: execMsg.id }) },
          }),
        },
      }))));
      debugLog("exec.stream_closed", { execMsgId: execMsg.id, execId: execMsg.execId, terminalEvent: event });
    }
  }
}

function sendPendingExecResult(
  exec: PendingExec,
  value: unknown,
  sendFrame: (data: Uint8Array) => void,
): void {
  sendExecResult(
    { id: exec.execMsgId, execId: exec.execId } as ExecServerMessage,
    exec.resultCase ?? "mcpResult",
    value,
    sendFrame,
  );
}

function protoRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return { ...(value as Record<string, unknown>) };
}

function nativePath(exec: PendingExec): string {
  const path = exec.nativeArgs?.path;
  return typeof path === "string" ? path : "";
}

function resumePendingExecWithToolResult(
  exec: PendingExec,
  content: string,
  isError: boolean,
  sendFrame: (data: Uint8Array) => void,
): void {
  try {
    resumePendingExecWithToolResultUnchecked(exec, content, isError, sendFrame);
  } catch (err) {
    console.error("[cursor-provider] Failed to encode tool result; throwing so Cursor cannot wait forever:", err instanceof Error ? err.message : err);
    throwUnhandledExec(
      { id: exec.execMsgId, execId: exec.execId } as ExecServerMessage,
      exec.resultCase,
      sendFrame,
    );
  }
}

function resumePendingExecWithToolResultUnchecked(
  exec: PendingExec,
  content: string,
  isError: boolean,
  sendFrame: (data: Uint8Array) => void,
): void {
  const resultCase = exec.resultCase ?? "mcpResult";
  if (resultCase === "mcpResult") {
    sendPendingExecResult(exec, create(McpResultSchema, {
      result: {
        case: "success",
        value: create(McpSuccessSchema, {
          content: [
            create(McpToolResultContentItemSchema, {
              content: { case: "text", value: create(McpTextContentSchema, { text: content }) },
            }),
          ],
          isError,
        }),
      },
    }), sendFrame);
    return;
  }
  if (resultCase === "readResult") {
    const path = nativePath(exec);
    // Native ReadArgs requests a whole file (it has no offset/limit fields). Pi's read is
    // bounded. Claiming that its partial output is complete makes Cursor repeat the same
    // native read forever instead of using the exposed MCP read tool's paging arguments.
    const partial = /\n\n\[(?:Showing lines \d+-\d+ of \d+(?: \([^\]\n]+ limit\))?|\d+ more lines in file)\. Use offset=\d+ to continue\.\]$/.exec(content);
    if (!isError && partial) {
      isError = true;
      content = `Native whole-file read is incomplete. Use the exposed MCP read tool with offset/limit instead of repeating this native read. ${partial[0].trim()}`;
    } else if (!isError && /^\[Line \d+ is [^\n]+, exceeds [^\n]+ limit\. Use bash: /.test(content)) {
      isError = true;
      content = "Pi could not read this oversized line. Use another available authorized tool or report the limitation; this is not complete file content.";
    }
    sendPendingExecResult(exec, create(ReadResultSchema, isError
      ? { result: { case: "error", value: create(ReadErrorSchema, { path, error: content }) } }
      : {
        result: {
          case: "success",
          value: create(ReadSuccessSchema, {
            path,
            totalLines: content.split("\n").length,
            fileSize: BigInt(Buffer.byteLength(content)),
            truncated: false,
            output: { case: "content", value: content },
          }),
        },
      }), sendFrame);
    return;
  }
  if (resultCase === "writeResult") {
    const path = nativePath(exec);
    const writtenText = typeof exec.nativeArgs?.fileText === "string" ? exec.nativeArgs.fileText : typeof exec.nativeArgs?.content === "string" ? exec.nativeArgs.content : undefined;
    sendPendingExecResult(exec, create(WriteResultSchema, isError
      ? { result: { case: "error", value: create(WriteErrorSchema, { path, error: content }) } }
      : {
        result: {
          case: "success",
          value: create(WriteSuccessSchema, {
            path,
            ...(writtenText === undefined ? {} : {
              linesCreated: writtenText.split("\n").length,
              fileSize: Buffer.byteLength(writtenText),
              fileContentAfterWrite: writtenText,
            }),
          }),
        },
      }), sendFrame);
    return;
  }
  if (resultCase === "deleteResult") {
    const path = nativePath(exec);
    sendPendingExecResult(exec, create(DeleteResultSchema, isError
      ? { result: { case: "error", value: create(DeleteErrorSchema, { path, error: content }) } }
      : {
        result: {
          case: "success",
          value: create(DeleteSuccessSchema, {
            path,
            deletedFile: path,
            fileSize: 0n,
            prevContent: "",
          }),
        },
      }), sendFrame);
    return;
  }
  if (resultCase === "grepResult") {
    const pattern = typeof exec.nativeArgs?.pattern === "string" ? exec.nativeArgs.pattern : "";
    const path = nativePath(exec) || ".";
    sendPendingExecResult(exec, create(GrepResultSchema, isError
      ? { result: { case: "error", value: create(GrepErrorSchema, { error: content }) } }
      : {
        result: {
          case: "success",
          value: create(GrepSuccessSchema, {
            pattern,
            path,
            outputMode: "content",
            workspaceResults: {
              [path]: create(GrepUnionResultSchema, {
                result: {
                  case: "content",
                  value: create(GrepContentResultSchema, {
                    matches: [create(GrepFileMatchSchema, {
                      file: path,
                      matches: content.split("\n").slice(0, 200).map((line, index) => create(GrepContentMatchSchema, {
                        lineNumber: index + 1,
                        content: line,
                        contentTruncated: false,
                      })),
                    })],
                    totalLines: content.split("\n").length,
                    totalMatchedLines: content.split("\n").length,
                    clientTruncated: content.split("\n").length > 200,
                    ripgrepTruncated: false,
                  }),
                },
              }),
            },
          }),
        },
      }), sendFrame);
    return;
  }
  if (resultCase === "lsResult") {
    const path = nativePath(exec) || ".";
    const files = content.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 500);
    sendPendingExecResult(exec, create(LsResultSchema, isError
      ? { result: { case: "error", value: create(LsErrorSchema, { path, error: content }) } }
      : {
        result: {
          case: "success",
          value: create(LsSuccessSchema, {
            directoryTreeRoot: create(LsDirectoryTreeNodeSchema, {
              absPath: path,
              childrenDirs: [],
              childrenFiles: files.map((name) => create(LsDirectoryTreeNode_FileSchema, { name })),
              childrenWereProcessed: true,
              fullSubtreeExtensionCounts: {},
              numFiles: files.length,
            }),
          }),
        },
      }), sendFrame);
    return;
  }
  if (resultCase === "shellResult") {
    const command = typeof exec.nativeArgs?.command === "string" ? exec.nativeArgs.command : "";
    const workingDirectory = typeof exec.nativeArgs?.workingDirectory === "string" ? exec.nativeArgs.workingDirectory : "";
    sendPendingExecResult(exec, create(ShellResultSchema, {
      result: {
        case: "success",
        value: create(ShellSuccessSchema, {
          command,
          workingDirectory,
          exitCode: isError ? 1 : 0,
          signal: "",
          stdout: isError ? "" : content,
          stderr: isError ? content : "",
          executionTime: 0,
        }),
      },
    }), sendFrame);
    return;
  }
  if (resultCase === "shellStream") {
    const cwd = typeof exec.nativeArgs?.workingDirectory === "string" ? exec.nativeArgs.workingDirectory : "";
    sendPendingExecResult(exec, create(ShellStreamSchema, {
      event: { case: "stdout", value: create(ShellStreamStdoutSchema, { data: content }) },
    }), sendFrame);
    sendPendingExecResult(exec, create(ShellStreamSchema, {
      event: {
        case: "exit",
        value: create(ShellStreamExitSchema, { code: isError ? 1 : 0, cwd, aborted: false }),
      },
    }), sendFrame);
    return;
  }
  sendPendingExecResult(exec, create(McpResultSchema, {
    result: {
      case: "success",
      value: create(McpSuccessSchema, {
        content: [
          create(McpToolResultContentItemSchema, {
            content: { case: "text", value: create(McpTextContentSchema, { text: content }) },
          }),
        ],
        isError,
      }),
    },
  }), sendFrame);
}


// ── Key derivation ──

export function derivePiSessionId(body: Pick<ChatCompletionRequest, "pi_session_id" | "user">): string | undefined {
  const raw = body.pi_session_id ?? body.user;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

export { deriveBridgeKeyFromSessionId, deriveConversationKeyFromSessionId, deterministicConversationId };

export function deriveBridgeKey(_messages: OpenAIMessage[], sessionId?: string): string {
  return deriveBridgeKeyFromSessionId(sessionId ?? `isolated:${crypto.randomUUID()}`);
}

export function deriveConversationKey(_messages: OpenAIMessage[], sessionId?: string): string {
  return deriveConversationKeyFromSessionId(sessionId ?? `isolated:${crypto.randomUUID()}`);
}

export function cleanupSessionState(sessionId?: string): void {
  if (!sessionId) return;
  const bridgeKey = deriveBridgeKeyFromSessionId(sessionId);
  const convKey = deriveConversationKeyFromSessionId(sessionId);
  const active = activeBridges.get(bridgeKey);
  debugLog("session.cleanup", { sessionId, bridgeKey, convKey, hasActiveBridge: !!active, hadConversation: conversationStates.has(convKey) });
  if (active) cleanupBridge(active.bridge, active.heartbeatTimer, bridgeKey);
  dropConversation(convKey);
}

/**
 * Pi just compacted this session. Pi now holds a short summary, but Cursor is still sitting on
 * the full pre-compaction conversation behind its checkpoint — and will keep answering from it,
 * and keep reporting its size, as if nothing was compacted. Drop the checkpoint and move to a
 * fresh conversation id so the next request is rebuilt from Pi's compacted turns.
 *
 * The in-flight bridge has to go too: a pending tool result would otherwise resume the very
 * conversation we are trying to leave behind.
 */
export function resetConversationForSession(sessionId?: string): void {
  if (!sessionId) return;
  const bridgeKey = deriveBridgeKeyFromSessionId(sessionId);
  const convKey = deriveConversationKeyFromSessionId(sessionId);
  const active = activeBridges.get(bridgeKey);
  const hadConversation = forgetConversation(convKey);
  debugLog("conversation.reset_after_compaction", {
    sessionId,
    bridgeKey,
    convKey,
    hadConversation,
    hasActiveBridge: !!active,
    nextConversationId: deterministicConversationId(convKey),
  });
  if (active) cleanupBridge(active.bridge, active.heartbeatTimer, bridgeKey);
}

// ── Thinking tag filter ──

const THINKING_TAG_NAMES = ['think', 'thinking', 'reasoning', 'thought', 'think_intent'];
const MAX_THINKING_TAG_LEN = 16;

function createThinkingTagFilter() {
  let buffer = '';
  let inThinking = false;
  return {
    process(text: string) {
      const input = buffer + text;
      buffer = '';
      let content = '';
      let reasoning = '';
      let lastIdx = 0;
      const re = new RegExp(`<(/?)(?:${THINKING_TAG_NAMES.join('|')})\\s*>`, 'gi');
      let match: RegExpExecArray | null;
      while ((match = re.exec(input)) !== null) {
        const before = input.slice(lastIdx, match.index);
        if (inThinking) reasoning += before; else content += before;
        inThinking = match[1] !== '/';
        lastIdx = re.lastIndex;
      }
      const rest = input.slice(lastIdx);
      const ltPos = rest.lastIndexOf('<');
      if (ltPos >= 0 && rest.length - ltPos < MAX_THINKING_TAG_LEN && /^<\/?[a-z_]*$/i.test(rest.slice(ltPos))) {
        buffer = rest.slice(ltPos);
        const before = rest.slice(0, ltPos);
        if (inThinking) reasoning += before; else content += before;
      } else {
        if (inThinking) reasoning += rest; else content += rest;
      }
      return { content, reasoning };
    },
    flush() {
      const b = buffer;
      buffer = '';
      if (!b) return { content: '', reasoning: '' };
      return inThinking ? { content: '', reasoning: b } : { content: b, reasoning: '' };
    },
  };
}

// ── Connect frame parser ──

function createConnectFrameParser(
  onMessage: (bytes: Uint8Array) => void,
  onEndStream: (bytes: Uint8Array) => void,
): (incoming: Buffer) => void {
  let pending = Buffer.alloc(0);
  return (incoming: Buffer) => {
    pending = Buffer.concat([pending, incoming]);
    while (pending.length >= 5) {
      const flags = pending[0]!;
      const msgLen = pending.readUInt32BE(1);
      if (pending.length < 5 + msgLen) break;
      const messageBytes = pending.subarray(5, 5 + msgLen);
      pending = pending.subarray(5 + msgLen);
      if (flags & CONNECT_END_STREAM_FLAG) onEndStream(messageBytes);
      else onMessage(messageBytes);
    }
  };
}

function parseConnectEndStream(data: Uint8Array): Error | null {
  try {
    const payload = JSON.parse(new TextDecoder().decode(data));
    const error = payload?.error;
    if (error) return new Error(transportStatusError({code:error.code}) ?? `Connect error ${error.code ?? "unknown"}: ${error.message ?? "Unknown error"}`);
    return null;
  } catch {
    return new Error("Failed to parse Connect end stream");
  }
}

function makeHeartbeatBytes(): Uint8Array {
  const heartbeat = create(AgentClientMessageSchema, {
    message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) },
  });
  return frameConnectMessage(toBinary(AgentClientMessageSchema, heartbeat));
}

function computeUsage(state: StreamState) {
  return resolveCursorUsage(state);
}

function respondWithPendingToolCalls(
  modelId: string,
  pendingExecs: PendingExec[],
  stream: boolean,
  res: ServerResponse,
  promptTokenEstimate = 0,
): void {
  const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 28)}`;
  const created = Math.floor(Date.now() / 1000);
  const usage = resolveCursorUsage({
    outputTokens: 0,
    totalTokens: 0,
    promptTokenEstimate,
  });
  const toolCalls = pendingExecs.map((exec, index) => ({
    index,
    id: exec.toolCallId,
    type: "function" as const,
    function: { name: exec.toolName, arguments: exec.decodedArgs },
  }));

  if (stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    for (const toolCall of toolCalls) {
      res.write(`data: ${JSON.stringify({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: modelId,
        choices: [{ index: 0, delta: { tool_calls: [toolCall] }, finish_reason: null }],
      })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: [],
      usage,
    })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    id: completionId,
    object: "chat.completion",
    created,
    model: modelId,
    choices: [{
      index: 0,
      message: { role: "assistant", content: null, tool_calls: toolCalls },
      finish_reason: "tool_calls",
    }],
    usage,
  }));
}

// ── Streaming response ──

function startBridge(accessToken: string, requestBytes: Uint8Array) {
  const bridge = bridgeFactory({ accessToken, rpcPath: "/agent.v1.AgentService/Run" });
  debugLog("bridge.start_run", { requestBytes });
  bridge.write(frameConnectMessage(requestBytes));
  const heartbeatTimer = setInterval(() => bridge.write(makeHeartbeatBytes()), 5_000);
  return { bridge, heartbeatTimer };
}

function handleStreamingResponse(
  payload: CursorRequestPayload,
  accessToken: string,
  modelId: string,
  bridgeKey: string,
  convKey: string,
  completedTurns: ParsedTurn[],
  currentTurn: ParsedTurn,
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
  promptTokenEstimate = 0,
  stream = true,
): void {
  debugLog("stream.start", { requestId, bridgeKey, convKey, modelId });
  const { bridge, heartbeatTimer } = startBridge(accessToken, payload.requestBytes);
  writeSSEStream(
    bridge,
    heartbeatTimer,
    payload.blobStore,
    payload.mcpTools,
    modelId,
    bridgeKey,
    convKey,
    completedTurns,
    currentTurn,
    req,
    res,
    requestId,
    promptTokenEstimate,
    stream,
  );
}

function sendCancelAction(
  bridge: BridgeHandle,
): void {
  debugLog("bridge.cancel_action", {});
  const action = create(ConversationActionSchema, {
    action: { case: "cancelAction", value: create(CancelActionSchema, {}) },
  });
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "conversationAction", value: action },
  });
  bridge.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
}

function cleanupBridge(
  bridge: BridgeHandle,
  heartbeatTimer: ReturnType<typeof setInterval>,
  bridgeKey: string,
): void {
  debugLog("bridge.cleanup", { bridgeKey, alive: bridge.alive });
  const active=activeBridges.get(bridgeKey);
  if(active?.bridge===bridge)active.dispose?.();
  clearInterval(heartbeatTimer);
  if (bridge.alive) sendCancelAction(bridge);
  // Ending stdin alone does not terminate a streaming HTTP/2 request: Cursor may
  // keep the response side open and the bridge process alive indefinitely. Once
  // this Run is cancelled or stale, kill the subprocess so dead connections do
  // not accumulate across stalls, compactions, and session switches.
  bridge.destroy();
  if(activeBridges.get(bridgeKey)?.bridge===bridge)activeBridges.delete(bridgeKey);
}

function writeSSEStream(
  bridge: BridgeHandle,
  heartbeatTimer: ReturnType<typeof setInterval>,
  blobStore: Map<string, Uint8Array>,
  mcpTools: McpToolDefinition[],
  modelId: string,
  bridgeKey: string,
  convKey: string,
  completedTurns: ParsedTurn[],
  currentTurn: ParsedTurn,
  req: IncomingMessage,
  res: ServerResponse,
  requestId?: string,
  promptTokenEstimate = 0,
  stream = true,
): void {
  debugLog("stream.writer_start", { requestId, bridgeKey, convKey, modelId, completedTurnCount: completedTurns.length, currentTurn });
  const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 28)}`;
  const created = Math.floor(Date.now() / 1000);

  const stopKeepalive = stream ? startSSEResponse(res) : () => {};
  const receipt=captureConversation(convKey);
  let responseText="";
  const responseTools:Record<string,any>[]=[];
  const recordResponse=()=>{if(ownsConversation(convKey,receipt))recordAssistantResponse(receipt!.stored,
    {role:"assistant",content:responseText||null,tool_calls:responseTools.length?responseTools:undefined});};

  let closed = false;
  let coalesceTimer: ReturnType<typeof setTimeout> | undefined;
  const clearCoalesceTimer = () => {
    if (!coalesceTimer) return;
    clearTimeout(coalesceTimer);
    coalesceTimer = undefined;
  };
  let jsonText="", jsonReasoning="", jsonFinish:string|null=null, jsonError="";
  let jsonUsage:unknown;
  const jsonTools:any[]=[];
  const sendSSE = (data: any) => {
    if (closed) return;
    if(stream){
      const failed=data.choices?.find((choice:any)=>choice.finish_reason==="error");
      // Pi/OpenAI native consumers map unknown finish reasons to a generic error.
      // The standard SSE error envelope preserves auth/quota/transient evidence.
      const wire=failed?{...data,error:{message:failed.delta?.content??"Cursor upstream error",type:"upstream_error",code:"cursor_error"}}:data;
      res.write(`data: ${JSON.stringify(wire)}\n\n`);return;
    }
    if(data.usage)jsonUsage=data.usage;
    for(const choice of data.choices??[]){
      const delta=choice.delta??{};
      if(choice.finish_reason==="error")jsonError=delta.content??"Cursor upstream error";
      else if(typeof delta.content==="string")jsonText+=delta.content;
      if(typeof delta.reasoning_content==="string")jsonReasoning+=delta.reasoning_content;
      if(choice.finish_reason)jsonFinish=choice.finish_reason;
      for(const tool of delta.tool_calls??[]){const {index,...call}=tool;jsonTools[index??jsonTools.length]=call;}
    }
  };
  const sendDone = () => {
    if (closed) return;
    if(stream){res.write("data: [DONE]\n\n");return;}
    if(jsonFinish==="error"){
      res.writeHead(502,{"Content-Type":"application/json"});
      res.write(JSON.stringify({error:{message:jsonError,type:"upstream_error",code:"cursor_error"}}));
    }else{
      res.writeHead(200,{"Content-Type":"application/json"});
      res.write(JSON.stringify({id:completionId,object:"chat.completion",created,model:modelId,
        choices:[{index:0,message:{role:"assistant",content:jsonText||null,...(jsonReasoning?{reasoning_content:jsonReasoning}:{}),...(jsonTools.length?{tool_calls:jsonTools}:{})},finish_reason:jsonFinish}],usage:jsonUsage}));
    }
  };
  const closeResponse = () => {
    if (closed) return;
    closed = true;
    clearCoalesceTimer();
    stopKeepalive();
    transportWatchdog.stop();
    upstreamWatchdog.stop();
    req.removeListener("close",onClientClose);
    res.removeListener("close",onClientClose);
    res.end();
  };

  const makeChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
    id: completionId, object: "chat.completion.chunk", created, model: modelId,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });

  const failStalledRun = (
    kind: "transport" | "useful_output",
    silentForMs: number,
  ) => {
    if (closed) return;
    const missing = kind === "transport" ? "upstream frames" : "useful output";
    const message = `Cursor Run stalled: no ${missing} for ${formatStallDuration(silentForMs)}; stream timed out`;
    console.error(`[cursor-provider] ${kind} stall (${modelId}):`, message);
    debugLog("stream.upstream_stall", { requestId, bridgeKey, convKey, modelId, kind, silentForMs });
    cancelled = true;
    if (!toolCallsFlushed) {
      for (const exec of state.pendingExecs) {
        resumePendingExecWithToolResult(exec, message, true, (data) => bridge.write(data));
      }
    }
    if(ownsConversation(convKey,receipt))forgetConversation(convKey);
    sendSSE(makeChunk({ content: message }, "error"));
    sendSSE(makeUsageChunk());
    sendDone();
    closeResponse();
    cleanupBridge(bridge, heartbeatTimer, bridgeKey);
  };

  // A decoded housekeeping frame proves the HTTP/2 transport is alive, but only
  // visible tokens or a Pi-bound tool prove the model is making useful progress.
  const transportWatchdog = startUpstreamWatchdog(
    (silentForMs) => failStalledRun("transport", silentForMs),
    resolveTransportStallTimeoutMs(),
  );
  const upstreamWatchdog = startUpstreamWatchdog(
    (silentForMs) => failStalledRun("useful_output", silentForMs),
    resolveUpstreamStallTimeoutMs(),
  );

  const makeUsageChunk = () => {
    const { prompt_tokens, completion_tokens, total_tokens } = computeUsage(state);
    return {
      id: completionId, object: "chat.completion.chunk", created, model: modelId,
      choices: [],
      usage: { prompt_tokens, completion_tokens, total_tokens },
    };
  };

  const state: StreamState = { toolCallIndex: 0, pendingExecs: [], outputTokens: 0, totalTokens: 0, promptTokenEstimate };
  // Track dispatched streaming Runs as well as paused tools: compaction/shutdown
  // must cancel every old generation, not just a Run currently waiting on a tool.
  const dispose=()=>{
    if(closed)return;
    cancelled=true;
    sendSSE(makeChunk({content:"Cursor Run cancelled"},"error"));sendSSE(makeUsageChunk());sendDone();closeResponse();
  };
  activeBridges.set(bridgeKey,{bridge,heartbeatTimer,blobStore,mcpTools,pendingExecs:state.pendingExecs,currentTurn,receipt,paused:false,dispose});
  const tagFilter = createThinkingTagFilter();
  let mcpExecReceived = false;
  let toolCallsFlushed = false;
  let cancelled = false;
  let observedTurnEnded = false;
  let latestCheckpoint: Uint8Array | null = null;
  const coalesceMs = resolveToolCallCoalesceMs();

  const flushPiToolCalls = () => {
    clearCoalesceTimer();
    if (closed || cancelled || toolCallsFlushed || state.pendingExecs.length === 0) return;
    toolCallsFlushed = true;
    mcpExecReceived = true;

    const flushed = tagFilter.flush();
    if (flushed.reasoning) sendSSE(makeChunk({ reasoning_content: flushed.reasoning }));
    if (flushed.content) {
      appendAssistantTextToTurn(currentTurn, flushed.content);
      responseText+=flushed.content;
      sendSSE(makeChunk({ content: flushed.content }));
    }

    for (const exec of state.pendingExecs) {
      responseTools.push({id:exec.toolCallId,type:"function",function:{name:exec.toolName,arguments:exec.decodedArgs}});
      const toolCallIndex = state.toolCallIndex++;
      sendSSE(makeChunk({
        tool_calls: [{
          index: toolCallIndex, id: exec.toolCallId, type: "function",
          function: { name: exec.toolName, arguments: exec.decodedArgs },
        }],
      }));
    }

    activeBridges.set(bridgeKey, {
      bridge, heartbeatTimer, blobStore, mcpTools, pendingExecs: state.pendingExecs, currentTurn,receipt,paused:true,dispose,
    });
    debugLog("stream.tool_call_pause", { requestId, bridgeKey, pendingExecs: state.pendingExecs, currentTurn });

    recordResponse();
    sendSSE(makeChunk({}, "tool_calls"));
    sendSSE(makeUsageChunk());
    sendDone();
    closeResponse();
  };

  const queuePiTool = (exec: PendingExec) => {
    if (closed || cancelled || toolCallsFlushed) {
      debugLog("stream.late_exec_rejected", { requestId, bridgeKey, exec });
      resumePendingExecWithToolResult(exec, NATIVE_TOOL_UNAVAILABLE, true, (data) => bridge.write(data));
      return;
    }
    state.pendingExecs.push(exec);
    mcpExecReceived = true;
    currentTurn.steps.push({
      kind: "toolCall",
      toolCallId: exec.toolCallId,
      toolName: exec.toolName,
      arguments: parseToolCallArguments(exec.decodedArgs),
    });
    clearCoalesceTimer();
    coalesceTimer = setTimeout(flushPiToolCalls, coalesceMs);
    coalesceTimer.unref?.();
  };

  const finishOpenAITurn = () => {
    if (closed || mcpExecReceived) return;
    const flushed = tagFilter.flush();
    if (flushed.reasoning) sendSSE(makeChunk({ reasoning_content: flushed.reasoning }));
    if (flushed.content) {
      appendAssistantTextToTurn(currentTurn, flushed.content);
      responseText+=flushed.content;
      sendSSE(makeChunk({ content: flushed.content }));
    }
    recordResponse();
    sendSSE(makeChunk({}, "stop"));
    sendSSE(makeUsageChunk());
    sendDone();
    closeResponse();
    cleanupBridge(bridge, heartbeatTimer, bridgeKey);
  };

  const failRun=(message:string)=>{
    if(closed)return;
    cancelled=true;
    if(ownsConversation(convKey,receipt))forgetConversation(convKey);
    const flushed=tagFilter.flush();
    if(flushed.content)sendSSE(makeChunk({content:flushed.content}));
    sendSSE(makeChunk({content:message},"error"));sendSSE(makeUsageChunk());sendDone();closeResponse();
    cleanupBridge(bridge,heartbeatTimer,bridgeKey);
  };

  // Detect client disconnect (e.g. user pressed Escape in pi)
  const onClientClose = () => {
    if (cancelled || closed) return;
    debugLog("stream.client_close", { requestId, bridgeKey, convKey });
    cancelled = true;
    cleanupBridge(bridge, heartbeatTimer, bridgeKey);
    closeResponse();
  };
  req.on("close", onClientClose);
  res.on("close", onClientClose);

  const processChunk = createConnectFrameParser(
    (messageBytes) => {
      try {
        const serverMessage = fromBinary(AgentServerMessageSchema, messageBytes);
        transportWatchdog.touch();
        const classified = processServerMessage(
          serverMessage, blobStore, mcpTools,
          (data) => bridge.write(data),
          state,
          (text, isThinking) => {
            if (isThinking) {
              sendSSE(makeChunk({ reasoning_content: text }));
            } else {
              const { content, reasoning } = tagFilter.process(text);
              if (reasoning) sendSSE(makeChunk({ reasoning_content: reasoning }));
              if (content) {
                appendAssistantTextToTurn(currentTurn, content);
                responseText+=content;
                sendSSE(makeChunk({ content }));
              }
            }
          },
          (exec) => {
            queuePiTool(exec);
          },
          (checkpointBytes) => {
            latestCheckpoint = checkpointBytes;
            const stored = ownsConversation(convKey,receipt)?receipt!.stored:undefined;
            if (stored) {
              stored.checkpoint = checkpointBytes;
              for (const [k, v] of blobStore) stored.blobStore.set(k, v);

              stored.lastAccessMs = Date.now();
            }
            debugLog("stream.checkpoint_buffered", { requestId, convKey, checkpointBytes });
          },
          () => {
            observedTurnEnded=true;
            debugLog("stream.turn_ended", { requestId, bridgeKey, convKey, mcpExecReceived, closed });
            finishOpenAITurn();
          },
        );
        if (classified.countsAsProgress) upstreamWatchdog.touch();
      } catch (err) {
        console.error("[cursor-provider] Stream message processing error:", err instanceof Error ? err.message : err);
      }
    },
    (endStreamBytes) => {
      const endError = parseConnectEndStream(endStreamBytes);
      if (endError) {
        console.error(`[cursor-provider] Cursor stream error (${modelId}):`, endError.message);
        failRun(endError.message);
      }
    },
  );

  bridge.onData(chunk=>{
    if(receipt && !ownsConversation(convKey,receipt)){
      cancelled=true;cleanupBridge(bridge,heartbeatTimer,bridgeKey);closeResponse();return;
    }
    processChunk(chunk);
  });

  bridge.onStatus?.(status=>{
    const error=transportStatusError(status);if(!error)return;
    if(closed){if(ownsConversation(convKey,receipt))forgetConversation(convKey);cleanupBridge(bridge,heartbeatTimer,bridgeKey);return;}
    failRun(error);
  });
  bridge.onClose((code) => {
    debugLog("stream.bridge_close", { requestId, bridgeKey, convKey, code, cancelled, observedTurnEnded, mcpExecReceived, toolCallsFlushed });
    clearCoalesceTimer();transportWatchdog.stop();upstreamWatchdog.stop();clearInterval(heartbeatTimer);
    req.removeListener("close",onClientClose);res.removeListener("close",onClientClose);
    if(activeBridges.get(bridgeKey)?.bridge===bridge)activeBridges.delete(bridgeKey);
    const stored=ownsConversation(convKey,receipt)?receipt!.stored:undefined;
    if(stored && !cancelled && observedTurnEnded && latestCheckpoint){
      stored.checkpoint=latestCheckpoint;for(const [k,v] of blobStore)stored.blobStore.set(k,v);stored.lastAccessMs=Date.now();
    }
    if(cancelled)return;
    if(closed){
      if(toolCallsFlushed && !observedTurnEnded && stored)forgetConversation(convKey);
      if(stored && !stored.sessionScoped && ownsConversation(convKey,receipt))dropConversation(convKey);
      return;
    }
    // EOF (including exit 0) is not the protocol's turnEnded. Do not fabricate
    // success or lose transport failure evidence before same-route recovery.
    failRun(`Cursor connection error: stream ended before turnEnded (bridge exit ${code})`);
  });
}

export function writeSSEStreamForTests(args: {
  bridge: BridgeHandle;
  heartbeatTimer: ReturnType<typeof setInterval>;
  blobStore?: Map<string, Uint8Array>;
  mcpTools?: McpToolDefinition[];
  modelId: string;
  bridgeKey: string;
  convKey: string;
  completedTurns: ParsedTurn[];
  currentTurn: ParsedTurn;
  req: IncomingMessage;
  res: ServerResponse;
  requestId?: string;
  promptTokenEstimate?: number;
  stream?: boolean;
}): void {
  writeSSEStream(
    args.bridge,
    args.heartbeatTimer,
    args.blobStore ?? new Map(),
    args.mcpTools ?? [],
    args.modelId,
    args.bridgeKey,
    args.convKey,
    args.completedTurns,
    args.currentTurn,
    args.req,
    args.res,
    args.requestId,
    args.promptTokenEstimate ?? 0,
    args.stream !== false,
  );
}

// ── Tool result resume ──

function handleToolResultResume(
  active: ActiveBridge,
  toolResults: ToolResultInfo[],
  modelId: string,
  bridgeKey: string,
  convKey: string,
  completedTurns: ParsedTurn[],
  req: IncomingMessage,
  res: ServerResponse,
  stream: boolean,
  requestId?: string,
  promptTokenEstimate = 0,
): void {
  const { bridge, heartbeatTimer, blobStore, mcpTools, pendingExecs, currentTurn } = active;
  debugLog("tool_resume.start", { requestId, bridgeKey, convKey, toolResults, pendingExecs, currentTurn });

  for (const result of toolResults) {
    const turnToolStep = currentTurn.steps.find((step) => step.kind === "toolCall" && step.toolCallId === result.toolCallId);
    if (turnToolStep) {
      turnToolStep.result = { content: result.content, isError: result.isError === true };
    }
  }

  const turnResults = getTurnToolCallResults(currentTurn);
  const unresolvedExecs = pendingExecs.filter((exec) => !turnResults.has(exec.toolCallId));
  if (unresolvedExecs.length > 0) {
    activeBridges.set(bridgeKey, {
      bridge,
      heartbeatTimer,
      blobStore,
      mcpTools,
      pendingExecs,
      currentTurn,receipt:active.receipt,paused:true,
    });
    const stored=conversationStates.get(convKey);
    if(stored)recordAssistantResponse(stored,{role:"assistant",content:null,tool_calls:unresolvedExecs.map(exec=>({id:exec.toolCallId,type:"function",function:{name:exec.toolName,arguments:exec.decodedArgs}}))});
    debugLog("tool_resume.partial_wait", { requestId, bridgeKey, unresolvedExecs, currentTurn });
    respondWithPendingToolCalls(modelId, unresolvedExecs, stream, res, promptTokenEstimate);
    return;
  }

  // Listen on the new OpenAI stream BEFORE writing exec results. Cursor often
  // replies in the same tick (text, thinking, the next exec, turnEnded). The
  // paused writer already called res.end(), so those frames used to land on a
  // closed SSE and vanish. Pi then sat on Working until the upstream stall watchdog fired.
  // Tool results belong to the same user turn that initiated the tool calls.
  // parseMessages keeps tool continuations out of completed history, so completedTurns
  // already reflects the correct history covered before this in-flight turn.
  writeSSEStream(
    bridge,
    heartbeatTimer,
    blobStore,
    mcpTools,
    modelId,
    bridgeKey,
    convKey,
    completedTurns,
    currentTurn,
    req,
    res,
    requestId,
    promptTokenEstimate,
    stream,
  );

  for (const exec of pendingExecs) {
    const result = turnResults.get(exec.toolCallId);
    if (!result) continue;
    resumePendingExecWithToolResult(exec, result.content, result.isError, (data) => bridge.write(data));
    debugLog("tool_resume.sent_result", { requestId, exec, result });
  }
}

export function resumeCursorToolResultsForTests(
  active: ActiveBridge,
  toolResults: ToolResultInfo[],
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    modelId: string;
    bridgeKey: string;
    convKey: string;
    completedTurns?: ParsedTurn[];
    stream?: boolean;
  },
): void {
  handleToolResultResume(
    active,
    toolResults,
    opts.modelId,
    opts.bridgeKey,
    opts.convKey,
    opts.completedTurns ?? [],
    req,
    res,
    opts.stream !== false,
  );
}

// JSON and SSE use the same Run ownership, tool pause/resume, deadlines and
// terminal checks above; only the response serialization differs.
