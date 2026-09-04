import { createHash } from "node:crypto";

/**
 * Parent-owned controller provider adapter.
 *
 * The delegation broker only receives the pair of functions exposed by this module.  It never
 * receives a Pi model registry, credential store, or provider object.  The route resolver binds one
 * lease to one exact Pi model plus the already-resolved credential, and the transport consumes that
 * binding once.  This keeps all subscription families on Pi's native provider implementations
 * (including API dialects this extension does not need to reimplement) while keeping credentials in
 * the parent process.
 */
export const CONTROLLER_PROVIDER_ADAPTER_ID = "pi-native-provider@1";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODEL_ID = /^[A-Za-z0-9~][A-Za-z0-9._/:~-]{0,159}$/;
const PROVIDER_REASON = /^[a-z_]{1,64}$/;
// Native providers expose compound tool ids in two observed forms: OpenAI Responses joins
// `${call_id}|${item.id}`, while Cursor's Grok SSE adapter joins the same two bounded components
// with one LF. Keep both delimiters scoped to tool-call ids; route/snapshot ids stay stricter.
const TOOL_CALL_ID = /^(?=[\s\S]{1,128}$)[A-Za-z0-9][A-Za-z0-9._:-]*(?:(?:\||\n)[A-Za-z0-9][A-Za-z0-9._:-]*)?$/;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const ROUTE_CACHE_LIMIT = 256;
const ROUTE_CACHE_TTL_MS = 10 * 60 * 1000;
const SUPPORTED_CACHE_RETENTION = new Set(["none", "short", "long"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const FIXED_REASONS = Object.freeze({
	unsupportedTools: "unsupported_tools",
	invalidBlockStart: "invalid_block_start",
	invalidBlockDelta: "invalid_block_delta",
	invalidBlockEnd: "invalid_block_end",
	unsupportedStreamEvent: "unsupported_stream_event",
	truncatedBlock: "truncated_block",
	invalidModel: "invalid_model",
	invalidRequest: "invalid_request",
	contextWindow: "context_window_exceeded",
	subscriptionExtraUsage: "subscription_extra_usage_required",
	quota: "quota_exhausted",
	rateLimit: "rate_limited",
	auth: "auth_failed",
});

type Registry = {
	getAll?: () => readonly any[];
	find?: (provider: string, modelId: string) => any;
	getProvider?: (provider: string) => any;
	getApiKeyAndHeaders?: (model: any) => Promise<any>;
	getRegisteredProviderConfig?: (provider: string) => any;
};

type RouteBinding = {
	leaseId: string;
	resourceId: string;
	provider: string;
	modelId: string;
	model: any;
	providerRuntime: any;
	auth: {
		apiKey: string;
		headers?: Record<string, string | null>;
		env?: Record<string, string>;
		baseUrl?: string;
	};
	createdAt: number;
};

type NormalizedEvent =
	| { type: "headers"; payload: Record<string, unknown> }
	| { type: "block_start" | "text_delta" | "reasoning_delta" | "tool_call_delta" | "block_end" | "usage"; payload: Record<string, unknown> }
	| { type: "terminal"; outcome: string; payload: Record<string, unknown> };

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function fixedProviderReason(value: string): string | undefined {
	return PROVIDER_REASON.test(value) ? value : undefined;
}

function parseResourceId(resourceId: unknown): { provider: string; modelId: string } | undefined {
	if (typeof resourceId !== "string") return undefined;
	const separator = resourceId.indexOf("/");
	if (separator < 1 || separator === resourceId.length - 1) return undefined;
	const provider = resourceId.slice(0, separator);
	const modelId = resourceId.slice(separator + 1);
	if (!PROVIDER_ID.test(provider) || !MODEL_ID.test(modelId)) return undefined;
	return { provider, modelId };
}

function boundedRouteText(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\0-\x1f]/.test(value)
		? value
		: fallback;
}

function endpointFor(model: any, providerRuntime: any, auth: any): string {
	return boundedRouteText(
		auth?.baseUrl ?? model?.baseUrl ?? providerRuntime?.baseUrl,
		"native-provider",
	);
}

function modelApi(model: any, provider: string, registry: Registry): string | undefined {
	if (typeof model?.api === "string" && model.api.length > 0) return model.api;
	const configured = registry.getRegisteredProviderConfig?.(provider);
	return typeof configured?.api === "string" && configured.api.length > 0 ? configured.api : undefined;
}

function modelIdentity(model: any, provider: string, modelId: string): Record<string, unknown> {
	return {
		provider,
		modelId,
		api: typeof model?.api === "string" ? model.api : undefined,
		baseUrl: typeof model?.baseUrl === "string" ? model.baseUrl : undefined,
		contextWindow: Number.isSafeInteger(model?.contextWindow) ? model.contextWindow : undefined,
		maxTokens: Number.isSafeInteger(model?.maxTokens) ? model.maxTokens : undefined,
	};
}

function poolFingerprint(registry: Registry, selected: Record<string, unknown>): string {
	let models: any[] = [];
	try {
		models = [...(registry.getAll?.() ?? [])]
			.filter((model) => typeof model?.provider === "string" && typeof model?.id === "string")
			.map((model) => modelIdentity(model, model.provider, model.id))
			.slice(0, 10_000);
	} catch {
		models = [];
	}
	if (models.length === 0 || !models.some((model) => model.provider === selected.provider && model.modelId === selected.modelId)) {
		models.push(selected);
	}
	models.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
	return digest(JSON.stringify(models));
}

function endpointId(provider: string, modelId: string, endpoint: string): string {
	return `pi-native-${digest(`${provider}\0${modelId}\0${endpoint}`).slice(0, 32)}`;
}

function headerValue(headers: unknown, name: string): string | undefined {
	if (!headers || typeof headers !== "object") return undefined;
	if (typeof (headers as any).get === "function") {
		const value = (headers as any).get(name);
		return typeof value === "string" ? value : undefined;
	}
	const record = headers as Record<string, unknown>;
	const exact = record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()];
	return typeof exact === "string" ? exact : undefined;
}

