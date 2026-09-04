import assert from "node:assert/strict";
import test from "node:test";
import {
	CONTROLLER_PROVIDER_ADAPTER_ID,
	createControllerProvider,
} from "../controller-provider.ts";

const SECRET = "oauth-access-secret-that-must-stay-in-the-parent";

function makeRegistry(models: any[], options: { events?: any[] } = {}) {
	const calls: any[] = [];
	const events = options.events ?? [
		{ type: "start", partial: {} },
		{ type: "text_start", contentIndex: 0, partial: {} },
		{ type: "text_delta", contentIndex: 0, delta: "hello", partial: {} },
		{ type: "text_end", contentIndex: 0, content: "hello", partial: {} },
		{
			type: "done",
			reason: "stop",
			message: {
				content: [{ type: "text", text: "hello" }],
				usage: { input: 4, output: 2, cacheRead: 1, cacheWrite: 0 },
			},
		},
	];
	const registry: any = {
		getAll: () => models,
		find: (provider: string, modelId: string) =>
			models.find((model) => model.provider === provider && model.id === modelId),
		getProvider: (_provider: string) => ({
			baseUrl: "https://provider.example/v1",
			streamSimple: (model: any, context: any, request: any) => {
				const payload = { model: model.id, messages: [{ role: "user", content: "hello" }], stream: true };
				const preparedPayload = request.onPayload?.(payload, model) ?? payload;
				calls.push({ model, context, request, payload: preparedPayload });
				request.onResponse?.({ status: 200, headers: { "request-id": "req-1" } });
				return (async function* () {
					for (const event of events) yield event;
				})();
			},
		}),
		getApiKeyAndHeaders: async (_model: any) => ({
			ok: true,
			apiKey: SECRET,
			headers: { "x-parent-only": "yes" },
			env: { PARENT_ONLY: "yes" },
			baseUrl: "https://provider.example/v1",
		}),
	};
	return { registry, calls };
}

function model(provider: string, id: string, api: string) {
	return {
		provider,
		id,
		api,
		baseUrl: "https://provider.example/v1",
		contextWindow: 272_000,
		maxTokens: 32_000,
	};
}

function lease(leaseId: string, provider: string, modelId: string) {
	return {
		leaseId,
		resourceId: `${provider}/${modelId}`,
		capacityGroup: `G-${provider}`,
		profile: "caps/code_reasoning/v1",
	};
}

function snapshot(route: any, sourceLease: any) {
	return {
		taskId: `task-${sourceLease.leaseId}`,
		leaseId: sourceLease.leaseId,
		fencingToken: 1,
		registryFingerprint: route.registryFingerprint,
		registryVersion: route.registryVersion,
		resourceId: sourceLease.resourceId,
		capacityGroup: sourceLease.capacityGroup,
		profile: sourceLease.profile,
		accountAlias: route.accountAlias,
		provider: route.provider,
		model: route.model,
		reasoningEffort: route.reasoningEffort,
		apiDialect: route.apiDialect,
		endpointId: route.endpointId,
		adapterId: route.adapterId,
		credentialRefFingerprint: route.credentialRefFingerprint,
		cacheRetention: route.cacheRetention,
		maxInputBytes: 100_000,
		maxOutputBytes: 100_000,
		maxOutputTokens: 1_000,
		deadlineAt: Date.now() + 10_000,
	};
}

