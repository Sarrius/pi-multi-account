/** Native Sign in with ChatGPT aliases, deliberately separate from legacy Codex. */
import { PROXY_PLACEHOLDER_KEY, shapeOpenAIChatGPTPayload } from "./slot-proxy.ts";
import { admitProviderPayload } from "./provider-payload-stream.ts";

export const OPENAI_CHATGPT_BASE = "openai";
export const OPENAI_CHATGPT_API = "openai-responses";
export const OPENAI_CHATGPT_URL = "https://api.openai.com/v1";
export const OPENAI_DIRECT_SCOPE = "chatgpt.tokens.use.direct";

/** Host capability, not version inference or a private SDK flow. */
export function supportsOpenAIChatGPT(provider: any): boolean {
	return provider?.id === OPENAI_CHATGPT_BASE &&
		provider?.auth?.oauth?.isSubscription === true &&
		["login", "refresh", "toAuth"].every(method => typeof provider.auth.oauth[method] === "function") &&
		typeof provider.getModels === "function" && typeof provider.stream === "function" && typeof provider.streamSimple === "function" &&
		provider.getModels().some((model: any) => model.api === OPENAI_CHATGPT_API);
}

/** Native grant metadata cannot be invented from a legacy token or paid key. */
export function isOpenAIChatGPTCredential(credential: any): boolean {
	return credential?.type === "oauth" && typeof credential.access === "string" && credential.access.length > 0 &&
		typeof credential.refresh === "string" && credential.refresh.length > 0 &&
		typeof credential.clientId === "string" && credential.clientId.trim().length > 0 &&
		Array.isArray(credential.scopes) && credential.scopes.includes(OPENAI_DIRECT_SCOPE);
}

/** Guard the host's effective composition before it can derive a direct bearer. */
export function assertOpenAIChatGPTConfiguration(
	config: any, id: string, baseUrl: string, effectiveModels: readonly any[] = [],
): void {
	const valid = (model: any) => (!model.type || model.type === "chat") &&
		(!model.api || model.api === OPENAI_CHATGPT_API) && (!model.baseUrl || model.baseUrl === baseUrl);
	if ((config && (!valid(config) || config.oauth ||
		(config.apiKey !== undefined && config.apiKey !== PROXY_PLACEHOLDER_KEY))) ||
		(config?.models ?? []).some((model: any) => !valid({ ...model,
			api: model.api ?? config.api, baseUrl: model.baseUrl ?? config.baseUrl })) ||
		effectiveModels.some(model => model.provider === id && !valid(model))) {
		throw new Error("OpenAI ChatGPT configuration requires this alias's exact native Responses route; use base openai for custom/metered APIs");
	}
}

/**
 * Clone the PUBLIC native Provider rather than adapting login to legacy callbacks.
 * That path would drop LoginOptions/getDeviceId and per-prompt cancellation.
 * Base OpenAI keeps its dual API-key/OAuth semantics; numbered aliases are OAuth
 * only, with one local-placeholder resolver for the child-publication protocol.
 */
