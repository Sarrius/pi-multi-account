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
import { resolve as pathResolve, dirname, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import { estimatePromptTokens, resolveCursorUsage } from "./prompt-usage.ts";
import { type BridgeHandle, type BridgeStreams, createBridgeHandle } from "./bridge-handle.ts";
import { startSSEResponse } from "./sse-keepalive.ts";
import { formatStallDuration, resolveUpstreamStallTimeoutMs, startUpstreamWatchdog } from "./upstream-watchdog.ts";
import {
  requestActionText,
  historyForRebuild,
  isToolCallStep,
  parseMessages as parseMessagesPure,
  parseToolCallArguments,
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
  CancelActionSchema,
  ClientHeartbeatSchema,
  ConversationActionSchema,
  ConversationStateStructureSchema,
  ConversationStepSchema,
  AgentConversationTurnStructureSchema,
  ConversationTurnStructureSchema,
  AssistantMessageSchema,

  BackgroundShellSpawnResultSchema,
  DeleteResultSchema,
  DeleteRejectedSchema,
  DiagnosticsResultSchema,
  ExecClientMessageSchema,
  FetchErrorSchema,
  FetchResultSchema,
  GetBlobResultSchema,
  GrepErrorSchema,
  GrepResultSchema,
  KvClientMessageSchema,
  LsRejectedSchema,
  LsResultSchema,
  McpArgsSchema,
  McpErrorSchema,
  McpResultSchema,
  McpSuccessSchema,
  McpTextContentSchema,
  McpToolCallSchema,
  McpToolDefinitionSchema,
  McpToolResultContentItemSchema,
  ModelDetailsSchema,
  ReadRejectedSchema,
  ReadResultSchema,
  RequestContextResultSchema,
  RequestContextSchema,
  RequestContextSuccessSchema,
  SelectedContextSchema,
  SetBlobResultSchema,
  ShellRejectedSchema,
  ShellResultSchema,
  ShellStreamSchema,
  ToolCallSchema,
  UserMessageActionSchema,
  UserMessageSchema,
  WriteRejectedSchema,
  WriteResultSchema,
  WriteShellStdinErrorSchema,
  WriteShellStdinResultSchema,
  GetUsableModelsRequestSchema,
  GetUsableModelsResponseSchema,
  type AgentServerMessage,
  type ConversationStateStructure,
  type ExecServerMessage,
  type KvServerMessage,
  type McpToolDefinition,
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

function sanitizeForDebug(value: unknown): unknown {
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
      if (key === "accessToken") return [key, "<redacted>"] as const;
      if (key === "data" && typeof inner === "string") return [key, `<redacted base64 ${inner.length} chars>`] as const;
      return [key, sanitizeForDebug(inner)] as const;
    });
    return Object.fromEntries(entries);
  }
  return String(value);
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
    ts: new Date().toISOString(),
    pid: process.pid,
    event,
    ...(data ? sanitizeForDebug(data) : {}),
  });
  const file = getDebugLogFilePath();
  try {
    appendFileSync(file, `${line}\n`, "utf8");
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
    let timedOut = false;
    const timeoutMs = options.timeoutMs ?? 5_000;
    const timeout = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          try { bridge.proc.kill(); } catch {}
        }, timeoutMs)
      : undefined;

    bridge.onData((chunk) => { chunks.push(Buffer.from(chunk)); });
    bridge.onClose((exitCode) => {
      if (timeout) clearTimeout(timeout);
      resolve({ body: Buffer.concat(chunks), exitCode, timedOut });
    });

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

  const sessionId = derivePiSessionId(body);
  const bridgeKey = deriveBridgeKey(body.messages, sessionId);
  const convKey = deriveConversationKey(body.messages, sessionId);
  const activeBridge = activeBridges.get(bridgeKey);
  debugLog("chat.session_keys", {
    requestId,
    sessionId,
    bridgeKey,
    convKey,
    hasActiveBridge: !!activeBridge,
  });

  const promptTokens = estimatePromptTokens(body.messages, body.tools);

  if (activeBridge && toolResults.length > 0) {
    debugLog("chat.resume_tool_results", { requestId, bridgeKey, toolResults, pendingExecs: activeBridge.pendingExecs });
    activeBridges.delete(bridgeKey);
    if (activeBridge.bridge.alive) {
      handleToolResultResume(activeBridge, toolResults, modelId, bridgeKey, convKey, turns, req, res, body.stream !== false, requestId, promptTokens);
      return;
    }
    clearInterval(activeBridge.heartbeatTimer);
    activeBridge.bridge.end();
  }

  if (activeBridge && activeBridges.has(bridgeKey)) {
    clearInterval(activeBridge.heartbeatTimer);
    activeBridge.bridge.end();
    activeBridges.delete(bridgeKey);
  }

  let stored = conversationStates.get(convKey);
  debugLog("chat.stored_state.before", { requestId, convKey, stored });
  // Rotation moves the session between providers mid-conversation. While it is away, Cursor
  // sees nothing — so a checkpoint that predates that excursion would resume a past with a
  // hole in it. Detect the jump and start clean instead.
  if (stored && isStaleForTranscript(stored, parsed.turns.length)) {
    debugLog("conversation.stale_checkpoint", {
      requestId,
      convKey,
      turnsCovered: stored.turnsCovered,
      completedTurns: parsed.turns.length,
    });
    forgetConversation(convKey);
    stored = undefined;
  }
  if (!stored) {
    stored = {
      conversationId: deterministicConversationId(convKey),
      checkpoint: null,

      sessionScoped: !!sessionId,
      blobStore: new Map(),
      lastAccessMs: Date.now(),
      turnsCovered: parsed.turns.length,
    };
    conversationStates.set(convKey, stored);
  }
  stored.turnsCovered = parsed.turns.length;
  stored.lastAccessMs = Date.now();
  evictStaleConversations();

  const mcpTools = buildMcpToolDefinitions(tools);
  // Cursor's own conversation is not available here, so the whole session is replayed from
  // Pi's transcript. The turn that is still in flight — the assistant's tool calls and the
  // results that just came back — is part of that history: dropping it and re-sending the
  // original question makes the model redo work it already did, and dropping the question and
  // sending raw tool output leaves it with no task at all.
  const rebuiltTurns = historyForRebuild(parsed);
  const effectiveUserText = requestActionText(parsed, { hasCheckpoint: !!stored.checkpoint });
  if (!stored.checkpoint) {
    debugLog("chat.no_checkpoint", { requestId, convKey, conversationId: stored.conversationId });
  }
  const payload = buildCursorRequest(
    modelId, systemPrompt, effectiveUserText, rebuiltTurns,
    stored.conversationId, stored.checkpoint, stored.blobStore,
  );
  debugLog("chat.cursor_request", {
    requestId,
    conversationId: stored.conversationId,
    effectiveUserText,
    turnCount: turns.length,
    hasCheckpoint: !!stored.checkpoint,
    payload,
  });
  payload.mcpTools = mcpTools;

  const currentTurn: ParsedTurn = {
    userText: effectiveUserText,
    steps: [],
  };

  if (body.stream === false) {
    debugLog("chat.dispatch_nonstream", { requestId, convKey });
    await handleNonStreamingResponse(payload, accessToken, modelId, convKey, turns, currentTurn, req, res, requestId, promptTokens);
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
      previousWorkspaceUris: [`file://${process.cwd()}`],
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
): void {
  const msgCase = msg.message.case;
  debugLog("server_message", { msgCase, msg });

  if (msgCase === "interactionUpdate") {
    const update = msg.message.value as any;
    const updateCase = update.message?.case;
    if (updateCase === "textDelta") {
      const delta = update.message.value.text || "";
      if (delta) onText(delta, false);
    } else if (updateCase === "thinkingDelta") {
      const delta = update.message.value.text || "";
      if (delta) onText(delta, true);
    } else if (updateCase === "tokenDelta") {
      state.outputTokens += update.message.value.tokens ?? 0;
    }
  } else if (msgCase === "kvServerMessage") {
    handleKvMessage(msg.message.value as KvServerMessage, blobStore, sendFrame);
  } else if (msgCase === "execServerMessage") {
    handleExecMessage(msg.message.value as ExecServerMessage, mcpTools, sendFrame, onMcpExec);
  } else if (msgCase === "conversationCheckpointUpdate") {
    const stateStructure = msg.message.value as ConversationStateStructure;
    if ((stateStructure as any).tokenDetails) {
      state.totalTokens = (stateStructure as any).tokenDetails.usedTokens;
    }
    if (onCheckpoint) {
      onCheckpoint(toBinary(ConversationStateStructureSchema, stateStructure));
    }
  }
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

function handleExecMessage(
  execMsg: ExecServerMessage,
  mcpTools: McpToolDefinition[],
  sendFrame: (data: Uint8Array) => void,
  onMcpExec: (exec: PendingExec) => void,
): void {
  const execCase = (execMsg as any).message.case;
  const REJECT_REASON = "Tool not available in this environment. Use the MCP tools provided instead.";

  if (execCase === "requestContextArgs") {
    const requestContext = create(RequestContextSchema, {
      rules: [], repositoryInfo: [], tools: mcpTools, gitRepos: [],
      projectLayouts: [], mcpInstructions: [], fileContents: {}, customSubagents: [],
    });
    const result = create(RequestContextResultSchema, {
      result: { case: "success", value: create(RequestContextSuccessSchema, { requestContext }) },
    });
    sendExecResult(execMsg, "requestContextResult", result, sendFrame);
    return;
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
    });
    return;
  }

  // Reject native Cursor tools so model falls back to MCP tools
  if (execCase === "readArgs") {
    const args = (execMsg as any).message.value;
    sendExecResult(execMsg, "readResult", create(ReadResultSchema, {
      result: { case: "rejected", value: create(ReadRejectedSchema, { path: args.path, reason: REJECT_REASON }) },
    }), sendFrame);
    return;
  }
  if (execCase === "lsArgs") {
    const args = (execMsg as any).message.value;
    sendExecResult(execMsg, "lsResult", create(LsResultSchema, {
      result: { case: "rejected", value: create(LsRejectedSchema, { path: args.path, reason: REJECT_REASON }) },
    }), sendFrame);
    return;
  }
  if (execCase === "grepArgs") {
    sendExecResult(execMsg, "grepResult", create(GrepResultSchema, {
      result: { case: "error", value: create(GrepErrorSchema, { error: REJECT_REASON }) },
    }), sendFrame);
    return;
  }
  if (execCase === "writeArgs") {
    const args = (execMsg as any).message.value;
    sendExecResult(execMsg, "writeResult", create(WriteResultSchema, {
      result: { case: "rejected", value: create(WriteRejectedSchema, { path: args.path, reason: REJECT_REASON }) },
    }), sendFrame);
    return;
  }
  if (execCase === "deleteArgs") {
    const args = (execMsg as any).message.value;
    sendExecResult(execMsg, "deleteResult", create(DeleteResultSchema, {
      result: { case: "rejected", value: create(DeleteRejectedSchema, { path: args.path, reason: REJECT_REASON }) },
    }), sendFrame);
    return;
  }
  if (execCase === "shellArgs") {
    const args = (execMsg as any).message.value;
    sendExecResult(execMsg, "shellResult", create(ShellResultSchema, {
      result: { case: "rejected", value: create(ShellRejectedSchema, {
        command: args.command ?? "", workingDirectory: args.workingDirectory ?? "",
        reason: REJECT_REASON, isReadonly: false,
      }) },
    }), sendFrame);
    return;
  }
  if (execCase === "shellStreamArgs") {
    const args = (execMsg as any).message.value;
    sendExecResult(execMsg, "shellStream", create(ShellStreamSchema, {
      event: { case: "rejected", value: create(ShellRejectedSchema, {
        command: args.command ?? "", workingDirectory: args.workingDirectory ?? "",
        reason: REJECT_REASON, isReadonly: false,
      }) },
    }), sendFrame);
    return;
  }
  if (execCase === "backgroundShellSpawnArgs") {
    const args = (execMsg as any).message.value;
    sendExecResult(execMsg, "backgroundShellSpawnResult", create(BackgroundShellSpawnResultSchema, {
      result: { case: "rejected", value: create(ShellRejectedSchema, {
        command: args.command ?? "", workingDirectory: args.workingDirectory ?? "",
        reason: REJECT_REASON, isReadonly: false,
      }) },
    }), sendFrame);
    return;
  }
  if (execCase === "writeShellStdinArgs") {
    sendExecResult(execMsg, "writeShellStdinResult", create(WriteShellStdinResultSchema, {
      result: { case: "error", value: create(WriteShellStdinErrorSchema, { error: REJECT_REASON }) },
    }), sendFrame);
    return;
  }
  if (execCase === "fetchArgs") {
    const args = (execMsg as any).message.value;
    sendExecResult(execMsg, "fetchResult", create(FetchResultSchema, {
      result: { case: "error", value: create(FetchErrorSchema, { url: args.url ?? "", error: REJECT_REASON }) },
    }), sendFrame);
    return;
  }
  if (execCase === "diagnosticsArgs") {
    sendExecResult(execMsg, "diagnosticsResult", create(DiagnosticsResultSchema, {}), sendFrame);
    return;
  }

  // Unknown exec types
  const miscCaseMap: Record<string, string> = {
    listMcpResourcesExecArgs: "listMcpResourcesExecResult",
    readMcpResourceExecArgs: "readMcpResourceExecResult",
    recordScreenArgs: "recordScreenResult",
    computerUseArgs: "computerUseResult",
  };
  const resultCase = miscCaseMap[execCase as string];
  if (resultCase) {
    sendExecResult(execMsg, resultCase, create(McpResultSchema, {}), sendFrame);
    return;
  }

  // Catch-all: log and attempt a generic rejection so the bridge doesn't hang
  console.error(`[cursor-provider] UNHANDLED exec case: "${execCase}". Bridge may stall.`);
  // Try to derive the result case name from the args case name
  const guessedResult = (execCase as string)?.replace(/Args$/, "Result");
  if (guessedResult && guessedResult !== execCase) {
    sendExecResult(execMsg, guessedResult, create(McpResultSchema, {}), sendFrame);
  }
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
}