function responsePayload(status: unknown, headers: unknown): Record<string, unknown> {
	const payload: Record<string, unknown> = {};
	if (Number.isInteger(status) && Number(status) >= 100 && Number(status) <= 599) {
		payload.httpStatus = Number(status);
	}
	const requestId = headerValue(headers, "request-id") ?? headerValue(headers, "x-request-id");
	if (typeof requestId === "string" && ID.test(requestId)) payload.providerRequestId = requestId;
	return payload;
}

function usageFrom(value: any): Record<string, number> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const read = (key: string): number =>
		Number.isSafeInteger(value[key]) && value[key] >= 0 ? value[key] : 0;
	return {
		input: read("input"),
		output: read("output"),
		cacheRead: read("cacheRead"),
		cacheWrite: read("cacheWrite"),
	};
}

function messageText(value: any): string {
	if (typeof value === "string") return value;
	if (value && typeof value === "object") {
		if (typeof value.errorMessage === "string") return value.errorMessage;
		if (typeof value.message === "string") return value.message;
	}
	return "";
}

function errorClassification(status: number | undefined, message: string, aborted: boolean, headersSeen: boolean) {
	const lower = message.toLowerCase();
	if (aborted) return { outcome: "cancelled_after_send", reason: undefined };
	if (lower.includes("context window") || lower.includes("context length") || lower.includes("too many tokens")) {
		return { outcome: "context_window_exceeded", reason: FIXED_REASONS.contextWindow };
	}
	if (lower.includes("extra usage") || lower.includes("plan limits")) {
		return { outcome: "rejected_before_send", reason: FIXED_REASONS.subscriptionExtraUsage };
	}
	if (status === 429 || lower.includes("rate limit") || lower.includes("too many requests")) {
		return { outcome: "rate_limited", reason: FIXED_REASONS.rateLimit };
	}
	if (status === 402 || lower.includes("insufficient balance") || lower.includes("quota exhausted") || lower.includes("usage limit")) {
		return { outcome: "quota_fatal", reason: FIXED_REASONS.quota };
	}
	if (status === 401 || status === 403 || lower.includes("unauthorized") || lower.includes("invalid api key") || lower.includes("authentication")) {
		return { outcome: "auth_fatal", reason: FIXED_REASONS.auth };
	}
	if (status !== undefined && status >= 400 && status < 500) {
		return { outcome: "rejected_before_send", reason: FIXED_REASONS.invalidRequest };
	}
	return { outcome: headersSeen ? "stream_truncated" : "transport_before_headers", reason: undefined };
}

