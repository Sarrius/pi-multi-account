/**
 * Opt-in provider-only bridge for restricted maintenance children on native Pi1.x.
 * Load via Hermes childExtensionPaths, not as a replacement for the parent extension.
 * No auth-file/sidecar access, login, account selection, discovery or recovery hooks.
 */
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isPublishedPlaceholder, isPlaceholderFor } from "./slot-proxy.ts";

/** Match only an explicit native CLI model selection, never saved defaults or env. */
export function selectedChildCodexAlias(argv: readonly string[]): string | undefined {
	let selected: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") break;
		if (arg === "--model" && argv[i + 1]) selected = argv[++i];
		else if (arg.startsWith("--model=")) selected = arg.slice("--model=".length);
	}
	const match = selected?.match(/^(openai-codex-account-[1-9]\d*)\/(.+)$/);
	return match?.[1];
}

function ownLoopbackRoute(baseUrl: string, id: string): boolean {
	try {
		const u = new URL(baseUrl);
		return (u.protocol === "http:" || u.protocol === "https:") &&
			["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) &&
			u.pathname.replace(/\/$/, "") === `/${id}` &&
			!u.username && !u.password && !u.search && !u.hash;
	} catch { return false; }
}

export function childCodexProvider(native: Provider, id: string, assertEffectiveConfiguration: () => void): Provider {
	if (native.id !== "openai-codex" || !native.auth.oauth || !/^openai-codex-account-[1-9]\d*$/.test(id)) {
		throw new Error("This child adapter needs the running host's native Codex OAuth provider and one explicit numbered alias");
	}
	const models = native.getModels().map(model => ({ ...model, provider: id }));
	const oauth = native.auth.oauth;
	function nativeEffortModel<T extends Model<Api>>(model: T): T {
		// Composed/native maps are sparse overrides, not closed allowlists.
		// Catalog allowlists must be completed where their provenance is known.
		const map = model.thinkingLevelMap ?? models.find(m => m.id === model.id)?.thinkingLevelMap;
		return map ? { ...model, thinkingLevelMap: { ...map } } : model;
	}
	function requireRoute(model: Model<Api>, options: any) {
		if (model.provider !== id || model.api !== "openai-codex-responses") {
			throw new Error("Restricted Codex child cannot dispatch another provider or API");
		}
		if (isPublishedPlaceholder(options?.apiKey) &&
			(!isPlaceholderFor("codex", options.apiKey) || !ownLoopbackRoute(model.baseUrl, id))) {
			throw new Error("A Codex child placeholder requires its exact parent-owned loopback route");
		}
	}
	return {
		...native, id, name: `Codex child (${id})`, getModels: () => models,
		...("getAllModels" in native ? { getAllModels: () => models } : {}),
		// No background catalog requests or non-chat operations in this helper.
		...{ refreshModels: undefined, generateImages: undefined, classify: undefined,
			fetchDeferred: undefined, cancelDeferred: undefined },
		auth: {
			oauth: {
				...oauth,
				async login() { throw new Error("Log in through the parent session; this restricted child never starts login"); },
				async refresh(credential, signal) {
					assertEffectiveConfiguration();
					const next = await oauth.refresh(credential, signal);
					assertEffectiveConfiguration(); return next;
				},
				async toAuth(credential) {
					assertEffectiveConfiguration();
					const auth = await oauth.toAuth(credential);
					assertEffectiveConfiguration(); return auth;
				},
			},
			apiKey: {
				name: "Parent-owned Codex child placeholder (not a paid API key)",
				async check(input) {
					input.signal.throwIfAborted();
					return isPlaceholderFor("codex", input.credential?.key) ? { type: "api_key", source: "parent-owned loopback" } : undefined;
				},
				async resolve(input) {
					input.signal.throwIfAborted();
					assertEffectiveConfiguration();
					return isPlaceholderFor("codex", input.credential?.key)
						? { auth: { apiKey: input.credential!.key }, source: "parent-owned loopback" } : undefined;
				},
			},
		},
		stream(model, context, options) { requireRoute(model, options); return native.stream(nativeEffortModel(model), context, options); },
		streamSimple(model, context, options) {
			requireRoute(model, options);
			const effective = nativeEffortModel(model);
			const minimum = effective.reasoning ? clampThinkingLevel(effective, "off") : "off";
			const request = options?.reasoning || minimum === "off" ? options : { ...options, reasoning: minimum };
			return native.streamSimple(effective, context, request);
		},
	};
}

export default function restrictedChildProvider(pi: ExtensionAPI): void {
	const id = selectedChildCodexAlias(process.argv.slice(2));
	if (!id) return;
	const native = builtinProviders().find(provider => provider.id === "openai-codex");
	if (!native) throw new Error("The running host has no native Codex OAuth provider");
	let registry: { getAll(): Model<Api>[] } | undefined;
	const assertConfiguration = () => {
		if (!registry) throw new Error("Restricted child provider is not bound to an active native session");
		const models = registry.getAll().filter(model => model.provider === id);
		// Composition can select a generic API and bypass native stream wrappers.
		// Validate at auth resolution too, before exposing either token shape.
		if (!models.length || models.some(model => model.api !== "openai-codex-responses" ||
			(model.baseUrl !== "https://chatgpt.com/backend-api" && !ownLoopbackRoute(model.baseUrl, id)))) {
			throw new Error("Restricted child requires its native Codex API/upstream or exact parent-owned loopback route");
		}
	};
	pi.registerProvider(childCodexProvider(native, id, assertConfiguration));
	pi.on("session_start", (_event, ctx) => { registry = ctx.modelRegistry; });
	pi.on("session_shutdown", () => { registry = undefined; });
}