test("routeResolver covers the current native provider pool without returning credentials", async () => {
	const models = [
		model("cursor", "cursor-grok-4.6", "openai-completions"),
		model("openai-codex-account-2", "gpt-5.6-luna", "openai-codex-responses"),
		model("kimi-coding", "k3", "anthropic-messages"),
		model("anthropic", "claude-opus-4-8", "anthropic-messages"),
		model("zai", "glm-5.3", "openai-completions"),
		model("minimax", "MiniMax-M3", "openai-completions"),
	];
	const { registry } = makeRegistry(models);
	const pair = createControllerProvider({ modelRegistry: registry });
	const routes = [];
	for (const [index, current] of models.entries()) {
		const currentLease = lease(`lease-${index + 1}`, current.provider, current.id);
		const route = await pair.routeResolver(currentLease);
		routes.push(route);
		assert.equal(route.provider, current.provider);
		assert.equal(route.model, current.id);
		assert.equal(route.adapterId, CONTROLLER_PROVIDER_ADAPTER_ID);
		assert.match(String(route.credentialRefFingerprint), /^[a-f0-9]{64}$/);
		assert.doesNotMatch(JSON.stringify(route), new RegExp(SECRET));
	}
	assert.equal(new Set(routes.map((route) => route.endpointId)).size, models.length);
	assert.equal(new Set(routes.map((route) => route.registryFingerprint)).size, 1);
	await assert.rejects(
		pair.routeResolver(lease("lease-invalid-effort", models[0].provider, models[0].id), { reasoningEffort: "turbo" }),
		/controller reasoning effort is invalid/,
	);
});

test("routePreflight rejects stale or unresolvable routes without exposing credentials", async () => {
	const currentModel = model("zai", "glm-5.3", "openai-completions");
	const { registry } = makeRegistry([currentModel]);
	const pair = createControllerProvider({ modelRegistry: registry });
	assert.deepEqual(await pair.routePreflight({ resourceId: "zai/removed-model" }), {
		status: "unavailable", reason: "model_not_registered", scope: "resource",
	});
	assert.deepEqual(await pair.routePreflight({ resourceId: currentModel.provider + "/" + currentModel.id }), { status: "ready" });
	registry.getApiKeyAndHeaders = async () => ({ ok: false });
	const unavailablePair = createControllerProvider({ modelRegistry: registry });
	const unavailable = await unavailablePair.routePreflight({ resourceId: currentModel.provider + "/" + currentModel.id });
	assert.deepEqual(unavailable, { status: "unavailable", reason: "credential_unavailable", scope: "resource" });
	assert.doesNotMatch(JSON.stringify(unavailable), new RegExp(SECRET));
});

test("native transport maps Pi events and consumes one exact lease binding", async () => {
	const currentModel = model("openai-codex-account-2", "gpt-5.6-luna", "openai-codex-responses");
	const { registry, calls } = makeRegistry([currentModel]);
	const cleaned: Array<{ sessionId: string; provider: string }> = [];
	const pair = createControllerProvider({
		modelRegistry: registry,
		preparePayload: (payload, _model, currentSnapshot) => ({ ...(payload as any), controller_task: currentSnapshot.taskId }),
		cleanupSession: (sessionId, provider) => cleaned.push({ sessionId, provider }),
	});
	const currentLease = lease("lease-stream", currentModel.provider, currentModel.id);
	const route = await pair.routeResolver(currentLease, { reasoningEffort: "high" });
	const sent: string[] = [];
	const output = [];
	for await (const event of pair.providerTransport.stream(
		snapshot(route, currentLease),
		{ systemPrompt: "system", messages: [{ role: "user", content: "say hello" }] },
		{ onSendStarted: () => sent.push("started") },
	)) {
		output.push(event);
	}

	assert.deepEqual(sent, ["started"]);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].request.apiKey, SECRET);
	assert.equal(calls[0].request.maxRetries, 0);
	assert.equal(calls[0].request.maxTokens, 1_000);
	assert.equal(calls[0].request.reasoning, "high");
	assert.equal(calls[0].request.sessionId, "task-lease-stream");
	assert.equal(calls[0].payload.controller_task, "task-lease-stream");
	assert.deepEqual(cleaned, [{ sessionId: "task-lease-stream", provider: currentModel.provider }]);
	assert.deepEqual(calls[0].context, {
		systemPrompt: "system",
		messages: [{ role: "user", content: "say hello" }],
		tools: [],
	});
	assert.deepEqual(output, [
		{ type: "headers", payload: { httpStatus: 200, providerRequestId: "req-1" } },
		{ type: "block_start", payload: { index: 0, blockType: "text" } },
		{ type: "text_delta", payload: { index: 0, delta: "hello" } },
		{ type: "block_end", payload: { index: 0, value: "hello" } },
		{ type: "usage", payload: { input: 4, output: 2, cacheRead: 1, cacheWrite: 0 } },
		{ type: "terminal", outcome: "succeeded_terminal", payload: { httpStatus: 200, providerRequestId: "req-1", finishReason: "stop" } },
	]);
	await assert.rejects(
		(async () => {
			for await (const _event of pair.providerTransport.stream(snapshot(route, currentLease), {
				messages: [{ role: "user", content: "again" }],
			})) { /* binding must be single-use */ }
		})(),
		/controller provider route binding is unavailable/,
	);
});