function verifySnapshot(snapshot: any): void {
	if (!snapshot || typeof snapshot !== "object") throw new Error("controller provider snapshot is unavailable");
	if (snapshot.adapterId !== CONTROLLER_PROVIDER_ADAPTER_ID) throw new Error("controller provider snapshot uses an unsupported adapter");
	if (typeof snapshot.leaseId !== "string" || !ID.test(snapshot.leaseId)) throw new Error("controller provider snapshot lease is invalid");
	if (typeof snapshot.resourceId !== "string" || !MODEL_ID.test(snapshot.resourceId.slice(snapshot.resourceId.indexOf("/") + 1))) throw new Error("controller provider snapshot resource is invalid");
	if (typeof snapshot.provider !== "string" || !PROVIDER_ID.test(snapshot.provider)) throw new Error("controller provider snapshot provider is invalid");
	if (typeof snapshot.model !== "string" || !MODEL_ID.test(snapshot.model)) throw new Error("controller provider snapshot model is invalid");
	if (!SUPPORTED_CACHE_RETENTION.has(snapshot.cacheRetention)) throw new Error("controller provider snapshot cache retention is invalid");
	for (const key of ["maxInputBytes", "maxOutputBytes", "maxOutputTokens"]) {
		if (!Number.isSafeInteger(snapshot[key]) || snapshot[key] < 1) throw new Error(`controller provider snapshot ${key} is invalid`);
	}
}

function sameBinding(snapshot: any, binding: RouteBinding): boolean {
	return snapshot.leaseId === binding.leaseId
		&& snapshot.resourceId === binding.resourceId
		&& snapshot.provider === binding.provider
		&& snapshot.model === binding.modelId;
}

function ensureSupportedContext(context: any): void {
	if (!Array.isArray(context?.messages) || context.messages.length === 0) {
		throw new Error("controller provider requires replayable messages");
	}
	if (context.tools !== undefined && !Array.isArray(context.tools)) {
		throw new Error("controller provider tool context is invalid");
	}
}

function nativeMessage(message: any): any {
	if (message.role === "assistant" && Array.isArray(message.content)) {
		return {
			role: "assistant",
			content: message.content.map((block: any) => block.type === "toolCall"
				? {
					type: "toolCall",
					id: block.id,
					name: block.name,
					arguments: block.arguments,
					...(block.namespace === undefined ? {} : { namespace: block.namespace }),
				}
				: { type: "text", text: block.text }),
		};
	}
	if (message.role === "toolResult") {
		return {
			role: "toolResult",
			content: [{ type: "text", text: message.content }],
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			isError: message.isError,
		};
	}
	return { role: message.role, content: message.content };
}

function nativeContext(context: any): any {
	return {
		...(typeof context.systemPrompt === "string" ? { systemPrompt: context.systemPrompt } : {}),
		messages: context.messages.map(nativeMessage),
		tools: (Array.isArray(context.tools) ? context.tools : []).map((tool: any) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema,
		})),
	};
}

function blockTypeFor(eventType: string): "text" | "reasoning" | undefined {
	if (eventType.startsWith("text_")) return "text";
	if (eventType.startsWith("thinking_")) return "reasoning";
	return undefined;
}

/**
 * Build the credentialless provider pair consumed by the delegation broker.
 * `resolveModel` is supplied by pi-multi-account so an only-active filter can still resolve a
 * hidden rotation slot. It must return the exact model object registered for the provider.
 */