export function cloneOpenAIChatGPTProvider(
	native: any,
	id: string,
	baseUrl: string,
	acceptLogin: (credential: any) => any,
	modelsOverride?: readonly any[],
	assertEffectiveConfiguration?: () => void,
): any {
	if (!supportsOpenAIChatGPT(native) || !/^openai-account-\d+$/.test(id)) {
		throw new Error("The running Pi host does not expose native OpenAI ChatGPT OAuth for this alias");
	}
	const local = new URL(baseUrl);
	const permitsPlaceholder = local.protocol === "http:" && local.hostname === "127.0.0.1" &&
		local.pathname === `/${id}/v1` && !local.username && !local.password && !local.search && !local.hash;
	if (!permitsPlaceholder && baseUrl !== OPENAI_CHATGPT_URL) {
		throw new Error("OpenAI ChatGPT aliases require the native Responses URL or their exact parent-owned loopback route");
	}
	const placeholder = (input: any) => permitsPlaceholder && input.credential?.type === "api_key" &&
		input.credential.key === PROXY_PLACEHOLDER_KEY;
	const models = (modelsOverride ?? native.getModels()).filter((model: any) =>
		(!model.type || model.type === "chat") && model.api === OPENAI_CHATGPT_API,
	).map((model: any) => ({ ...model, provider: id, baseUrl }));
	const oauth = native.auth.oauth;
	function subscriptionOptions(options: any) {
		return { ...options, async onPayload(payload: unknown, model: any) {
			const proposed = await options?.onPayload?.(payload, model);
			const final = shapeOpenAIChatGPTPayload(proposed === undefined ? payload : proposed);
			await admitProviderPayload(final, model, options);
			return final;
		} };
	}
	function requireRoute(model: any) {
		// models.json is composed after registration. It must not turn a grant
		// into a foreign destination or a different provider/API at dispatch.
		if (model.provider !== id || model.api !== OPENAI_CHATGPT_API || model.baseUrl !== baseUrl) {
			throw new Error("OpenAI ChatGPT alias dispatch requires its exact native Responses route");
		}
	}
	return {
		...native,
		id,
		name: `OpenAI (ChatGPT subscription · ${id})`,
		baseUrl,
		getModels: () => models,
		// Classifiers, image-generation and virtual models are not subscription chat routes.
		getAllModels: () => models,
		generateImages: undefined,
		classify: undefined,
		...(typeof native.fetchDeferred === "function" ? { fetchDeferred(model: any, handle: any, options: any) {
			requireRoute(model);
			return native.fetchDeferred(model, handle, options);
		} } : {}),
		...(typeof native.cancelDeferred === "function" ? { cancelDeferred(model: any, handle: any, options: any) {
			requireRoute(model);
			return native.cancelDeferred(model, handle, options);
		} } : {}),
		stream(model: any, context: any, options: any) {
			requireRoute(model);
			return native.stream(model, context, subscriptionOptions(options));
		},
		streamSimple(model: any, context: any, options: any) {
			requireRoute(model);
			return native.streamSimple(model, context, subscriptionOptions(options));
		},
		auth: {
			apiKey: {
				name: "Local child route (not a billed API key)",
				// Also prevents the host composer from synthesizing a paid-key prompt.
				async login() {
					throw new Error("This alias is ChatGPT subscription-only. Sign in with an account; metered API keys belong to base openai.");
				},
				async check(input: any) {
					input.signal?.throwIfAborted();
					return placeholder(input) ? { type: "api_key", source: "parent-owned subscription route" } : undefined;
				},
				async resolve(input: any) {
					input.signal?.throwIfAborted();
					return placeholder(input) ? { auth: { apiKey: PROXY_PLACEHOLDER_KEY, baseUrl }, source: "parent-owned subscription route" } : undefined;
				},
			},
			oauth: {
				...oauth,
				name: `OpenAI (ChatGPT subscription · ${id})`,
				async login(interaction: any, options: any) {
					const credential = await oauth.login(interaction, options);
					interaction.signal?.throwIfAborted();
					if (!isOpenAIChatGPTCredential(credential)) throw new Error("Native OpenAI login did not return a direct-token ChatGPT grant");
					return acceptLogin(credential);
				},
				async refresh(credential: any, signal: AbortSignal) {
					if (!isOpenAIChatGPTCredential(credential)) throw new Error("Reconnect this OpenAI ChatGPT account; issued client/scopes are missing");
					return oauth.refresh(credential, signal);
				},
				async toAuth(credential: any) {
					if (!isOpenAIChatGPTCredential(credential)) throw new Error("Reconnect this OpenAI ChatGPT account; issued client/scopes are missing");
					assertEffectiveConfiguration?.();
					const auth = await oauth.toAuth(credential);
					assertEffectiveConfiguration?.();
					// The host composer can choose a generic transport for a custom API,
					// bypassing stream guards. Bind the destination at auth resolution too.
					return { ...auth, baseUrl };
				},
			},
		},
	};
}