test("native transport consumes provider reasoning without widening the text-only controller stream", async () => {
	const currentModel = model("anthropic", "claude-opus-4-8", "anthropic-messages");
	const { registry } = makeRegistry([currentModel], {
		events: [
			{ type: "start", partial: {} },
			{ type: "thinking_start", contentIndex: 0, partial: {} },
			{ type: "thinking_delta", contentIndex: 0, delta: "private streamed reasoning", partial: {} },
			// OpenAI Responses may replace streamed reasoning with its final summary at item.done.
			{ type: "thinking_end", contentIndex: 0, content: "final reasoning summary", partial: {} },
			{ type: "text_start", contentIndex: 1, partial: {} },
			{ type: "text_delta", contentIndex: 1, delta: "answer", partial: {} },
			{ type: "text_end", contentIndex: 1, content: "answer", partial: {} },
			{ type: "done", reason: "stop", message: { content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "answer" }] } },
		],
	});
	const pair = createControllerProvider({ modelRegistry: registry });
	const currentLease = lease("lease-reasoning", currentModel.provider, currentModel.id);
	const route = await pair.routeResolver(currentLease, { reasoningEffort: "high" });
	const output = [];
	for await (const event of pair.providerTransport.stream(snapshot(route, currentLease), {
		messages: [{ role: "user", content: "answer" }],
	})) {
		output.push(event);
	}
	assert.deepEqual(output.map((event) => event.type), ["headers", "block_start", "text_delta", "block_end", "terminal"]);
	const finalEvent = output.at(-1);
	assert.equal(finalEvent?.type, "terminal");
	if (finalEvent?.type === "terminal") assert.equal(finalEvent.outcome, "succeeded_terminal");
});

test("Cursor native routes force SSE instead of a second WebSocket dispatch", async () => {
	const currentModel = model("cursor", "cursor-grok-4.6", "openai-completions");
	const { registry, calls } = makeRegistry([currentModel]);
	const pair = createControllerProvider({ modelRegistry: registry });
	const currentLease = lease("lease-cursor", currentModel.provider, currentModel.id);
	const route = await pair.routeResolver(currentLease);
	for await (const _event of pair.providerTransport.stream(snapshot(route, currentLease), {
		messages: [{ role: "user", content: "say hello" }],
	})) { /* consume the validated stream */ }
	assert.equal(calls[0].request.transport, "sse");
});