export function createControllerProvider({
	modelRegistry,
	resolveModel,
	preparePayload,
	cleanupSession,
	now = () => Date.now(),
}: {
	modelRegistry: Registry;
	resolveModel?: (provider: string, modelId: string) => any;
	preparePayload?: (payload: unknown, model: any, snapshot: any) => unknown | undefined;
	cleanupSession?: (sessionId: string, provider: string) => void;
	now?: () => number;
}): { providerTransport: { stream: (snapshot: any, context: any, options?: any) => AsyncIterable<NormalizedEvent> }; routeResolver: (lease: any, request?: any) => Promise<Record<string, unknown>>; routePreflight: (request: any) => Promise<Record<string, unknown>> } {
	if (!modelRegistry || typeof modelRegistry !== "object") throw new Error("controller provider requires a model registry");
	const resolveAuth = typeof modelRegistry.getApiKeyAndHeaders === "function"
		? modelRegistry.getApiKeyAndHeaders.bind(modelRegistry)
		: undefined;
	if (!resolveAuth) throw new Error("controller provider requires Pi auth resolution");
	if (typeof now !== "function") throw new Error("controller provider clock is invalid");

	const bindings = new Map<string, RouteBinding>();
	let registryVersion = 0;
	let lastRegistryFingerprint = "";

	/**
	 * Check the exact route that the broker is about to lease without opening a
	 * provider stream. This is deliberately a safe readiness result: no model
	 * object, endpoint, credential, or provider error crosses the boundary.
	 */
	const routePreflight = async (request: any): Promise<Record<string, unknown>> => {
		const parsed = parseResourceId(request?.resourceId);
		if (!parsed) return Object.freeze({ status: "unavailable", reason: "invalid_route", scope: "resource" });
		let model: any;
		try {
			model = resolveModel?.(parsed.provider, parsed.modelId) ?? modelRegistry.find?.(parsed.provider, parsed.modelId);
		} catch {
			return Object.freeze({ status: "unavailable", reason: "model_lookup_failed", scope: "resource" });
		}
		if (!model || model.provider !== parsed.provider || model.id !== parsed.modelId) {
			return Object.freeze({ status: "unavailable", reason: "model_not_registered", scope: "resource" });
		}
		let providerRuntime: any;
		try { providerRuntime = modelRegistry.getProvider?.(parsed.provider); } catch {
			return Object.freeze({ status: "unavailable", reason: "provider_runtime_unavailable", scope: "resource" });
		}
		if (!providerRuntime || typeof providerRuntime.streamSimple !== "function") {
			return Object.freeze({ status: "unavailable", reason: "provider_runtime_unavailable", scope: "resource" });
		}
		let auth: any;
		try { auth = await resolveAuth(model); } catch {
			return Object.freeze({ status: "unavailable", reason: "credential_resolution_failed", scope: "resource" });
		}
		if (!auth || auth.ok !== true || typeof auth.apiKey !== "string" || auth.apiKey.length < 1 || auth.apiKey.length > 4_096 || /[\0\r\n]/.test(auth.apiKey)) {
			return Object.freeze({ status: "unavailable", reason: "credential_unavailable", scope: "resource" });
		}
		let apiDialect: string | undefined;
		try { apiDialect = modelApi(model, parsed.provider, modelRegistry); } catch {
			return Object.freeze({ status: "unavailable", reason: "api_dialect_unavailable", scope: "resource" });
		}
		if (!apiDialect) return Object.freeze({ status: "unavailable", reason: "api_dialect_unavailable", scope: "resource" });
		return Object.freeze({ status: "ready" });
	};

	function pruneBindings(at = now()): void {
		for (const [leaseId, binding] of bindings) {
			if (at - binding.createdAt > ROUTE_CACHE_TTL_MS) bindings.delete(leaseId);
		}
		while (bindings.size > ROUTE_CACHE_LIMIT) {
			const oldest = bindings.keys().next().value;
			if (typeof oldest !== "string") break;
			bindings.delete(oldest);
		}
	}

	const routeResolver = async (lease: any, request: any = {}): Promise<Record<string, unknown>> => {
		pruneBindings();
		const requestedReasoning = request?.reasoningEffort;
		if (requestedReasoning !== undefined && (typeof requestedReasoning !== "string" || !THINKING_LEVELS.has(requestedReasoning))) {
			throw new Error("controller reasoning effort is invalid");
		}
		const parsed = parseResourceId(lease?.resourceId);
		if (!parsed || typeof lease?.leaseId !== "string" || !ID.test(lease.leaseId)) {
			throw new Error("controller provider lease is not bound to a model route");
		}
		const model = resolveModel?.(parsed.provider, parsed.modelId) ?? modelRegistry.find?.(parsed.provider, parsed.modelId);
		if (!model || model.provider !== parsed.provider || model.id !== parsed.modelId) {
			throw new Error("controller provider model is no longer registered");
		}
		const providerRuntime = modelRegistry.getProvider?.(parsed.provider);
		if (!providerRuntime || typeof providerRuntime.streamSimple !== "function") {
			throw new Error("controller provider runtime is unavailable");
		}
		let auth: any;
		try {
			auth = await resolveAuth(model);
		} catch {
			throw new Error("controller provider credential resolution failed");
		}
		if (!auth || auth.ok !== true || typeof auth.apiKey !== "string" || auth.apiKey.length < 1 || auth.apiKey.length > 4_096 || /[\0\r\n]/.test(auth.apiKey)) {
			throw new Error("controller provider credential is unavailable");
		}
		const apiDialect = modelApi(model, parsed.provider, modelRegistry);
		if (!apiDialect) throw new Error("controller provider model API dialect is unavailable");
		const nativeModel = Object.freeze({ ...model, api: apiDialect });
		const endpoint = endpointFor(nativeModel, providerRuntime, auth);
		const selected = modelIdentity(nativeModel, parsed.provider, parsed.modelId);
		const fingerprint = poolFingerprint(modelRegistry, selected);
		if (fingerprint !== lastRegistryFingerprint) {
			lastRegistryFingerprint = fingerprint;
			registryVersion = Math.min(Number.MAX_SAFE_INTEGER, registryVersion + 1);
		}
		const binding: RouteBinding = {
			leaseId: lease.leaseId,
			resourceId: lease.resourceId,
			provider: parsed.provider,
			modelId: parsed.modelId,
			model: nativeModel,
			providerRuntime,
			auth: Object.freeze({
				apiKey: auth.apiKey,
				...(auth.headers && typeof auth.headers === "object" ? { headers: Object.freeze({ ...auth.headers }) } : {}),
				...(auth.env && typeof auth.env === "object" ? { env: Object.freeze({ ...auth.env }) } : {}),
				...(typeof auth.baseUrl === "string" ? { baseUrl: auth.baseUrl } : {}),
			}),
			createdAt: now(),
		};
		bindings.set(lease.leaseId, binding);
		pruneBindings(binding.createdAt);
		return Object.freeze({
			registryFingerprint: fingerprint,
			registryVersion: Math.max(1, registryVersion),
			accountAlias: parsed.provider,
			provider: parsed.provider,
			model: parsed.modelId,
			reasoningEffort: requestedReasoning ?? "off",
			apiDialect,
			endpointId: endpointId(parsed.provider, parsed.modelId, endpoint),
			adapterId: CONTROLLER_PROVIDER_ADAPTER_ID,
			credentialRefFingerprint: digest(`native:${auth.apiKey}`),
			cacheRetention: "none",
		});
	};

	const providerTransport = {
		async *stream(snapshot: any, context: any, options: any = {}): AsyncIterable<NormalizedEvent> {
			verifySnapshot(snapshot);
			const binding = bindings.get(snapshot.leaseId);
			if (!binding || !sameBinding(snapshot, binding)) throw new Error("controller provider route binding is unavailable");
			bindings.delete(snapshot.leaseId);
			try {
			let responseStatus: number | undefined;
			let responseHeaders: unknown;
			let headersSeen = false;
			let terminalSeen = false;
			let semanticOutputSeen = false;
			let toolCallSeen = false;
			let totalOutputBytes = 0;
			const toolNames = new Set((Array.isArray(context.tools) ? context.tools : []).map((tool: any) => tool?.name));
			const seenToolCallIds = new Set<string>();
			const openBlocks = new Map<number, { type: "text" | "reasoning" | "tool_call"; value: string; bytes: number }>();
			const headerPayload = () => responsePayload(responseStatus, responseHeaders);
			const terminal = (outcome: string, reason?: string, finishReason?: string): NormalizedEvent => ({
				type: "terminal",
				outcome,
				payload: {
					...headerPayload(),
					...(finishReason === undefined ? {} : { finishReason }),
					...(reason && fixedProviderReason(reason) ? { providerReason: reason } : {}),
				},
			});
			try {
				ensureSupportedContext(context);
			} catch (error) {
				const reason = Array.isArray(context?.tools) && context.tools.length > 0
					? FIXED_REASONS.unsupportedTools
					: FIXED_REASONS.invalidRequest;
				yield terminal("rejected_before_send", reason);
				return;
			}
			if (options.signal?.aborted) {
				yield terminal("cancelled_before_send");
				return;
			}
			if (Number.isSafeInteger(snapshot.deadlineAt) && snapshot.deadlineAt <= now()) {
				yield terminal("deadline_exceeded_before_send");
				return;
			}

			const onResponse = (response: any) => {
				responseStatus = Number.isInteger(response?.status) ? response.status : undefined;
				responseHeaders = response?.headers;
			};
			let stream: AsyncIterable<any>;
			try {
				// Native providers are lazy streams: invoking streamSimple prepares the request, and
				// iteration performs the one network dispatch. Acknowledging immediately before both
				// keeps the controller's send phase ahead of either implementation detail.
				options.onSendStarted?.();
				stream = binding.providerRuntime.streamSimple(
					{
						...binding.model,
						...(binding.auth.baseUrl ? { baseUrl: binding.auth.baseUrl } : {}),
					},
					nativeContext(context),
					{
						apiKey: binding.auth.apiKey,
						...(binding.auth.headers ? { headers: binding.auth.headers } : {}),
						...(binding.auth.env ? { env: binding.auth.env } : {}),
						signal: options.signal,
						maxTokens: snapshot.maxOutputTokens,
						maxRetries: 0,
						timeoutMs: Math.max(1, snapshot.deadlineAt - now()),
						cacheRetention: snapshot.cacheRetention,
						sessionId: snapshot.taskId,
						...(/^(?:cursor|cursor-account-\d+)$/.test(binding.provider) ? { transport: "sse" } : {}),
						...(snapshot.reasoningEffort && snapshot.reasoningEffort !== "off" ? { reasoning: snapshot.reasoningEffort } : {}),
						...(preparePayload ? {
							onPayload: (payload: unknown, model: any) => preparePayload(payload, model, snapshot),
						} : {}),
						onResponse,
					},
				);
			} catch (error) {
				if (responseStatus !== undefined && !headersSeen) {
					headersSeen = true;
					yield { type: "headers", payload: headerPayload() };
				}
				const classification = errorClassification(responseStatus, messageText(error), Boolean(options.signal?.aborted), headersSeen);
				yield terminal(classification.outcome, classification.reason);
				return;
			}

			try {
				for await (const event of stream) {
					if (terminalSeen) break;
					if (event?.type === "error") {
						if (responseStatus !== undefined && !headersSeen) {
							headersSeen = true;
							yield { type: "headers", payload: headerPayload() };
						}
						const classification = errorClassification(
							responseStatus,
							messageText(event.error),
							event.reason === "aborted" || Boolean(options.signal?.aborted),
							headersSeen,
						);
						terminalSeen = true;
						yield terminal(classification.outcome, classification.reason);
						return;
					}
					if (!headersSeen) {
						headersSeen = true;
						yield { type: "headers", payload: headerPayload() };
					}
					const type = typeof event?.type === "string" ? event.type : "";
					if (type === "start") continue;
					if (type === "text_start" || type === "thinking_start") {
						const index = event.contentIndex;
						const blockType = blockTypeFor(type);
						if (!Number.isSafeInteger(index) || index < 0 || !blockType || openBlocks.has(index)) {
							terminalSeen = true;
							yield terminal("malformed_provider_frame", FIXED_REASONS.invalidBlockStart);
							return;
						}
						openBlocks.set(index, { type: blockType, value: "", bytes: 0 });
						if (blockType === "reasoning") continue;
						yield { type: "block_start", payload: { index, blockType } };
						continue;
					}
					if (type === "text_delta" || type === "thinking_delta") {
						const index = event.contentIndex;
						const block = openBlocks.get(index);
						const expected = type === "text_delta" ? "text" : "reasoning";
						if (!block || block.type !== expected || typeof event.delta !== "string" || event.delta.length === 0) {
							terminalSeen = true;
							yield terminal("malformed_provider_frame", FIXED_REASONS.invalidBlockDelta);
							return;
						}
						const bytes = Buffer.byteLength(event.delta, "utf8");
						if (block.bytes + bytes > snapshot.maxOutputBytes || totalOutputBytes + bytes > snapshot.maxOutputBytes) {
							terminalSeen = true;
							yield terminal("malformed_provider_frame");
							return;
						}
						block.value += event.delta;
						block.bytes += bytes;
						totalOutputBytes += bytes;
						if (expected === "reasoning") continue;
						yield { type, payload: { index, delta: event.delta } };
						continue;
					}
					if (type === "text_end" || type === "thinking_end") {
						const index = event.contentIndex;
						const block = openBlocks.get(index);
						const expected = type === "text_end" ? "text" : "reasoning";
						const contentBytes = typeof event.content === "string" ? Buffer.byteLength(event.content, "utf8") : Infinity;
						// OpenAI Responses streams one reasoning representation, then may replace it with
						// a summarized form at output_item.done. Reasoning never crosses this controller
						// boundary, so validate/bound the final value but do not require byte equality.
						const contentMatches = expected === "reasoning" || event.content === block?.value;
						if (!block || block.type !== expected || typeof event.content !== "string"
							|| contentBytes > snapshot.maxOutputBytes || !contentMatches) {
							terminalSeen = true;
							yield terminal("malformed_provider_frame", FIXED_REASONS.invalidBlockEnd);
							return;
						}
						openBlocks.delete(index);
						if (block.type === "reasoning") continue;
						if (event.content.length > 0) semanticOutputSeen = true;
						yield { type: "block_end", payload: { index, value: event.content } };
						continue;
					}
					if (type === "toolcall_start") {
						const index = event.contentIndex;
						if (!Number.isSafeInteger(index) || index < 0 || openBlocks.has(index)) {
							terminalSeen = true;
							yield terminal("malformed_provider_frame", FIXED_REASONS.unsupportedTools);
							return;
						}
						toolCallSeen = true;
						openBlocks.set(index, { type: "tool_call", value: "", bytes: 0 });
						continue;
					}
					if (type === "toolcall_delta") {
						const index = event.contentIndex;
						const block = openBlocks.get(index);
						if (!block || block.type !== "tool_call" || typeof event.delta !== "string" || event.delta.length === 0) {
							terminalSeen = true;
							yield terminal("malformed_provider_frame", FIXED_REASONS.unsupportedTools);
							return;
						}
						const bytes = Buffer.byteLength(event.delta, "utf8");
						if (block.bytes + bytes > snapshot.maxOutputBytes || totalOutputBytes + bytes > snapshot.maxOutputBytes) {
							terminalSeen = true;
							yield terminal("malformed_provider_frame", FIXED_REASONS.unsupportedTools);
							return;
						}
						block.value += event.delta;
						block.bytes += bytes;
						totalOutputBytes += bytes;
						continue;
					}
					if (type === "toolcall_end") {
						const index = event.contentIndex;
						const block = openBlocks.get(index);
						const toolCall = event.toolCall;
						const unsupportedField = toolCall && typeof toolCall === "object"
							? Object.keys(toolCall).find((key) => !["type", "id", "name", "arguments"].includes(key))
							: undefined;
					if (!block || block.type !== "tool_call" || !toolCall || typeof toolCall !== "object"
							|| unsupportedField || toolCall.type !== "toolCall"
							|| typeof toolCall.id !== "string" || !TOOL_CALL_ID.test(toolCall.id)
							|| seenToolCallIds.has(toolCall.id) || typeof toolCall.name !== "string" || !TOOL_NAME.test(toolCall.name)
							|| !toolNames.has(toolCall.name) || !toolCall.arguments || typeof toolCall.arguments !== "object"
							|| Array.isArray(toolCall.arguments)) {
							terminalSeen = true;
							yield terminal("malformed_provider_frame", FIXED_REASONS.unsupportedTools);
							return;
						}
						let argumentsJson: string;
						try { argumentsJson = JSON.stringify(toolCall.arguments); } catch {
							terminalSeen = true;
							yield terminal("malformed_provider_frame", FIXED_REASONS.unsupportedTools);
							return;
						}
						const value = block.value || argumentsJson;
						let parsedArguments: unknown;
						try { parsedArguments = JSON.parse(value); } catch {
							terminalSeen = true;
							yield terminal("malformed_provider_frame", FIXED_REASONS.unsupportedTools);
							return;
						}
						if (!parsedArguments || typeof parsedArguments !== "object" || Array.isArray(parsedArguments)
							|| JSON.stringify(parsedArguments) !== argumentsJson || Buffer.byteLength(value, "utf8") > snapshot.maxOutputBytes) {
							terminalSeen = true;
							yield terminal("malformed_provider_frame", FIXED_REASONS.unsupportedTools);
							return;
						}
						if (!block.value) {
							block.value = value;
							block.bytes = Buffer.byteLength(value, "utf8");
							totalOutputBytes += block.bytes;
						}
						seenToolCallIds.add(toolCall.id);
						yield { type: "block_start", payload: { index, blockType: "tool_call", id: toolCall.id, name: toolCall.name } };
						yield { type: "tool_call_delta", payload: { index, delta: block.value } };
						yield { type: "block_end", payload: { index, value: block.value } };
						openBlocks.delete(index);
						continue;
					}
					if (type === "done") {
						if (openBlocks.size > 0) {
							terminalSeen = true;
							yield terminal("stream_truncated", FIXED_REASONS.truncatedBlock);
							return;
						}
						const usage = usageFrom(event.message?.usage);
						if (usage) yield { type: "usage", payload: usage };
						const semanticOutput = semanticOutputSeen || (event.message?.content?.some?.((part: any) =>
							part?.type === "text" && typeof part.text === "string" && part.text.length > 0,
						) ?? false);
						terminalSeen = true;
						if (event.reason === "toolUse" || toolCallSeen) {
							if (!toolCallSeen) yield terminal("malformed_provider_frame", FIXED_REASONS.unsupportedTools);
							else yield terminal("succeeded_terminal", undefined, "tool_use");
						} else if (event.reason === "stop") {
							yield terminal(semanticOutput ? "succeeded_terminal" : "empty_response", undefined, "stop");
						} else if (event.reason === "length") {
							yield terminal("unknown_finish", undefined, "length");
						} else if (event.reason === "aborted") {
							yield terminal("cancelled_after_send");
						} else if (event.reason === "deferred") {
							yield terminal("malformed_provider_frame", FIXED_REASONS.unsupportedTools);
						} else if (event.reason === "error") {
							const classification = errorClassification(responseStatus, messageText(event.message), Boolean(options.signal?.aborted), headersSeen);
							yield terminal(classification.outcome, classification.reason);
						} else {
							yield terminal("unknown_finish");
						}
						return;
					}
					yield terminal("malformed_provider_frame", FIXED_REASONS.unsupportedStreamEvent);
					return;
				}
				if (!terminalSeen) {
					if (!headersSeen && responseStatus !== undefined) {
						headersSeen = true;
						yield { type: "headers", payload: headerPayload() };
					}
					terminalSeen = true;
					yield terminal(
						options.signal?.aborted
							? "cancelled_after_send"
							: headersSeen
								? "stream_truncated"
								: "transport_before_headers",
					);
				}
			} catch (error) {
				if (terminalSeen) return;
				terminalSeen = true;
				const classification = errorClassification(responseStatus, messageText(error), Boolean(options.signal?.aborted), headersSeen);
				yield terminal(classification.outcome, classification.reason);
			}
			} finally {
				cleanupSession?.(snapshot.taskId, binding.provider);
			}
		},
	};

	return Object.freeze({ providerTransport: Object.freeze(providerTransport), routeResolver, routePreflight });
}

export function isControllerProviderPair(value: unknown): value is { providerTransport: { stream: Function }; routeResolver: Function; routePreflight: Function } {
	return Boolean(value && typeof value === "object" && !Array.isArray(value)
		&& typeof (value as any).providerTransport?.stream === "function"
		&& typeof (value as any).routeResolver === "function"
		&& typeof (value as any).routePreflight === "function");
}