// ── Key derivation ──

export function derivePiSessionId(body: Pick<ChatCompletionRequest, "pi_session_id" | "user">): string | undefined {
  const raw = body.pi_session_id ?? body.user;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

export { deriveBridgeKeyFromSessionId, deriveConversationKeyFromSessionId, deterministicConversationId };

export function deriveBridgeKey(messages: OpenAIMessage[], sessionId?: string): string {
  if (sessionId) return deriveBridgeKeyFromSessionId(sessionId);
  const firstUserMsg = messages.find((m) => m.role === "user");
  const firstUserText = firstUserMsg ? textContent(firstUserMsg.content) : "";
  return createHash("sha256").update(`bridge:${firstUserText.slice(0, 200)}`).digest("hex").slice(0, 16);
}

export function deriveConversationKey(messages: OpenAIMessage[], sessionId?: string): string {
  if (sessionId) return deriveConversationKeyFromSessionId(sessionId);
  const firstUserMsg = messages.find((m) => m.role === "user");
  const firstUserText = firstUserMsg ? textContent(firstUserMsg.content) : "";
  return createHash("sha256").update(`conv:${firstUserText.slice(0, 200)}`).digest("hex").slice(0, 16);
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
    if (error) return new Error(`Connect error ${error.code ?? "unknown"}: ${error.message ?? "Unknown error"}`);
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
  clearInterval(heartbeatTimer);
  if (bridge.alive) {
    sendCancelAction(bridge);
    bridge.end();
  }
  activeBridges.delete(bridgeKey);
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
): void {
  debugLog("stream.writer_start", { requestId, bridgeKey, convKey, modelId, completedTurnCount: completedTurns.length, currentTurn });
  const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 28)}`;
  const created = Math.floor(Date.now() / 1000);

  const stopKeepalive = startSSEResponse(res);

  let closed = false;
  const sendSSE = (data: object) => {
    if (closed) return;
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const sendDone = () => {
    if (closed) return;
    res.write("data: [DONE]\n\n");
  };
  const closeResponse = () => {
    if (closed) return;
    closed = true;
    stopKeepalive();
    upstreamWatchdog.stop();
    res.end();
  };

  const makeChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
    id: completionId, object: "chat.completion.chunk", created, model: modelId,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });

  // Keepalives preserve the client connection; decoded progress bounds the upstream wait.
  const upstreamWatchdog = startUpstreamWatchdog((silentForMs) => {
    if (closed) return;
    const message = `Cursor produced no output for ${formatStallDuration(silentForMs)}; stream timed out`;
    console.error(`[cursor-provider] Upstream stall (${modelId}):`, message);
    debugLog("stream.upstream_stall", { requestId, bridgeKey, convKey, modelId, silentForMs });
    cancelled = true;
    cleanupBridge(bridge, heartbeatTimer, bridgeKey);
    sendSSE(makeChunk({ content: message }, "error"));
    sendSSE(makeUsageChunk());
    sendDone();
    closeResponse();
  }, resolveUpstreamStallTimeoutMs());

  const makeUsageChunk = () => {
    const { prompt_tokens, completion_tokens, total_tokens } = computeUsage(state);
    return {
      id: completionId, object: "chat.completion.chunk", created, model: modelId,
      choices: [],
      usage: { prompt_tokens, completion_tokens, total_tokens },
    };
  };

  const state: StreamState = { toolCallIndex: 0, pendingExecs: [], outputTokens: 0, totalTokens: 0, promptTokenEstimate };
  const tagFilter = createThinkingTagFilter();
  let mcpExecReceived = false;
  let cancelled = false;
  let latestCheckpoint: Uint8Array | null = null;

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
        if (serverMessage.message.case !== undefined &&
          (serverMessage.message.case !== "interactionUpdate" ||
            (serverMessage.message.value.message.case !== undefined &&
              serverMessage.message.value.message.case !== "heartbeat"))) {
          upstreamWatchdog.touch();
        }
        processServerMessage(
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
                sendSSE(makeChunk({ content }));
              }
            }
          },
          (exec) => {
            state.pendingExecs.push(exec);
            mcpExecReceived = true;

            const flushed = tagFilter.flush();
            if (flushed.reasoning) sendSSE(makeChunk({ reasoning_content: flushed.reasoning }));
            if (flushed.content) {
              appendAssistantTextToTurn(currentTurn, flushed.content);
              sendSSE(makeChunk({ content: flushed.content }));
            }

            currentTurn.steps.push({
              kind: "toolCall",
              toolCallId: exec.toolCallId,
              toolName: exec.toolName,
              arguments: parseToolCallArguments(exec.decodedArgs),
            });

            const toolCallIndex = state.toolCallIndex++;
            sendSSE(makeChunk({
              tool_calls: [{
                index: toolCallIndex, id: exec.toolCallId, type: "function",
                function: { name: exec.toolName, arguments: exec.decodedArgs },
              }],
            }));

            activeBridges.set(bridgeKey, {
              bridge, heartbeatTimer, blobStore, mcpTools, pendingExecs: state.pendingExecs, currentTurn,
            });
            debugLog("stream.tool_call_pause", { requestId, bridgeKey, exec, pendingExecs: state.pendingExecs, currentTurn });

            sendSSE(makeChunk({}, "tool_calls"));
            sendSSE(makeUsageChunk());
            sendDone();
            closeResponse();
          },
          (checkpointBytes) => {
            latestCheckpoint = checkpointBytes;
            const stored = conversationStates.get(convKey);
            if (stored) {
              stored.checkpoint = checkpointBytes;
              for (const [k, v] of blobStore) stored.blobStore.set(k, v);

              stored.lastAccessMs = Date.now();
            }
            debugLog("stream.checkpoint_buffered", { requestId, convKey, checkpointBytes });
          },
        );
      } catch (err) {
        console.error("[cursor-provider] Stream message processing error:", err instanceof Error ? err.message : err);
      }
    },
    (endStreamBytes) => {
      const endError = parseConnectEndStream(endStreamBytes);
      if (endError) {
        console.error(`[cursor-provider] Cursor stream error (${modelId}):`, endError.message);
        conversationStates.delete(convKey);
        sendSSE(makeChunk({ content: endError.message }, "error"));
        sendSSE(makeUsageChunk());
        sendDone();
        closeResponse();
      }
    },
  );

  bridge.onData(processChunk);

  bridge.onClose((code) => {
    debugLog("stream.bridge_close", { requestId, bridgeKey, convKey, code, cancelled, mcpExecReceived, currentTurn, latestCheckpoint });
    upstreamWatchdog.stop();
    clearInterval(heartbeatTimer);
    req.removeListener("close", onClientClose);
    res.removeListener("close", onClientClose);
    const stored = conversationStates.get(convKey);
    if (stored) {
      for (const [k, v] of blobStore) stored.blobStore.set(k, v);
      stored.lastAccessMs = Date.now();
      if (!cancelled && latestCheckpoint) {
        stored.checkpoint = latestCheckpoint;
        debugLog("stream.checkpoint_committed", { requestId, convKey, stored });
      }
    }
    if (cancelled) return;
    if (!mcpExecReceived) {
      const flushed = tagFilter.flush();
      if (flushed.reasoning) sendSSE(makeChunk({ reasoning_content: flushed.reasoning }));
      if (flushed.content) {
        appendAssistantTextToTurn(currentTurn, flushed.content);
        sendSSE(makeChunk({ content: flushed.content }));
      }
      sendSSE(makeChunk({}, "stop"));
      sendSSE(makeUsageChunk());
      sendDone();
      closeResponse();
    } else if (code !== 0) {
      sendSSE(makeChunk({ content: "Bridge connection lost" }, "error"));
      sendSSE(makeUsageChunk());
      sendDone();
      closeResponse();
      activeBridges.delete(bridgeKey);
    }
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
      turnToolStep.result = { content: result.content, isError: false };
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
      currentTurn,
    });
    debugLog("tool_resume.partial_wait", { requestId, bridgeKey, unresolvedExecs, currentTurn });
    respondWithPendingToolCalls(modelId, unresolvedExecs, stream, res, promptTokenEstimate);
    return;
  }

  for (const exec of pendingExecs) {
    const result = turnResults.get(exec.toolCallId);
    if (!result) continue;
    const mcpResult = create(McpResultSchema, {
      result: {
        case: "success",
        value: create(McpSuccessSchema, {
          content: [
            create(McpToolResultContentItemSchema, {
              content: { case: "text", value: create(McpTextContentSchema, { text: result.content }) },
            }),
          ],
          isError: false,
        }),
      },
    });

    const execClientMessage = create(ExecClientMessageSchema, {
      id: exec.execMsgId,
      execId: exec.execId,
      message: { case: "mcpResult" as any, value: mcpResult as any },
    });
    const clientMessage = create(AgentClientMessageSchema, {
      message: { case: "execClientMessage", value: execClientMessage },
    });
    bridge.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
    debugLog("tool_resume.sent_result", { requestId, exec, result });
  }

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
  );
}

// ── Non-streaming response ──

async function handleNonStreamingResponse(
  payload: CursorRequestPayload,
  accessToken: string,
  modelId: string,
  convKey: string,
  completedTurns: ParsedTurn[],
  currentTurn: ParsedTurn,
  req: IncomingMessage,
  res: ServerResponse,
  requestId?: string,
  promptTokenEstimate = 0,
): Promise<void> {
  debugLog("nonstream.start", { requestId, convKey, modelId, currentTurn, completedTurnCount: completedTurns.length });
  const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 28)}`;
  const created = Math.floor(Date.now() / 1000);

  const { bridge, heartbeatTimer } = startBridge(accessToken, payload.requestBytes);
  let cancelled = false;

  const onClientClose = () => {
    if (cancelled) return;
    debugLog("nonstream.client_close", { requestId, convKey });
    cancelled = true;
    clearInterval(heartbeatTimer);
    if (bridge.alive) {
      sendCancelAction(bridge);
      bridge.end();
    }
  };
  req.on("close", onClientClose);
  res.on("close", onClientClose);
  const state: StreamState = { toolCallIndex: 0, pendingExecs: [], outputTokens: 0, totalTokens: 0, promptTokenEstimate };
  const tagFilter = createThinkingTagFilter();
  let fullText = "";
  let nonStreamError: Error | null = null;
  let latestCheckpoint: Uint8Array | null = null;

  return new Promise((resolve) => {
    bridge.onData(createConnectFrameParser(
      (messageBytes) => {
        try {
          const serverMessage = fromBinary(AgentServerMessageSchema, messageBytes);
          processServerMessage(
            serverMessage, payload.blobStore, payload.mcpTools,
            (data) => bridge.write(data),
            state,
            (text, isThinking) => {
              if (isThinking) return;
              const { content } = tagFilter.process(text);
              fullText += content;
              appendAssistantTextToTurn(currentTurn, content);
            },
            () => {},
            (checkpointBytes) => {
              latestCheckpoint = checkpointBytes;
              const stored = conversationStates.get(convKey);
              if (stored) {
                stored.checkpoint = checkpointBytes;
                for (const [k, v] of payload.blobStore) stored.blobStore.set(k, v);
  
                stored.lastAccessMs = Date.now();
              }
              debugLog("nonstream.checkpoint_buffered", { requestId, convKey, checkpointBytes });
            },
          );
        } catch (err) {
          console.error("[cursor-provider] Non-stream message processing error:", err instanceof Error ? err.message : err);
        }
      },
      (endStreamBytes) => {
        const endError = parseConnectEndStream(endStreamBytes);
        if (endError) {
          console.error(`[cursor-provider] Cursor non-stream error (${modelId}):`, endError.message);
          conversationStates.delete(convKey);
          nonStreamError = endError;
        }
      },
    ));

    bridge.onClose(() => {
      debugLog("nonstream.bridge_close", { requestId, convKey, cancelled, nonStreamError: nonStreamError?.message, currentTurn, latestCheckpoint });
      clearInterval(heartbeatTimer);
      req.removeListener("close", onClientClose);
      res.removeListener("close", onClientClose);
      const stored = conversationStates.get(convKey);
      if (stored) {
        for (const [k, v] of payload.blobStore) stored.blobStore.set(k, v);
        stored.lastAccessMs = Date.now();
        if (!cancelled && !nonStreamError && latestCheckpoint) {
          stored.checkpoint = latestCheckpoint;
          debugLog("nonstream.checkpoint_committed", { requestId, convKey, stored });
        }
      }

      if (cancelled) {
        if (!res.headersSent) {
          res.writeHead(499, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Client closed request", type: "aborted", code: "client_closed" } }));
        }
        resolve();
        return;
      }

      if (nonStreamError) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: { message: nonStreamError.message, type: "upstream_error", code: "cursor_error" },
        }));
        resolve();
        return;
      }

      const flushed = tagFilter.flush();
      fullText += flushed.content;
      appendAssistantTextToTurn(currentTurn, flushed.content);
      const usage = computeUsage(state);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: completionId, object: "chat.completion", created, model: modelId,
        choices: [{ index: 0, message: { role: "assistant", content: fullText }, finish_reason: "stop" }],
        usage,
      }));
      resolve();
    });
  });
}