test("native transport forwards tool schemas and Codex compound tool-call ids without executable functions", async () => {
	const currentModel = model("openai-codex-account-4", "gpt-5.6-sol", "openai-codex-responses");
	const { registry, calls } = makeRegistry([currentModel], {
		events: [
			{ type: "start", partial: {} },
			{ type: "toolcall_start", contentIndex: 0, partial: {} },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"greeting.txt"}', partial: {} },
			{ type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "call_1|fc_1", name: "write", arguments: { path: "greeting.txt" } }, partial: {} },
			{ type: "done", reason: "toolUse", message: { content: [{ type: "toolCall", id: "call_1|fc_1", name: "write", arguments: { path: "greeting.txt" } }], usage: { input: 4, output: 3 } } },
		],
	});
	const pair = createControllerProvider({ modelRegistry: registry });
	const currentLease = lease("lease-tools", currentModel.provider, currentModel.id);
	const route = await pair.routeResolver(currentLease);
	const output = [];
	for await (const event of pair.providerTransport.stream(snapshot(route, currentLease), {
		messages: [
			{ role: "user", content: "use the tool" },
			{ role: "assistant", content: [{ type: "toolCall", id: "call_0", name: "write", arguments: { path: "old.txt" } }] },
			{ role: "toolResult", toolCallId: "call_0", toolName: "write", content: "written", isError: false },
		],
		tools: [{ name: "write", description: "write", inputSchema: {} }],
	})) {
		output.push(event);
	}
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].context.tools, [{ name: "write", description: "write", parameters: {} }]);
	assert.deepEqual(calls[0].context.messages[1], {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_0", name: "write", arguments: { path: "old.txt" } }],
	});
	assert.deepEqual(calls[0].context.messages[2], {
		role: "toolResult",
		content: [{ type: "text", text: "written" }],
		toolCallId: "call_0",
		toolName: "write",
		isError: false,
	});
	assert.deepEqual(output, [
		{ type: "headers", payload: { httpStatus: 200, providerRequestId: "req-1" } },
		{ type: "block_start", payload: { index: 0, blockType: "tool_call", id: "call_1|fc_1", name: "write" } },
		{ type: "tool_call_delta", payload: { index: 0, delta: '{"path":"greeting.txt"}' } },
		{ type: "block_end", payload: { index: 0, value: '{"path":"greeting.txt"}' } },
		{ type: "usage", payload: { input: 4, output: 3, cacheRead: 0, cacheWrite: 0 } },
		{ type: "terminal", outcome: "succeeded_terminal", payload: { httpStatus: 200, providerRequestId: "req-1", finishReason: "tool_use" } },
	]);
});

test("Cursor Grok forwards its LF-joined compound tool-call id", async () => {
	const currentModel = model("cursor", "cursor-grok-4.6", "openai-completions");
	const toolCallId = "call-12345678-1234-1234-1234-123456789abc-1\nfc_12345678-1234-1234-1234-123456789abc_0";
	const { registry } = makeRegistry([currentModel], {
		events: [
			{ type: "start", partial: {} },
			{ type: "toolcall_start", contentIndex: 0, partial: {} },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"README.md"}', partial: {} },
			{ type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: toolCallId, name: "read", arguments: { path: "README.md" } }, partial: {} },
			{ type: "done", reason: "toolUse", message: { content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "README.md" } }], usage: { input: 8, output: 4 } } },
		],
	});
	const pair = createControllerProvider({ modelRegistry: registry });
	const currentLease = lease("lease-cursor-grok-tool", currentModel.provider, currentModel.id);
	const route = await pair.routeResolver(currentLease);
	const output = [];
	for await (const event of pair.providerTransport.stream(snapshot(route, currentLease), {
		messages: [{ role: "user", content: "read README.md" }],
		tools: [{ name: "read", description: "read", inputSchema: {} }],
	})) output.push(event);
	assert.deepEqual(output.slice(1, 4), [
		{ type: "block_start", payload: { index: 0, blockType: "tool_call", id: toolCallId, name: "read" } },
		{ type: "tool_call_delta", payload: { index: 0, delta: '{"path":"README.md"}' } },
		{ type: "block_end", payload: { index: 0, value: '{"path":"README.md"}' } },
	]);
	const finalEvent = output.at(-1);
	assert.equal(finalEvent?.type, "terminal");
	if (finalEvent?.type === "terminal") assert.equal(finalEvent.outcome, "succeeded_terminal");
});

test("routeResolver fails closed when Pi cannot resolve an exact model credential", async () => {
	const currentModel = model("anthropic", "claude-opus-4-8", "anthropic-messages");
	const { registry } = makeRegistry([currentModel]);
	registry.getApiKeyAndHeaders = async () => ({ ok: false, error: "No API key found" });
	const pair = createControllerProvider({ modelRegistry: registry });
	await assert.rejects(
		pair.routeResolver(lease("lease-no-auth", currentModel.provider, currentModel.id)),
		/controller provider credential is unavailable/,
	);
});
