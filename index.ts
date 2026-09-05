/**
 * pi-multi-account — automatic multi-account failover & rotation for Pi.
 *
 * What it does
 * ------------
 * - Auto-discovers every authenticated account from ~/.pi/agent/auth.json
 *   (Anthropic Claude Pro/Max, OpenAI/ChatGPT Codex, and Qwen/Alibaba) and
 *   builds the failover rotation dynamically — no manual config editing.
 * - Pre-registers a pool of login slots so `/login` can offer numbered account
 *   targets such as `anthropic-account-3` and `openai-codex-account-5`.
 * - Drops an account from the rotation the moment its token is expired or its
 *   authorization is revoked, and restores it automatically once you re-login.
 * - On a quota/rate-limit (429/402/403) it marks the account on cooldown and
 *   transparently switches to the next available account/model, optionally
 *   queuing a safe continuation prompt.
 *
 * Anthropic OAuth (Claude Pro/Max) works out of the box: this package enables
 * OAuth login on the base `anthropic` provider and on every `anthropic-account-*`
 * alias, and shapes the outgoing requests itself (billing header + system-prompt
 * normalization, vendored from gotgenes/pi-anthropic-auth, MIT). No separate
 * pi-anthropic-auth install is needed; if you have one, both coexist (idempotent).
 *
 * Config:  ~/.pi/agent/provider-failover.json
 * State:   ~/.pi/agent/provider-failover-state.json
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
	accessSync,
	appendFileSync,
	constants as fsConstants,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { Readable } from "node:stream";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_BASE,
	CURSOR_PROXY_PLACEHOLDER_KEY,
	cleanupCursorControllerSession,
	isCursorProviderId,
	isCursorProviderInstalled,
	refreshCursorCredentials,
	setupCursorSubscription,
} from "./cursor-bridge.ts";
import { droppedPreviousSummary, restorePreviousSummary } from "./compaction-summary.ts";
import {
	admitRequest,
	dropOwnLoopbackPublications,
	parseProxyPath,
	placeholderKeyFor,
	preservedModelOverrides,
	proxyFamilyFor,
	publishedRouteFor,
	shapeUpstreamRequest,
	type ProxyFamily,
	type ProxyRoute,
} from "./slot-proxy.ts";
import {
	applyRestoreAll,
	applyShadowAll,
	mergeParentAuth,
	needsAuthShadow,
	type AuthBlob,
} from "./slot-proxy-auth.ts";
import {
	classifyChildUsability,
	defaultRouteWarning,
	type ChildUsability,
} from "./child-usability.ts";
import {
	checkAuthShape,
	checkModelsShape,
	checkSettingsTracksActive,
	describeContractDrift,
	observedAssumptions,
	type ShapeVerdict,
} from "./pi-contract.ts";
import {
	DEFAULT_PROVIDER_PRIORITY,
	comparePriority,
	describePriority,
	normalizeGroup,
	normalizePriority,
} from "./provider-priority.ts";
import {
	DEFAULT_CONTEXT_GUARD_SETTINGS,
	createOverheadTracker,
	decideGuard,
	estimateRawTokens,
	planElision,
	type ContextGuardSettings,
	type GuardMessage,
	type OverheadTracker,
} from "./context-guard.ts";
import { createControllerProvider } from "./controller-provider.ts";

// ---------------------------------------------------------------------------
// pi-ai OAuth bridge (version-agnostic)
// ---------------------------------------------------------------------------
//
// This is the single most fragile boundary in the extension, and it has now broken
// twice in the field:
//
//   * pi-coding-agent's extension loader aliases `@earendil-works/pi-ai/oauth` to an
//     empty stub in its own node_modules, so a plain static import yields undefined —
//     the `undefined is not an object (evaluating
//     '_oauth.openaiCodexOAuthProvider.usesCallbackServer')` crash at startup.
//   * pi-ai 0.80 REMOVED the runtime OAuth surface: `dist/oauth.js` is now literally
//     `export {}` (types only), `getModel` moved to `dist/compat.js`, and the OAuth
//     implementations live behind provider factories
//     (`anthropicProvider().auth.oauth`) with a new `login(interaction)` /
//     `refresh(credential)` shape.
//
// So we resolve pi-ai on disk ourselves and normalize BOTH eras behind one internal
// surface. Everything here is best-effort: a pi-ai we cannot adapt degrades to
// "subscription logins unavailable" and the extension still loads, so API-key
// accounts keep rotating instead of the whole extension dying at load time.
//
// The 0.80+ adaptation follows the approach contributed by @lfoscari in PR #4.

/** Normalized OAuth surface — identical for every supported pi-ai version. */
type PiAiOauthBridge = {
	/** pi-ai release line this was adapted from, for the debug log. */
	era: "legacy-oauth-entry" | "provider-factories";
	anthropic: {
		login: (callbacks: any) => Promise<any>;
		refresh: (credentials: any, signal: AbortSignal) => Promise<any>;
	};
	codex: {
		usesCallbackServer: boolean;
		login: (callbacks: any) => Promise<any>;
		refresh: (credentials: any, signal: AbortSignal) => Promise<any>;
		getApiKey: (credentials: any) => string;
	};
	/**
	 * Optional: Kimi exists only in pi-ai's provider-factories era, never in the
	 * legacy oauth.js entry. Absence must not disqualify an otherwise usable bridge.
	 */
	kimi?: {
		login: (callbacks: any) => Promise<any>;
		refresh: (credentials: any, signal: AbortSignal) => Promise<any>;
		getApiKey: (credentials: any) => string;
	};
};

let piAiOauthBridge: PiAiOauthBridge | undefined;
let piAiOauthLoadError: string | undefined;
let piAiPackageRoot: string | undefined | null; // null = searched, not found

/**
 * Locate the `@earendil-works/pi-ai` package directory, nearest-first.
 *
 * A git checkout keeps pi-ai in the extension's OWN node_modules, but `npm i` /
 * `pi install` HOIST it next to the package instead
 * (`~/.pi/agent/npm/node_modules/pi-multi-account` +
 * `~/.pi/agent/npm/node_modules/@earendil-works/pi-ai`), and pnpm hides it behind a
 * symlinked store. Probing only the nested path made the extension fail to load on
 * every hoisted install, so walk ancestors the way Node's own resolver does and fall
 * back to require.resolve().
 */
export function piAiRootCandidates(
	fromFile: string,
	resolver?: (specifier: string) => string,
): string[] {
	const candidates: string[] = [];
	let dir = dirname(fromFile);
	for (let depth = 0; depth < 16; depth++) {
		candidates.push(join(dir, "node_modules", "@earendil-works", "pi-ai"));
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	if (resolver) {
		try {
			// Resolves through "exports"/symlinks even when no ancestor path matched.
			candidates.push(dirname(resolver("@earendil-works/pi-ai/package.json")));
		} catch {
			// Not resolvable from here — the ancestor paths above may still hit.
		}
	}
	return [...new Set(candidates)];
}

function findPiAiRoot(): string | undefined {
	if (piAiPackageRoot !== undefined) return piAiPackageRoot ?? undefined;
	const here = fileURLToPath(import.meta.url);
	const localRequire = createRequire(import.meta.url);
	for (const candidate of piAiRootCandidates(here, (specifier) =>
		localRequire.resolve(specifier),
	)) {
		if (existsSync(join(candidate, "package.json"))) {
			piAiPackageRoot = candidate;
			return candidate;
		}
	}
	piAiPackageRoot = null;
	return undefined;
}

/**
 * Bridge Pi's legacy extension OAuth callbacks (`onAuth`/`onDeviceCode`/`onPrompt`/
 * `onSelect`) to pi-ai 0.80+'s `AuthInteraction` (`notify(event)`/`prompt(prompt)`).
 * Pi still hands us the legacy callbacks, so without this the browser login throws
 * `interaction.notify is not a function`.
 */
function toAuthInteraction(callbacks: any) {
	return {
		signal: callbacks?.signal,
		notify(event: any) {
			if (!event || typeof event !== "object") {
				callbacks?.onProgress?.(String(event ?? ""));
				return;
			}
			if (event.type === "auth_url") {
				callbacks?.onAuth?.({ url: event.url, instructions: event.instructions });
				return;
			}
			if (event.type === "device_code") {
				callbacks?.onDeviceCode?.({
					userCode: event.userCode,
					verificationUri: event.verificationUri,
					intervalSeconds: event.intervalSeconds,
					expiresInSeconds: event.expiresInSeconds,
				});
				return;
			}
			// "info" and "progress" both carry a human-readable message.
			callbacks?.onProgress?.(
				typeof event.message === "string" ? event.message : JSON.stringify(event),
			);
		},
		prompt(prompt: any) {
			if (prompt?.type === "select") return callbacks.onSelect(prompt);
			if (prompt?.type === "manual_code" && callbacks?.onManualCodeInput) {
				return callbacks.onManualCodeInput();
			}
			return callbacks.onPrompt({
				message: prompt?.message ?? "",
				placeholder: prompt?.placeholder,
				allowEmpty: prompt?.allowEmpty,
			});
		},
	};
}

/** pi-ai <= 0.79: runtime OAuth helpers exported straight from `dist/oauth.js`. */
function adaptLegacyOauthEntry(mod: any): PiAiOauthBridge | undefined {
	const codex = mod?.openaiCodexOAuthProvider;
	if (
		typeof mod?.loginAnthropic !== "function" ||
		typeof mod?.refreshAnthropicToken !== "function" ||
		typeof codex?.login !== "function" ||
		typeof codex?.refreshToken !== "function"
	) {
		return undefined;
	}
	return {
		era: "legacy-oauth-entry",
		anthropic: {
			login: (callbacks) => mod.loginAnthropic(callbacks),
			// This era exchanges the bare refresh token, not the whole credential.
			refresh: (credentials, signal) =>
				mod.refreshAnthropicToken(credentials.refresh, signal),
		},
		codex: {
			usesCallbackServer: codex.usesCallbackServer ?? true,
			login: (callbacks) => codex.login(callbacks),
			refresh: (credentials, signal) => codex.refreshToken(credentials, signal),
			getApiKey: (credentials) =>
				typeof codex.getApiKey === "function"
					? codex.getApiKey(credentials)
					: credentials.access,
		},
	};
}

/** pi-ai >= 0.80: OAuth lives behind provider factories, with an AuthInteraction API. */
function adaptProviderFactories(
	anthropicMod: any,
	codexMod: any,
	kimiMod?: any,
): PiAiOauthBridge | undefined {
	const anthropicOauth = anthropicMod?.anthropicProvider?.()?.auth?.oauth;
	const codexOauth = codexMod?.openaiCodexProvider?.()?.auth?.oauth;
	const kimiOauth = kimiMod?.kimiCodingProvider?.()?.auth?.oauth;
	if (
		typeof anthropicOauth?.login !== "function" ||
		typeof anthropicOauth?.refresh !== "function" ||
		typeof codexOauth?.login !== "function" ||
		typeof codexOauth?.refresh !== "function"
	) {
		return undefined;
	}
	return {
		era: "provider-factories",
		anthropic: {
			login: (callbacks) => anthropicOauth.login(toAuthInteraction(callbacks)),
			refresh: (credentials, signal) => anthropicOauth.refresh(credentials, signal),
		},
		codex: {
			// The flag is gone from the new shape; both eras of pi-ai's Codex flow use a
			// local callback server, and Pi only reads this to decide how to present login.
			usesCallbackServer: true,
			login: (callbacks) => codexOauth.login(toAuthInteraction(callbacks)),
			refresh: (credentials, signal) => codexOauth.refresh(credentials, signal),
			// Identical to what pi-ai <= 0.79's getApiKey did (verified in its source).
			getApiKey: (credentials) => credentials.access,
		},
		kimi:
			typeof kimiOauth?.login === "function" &&
			typeof kimiOauth?.refresh === "function"
				? {
						login: (callbacks) => kimiOauth.login(toAuthInteraction(callbacks)),
						refresh: (credentials, signal) => kimiOauth.refresh(credentials, signal),
						getApiKey: (credentials) => credentials.access,
					}
				: undefined,
	};
}

/**
 * Best-effort load + normalization of pi-ai's OAuth surface. NEVER throws.
 *
 * Uses a synchronous require() (Node >= 22 supports require() of ESM without
 * top-level await, and pi-ai qualifies) because providers are registered
 * synchronously — `usesCallbackServer` is read while Pi merely LISTS providers.
 */
function tryLoadPiAiOauth(): PiAiOauthBridge | undefined {
	if (piAiOauthBridge) return piAiOauthBridge;
	const root = findPiAiRoot();
	if (!root) {
		piAiOauthLoadError = `@earendil-works/pi-ai was not found near ${fileURLToPath(import.meta.url)}. Install @earendil-works/pi-ai alongside pi-multi-account.`;
		return undefined;
	}
	const localRequire = createRequire(import.meta.url);
	const load = (relative: string): any => {
		const file = join(root, "dist", relative);
		if (!existsSync(file)) return undefined;
		try {
			return localRequire(file);
		} catch (error) {
			tried.push(
				`${relative}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		}
	};
	const tried: string[] = [];

	const legacy = adaptLegacyOauthEntry(load("oauth.js"));
	if (legacy) {
		piAiOauthBridge = legacy;
		piAiOauthLoadError = undefined;
		return legacy;
	}
	tried.push("dist/oauth.js exports no runtime OAuth helpers (pi-ai >= 0.80)");

	const modern = adaptProviderFactories(
		load(join("providers", "anthropic.js")),
		load(join("providers", "openai-codex.js")),
		load(join("providers", "kimi-coding.js")),
	);
	if (modern) {
		piAiOauthBridge = modern;
		piAiOauthLoadError = undefined;
		return modern;
	}
	tried.push("dist/providers/{anthropic,openai-codex}.js exposed no auth.oauth");

	piAiOauthLoadError = `the @earendil-works/pi-ai at ${root} exposes no OAuth surface this extension can use. ${tried.join("; ")}`;
	return undefined;
}

/** Load reason, or undefined when OAuth is available. */
function piAiOauthUnavailableReason(): string | undefined {
	tryLoadPiAiOauth();
	return piAiOauthBridge ? undefined : piAiOauthLoadError;
}

function requirePiAiOauth(): PiAiOauthBridge {
	const bridge = tryLoadPiAiOauth();
	if (!bridge) {
		throw new Error(
			`pi-multi-account: subscription (OAuth) login is unavailable — ${piAiOauthLoadError}`,
		);
	}
	return bridge;
}

/**
 * pi-ai's static model catalog lookup. It lived on the package root until 0.79 and
 * moved to `dist/compat.js` in 0.80, so resolve it lazily from whichever is present
 * — and treat "absent" as "no canonical metadata", never as a load failure.
 */
let piAiGetModelFn: ((provider: string, id: string) => any) | null | undefined;

function piAiGetModel(provider: string, id: string): any {
	if (piAiGetModelFn === undefined) {
		piAiGetModelFn = null;
		const root = findPiAiRoot();
		if (root) {
			const localRequire = createRequire(import.meta.url);
			for (const relative of ["compat.js", "index.js"]) {
				const file = join(root, "dist", relative);
				if (!existsSync(file)) continue;
				try {
					const candidate = localRequire(file)?.getModel;
					if (typeof candidate === "function") {
						piAiGetModelFn = candidate;
						break;
					}
				} catch {
					// Try the next entry point.
				}
			}
		}
	}
	try {
		return piAiGetModelFn?.(provider, id);
	} catch {
		return undefined;
	}
}
import {
	CodexCatalogFetchError,
	OllamaCatalogFetchError,
	compareCodexModelStrength,
	fetchCodexModelCatalog,
	fetchOllamaCloudCatalog,
	rankAnthropicModelIds,
	type CodexCatalogModel,
	type CodexCatalogSnapshot,
} from "./model-catalog.ts";
import {
	fetchUsageSnapshot,
	formatResetDuration,
	formatUsageCompact,
	formatUsageDetails,
	parseCodexUsageHeaders,
	providerUsageLabel,
	remainingPercent,
	usageColor,
	usageFamily,
	UsageFetchError,
	windowLabel,
	type UsageSnapshot,
	type UsageWindow,
} from "./usage.ts";

type ModelRef = `${string}/${string}`;
type ProviderFamily =
	| "anthropic"
	| "openai-codex"
	| "kimi-coding"
	| "qwen"
	| "ollama"
	| "cursor";
type ReasoningLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";
// Reasoning levels ordered weakest → strongest. Used to tell a host clamp (a drop forced by a
// weaker fallback model) apart from a deliberate change by the user.
const REASONING_LEVELS: ReasoningLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];
// "auto" = follow the session's own level (per-agent `--thinking`, `/thinking`) instead of
// forcing a global one. Any explicit level still forces that level on every turn.
type ReasoningLevelSetting = ReasoningLevel | "auto";

type OpenAICodexAliasConfig = {
	id: string;
	displayName?: string;
	models?: string[];
};
type AnthropicOAuthAliasConfig = {
	id: string;
	displayName?: string;
	models?: string[];
};

type ProviderFailoverConfig = {
	enabled?: boolean;
	autoContinue?: boolean;
	autoDiscover?: boolean;
	autoDiscoverModels?: boolean;
	maxAccountsPerProvider?: number;
	includeQwen?: boolean;
	qwenProvider?: string;
	includeOllama?: boolean;
	/**
	 * Let providers outside the five specially-managed families take part in rotation — any
	 * account with a usable key that Pi already knows how to call. Off is for someone paying per
	 * token who does not want background failover spending a plain API key.
	 */
	includeOtherProviders?: boolean;
	includeCursor?: boolean;
	/**
	 * Serve OAuth rotation slots to extension-free children through a parent-owned loopback
	 * route. Off means such a child cannot use those accounts at all and silently reroutes to
	 * whichever provider Pi finds first.
	 */
	childProxy?: boolean;
	/**
	 * When true, `/model` shows only the currently active rotation account: every other
	 * provider is re-registered with an empty model list (its auth and OAuth config are
	 * preserved by Pi's merge) and restored on switch or when the flag goes off.
	 */
	onlyActive?: boolean;
	/**
	 * Provider ids this extension must never fail away from, even on an actionable error.
	 *
	 * For providers we do not manage (no cooldown/refresh lifecycle of ours) that run their own
	 * retry logic — typically a companion extension that owns retries for that provider. Failing
	 * over would fight it: we would switch accounts while the other extension is mid-retry.
	 * Only meaningful for unmanaged providers; a managed account still cools and rotates normally.
	 */
	neverFailoverProviders?: string[];
	providerOrder?: ProviderFamily[];
	// Where work goes once EVERY account of the current family is spent. An ordered list of
	// provider groups — a managed family, or the base id of anything else you are logged in to
	// (`openrouter`, `zai`, `minimax`…), which `providerOrder` could never name. Same-family
	// failover always runs first and is not affected; an account on a real cooldown is still never
	// chosen over a free one. Only the order among candidates that are all selectable right now
	// changes. Anything unlisted sorts after everything listed. Set with
	// `/multi-account priority ...`.
	providerPriority?: string[];
	cooldownMs?: number;
	probeCooldownMs?: number;
	invalidCooldownMs?: number;
	transientCooldownMs?: number;
	showUsage?: boolean;
	usageRefreshMs?: number;
	usageStatusRefreshMs?: number;
	pendingPollMs?: number;
	maxAutoContinuesPerPrompt?: number;
	fallbacks?: string[];
	openaiCodexAliases?: OpenAICodexAliasConfig[];
	anthropicOAuthAliases?: AnthropicOAuthAliasConfig[];
	limitErrorPatterns?: string[];
	authErrorPatterns?: string[];
	transientErrorPatterns?: string[];
	modelErrorPatterns?: string[];
	ignoreErrorPatterns?: string[];
	continuationPrompt?: string;
	// Hard ceiling on how long ANY prediction may stop us from simply trying an account again.
	// Providers reset quota windows early and without notice, and they resize the windows
	// themselves — so a reset timestamp, a "try again in N min" sentence and a used-percentage are
	// all forecasts, not facts. The only fact is what the account answers when asked. Default: 10
	// minutes. Set higher to probe less often, never to "trust" a provider's own estimate.
	maxRecheckIntervalMs?: number;
	// Rewrite the interrupted turn into a verbatim `user` handoff record so the account
	// taking over still sees exactly where the previous one stopped. Without this, pi-ai
	// drops the interrupted assistant message entirely before the next request is built,
	// so the continuation lands on an account that cannot see the work it is told not to
	// repeat. Default: true.
	// Keep a request inside the model's context window WHILE the agent is working. Pi only checks
	// whether to compact after a whole agent run has ended and before a new user prompt, so a long
	// autonomous run is never measured: one 78-minute run grew from 85 663 to 542 529 tokens
	// against a 272 000 window with no check at all. `true`/absent uses the
	// defaults; an object overrides individual thresholds; `false` disables the guard entirely.
	contextGuard?: boolean | Partial<ContextGuardSettings>;
	// After an AUTOMATIC compaction, carry the task on instead of stopping and waiting for the
	// user to type "продовжуй". Pi already has the machinery: `_runAutoCompaction` ends with
	// `return this.agent.hasQueuedMessages()`, and the run loop turns a `true` there into
	// `agent.continue()`. Pi uses that on the overflow path but queues nothing on the threshold
	// path, so a threshold compaction otherwise ends the run. This is enabled by default for
	// run-to-completion; another extension (for example pi-goal) may own continuation, in which
	// case set this explicitly to false to avoid competing follow-ups.
	continueAfterCompaction?: boolean;
	preserveInterruptedContext?: boolean;
	// When the active account is rate-limited/cooling/invalid and Pi needs to compact
	// (context overflow or threshold), run the summary on a HEALTHY fallback account
	// instead of letting the default summary die on the dead account. If every live
	// attempt fails, CANCEL — never fall through to Pi's unbounded default on the spent
	// account (that is the infinite "Compacting context…" spinner). Default: true.
	routeCompactionToHealthyAccount?: boolean;
	// Upper bound for one routed compaction attempt. 0/absent ⇒ built-in default.
	compactionWatchdogMs?: number;
	// When a resumed turn wedges (silent past stuckWatchdogMs with no tool running), auto-cancel
	// it and auto-resume when an account frees, instead of only notifying. Default: true.
	autoRecoverStuck?: boolean;
	// Write a structured "black box" decision log to provider-failover-debug.log. Default: true.
	// Contains no credentials — only provider/model ids, decisions, and truncated reasons.
	debugLog?: boolean;
	// Always upgrade to the newest available model on failover instead of carrying a
	// previously-downgraded model forward forever. Default: true.
	preferLatestModel?: boolean;
	// Reasoning effort to preserve across model/account switches. Default: "auto" — the level
	// the session actually runs at (per-agent `--thinking`, `/thinking`, your Pi default) is
	// honoured and only restored after a switch, never overridden. Set an explicit level to
	// FORCE it on every turn regardless of the session. Extreme levels such as xhigh are
	// opt-in only.
	reasoningLevel?: ReasoningLevelSetting;
	// Per-family override of the preferred model order (newest first). Lets you pin the
	// latest model for each provider WITHOUT a code change when a new one ships, e.g.
	// { "openai-codex": ["gpt-5.6", "gpt-5.5"], "anthropic": ["claude-opus-4-9"] }.
	// Keys: anthropic | openai-codex | cursor | qwen | ollama.
	preferredModels?: Record<string, string[]>;
	// Forward-progress watchdog tunables (see constants above). 0/absent ⇒ built-in default.
	resumeIdleTimeoutMs?: number;
	stuckWatchdogMs?: number;
};

type RuntimeConfig = Required<
	Pick<
		ProviderFailoverConfig,
		| "enabled"
		| "autoContinue"
		| "autoDiscover"
		| "autoDiscoverModels"
		| "maxAccountsPerProvider"
		| "includeQwen"
		| "qwenProvider"
		| "includeOllama"
		| "includeOtherProviders"
		| "includeCursor"
		| "childProxy"
		| "onlyActive"
		| "neverFailoverProviders"
		| "providerOrder"
		| "providerPriority"
		| "cooldownMs"
		| "probeCooldownMs"
		| "invalidCooldownMs"
		| "transientCooldownMs"
		| "showUsage"
		| "usageRefreshMs"
		| "usageStatusRefreshMs"
		| "pendingPollMs"
		| "maxAutoContinuesPerPrompt"
		| "fallbacks"
		| "limitErrorPatterns"
		| "authErrorPatterns"
		| "transientErrorPatterns"
		| "modelErrorPatterns"
		| "ignoreErrorPatterns"
		| "continuationPrompt"
		| "maxRecheckIntervalMs"
		| "continueAfterCompaction"
		| "preserveInterruptedContext"
		| "routeCompactionToHealthyAccount"
		| "autoRecoverStuck"
		| "debugLog"
		| "preferLatestModel"
		| "reasoningLevel"
		| "preferredModels"
		| "resumeIdleTimeoutMs"
		| "stuckWatchdogMs"
		| "compactionWatchdogMs"
	>
> & {
	openaiCodexAliases: OpenAICodexAliasConfig[];
	anthropicOAuthAliases: AnthropicOAuthAliasConfig[];
	contextGuard: ContextGuardSettings;
};

type SwitchRecord = {
	from: ModelRef;
	to: ModelRef;
	reason: string;
	at: number;
};

type InvalidationRecord = { tokenHash: string; at: number; reason: string };

type ProviderFailoverState = {
	stateVersion?: number;
	exhaustedUntilByProvider?: Record<string, number>;
	exhaustedUntilByModel?: Record<string, number>;
	lastProbeAtByProvider?: Record<string, number>;
	invalidatedByProvider?: Record<string, InvalidationRecord>;
	// Providers whose usage-% reading has been PROVEN not to reflect the real limit, because the
	// account refused while the meter still claimed headroom. Persisted so a restart cannot go
	// back to believing a meter already caught lying — that amnesia re-opened the retry loop once
	// per session.
	usageUntrustedUntilByProvider?: Record<string, number>;
	usageByProvider?: Record<string, UsageSnapshot>;
	codexModelCatalogByProvider?: Record<string, CodexCatalogSnapshot>;
	pendingContinuationPrompt?: string;
	pendingFrom?: ModelRef;
	pendingSince?: number;
	pendingReason?: string;
	/** Session instance that owns this pending wake; prevents another Pi window's stale timer from clearing it. */
	pendingOwner?: string;
	lastSwitches?: SwitchRecord[];
	/** Last model the user was actually on (failover destination included). Restored after catalogs load. */
	lastUserModel?: { provider: string; id: string };
	/** Thinking level the session ran at (high/max/…). Pi clamps it to the fallback model's caps at restore time, so persist and re-assert after the model is back. */
	lastUserThinkingLevel?: string;
	/** Last chosen model id per family, so /next into that family does not land on the baked-in fallback. */
	lastModelByFamily?: Record<string, string>;
};

const AGENT_DIR =
	process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "provider-failover.json");
const STATE_PATH = join(AGENT_DIR, "provider-failover-state.json");
const AUTH_PATH = join(AGENT_DIR, "auth.json");
const PROXY_OAUTH_PATH = join(AGENT_DIR, "pi-multi-account-proxy-oauth.json");
const MODELS_CONFIG_PATH = join(AGENT_DIR, "models.json");
const SETTINGS_PATH = join(AGENT_DIR, "settings.json");

/**
 * Model ids the user configured for a provider in Pi's own models.json.
 *
 * This is the user's list, not ours. The API-key base registration below exists only because a
 * placeholder apiKey can stop Pi exposing a provider at all — it was never meant to decide which
 * models that provider has, and replacing a configured six-model provider with one built-in tag
 * is a silent downgrade of the user's own configuration.
 */
function configuredModelIds(provider: string): string[] {
	try {
		const parsed = JSON.parse(readFileSync(MODELS_CONFIG_PATH, "utf8"));
		const models = parsed?.providers?.[provider]?.models;
		if (Array.isArray(models)) {
			return models
				.map((model: any) => (typeof model === "string" ? model : model?.id))
				.filter((id: unknown): id is string => typeof id === "string" && id.length > 0);
		}
		if (models && typeof models === "object") return Object.keys(models);
		return [];
	} catch {
		return [];
	}
}

function readHostDefaultModel(): { provider: string; id: string } | undefined {
	try {
		const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
		const provider = parsed?.defaultProvider;
		const id = parsed?.defaultModel;
		if (
			typeof provider === "string" &&
			provider &&
			typeof id === "string" &&
			id
		) {
			return { provider, id };
		}
	} catch {
		/* settings.json is optional */
	}
	return undefined;
}

/**
 * The three files Pi publishes, read the only way this extension is allowed to read them: parse,
 * never write, and treat absence as normal rather than as a fault.
 *
 * `undefined` means "no such file" — a fresh install has no models.json and no custom providers,
 * and reporting that as drift would be pure noise. A file that exists but will not parse is a
 * different thing entirely and is reported, because a corrupt models.json is exactly how every
 * custom provider a user has disappears at once.
 */
function readPublishedJson(path: string): { present: boolean; value?: unknown; unreadable?: string } {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { present: false };
	}
	try {
		return { present: true, value: JSON.parse(text) };
	} catch (error) {
		return {
			present: true,
			unreadable: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Check the published files against the shapes this extension depends on.
 *
 * `active` is supplied only once a model switch has happened in the session: before that,
 * settings.json legitimately still names the previous session's choice, and checking it would
 * report a mismatch that means nothing.
 */
function inspectPiContract(active?: { provider: string; id: string }): ShapeVerdict[] {
	const verdicts: ShapeVerdict[] = [];
	const checks: Array<[string, string, (raw: unknown) => ShapeVerdict]> = [
		["auth.json", AUTH_PATH, checkAuthShape],
		["models.json", MODELS_CONFIG_PATH, checkModelsShape],
	];
	if (active) {
		checks.push([
			"settings.json",
			SETTINGS_PATH,
			(raw) => checkSettingsTracksActive(raw, active),
		]);
	}
	for (const [file, path, check] of checks) {
		const read = readPublishedJson(path);
		if (!read.present) continue;
		if (read.unreadable) {
			verdicts.push({
				file,
				ok: false,
				problems: [`exists but will not parse (${read.unreadable})`],
			});
			continue;
		}
		verdicts.push(check(read.value));
	}
	return verdicts;
}

/**
 * What a rotation slot looks like to something that does NOT load this extension.
 *
 * Read from disk rather than from our own in-memory registry on purpose: the child sees the files,
 * not our objects, so the files are what has to be judged. A provider that is neither one of our
 * numbered slots nor present in models.json is one Pi defines itself, and Pi then owns its auth
 * flow — which is the only case where an OAuth credential works for a child at all.
 */
function slotsAsAChildSeesThem(
	slotIds: readonly string[],
	auth: Record<string, { type?: string }>,
): ChildUsability[] {
	const read = readPublishedJson(MODELS_CONFIG_PATH);
	const published =
		read.present && !read.unreadable && typeof (read.value as any)?.providers === "object"
			? ((read.value as any).providers as Record<string, any>)
			: {};
	return slotIds.map((slotId) => {
		const entry = published[slotId];
		const credentialType = auth[slotId]?.type;
		return classifyChildUsability({
			slotId,
			credential:
				credentialType === "oauth"
					? "oauth"
					: credentialType === "api_key"
						? "api_key"
						: "none",
			builtin: !/-account-\d+$/.test(slotId) && entry === undefined,
			publishedApiKey: typeof entry?.apiKey === "string" ? entry.apiKey : undefined,
			publishedBaseUrl: typeof entry?.baseUrl === "string" ? entry.baseUrl : undefined,
		});
	});
}

type NativeModelEntry = {
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input?: Array<"text" | "image">;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow?: number;
	maxTokens?: number;
	compat?: Record<string, unknown>;
};

type NativeProviderEntry = {
	api: string;
	baseUrl: string;
	models: unknown[];
	compat?: Record<string, unknown>;
	/**
	 * Key written into models.json for this slot. Pi refuses to use a provider it has
	 * no credential for — `credentials_not_configured` — so a slot we publish without
	 * one resolves the model and then cannot call it. Only ever a non-secret
	 * placeholder for a LOCAL proxy that supplies the real token itself; a real
	 * credential must never be copied into models.json.
	 */
	apiKey?: string;
};

/**
 * Pi's models.json schema is `models: ModelDefinition[]` — each entry MUST be an
 * object with `id`. A string id (`"k3"`) fails validation, and Pi then discards
 * the *entire* file (every custom provider, not just the bad slot).
 */
function nativeModelEntry(model: unknown): NativeModelEntry | undefined {
	if (typeof model === "string") {
		return model.length > 0 ? { id: model } : undefined;
	}
	if (!model || typeof model !== "object") return undefined;
	const rec = model as Record<string, unknown>;
	const id = typeof rec.id === "string" ? rec.id : "";
	if (!id) return undefined;
	const entry: NativeModelEntry = { id };
	if (typeof rec.name === "string" && rec.name.length > 0) entry.name = rec.name;
	if (typeof rec.api === "string" && rec.api.length > 0) entry.api = rec.api;
	if (typeof rec.baseUrl === "string" && rec.baseUrl.length > 0) {
		entry.baseUrl = rec.baseUrl;
	}
	if (typeof rec.reasoning === "boolean") entry.reasoning = rec.reasoning;
	if (rec.thinkingLevelMap && typeof rec.thinkingLevelMap === "object") {
		entry.thinkingLevelMap = rec.thinkingLevelMap as NativeModelEntry["thinkingLevelMap"];
	}
	if (Array.isArray(rec.input)) {
		const input = rec.input.filter(
			(value): value is "text" | "image" => value === "text" || value === "image",
		);
		if (input.length) entry.input = input;
	}
	if (rec.cost && typeof rec.cost === "object") {
		const cost = rec.cost as Record<string, unknown>;
		if (
			typeof cost.input === "number" &&
			typeof cost.output === "number" &&
			typeof cost.cacheRead === "number" &&
			typeof cost.cacheWrite === "number"
		) {
			entry.cost = {
				input: cost.input,
				output: cost.output,
				cacheRead: cost.cacheRead,
				cacheWrite: cost.cacheWrite,
			};
		}
	}
	if (typeof rec.contextWindow === "number") entry.contextWindow = rec.contextWindow;
	if (typeof rec.maxTokens === "number") entry.maxTokens = rec.maxTokens;
	if (rec.compat && typeof rec.compat === "object") {
		entry.compat = rec.compat as Record<string, unknown>;
	}
	return entry;
}

function nativeModelEntries(models: unknown[]): NativeModelEntry[] {
	const out: NativeModelEntry[] = [];
	for (const model of models) {
		const entry = nativeModelEntry(model);
		if (entry) out.push(entry);
	}
	return out;
}

/**
 * Provision a rotation slot into Pi's OWN static provider registry (models.json)
 * so any bare `pi -p` child resolves `kimi-coding-account-2/k3` or
 * `cursor/cursor-grok-4.6` WITHOUT this extension loaded. Written ONLY here:
 * at slot login/discovery — never on failover, rotation, or limit events.
 * Failover state lives in provider-failover-state.json, our own file.
 * Merge-only: existing user entries and unrelated keys are preserved verbatim.
 */
function provisionNativeSlot(provider: string, entry: NativeProviderEntry): void {
	try {
		const models = nativeModelEntries(entry.models);
		const raw = existsSync(MODELS_CONFIG_PATH)
			? readFileSync(MODELS_CONFIG_PATH, "utf8")
			: "{}";
		const parsed = JSON.parse(raw);
		const providers =
			typeof parsed?.providers === "object" && parsed.providers !== null
				? parsed.providers
				: {};
		const existing = providers[provider];
		const normalized: Record<string, unknown> = {
			api: entry.api,
			baseUrl: entry.baseUrl,
			models,
		};
		if (entry.apiKey) normalized.apiKey = entry.apiKey;
		if (entry.compat) normalized.compat = entry.compat;
		const modelOverrides = preservedModelOverrides(existing);
		if (modelOverrides) normalized.modelOverrides = modelOverrides;
		if (
			existing?.baseUrl === normalized.baseUrl &&
			existing?.api === normalized.api &&
			existing?.apiKey === normalized.apiKey &&
			JSON.stringify(existing?.models ?? []) === JSON.stringify(models)
		) {
			return; // already provisioned — do not touch the file
		}
		const next = {
			...parsed,
			providers: { ...providers, [provider]: normalized },
		};
		const tmp = `${MODELS_CONFIG_PATH}.multi-account.tmp`;
		writeFileSync(tmp, `${JSON.stringify(next, null, 2)}
`, {
			encoding: "utf8",
			mode: 0o600,
		});
		renameSync(tmp, MODELS_CONFIG_PATH);
	} catch {
		/* models.json locked/corrupt — the extension registry still works */
	}
}

/** Remove loopback publications we wrote, never a user's own models.json entry. */
function unprovisionOwnLoopbacks(slotIds?: readonly string[]): void {
	try {
		if (!existsSync(MODELS_CONFIG_PATH)) return;
		const parsed = JSON.parse(readFileSync(MODELS_CONFIG_PATH, "utf8"));
		const providers =
			typeof parsed?.providers === "object" && parsed.providers !== null
				? parsed.providers
				: undefined;
		if (!providers) return;
		const nextProviders = dropOwnLoopbackPublications(providers, slotIds);
		if (JSON.stringify(nextProviders) === JSON.stringify(providers)) return;
		const next = { ...parsed, providers: nextProviders };
		const tmp = `${MODELS_CONFIG_PATH}.multi-account.tmp`;
		writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		renameSync(tmp, MODELS_CONFIG_PATH);
	} catch {
		/* leaving a stale loopback is worse than a failed write; next publish retries */
	}
}

// "Black box" flight recorder: a structured, append-only log of every decision the
// extension makes (switches, errors, watchdog actions, breaker trips, compaction
// routing). When something misbehaves, this file is the exact reproduction trail —
// no guessing from screenshots. It NEVER contains tokens/credentials (only provider
// ids, model ids, truncated reasons). Bounded size with one rotation so it can never
// fill the disk.
const DEBUG_LOG_PATH = join(AGENT_DIR, "provider-failover-debug.log");
const DEBUG_LOG_MAX_BYTES = 4 * 1024 * 1024; // rotate to .log.1 past this
const STATE_VERSION = 5;
const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const DEFAULT_PROBE_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_INVALID_COOLDOWN_MS = 365 * 24 * 60 * 60 * 1000; // effectively "until re-login"
const DEFAULT_TRANSIENT_COOLDOWN_MS = 60 * 1000;
const DEFAULT_USAGE_REFRESH_MS = 5 * 60 * 1000;
const DEFAULT_USAGE_STATUS_REFRESH_MS = 60 * 1000;
const CODEX_MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;
const OLLAMA_MODEL_CATALOG_TTL_MS = 30 * 60 * 1000;
const MIN_ANTHROPIC_USAGE_REFRESH_MS = 10 * 60 * 1000;
const MAX_MIGRATED_COOLDOWN_MS = 8 * 24 * 60 * 60 * 1000;
// v1.13.7 — Hard ceiling on any LIVE-parsed cooldown. Codex/usage error bodies can report the
// reset of a long ROLLING window (weekly/monthly) as `resets_at`, which — taken literally — evicts
// an account from rotation for weeks even though its short (primary) window has already freed. Any
// single estimate is capped here so a mis-parsed or long-window reset can never lock a live account
// for more than this; the account is re-probed at the cap and cooldownMsFromUsage self-corrects the
// moment the primary window has headroom. Cooling-down accounts are otherwise never probed, so
// without this cap the far-future estimate is a dead end (the "bogus cooldown" bug, open since v1.13.1).
const MAX_LIVE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
// Default ceiling on any predicted unavailability. Every number a provider gives us about the
// FUTURE — reset timestamps, "try again in N min", used-percentage against a quota size the
// provider can resize at will — is a forecast that goes stale silently the moment the provider
// refreshes a window early. Rather than trying to predict better, we cap how long any forecast
// may prevent us from simply asking the account again. A rejected request costs no tokens, so
// re-asking is close to free; only a successful one proves availability.
const MAX_RECHECK_INTERVAL_MS = 10 * 60 * 1000;
const MIN_PENDING_WAKE_MS = 1000;
// The usage-% endpoint tracks an account's QUOTA window; it does NOT reflect session/rate limits.
// So a session-limited account keeps 429ing "usage limit reached" while usage still reports
// headroom. Trusting usage as ground truth then reports the account "free now", schedules a ~1s
// retry, gets 429 again, and loops. Once a provider limit-errors TWICE within this window (no
// success in between), the usage reading is proven a liar for this account and is distrusted.
const LIMIT_STREAK_WINDOW_MS = 15 * 60 * 1000;
// How long to ignore "usage says free" for a provider after usage has been proven wrong, so the
// recorded cooldown from the real error sticks instead of being cleared on the next poll.
const USAGE_UNTRUSTED_MS = 30 * 60 * 1000;
// Minimum backoff to record for a session/rate limit the usage window cannot see, so the wake
// timer polls (every PENDING_POLL_MS) instead of hot-retrying a maxed account every second.
const SESSION_LIMIT_FLOOR_MS = 5 * 60 * 1000;
const AUTH_CHANGE_POLL_MS = 5000;
// While a session is paused waiting for ANY account to recover, never sleep longer than this
// between availability checks. A single multi-hour timer would miss an account that recovers
// earlier than its recorded estimate (or a fresh /login in a parallel session); polling lets the
// first account that is ACTUALLY free pick the work back up.
const PENDING_POLL_MS = 60 * 1000;
const MAX_QUEUED_USER_INPUTS = 20;
// A held user message is only worth delaying a compaction for if it is about to be sent.
const QUEUE_FLUSH_SOON_MS = 10 * 1000;
// Runaway-loop guards (added). Without these, when every account is rate-limited the
// failover bounces between accounts every 1-9s forever, growing the session history
// until the machine swaps itself to death.
const ANTI_PINGPONG_MS = 60 * 1000; // don't switch straight back to the account we just left
// A 401 on an OAuth account usually just means "access token expired, refresh it" — Pi refreshes
// on the next call. So a single 401 must NOT permanently kill a refreshable account (that was the
// "it dropped me off an account that still had tokens" bug). Only kill it after this many 401s in a
// row with no successful response in between. Non-refreshable (API-key) 401 is fatal immediately.
// Bumped on every release. Printed at startup and in `/multi-account status` so you can verify
// which version Pi actually loaded (a running Pi keeps the version it started with — /login and
// /reload do NOT reload extension code; only a full restart does).
const VERSION = "1.21.2";
const MODEL_CATALOG_REQUEST_EVENT = "pi:model-catalog:request:v1";
const MODEL_CATALOG_SNAPSHOT_EVENT = "pi:model-catalog:snapshot:v1";
const TRANSIENT_PENDING_PREFIX = "temporary provider failure:";
// Pending reason for a turn that was NOT a model/account failure — the prior turn simply had
// not gone idle in time, so we re-arm to resume the SAME model. This must never be treated as
// a failure of the current model (doing so would downgrade it to an older sibling on the same
// account, which shares the same quota pool and gains nothing).
const BUSY_RETRY_REASON = "previous turn was still busy; auto-retry";
// Raised from 3 → 8. A single transient 401 burst from OpenAI Codex (one physical event
// that Pi surfaces as 3 error hooks: response/message/agent) hit the old threshold instantly
// and permanently killed a live account. The threshold now tolerates a retry burst plus a
// few genuinely distinct failures. Dedup in markAuthFailure (same-hash repeats do not count)
// is the other half of this fix.
const MAX_CONSECUTIVE_AUTH_FAILURES = 8;
const TRANSIENT_AUTH_COOLDOWN_MS = 60 * 1000; // brief skip after a 401 so the next call can refresh

// For non-refreshable (API-key) providers, repeated 401s with the SAME key are not a
// transient blip — the key is permanently invalid. After this many consecutive same-key
// failures, invalidate the account so the user is told to re-login instead of looping
// on a 1-minute cooldown forever.
const MAX_SAME_KEY_AUTH_FAILURES = 3;

// --- Forward-progress watchdogs (v1.12.0) ----------------------------------
// A resumed/rotated turn must NEVER be able to hang the session forever. The old
// code awaited pi.continueAgent() and busy-waited on ctx.isIdle() with no upper
// bound, so any stall (a wedged compaction, a provider socket that never returns,
// an account that quietly accepts the request but never streams) showed the user a
// spinning "working" animation with zero progress and no way to tell it was dead.
// These bounds turn whole CLASSES of "it just hangs" — including ones never
// individually enumerated — into a visible, recoverable state.
const RESUME_IDLE_TIMEOUT_MS = 90 * 1000; // max wait for the prior turn to go idle before we stop blocking
const STUCK_WATCHDOG_MS = 180 * 1000; // total silence (no stream/tool/response) on a resumed turn ⇒ "stuck"
const STUCK_REMINDER_MS = 120 * 1000; // re-surface the stuck notice this often while it stays stuck
// Hang bound for a routed summary, not a success SLA. Large sessions on Opus routinely
// take more than 2–3 minutes; the old 150s cap aborted a live summary and then handed
// compaction to the spent account, which is how "Compacting context…" never ended.
const COMPACTION_WATCHDOG_MS = 8 * 60 * 1000;
// How many accounts a single routed compaction may actually ask.
//
// The candidate list is the whole rotation, which on a fully-populated machine is nine accounts
// across seven vendors — including the per-token ones that are in the list precisely because
// nothing measures them. Walking all of them turned one compaction into nine sequential provider
// calls (observed: 98 failures in a row, "insufficient balance", "requires a subscription",
// "no endpoints found", "does not exist or you do not have access"), and the user watched
// "Compacting context…" the whole time. Two spares after the first choice is enough: if three
// accounts in a row cannot summarize, the tenth will not either.
const COMPACTION_MAX_ATTEMPTS = 3;
// How long an account that refused for a reason needing a human — no balance, no access to the
// model, a model that is gone — is skipped as a summariser, so the next compaction does not
// re-discover the same wall of refusals it just walked.
const COMPACTION_UNFIT_MS = 30 * 60 * 1000;
/**
 * Refusals that are about the ACCOUNT, not about this attempt.
 *
 * Deliberately narrow: a 500, a timeout, or an overload is a bad moment and must not bench an
 * account that will work again in a minute. Everything listed here needs a human to buy, upgrade
 * or re-login before it can change, so re-asking within the half hour only costs time.
 */
const COMPACTION_UNFIT_PATTERNS = [
	"insufficient balance",
	"insufficient_quota",
	"no resource package",
	"creditserror",
	"requires a subscription",
	"requires both a pro",
	"do not have access",
	"does not exist or you do not have access",
	"no endpoints found",
	"unable to verify your membership",
	"exceeds the context window",
	"usage limit",
	"quota",
];

// --- Circuit breaker (v1.13.0) ---------------------------------------------
// The reliability FLOOR. If automatic recovery keeps failing (resume wedges, switch
// makes no progress) the extension stops trying to be clever and drops to "advisory
// mode": it still flags rate limits and tells you which account to switch to, but it
// no longer attempts the auto-continue that was hanging. Guarantee: the extension can
// never make the experience WORSE than switching accounts by hand. Closes again on any
// real forward progress, a new user prompt, /multi-account reset, or after a cooldown.
const BREAKER_FAILURE_THRESHOLD = 3; // consecutive failed recoveries before tripping
const BREAKER_COOLDOWN_MS = 10 * 60 * 1000; // how long advisory mode lasts once tripped

const ANTHROPIC_BASE = "anthropic";
const CODEX_BASE = "openai-codex";
const OLLAMA_BASE = "ollama";
const DEFAULT_QWEN_PROVIDER = "alibaba";

const DEFAULT_LIMIT_PATTERNS = [
	"429",
	"rate limit",
	"rate_limit",
	"too many requests",
	"usage limit",
	"usage_limit_reached",
	"usage_not_included",
	"quota",
	"insufficient_quota",
	"out of budget",
	"available balance",
	"billing hard limit",
	"monthly usage limit",
	"freeusagelimiterror",
	"gousagelimiterror",
	// "Payment required" — the account's credits or free allowance no longer cover the request.
	// This is a limit like any other: the account cannot serve work until it is topped up, so it
	// must cool down and rotation must move on. Left unrecognised, a session parked on such an
	// account produced the same refusal for every user message forever, because nothing
	// classified the error and therefore nothing switched away. Matched on prose rather than the
	// bare status code: `402` as a substring also occurs inside token counts ("38402 tokens").
	"payment required",
	"limit_source",
	"remaining balance",
	"upgrade to a paid account",
	"insufficient credits",
	"insufficient_credits",
	"out of credits",
	"credit balance is too low",
	"add credits",
	"third-party apps now draw from your extra usage",
	// gRPC status code for quota exhaustion. Cursor (and other OpenAI-compatible backends
	// fronted by gRPC) surface a per-account quota wall as `resource_exhausted`, not a 429.
	// Without this entry the refusal is unclassified → no failover → every turn dies on the
	// spent account forever. Treated as a limit so the account cools down and rotation moves on.
	"resource_exhausted",
];

// Errors that mean "this account's authorization is dead" → drop from rotation
// until the user re-logs in (not a temporary cooldown).
const DEFAULT_AUTH_ERROR_PATTERNS = [
	"401",
	"unauthorized",
	"authentication_error",
	"could not parse your authentication token",
	"authentication token has been invalidated",
	"token has been invalidated",
	"invalid authentication",
	"invalid_token",
	"invalid token",
	"token has expired",
	"token expired",
	"expired token",
	"invalid_grant",
	"invalid api key",
	"incorrect api key",
	"no api key",
	"missing api key",
	"revoked",
	"oauth token",
];

const DEFAULT_TRANSIENT_ERROR_PATTERNS = [
	"408",
	"425",
	"500",
	"502",
	"503",
	"504",
	"529",
	"overloaded",
	"service unavailable",
	"temporarily unavailable",
	"internal server error",
	"bad gateway",
	"gateway timeout",
	"request timeout",
	"timed out",
	"timeout",
	"connection reset",
	"econnreset",
	"econnrefused",
	"enetunreach",
	"fetch failed",
	"network error",
	"socket hang up",
	"stream disconnected",
	"websocket error",
	"server error",
];

const DEFAULT_MODEL_ERROR_PATTERNS = [
	"model_not_found",
	"model not found",
	"unsupported model",
	"unknown model",
	"model is unavailable",
	"model unavailable",
	"does not have access to model",
	"do not have access to model",
];

// These are explicit provider verdicts that reusing or refreshing the current credential cannot
// repair. Unlike a generic 401, they should remove the account from rotation immediately.
const TERMINAL_AUTH_ERROR_PATTERNS = [
	"authentication token has been invalidated",
	"token has been invalidated",
	"invalid_grant",
	"revoked",
	"invalid api key",
	"invalid api-key",
	"incorrect api key",
	"incorrect api-key",
	"api-key provided",
	"apikey-error",
];

const FORCE_REFRESH_AUTH_ERROR_PATTERNS = [
	"authentication token has been invalidated",
	"token has been invalidated",
];

// These are explicit refresh-endpoint verdicts that re-login cannot wait out.
// IMPORTANT: "refresh_token_invalidated" and "session has ended" were REMOVED from this list in
// v1.9.0 — OpenAI Codex returns them transiently under load even when the account is alive
// (a parallel Pi session can refresh the same token moments later). They are now treated as
// transient: the account gets a short cooldown and the next attempt can still refresh.
const TERMINAL_REFRESH_ERROR_PATTERNS = ["invalid_grant", "revoked"];

const DEFAULT_IGNORE_PATTERNS = [
	"context overflow",
	"context window",
	"context length",
	"maximum context",
	"too many tokens",
	"token limit exceeded",
	"input is too long",
];

const DEFAULT_CONTINUATION_PROMPT = [
	"Provider failover activated: switched to {to} after {from} hit a quota or rate limit.",
	"Continue the interrupted task from where it stopped.",
	"The interrupted turn itself is preserved verbatim in this session as a [handoff:interrupted-turn] record — read it before acting:",
	"it contains the reasoning and output of that turn plus every tool call it issued, marking which ones never returned a result.",
	"Anything shown there was already attempted, so verify the current state instead of redoing it, and do not restart the task from the beginning.",
].join(" ");

// ---------------------------------------------------------------------------
// Interrupted-turn preservation ("black box" handoff record)
// ---------------------------------------------------------------------------
// Two independent pi-ai behaviours combine to erase the interruption point on every
// cross-provider failover:
//
//   1. `transform-messages` skips any assistant message whose stopReason is "error" or
//      "aborted" — incomplete turns are never replayed. The turn that TRIGGERED the
//      failover is exactly the turn that gets dropped.
//   2. The same pass degrades thinking blocks to plain text (and drops redacted ones
//      outright) whenever the next request runs on a different model — which is exactly
//      what an account switch does.
//
// The account taking over therefore receives a continuation prompt telling it "do not
// repeat completed work" while the record of that work has just been deleted, and its
// tool results are left in the transcript with no request to attach them to.
//
// The `context` hook runs on AgentMessage[] BEFORE convertToLlm/transformMessages, so it
// is the last point at which the interrupted turn is still intact. We rewrite it into a
// `user` message — the one role transform-messages passes through verbatim on every
// provider — folding its orphaned tool results into the same record.
//
// Invariants this rendering must keep:
//   * Deterministic: identical input produces byte-identical output, so replaying the
//     hook on every request never invalidates the prompt cache (no timestamps, no rng).
//   * Orphan-free: every tool result belonging to the dropped turn is folded in and
//     removed, so no toolResult survives without its originating tool call.
//   * Bounded: hard caps on every section, so rescuing context can never blow the
//     context window of the account we just switched to.
const HANDOFF_MARKER = "[handoff:interrupted-turn]";
const HANDOFF_MAX_TEXT = 4000;
const HANDOFF_MAX_THINKING = 3000;
const HANDOFF_MAX_ARGS = 800;
const HANDOFF_MAX_RESULT = 1000;
const HANDOFF_MAX_TOOL_CALLS = 12;
const HANDOFF_MAX_ERROR = 400;

/** Head+tail clip: the start says what the turn was doing, the tail says where it died. */
function clipHandoff(value: string, max: number): string {
	const text = value.trim();
	if (text.length <= max) return text;
	const head = Math.ceil(max * 0.6);
	const tail = max - head;
	return `${text.slice(0, head)}\n…[${text.length - max} characters omitted]…\n${text.slice(-tail)}`;
}

function handoffBlockText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: any) =>
			block && typeof block === "object" && block.type === "text"
				? String(block.text ?? "")
				: "",
		)
		.filter(Boolean)
		.join("\n");
}

/**
 * Render the verbatim handoff record for one interrupted assistant message.
 * Returns undefined when the turn carries nothing worth preserving (a turn aborted
 * before it produced anything), so we leave those to pi's normal drop path.
 */
export function renderHandoffRecord(
	message: any,
	resultsByCallId: Map<string, any>,
): string | undefined {
	const texts: string[] = [];
	const thinking: string[] = [];
	const toolCalls: any[] = [];
	for (const block of Array.isArray(message?.content) ? message.content : []) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string") {
			if (block.text.trim()) texts.push(block.text);
		} else if (block.type === "thinking") {
			// Redacted thinking is an opaque provider-encrypted payload: it cannot be
			// replayed cross-model and has no plain text to preserve.
			if (!block.redacted && typeof block.thinking === "string" && block.thinking.trim())
				thinking.push(block.thinking);
		} else if (block.type === "toolCall") {
			toolCalls.push(block);
		}
	}
	const errorMessage =
		typeof message?.errorMessage === "string" ? message.errorMessage.trim() : "";
	if (!texts.length && !thinking.length && !toolCalls.length) return undefined;

	const ref =
		message?.provider && message?.model
			? `${message.provider}/${message.model}`
			: "the previous account";
	const stopped = message?.stopReason === "aborted" ? "cancelled" : "interrupted";
	const lines: string[] = [
		`${HANDOFF_MARKER} The turn below ran on ${ref} and was ${stopped} before it finished.`,
		"Pi does not replay interrupted turns, so its content is reproduced here verbatim and will otherwise be lost.",
		"Treat everything in this record as work ALREADY ATTEMPTED: verify the current state before redoing any of it, and continue from the stopping point rather than from the start.",
	];
	if (thinking.length) {
		lines.push(
			"",
			"--- reasoning of the interrupted turn (verbatim) ---",
			clipHandoff(thinking.join("\n"), HANDOFF_MAX_THINKING),
		);
	}
	if (texts.length) {
		lines.push(
			"",
			"--- output written before the interruption (verbatim) ---",
			clipHandoff(texts.join("\n"), HANDOFF_MAX_TEXT),
		);
	}
	if (toolCalls.length) {
		lines.push("", "--- tool calls issued in that turn ---");
		const shown = toolCalls.slice(0, HANDOFF_MAX_TOOL_CALLS);
		shown.forEach((call: any, index: number) => {
			let args = "";
			try {
				args = JSON.stringify(call?.arguments ?? {});
			} catch {
				args = "<unserializable arguments>";
			}
			lines.push(
				`${index + 1}. ${String(call?.name ?? "unknown")} — arguments: ${clipHandoff(args, HANDOFF_MAX_ARGS)}`,
			);
			const result = resultsByCallId.get(String(call?.id));
			if (!result) {
				lines.push(
					"   result: NONE — the turn was interrupted before this call returned. Its effect is UNKNOWN and must be checked.",
				);
				return;
			}
			const body = clipHandoff(handoffBlockText(result.content), HANDOFF_MAX_RESULT);
			lines.push(
				`   result${result.isError ? " (error)" : ""}: ${body || "<empty>"}`,
			);
		});
		if (toolCalls.length > shown.length)
			lines.push(
				`…and ${toolCalls.length - shown.length} further tool call(s) omitted from this record.`,
			);
	}
	if (errorMessage) {
		lines.push(
			"",
			`--- why it stopped ---`,
			clipHandoff(errorMessage, HANDOFF_MAX_ERROR),
		);
	}
	lines.push("", `--- end of ${HANDOFF_MARKER} ---`);
	return lines.join("\n");
}

/**
 * Replace every interrupted assistant message with a verbatim `user` handoff record and
 * fold in (and remove) the tool results that belonged to it. Returns the original array
 * when there is nothing to preserve, so the caller can skip the hook result entirely.
 */
export function preserveInterruptedTurns(messages: any[]): any[] {
	if (!Array.isArray(messages) || messages.length === 0) return messages;
	const interrupted = messages.filter(
		(message: any) =>
			message?.role === "assistant" &&
			(message.stopReason === "error" || message.stopReason === "aborted"),
	);
	if (interrupted.length === 0) return messages;

	// Tool results are addressed by call id, so a single index over the whole transcript
	// is enough — and it stays correct no matter how the host interleaves them.
	const resultsByCallId = new Map<string, any>();
	for (const message of messages) {
		if (message?.role === "toolResult" && message.toolCallId != null)
			resultsByCallId.set(String(message.toolCallId), message);
	}
	const foldedResultIds = new Set<string>();
	const rendered = new Map<any, string>();
	for (const message of interrupted) {
		const record = renderHandoffRecord(message, resultsByCallId);
		if (!record) continue;
		rendered.set(message, record);
		for (const block of Array.isArray(message.content) ? message.content : []) {
			if (block?.type === "toolCall" && block.id != null)
				foldedResultIds.add(String(block.id));
		}
	}
	if (rendered.size === 0) return messages;

	const out: any[] = [];
	for (const message of messages) {
		const record = rendered.get(message);
		if (record) {
			out.push({
				role: "user",
				content: [{ type: "text", text: record }],
				// Reuse the original timestamp: the record must be byte-identical on every
				// replay or it would invalidate the prompt cache on each request.
				timestamp: message.timestamp,
			});
			continue;
		}
		if (
			message?.role === "toolResult" &&
			message.toolCallId != null &&
			foldedResultIds.has(String(message.toolCallId))
		)
			continue; // folded into the record above; leaving it would orphan it
		out.push(message);
	}
	return out;
}

const DEFAULT_PROVIDER_ORDER: ProviderFamily[] = [
	"anthropic",
	"openai-codex",
	"kimi-coding",
	"cursor",
	"qwen",
	"ollama",
];

const CODEX_MODEL_DEFS: Record<string, Record<string, unknown>> = {
	"gpt-5.3-codex-spark": {
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
		input: ["text"],
		cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 128000,
	},
	"gpt-5.4": {
		id: "gpt-5.4",
		name: "GPT-5.4",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
		input: ["text", "image"],
		cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
	"gpt-5.4-mini": {
		id: "gpt-5.4-mini",
		name: "GPT-5.4 mini",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
		input: ["text", "image"],
		cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
	"gpt-5.5": {
		id: "gpt-5.5",
		name: "GPT-5.5",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
		input: ["text", "image"],
		cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
};
// Deliberately NOT listing the 5.6 family (gpt-5.6-sol / -terra / -luna) or anything newer here.
// Those come from the host model registry and the live per-account catalog, which carry their real
// costs, context windows and reasoning levels — and `compareCodexModelStrength` already ranks an
// unknown generation correctly by version and variant. Hard-coding guessed ids would risk offering
// a model a given plan cannot serve, and re-introduce the release-per-generation treadmill.

// Offline last resort ONLY — newest first. Both the live per-account catalog and the host
// model registry outrank this list (see refreshRegistryCodexModels), which is what makes a
// new generation such as gpt-5.6 win with no release here. Deliberately conservative: it must
// never *invent* a model the host has never heard of and OpenAI may not serve for this plan.
const DEFAULT_CODEX_MODELS = [
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.3-codex-spark",
];
// Newest first. Offline fallback ordering: the host model registry is consulted too (see
// refreshRegistryAnthropicModels), so a newer flagship wins even before it is listed here.
const DEFAULT_ANTHROPIC_MODELS = [
	"claude-opus-5",
	"claude-opus-4-8",
	"claude-opus-4-5",
	// claude-sonnet-4-6 contributed by @RuslanAsadov (PR #1).
	"claude-sonnet-4-6",
	"claude-sonnet-4-5",
	"claude-haiku-4-5",
];

const DEFAULT_OLLAMA_MODELS = ["glm-5.2:cloud"];
const DEFAULT_QWEN_MODELS = ["qwen3.8-max", "qwen-max", "qwen-plus"];
const DEFAULT_CURSOR_MODELS = ["cursor-grok-4.6", "grok-4.6", "composer-2.5"];

const DEFAULT_CONFIG: ProviderFailoverConfig = {
	enabled: true,
	autoContinue: true,
	autoDiscover: true,
	autoDiscoverModels: true,
	maxAccountsPerProvider: 10,
	includeQwen: true,
	qwenProvider: DEFAULT_QWEN_PROVIDER,
	includeOllama: true,
	includeOtherProviders: true,
	includeCursor: true,
	childProxy: true,
	neverFailoverProviders: [],
	providerOrder: DEFAULT_PROVIDER_ORDER,
	providerPriority: DEFAULT_PROVIDER_PRIORITY,
	cooldownMs: DEFAULT_COOLDOWN_MS,
	probeCooldownMs: DEFAULT_PROBE_COOLDOWN_MS,
	invalidCooldownMs: DEFAULT_INVALID_COOLDOWN_MS,
	transientCooldownMs: DEFAULT_TRANSIENT_COOLDOWN_MS,
	showUsage: true,
	usageRefreshMs: DEFAULT_USAGE_REFRESH_MS,
	usageStatusRefreshMs: DEFAULT_USAGE_STATUS_REFRESH_MS,
	pendingPollMs: PENDING_POLL_MS,
	maxAutoContinuesPerPrompt: 8,
	fallbacks: [],
	openaiCodexAliases: [],
	anthropicOAuthAliases: [],
	limitErrorPatterns: DEFAULT_LIMIT_PATTERNS,
	authErrorPatterns: DEFAULT_AUTH_ERROR_PATTERNS,
	transientErrorPatterns: DEFAULT_TRANSIENT_ERROR_PATTERNS,
	modelErrorPatterns: DEFAULT_MODEL_ERROR_PATTERNS,
	ignoreErrorPatterns: DEFAULT_IGNORE_PATTERNS,
	continuationPrompt: DEFAULT_CONTINUATION_PROMPT,
	maxRecheckIntervalMs: MAX_RECHECK_INTERVAL_MS,
	contextGuard: true,
	continueAfterCompaction: true,
	preserveInterruptedContext: true,
	routeCompactionToHealthyAccount: true,
	autoRecoverStuck: true,
	debugLog: true,
	preferLatestModel: true,
	reasoningLevel: "auto",
	preferredModels: {},
	resumeIdleTimeoutMs: RESUME_IDLE_TIMEOUT_MS,
	stuckWatchdogMs: STUCK_WATCHDOG_MS,
	compactionWatchdogMs: COMPACTION_WATCHDOG_MS,
};

// ---------------------------------------------------------------------------
// Config + state persistence
// ---------------------------------------------------------------------------

function ensureDefaultConfig() {
	if (existsSync(CONFIG_PATH)) return;
	mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
	writeFileSync(
		CONFIG_PATH,
		`${JSON.stringify(DEFAULT_CONFIG, null, "\t")}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
}

function positiveOr(value: unknown, fallback: number) {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: fallback;
}

/**
 * Resolve the context-guard settings. `true`/absent takes the defaults, `false` turns the guard
 * off, an object overrides individual thresholds. Every number is sanity-checked here rather than
 * trusted, because a mistyped percentage would either trim on every request or never at all.
 */
function normalizeContextGuard(value: unknown): ContextGuardSettings {
	const defaults = DEFAULT_CONTEXT_GUARD_SETTINGS;
	if (value === false) return { ...defaults, enabled: false };
	if (value === true || value === undefined || value === null) return { ...defaults };
	if (typeof value !== "object") return { ...defaults };
	const raw = value as Partial<ContextGuardSettings>;
	const share = (candidate: unknown, fallback: number) =>
		typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0 && candidate <= 1
			? candidate
			: fallback;
	const settings: ContextGuardSettings = {
		enabled: raw.enabled ?? true,
		softPercent: share(raw.softPercent, defaults.softPercent),
		targetPercent: share(raw.targetPercent, defaults.targetPercent),
		compactPercent: share(raw.compactPercent, defaults.compactPercent),
		keepVerbatimTokens: positiveOr(raw.keepVerbatimTokens, defaults.keepVerbatimTokens),
		minElideTokens: positiveOr(raw.minElideTokens, defaults.minElideTokens),
		maxWindowTokens:
			typeof raw.maxWindowTokens === "number" &&
			Number.isFinite(raw.maxWindowTokens) &&
			raw.maxWindowTokens >= 0
				? raw.maxWindowTokens
				: defaults.maxWindowTokens,
	};
	// Trimming down to a point at or above where trimming starts would loop; keep them ordered.
	if (settings.targetPercent >= settings.softPercent) {
		settings.targetPercent = Math.max(0.1, settings.softPercent - 0.15);
	}
	return settings;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function nonEmptyStringArrayOr(value: unknown, fallback: string[]): string[] {
	const sanitized = stringArray(value);
	return sanitized.length > 0 ? sanitized : fallback;
}

/**
 * The error vocabulary is a dictionary that GROWS with each release, so a user's list is merged
 * with the built-in one rather than replacing it.
 *
 * `/multi-account` writes the full config to disk, defaults included, so nearly every installed
 * config contains a frozen snapshot of the vocabulary that shipped the day it was written. Under
 * replace-semantics that snapshot permanently pinned the classifier: a newly recognised refusal —
 * say a provider that starts answering "payment required" — was understood on a fresh install and
 * invisible on every machine that had ever run the command. That is exactly backwards, because
 * the machines with a config are the ones in use. Anything the user adds still takes effect; they
 * simply cannot silently miss a term added later.
 */
function patternsWithDefaults(value: unknown, defaults: string[]): string[] {
	const merged = [...defaults];
	for (const pattern of stringArray(value)) {
		if (!merged.some((known) => known.toLowerCase() === pattern.toLowerCase()))
			merged.push(pattern);
	}
	return merged;
}

function normalizeConfig(raw: ProviderFailoverConfig): RuntimeConfig {
	// A saved `providerOrder` states a PREFERENCE about sequence, never a whitelist of which
	// families may exist. `/multi-account` writes the whole config out, so every installed config
	// froze the family list as it stood the day it was written — and a family promoted to managed
	// later then fell through both doors at once: too new for the saved order, no longer eligible
	// as an "other" provider because it is managed now. The account simply disappeared from the
	// ring, with `rediscover` unable to help because discovery was working exactly as written.
	// Families the user never ranked are appended in their default order, after the ones they did.
	const configured =
		Array.isArray(raw.providerOrder) && raw.providerOrder.length > 0
			? raw.providerOrder
			: DEFAULT_PROVIDER_ORDER;
	const order = [
		...configured,
		...DEFAULT_PROVIDER_ORDER.filter((family) => !configured.includes(family)),
	];
	return {
		enabled: raw.enabled ?? true,
		autoContinue: raw.autoContinue ?? true,
		autoDiscover: raw.autoDiscover ?? true,
		autoDiscoverModels: raw.autoDiscoverModels ?? true,
		maxAccountsPerProvider: Math.max(
			1,
			Math.floor(positiveOr(raw.maxAccountsPerProvider, 10)),
		),
		includeQwen: raw.includeQwen ?? true,
		qwenProvider: raw.qwenProvider?.trim() || DEFAULT_QWEN_PROVIDER,
		includeOllama: raw.includeOllama ?? true,
		includeOtherProviders: raw.includeOtherProviders ?? true,
		includeCursor: raw.includeCursor ?? true,
		childProxy: raw.childProxy ?? true,
		onlyActive: raw.onlyActive ?? false,
		neverFailoverProviders: stringArray(raw.neverFailoverProviders),
		providerOrder: order.filter(
			(f): f is ProviderFamily =>
				f === "anthropic" ||
				f === "openai-codex" ||
				f === "kimi-coding" ||
				f === "cursor" ||
				f === "qwen" ||
				f === "ollama",
		),
		// An explicitly empty list means "no stated preference" and is honoured as such; only an
		// absent key falls back to the shipped ladder.
		providerPriority: Array.isArray(raw.providerPriority)
			? normalizePriority(raw.providerPriority)
			: [...DEFAULT_PROVIDER_PRIORITY],
		cooldownMs: positiveOr(raw.cooldownMs, DEFAULT_COOLDOWN_MS),
		probeCooldownMs: positiveOr(raw.probeCooldownMs, DEFAULT_PROBE_COOLDOWN_MS),
		invalidCooldownMs: positiveOr(
			raw.invalidCooldownMs,
			DEFAULT_INVALID_COOLDOWN_MS,
		),
		transientCooldownMs: positiveOr(
			raw.transientCooldownMs,
			DEFAULT_TRANSIENT_COOLDOWN_MS,
		),
		showUsage: raw.showUsage ?? true,
		usageRefreshMs: positiveOr(raw.usageRefreshMs, DEFAULT_USAGE_REFRESH_MS),
		usageStatusRefreshMs: positiveOr(
			raw.usageStatusRefreshMs,
			DEFAULT_USAGE_STATUS_REFRESH_MS,
		),
		pendingPollMs: positiveOr(raw.pendingPollMs, PENDING_POLL_MS),
		maxAutoContinuesPerPrompt: Math.floor(
			positiveOr(raw.maxAutoContinuesPerPrompt, 8),
		),
		fallbacks: stringArray(raw.fallbacks),
		openaiCodexAliases: Array.isArray(raw.openaiCodexAliases)
			? raw.openaiCodexAliases
			: [],
		anthropicOAuthAliases: Array.isArray(raw.anthropicOAuthAliases)
			? raw.anthropicOAuthAliases
			: [],
		limitErrorPatterns: patternsWithDefaults(
			raw.limitErrorPatterns,
			DEFAULT_LIMIT_PATTERNS,
		),
		authErrorPatterns: patternsWithDefaults(
			raw.authErrorPatterns,
			DEFAULT_AUTH_ERROR_PATTERNS,
		),
		transientErrorPatterns: patternsWithDefaults(
			raw.transientErrorPatterns,
			DEFAULT_TRANSIENT_ERROR_PATTERNS,
		),
		modelErrorPatterns: patternsWithDefaults(
			raw.modelErrorPatterns,
			DEFAULT_MODEL_ERROR_PATTERNS,
		),
		ignoreErrorPatterns: patternsWithDefaults(
			raw.ignoreErrorPatterns,
			DEFAULT_IGNORE_PATTERNS,
		),
		continuationPrompt:
			raw.continuationPrompt?.trim() || DEFAULT_CONTINUATION_PROMPT,
		maxRecheckIntervalMs: positiveOr(
			raw.maxRecheckIntervalMs,
			MAX_RECHECK_INTERVAL_MS,
		),
		contextGuard: normalizeContextGuard(raw.contextGuard),
		continueAfterCompaction: raw.continueAfterCompaction ?? true,
		preserveInterruptedContext: raw.preserveInterruptedContext ?? true,
		routeCompactionToHealthyAccount:
			raw.routeCompactionToHealthyAccount ?? true,
		autoRecoverStuck: raw.autoRecoverStuck ?? true,
		debugLog: raw.debugLog ?? true,
		preferLatestModel: raw.preferLatestModel ?? true,
		// Anything unset/invalid means "auto": follow the session's own level. Forcing a level
		// here would clobber per-agent `--thinking` on every turn (issue #6).
		reasoningLevel:
			raw.reasoningLevel === "off" ||
			raw.reasoningLevel === "minimal" ||
			raw.reasoningLevel === "low" ||
			raw.reasoningLevel === "medium" ||
			raw.reasoningLevel === "high" ||
			raw.reasoningLevel === "xhigh" ||
			raw.reasoningLevel === "max"
				? raw.reasoningLevel
				: "auto",
		preferredModels:
			raw.preferredModels && typeof raw.preferredModels === "object"
				? Object.fromEntries(
						Object.entries(raw.preferredModels)
							.map(([k, v]) => [k, stringArray(v)] as const)
							.filter(([, v]) => v.length > 0),
					)
				: {},
		resumeIdleTimeoutMs: positiveOr(
			raw.resumeIdleTimeoutMs,
			RESUME_IDLE_TIMEOUT_MS,
		),
		stuckWatchdogMs: positiveOr(raw.stuckWatchdogMs, STUCK_WATCHDOG_MS),
		compactionWatchdogMs: positiveOr(
			raw.compactionWatchdogMs,
			COMPACTION_WATCHDOG_MS,
		),
	};
}

function loadConfig(): RuntimeConfig {
	ensureDefaultConfig();
	try {
		return normalizeConfig(
			JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as ProviderFailoverConfig,
		);
	} catch {
		return normalizeConfig(DEFAULT_CONFIG);
	}
}

function loadState(): ProviderFailoverState {
	try {
		if (!existsSync(STATE_PATH)) return { stateVersion: STATE_VERSION };
		const state = JSON.parse(
			readFileSync(STATE_PATH, "utf8"),
		) as ProviderFailoverState;
		if (state.stateVersion !== STATE_VERSION) {
			if (state.stateVersion === 4) {
				const migrated: ProviderFailoverState = {
					...state,
					stateVersion: STATE_VERSION,
					exhaustedUntilByModel: {},
				};
				saveState(migrated);
				return migrated;
			}
			// v3 could turn one physical 401 into three failures (response/message/agent hooks)
			// and then persist a one-year invalidation. Keep only plausible quota cooldowns;
			// discard invalidations and pending work produced by that broken state machine.
			const now = Date.now();
			const plausibleCooldowns = Object.fromEntries(
				Object.entries(state.exhaustedUntilByProvider ?? {}).filter(
					([, until]) =>
						Number.isFinite(until) &&
						until > now &&
						until <= now + MAX_MIGRATED_COOLDOWN_MS,
				),
			);
			const migrated: ProviderFailoverState = {
				stateVersion: STATE_VERSION,
				exhaustedUntilByProvider: plausibleCooldowns,
				exhaustedUntilByModel: {},
				lastProbeAtByProvider: state.lastProbeAtByProvider ?? {},
				invalidatedByProvider: {},
				lastSwitches: state.lastSwitches ?? [],
				// A version bump must not forget which model the user was actually on.
				lastUserModel: state.lastUserModel,
				lastUserThinkingLevel: state.lastUserThinkingLevel,
				lastModelByFamily: state.lastModelByFamily,
			};
			saveState(migrated);
			return migrated;
		}
		return state;
	} catch {
		return { stateVersion: STATE_VERSION };
	}
}

function saveState(state: ProviderFailoverState) {
	// Best-effort: a locked/read-only/full disk must never crash the host. Losing a
	// state write only costs a cooldown estimate that is re-derived on the next error.
	try {
		mkdirSync(dirname(STATE_PATH), { recursive: true, mode: 0o700 });
		// Atomic: a crash mid-write (the EPIPE exit already cost us lastUserModel once)
		// must leave the PREVIOUS complete file, not a truncated JSON the next process
		// discards wholesale.
		const tmp = `${STATE_PATH}.tmp`;
		writeFileSync(
			tmp,
			`${JSON.stringify({ stateVersion: STATE_VERSION, ...state }, null, "\t")}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
		renameSync(tmp, STATE_PATH);
	} catch {
		/* persistence is non-critical; in-memory state remains correct */
	}
}

// ---------------------------------------------------------------------------
// "Black box" decision log — structured, append-only, credential-free, bounded.
// ---------------------------------------------------------------------------

// Set from the extension closure once config is known. Module-level so the writer
// (a plain function) can be called from anywhere without threading config through.
let debugLogEnabled = false;
const DEBUG_TOKENISH =
	/(sk-[\w-]{8,}|ey[A-Za-z0-9._-]{12,}|Bearer\s+\S+|[A-Za-z0-9_-]{40,})/g;

// Redact anything that smells like a token/JWT/api key so the log is always safe to
// share. We never deliberately log credentials, but error strings from providers can
// occasionally embed one; this is the belt-and-braces guarantee.
function redactForLog(text: string): string {
	return text.replace(DEBUG_TOKENISH, "«redacted»");
}

function rotateDebugLogIfNeeded() {
	try {
		const size = statSync(DEBUG_LOG_PATH).size;
		if (size >= DEBUG_LOG_MAX_BYTES) {
			renameSync(DEBUG_LOG_PATH, `${DEBUG_LOG_PATH}.1`); // keep exactly one previous file
		}
	} catch {
		/* no file yet, or rotation failed — non-fatal */
	}
}

// Append one structured event. Best-effort and utterly silent on failure: logging must
// NEVER affect failover behaviour or crash the host. `data` should already be free of
// secrets; string fields are still redacted defensively.
function logEvent(kind: string, data: Record<string, unknown> = {}) {
	if (!debugLogEnabled) return;
	try {
		const safe: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(data)) {
			safe[k] = typeof v === "string" ? redactForLog(v).slice(0, 300) : v;
		}
		const line = `${JSON.stringify({ t: new Date().toISOString(), kind, ...safe })}\n`;
		rotateDebugLogIfNeeded();
		mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true, mode: 0o700 });
		appendFileSync(DEBUG_LOG_PATH, line, { encoding: "utf8", mode: 0o600 });
	} catch {
		/* diagnostics are best-effort; never throw */
	}
}

function readDebugLogTail(maxLines: number): string {
	try {
		const raw = readFileSync(DEBUG_LOG_PATH, "utf8");
		const lines = raw.split("\n").filter((l) => l.trim().length > 0);
		return lines.slice(-maxLines).join("\n");
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------
// auth.json reading, account identity & token validity
// ---------------------------------------------------------------------------

type AuthEntry = {
	type?: string;
	access?: string;
	refresh?: string;
	expires?: number;
	key?: string;
	accountId?: string;
};

function readAuthFileRaw(): Record<string, AuthEntry> {
	try {
		return JSON.parse(readFileSync(AUTH_PATH, "utf8")) as Record<
			string,
			AuthEntry
		>;
	} catch {
		return {};
	}
}

function readProxyOAuthSidecar(): Record<string, AuthEntry> {
	try {
		return JSON.parse(readFileSync(PROXY_OAUTH_PATH, "utf8")) as Record<
			string,
			AuthEntry
		>;
	} catch {
		return {};
	}
}

function writeProxyOAuthSidecar(data: Record<string, AuthEntry>): void {
	const tmp = `${PROXY_OAUTH_PATH}.multi-account.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, "\t")}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	renameSync(tmp, PROXY_OAUTH_PATH);
}

/**
 * Parent-facing credentials. While the child proxy is up, numbered OAuth slots are stored as
 * a placeholder in auth.json so a bare child can authenticate; the real blob lives in the sidecar.
 */
function readAuthFile(): Record<string, AuthEntry> {
	return mergeParentAuth(readAuthFileRaw(), readProxyOAuthSidecar()) as Record<
		string,
		AuthEntry
	>;
}

function persistChildFacingAuth(
	auth: Record<string, AuthBlob>,
	sidecar: Record<string, AuthBlob>,
): void {
	writeAuthFile(auth as Record<string, AuthEntry>);
	writeProxyOAuthSidecar(sidecar as Record<string, AuthEntry>);
}

/** Atomic replace of auth.json, so a crash mid-write can never truncate credentials. */
function writeAuthFile(data: Record<string, AuthEntry>): void {
	const tmp = `${AUTH_PATH}.multi-account.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, "\t")}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	renameSync(tmp, AUTH_PATH);
}

function authFileIsWritable(): boolean {
	try {
		accessSync(AUTH_PATH, fsConstants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Can a refreshed credential be written back AT ALL?
 *
 * This must be answered BEFORE the network refresh, never after. Anthropic rotates the
 * refresh token on every refresh call and revokes the old one immediately, so a refresh
 * we cannot persist does not "fail" — it DESTROYS the account's credential and throws the
 * replacement away. That is exactly what happened on pi 0.84.x, whose `AuthStorage` dropped
 * the `set()` method this extension used to persist with: the post-refresh guard tripped
 * every time, and the user lost their Claude login roughly once a day.
 */
export function canPersistRefreshedCredentials(
	authStorage: any,
	authWritable: () => boolean = authFileIsWritable,
): boolean {
	return (
		typeof authStorage?.modify === "function" ||
		typeof authStorage?.set === "function" ||
		authWritable()
	);
}

/**
 * Write a refreshed OAuth credential back, through whichever path this host actually offers.
 *
 * `modify` is the locked, supported API in current pi and is tried first. `set` covers older
 * hosts (and the test harness). The direct auth.json write is the last resort that exists
 * only so a token we already rotated is never dropped on the floor — losing it means a
 * forced re-login, which is the failure this whole function exists to prevent.
 */
export async function persistRefreshedCredentials(
	authStorage: any,
	provider: string,
	credential: Record<string, unknown>,
	io?: {
		read?: () => Record<string, any>;
		write?: (data: Record<string, any>) => void;
	},
): Promise<boolean> {
	if (typeof authStorage?.modify === "function") {
		try {
			await authStorage.modify(provider, () => credential);
			return true;
		} catch {
			// Locked or read-only storage — fall through to the remaining paths.
		}
	}
	if (typeof authStorage?.set === "function") {
		try {
			authStorage.set(provider, credential);
			return true;
		} catch {
			// Same.
		}
	}
	try {
		// Child-facing auth.json, not the parent merge: spreading the merged view would dump
		// sidecar OAuth onto every numbered slot a child still has to see as a placeholder.
		const read = io?.read ?? readAuthFileRaw;
		const write = io?.write ?? writeAuthFile;
		write({ ...read(), [provider]: credential });
		return true;
	} catch {
		return false;
	}
}

function authMtimeMs(): number {
	try {
		return statSync(AUTH_PATH).mtimeMs;
	} catch {
		return 0;
	}
}

function decodeJwtPayload(token: string): any | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		let payload = parts[1].replaceAll("-", "+").replaceAll("_", "/");
		payload += "=".repeat((4 - (payload.length % 4)) % 4);
		return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
	} catch {
		return undefined;
	}
}

function jwtExpMs(token: string): number | undefined {
	const exp = decodeJwtPayload(token)?.exp;
	return typeof exp === "number" && Number.isFinite(exp)
		? exp * 1000
		: undefined;
}

function getCursorSubFromAccessToken(token: string): string | undefined {
	const sub = decodeJwtPayload(token)?.sub;
	return typeof sub === "string" && sub.length > 0 ? sub : undefined;
}

function getCodexAccountIdFromAccessToken(token: string): string | undefined {
	return decodeJwtPayload(token)?.["https://api.openai.com/auth"]
		?.chatgpt_account_id as string | undefined;
}

function getCodexAccountUserIdFromAccessToken(token: string): string | undefined {
	const accountUserId = decodeJwtPayload(token)?.["https://api.openai.com/auth"]
		?.chatgpt_account_user_id;
	return typeof accountUserId === "string" && accountUserId.length > 0
		? accountUserId
		: undefined;
}

function getCodexUserIdFromAccessToken(token: string): string | undefined {
	const userId = decodeJwtPayload(token)?.["https://api.openai.com/auth"]
		?.chatgpt_user_id;
	return typeof userId === "string" && userId.length > 0 ? userId : undefined;
}

function hash12(input: string) {
	return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

/** A stable fingerprint of the current credential, used to detect re-login. */
function credentialHash(entry: AuthEntry): string | undefined {
	const secret = entry.access ?? entry.key;
	return secret ? hash12(secret) : undefined;
}

/** Stable identity of one user's membership in one selected ChatGPT workspace. */
function codexWorkspaceMembershipIdentity(entry: AuthEntry): string | undefined {
	if (!entry.access) return undefined;
	// Current live access tokens expose this account-scoped membership claim. Prefer it because a
	// single ChatGPT user may belong to several workspaces with separate quota and entitlements.
	const accountUserId = getCodexAccountUserIdFromAccessToken(entry.access);
	if (accountUserId) return `codex-membership:${hash12(accountUserId)}`;
	// OpenAI Codex documents chatgpt_user_id and chatgpt_account_id. Older tokens that omit the
	// account-scoped claim remain distinguishable by the composite, without collapsing two users
	// in one workspace or two workspaces belonging to one user.
	const userId = getCodexUserIdFromAccessToken(entry.access);
	const workspaceId =
		getCodexAccountIdFromAccessToken(entry.access) ??
		(typeof entry.accountId === "string" && entry.accountId.length > 0
			? entry.accountId
			: undefined);
	if (userId && workspaceId)
		return `codex-user-workspace:${hash12(`${userId}\0${workspaceId}`)}`;
	if (userId) return `codex-user:${hash12(userId)}`;
	return undefined;
}

/**
 * Identity of the REAL underlying account, used to detect the same account logged into multiple
 * slots. Deterministic where the data allows it:
 *   - `chatgpt_account_user_id` embedded in a Codex JWT → user membership within a workspace.
 *   - else documented `chatgpt_user_id` + workspace id → the same membership identity.
 *   - else `accountId` stored in auth.json / embedded in the JWT (legacy Codex fallback).
 *   - else a hash of the API key (same key = same account).
 *   - else a hash of the opaque access token. Opaque OAuth tokens (Anthropic) change on every login,
 *     so this only catches the literal same-token case. Two separate logins of the same Anthropic
 *     account are not deterministically identifiable from auth.json alone.
 */
function accountIdentity(entry: AuthEntry): string | undefined {
	const codexMembership = codexWorkspaceMembershipIdentity(entry);
	if (codexMembership) return codexMembership;
	if (typeof entry.accountId === "string" && entry.accountId.length > 0)
		return `acct:${hash12(entry.accountId)}`;
	if (entry.access) {
		const codexId = getCodexAccountIdFromAccessToken(entry.access);
		if (codexId) return `codex:${hash12(codexId)}`;
		const cursorSub = getCursorSubFromAccessToken(entry.access);
		if (cursorSub) return `cursor:${hash12(cursorSub)}`;
		return `tok:${hash12(entry.access)}`;
	}
	if (entry.key) return `key:${hash12(entry.key)}`;
	return undefined;
}

/**
 * A fingerprint that SURVIVES routine OAuth access-token refreshes and changes only when the
 * slot is genuinely re-logged into a DIFFERENT real account. Used to decide whether a recorded
 * cooldown still applies after auth.json changes. Unlike {@link accountIdentity}, it never falls
 * back to the volatile access token: when auth.json carries no stable signal (opaque OAuth tokens,
 * e.g. Anthropic) it returns undefined, so we keep the cooldown. A server-side rate limit is not
 * lifted by rotating a token anyway, so erring toward "keep the cooldown" is correct.
 */
function stableAccountFingerprint(entry: AuthEntry): string | undefined {
	const codexMembership = codexWorkspaceMembershipIdentity(entry);
	if (codexMembership) return codexMembership;
	if (typeof entry.accountId === "string" && entry.accountId.length > 0)
		return `acct:${hash12(entry.accountId)}`;
	if (entry.access) {
		const codexId = getCodexAccountIdFromAccessToken(entry.access);
		if (codexId) return `codex:${hash12(codexId)}`;
	}
	if (entry.key) return `key:${hash12(entry.key)}`;
	return undefined;
}

function rejectDuplicateLogin<T extends AuthEntry>(
	providerId: string,
	credentials: T,
): T {
	const identity = accountIdentity(credentials);
	if (!identity) return credentials;
	const duplicate = Object.entries(readAuthFile()).find(
		([existingId, entry]) =>
			existingId !== providerId && accountIdentity(entry) === identity,
	);
	if (duplicate) {
		throw new Error(
			`This real account is already logged in as "${duplicate[0]}". Use that slot, or log it out before replacing it.`,
		);
	}
	return credentials;
}

/** True when the credential is present and not provably dead. */
function isEntryUsable(entry: AuthEntry | undefined): boolean {
	if (!entry) return false;
	if (entry.type === "api_key" || entry.key)
		return typeof entry.key === "string" && entry.key.length > 0;
	if (typeof entry.access !== "string" || entry.access.length === 0)
		return false;
	// Expired access token with no refresh token → unrecoverable.
	const storedExpiry =
		typeof entry.expires === "number" && Number.isFinite(entry.expires)
			? entry.expires < 10_000_000_000
				? entry.expires * 1000
				: entry.expires
			: undefined;
	const expMs = jwtExpMs(entry.access) ?? storedExpiry;
	if (
		expMs !== undefined &&
		expMs <= Date.now() &&
		!(typeof entry.refresh === "string" && entry.refresh.length > 0)
	) {
		return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Provider id helpers
// ---------------------------------------------------------------------------

const FAMILY_KEYWORDS = new Set([
	"anthropic",
	"claude",
	"codex",
	"openai",
	"cursor",
	"ollama",
	"qwen",
	"alibaba",
]);

function parseFamilyArg(raw: string | undefined): ProviderFamily | undefined {
	const familyRaw = (raw || "").toLowerCase();
	if (familyRaw === "codex" || familyRaw === "openai") return "openai-codex";
	if (familyRaw === "anthropic" || familyRaw === "claude") return "anthropic";
	if (familyRaw === "ollama") return "ollama";
	if (familyRaw === "qwen" || familyRaw === "alibaba") return "qwen";
	if (familyRaw === "cursor") return "cursor";
	if (familyRaw === "kimi" || familyRaw === "kimi-coding") return "kimi-coding";
	return undefined;
}

function isFamilyKeyword(raw: string): boolean {
	return FAMILY_KEYWORDS.has(raw.trim().toLowerCase());
}

function resolveRemoveTarget(
	arg: string,
	auth: Record<string, AuthEntry>,
	qwenProvider: string,
): string | undefined {
	const trimmed = arg.trim();
	if (!trimmed) return undefined;

	if (/-account-\d+$/.test(trimmed) || isCursorProviderId(trimmed)) {
		return auth[trimmed] && classifyProvider(trimmed, qwenProvider)
			? trimmed
			: undefined;
	}

	const parsed = parseTarget(trimmed);
	const exactId = parsed?.provider ?? trimmed;
	if (!isFamilyKeyword(trimmed)) {
		return auth[exactId] && classifyProvider(exactId, qwenProvider)
			? exactId
			: undefined;
	}

	const family = parseFamilyArg(trimmed);
	if (!family) return undefined;

	const aliases = Object.keys(auth)
		.filter(
			(id) =>
				classifyProvider(id, qwenProvider) === family && slotIndex(id) >= 2,
		)
		.sort((a, b) => slotIndex(b) - slotIndex(a));
	if (aliases.length > 0) return aliases[0];

	const baseId = slotId(family, 1, qwenProvider);
	return auth[baseId] ? baseId : undefined;
}

function classifyProvider(
	id: string,
	qwenProvider: string,
): ProviderFamily | undefined {
	if (id === ANTHROPIC_BASE || /^anthropic-account-\d+$/.test(id))
		return "anthropic";
	if (id === CODEX_BASE || /^openai-codex-account-\d+$/.test(id))
		return "openai-codex";
	if (
		id === qwenProvider ||
		new RegExp(`^${escapeRegex(qwenProvider)}-account-\\d+$`).test(id) ||
		/^qwen/i.test(id)
	)
		return "qwen";
	if (
		id === OLLAMA_BASE ||
		/^ollama-account-\d+$/.test(id) ||
		/^ollama/i.test(id)
	)
		return "ollama";
	if (isCursorProviderId(id)) return "cursor";
	if (id === "kimi-coding" || /^kimi-coding-account-\d+$/.test(id))
		return "kimi-coding";
	return undefined;
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slotIndex(id: string): number {
	const m = id.match(/-account-(\d+)$/);
	return m ? Number(m[1]) : 1; // base provider counts as slot 1
}

function slotId(
	family: ProviderFamily,
	index: number,
	qwenProvider: string = DEFAULT_QWEN_PROVIDER,
): string {
	const base =
		family === "anthropic"
			? ANTHROPIC_BASE
			: family === "openai-codex"
				? CODEX_BASE
				: family === "kimi-coding"
					? "kimi-coding"
					: family === "qwen"
						? qwenProvider
						: family === "cursor"
							? CURSOR_BASE
							: OLLAMA_BASE;
	return index <= 1 ? base : `${base}-account-${index}`;
}

function ref(provider: string, modelId: string): ModelRef {
	return `${provider}/${modelId}` as ModelRef;
}

function parseTarget(
	target: unknown,
): { provider: string; modelId?: string } | undefined {
	if (typeof target !== "string") return undefined;
	const trimmed = target.trim();
	if (!trimmed) return undefined;
	const slash = trimmed.indexOf("/");
	if (slash === -1) return { provider: trimmed };
	const provider = trimmed.slice(0, slash).trim();
	const modelId = trimmed.slice(slash + 1).trim();
	if (!provider || !modelId) return undefined;
	return { provider, modelId };
}

/** Effort suffixes some catalogs bake into the model id. Thinking is a session setting. */
const MODEL_IDENTITY_EFFORTS = new Set([
	"none",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"minimal",
]);

/**
 * Compare models the way a person does: `cursor-grok-4.6-high` is the same model as
 * `cursor-grok-4.6` / `grok-4.6` at a different thinking effort, not a different model.
 */
export function modelIdentityKey(modelId: string): string {
	let id = modelId.trim().toLowerCase();
	if (id.endsWith("-fast")) id = id.slice(0, -5);
	if (id.endsWith("-thinking")) id = id.slice(0, -9);
	const dash = id.lastIndexOf("-");
	if (dash >= 0 && MODEL_IDENTITY_EFFORTS.has(id.slice(dash + 1))) {
		id = id.slice(0, dash);
	}
	if (id.startsWith("cursor-")) id = id.slice("cursor-".length);
	return id;
}

export function sameModelIdentity(
	a: string | undefined,
	b: string | undefined,
): boolean {
	if (!a || !b) return false;
	return a === b || modelIdentityKey(a) === modelIdentityKey(b);
}

type ModelQualityBand = "frontier" | "balanced" | "fast";

/**
 * Coarse cross-provider quality bands used only to prevent an automatic downgrade.
 *
 * Provider names are intentionally mapped by product tier rather than generation: Sol ↔ Opus,
 * Terra ↔ Sonnet, and Luna ↔ Haiku. Unknown models stay unclassified; an explicit `switch` may
 * still select them, but automatic failover and `next` will not pretend that an unknown model is
 * equivalent to a known tier.
 */
export function modelQualityBand(modelId: string | undefined): ModelQualityBand | undefined {
	if (!modelId) return undefined;
	// Do not use modelIdentityKey here: a trailing `-max` is an effort suffix for some Cursor
	// aliases, but it is the actual product tier in `qwen-max`.
	const id = modelId.trim().toLowerCase().replace(/^cursor-/, "");
	if (/(^|[-/:])(luna|haiku|mini|spark|flash|nano|lite)([-/:]|$)/i.test(id))
		return "fast";
	if (/(^|[-/:])(terra|sonnet|jamba)([-/:]|$)/i.test(id))
		return "balanced";
	if (
		/(^|[-/:])(sol|opus)([-/:]|$)/i.test(id) ||
		/(^|[-/:])composer(?:[-/:]|$)/i.test(id) ||
		/^gpt-5(?:\.\d+)?$/i.test(id) ||
		/(^|[-/:])(?:k3|kimi-k3|grok-4\.6|minimax-m2\.7)([-/:]|$)/i.test(id) ||
		/^glm-5(?:[.:-]|$)/i.test(id) ||
		/qwen.*max/i.test(id)
	)
		return "frontier";
	return undefined;
}

/** Family when we know one; otherwise the un-numbered provider id (`zai` from `zai-account-2`). */
function accountGroup(id: string, qwenProvider: string): string {
	return classifyProvider(id, qwenProvider) ?? id.replace(/-account-\d+$/, "");
}

// ---------------------------------------------------------------------------
// Model definitions for registered alias providers
// ---------------------------------------------------------------------------

function anthropicModelDef(id: string, providerId: string) {
	const canonical = piAiGetModel("anthropic", id) as any;
	if (canonical) return { ...canonical, provider: providerId };
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: providerId,
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	};
}

function codexModelDef(id: string) {
	return (
		CODEX_MODEL_DEFS[id] ?? {
			id,
			name: id,
			reasoning: true,
			thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
			input: ["text", "image"],
			contextWindow: 272000,
			maxTokens: 128000,
		}
	);
}

/**
 * Merge a freshly refreshed OAuth credential back onto the stored one. Spreading `...refreshed` is
 * the whole point: it carries the NEW access token (and expiry) onto the credential Pi uses next.
 * Dropping it — keeping only the old access — makes every post-refresh call reuse an expired token
 * and 401 forever, which is how an alias slot got its tokens silently discarded and was then wrongly
 * killed by the consecutive-401 guard. `refresh` is preserved when the provider mints no new refresh
 * token. Exported for unit testing so the two refresh paths can never silently diverge again.
 */
export function mergeRefreshedCredentials(credentials: any, refreshed: any) {
	return {
		...credentials,
		...refreshed,
		refresh:
			typeof refreshed?.refresh === "string" &&
			refreshed.refresh.trim().length > 0
				? refreshed.refresh
				: credentials.refresh,
	};
}

/**
 * Refresh an OAuth credential, and survive losing a race for it.
 *
 * Anthropic rotates the refresh token on every use and kills the old one the moment the new one
 * is issued. So any second holder of that credential — another Pi window, a background usage
 * probe that read the file a second earlier, a `/login` in a neighbouring session — presents a
 * token that was valid when it was read and is already dead when it arrives. The server answers
 * `invalid_grant`, which reads identically to a genuinely revoked account, and the slot was
 * dropped from the rotation with a demand to re-login that fixed nothing: the working token had
 * been on disk the whole time, written by whoever won the race.
 *
 * So on `invalid_grant` — and only on `invalid_grant` — we re-read what is stored now and try
 * once more. If disk holds the same token that just failed there is nothing new to send, and the
 * account really is revoked: fail immediately so rotation moves on. Any other error (a timeout, a
 * 5xx) is not a statement about the token and is never retried, since burning the disk token on a
 * network blip would turn an outage into a lost account.
 *
 * Exported for tests: this is the one piece of logic that decides whether an account survives.
 */
export async function refreshWithDiskRetry(opts: {
	credentials: any;
	refresh: (credentials: any) => Promise<any>;
	storedRefresh: () => string | undefined;
}): Promise<any> {
	try {
		return await opts.refresh(opts.credentials);
	} catch (error) {
		if (!/invalid_grant/i.test(String((error as any)?.message ?? error))) throw error;
		const stored = opts.storedRefresh();
		if (!stored || stored === opts.credentials?.refresh) throw error;
		return await opts.refresh({ ...opts.credentials, refresh: stored });
	}
}

/** The refresh token currently stored on disk for a slot — whoever wrote it last wins. */
function storedRefreshToken(providerId: string): string | undefined {
	const stored = readAuthFile()[providerId] as any;
	return typeof stored?.refresh === "string" && stored.refresh.trim()
		? stored.refresh
		: undefined;
}

/** Single source of truth for Anthropic OAuth refresh — used by BOTH the base provider and aliases. */
function oauthRefreshSignal(signal?: AbortSignal): AbortSignal {
	return signal instanceof AbortSignal ? signal : AbortSignal.timeout(30_000);
}

async function refreshAnthropicCredentials(
	credentials: any,
	signal?: AbortSignal,
	providerId?: string,
) {
	const attempt = (creds: any) =>
		requirePiAiOauth().anthropic.refresh(creds, oauthRefreshSignal(signal));
	// Without a slot id there is nothing on disk to consult, so this degrades to a plain refresh.
	if (!providerId)
		return mergeRefreshedCredentials(credentials, await attempt(credentials));
	const refreshed = await refreshWithDiskRetry({
		credentials,
		refresh: attempt,
		storedRefresh: () => storedRefreshToken(providerId),
	});
	return mergeRefreshedCredentials(credentials, refreshed);
}

/** Bind the refresher to the slot it belongs to, so a lost race can be recovered from disk. */
function anthropicRefresherFor(providerId: string) {
	return (credentials: any, signal?: AbortSignal) =>
		refreshAnthropicCredentials(credentials, signal, providerId);
}

function registerAnthropicSlot(
	pi: ExtensionAPI,
	id: string,
	modelIds: string[] = DEFAULT_ANTHROPIC_MODELS,
	baseUrl = "https://api.anthropic.com",
) {
	if (id === ANTHROPIC_BASE) return; // base provider: oauth + shaping registered in piMultiAccount()
	const models = modelIds.map((m) => anthropicModelDef(m, id));
	pi.registerProvider(id, {
		name: `Claude Pro/Max (${id})`,
		baseUrl,
		api: "anthropic-messages" as any,
		oauth: {
			name: `Claude Pro/Max (${id})`,
			async login(callbacks: any) {
				return rejectDuplicateLogin(
					id,
					await requirePiAiOauth().anthropic.login(callbacks),
				);
			},
			refreshToken: anthropicRefresherFor(id),
			getApiKey: (credentials: any) => credentials.access,
		},
		models: models as any,
	});
}

function codexOAuthOverride(providerId: string, name: string) {
	const getProvider = () => requirePiAiOauth().codex;
	return {
		name,
		// Read-only flag: Pi reads it while merely LISTING providers, long before any
		// login. It must never throw — an unresolvable pi-ai here is what used to blow
		// up the whole extension load. `true` mirrors pi-ai's own Codex provider, and an
		// actual login attempt still fails loudly with an actionable message.
		get usesCallbackServer() {
			return tryLoadPiAiOauth()?.codex.usesCallbackServer ?? true;
		},
		async login(callbacks: any) {
			return rejectDuplicateLogin(providerId, await getProvider().login(callbacks));
		},
		async refreshToken(credentials: any, signal?: AbortSignal) {
			return getProvider().refresh(credentials, oauthRefreshSignal(signal));
		},
		getApiKey(credentials: any) {
			return getProvider().getApiKey(credentials);
		},
	};
}

function registerCodexSlot(
	pi: ExtensionAPI,
	id: string,
	models: Array<Record<string, unknown>> = DEFAULT_CODEX_MODELS.map(codexModelDef),
	baseUrl = "https://chatgpt.com/backend-api",
) {
	if (id === CODEX_BASE) return; // base provider is native until live catalog sync enriches it
	pi.registerProvider(id, {
		name: `ChatGPT Plus/Pro (Codex ${id})`,
		baseUrl,
		api: "openai-codex-responses" as any,
		oauth: codexOAuthOverride(id, `ChatGPT Plus/Pro (Codex ${id})`),
		models: models as any,
	});
}

/** Replace one Codex provider's model list while preserving its OAuth behavior. */
function registerCodexCatalog(
	pi: ExtensionAPI,
	id: string,
	models: Array<Record<string, unknown>>,
	baseUrl = "https://chatgpt.com/backend-api",
) {
	const name =
		id === CODEX_BASE
			? "ChatGPT Plus/Pro (Codex)"
			: `ChatGPT Plus/Pro (Codex ${id})`;
	pi.registerProvider(id, {
		name,
		baseUrl,
		api: "openai-codex-responses" as any,
		oauth: codexOAuthOverride(id, name),
		models: models as any,
	});
}

// ----- Kimi For Coding (subscription, device-flow OAuth) ---------------------

const KIMI_BASE = "kimi-coding";
const KIMI_BASE_URL = "https://api.kimi.com/coding";
// Mirrors pi-ai's bundled kimi-coding catalog; piAiGetModel() enriches each entry
// with canonical metadata when the installed pi-ai is new enough to have it.
const DEFAULT_KIMI_MODELS = [
	"k3",
	"k3-256k",
	"kimi-for-coding",
	"kimi-for-coding-highspeed",
];

function kimiModelDef(id: string, providerId: string) {
	const canonical = piAiGetModel(KIMI_BASE, id) as any;
	if (canonical) return { ...canonical, provider: providerId };
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: providerId,
		baseUrl: KIMI_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 32768,
	};
}

function kimiOAuthOverride(providerId: string, name: string) {
	// kimi exists only in pi-ai's provider-factories era, so the bridge field is
	// optional — resolve it lazily and fail loudly only on a real login attempt,
	// never while Pi is merely listing providers.
	const getProvider = () => {
		const kimi = requirePiAiOauth().kimi;
		if (!kimi) {
			throw new Error(
				"pi-multi-account: this @earendil-works/pi-ai exposes no Kimi OAuth flow; upgrade pi-ai to log Kimi slots in via subscription.",
			);
		}
		return kimi;
	};
	return {
		name,
		isSubscription: true,
		async login(callbacks: any) {
			return rejectDuplicateLogin(providerId, await getProvider().login(callbacks));
		},
		async refreshToken(credentials: any, signal?: AbortSignal) {
			return getProvider().refresh(credentials, oauthRefreshSignal(signal));
		},
		getApiKey(credentials: any) {
			return credentials.access;
		},
	};
}

function registerKimiSlot(
	pi: ExtensionAPI,
	id: string,
	modelIds: string[] = DEFAULT_KIMI_MODELS,
) {
	if (id === KIMI_BASE) return; // base provider is native to Pi (pi-ai ships it)
	pi.registerProvider(id, {
		name: `Kimi For Coding (${id})`,
		baseUrl: KIMI_BASE_URL,
		api: "anthropic-messages" as any,
		oauth: kimiOAuthOverride(id, `Kimi For Coding (${id})`),
		models: modelIds.map((m) => kimiModelDef(m, id)) as any,
	});
}

// Base URLs and model lists for API-key provider families that support multiple
// accounts (each account = a separate API key in a numbered slot).
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const OLLAMA_CLOUD_BASE_URL = "https://ollama.com/v1";

// Ollama Cloud accepts both the canonical bare id (`kimi-k3`, `glm-5.2`) returned by
// /v1/models and the legacy `:cloud`-suffixed form, so the suffix is display-only now.
// Every managed Ollama provider (base + cloned slots) is registered against the Cloud
// endpoint, so all of its models route there regardless of suffix.
function isOllamaCloudModel(modelId: string): boolean {
	return modelId.includes(":cloud");
}
const OLLAMA_MODEL_DEFS: Record<string, Record<string, unknown>> = {
	"glm-5.2:cloud": {
		id: "glm-5.2:cloud",
		name: "GLM-5.2 (Ollama Cloud)",
		contextWindow: 1000000,
		maxTokens: 32768,
		input: ["text"],
		cost: ZERO_COST,
		reasoning: true,
	},
};
function ollamaModelDef(id: string, providerId: string) {
	const def = OLLAMA_MODEL_DEFS[id] ?? {
		id,
		name: id,
		contextWindow: 1000000,
		maxTokens: 32768,
		input: ["text"],
		cost: ZERO_COST,
		reasoning: true,
	};
	return { ...def, provider: providerId, baseUrl: OLLAMA_CLOUD_BASE_URL };
}

// Alibaba Model Studio (Qwen), OpenAI-compatible International endpoint. The old default pointed at
// a `token-plan.*.maas.aliyuncs.com` promo endpoint that ACCEPTS the key on /models but returns
// 401 invalid_api_key on /chat/completions once the token plan lapses — so a perfectly valid Qwen
// key looked "invalid" and the account was wrongly dropped from rotation. Verified with a live
// request: the same key 200s on dashscope-intl for completions.
const QWEN_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const QWEN_MODEL_DEFS: Record<string, Record<string, unknown>> = {
	"qwen3.8-max": {
		id: "qwen3.8-max",
		name: "Qwen3.8 Max",
		contextWindow: 1000000,
		maxTokens: 65536,
		input: ["text"],
		cost: ZERO_COST,
		reasoning: true,
		thinkingLevelMap: {
			high: "high",
			low: null,
			medium: null,
			minimal: null,
			xhigh: "max",
		},
	},
	"qwen-max": {
		id: "qwen-max",
		name: "Qwen Max",
		contextWindow: 1000000,
		maxTokens: 8192,
		input: ["text"],
		cost: ZERO_COST,
		reasoning: true,
	},
	"qwen-plus": {
		id: "qwen-plus",
		name: "Qwen Plus",
		contextWindow: 1000000,
		maxTokens: 8192,
		input: ["text"],
		cost: ZERO_COST,
		reasoning: true,
	},
};
function qwenModelDef(id: string, providerId: string) {
	const def = QWEN_MODEL_DEFS[id] ?? {
		id,
		name: id,
		contextWindow: 1000000,
		maxTokens: 8192,
		input: ["text"],
		cost: ZERO_COST,
		reasoning: true,
	};
	return { ...def, provider: providerId };
}

/**
 * Register an API-key provider slot (ollama-account-2, alibaba-account-3, ...).
 * Unlike OAuth slots, these never log in interactively — the user adds them by
 * placing a key in auth.json (type "api_key", key "sk-..."). Discovery then
 * picks the slot up exactly like a Codex/Anthropic alias.
 *
 * Pi requires every provider that defines models to also supply credentials —
 * either `oauth` or `apiKey`. For API-key slots we read the key from auth.json
 * at registration time and pass it straight through. If the key is missing
 * (slot added via `/multi-account add` but not yet filled), we skip model
 * registration so the slot stays dormant until the user adds a real key.
 */
/**
 * Model tags the HOST already knows for a provider, newest-first as Pi lists them.
 *
 * Anthropic and Codex were taught to learn their model lists from the host registry so a newly
 * released generation works with no release of this extension. Ollama and Qwen never were: their
 * slots carried a hardcoded array, so a user running six Ollama cloud tags could reach exactly the
 * one written down here. This closes that gap without inventing a strength ranking for arbitrary
 * tags — the built-in list still leads, so the known flagship stays the account's representative
 * and nothing is silently downgraded.
 */
function hostModelIdsFor(ctx: any, baseProvider: string): string[] {
	try {
		const all = ctx?.modelRegistry?.getAll?.() ?? [];
		return all
			.filter((model: any) => model?.provider === baseProvider && typeof model?.id === "string")
			.map((model: any) => model.id);
	} catch {
		return [];
	}
}

function registerApiKeySlot(
	pi: ExtensionAPI,
	id: string,
	family: "ollama" | "qwen",
	qwenBase: string = DEFAULT_QWEN_PROVIDER,
	ctx?: any,
) {
	// The qwen arm read OLLAMA_BASE too, so the "this IS the base provider" guard could never
	// fire for a qwen slot. Harmless while the value was only compared against; it decides which
	// provider's host models are inherited now, so it has to be the real base.
	const baseId = family === "ollama" ? OLLAMA_BASE : qwenBase;
	if (id === baseId) return;
	// Read the key from auth.json. No key → no models → Pi won't complain and
	// the slot simply won't be selectable until the user fills it in.
	const entry = readAuthFile()[id];
	const key =
		entry && typeof entry.key === "string" && entry.key.length > 0
			? entry.key
			: undefined;
	if (!key) return;
	const baseUrl = family === "ollama" ? OLLAMA_CLOUD_BASE_URL : QWEN_BASE_URL;
	const preferred =
		family === "ollama" ? DEFAULT_OLLAMA_MODELS : DEFAULT_QWEN_MODELS;
	// Built-in tags first (the flagship this extension knows), then everything the host has for
	// the base provider — so a tag the user configured, or one the provider shipped after this
	// release, is selectable instead of invisible.
	const ids = [...preferred];
	for (const hostId of hostModelIdsFor(ctx, baseId)) {
		if (!ids.includes(hostId)) ids.push(hostId);
	}
	const models = ids.map((m) =>
		family === "ollama" ? ollamaModelDef(m, id) : qwenModelDef(m, id),
	);
	pi.registerProvider(id, {
		name: `${family === "ollama" ? "Ollama" : "Alibaba/Qwen"} (${id})`,
		baseUrl,
		api: "openai-completions" as any,
		apiKey: key,
		// No oauth block → no interactive login, no refresh path.
		models: models as any,
	});
	return ids;
}

// ---------------------------------------------------------------------------
// Misc helpers (cooldown parsing from headers / error bodies)
// ---------------------------------------------------------------------------

function patternMatch(text: string, patterns: string[]) {
	const lower = text.toLowerCase();
	return patterns.some((p) => p && lower.includes(p.toLowerCase()));
}

function retryAfterToMs(value: string | undefined) {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0)
		return Math.ceil(seconds * 1000);
	const dateMs = Date.parse(value);
	if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
	return undefined;
}

function secondsToMs(value: string | undefined) {
	if (!value) return undefined;
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds >= 0
		? Math.ceil(seconds * 1000)
		: undefined;
}

function unixSecondsToCooldownMs(value: string | undefined) {
	if (!value) return undefined;
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds > 0
		? Math.max(0, seconds * 1000 - Date.now())
		: undefined;
}

function firstDefinedMs(values: Array<number | undefined>) {
	return values.find(
		(value): value is number =>
			value !== undefined && Number.isFinite(value) && value >= 0,
	);
}

function percentValue(value: string | undefined) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : undefined;
}

function cooldownFromHeaders(headers: Record<string, string>) {
	const normalized = new Map(
		Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
	);
	const get = (name: string) => normalized.get(name.toLowerCase());
	const primaryUsed = percentValue(get("x-codex-primary-used-percent"));
	const secondaryUsed = percentValue(get("x-codex-secondary-used-percent"));
	const retryAfter = retryAfterToMs(get("retry-after"));
	const primaryReset = firstDefinedMs([
		secondsToMs(get("x-codex-primary-reset-after-seconds")),
		unixSecondsToCooldownMs(get("x-codex-primary-reset-at")),
	]);
	const secondaryReset = firstDefinedMs([
		secondsToMs(get("x-codex-secondary-reset-after-seconds")),
		unixSecondsToCooldownMs(get("x-codex-secondary-reset-at")),
	]);
	if ((secondaryUsed ?? 0) >= 100)
		return secondaryReset ?? retryAfter ?? primaryReset;
	if ((primaryUsed ?? 0) >= 100)
		return primaryReset ?? retryAfter ?? secondaryReset;
	return retryAfter ?? primaryReset ?? secondaryReset;
}

const RETRY_PHRASE =
	/\btry again in\s*~?\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|[smhd])\b/i;
const RETRY_UNIT_MS: Record<string, number> = {
	s: 1_000,
	sec: 1_000,
	secs: 1_000,
	second: 1_000,
	seconds: 1_000,
	m: 60_000,
	min: 60_000,
	mins: 60_000,
	minute: 60_000,
	minutes: 60_000,
	h: 3_600_000,
	hr: 3_600_000,
	hrs: 3_600_000,
	hour: 3_600_000,
	hours: 3_600_000,
	d: 86_400_000,
	day: 86_400_000,
	days: 86_400_000,
};

/**
 * Some providers state the recovery horizon in prose rather than in a header or JSON field —
 * Codex free-plan refusals read "You have hit your ChatGPT usage limit (free plan). Try again in
 * ~41615 min." Ignoring it threw away the single most direct statement the provider makes about
 * when the account comes back, leaving only a quota percentage that does not see that limit.
 * Still only a forecast, so callers cap it like any other.
 */
function retryPhraseMs(errorText: string): number | undefined {
	const match = errorText.match(RETRY_PHRASE);
	if (!match) return undefined;
	const value = Number(match[1]);
	const unit = RETRY_UNIT_MS[match[2].toLowerCase()];
	if (!Number.isFinite(value) || value <= 0 || !unit) return undefined;
	return Math.round(value * unit);
}

function cooldownFromErrorText(errorText: string) {
	const bodyReset = firstDefinedMs([
		secondsToMs(errorText.match(/"resets_in_seconds"\s*:\s*(\d+)/i)?.[1]),
		unixSecondsToCooldownMs(errorText.match(/"resets_at"\s*:\s*(\d+)/i)?.[1]),
	]);
	if (bodyReset !== undefined) return bodyReset;
	const primaryUsed = percentValue(
		errorText.match(/"X-Codex-Primary-Used-Percent"\s*:\s*"?(\d+)/i)?.[1],
	);
	const secondaryUsed = percentValue(
		errorText.match(/"X-Codex-Secondary-Used-Percent"\s*:\s*"?(\d+)/i)?.[1],
	);
	const primaryReset = firstDefinedMs([
		secondsToMs(
			errorText.match(
				/"X-Codex-Primary-Reset-After-Seconds"\s*:\s*"?(\d+)/i,
			)?.[1],
		),
		unixSecondsToCooldownMs(
			errorText.match(/"X-Codex-Primary-Reset-At"\s*:\s*"?(\d+)/i)?.[1],
		),
	]);
	const secondaryReset = firstDefinedMs([
		secondsToMs(
			errorText.match(
				/"X-Codex-Secondary-Reset-After-Seconds"\s*:\s*"?(\d+)/i,
			)?.[1],
		),
		unixSecondsToCooldownMs(
			errorText.match(/"X-Codex-Secondary-Reset-At"\s*:\s*"?(\d+)/i)?.[1],
		),
	]);
	// Structured fields always win; the prose horizon is the last resort, used only when the
	// provider gave us nothing machine-readable.
	const stated = retryPhraseMs(errorText);
	if ((secondaryUsed ?? 0) >= 100)
		return secondaryReset ?? primaryReset ?? stated;
	if ((primaryUsed ?? 0) >= 100) return primaryReset ?? secondaryReset ?? stated;
	return primaryReset ?? secondaryReset ?? stated;
}

/**
 * How long (ms) until the account behind this usage snapshot is actually usable again?
 *  - `0`         → no window is maxed out: the account is available right now.
 *  - `> 0`       → soonest reset among the maxed-out (>=100%) windows still in the future.
 *  - `undefined` → the snapshot carries no window data; the caller keeps its own estimate.
 *
 * This is the ground truth used to RECONCILE recorded cooldowns during a wait, so a session
 * resumes the moment an account truly recovers — not when a stale estimate happens to expire.
 */
function cooldownMsFromUsage(
	snapshot: UsageSnapshot,
	now = Date.now(),
): number | undefined {
	// Codex/Claude short windows can still have headroom while a longer rolling window is maxed.
	// Treat the account as available when the primary window is not exhausted.
	if (snapshot.primary && snapshot.primary.usedPercent < 100) return 0;

	const windows = [snapshot.primary, snapshot.secondary].filter(
		(w): w is UsageWindow => !!w,
	);
	if (windows.length === 0) return undefined;
	const blocking = windows.filter(
		(w) => w.usedPercent >= 100 && w.resetAt > now,
	);
	if (blocking.length === 0) return 0;
	return Math.min(...blocking.map((w) => w.resetAt)) - now;
}

function formatUntil(timestamp: number) {
	const ms = timestamp - Date.now();
	if (ms <= 0) return "expired";
	const minutes = Math.ceil(ms / 60000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** Human-readable wait duration: "45s", "12m", "2h 20m" — never the misleading hours-only ceil. */
function formatDelay(ms: number): string {
	if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`;
	const totalMinutes = Math.ceil(ms / 60_000);
	if (totalMinutes < 60) return `${totalMinutes}m`;
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

/** stopReason of the most recent assistant message — "aborted" means the user pressed Esc. */
function lastAssistantStopReason(messages: any[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant")
			return messages[i]?.stopReason as string | undefined;
	}
	return undefined;
}

// ===========================================================================
// Anthropic OAuth request shaping (vendored)
//
// Makes Claude Pro/Max (OAuth) accounts work out of the box — no separate
// pi-anthropic-auth install required. Ported from gotgenes/pi-anthropic-auth
// (MIT). The logic is idempotent: if pi-anthropic-auth is ALSO installed, both
// before_provider_request hooks run, but the second sees the request already
// shaped (billing header present, Pi preamble already replaced) and no-ops.
//
// CLAUDE_CODE_VERSION must track the current Claude Code release; if it drifts
// too far Anthropic may reject or miscount OAuth requests. Check `claude
// --version` or https://github.com/anthropics/claude-code.
// ===========================================================================

const PI_DEFAULT_PROMPT_PREFIX =
	"You are an expert coding assistant operating inside pi, a coding agent harness.";
const PI_DEFAULT_PROMPT_TERMINATOR =
	"- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)";
const MINIMAL_ANTHROPIC_OAUTH_PROMPT_PREFIX =
	"You are an expert coding assistant.";
const MINIMAL_ANTHROPIC_OAUTH_PROMPT = [
	MINIMAL_ANTHROPIC_OAUTH_PROMPT_PREFIX,
	"Be concise and helpful.",
	"Use the available tools to answer the user's request.",
	"Show file paths clearly when working with files.",
].join("\n");
const CLAUDE_CODE_IDENTITY_PREFIX =
	"You are Claude Code, Anthropic's official CLI";
const CLAUDE_CODE_VERSION = "2.1.259";
const BILLING_HEADER_SALT = "59cf53e54c78";
const BILLING_HEADER_POSITIONS = [4, 7, 20] as const;
const CLAUDE_CODE_ENTRYPOINT = "sdk-cli";
const PARAGRAPH_REMOVAL_ANCHORS: readonly string[] = [
	"operating inside pi, a coding agent harness",
	"In addition to the tools above",
	"Pi documentation (read only when the user asks about pi itself",
];
const TEXT_REPLACEMENTS: readonly { match: string; replacement: string }[] = [
	{
		match:
			"Here is some useful information about the environment you are running in:",
		replacement: "Environment context you are running in:",
	},
];

type ShapeTextBlock = { type: "text"; text: string; [key: string]: unknown };
type ShapeMessageBlock = {
	type?: string;
	text?: string;
	[key: string]: unknown;
};
type ShapeMessageParam = {
	role?: string;
	content?: string | ShapeMessageBlock[];
	[key: string]: unknown;
};
type ShapeAnthropicPayload = {
	model?: unknown;
	messages?: unknown;
	system?: unknown;
	stream?: unknown;
	[key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAnthropicMessagesPayload(
	payload: unknown,
): payload is ShapeAnthropicPayload {
	return (
		isRecord(payload) &&
		typeof payload.model === "string" &&
		Array.isArray(payload.messages) &&
		typeof payload.stream === "boolean"
	);
}

function hasOAuthAnthropicSystemMarker(block: unknown): boolean {
	if (
		!isRecord(block) ||
		block.type !== "text" ||
		typeof block.text !== "string"
	)
		return false;
	return (
		block.text.includes(CLAUDE_CODE_IDENTITY_PREFIX) ||
		block.text.includes("x-anthropic-billing-header:") ||
		block.text.startsWith(MINIMAL_ANTHROPIC_OAUTH_PROMPT_PREFIX)
	);
}

// Only requests that Pi already marked as OAuth (Claude Code identity block, or
// already-shaped) are touched — API-key Anthropic requests pass through untouched.
function isOAuthAnthropicPayload(payload: ShapeAnthropicPayload): boolean {
	if (!Array.isArray(payload.system)) return false;
	return payload.system.some(hasOAuthAnthropicSystemMarker);
}

function getFirstUserText(messages: ShapeMessageParam[]): string {
	const firstUserMessage = messages.find((message) => message.role === "user");
	if (!firstUserMessage) return "";
	if (typeof firstUserMessage.content === "string")
		return firstUserMessage.content;
	if (!Array.isArray(firstUserMessage.content)) return "";
	const firstTextBlock = firstUserMessage.content.find(
		(block) => block.type === "text" && typeof block.text === "string",
	);
	return typeof firstTextBlock?.text === "string" ? firstTextBlock.text : "";
}

function buildBillingHeaderValue(
	messages: ShapeMessageParam[],
): string | undefined {
	const messageText = getFirstUserText(messages);
	if (!messageText) return undefined;
	const cch = createHash("sha256")
		.update(messageText)
		.digest("hex")
		.slice(0, 5);
	const sampledCharacters = BILLING_HEADER_POSITIONS.map(
		(index) => messageText[index] || "0",
	).join("");
	const suffix = createHash("sha256")
		.update(`${BILLING_HEADER_SALT}${sampledCharacters}${CLAUDE_CODE_VERSION}`)
		.digest("hex")
		.slice(0, 3);
	return [
		"x-anthropic-billing-header:",
		`cc_version=${CLAUDE_CODE_VERSION}.${suffix};`,
		`cc_entrypoint=${CLAUDE_CODE_ENTRYPOINT};`,
		`cch=${cch};`,
	].join(" ");
}

function normalizeSystemBlock(block: unknown): ShapeTextBlock {
	if (typeof block === "string") return { type: "text", text: block };
	if (isRecord(block) && typeof block.text === "string")
		return { ...block, type: "text", text: block.text };
	return { type: "text", text: "" };
}

function prependBillingHeader(
	system: unknown,
	messages: ShapeMessageParam[],
): unknown {
	const billingHeader = buildBillingHeaderValue(messages);
	if (!billingHeader) return system;
	const systemBlocks = Array.isArray(system)
		? system.map(normalizeSystemBlock)
		: system == null
			? []
			: [normalizeSystemBlock(system)];
	// Idempotent: don't add a second billing header (e.g. pi-anthropic-auth also ran).
	if (
		systemBlocks.some((block) =>
			block.text.includes("x-anthropic-billing-header:"),
		)
	)
		return systemBlocks;
	const billingBlock: ShapeTextBlock = { type: "text", text: billingHeader };
	return [billingBlock, ...systemBlocks];
}

// The Anthropic API rejects assistant turns where non-tool_use blocks follow a
// tool_use block; Pi's serializer can produce that, so split into two turns.
function splitAssistantToolUseTrailingContent(
	messages: ShapeMessageParam[],
): ShapeMessageParam[] {
	return messages.flatMap((message) => {
		if (message.role !== "assistant" || !Array.isArray(message.content))
			return [message];
		const firstToolUseIndex = message.content.findIndex(
			(block) => block.type === "tool_use",
		);
		if (firstToolUseIndex === -1) return [message];
		const trailingBlocks = message.content.slice(firstToolUseIndex);
		if (!trailingBlocks.some((block) => block.type !== "tool_use"))
			return [message];
		const nonToolUseBlocks = message.content.filter(
			(block) => block.type !== "tool_use",
		);
		const toolUseBlocks = message.content.filter(
			(block) => block.type === "tool_use",
		);
		return [
			{ ...message, content: nonToolUseBlocks },
			{ ...message, content: toolUseBlocks },
		];
	});
}

function sanitizeSystemText(text: string): string {
	const paragraphs = text.split(/\n\n+/);
	const filtered = paragraphs.filter(
		(paragraph) =>
			!PARAGRAPH_REMOVAL_ANCHORS.some((anchor) => paragraph.includes(anchor)),
	);
	let result = filtered.join("\n\n");
	for (const rule of TEXT_REPLACEMENTS)
		result = result.replaceAll(rule.match, rule.replacement);
	return result.trim();
}

function findProjectContextStart(systemPrompt: string): number {
	return systemPrompt.indexOf("\n\n# Project Context\n\n");
}

function shapeAnthropicOAuthSystemPrompt(systemPrompt: string): string {
	const prefixIdx = systemPrompt.indexOf(PI_DEFAULT_PROMPT_PREFIX);
	if (prefixIdx === -1) return systemPrompt;
	const terminatorIdx = systemPrompt.indexOf(
		PI_DEFAULT_PROMPT_TERMINATOR,
		prefixIdx,
	);
	if (terminatorIdx !== -1) {
		const terminatorEnd = terminatorIdx + PI_DEFAULT_PROMPT_TERMINATOR.length;
		const preamble = systemPrompt.slice(prefixIdx, terminatorEnd);
		const sanitized = sanitizeSystemText(preamble);
		const shapedPreamble = sanitized
			? `${MINIMAL_ANTHROPIC_OAUTH_PROMPT}\n\n${sanitized}`
			: MINIMAL_ANTHROPIC_OAUTH_PROMPT;
		return (
			systemPrompt.slice(0, prefixIdx) +
			shapedPreamble +
			systemPrompt.slice(terminatorEnd)
		);
	}
	// Pi reworded its preamble terminator → fall back to slicing from project context.
	const projectContextStart = findProjectContextStart(systemPrompt);
	if (projectContextStart === -1) return MINIMAL_ANTHROPIC_OAUTH_PROMPT;
	return `${MINIMAL_ANTHROPIC_OAUTH_PROMPT}${systemPrompt.slice(projectContextStart)}`;
}

function shapeSystemBlocks(blocks: ShapeTextBlock[]): ShapeTextBlock[] {
	return blocks.map((block) => {
		if (block.type !== "text" || !block.text.includes(PI_DEFAULT_PROMPT_PREFIX))
			return block;
		return { ...block, text: shapeAnthropicOAuthSystemPrompt(block.text) };
	});
}

/** before_provider_request shaper: makes Claude Pro/Max OAuth requests acceptable. */
function shapeAnthropicOAuthPayload(payload: unknown): unknown {
	if (!isAnthropicMessagesPayload(payload)) return payload;
	const messages = payload.messages as ShapeMessageParam[];
	if (!isOAuthAnthropicPayload(payload)) return payload; // API-key / non-OAuth → untouched
	const normalizedMessages = splitAssistantToolUseTrailingContent(messages);
	const shapedSystem = Array.isArray(payload.system)
		? shapeSystemBlocks(payload.system as ShapeTextBlock[])
		: payload.system;
	const finalSystem = prependBillingHeader(shapedSystem, normalizedMessages);
	return { ...payload, messages: normalizedMessages, system: finalSystem };
}

/**
 * The controller calls Pi's native provider directly, so the normal
 * before_provider_request event is not emitted. Reuse the exact OAuth shaping
 * above by adding a temporary identity marker, then remove only that marker.
 * This keeps the billing header and prompt normalization identical to a normal
 * parent request without putting a Claude-specific marker into the child result.
 */
function shapeControllerAnthropicPayload(payload: unknown): unknown {
	if (!isAnthropicMessagesPayload(payload)) return payload;
	const originalSystem = Array.isArray(payload.system)
		? payload.system.map(normalizeSystemBlock)
		: payload.system == null
			? []
			: [normalizeSystemBlock(payload.system)];
	const marker = { type: "text", text: CLAUDE_CODE_IDENTITY_PREFIX };
	const shaped = shapeAnthropicOAuthPayload({
		...payload,
		system: [marker, ...originalSystem],
	}) as ShapeAnthropicPayload;
	if (!Array.isArray(shaped.system)) return shaped;
	return {
		...shaped,
		system: shaped.system.filter(
			(block) => !(isRecord(block) && block.type === "text" && block.text === marker.text),
		),
	};
}

/**
 * before_provider_request shaper for Qwen/Alibaba (OpenAI-compatible). Pi sends the system
 * instructions with the OpenAI-only `developer` role (the o1+/Codex convention), but Qwen's
 * compatible-mode API rejects it with `400 invalid_parameter_error: developer is not one of
 * ['system','assistant','user','tool','function']`. Rewrite that role to `system` (which Qwen
 * accepts) in place. Idempotent and role-only — content is untouched. Returns whether it changed
 * anything, so callers/tests can assert it fired.
 */
function rewriteDeveloperRoleToSystem(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") return false;
	const messages = (payload as { messages?: unknown }).messages;
	if (!Array.isArray(messages)) return false;
	let changed = false;
	for (const message of messages) {
		if (
			message &&
			typeof message === "object" &&
			(message as { role?: unknown }).role === "developer"
		) {
			(message as { role?: unknown }).role = "system";
			changed = true;
		}
	}
	return changed;
}

/** OAuth override enabling Claude Pro/Max login on a provider (base or alias). */
function anthropicOAuthOverride(providerId: string, name: string) {
	return {
		name,
		usesCallbackServer: true,
		async login(callbacks: any) {
			return rejectDuplicateLogin(
				providerId,
				await requirePiAiOauth().anthropic.login(callbacks),
			);
		},
		refreshToken: anthropicRefresherFor(providerId),
		getApiKey: (credentials: any) => credentials.access,
	};
}

// ===========================================================================
// Extension entry point
// ===========================================================================

export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";

/**
 * pi-subagents owns model selection and fallback routing inside its child
 * processes. Loading this extension there is still useful for provider/account
 * registration and request shaping, but a child must never restore the parent
 * process's remembered model or start a second failover loop.
 */
export function isSubagentChildProcess(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return env[SUBAGENT_CHILD_ENV] === "1";
}

function parseExplicitCliArgs(argv: readonly string[] = process.argv): {
	model?: string;
	provider?: string;
	thinking?: ReasoningLevel;
} {
	let model: string | undefined;
	let provider: string | undefined;
	let thinking: ReasoningLevel | undefined;
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") break;
		if (arg === "--provider" && i + 1 < argv.length) provider = argv[++i];
		else if (arg === "--model" && i + 1 < argv.length) model = argv[++i];
		else if (arg === "--thinking" && i + 1 < argv.length) {
			const value = argv[++i];
			if (REASONING_LEVELS.includes(value as ReasoningLevel)) {
				thinking = value as ReasoningLevel;
			}
		}
	}
	return { model, provider, thinking };
}

// Registration has no model catalog. Once session_start supplies one, delegate model suffix
// parsing to the same resolver as Pi's CLI, including exact colon IDs and provider custom IDs.
async function resolveExplicitCliModelThinkingLevel(
	args: ReturnType<typeof parseExplicitCliArgs>,
	ctx: any,
): Promise<ReasoningLevel | undefined> {
	if (!args.model) return undefined;
	try {
		const registry = ctx?.modelRegistry;
		const models = registry?.getAll?.() ?? [];
		const { resolveCliModel } = await import(
			"@earendil-works/pi-coding-agent"
		);
		const { thinkingLevel } = resolveCliModel({
			cliProvider: args.provider,
			cliModel: args.model,
			cliThinking: args.thinking,
			modelRuntime: {
				getModels: () => models,
				hasConfiguredAuth: (provider: string) =>
					models.some(
						(model: any) =>
							model.provider === provider &&
							(registry.hasConfiguredAuth?.(model) ??
								registry.getProviderAuthStatus?.(provider)?.configured ??
								false),
					),
			} as any,
		});
		return REASONING_LEVELS.includes(thinkingLevel as ReasoningLevel)
			? (thinkingLevel as ReasoningLevel)
			: undefined;
	} catch {
		return undefined;
	}
}

export function explicitCliSelections(
	argv: readonly string[] = process.argv,
): { model: boolean; thinking: boolean } {
	const parsed = parseExplicitCliArgs(argv);
	return {
		model: parsed.model !== undefined,
		thinking: parsed.thinking !== undefined,
	};
}

export default function piMultiAccount(pi: ExtensionAPI) {
	// Warm up the OAuth helpers before any provider registration: providers are
	// registered synchronously below and their `usesCallbackServer`/`getApiKey`
	// read from the cached module. Deliberately NON-fatal — if pi-ai's oauth entry
	// cannot be resolved (hoisted npm layout, incompatible pi-ai), the extension
	// still loads and every non-OAuth account keeps working; only subscription
	// logins are unavailable, and the user is told once at session start.
	const oauthUnavailable = piAiOauthUnavailableReason();
	const subagentChild = isSubagentChildProcess();
	const explicitCliArgs = parseExplicitCliArgs();
	const explicitCli = {
		model: explicitCliArgs.model !== undefined,
		thinking: explicitCliArgs.thinking !== undefined,
	};
	const explicitCliThinkingAtRegistration = explicitCliArgs.thinking;
	const hasExplicitCliSelection = explicitCli.model || explicitCli.thinking;
	// A CLI launch owns both remembered dimensions until a genuine user change takes ownership
	// of that dimension. Otherwise a model-only launch can persist its thinking clamp (or vice versa).
	let modelPreferenceChanged = !hasExplicitCliSelection;
	let thinkingPreferenceChanged = !hasExplicitCliSelection;
	const sessionInstanceId = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
	let config = loadConfig();
	const automaticFailoverEnabled = () => config.enabled && !subagentChild;
	debugLogEnabled = config.debugLog;
	let configuredFallbacks = config.fallbacks.slice();
	let persistedState = loadState();
	let lastModelByFamily: Record<string, string> = {
		...(persistedState.lastModelByFamily ?? {}),
	};
	/** Settles once Cursor fallback models are registered. Pi awaits the factory return, so createAgentSession can getModel(cursor, grok-4.6) instead of falling back. */
	let cursorReady: Promise<unknown> | undefined;
	let modelCatalogContext: any;

	// ----- only-active model filter -------------------------------------------
	// When enabled, /model drops this extension's OTHER rotation slots: each is
	// re-registered with `models: []` (Pi merges re-registrations, so auth/OAuth
	// config survives) and restored from here on switch or disable.
	//
	// It may only ever narrow slots THIS extension invented. Pi's registry is the
	// single place anything — Pi itself, another extension, a `--models` pattern —
	// asks "does this model exist?", and re-registering a provider with no models
	// answers "no" to every one of them. Emptying a provider Pi knows on its own
	// (a built-in, a models.json entry, another extension's registration) therefore
	// does not hide a model, it DELETES it: a pinned `zai/glm-5.1` stops resolving,
	// and a caller that falls back to "just use the session model" silently starts
	// running on whichever account rotation happens to be on. That is invisible from
	// here and undebuggable from there. Slots we invented are ours to narrow —
	// nothing else in Pi knows the name `openai-codex-account-3` — and every model
	// Pi knows independently stays resolvable by reference while the filter is on.
	let onlyActiveModels = config.onlyActive;
	/** Models of the providers WE hid, freshest copy — the only way back. */
	const hiddenProviderModels = new Map<string, any[]>();

	/**
	 * A provider that exists ONLY because this extension registered it. Pi has no
	 * built-in and no models.json entry under a `-account-N` name unless we made it,
	 * so narrowing these takes nothing away from anyone else.
	 */
	function isOwnRotationSlot(provider: string): boolean {
		return /-account-\d+$/.test(provider);
	}

	function unhideProvider(provider: string) {
		const models = hiddenProviderModels.get(provider);
		if (!models) return;
		try {
			pi.registerProvider(provider, { models } as any);
			hiddenProviderModels.delete(provider);
		} catch (error) {
			logEvent("only_active_restore_failed", {
				provider,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}

	function clearOnlyActiveFilter() {
		for (const provider of [...hiddenProviderModels.keys()]) unhideProvider(provider);
	}

	/**
	 * Narrow /model to the active account. Idempotent and cheap: a provider we already
	 * hid shows zero models in the registry, so there is nothing to re-hide, and a
	 * provider that re-registered itself (catalog sync) is re-hidden with the FRESH
	 * model list stored for restore. Never touches the active provider's registration
	 * beyond restoring what we previously hid.
	 */
	function applyOnlyActiveFilter(ctx: any, activeProvider?: string) {
		// A pi-subagents child was launched on one exact candidate. Hiding its registry through the
		// interactive process's only-active policy would make that candidate unverifiable again.
		if (subagentChild || !onlyActiveModels) return;
		const active = activeProvider ?? ctx?.model?.provider;
		if (!active) return;
		let all: any[] = [];
		try {
			all = ctx?.modelRegistry?.getAll?.() ?? [];
		} catch {
			return;
		}
		const visibleByProvider = new Map<string, any[]>();
		for (const model of all) {
			if (!model?.provider || typeof model.id !== "string") continue;
			const list = visibleByProvider.get(model.provider);
			if (list) list.push(model);
			else visibleByProvider.set(model.provider, [model]);
		}
		for (const [provider, models] of visibleByProvider) {
			if (provider === active) {
				unhideProvider(provider);
				continue;
			}
			// Not ours to remove: emptying it would unregister models Pi knows on its
			// own, and every caller resolving one by reference would stop finding it.
			if (!isOwnRotationSlot(provider)) continue;
			if (!models.length) continue; // already hidden (or genuinely empty)
			hiddenProviderModels.set(provider, models);
			try {
				pi.registerProvider(provider, { models: [] } as any);
			} catch (error) {
				hiddenProviderModels.delete(provider);
				logEvent("only_active_hide_failed", {
					provider,
					reason: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	/** pi.setModel that first restores the target's models when the filter hid them. */
	let internalModelChanges = 0;
	async function setModelEnsuringVisible(
		target: { provider: string; id: string },
		ctx: any,
	) {
		if (onlyActiveModels) unhideProvider(target.provider);
		// Pi rewrites settings.json on this path; the next turn checks that it actually did.
		pendingSettingsCheck = true;
		internalModelChanges++;
		try {
			return await pi.setModel(target as any);
		} finally {
			internalModelChanges--;
		}
	}

	/**
	 * Registry lookup that also sees providers the filter hid. Without it the failover's
	 * own candidate search would starve: a hidden provider shows zero models, so the
	 * rotation could never switch INTO it.
	 */
	function findModelIncludingHidden(ctx: any, provider: string, modelId: string) {
		const direct =
			ctx.modelRegistry.find(provider, modelId) ??
			hiddenProviderModels.get(provider)?.find((m: any) => m.id === modelId);
		if (direct) return direct;
		try {
			const fromRegistry = (ctx.modelRegistry.getAll?.() ?? []).filter(
				(m: any) => m.provider === provider,
			);
			const pool = [
				...fromRegistry,
				...(hiddenProviderModels.get(provider) ?? []),
			];
			const exact = pool.find((m: any) => m.id === modelId);
			if (exact) return exact;
			// Cursor catalogs fold effort variants (`cursor-grok-4.6-high` → `cursor-grok-4.6`).
			// A remembered or in-flight id with the suffix must still resolve to the folded model.
			return pool.find((m: any) => sameModelIdentity(m.id, modelId));
		} catch {
			return undefined;
		}
	}

	// Clamp any persisted far-future cooldown on load: a pre-fix (or mis-parsed long-window) state
	// could carry a weeks-away reset that would keep evicting a live account until it expired. Cap it
	// so the account is re-probed within MAX_LIVE_COOLDOWN_MS and usage reconciliation takes over.
	const clampCooldownUntil = (until: number, now = Date.now()): number =>
		Number.isFinite(until) ? Math.min(until, now + MAX_LIVE_COOLDOWN_MS) : until;
	const exhaustedUntilByProvider = new Map<string, number>(
		Object.entries(persistedState.exhaustedUntilByProvider ?? {}).map(
			([provider, until]) => [provider, clampCooldownUntil(until)],
		),
	);
	const exhaustedUntilByModel = new Map<string, number>(
		Object.entries(persistedState.exhaustedUntilByModel ?? {}),
	);
	const invalidatedByProvider = new Map<string, InvalidationRecord>(
		Object.entries(persistedState.invalidatedByProvider ?? {}),
	);
	const usageByProvider = new Map<string, UsageSnapshot>(
		Object.entries(persistedState.usageByProvider ?? {}),
	);
	const codexModelCatalogByProvider = new Map<string, CodexCatalogSnapshot>(
		Object.entries(persistedState.codexModelCatalogByProvider ?? {}),
	);
	const usageFetches = new Map<string, Promise<UsageSnapshot>>();
	const usageErrors = new Map<string, string>();
	// Per-provider 401 tracking (in-memory, reset on any success): the token hash that last failed
	// and how many DISTINCT (refreshed) tokens have failed in a row. Only 401s on a *rotated* token
	// advance toward a permanent kill, so a refreshable account whose refresh isn't reaching the wire
	// is never wrongly revoked.
	const authFailures = new Map<string, { hash: string; distinct: number }>();
	// Response headers arrive before the final assistant message. Keep their cooldown hints, but
	// never switch accounts from that early hook: Pi may still be retrying the same HTTP request.
	const responseCooldownHints = new Map<string, number>();
	const handledAssistantErrors = new Set<string>();
	// Consecutive limit-error accounting per provider (in-memory, reset on any success). Two limit
	// errors in a row prove the usage-% window is not seeing this account's real limit, so usage is
	// distrusted until `usageUntrustedUntilByProvider` expires — this is what stops the ~1s
	// retry-loop against a session-limited account whose quota window still shows headroom.
	const limitStreakByProvider = new Map<
		string,
		{ count: number; lastAt: number }
	>();
	/**
	 * Accounts this failover chain has already rotated ONTO while their own quota forecast still
	 * said they were spent.
	 *
	 * `findFallbackModels` deliberately admits a same-family sibling that no error has refused
	 * yet, even when its meter reads 100 %: the meter is a forecast, and skipping straight to
	 * another vendor on a forecast is what once sent a Codex turn to Claude with three Codex slots
	 * still untried. The exception was written as "has not refused THIS SESSION", and that phrasing
	 * is the hole. The pending-resume path rotates onto an account WITHOUT sending it a request, so
	 * it never refuses, so `lastRefusalAt` stays 0 and it stays eligible for ever. Two such
	 * siblings then re-admit each other about once a second: 275 switches in four minutes with not
	 * one request leaving the machine, while a free Anthropic account sat at the top of the ladder
	 * and was never asked, because same-model outranks every other key in the comparator.
	 *
	 * So the reprieve is spent by SELECTION, not by refusal: one rotation onto the account is the
	 * single attempt its stale forecast has earned. Cleared when the account proves itself
	 * (`noteAuthSuccess`) or a genuine user prompt begins a fresh chain.
	 */
	// Seeded from disk: the proof that an account's meter lies must outlive the process that
	// observed it, or every new session re-selects the spent account all over again. Only
	// still-future entries are carried; an expired one has already served its purpose.
	const usageUntrustedUntilByProvider = new Map<string, number>(
		Object.entries(persistedState.usageUntrustedUntilByProvider ?? {}).filter(
			([, until]) => typeof until === "number" && until > Date.now(),
		),
	);

	// An account the user picked by hand (`next` / `switch`), still owed its one attempt.
	//
	// Manual selection deliberately ignores the cooldown bookkeeping, because that bookkeeping is
	// a forecast and actually asking the account is the only way to prove it wrong. The preflight
	// that runs on the next user message re-applied the same forecast and moved the user off — so
	// the override survived only until it was used, which is the one moment it had to hold. This
	// reprieve is spent by the first attempt, so a user cannot strand themselves on a dead account.
	let manualPinnedProvider: string | undefined;
	// Whether the reprieve has already covered a message. The attempt spans several hooks, so
	// "spent" cannot mean "the first hook asked about it"; it means "a message has gone out under
	// it". The next message retires it — which is also why nothing here depends on a particular
	// host emitting a particular event: a reprieve can never outlive the message it was granted
	// for, even on a host that never reaches `before_agent_start`.
	let manualPinCoveredMessage = false;

	function pinManualChoice(provider: string | undefined) {
		manualPinnedProvider = provider;
		manualPinCoveredMessage = false;
	}

	/** Retire a reprieve that has already had its message. Called when a new prompt arrives. */
	function retireSpentManualPin() {
		if (manualPinCoveredMessage) manualPinnedProvider = undefined;
	}

	/**
	 * Whether the account currently selected is the one the user just chose by hand.
	 *
	 * Deliberately does NOT clear the reprieve. Pi runs the readiness preflight twice for a single
	 * user message — once on `input`, then again in `before_agent_start` — so a reprieve spent by
	 * the first "is this account ready?" question was already gone when the second asked, and the
	 * user was moved off the account they had just picked, one moment before it was used. The
	 * reprieve covers the ATTEMPT; only the attempt may spend it.
	 */
	function hasManualPin(provider: string | undefined): boolean {
		return !!provider && manualPinnedProvider === provider;
	}

	/** Mark the reprieve as having covered this message; the next prompt retires it. */
	function markManualPinUsed(provider: string | undefined) {
		if (hasManualPin(provider)) manualPinCoveredMessage = true;
	}

	// Automatic failover onto a same-family sibling whose usage forecast still says spent.
	// Without a one-attempt pin, the next preflight treats that forecast as a verdict and
	// bounces to another family (the openai-codex/gpt-5.6-sol → anthropic/claude-opus-5 hop).
	let failoverPinnedProvider: string | undefined;
	let failoverPinCoveredMessage = false;

	function pinFailoverProbe(provider: string | undefined) {
		failoverPinnedProvider = provider;
		// The hop itself is the attempt. The continuation is not a new user prompt, so the pin
		// must survive until the next genuine `input`. Marking it covered here means a host that
		// never emits `before_agent_start` still retires it on the next typed message, instead of
		// leaving a dead account pinned forever.
		failoverPinCoveredMessage = true;
	}

	function retireSpentFailoverPin() {
		if (failoverPinCoveredMessage) failoverPinnedProvider = undefined;
	}

	function hasFailoverPin(provider: string | undefined): boolean {
		return !!provider && failoverPinnedProvider === provider;
	}

	function markFailoverPinUsed(provider: string | undefined) {
		if (hasFailoverPin(provider)) failoverPinCoveredMessage = true;
	}

	// Discovered, authed, deduped provider ids in rotation order.
	let rotation: string[] = [];
	let duplicateSlots: Array<{ duplicate: string; primary: string }> = [];
	// Whether the one-time host-capability notice has already been shown this process.
	let preflightNotified = false;
	// Slot ids registered as targets in the interactive /login provider picker.
	const registeredSlots = new Set<string>();
	// Host model list an api-key slot was last registered with, so it is refreshed, not re-done.
	const apiKeySlotHostSignature = new Map<string, string>();
	// One notice per process when the optional Cursor provider cannot be loaded.
	let cursorSetupFailureNotified = false;
	// Strongest-first order learned from OpenAI's live per-account catalogs. It feeds the same
	// cross-account ranking path as explicit preferredModels, so newly released flagships win
	// immediately without hard-coding their names in this extension.
	let discoveredCodexModelOrder: string[] = [];
	// Same idea one level down: strongest-first order learned from the HOST model registry
	// (plus our static list). Used whenever the live catalog is unavailable — offline, catalog
	// fetch failing, or autoDiscoverModels turned off.
	let registryCodexModelOrder: string[] = [];
	// The same, for Anthropic. Anthropic publishes no per-account catalog API, so the host
	// registry is the only way a new flagship (e.g. claude-opus-5) can win without a release.
	let registryAnthropicModelOrder: string[] = [];
	// Live Ollama Cloud catalog (`GET https://ollama.com/v1/models`). Unlike Codex, Ollama
	// publishes a single account-agnostic catalog per API key, so one fetch covers the base
	// provider and every cloned `ollama-account-N` slot. Bare ids (e.g. `kimi-k3`) are
	// registered verbatim — Ollama Cloud accepts them as-is.
	let discoveredOllamaModelIds: string[] = [];
	let ollamaCatalogFetchedAt = 0;
	let lastAuthMtime = -1;
	const credentialHashes = new Map<string, string>();
	// Stable per-slot account fingerprints (survive token refresh). A change means the slot was
	// re-logged into a DIFFERENT real account, which is the only reason to drop its cooldown.
	const credentialIdentities = new Map<string, string>();

	let currentPromptSwitch: SwitchRecord | undefined;
	// Number of auto-continuations issued for the CURRENT task. Crucially this is NOT
	// reset by the self-triggered re-prompts failover issues (only by a genuine new user
	// prompt — see before_agent_start), so config.maxAutoContinuesPerPrompt actually bounds
	// the failover loop instead of resetting to 0 on every iteration.
	let autoContinuesThisPrompt = 0;
	/**
	 * Account rotations performed by the pending-resume timer that did NOT end in a dispatched
	 * continuation.
	 *
	 * `autoContinuesThisPrompt` counts turns we actually started, so it cannot bound a loop that
	 * never starts one — and the ping-pong never did: every wake switched account, found the new
	 * account cooling too, re-armed the wait and changed nothing. Counting the rotations themselves
	 * is what makes `maxAutoContinuesPerPrompt` a real ceiling on that path.
	 */
	let pendingResumeHops = 0;
	/**
	 * How long the pending-resume timer waits after a wake that changed nothing.
	 *
	 * The floor exists so a genuinely-recovered account is picked up promptly. But the wake delay
	 * is the minimum across EVERY rotation account, so one free account elsewhere pinned it at the
	 * floor and the session re-checked at 1 Hz for as long as the state lasted. A wake that
	 * achieves nothing doubles the wait, up to the ordinary poll interval; anything that counts as
	 * progress puts it back on the floor.
	 */
	let pendingWakeBackoffMs = MIN_PENDING_WAKE_MS;
	/** The same relaxation, for the timer that holds a typed message until an account is free. */
	let queuedWakeBackoffMs = AUTH_CHANGE_POLL_MS;
	/**
	 * Bumped by every explicit "stop what you are doing" — `/multi-account stop`, `reset`, `clear`.
	 *
	 * The automatic paths are async: a wake that is already past its guards keeps running while the
	 * user types, and re-arms the wait a moment after `stop` cleared it. That is why stop had to be
	 * typed two or three times before it took. Each async chain captures the epoch it started under
	 * and abandons itself the moment it changes, so one stop is enough.
	 */
	let chainEpoch = 0;
	let pendingWakeTimer: ReturnType<typeof setTimeout> | undefined;
	let queuedInputWakeTimer: ReturnType<typeof setTimeout> | undefined;
	let usageStatusTimer: ReturnType<typeof setInterval> | undefined;
	// Pending work is session-local. The shared state file may contain another Pi window's marker;
	// using that marker as this window's runtime state makes two unrelated tasks resume each other.
	let pendingResume:
		| { from: ModelRef; reason: string; since: number }
		| undefined;

	// ----- the governor ----------------------------------------------------
	//
	// WHY THIS EXISTS, since the alternative has been tried eight times and did not hold.
	//
	// This extension drives the session from a dozen independent places: a failed turn, a
	// resume timer, a queued-input timer, a stuck-turn watchdog, a compaction boundary, two
	// preflights. Each of them decided for itself when to give up, and between them there are
	// six unrelated stop conditions — `autoContinuesThisPrompt`, the pending-resume hop count,
	// the stuck-reminder count, the recovery circuit breaker, the guard's compaction cooldown,
	// the queue length. Not one of them can see the others, and none of them can see the system.
	//
	// The consequence is that a NEW path, or a new interaction between two existing paths, is an
	// unbounded loop by default; it only becomes safe if whoever wrote it remembered to bound it.
	// The changelog is the evidence: "Runaway failover loop that could freeze the machine",
	// "Escape did not stop the loop", "API-key providers no longer loop forever on a dead key",
	// "a session/rate limit is no longer hot-retried every second", "Compaction no longer leaves
	// 'Compacting context…' spinning forever", "a refusal that cannot be classified no longer
	// strands the session forever", "the stuck-resume watchdog now ACTS instead of only warning",
	// and the 275-switch rotation this governor was written for. Eight separate fixes, eight
	// separate paths, one shape.
	//
	// So the default is inverted. Every automatic action asks here first, and the question is not
	// "have I personally done this too often" but "has this session gone anywhere". Two invariants
	// answer that, and both are measured from the PROVIDER, not from our own bookkeeping — the
	// whole failure mode is that our bookkeeping believed it was making progress:
	//
	//   1. No request reached a provider at all across N consecutive actions. That is a spin with
	//      certainty: nothing was learned, nothing was sent, nothing can change. The 275 switches
	//      in four minutes made not one request.
	//   2. No SUCCESSFUL response across M consecutive actions. Slower and rarer, and it is what a
	//      hot retry against a limit that our meters cannot see looks like. The bound is loose
	//      enough that walking an entire seventeen-account fleet — a switch and a real request per
	//      account — completes normally, because every one of those requests resets invariant 1
	//      and a fleet walk is a legitimate way to spend a minute.
	//
	// Tripping is not a pause. It stops every timer, drops every armed continuation, says what
	// happened in one sentence with the user's own held text handed back, and stays stopped until
	// the user says something or runs `/multi-account reset`. A session that has stopped is a
	// session the user can act on; a session that is spinning is one they can only kill.
	const GOVERNOR_ACTIONS_WITHOUT_REQUEST = 12;
	const GOVERNOR_ACTIONS_WITHOUT_SUCCESS = 40;
	let actionsSinceRequest = 0;
	let actionsSinceSuccess = 0;
	let firstActionSinceRequestAt = 0;
	let governorStoppedReason: string | undefined;
	// A safety stop that misfires is worse than the hang it prevents, and the way it would misfire
	// is a host that never emits the hooks the governor watches — then "no request was observed"
	// means "we cannot see requests", not "no request happened". So each invariant arms itself only
	// after it has seen its own signal work at least once in this session. On a host that emits
	// nothing, the governor stays dormant and behaviour is exactly what it was before. On a host
	// that emits normally, the very turn that hit the limit has already armed it, which is all the
	// spin that follows ever needed.
	let requestSignalSeen = false;
	let successSignalSeen = false;

	const queuedUserInputs: Array<{ text: string; images?: any[] }> = [];
	let continuationDispatchedForAgentTurn = false; // avoid agent_end double-dispatch after message_end failover
	let userAbortedChain = false; // user pressed Esc → stop auto-continuing until a new prompt
	let lastLeftProvider: string | undefined; // account we just failed away from (anti-ping-pong)
	let lastLeftAt = 0;
	type ThinkingChangeEvidence = {
		model: string;
		previousLevel: ReasoningLevel;
		appliedLevel: ReasoningLevel;
	};
	let automaticModelTarget: ModelRef | undefined;
	let lastObservedModelKey: string | undefined;
	let lastObservedThinkingLevel: ReasoningLevel | undefined;
	let pendingModelThinkingChange: ThinkingChangeEvidence | undefined;
	// Forward-progress watchdog state. A "resume in flight" is a continuation WE dispatched
	// (pi.continueAgent after a switch) whose new turn must keep showing activity. Any stream
	// token, tool event, or provider response is "progress" and disarms the stuck timer; total
	// silence past stuckWatchdogMs means the rotated turn wedged and the user is staring at a
	// spinner that will never finish — so we surface a concrete, actionable recovery.
	let activeResumeWatch: symbol | undefined;
	let progressWatchdogTimer: ReturnType<typeof setTimeout> | undefined;
	let watchdogCtx: any;
	let lastResumeProgressAt = 0;
	let stuckReminders = 0;
	// True only while WE deliberately abort a wedged resumed turn, so agent_end can tell our
	// recovery abort apart from a real user Esc and auto-continue instead of stopping.
	/**
	 * Set on every model switch, cleared once the next turn has verified it.
	 *
	 * Before the first switch, settings.json still names the previous session's choice, so
	 * comparing it to the live model would report a mismatch that means nothing. After a switch
	 * the comparison is meaningful: Pi is supposed to have rewritten both keys, and everything
	 * spawned without this extension loaded reads them to find the active account.
	 */
	let pendingSettingsCheck = false;
	/** Contract drift is stated once per session — it is a standing condition, not an event. */
	let contractDriftAnnounced = false;
	/** Last contract verdicts, for the status line. */
	let lastContractVerdicts: ShapeVerdict[] = [];

	let watchdogAborting = false;
	// How many tools are executing right now on the resumed turn. A long build/test command is
	// silent for minutes but is NOT stuck — never abort while a tool is in flight.
	let toolInFlight = 0;
	// Set right before we inject a continuation prompt as a user message (the fallback used when
	// the transcript tail is not continuable, e.g. after a watchdog abort). before_agent_start
	// checks it so our own continuation does NOT reset the per-task auto-continue counter — that
	// keeps maxAutoContinuesPerPrompt bounding the recovery loop.
	let expectingInjectedContinuation = false;
	let lastContextOverflowAt = 0; // for /multi-account status visibility
	let compactionRoutedNote: string | undefined; // last healthy-compaction routing decision, for status
	// Circuit breaker: consecutive failed auto-recoveries, and the time until which advisory mode
	// (auto-continue paused) stays in effect once tripped.
	let recoveryFailures = 0;
	let breakerOpenUntil = 0;
	// The thinking level the user intends for this session. pi.setModel() re-clamps AND
	// persists the thinking level on every model switch, so without re-asserting it the level
	// drifts downward across failovers ("thinking level keeps dropping"). But the intent must be
	// read from the SESSION (per-agent `--thinking`, `/thinking`), not from a global default:
	// forcing config.reasoningLevel on every agent_start clobbered per-agent thinking, so an
	// agent configured `low` was flipped to `high` on its first turn (issue #6).
	let desiredThinkingLevel: ReasoningLevel | undefined =
		explicitCliThinkingAtRegistration;
	let explicitCliThinkingLevel: ReasoningLevel | undefined = explicitCliThinkingAtRegistration;
	// What the host applied after we asserted the session's intent, and on which model. A
	// capability clamp or model default is NOT a user decision, otherwise thinking ratchets.
	let thinkingClamp: { model: string; level: ReasoningLevel } | undefined;
	const thinkingChangeSource = new AsyncLocalStorage<"extension">();

	const thinkingRank = (level: unknown) =>
		REASONING_LEVELS.indexOf(level as ReasoningLevel);

	function readThinkingLevel(): ReasoningLevel | undefined {
		try {
			const level = (pi as any).getThinkingLevel?.();
			return thinkingRank(level) >= 0 ? (level as ReasoningLevel) : undefined;
		} catch {
			// Older hosts have no getThinkingLevel; we simply have nothing to preserve.
			return undefined;
		}
	}

	if (explicitCli.thinking && !explicitCliThinkingLevel)
		explicitCliThinkingLevel = readThinkingLevel();
	if (explicitCli.thinking && explicitCliThinkingLevel)
		desiredThinkingLevel = explicitCliThinkingLevel;

	const thinkingModelKey = (ctx?: any) =>
		ctx?.model?.provider && ctx?.model?.id
			? ref(ctx.model.provider, ctx.model.id)
			: "unknown";

	// A level lower than the intent that is exactly what the host produced last time we asserted
	// the intent on THIS model is a clamp, not the user lowering thinking on purpose.
	function isKnownThinkingClamp(ctx: any, level: ReasoningLevel) {
		return (
			!!thinkingClamp &&
			thinkingClamp.level === level &&
			thinkingClamp.model === thinkingModelKey(ctx) &&
			level !== desiredThinkingLevel
		);
	}

	function captureDesiredThinking(ctx?: any) {
		const forced =
			config.reasoningLevel === "auto" ? undefined : config.reasoningLevel;
		if (forced) {
			// Explicit config is an opt-in override: force it on every turn (old behaviour).
			desiredThinkingLevel = forced;
		} else {
			const actual = readThinkingLevel();
			if (!actual) {
				/* host cannot report the level: keep whatever we already know, force nothing */
			} else if (desiredThinkingLevel === undefined) {
				// First turn of the session: whatever the session runs at IS the user's intent.
				desiredThinkingLevel = actual;
			} else if (
				actual !== desiredThinkingLevel &&
				!isKnownThinkingClamp(ctx, actual)
			) {
				// The user changed it (`/thinking`, or a delegated agent with its own level).
				logEvent("thinking_intent", { from: desiredThinkingLevel, to: actual });
				desiredThinkingLevel = actual;
			}
		}
		restoreDesiredThinking(ctx);
	}

	function restoreDesiredThinking(ctx?: any) {
		if (!desiredThinkingLevel) return;
		try {
			thinkingChangeSource.run("extension", () =>
				(pi as any).setThinkingLevel?.(desiredThinkingLevel),
			);
		} catch {
			/* setThinkingLevel clamps to model caps; ignore if unsupported */
		}
		// Record a clamp so the next turn does not mistake the fallback model's cap for intent.
		const applied = readThinkingLevel();
		if (!applied) return;
		lastObservedThinkingLevel = applied;
		if (applied !== desiredThinkingLevel) {
			thinkingClamp = { model: thinkingModelKey(ctx), level: applied };
			logEvent("thinking_clamped", {
				wanted: desiredThinkingLevel,
				applied,
				model: thinkingClamp.model,
			});
		} else {
			thinkingClamp = undefined;
		}
	}

	// ---- crash isolation (v1.12.0) ----------------------------------------
	// This extension hooks ~12 Pi events and runs several background timers. Node
	// terminates the whole process on an unhandled promise rejection, and a throw
	// inside an event handler can break the host. So EVERY handler and EVERY timer
	// callback is funnelled through these guards: the error is reported once
	// (deduped, so a repeating fault can't spam) and swallowed, the current failover
	// step is skipped, and Pi keeps running. This is the systemic net that makes the
	// whole surface fail-safe — not just the specific bugs we already know about.
	const reportedErrors = new Map<string, number>();
	function reportExtensionError(where: string, error: unknown, ctx?: any) {
		const msg = error instanceof Error ? error.message : String(error);
		const key = `${where}:${msg.slice(0, 80)}`;
		const now = Date.now();
		const last = reportedErrors.get(key) ?? 0;
		// Always record the raw fault in the black box (deduped only for the user-facing toast).
		logEvent("internal_error", { where, error: msg });
		if (now - last < 30_000) return; // dedupe identical errors within 30s
		reportedErrors.set(key, now);
		if (reportedErrors.size > 50) reportedErrors.clear(); // never grow unbounded
		try {
			ctx?.ui?.notify?.(
				`pi-multi-account: recovered from an internal error in ${where} (${msg.slice(0, 140)}). Failover continues; run /multi-account status if anything looks off.`,
				"warning",
			);
		} catch {
			/* even notify must never throw us out of the guard */
		}
	}

	// Register an event handler that can never crash the host. Preserves the handler's
	// return value (Pi uses these — e.g. the shaped payload, the input action, the
	// compaction result); on a sync throw OR async rejection it reports once and
	// returns undefined, which every Pi event treats as "no opinion / default".
	/**
	 * Look at the files Pi publishes, and say something only when one no longer has the shape this
	 * extension depends on.
	 *
	 * Neither auth.json nor models.json carries a schema version, so a Pi upgrade can change
	 * either without anything announcing it — both breakages this extension has already lived
	 * through were silent for days. Looking is the only detection available.
	 *
	 * `includeSettings` is true only on the turn after a model switch, when settings.json is
	 * supposed to have been rewritten to name the account the rotation just chose.
	 */
	function checkPiContract(ctx: any, why: string, includeSettings = false) {
		const active =
			includeSettings && ctx?.model?.provider && ctx?.model?.id
				? { provider: ctx.model.provider as string, id: ctx.model.id as string }
				: undefined;
		const verdicts = inspectPiContract(active);
		lastContractVerdicts = verdicts;
		const drift = describeContractDrift(verdicts);
		// A healthy check is logged once, at session start; after that only faults are worth a
		// line, or the black box fills with "still fine" on every turn.
		if (drift || why === "session_start") {
			logEvent("pi_contract_checked", {
				why,
				checked: verdicts.map((verdict) => verdict.file),
				problems: verdicts.flatMap((verdict) => verdict.problems),
				// Named on every logged check: after an upgrade these are the rows to re-verify by
				// hand, because nothing in Pi promises them.
				unpromised: observedAssumptions().map((assumption) => assumption.id),
			});
		}
		if (!drift) {
			// Cleared, so a fault that comes back later is announced again rather than swallowed.
			contractDriftAnnounced = false;
			return;
		}
		if (contractDriftAnnounced) return;
		contractDriftAnnounced = true;
		ctx?.ui?.notify?.(drift, "warning");
	}

	function safeOn(event: string, handler: (ev: any, ctx: any) => any) {
		pi.on(event as any, (ev: any, ctx: any) => {
			try {
				const out = handler(ev, ctx);
				if (out && typeof (out as any).then === "function") {
					return (out as Promise<unknown>).catch((error) => {
						reportExtensionError(`${event} handler`, error, ctx);
						return undefined;
					});
				}
				return out;
			} catch (error) {
				reportExtensionError(`${event} handler`, error, ctx);
				return undefined;
			}
		});
	}

	// Fire-and-forget an async background task (timer callbacks) without ever leaking
	// an unhandled rejection that would abort the Node process.
	function runBackground(where: string, ctx: any, fn: () => Promise<unknown>) {
		try {
			void fn().catch((error) => reportExtensionError(where, error, ctx));
		} catch (error) {
			reportExtensionError(where, error, ctx);
		}
	}

	function persist(
		extra?: Partial<ProviderFailoverState>,
		options: {
			clearPending?: "owned" | "owned-or-legacy";
			writeUserPreferences?: boolean;
		} = {},
	) {
		let next: ProviderFailoverState = {
			...persistedState,
			...extra,
			stateVersion: STATE_VERSION,
			exhaustedUntilByProvider: Object.fromEntries(
				exhaustedUntilByProvider.entries(),
			),
			exhaustedUntilByModel: Object.fromEntries(
				exhaustedUntilByModel.entries(),
			),
			invalidatedByProvider: Object.fromEntries(
				invalidatedByProvider.entries(),
			),
			usageUntrustedUntilByProvider: Object.fromEntries(
				usageUntrustedUntilByProvider.entries(),
			),
			usageByProvider: Object.fromEntries(usageByProvider.entries()),
			codexModelCatalogByProvider: Object.fromEntries(
				codexModelCatalogByProvider.entries(),
			),
		};
		// Every Pi window and delegated child shares this file. Preserve another live session's
		// pending marker on ordinary writes, and let an explicit clear remove only a marker owned by
		// this session. Otherwise an old wake timer can erase a newer session's held message.
		const disk = loadState();
		const diskHasPending = !!(disk.pendingFrom && disk.pendingReason);
		const nextHasPending = !!(next.pendingFrom && next.pendingReason);
		const canClearDiskPending =
			options.clearPending === "owned-or-legacy"
				? !disk.pendingOwner || disk.pendingOwner === sessionInstanceId
				: options.clearPending === "owned"
					? disk.pendingOwner === sessionInstanceId
					: false;
		const ordinaryWriteMustKeepDiskPending =
			!options.clearPending &&
			diskHasPending &&
			(!nextHasPending ||
				disk.pendingOwner !== sessionInstanceId ||
				next.pendingOwner !== sessionInstanceId);
		if (
			ordinaryWriteMustKeepDiskPending ||
			(!!options.clearPending && diskHasPending && !canClearDiskPending)
		) {
			next = {
				...next,
				pendingFrom: disk.pendingFrom,
				pendingReason: disk.pendingReason,
				pendingSince: disk.pendingSince,
				pendingContinuationPrompt: disk.pendingContinuationPrompt,
				pendingOwner: disk.pendingOwner,
			};
		} else if (
			!options.clearPending &&
			!diskHasPending &&
			nextHasPending &&
			next.pendingOwner !== sessionInstanceId
		) {
			// This process merely observed a marker that has since been cleared by its owner. Do not
			// resurrect it during an unrelated usage/catalog persistence write.
			next = {
				...next,
				pendingFrom: undefined,
				pendingReason: undefined,
				pendingSince: undefined,
				pendingContinuationPrompt: undefined,
				pendingOwner: undefined,
			};
		}
		// Usage/catalog timers are allowed to persist their own telemetry, but they must not roll
		// back a model choice saved by another live Pi window from an older in-memory snapshot.
		// Only rememberUserModel opts into changing these shared user-preference fields.
		if (!options.writeUserPreferences) {
			next = {
				...next,
				lastUserModel: disk.lastUserModel,
				lastUserThinkingLevel: disk.lastUserThinkingLevel,
				lastModelByFamily: disk.lastModelByFamily,
			};
		}
		persistedState = next;
		saveState(persistedState);
	}

	function lastProbeMap() {
		return persistedState.lastProbeAtByProvider ?? {};
	}

	function setLastProbe(provider: string) {
		persistedState = {
			...persistedState,
			lastProbeAtByProvider: { ...lastProbeMap(), [provider]: Date.now() },
		};
		persist();
	}

	// ----- invalidation (dead authorization) --------------------------------

	function clearReauthedInvalidations(auth: Record<string, AuthEntry>) {
		let changed = false;
		for (const [provider, record] of [...invalidatedByProvider.entries()]) {
			const entry = auth[provider];
			const currentHash = entry ? credentialHash(entry) : undefined;
			// Re-login (credential changed) or entry removed → clear invalidation.
			if (!entry || (currentHash && currentHash !== record.tokenHash)) {
				invalidatedByProvider.delete(provider);
				exhaustedUntilByProvider.delete(provider);
				authFailures.delete(provider);
				changed = true;
			}
		}
		if (changed) persist();
	}

	function markInvalid(provider: string, reason: string) {
		const entry = readAuthFile()[provider];
		const tokenHash = entry ? (credentialHash(entry) ?? "") : "";
		invalidatedByProvider.set(provider, {
			tokenHash,
			at: Date.now(),
			reason: reason.slice(0, 500),
		});
		// Invalidation = "drop from rotation until the user re-logs in / replaces the key".
		// We do NOT also set a 365-day cooldown — that polluted cooldown displays ("Cooldowns:
		// account-2: 8696h") and confused users into thinking a dead account was merely rate-
		// limited. Selection logic checks isInvalidated() directly, so the cooldown entry is
		// redundant. State stays clean: invalidated providers are reported separately.
		persist();
	}

	function isInvalidated(provider: string) {
		return invalidatedByProvider.has(provider);
	}

	/** True if this account can self-heal a 401 by refreshing its OAuth token. */
	function isRefreshable(provider: string): boolean {
		const entry = readAuthFile()[provider];
		return (
			!!entry && typeof entry.refresh === "string" && entry.refresh.length > 0
		);
	}

	type ForcedRefreshResult =
		| { status: "refreshed" }
		| { status: "terminal"; error: string }
		| { status: "transient"; error: string }
		| { status: "unsupported" };

	/**
	 * Pi normally refreshes OAuth only after the local expiry timestamp. Providers can revoke an
	 * access token earlier, leaving Pi stuck on a token that looks locally valid. On that explicit
	 * provider verdict, force one refresh immediately and persist it through Pi's AuthStorage.
	 */
	async function forceRefreshProvider(
		ctx: any,
		provider: string,
	): Promise<ForcedRefreshResult> {
		const entry = readAuthFile()[provider];
		if (
			!entry ||
			entry.type !== "oauth" ||
			typeof entry.refresh !== "string" ||
			entry.refresh.length === 0
		) {
			return { status: "unsupported" };
		}

		const authStorage = ctx?.modelRegistry?.authStorage;
		// Test harnesses and future Pi versions can provide a first-class forced refresh operation.
		if (typeof authStorage?.forceRefreshProvider === "function") {
			return authStorage.forceRefreshProvider(provider);
		}
		// Refuse to refresh at all if the result has nowhere to go: the refresh itself
		// revokes the token currently on disk.
		if (!canPersistRefreshedCredentials(authStorage)) {
			return { status: "unsupported" };
		}

		const family = classifyProvider(provider, config.qwenProvider);
		try {
			let refreshed: AuthEntry | undefined;
			if (family === "anthropic") {
				refreshed = await refreshAnthropicCredentials(
					entry,
					undefined,
					provider,
				);
			} else if (family === "openai-codex") {
				refreshed = mergeRefreshedCredentials(
					entry,
					await requirePiAiOauth().codex.refresh(
						entry as any,
						AbortSignal.timeout(30_000),
					),
				);
			} else if (family === "cursor") {
				refreshed = mergeRefreshedCredentials(
					entry,
					await refreshCursorCredentials(entry.refresh),
				);
			} else {
				return { status: "unsupported" };
			}

			if (!refreshed?.access) {
				return {
					status: "transient",
					error: "OAuth refresh returned no usable access token",
				};
			}
			if (
				entry.accountId &&
				refreshed.accountId &&
				entry.accountId !== refreshed.accountId
			) {
				return {
					status: "terminal",
					error: "OAuth refresh returned credentials for a different account",
				};
			}

			const persisted = await persistRefreshedCredentials(authStorage, provider, {
				type: "oauth",
				...entry,
				...refreshed,
			});
			if (!persisted) {
				// The refresh already rotated the token server-side, so the old one on
				// disk is dead either way. Say so instead of pretending it is transient.
				return {
					status: "terminal",
					error:
						"OAuth refresh succeeded but the rotated credential could not be written to auth.json; run /login for this account",
				};
			}
			if (
				ownsSharedChildPublication() &&
				needsAuthShadow(provider) &&
				(isCursorProviderId(provider) || slotProxyPort !== undefined)
			) {
				shadowChildFacingAuth([provider]);
			}
			reloadHostAuth(ctx);
			refreshDiscovery(true, ctx);
			return { status: "refreshed" };
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			return patternMatch(text, TERMINAL_REFRESH_ERROR_PATTERNS)
				? { status: "terminal", error: text }
				: { status: "transient", error: text };
		}
	}

	function registryCodexModels(ctx: any): CodexCatalogModel[] {
		let models: any[] = [];
		try {
			models = ctx?.modelRegistry
				?.getAll?.()
				?.filter((model: any) => model?.provider === CODEX_BASE) ?? [];
		} catch {
			return [];
		}
		return models
			.filter(
				(model) =>
					typeof model?.id === "string" &&
					// Codex only ever serves OpenAI ids. Guard against a host registry that
					// lists something else under this provider leaking into a Codex model list.
					/gpt|codex|^o\d/i.test(model.id),
			)
			.map((model) => ({
				id: model.id,
				name: typeof model.name === "string" ? model.name : model.id,
				reasoning: model.reasoning !== false,
				...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
				input: Array.isArray(model.input) && model.input.length > 0 ? model.input : ["text"],
				cost:
					model.cost && typeof model.cost === "object"
						? model.cost
						: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow:
					typeof model.contextWindow === "number" ? model.contextWindow : 272_000,
				maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : 128_000,
			})) as CodexCatalogModel[];
	}

	function mergeCodexModels(...groups: CodexCatalogModel[][]): CodexCatalogModel[] {
		const byId = new Map<string, CodexCatalogModel>();
		for (const group of groups) {
			for (const model of group) if (!byId.has(model.id)) byId.set(model.id, model);
		}
		return [...byId.values()].sort(compareCodexModelStrength);
	}

	/** Publish a credential-free, account-specific model snapshot over Pi's neutral event bus.
	 * Hidden providers are included, while each Codex account's live catalog overrides any
	 * base-provider fallback. No extension name, credential, quota or account identity is sent. */
	function emitModelCatalogSnapshot(ctx: any) {
		const auth = readAuthFile();
		const byProvider = new Map<string, any[]>();
		const put = (model: any) => {
			if (!model || typeof model.provider !== "string" || typeof model.id !== "string" || !auth[model.provider]) return;
			const list = byProvider.get(model.provider) ?? [];
			if (!list.some((entry) => entry.id === model.id)) list.push(model);
			byProvider.set(model.provider, list);
		};
		try {
			for (const model of ctx?.modelRegistry?.getAll?.() ?? []) put(model);
		} catch { /* runtime catalog is best effort; hidden/live snapshots follow */ }
		for (const models of hiddenProviderModels.values()) for (const model of models) put(model);
		for (const [provider, snapshot] of codexModelCatalogByProvider) {
			if (!auth[provider] || !snapshot.models.length) continue;
			const template = byProvider.get(provider)?.[0] ?? byProvider.get(CODEX_BASE)?.[0] ?? {};
			byProvider.set(provider, snapshot.models.map((model) => ({
				...model,
				provider,
				api: template.api ?? "openai-codex-responses",
				baseUrl: template.baseUrl,
			})));
		}
		const models = [...byProvider]
			.sort(([left], [right]) => left.localeCompare(right))
			.flatMap(([, providerModels]) => providerModels)
			.map((model) => ({
				provider: model.provider,
				id: model.id,
				name: model.name ?? model.id,
				api: model.api,
				baseUrl: model.baseUrl,
				reasoning: model.reasoning !== false,
				input: Array.isArray(model.input) ? model.input : ["text"],
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			}));
		pi.events?.emit?.(MODEL_CATALOG_SNAPSHOT_EVENT, { schemaVersion: 1, models });
	}

	pi.events?.on?.(MODEL_CATALOG_REQUEST_EVENT, () => emitModelCatalogSnapshot(modelCatalogContext));

	/**
	 * Offline Codex ordering: everything the HOST (Pi) knows about the Codex provider, merged
	 * with our static list and sorted strongest-first.
	 *
	 * Without this, the built-in `DEFAULT_CODEX_MODELS` list was consulted BEFORE the host
	 * registry, so a Pi that already shipped a newer flagship (e.g. gpt-5.6) kept failing over
	 * to the newest model this extension happened to have been released with (gpt-5.5) — a
	 * silent downgrade that needed a new release for every OpenAI generation. Registry-learned
	 * models now win by version, so the next generation works with no release at all. The live
	 * per-account catalog (when reachable) still outranks this.
	 */
	/**
	 * Offline Anthropic ordering: every Claude model the HOST knows, merged with our static list
	 * and ranked strongest-first. Without this, a new flagship shipped by Pi (claude-opus-5 while
	 * this extension's list still topped out at claude-opus-4-8) was invisible to failover, which
	 * silently broke the project's hard rule of always staying on a provider's top model.
	 */
	function refreshRegistryAnthropicModels(ctx: any) {
		let hostIds: string[] = [];
		try {
			hostIds =
				ctx?.modelRegistry
					?.getAll?.()
					?.filter((model: any) => model?.provider === ANTHROPIC_BASE)
					?.map((model: any) => model?.id) ?? [];
		} catch {
			hostIds = [];
		}
		const ranked = rankAnthropicModelIds([
			...hostIds,
			...DEFAULT_ANTHROPIC_MODELS,
		]);
		if (ranked.length === 0) return;
		if (ranked.join(",") === registryAnthropicModelOrder.join(",")) return;
		registryAnthropicModelOrder = ranked;
		// Alias slots are registered from the static list, so a model only the host knows about
		// would not be selectable on them even once it is ranked first.
		for (const provider of registeredSlots) {
			if (classifyProvider(provider, config.qwenProvider) !== "anthropic") continue;
			registerAnthropicSlot(
				pi,
				provider,
				ranked,
				numberedSlotBaseUrl(provider, "anthropic"),
			);
		}
	}

	function refreshRegistryCodexModels(ctx: any) {
		const merged = mergeCodexModels(
			registryCodexModels(ctx),
			DEFAULT_CODEX_MODELS.map((id) => codexModelDef(id) as CodexCatalogModel),
		);
		const ids = merged.map((model) => model.id);
		if (ids.join(",") === registryCodexModelOrder.join(",")) return;
		registryCodexModelOrder = ids;
		// Alias slots are registered from our static list, so a model only the host knows about
		// would not be selectable on them. Re-register — but never over a live catalog, which is
		// authoritative for that specific account.
		for (const provider of registeredSlots) {
			if (classifyProvider(provider, config.qwenProvider) !== "openai-codex") continue;
			if (
				config.autoDiscoverModels &&
				codexModelCatalogByProvider.get(provider)?.models.length
			)
				continue;
			registerCodexCatalog(
				pi,
				provider,
				merged as Array<Record<string, unknown>>,
				numberedSlotBaseUrl(provider, "codex"),
			);
		}
	}

	async function fetchFreshCodexCatalog(
		ctx: any,
		provider: string,
	): Promise<CodexCatalogModel[]> {
		let entry = readAuthFile()[provider];
		if (!entry) throw new CodexCatalogFetchError(`${provider} has no stored credential`);
		const runFetch = () =>
			fetchCodexModelCatalog(entry, { clientVersion: VERSION });
		try {
			return await runFetch();
		} catch (error) {
			if (
				!(error instanceof CodexCatalogFetchError) ||
				error.status !== 401 ||
				!isRefreshable(provider)
			) {
				throw error;
			}
			const refreshed = await forceRefreshProvider(ctx, provider);
			if (refreshed.status !== "refreshed") throw error;
			entry = readAuthFile()[provider];
			if (!entry) throw error;
			return runFetch();
		}
	}

	/**
	 * Pull OpenAI's account-specific catalog and immediately replace every Codex alias model list.
	 * The backend's priority is authoritative; Pi's built-in registry and our static definitions are
	 * only an offline fallback. Catalog snapshots are credential-free and safe to persist.
	 */
	async function syncCodexModelCatalog(ctx: any, force = false) {
		if (!config.autoDiscoverModels) return;
		const auth = readAuthFile();
		const providers = Object.keys(auth).filter(
			(provider) =>
				classifyProvider(provider, config.qwenProvider) === "openai-codex" &&
				isEntryUsable(auth[provider]),
		);
		const registryFallback = mergeCodexModels(
			registryCodexModels(ctx),
			DEFAULT_CODEX_MODELS.map((id) => codexModelDef(id) as CodexCatalogModel),
		);
		let changed = false;
		await Promise.all(
			providers.map(async (provider) => {
				const cached = codexModelCatalogByProvider.get(provider);
				if (
					!force &&
					cached &&
					Date.now() - cached.fetchedAt < CODEX_MODEL_CATALOG_TTL_MS
				) {
					return;
				}
				try {
					const models = await fetchFreshCodexCatalog(ctx, provider);
					codexModelCatalogByProvider.set(provider, {
						fetchedAt: Date.now(),
						models,
					});
					changed = true;
					logEvent("model_catalog_refresh", {
						provider,
						models: models.map((model) => model.id).join(","),
					});
				} catch (error) {
					logEvent("model_catalog_error", {
						provider,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}),
		);

		const allKnown = mergeCodexModels(
			...providers.map(
				(provider) => codexModelCatalogByProvider.get(provider)?.models ?? [],
			),
			registryFallback,
		);
		discoveredCodexModelOrder = allKnown.map((model) => model.id);

		for (const provider of providers) {
			const cached = codexModelCatalogByProvider.get(provider)?.models;
			const models = cached?.length ? cached : registryFallback;
			registerCodexCatalog(
				pi,
				provider,
				models as Array<Record<string, unknown>>,
				provider === CODEX_BASE
					? "https://chatgpt.com/backend-api"
					: numberedSlotBaseUrl(provider, "codex"),
			);
		}
		// Also keep unauthenticated spare login slots current so a newly logged-in account can select
		// the new flagship before the next restart/session refresh.
		for (const provider of registeredSlots) {
			if (classifyProvider(provider, config.qwenProvider) !== "openai-codex") continue;
			if (providers.includes(provider)) continue;
			registerCodexCatalog(
				pi,
				provider,
				allKnown as Array<Record<string, unknown>>,
				numberedSlotBaseUrl(provider, "codex"),
			);
		}
		if (changed) persist();
		emitModelCatalogSnapshot(ctx);
		// Catalogs just changed while some providers may be hidden by only-active. Re-apply the
		// filter NOW so the stored hidden copies hold the FRESH lists — otherwise a manual switch
		// that lands before the next message_start would restore the stale pre-sync models.
		applyOnlyActiveFilter(ctx);
	}

	/**
	 * The full Ollama model id set the base provider and every cloned slot should expose:
	 * built-in flagship first, then the user's configured `models.json` ids, then the live
	 * Cloud catalog. Deduped, order-stable. Live ids win visibility without dropping the
	 * configured ones, so a user-pinned tag is never silently replaced.
	 */
	function ollamaRotationModelIds(): string[] {
		const ids = [...DEFAULT_OLLAMA_MODELS];
		for (const configured of configuredModelIds(OLLAMA_BASE)) {
			if (!ids.includes(configured)) ids.push(configured);
		}
		for (const discovered of discoveredOllamaModelIds) {
			if (!ids.includes(discovered)) ids.push(discovered);
		}
		return ids;
	}

	/**
	 * Pull Ollama Cloud's live catalog and re-register the base provider + every cloned slot
	 * with the merged set. Idempotent and cheap: a fresh fetch is bounded by OLLAMA_MODEL_CATALOG_TTL_MS
	 * and the TTL sweep only re-registers when the id set actually changed. Mirrors syncCodexModelCatalog
	 * but simpler — one API key, one account-agnostic catalog.
	 */
	async function syncOllamaModelCatalog(ctx: any, force = false) {
		if (!config.autoDiscoverModels || !config.includeOllama) return;
		const entry = readAuthFile()[OLLAMA_BASE];
		const key =
			entry && typeof entry.key === "string" && entry.key.length > 0
				? entry.key
				: undefined;
		if (!key) return; // no credential → nothing to discover, configured ids still serve
		if (
			!force &&
				ollamaCatalogFetchedAt &&
				Date.now() - ollamaCatalogFetchedAt < OLLAMA_MODEL_CATALOG_TTL_MS
		) {
			return;
		}
		try {
			const ids = await fetchOllamaCloudCatalog(key);
			discoveredOllamaModelIds = ids;
			ollamaCatalogFetchedAt = Date.now();
			logEvent("ollama_catalog_refresh", {
				models: ids.length,
				sample: ids.slice(0, 12).join(","),
			});
		} catch (error) {
			logEvent("ollama_catalog_error", {
				error: error instanceof Error ? error.message : String(error),
			});
			return; // keep the previous (or empty) discovered set; configured ids still serve
		}
		const models = ollamaRotationModelIds().map((m) => ollamaModelDef(m, OLLAMA_BASE));
		pi.registerProvider(OLLAMA_BASE, {
			name: "Ollama",
			baseUrl: OLLAMA_CLOUD_BASE_URL,
			api: "openai-completions" as any,
			apiKey: key,
			models: models as any,
		} as any);
		for (const provider of registeredSlots) {
			if (classifyProvider(provider, config.qwenProvider) !== "ollama") continue;
			const slotEntry = readAuthFile()[provider];
			const slotKey =
				slotEntry && typeof slotEntry.key === "string" && slotEntry.key.length > 0
					? slotEntry.key
					: undefined;
			if (!slotKey) continue;
			pi.registerProvider(provider, {
				name: `Ollama (${provider})`,
				baseUrl: OLLAMA_CLOUD_BASE_URL,
				api: "openai-completions" as any,
				apiKey: slotKey,
				models: ollamaRotationModelIds().map((m) => ollamaModelDef(m, provider)) as any,
			} as any);
		}
		// Same repair as the Codex sync: keep only-active hidden copies fresh immediately.
		applyOnlyActiveFilter(ctx);
	}

	function cachedUsage(provider: string): UsageSnapshot | undefined {
		const snapshot = usageByProvider.get(provider);
		if (!snapshot) return undefined;
		const entry = readAuthFile()[provider];
		const currentHash = entry ? credentialHash(entry) : undefined;
		if (snapshot.credentialHash && snapshot.credentialHash !== currentHash)
			return undefined;
		return snapshot;
	}

	function usageCacheTtl(provider: string): number {
		const family = usageFamily(provider);
		if (family === "anthropic") {
			return Math.max(config.usageRefreshMs, MIN_ANTHROPIC_USAGE_REFRESH_MS);
		}
		if (family === "ollama" || family === "cursor") {
			return Math.max(config.usageRefreshMs, 5 * 60_000);
		}
		return config.usageRefreshMs;
	}

	// Qwen/Alibaba publishes NO live quota endpoint (verified: every usage/billing path 404s and no
	// rate-limit headers come back), so a real "% left" is impossible. The honest, useful thing to
	// show instead is the account's live operational state from OUR OWN tracking: available now,
	// rate-limited until a known time (recorded from a caught 429), or needs re-login.
	function qwenLiveStatus(provider: string): string {
		if (isInvalidated(provider))
			return "needs re-login (/login → subscription → alibaba)";
		const now = Date.now();
		const until = providerRecoveryAt(provider, now);
		if (until > now) return `rate-limited · retry in ${formatDelay(until - now)}`;
		return "available · Alibaba exposes no quota API";
	}

	// For display only: Qwen carries no usage windows, so swap its plan text for the live status.
	function displayUsageSnapshot(snapshot: UsageSnapshot): UsageSnapshot {
		return snapshot.family === "qwen"
			? { ...snapshot, plan: qwenLiveStatus(snapshot.provider) }
			: snapshot;
	}

	/**
	 * How many OTHER accounts could take over right now.
	 *
	 * "This account is nearly out" is only half the information; the half that decides what to do
	 * is whether anywhere else is ready. Counted from bookkeeping already in memory — no probes,
	 * no reconciliation — because this runs on a footer timer, not on a decision.
	 */
	function readyElsewhereCount(ctx: any, current: string | undefined): number {
		const now = Date.now();
		return rotation.filter(
			(provider) =>
				provider !== current &&
				!isInvalidated(provider) &&
				providerHasUsableAuth(ctx, provider) &&
				providerRecoveryAt(provider, now) <= now,
		).length;
	}

	function updateUsageStatus(ctx: any, provider = ctx?.model?.provider) {
		if (typeof ctx?.ui?.setStatus !== "function") return;
		// Footer rendering touches host UI + formatting helpers; never let a render hiccup
		// (theme shape change, formatter edge case) bubble up and break the turn it runs in.
		try {
			if (!config.showUsage || !provider || !usageFamily(provider)) {
				ctx.ui.setStatus("multi-account-quota", undefined);
				return;
			}
			// Prefer the hash-verified snapshot, but for DISPLAY fall back to the last stored one even
			// if the OAuth token has since rotated (hash mismatch) — a slightly stale "% left" beats a
			// blank footer, which is what the user saw when Codex's token rotated between usage fetches.
			// Qwen may have no snapshot at all (nothing to fetch) — synthesize a bare one so its live
			// availability/rate-limit status still shows.
			const snapshot =
				cachedUsage(provider) ??
				usageByProvider.get(provider) ??
				(usageFamily(provider) === "qwen"
					? {
							provider,
							family: "qwen" as const,
							fetchedAt: Date.now(),
							plan: "",
						}
					: undefined);
			if (!snapshot) {
				ctx.ui.setStatus("multi-account-quota", undefined);
				return;
			}
			const display = displayUsageSnapshot(snapshot);
			const spare = readyElsewhereCount(ctx, provider);
			const text = `${formatUsageCompact(display)} | ${
				spare > 0 ? `+${spare} ready` : "no spare"
			}`;
			const color =
				snapshot.family === "qwen"
					? isInvalidated(provider)
						? "error"
						: providerRecoveryAt(provider) > Date.now()
							? "warning"
							: "success"
					: usageColor(display);
			// A theme.fg that throws (host theme API drift) must not blank the whole footer — always
			// fall back to plain text so setStatus is still called with something visible.
			let rendered: string = text;
			try {
				if (ctx.ui.theme?.fg) rendered = ctx.ui.theme.fg(color, text);
			} catch {
				rendered = text;
			}
			ctx.ui.setStatus("multi-account-quota", rendered);
		} catch {
			/* footer is cosmetic — a render error must not affect failover */
		}
	}

	function storeUsage(ctx: any, snapshot: UsageSnapshot) {
		usageByProvider.set(snapshot.provider, snapshot);
		usageErrors.delete(snapshot.provider);
		// AUTHORITATIVE PROACTIVE BENCH. If the account's own usage endpoint reports a hard block (a
		// window at >=100% with a future reset), record the cooldown NOW — even if the account never
		// threw a limit error and had no prior cooldown. Without this, a known-spent account (a
		// free-tier Codex slot maxed on its monthly window) stayed fully "available" for selection
		// until it was actively tried and failed, so failover kept landing on dead accounts one after
		// another instead of jumping straight to a live one. markExhausted caps the STORED value at the
		// live ceiling and fans it out to sibling slots on the same account; providerRecoveryAt still
		// reports the real reset from the live snapshot. Never benches an account with headroom
		// (cooldownMsFromUsage returns 0 while the primary window is < 100%).
		const blockMs = cooldownMsFromUsage(snapshot);
		if (blockMs !== undefined && blockMs > 0) {
			markExhausted(snapshot.provider, blockMs);
		} else if (blockMs === 0) {
			// A live account probe is allowed to contradict an older reset estimate. Plans can be
			// upgraded, credits can be purchased, and providers can restore capacity before the
			// previously advertised resetAt. Fresh headroom therefore clears the old cooldown; the
			// usage-untrusted guard inside applyUsageToCooldown still protects session limits that
			// the quota endpoint is known not to see.
			applyUsageToCooldown(snapshot.provider, snapshot, Date.now());
		}
		logEvent("usage_refresh", {
			provider: snapshot.provider,
			family: snapshot.family,
			plan: snapshot.plan ?? "unknown",
			primaryUsedPercent: snapshot.primary?.usedPercent ?? "unknown",
			blocked: blockMs !== undefined && blockMs > 0,
		});
		persist();
		updateUsageStatus(ctx);
	}

	async function fetchFreshUsage(
		ctx: any,
		provider: string,
	): Promise<UsageSnapshot> {
		let entry = readAuthFile()[provider];
		if (!entry)
			throw new UsageFetchError(`${provider} has no stored credential`);
		const runFetch = () =>
			fetchUsageSnapshot(provider, entry, {
				credentialHash: credentialHash(entry),
			});
		try {
			return await runFetch();
		} catch (error) {
			if (
				!(error instanceof UsageFetchError) ||
				error.status !== 401 ||
				!isRefreshable(provider)
			)
				throw error;
			const refreshed = await forceRefreshProvider(ctx, provider);
			if (refreshed.status !== "refreshed") throw error;
			entry = readAuthFile()[provider];
			if (!entry) throw error;
			return runFetch();
		}
	}

	async function refreshUsage(
		ctx: any,
		provider = ctx?.model?.provider,
		force = false,
		allowWhenHidden = false,
	): Promise<UsageSnapshot | undefined> {
		if ((!config.showUsage && !allowWhenHidden) || !provider || !usageFamily(provider)) {
			updateUsageStatus(ctx, provider);
			return undefined;
		}
		const cached = cachedUsage(provider);
		if (
			!force &&
			cached &&
			Date.now() - cached.fetchedAt < usageCacheTtl(provider)
		) {
			updateUsageStatus(ctx, provider);
			return cached;
		}
		const existing = usageFetches.get(provider);
		if (existing) {
			try {
				return await existing;
			} catch {
				updateUsageStatus(ctx, provider);
				return cached;
			}
		}
		const fetchPromise = fetchFreshUsage(ctx, provider);
		usageFetches.set(provider, fetchPromise);
		try {
			const snapshot = await fetchPromise;
			storeUsage(ctx, snapshot);
			return snapshot;
		} catch (error) {
			usageErrors.set(
				provider,
				error instanceof Error ? error.message : String(error),
			);
			updateUsageStatus(ctx, provider);
			return cached;
		} finally {
			usageFetches.delete(provider);
		}
	}

	/**
	 * Refresh every authenticated account independently, not just the account currently selected
	 * in the session. This is what detects an early quota restoration, a purchased credit balance,
	 * or a Free -> Plus/Pro plan upgrade while the account is benched by an older 100% snapshot.
	 *
	 * refreshUsage() already applies a per-family TTL and deduplicates in-flight requests, so calling
	 * this from the status timer is cheap: network traffic occurs only when an account's own snapshot
	 * is stale. Qwen/Cursor use honest capability-only snapshots because they expose no quota API.
	 */
	async function refreshRotationUsage(ctx: any, force = false) {
		if (!config.showUsage) {
			updateUsageStatus(ctx);
			return;
		}
		const providers = [
			...new Set(
				rotation.filter(
					(provider) =>
						!!usageFamily(provider) && providerHasUsableAuth(ctx, provider),
				),
			),
		];
		await Promise.all(
			providers.map((provider) => refreshUsage(ctx, provider, force)),
		);
		updateUsageStatus(ctx);
	}

	function accountUsageCell(
		snapshot: UsageSnapshot | undefined,
		position: "primary" | "secondary",
		now: number,
	): string {
		const window = snapshot?.[position];
		if (!snapshot || !window) return "—";
		return `${windowLabel(window, snapshot.family, position)} ${remainingPercent(window)}%/${formatResetDuration(window.resetAt, now)}`;
	}

	function renderAccountTable(ctx: any): string {
		refreshDiscovery(false, ctx);
		const auth = readAuthFile();
		const ordered = [
			...rotation,
			...Object.keys(auth)
				.filter((provider) => !rotation.includes(provider))
				.sort((a, b) => a.localeCompare(b)),
		];
		const duplicateOf = new Map(
			duplicateSlots.map(({ duplicate, primary }) => [duplicate, primary]),
		);
		const unconfigured = new Set(unconfiguredRotationMembers(ctx));
		const now = Date.now();
		const rows = ordered.map((provider) => {
			const entry = auth[provider];
			const snapshot = cachedUsage(provider);
			const account = snapshot?.account ?? "—";
			const alias =
				snapshot?.account && snapshot.account.includes("@")
					? snapshot.account.slice(0, snapshot.account.indexOf("@"))
					: snapshot?.account ?? "—";
			const duplicate = duplicateOf.get(provider);
			const recoveryAt = providerRecoveryAt(provider, now);
			let status: string;
			if (!entry || !isEntryUsable(entry)) status = "unavailable · no credential";
			else if (isInvalidated(provider)) status = "unavailable · re-login";
			else if (duplicate) status = `duplicate → ${duplicate}`;
			else if (unconfigured.has(provider)) status = "unavailable · no models";
			else if (recoveryAt > now)
				status = `cooldown ${formatResetDuration(recoveryAt, now)}`;
			else if (usageErrors.has(provider)) status = "ready · usage unavailable";
			else status = "ready";
			return [
				provider,
				alias,
				account,
				snapshot?.plan ?? "—",
				accountUsageCell(snapshot, "primary", now),
				accountUsageCell(snapshot, "secondary", now),
				status,
			];
		});
		if (rows.length === 0) {
			return "pi-multi-account accounts: no configured accounts in auth.json";
		}
		const header = ["Slot", "Alias", "Account", "Plan", "Primary", "Secondary", "Status"];
		const widths = header.map((title, column) =>
			Math.max(title.length, ...rows.map((row) => row[column].length)),
		);
		const line = (row: string[]) =>
			row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd();
		return [
			"pi-multi-account accounts — provider metadata only; — = not reported",
			line(header),
			line(widths.map((width) => "-".repeat(width))),
			...rows.map(line),
			"Use /multi-account accounts refresh to refresh every supported account explicitly.",
		].join("\n");
	}

	function clearUsageStatusTimer() {
		if (!usageStatusTimer) return;
		clearInterval(usageStatusTimer);
		usageStatusTimer = undefined;
	}

	function startUsageStatusTimer(ctx: any) {
		clearUsageStatusTimer();
		// A delegated child neither displays the interactive footer nor owns fleet metadata. One
		// poller per parallel child would multiply usage/catalog traffic for no routing benefit.
		if (subagentChild) return;
		if (!config.showUsage && !config.autoDiscoverModels) {
			updateUsageStatus(ctx);
			return;
		}
		usageStatusTimer = setInterval(() => {
			runBackground("rotation metadata refresh", ctx, async () => {
				await refreshRotationUsage(ctx);
				// Re-registering provider models is safe while idle and avoids touching the registry in
				// the middle of a streaming request. The five-minute catalog TTL keeps this sweep cheap.
				if (ctx?.isIdle?.() !== false) await syncCodexModelCatalog(ctx);
				if (ctx?.isIdle?.() !== false) await syncOllamaModelCatalog(ctx);
			});
		}, config.usageStatusRefreshMs);
		(usageStatusTimer as any).unref?.();
	}

	/** A successful response → this account's auth is fine; clear its 401 streak. */
	function noteAuthSuccess(provider: string, modelId?: string) {
		// A real success proves the account works right now → the usage reading was not lying; reset
		// the limit-error streak and re-trust usage for this provider.
		limitStreakByProvider.delete(provider);
		// It answered, so whatever its meter said is beside the point: give it its reprieve back.
		// Distrust is not permanent: a real success is the only evidence that outranks the refusal
		// that created it, and it must be written down too or a restart would resurrect the bench.
		let changed = usageUntrustedUntilByProvider.delete(provider);
		changed = authFailures.delete(provider) || changed;
		changed = exhaustedUntilByProvider.delete(provider) || changed;
		changed = invalidatedByProvider.delete(provider) || changed;
		if (modelId)
			changed = exhaustedUntilByModel.delete(ref(provider, modelId)) || changed;
		if (changed) persist();
	}

	/**
	 * Handle a 401/auth failure WITHOUT nuking an account that just needs a token refresh.
	 * Non-refreshable (API key): historically a 401 was marked fatal at once, but in practice
	 * Ollama Cloud / Alibaba / OpenRouter return 401 transiently under load, or the key rotates
	 * on the server side without the client knowing. Only the explicit terminal patterns
	 * ("invalid api key", "incorrect api key", "revoked") kill the slot now; a bare 401 gets a
	 * transient cooldown and the same consecutive-failure accounting as OAuth, so a momentary
	 * blip no longer removes a working key for a year. However, repeated 401s with the SAME key
	 * (same hash) are not a transient blip for API-key providers — the key is permanently
	 * invalid. After MAX_SAME_KEY_AUTH_FAILURES consecutive same-key failures, the slot is
	 * invalidated so the user is told to re-login instead of looping on a 1-minute cooldown
	 * forever.
	 * Refreshable (OAuth): only a 401 on a *rotated* token — proof Pi actually refreshed and the NEW
	 * token still failed — counts toward the kill threshold. Repeated 401s on the SAME token mean the
	 * refresh isn't reaching the wire (a refresh/config fault, e.g. an alias that dropped the refreshed
	 * access token), which is NEVER proof the account is revoked; those only re-arm the transient
	 * cooldown so the next call keeps a chance to refresh. Only after MAX_CONSECUTIVE_AUTH_FAILURES
	 * distinct refreshed tokens fail do we mark it dead-until-relogin.
	 * Returns true if the account was permanently invalidated.
	 */
	function markAuthFailure(provider: string, reason: string): boolean {
		if (patternMatch(reason, TERMINAL_AUTH_ERROR_PATTERNS)) {
			authFailures.delete(provider);
			markInvalid(provider, reason);
			return true;
		}
		const entry = readAuthFile()[provider];
		const hash = (entry ? credentialHash(entry) : undefined) ?? "";
		const prev = authFailures.get(provider);
		if (prev && prev.hash === hash) {
			// Same token failed again → Pi's refresh never reached the wire, or (for API-key
			// providers) the same key failed again. For OAuth providers this is likely a refresh
			// fault (the refresh didn't reach the wire), so we keep the account recoverable.
			// For non-refreshable (API-key) providers, the same key failing repeatedly is NOT a
			// transient blip — the key is permanently invalid. Advance toward invalidation so
			// the user is told to re-login instead of looping on a 1-minute cooldown forever.
			if (!isRefreshable(provider)) {
				const distinct = (prev.distinct ?? 0) + 1;
				if (distinct >= MAX_SAME_KEY_AUTH_FAILURES) {
					authFailures.delete(provider);
					markInvalid(provider, `${reason} (after ${distinct} same-key 401s)`);
					return true;
				}
				authFailures.set(provider, { hash, distinct });
			}
			markExhausted(provider, TRANSIENT_AUTH_COOLDOWN_MS);
			return false;
		}
		// First failure, or the token rotated since the last 401 (Pi refreshed and it STILL failed).
		const distinct = (prev?.distinct ?? 0) + 1;
		if (distinct >= MAX_CONSECUTIVE_AUTH_FAILURES) {
			authFailures.delete(provider);
			markInvalid(
				provider,
				`${reason} (after ${distinct} refreshed-token 401s)`,
			);
			return true;
		}
		authFailures.set(provider, { hash, distinct });
		// Transient: brief cooldown so selection skips it for a moment; Pi refreshes on next use.
		markExhausted(provider, TRANSIENT_AUTH_COOLDOWN_MS);
		return false;
	}

	// ----- cooldowns --------------------------------------------------------

	function pruneCooldowns() {
		const now = Date.now();
		let changed = false;
		const ceiling = now + MAX_LIVE_COOLDOWN_MS;
		for (const [provider, until] of exhaustedUntilByProvider) {
			if (until <= now && !isInvalidated(provider)) {
				exhaustedUntilByProvider.delete(provider);
				changed = true;
			} else if (until > ceiling) {
				// A far-future cooldown (mis-parsed long/rolling reset) never gets re-probed on its
				// own — cooling-down accounts are skipped. Clamp it so the account is retried at the
				// ceiling and usage reconciliation can free it the moment its short window has headroom.
				exhaustedUntilByProvider.set(provider, ceiling);
				changed = true;
			}
		}
		for (const [model, until] of exhaustedUntilByModel) {
			if (until <= now) {
				exhaustedUntilByModel.delete(model);
				changed = true;
			}
		}
		if (changed) persist();
	}

	function isTransientPendingReason(reason: string) {
		return reason.startsWith(TRANSIENT_PENDING_PREFIX);
	}

	// A "still busy" auto-retry is a timing issue, not a model failure: resume the SAME model,
	// never rotate to a sibling model/account (which would silently downgrade it).
	function isBusyRetryPendingReason(reason: string) {
		return reason === BUSY_RETRY_REASON;
	}

	// Reasons where the source model is healthy and must be resumed as-is — never downgraded.
	function isSameModelResumeReason(reason: string) {
		return isTransientPendingReason(reason) || isBusyRetryPendingReason(reason);
	}

	function isAuthPendingReason(reason: string) {
		const lower = reason.toLowerCase();
		return (
			lower.includes("auth invalid") ||
			lower.includes("auth failure") ||
			lower.includes("invalid api-key") ||
			lower.includes("invalid api key")
		);
	}

	/** When does this provider become usable again? Uses recorded cooldown AND fresh usage. */
	// True while a provider's usage-% reading is distrusted because a repeat limit error proved it
	// does not reflect the account's real (session/rate) limit. See LIMIT_STREAK_WINDOW_MS.
	function usageUntrusted(provider: string, now = Date.now()): boolean {
		return (usageUntrustedUntilByProvider.get(provider) ?? 0) > now;
	}

	// Record a limit error for a provider and return the consecutive streak. A second error within
	// LIMIT_STREAK_WINDOW_MS (no success reset in between) flips the account's usage reading to
	// "distrusted" so its real cooldown can no longer be cleared by a lying "usage says free".
	function noteLimitError(provider: string, now = Date.now()): number {
		const prev = limitStreakByProvider.get(provider);
		const count =
			prev && now - prev.lastAt < LIMIT_STREAK_WINDOW_MS ? prev.count + 1 : 1;
		limitStreakByProvider.set(provider, { count, lastAt: now });
		if (count >= 2) markUsageUntrusted(provider, now);
		return count;
	}

	/**
	 * Stop believing this provider's usage-% reading for a while, and write that down.
	 *
	 * The distinction that matters: a used-percentage is a FORECAST about one quota window, and
	 * that window cannot see a session or plan limit. A refusal is an OBSERVATION that just
	 * happened. When they disagree, the observation is the one that was actually measured — so it
	 * wins, and it keeps winning across restarts until the account proves otherwise by succeeding.
	 */
	function markUsageUntrusted(provider: string, now = Date.now()) {
		const until = now + USAGE_UNTRUSTED_MS;
		if ((usageUntrustedUntilByProvider.get(provider) ?? 0) >= until) return;
		usageUntrustedUntilByProvider.set(provider, until);
		persist();
	}

	/** True when a fresh snapshot carries the provider's own "usable right now" verdict. */
	function isConfirmedAvailable(provider: string, now = Date.now()): boolean {
		const cached = usageByProvider.get(provider);
		return (
			!!cached &&
			cached.serviceable === true &&
			now - cached.fetchedAt < usageCacheTtl(provider)
		);
	}

	function providerRecoveryAt(
		provider: string,
		now = Date.now(),
		options: { ignoreCeiling?: boolean } = {},
	): number {
		// Nothing may push the next attempt beyond the recheck ceiling. Providers refresh quota
		// windows early and unannounced, AND resize the windows themselves — so a reset timestamp
		// is a forecast and a used-percentage is a fraction whose denominator can change under us.
		// Neither is evidence about the future. Capping here is what converts this extension from
		// predicting availability to verifying it: worst case we ask again in `maxRecheckIntervalMs`
		// and the account itself answers. A refusal costs no tokens, so asking is close to free.
		//
		// Applied to the usage FORECAST only. A cooldown we recorded ourselves was already capped
		// when it was written (see markExhausted).
		//
		// The ceiling is anchored to when the snapshot was TAKEN, never to `now`: an offset from
		// `now` is recomputed on every call, so it stays permanently in the future and never
		// elapses. Anchoring says what we actually mean — this reading is worth believing for
		// maxRecheckIntervalMs after we took it, and then the account itself gets asked again.
		const capped = (at: number, takenAt: number) =>
			options.ignoreCeiling
				? at
				: Math.max(now, Math.min(at, takenAt + config.maxRecheckIntervalMs));
		let at = Math.max(now, exhaustedUntilByProvider.get(provider) ?? now);
		const cached = usageByProvider.get(provider);
		if (cached) {
			const fresh = now - cached.fetchedAt < usageCacheTtl(provider);
			// The provider's OWN verdict, when it states one, outranks every derived number here —
			// including a cooldown we recorded ourselves and the distrust we place on a meter that
			// once lied. Those exist precisely because a percentage is a forecast; `serviceable` is
			// not a forecast, it is the account answering "can I be used right now". Ignoring it is
			// what left two accounts benched for hours after ChatGPT had already gone back to
			// answering `allowed: true` for them, which from the outside looks exactly like an
			// extension that cannot see accounts that freed up.
			//
			// Only while FRESH: a verdict is a statement about the moment it was taken, so a stale
			// "yes" must not clear a cooldown recorded after it, and a stale "no" must not outlive
			// the recheck ceiling that governs every other stale reading.
			if (fresh && cached.serviceable === true) return now;
			if (fresh && cached.serviceable === false)
				return capped(
					Math.max(at, now + config.maxRecheckIntervalMs),
					cached.fetchedAt,
				);
			const usageMs = cooldownMsFromUsage(cached, now);
			// A HARD BLOCK — a usage window at >=100% whose reset is still in the future — is
			// authoritative ground truth REGARDLESS of snapshot age: a maxed 30-day (or 5h) window
			// cannot have "un-maxed" itself in the minutes since we last probed, and cooldownMsFromUsage
			// already drops any window whose reset has passed. So we trust it even when stale. This is
			// the fix for the real failure mode: a genuinely-spent account (e.g. a free-tier Codex slot
			// maxed on its monthly window) that never threw an error yet and had no recorded cooldown
			// was treated as "available" and selected as the failover target — so failover kept landing
			// on dead accounts instead of advancing to a live Qwen/Ollama one.
			if (usageMs !== undefined && usageMs > 0)
				return capped(now + usageMs, cached.fetchedAt);
			// "Available now" (usageMs === 0) is only trusted while FRESH — a stale pre-limit reading
			// must never clear a real cooldown early — AND only while usage is still trusted for this
			// provider. A session/rate-limited account keeps 429ing while its quota window shows
			// headroom; once that has been proven (usageUntrusted), we respect the recorded cooldown
			// (`at`) instead of falsely reporting "recovered now" and hot-looping a ~1s retry.
			if (fresh && usageMs === 0)
				return usageUntrusted(provider, now) ? at : now;
		}
		return at;
	}

	/** Human-readable summary for /multi-account status — earliest account to recover. */
	function nextRecoveryStatus(ctx: any): string {
		const now = Date.now();
		reconcileCooldownsFromUsage(ctx);
		const providers = rotation.filter((p) => !isInvalidated(p));
		if (providers.length === 0)
			return "none — no authenticated accounts in rotation";

		const cooling = providers
			.map((provider) => ({ provider, at: providerRecoveryAt(provider, now) }))
			.filter(({ at }) => at > now + 500)
			.sort((a, b) => a.at - b.at);

		if (cooling.length === 0) return "all rotation accounts available now";

		const parts: string[] = [];
		const first = cooling[0];
		parts.push(
			`first: ${first.provider} in ~${formatDelay(first.at - now)} (${formatUntil(first.at)})`,
		);
		if (cooling.length > 1) {
			const also = cooling
				.slice(1, 4)
				.map((r) => `${r.provider} ~${formatDelay(r.at - now)}`)
				.join(", ");
			parts.push(`then: ${also}${cooling.length > 4 ? ", …" : ""}`);
		}
		if (hasPendingResume()) {
			const wake = nextPendingWakeDelayMs();
			if (wake !== undefined)
				parts.push(`auto-resume check in ~${formatDelay(wake)}`);
		} else if (queuedUserInputs.length > 0) {
			const wake = nextModelAvailabilityDelayMs(ctx);
			if (wake !== undefined)
				parts.push(`queued input send in ~${formatDelay(wake)}`);
		}
		return parts.join(" · ");
	}

	async function resolveLimitCooldownMs(
		ctx: any,
		provider: string,
		errorText: string,
	): Promise<number> {
		const now = Date.now();
		// Count this limit error. The streak still drives longer-horizon behaviour; the immediate
		// decision below no longer waits for it.
		noteLimitError(provider, now);
		const statedMs = cooldownFromErrorText(errorText);
		// The provider named a concrete recovery horizon while our usage reading for this account
		// claims it is free right now. Those cannot both be true, and only one of them was
		// measured: the stated horizon came from the account being refused just now, the
		// percentage is a forecast about a quota window that cannot see a session or plan limit.
		// So the reading is wrong for this account and must stop being able to wipe the bench we
		// are about to set — that clearing is exactly what walked rotation back onto a spent
		// account seconds after it refused.
		//
		// Deliberately narrow. A bare throttle with no stated horizon ("429 rate limit") still
		// defers to the meter, because there the meter really is the better evidence and the
		// account may well be usable again immediately. Only an explicit horizon longer than the
		// floor counts as the provider contradicting the reading. Checked against the CACHED
		// snapshot because the live refresh below is best-effort, while the reconciliation pass
		// that did the clearing runs off the cache.
		const knownUsage = usageByProvider.get(provider);
		if (
			typeof statedMs === "number" &&
			statedMs > SESSION_LIMIT_FLOOR_MS &&
			knownUsage &&
			cooldownMsFromUsage(knownUsage, now) === 0
		) {
			markUsageUntrusted(provider, now);
		}
		const hintedCooldowns = [
			responseCooldownHints.get(provider),
			statedMs,
		].filter(
			(value): value is number => typeof value === "number" && value > 0,
		);
		const snapshot = await refreshUsage(ctx, provider, true);
		if (snapshot) {
			applyUsageToCooldown(provider, snapshot, now);
			const usageMs = cooldownMsFromUsage(snapshot);
			// Fresh usage is normally ground truth: a maxed long/rolling window must not evict an
			// account whose short window has already freed.
			//
			// But here the account has JUST REFUSED while the meter claims headroom
			// (usageMs === 0). That contradiction is itself the evidence — this account's real
			// limit is invisible to the quota window, so the reading is wrong for it right now.
			// Returning 0 on that reading is what put the user straight back onto a spent account:
			// the meter read 98%, the cooldown was wiped, rotation walked back in, and the same
			// refusal came again. Believing it once was already once too many, so the first
			// contradiction distrusts the meter and records a short real floor instead.
			//
			// The floor is deliberately small: if the short window truly had freed, the account
			// simply returns a few minutes later rather than being benched on a forecast.
			if (usageMs === 0) {
				markUsageUntrusted(provider, now);
				hintedCooldowns.push(SESSION_LIMIT_FLOOR_MS);
			} else if (usageMs !== undefined && usageMs > 0) {
				hintedCooldowns.push(usageMs);
			}
		}
		if (hintedCooldowns.length === 0) return config.cooldownMs;
		// Backstop: never let a single live estimate lock an account beyond the ceiling.
		return Math.min(Math.max(...hintedCooldowns), MAX_LIVE_COOLDOWN_MS);
	}

	function providersSharingAccount(provider: string): string[] {
		const auth = readAuthFile();
		const identity = auth[provider]
			? accountIdentity(auth[provider])
			: undefined;
		if (!identity) return [provider];
		const shared = Object.keys(auth).filter((p) => {
			const e = auth[p];
			return e && accountIdentity(e) === identity;
		});
		return shared.length > 0 ? shared : [provider];
	}

	/**
	 * Whether this account's availability can be checked WITHOUT spending a user turn.
	 *
	 * Codex, Anthropic, Ollama and Cursor all publish something we can poll in the background.
	 * Kimi and Qwen publish nothing, so their only "probe" is a real request that costs the user
	 * the turn it lands on.
	 */
	function hasCheapAvailabilityProbe(provider: string): boolean {
		const family = usageFamily(provider);
		return (
			family === "codex" ||
			family === "anthropic" ||
			family === "ollama" ||
			family === "cursor"
		);
	}

	function markExhausted(provider: string, cooldownMs: number) {
		if (cooldownMs <= 0) return; // killed accounts are in invalidatedByProvider, not cooldowns
		// This is the moment the account was last actually asked, and it is what the recheck
		// ceiling is measured from. Without it the ceiling has no anchor and can never elapse.
		setLastProbe(provider);
		// Invariant backstop: no LIVE cooldown may exceed the recheck ceiling, regardless of what
		// the provider predicted. A reset timestamp is a forecast — providers refresh windows early
		// and unannounced and resize the windows themselves — so it may order the queue but must
		// never bench an account for hours or weeks. At the ceiling we simply ask again; a refusal
		// costs no tokens, and only the account itself can prove it is still spent.
		//
		// "Costs no tokens" is true only where asking is a background usage probe. For an account
		// with NO usage endpoint — Kimi answers 404 on every documented path, Qwen exposes none —
		// the only way to ask is to spend a real user turn: the message lands on the spent account,
		// is refused, and is bounced onward. Re-asking that way every ten minutes, of an account
		// that has just said its quota returns in the next billing cycle, is precisely the
		// thrashing the ceiling exists to prevent. So the ceiling applies where re-probing is
		// cheap, and the recorded cooldown stands where it is not.
		const until =
			Date.now() +
			Math.min(
				Math.max(cooldownMs, 1000),
				hasCheapAvailabilityProbe(provider)
					? config.maxRecheckIntervalMs
					: Number.POSITIVE_INFINITY,
				MAX_LIVE_COOLDOWN_MS,
			);
		for (const candidate of providersSharingAccount(provider)) {
			exhaustedUntilByProvider.set(
				candidate,
				Math.max(exhaustedUntilByProvider.get(candidate) ?? 0, until),
			);
		}
		persist();
	}

	function markModelExhausted(model: any, cooldownMs: number) {
		if (!model?.provider || !model?.id) return;
		const key = ref(model.provider, model.id);
		const until = Date.now() + Math.max(cooldownMs, 1000);
		exhaustedUntilByModel.set(
			key,
			Math.max(exhaustedUntilByModel.get(key) ?? 0, until),
		);
		persist();
	}

	/** Snap a recorded cooldown to what fresh usage actually reports for the account. */
	function applyUsageToCooldown(
		provider: string,
		snapshot: UsageSnapshot,
		now: number,
	) {
		// The account's own verdict settles it in both directions, before any arithmetic on
		// windows. "Usable" retires the bench AND the distrust: that distrust was recorded about
		// the METER after a refusal contradicted it, and the account has now answered for itself,
		// which is the evidence the distrust was waiting for. Leaving the record in place while
		// merely bypassing it at selection time keeps the account looking spent in `status` and
		// keeps the resume timer waiting on a bench that no longer means anything.
		if (snapshot.serviceable === true) {
			let changed = exhaustedUntilByProvider.delete(provider);
			changed = usageUntrustedUntilByProvider.delete(provider) || changed;
			if (changed) persist();
			return;
		}
		// "Blocked" is the account refusing outright; a window with headroom does not overrule it.
		if (snapshot.serviceable === false) return;
		const realMs = cooldownMsFromUsage(snapshot, now);
		if (realMs === undefined) return;
		const recorded = exhaustedUntilByProvider.get(provider) ?? 0;
		if (realMs <= 0) {
			// Usage says the account is free again — drop the cooldown so resume can pick it up,
			// even if our original estimate hasn't expired yet. But NOT when usage has been proven
			// unreliable for this account (a session/rate limit the quota window can't see): clearing
			// there would immediately re-select a still-maxed account and loop.
			if (usageUntrusted(provider, now)) return;
			if (exhaustedUntilByProvider.delete(provider)) persist();
			return;
		}
		const realUntil = now + realMs;
		// Only ever SHORTEN here: error-derived cooldowns may be more pessimistic than reality,
		// but never extend a cooldown from a usage probe.
		if (recorded > now && realUntil < recorded) {
			exhaustedUntilByProvider.set(provider, realUntil);
			persist();
		}
	}

	/**
	 * While paused, re-derive the real recovery time of every cooling account from its usage
	 * endpoint. This is what makes the FIRST account to actually recover resume the work, instead
	 * of waiting on a recorded estimate that may be longer than the server's true reset.
	 *
	 * Non-blocking by design: it kicks a background usage refresh (a no-op unless usage display is
	 * enabled) and acts only on a FRESH cached snapshot, so resume is never stalled on a slow probe
	 * and a stale pre-limit reading can never clear a cooldown prematurely.
	 */
	function reconcileCooldownsFromUsage(ctx: any) {
		const now = Date.now();
		for (const [provider, until] of [...exhaustedUntilByProvider.entries()]) {
			if (until <= now || isInvalidated(provider) || !usageFamily(provider))
				continue;
			runBackground("cooldown reconcile usage", ctx, () =>
				refreshUsage(ctx, provider, true),
			);
			const cached = usageByProvider.get(provider);
			if (cached && now - cached.fetchedAt < usageCacheTtl(provider))
				applyUsageToCooldown(provider, cached, now);
		}
	}

	// ----- discovery & dynamic rotation -------------------------------------

	function discoverRotation(auth: Record<string, AuthEntry>): string[] {
		const byFamily: Record<ProviderFamily, string[]> = {
			anthropic: [],
			"openai-codex": [],
			"kimi-coding": [],
			cursor: [],
			qwen: [],
			ollama: [],
		};
		for (const [id, entry] of Object.entries(auth)) {
			const family = classifyProvider(id, config.qwenProvider);
			if (!family) continue;
			if (family === "qwen" && !config.includeQwen) continue;
			if (family === "ollama" && !config.includeOllama) continue;
			if (family === "cursor" && !config.includeCursor) continue;
			if (!isEntryUsable(entry)) continue;
			if (isInvalidated(id)) continue;
			byFamily[family].push(id);
		}
		// Sort each family base-first, then account-2,3,... and dedupe real accounts.
		const order = config.providerOrder.length
			? config.providerOrder
			: DEFAULT_PROVIDER_ORDER;
		const seenIdentity = new Set<string>();
		const result: string[] = [];
		for (const family of order) {
			const ids = byFamily[family].sort((a, b) => slotIndex(a) - slotIndex(b));
			for (const id of ids) {
				const identity = accountIdentity(auth[id]);
				if (identity && seenIdentity.has(identity)) continue; // same account in two slots
				if (identity) seenIdentity.add(identity);
				result.push(id);
			}
		}
		// Everything else the user is logged in to. Recognising five families by name and dropping
		// the rest meant a machine with fourteen accounts rotated across eight and silently left
		// six — several hundred models — unused, with nothing anywhere saying so. A provider does
		// not need to be understood in detail to be usable: if Pi can call it, it can carry work.
		//
		// They go LAST, after every managed family. A managed account has quota telemetry, OAuth
		// refresh and a live catalogue; an unmanaged one is a blind spend, so it is the account of
		// last resort rather than a peer. A provider Pi exposes no model for contributes no
		// candidate at selection time and is skipped there, so nothing is routed into a void.
		if (config.includeOtherProviders) {
			for (const [id, entry] of Object.entries(auth)) {
				if (classifyProvider(id, config.qwenProvider)) continue;
				if (!isEntryUsable(entry) || isInvalidated(id)) continue;
				const identity = accountIdentity(entry);
				if (identity && seenIdentity.has(identity)) continue;
				if (identity) seenIdentity.add(identity);
				result.push(id);
			}
		}
		return result;
	}

	/** Rotation members this extension carries but cannot measure — no quota endpoint, no OAuth. */
	function unmanagedRotationMembers(): string[] {
		return rotation.filter(
			(id) => !classifyProvider(id, config.qwenProvider),
		);
	}

	/**
	 * Rotation members the host knows no model for.
	 *
	 * Being in the rotation is not the same as being usable: selection asks the host registry for
	 * this provider's models and skips an account that yields none. Such an account was listed
	 * beside working ones with nothing to distinguish it, so it read as in service while being
	 * unreachable — the fix is to name it as needing configuration, not to hide it, because
	 * hiding it is how the original silent drop looked from the outside.
	 *
	 * Specially-managed families are exempt: this extension registers their slots itself, so a
	 * momentarily empty registry says nothing about whether they work.
	 */
	function unconfiguredRotationMembers(ctx: any): string[] {
		if (!ctx?.modelRegistry?.getAll) return [];
		return rotation.filter((id) => {
			if (classifyProvider(id, config.qwenProvider)) return false;
			return hostModelIdsFor(ctx, id).length === 0;
		});
	}

	function discoverDuplicateSlots(auth: Record<string, AuthEntry>) {
		const primaryByIdentity = new Map<string, string>();
		const duplicates: Array<{ duplicate: string; primary: string }> = [];
		for (const id of Object.keys(auth).sort(
			(a, b) => slotIndex(a) - slotIndex(b),
		)) {
			const family = classifyProvider(id, config.qwenProvider);
			if (!family || !isEntryUsable(auth[id])) continue;
			const identity = accountIdentity(auth[id]);
			if (!identity) continue;
			const primary = primaryByIdentity.get(identity);
			if (primary) duplicates.push({ duplicate: id, primary });
			else primaryByIdentity.set(identity, id);
		}
		return duplicates;
	}

	/**
	 * `explicit` = the user asked for Cursor by name (`/multi-account add cursor`), which is
	 * the ONLY case where a missing provider clone is worth a warning. On the automatic path
	 * a not-installed Cursor provider is a silent no-op: `includeCursor` defaults to true, so
	 * warning there nagged every user who never wanted Cursor at all.
	 */
	async function refreshCursorSlots(
		auth: Record<string, AuthEntry>,
		ctx?: any,
		explicit = false,
	) {
		if (!config.includeCursor) return;
		if (!explicit && !isCursorProviderInstalled()) return;
		const slotIds = [
			...new Set([
				...Object.keys(auth).filter(
					(id) =>
						isCursorProviderId(id) &&
						id !== CURSOR_BASE &&
						isEntryUsable(auth[id]),
				),
				...[...registeredSlots].filter(
					(id) => isCursorProviderId(id) && id !== CURSOR_BASE,
				),
			]),
		].sort((a, b) => slotIndex(a) - slotIndex(b));
		// Cursor lives in a separate repo we do not control, on whatever Node the user runs.
		// A version-incompatible clone (e.g. a JSON import that newer Node rejects) must never
		// escape as a rejected promise: on the automatic path this is fire-and-forget, so it
		// would surface as an unhandled rejection, and inside session_start it aborted the rest
		// of the handler — skipping the pending-resume reset that must run on every session.
		// Cursor is optional; nothing else may be lost because it failed.
		try {
			await setupCursorSubscription(pi, {
				readAuth: readAuthFile,
				rejectDuplicateLogin: (slot, creds) => rejectDuplicateLogin(slot, creds),
				slotIds,
				notify: (message, level) => ctx?.ui?.notify?.(message, level),
				log: (kind, data) => logEvent(kind, data),
				onProvision: (slots, port, models) => {
					// Registration above is process-local and remains useful in a delegated child. The
					// files below are shared with its parent and only the canonical publisher may touch
					// them; otherwise a short-lived child leaves a dead Cursor route behind.
					if (!ownsSharedChildPublication()) return;
					// models.json entries point at the running proxy, so a bare child
					// `pi -p` resolves cursor/* while any parent Pi process is alive.
					//
					// The placeholder key is what makes that resolution USABLE. Pi refuses a
					// provider it has no credential for, and Cursor's credential is an OAuth
					// token this extension holds — a child cannot read it. The proxy already
					// treats this exact value as "no token on the request" and falls back to
					// the base slot's stored credential, so the child authenticates to a
					// LOCAL socket with a non-secret string and the real token never leaves
					// the parent. Without it a provisioned slot reports
					// `credentials_not_configured` and every child call dies at auth.
					for (const slot of slots) {
						provisionNativeSlot(slot, {
							api: "openai-completions",
							baseUrl: `http://127.0.0.1:${port}/v1`,
							apiKey: CURSOR_PROXY_PLACEHOLDER_KEY,
							models,
						});
					}
					// Same trap as numbered Anthropic/Codex: Pi ignores a models.json placeholder
					// while an OAuth blob sits under the same key. Measured 2026-08-30 after restart:
					// `pi -p --no-extensions --model cursor/cursor-grok-4.6` → "No API key found for cursor".
					shadowChildFacingAuth(slots);
				},
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			logEvent("cursor_setup_failed", { reason });
			// Once per process: the user cloned it deliberately, so silence would be wrong —
			// but repeating it on every discovery pass would be nagging. The flag is set only
			// once a notice was really delivered: the first attempt runs from discovery, which
			// has no ctx and therefore no UI to notify, and marking it "notified" there would
			// swallow the message for the session_start attempt that can actually show it.
			if (!cursorSetupFailureNotified && typeof ctx?.ui?.notify === "function") {
				cursorSetupFailureNotified = true;
				ctx.ui.notify(
					`pi-multi-account: built-in Cursor support failed to load, so Cursor accounts are unavailable this session (${reason.slice(0, 160)}). Everything else keeps working; set "includeCursor": false in ${CONFIG_PATH} to silence this.`,
					"warning",
				);
			}
		}
	}

	/** Register authed alias slots plus one spare per family for the next interactive /login. */
	function syncRegisteredSlots(auth: Record<string, AuthEntry>, ctx?: any) {
		// Cursor is the one family whose provider lives in a separate, optional repo. Unlike
		// anthropic/codex/qwen/ollama — which only ever create slots backed by a real auth
		// entry — cursor used to conjure a spare `cursor-account-2` out of nothing, so /login
		// offered a slot no provider could serve. Only offer cursor slots once the provider
		// is actually on disk.
		const cursorAvailable = config.includeCursor && isCursorProviderInstalled();
		const families: ProviderFamily[] = [
			"anthropic",
			"openai-codex",
			"kimi-coding",
			...(cursorAvailable ? (["cursor"] as const) : []),
			"ollama",
			"qwen",
		];
		for (const family of families) {
			const authedIndexes = Object.keys(auth)
				.filter(
					(id) =>
						classifyProvider(id, config.qwenProvider) === family &&
						isEntryUsable(auth[id]),
				)
				.map(slotIndex);
			const wanted = new Set<number>(authedIndexes);
			// For OAuth families, add the next free slot (>=2) so the user can select it
			// from /login. API-key families (ollama/qwen) have no interactive login, so a
			// spare slot with no key would just produce a Pi error ("apiKey or oauth
			// required when defining models") — skip the spare for those families.
			if (
				family === "anthropic" ||
				family === "openai-codex" ||
				family === "kimi-coding" ||
				family === "cursor"
			) {
				let spare = 2;
				while (wanted.has(spare) && spare <= config.maxAccountsPerProvider)
					spare++;
				if (spare <= config.maxAccountsPerProvider) wanted.add(spare);
			}
			for (const index of wanted) {
				const id = slotId(family, index, config.qwenProvider);
				if (family === "cursor") {
					if (index <= 1) continue;
					if (!registeredSlots.has(id)) registeredSlots.add(id);
					continue;
				}
				if (index <= 1) continue; // base provider is native
				// An api-key slot registered before a ctx existed carries only the built-in tag.
				// Once the host registry is reachable its models must be folded in, so those slots
				// are re-registered whenever the host set changes rather than skipped forever.
				if (registeredSlots.has(id)) {
					if (!ctx || (family !== "ollama" && family !== "qwen")) continue;
					const base = family === "ollama" ? OLLAMA_BASE : config.qwenProvider;
					const signature = hostModelIdsFor(ctx, base).join(",");
					if (apiKeySlotHostSignature.get(id) === signature) continue;
					apiKeySlotHostSignature.set(id, signature);
				}
				if (family === "anthropic") {
					registerAnthropicSlot(
						pi,
						id,
						DEFAULT_ANTHROPIC_MODELS,
						numberedSlotBaseUrl(id, "anthropic"),
					);
				} else if (family === "openai-codex") {
					const cached = codexModelCatalogByProvider.get(id)?.models;
					registerCodexSlot(
						pi,
						id,
						config.autoDiscoverModels && cached?.length
							? (cached as Array<Record<string, unknown>>)
							: undefined,
						numberedSlotBaseUrl(id, "codex"),
					);
				} else if (family === "kimi-coding") {
					const kimiModels = [
						...new Set([...DEFAULT_KIMI_MODELS, ...hostModelIdsFor(ctx, KIMI_BASE)]),
					];
					registerKimiSlot(pi, id, kimiModels);
					// Provision into Pi's native registry so an extension-free child can RESOLVE the
					// slot by name. That is all this buys: measured 2026-08-24, such a child then
					// fails with "No API key found", because Pi honours an OAuth credential only
					// for a provider definition that declares the flow and a models.json entry
					// declares none. Making the slot genuinely usable needs the Cursor pattern — a
					// parent-owned loopback route with a non-secret placeholder — which Kimi does
					// not have yet. See child-usability.ts.
					if (ownsSharedChildPublication()) {
						provisionNativeSlot(id, {
							api: "anthropic-messages",
							baseUrl: KIMI_BASE_URL,
							models: kimiModels.map((modelId) => kimiModelDef(modelId, id)),
						});
					}
				} else if (family === "ollama" || family === "qwen") {
					registerApiKeySlot(pi, id, family, config.qwenProvider, ctx);
				}
				registeredSlots.add(id);
			}
		}
		if (cursorAvailable) cursorReady = refreshCursorSlots(auth);
	}

	/**
	 * Publish deterministic non-proxied aliases only after this process has proved that it owns
	 * the shared models.json publication boundary. During factory construction the canonical
	 * proxy port has not been claimed yet, so syncRegisteredSlots deliberately cannot write these
	 * entries there. Replaying the Kimi publication here also repairs legacy string-only model
	 * arrays once ownership is known.
	 */
	function publishOwnedNativeAliases(ctx?: any): void {
		if (!ownsSharedChildPublication()) return;
		for (const id of registeredSlots) {
			if (classifyProvider(id, config.qwenProvider) !== "kimi-coding") continue;
			const kimiModels = [
				...new Set([...DEFAULT_KIMI_MODELS, ...hostModelIdsFor(ctx, KIMI_BASE)]),
			];
			provisionNativeSlot(id, {
				api: "anthropic-messages",
				baseUrl: KIMI_BASE_URL,
				models: kimiModels.map((modelId) => kimiModelDef(modelId, id)),
			});
		}
	}

	function reloadHostAuth(ctx: any) {
		try {
			ctx?.modelRegistry?.authStorage?.reload?.();
		} catch {
			// A malformed or concurrently replaced auth file is handled by the next poll.
		}
	}

	function refreshDiscovery(force = false, ctx?: any): boolean {
		if (ctx) reloadHostAuth(ctx);
		const mtime = authMtimeMs();
		if (!force && mtime === lastAuthMtime) return false;
		lastAuthMtime = mtime;
		const auth = readAuthFile();
		let cooldownsCleared = false;
		for (const provider of new Set([
			...credentialHashes.keys(),
			...Object.keys(auth),
		])) {
			const entry = auth[provider];
			const nextHash = entry ? credentialHash(entry) : undefined;
			const previousHash = credentialHashes.get(provider);
			const nextIdentity = entry ? stableAccountFingerprint(entry) : undefined;
			const previousIdentity = credentialIdentities.get(provider);
			// A routine OAuth refresh rotates the access token (hash changes) but the real account
			// is unchanged, so its rate-limit cooldown MUST survive. Only drop the cooldown when the
			// slot is re-logged into a DIFFERENT real account (stable fingerprint changed) — a token
			// rotation never lifts a server-side limit.
			if (
				previousIdentity &&
				nextIdentity &&
				nextIdentity !== previousIdentity
			) {
				if (exhaustedUntilByProvider.delete(provider)) cooldownsCleared = true;
				// Model availability is account/plan-specific. Never let a newly logged-in account
				// inherit the previous account's five-minute catalog snapshot for this slot.
				if (codexModelCatalogByProvider.delete(provider)) cooldownsCleared = true;
				// A different real account also clears any stale 401-streak tracking: the new
				// account's credentials are unrelated to the old failures.
				authFailures.delete(provider);
				exhaustedUntilByModel.forEach((_until, key) => {
					if (key.startsWith(`${provider}/`)) {
						exhaustedUntilByModel.delete(key);
						cooldownsCleared = true;
					}
				});
			}
			// The usage snapshot is tied to the token, so refresh it whenever the credential blob
			// changes (cheap to re-fetch, and never used to gate availability).
			// For non-refreshable (API-key) providers, a credential change means the user manually
			// replaced the key (re-login) — stale 401-streak tracking is irrelevant and must be
			// cleared so the new key gets a fresh start. For OAuth providers, a hash change is a
			// routine token refresh by Pi; the 401 streak MUST survive so rotated-token failures
			// can still accumulate toward the kill threshold. Rate-limit cooldowns are NOT
			// cleared here (they are server-side limits tied to the account, not the token).
			if (previousHash && nextHash !== previousHash) {
				usageByProvider.delete(provider);
				usageErrors.delete(provider);
				const refreshable =
					!!entry &&
					typeof entry.refresh === "string" &&
					entry.refresh.length > 0;
				if (!refreshable) authFailures.delete(provider);
			}
			if (nextHash) credentialHashes.set(provider, nextHash);
			else credentialHashes.delete(provider);
			if (nextIdentity) credentialIdentities.set(provider, nextIdentity);
			else credentialIdentities.delete(provider);
		}
		if (cooldownsCleared) persist();
		clearReauthedInvalidations(auth);
		syncRegisteredSlots(auth, ctx);
		// After the slots exist: learn the host's Codex model list, so a flagship that shipped
		// with Pi (and not with this extension) is selectable and preferred on every slot.
		if (ctx) {
			refreshRegistryCodexModels(ctx);
			refreshRegistryAnthropicModels(ctx);
		}
		duplicateSlots = discoverDuplicateSlots(auth);
		rotation = discoverRotation(auth);
		return true;
	}

	function activeFallbacks(): string[] {
		const auth = readAuthFile();
		const source = config.autoDiscover
			? [...configuredFallbacks, ...rotation]
			: configuredFallbacks.length > 0
				? configuredFallbacks
				: rotation;
		const result: string[] = [];
		const seenTargets = new Set<string>();
		const seenAccounts = new Set<string>();
		for (const target of source) {
			const parsed = parseTarget(target);
			if (!parsed) continue;
			const normalized = parsed.modelId
				? `${parsed.provider}/${parsed.modelId}`
				: parsed.provider;
			if (seenTargets.has(normalized)) continue;
			const entry = auth[parsed.provider];
			const identity = entry ? accountIdentity(entry) : undefined;
			if (identity && seenAccounts.has(identity)) continue;
			seenTargets.add(normalized);
			if (identity) seenAccounts.add(identity);
			result.push(normalized);
		}
		return result;
	}

	// ----- fallback selection ----------------------------------------------

	function providerHasUsableAuth(ctx: any, provider: string) {
		const entry = readAuthFile()[provider];
		if (entry) return isEntryUsable(entry);
		try {
			return (
				ctx.modelRegistry.authStorage?.hasAuth?.(provider) ??
				ctx.modelRegistry.getProviderAuthStatus?.(provider)?.configured ??
				true
			);
		} catch {
			return true;
		}
	}

	/**
	 * Give the controller broker the parent-owned native provider boundary. This is deliberately
	 * installed here, rather than in a third extension or by importing the broker package: the
	 * multi-account extension already owns Pi's provider registry, OAuth refresh and Cursor bridge.
	 * The broker receives only this credentialless pair and still owns admission, health and
	 * failover. An explicit host-injected pair always wins and is never overwritten.
	 */
	function installControllerProvider(ctx: any) {
		if (!ctx || ctx.controllerProvider !== undefined) return;
		try {
			const modelRegistry = ctx.modelRegistry;
			const pair = createControllerProvider({
				modelRegistry,
				resolveModel: (provider, modelId) =>
					modelRegistry.find?.(provider, modelId) ??
					hiddenProviderModels.get(provider)?.find((model: any) => model.id === modelId),
				preparePayload: (payload, model, snapshot) => {
					let prepared = payload;
					if (isCursorProviderId(model?.provider) && isRecord(prepared)) {
						prepared = { ...prepared, pi_session_id: snapshot.taskId };
					}
					if (classifyProvider(model?.provider ?? "", config.qwenProvider) === "qwen") {
						rewriteDeveloperRoleToSystem(prepared);
					}
					const oauthAnthropic =
						classifyProvider(model?.provider ?? "", config.qwenProvider) === "anthropic" &&
						(modelRegistry.isUsingOAuth?.(model) ??
							readAuthFile()[model?.provider]?.type === "oauth");
					return oauthAnthropic ? shapeControllerAnthropicPayload(prepared) : prepared;
				},
				cleanupSession: (sessionId, provider) => {
					if (isCursorProviderId(provider)) cleanupCursorControllerSession(sessionId);
				},
			});
			ctx.controllerProvider = pair;
			logEvent("controller_provider_installed", { adapter: "pi-native-provider@1" });
		} catch (error) {
			// Older Pi builds may not expose the provider/auth methods needed by this boundary.
			// Keep the compatibility path available, but make the missing live boundary explicit.
			logEvent("controller_provider_unavailable", {
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}

	// Newest-first preferred model list for a family. A per-family config override
	// (preferredModels) wins so a new flagship can be pinned without a code change.
	function familyPreferredModels(family: string | undefined): string[] {
		if (!family) return [];
		const configured = config.preferredModels[family];
		if (configured && configured.length > 0) return configured;
		const defaults =
			family === "anthropic"
				? registryAnthropicModelOrder.length > 0
					? registryAnthropicModelOrder
					: DEFAULT_ANTHROPIC_MODELS
				: family === "openai-codex"
					? discoveredCodexModelOrder.length > 0
						? discoveredCodexModelOrder
						: registryCodexModelOrder.length > 0
							? registryCodexModelOrder
							: DEFAULT_CODEX_MODELS
					: family === "kimi-coding"
						? DEFAULT_KIMI_MODELS
						: family === "ollama"
							? DEFAULT_OLLAMA_MODELS
							: family === "qwen"
								? DEFAULT_QWEN_MODELS
								: family === "cursor"
									? DEFAULT_CURSOR_MODELS
									: [];
		const last = lastModelByFamily[family];
		if (!last) return defaults;
		return [last, ...defaults.filter((id) => id !== last)];
	}

	// Rank of a model within its family's newest-first preferred order (0 = newest).
	// Unknown models sort last. Used to keep the latest model across accounts, not
	// just within one account, during fallback ranking.
	function modelRecencyRank(model: any): number {
		const family = classifyProvider(model?.provider, config.qwenProvider);
		const order = familyPreferredModels(family);
		const idx = order.findIndex((id) => sameModelIdentity(id, model?.id));
		return idx < 0 ? Number.MAX_SAFE_INTEGER : idx;
	}

	function resolveTargets(
		ctx: any,
		target: string,
		currentModel: any,
		preferredOnly = false,
	) {
		const parsed = parseTarget(target);
		if (!parsed) return [];
		if (parsed.modelId) {
			const model = findModelIncludingHidden(ctx, parsed.provider, parsed.modelId);
			return model ? [model] : [];
		}

		const family = classifyProvider(parsed.provider, config.qwenProvider);
		const currentFamily = currentModel?.provider
			? classifyProvider(currentModel.provider, config.qwenProvider)
			: undefined;
		const sameFamily = !!family && !!currentFamily && family === currentFamily;
		// A per-family config override (preferredModels) wins, so a new flagship model can be
		// pinned without a code change. Order is newest-first either way.
		const preferred = familyPreferredModels(family);
		const keepCurrent = sameFamily && currentModel?.id ? [currentModel.id] : [];
		// `preferredOnly` means "take this family's flagship, not an arbitrary model". A provider
		// outside the managed families has no flagship list at all, so honouring it literally
		// yields no candidate and the switch fails — which is what made an unmanaged account
		// unreachable by name. Fall back to what Pi knows for it.
		const usePreferredOnly = preferredOnly && preferred.length > 0;
		const registryModels = usePreferredOnly
			? []
			: [
					...ctx.modelRegistry
						.getAll()
						.filter((model: any) => model.provider === parsed.provider),
					...(hiddenProviderModels.get(parsed.provider) ?? []),
				].map((model: any) => model.id);
		// preferLatestModel (default): try the newest preferred model FIRST, so a turn that was
		// once downgraded (e.g. gpt-5.4 after a momentary limit on gpt-5.5) is upgraded back to
		// the latest the moment it is available again — instead of carrying the old model forever.
		// Legacy mode keeps the current model first (never changes the model unless it has to).
		const modelIds = config.preferLatestModel
			? [...preferred, ...keepCurrent, ...registryModels]
			: [...keepCurrent, ...preferred, ...registryModels];
		const result: any[] = [];
		const seen = new Set<string>();
		for (const modelId of modelIds) {
			if (seen.has(modelId)) continue;
			const model = findModelIncludingHidden(ctx, parsed.provider, modelId);
			if (!model) {
				seen.add(modelId);
				continue;
			}
			if (seen.has(model.id)) continue;
			seen.add(modelId);
			seen.add(model.id);
			result.push(model);
		}
		return result;
	}

	/**
	 * Return fallback models in deterministic rotation order.
	 * Immediate failover only receives accounts whose known cooldown has expired.
	 */
	function findFallbackModels(
		ctx: any,
		currentModel: any,
		options: {
			availableNowOnly?: boolean;
			includeCurrent?: boolean;
			manualRoundRobin?: boolean;
			excludeProviders?: Set<string>;
			/** Keep the source model's product tier across accounts and provider families. */
			preserveQualityBand?: boolean;
			/**
			 * Automatic failover: try another account that still has THIS model (and family)
			 * before jumping to a different model. `best` turns this off so confirmation still
			 * outranks an unmeasurable sibling.
			 */
			preferSameIdentity?: boolean;
		} = {},
	) {
		reconcileCooldownsFromUsage(ctx);
		pruneCooldowns();
		// Cheap and idempotent: guarantees the newest Codex generation the host knows about is
		// ranked first at the exact moment we choose a fallback, even if no session_start ran.
		refreshRegistryCodexModels(ctx);
		refreshRegistryAnthropicModels(ctx);
		const fallbacks = activeFallbacks();
		if (fallbacks.length === 0) return [];

		const now = Date.now();

		type Scored = {
			model: any;
			remaining: number;
			rotIndex: number;
			rank: number;
			/** When this account last refused with a limit error. 0 = never, in this session. */
			lastRefusalAt: number;
			/**
			 * Whether the UNCAPPED forecast still considers this account spent. The recheck ceiling
			 * decides whether an account may be tried at all; this decides the ORDER. An account
			 * nothing predicts as spent is always tried before one we are only re-probing because
			 * its forecast went stale.
			 */
			predictedBusy: boolean;
			/**
			 * The provider itself said this account is usable, recently enough to believe.
			 *
			 * Distinct from "we hold no cooldown for it": that is absence of evidence, which is what
			 * an account with no usage endpoint at all always looks like. Treating the two as equal
			 * let an unmeasurable, out-of-quota account beat a measured, confirmed one.
			 */
			confirmed: boolean;
			/** Provider group this candidate belongs to — what the priority ladder ranks. */
			group: string;
			/** Same provider family (or un-numbered base) as the account that just failed. */
			sameFamily: boolean;
			/** Same model identity, including effort-folded Cursor ids. */
			sameModel: boolean;
		};
		// When preferLatestModel is on, the newest model wins ACROSS accounts — not just
		// within one account. Without this, failing over from gpt-5.5 could land on the
		// same account's older gpt-5.4 (lower rotIndex) instead of gpt-5.5 on a healthy
		// account, silently downgrading the model. rank is the primary tiebreak.
		const byRankThenRot = (a: Scored, b: Scored) =>
			(config.preferLatestModel ? a.rank - b.rank : 0) ||
			a.rotIndex - b.rotIndex;
		const scored: Scored[] = [];
		const seen = new Set<string>();

		for (let i = 0; i < fallbacks.length; i++) {
			// HARD RULE (never auto-downgrade the model): each account contributes exactly ONE
			// candidate — its newest/flagship model. We must NOT enumerate an account's older or
			// "mini" models as separate rotation targets, or `/multi-account next` ping-pongs
			// between e.g. gpt-5.4 ↔ gpt-5.4-mini and one chatty provider drowns out the others.
			// resolveTargets returns this account's models newest-first, so models[0] is the flagship.
			let models = resolveTargets(ctx, fallbacks[i], currentModel).filter(
				(model: any) =>
					!options.excludeProviders?.has(model.provider) &&
					!isInvalidated(model.provider) &&
					providerHasUsableAuth(ctx, model.provider),
			);
			const sourceBand = modelQualityBand(currentModel?.id);
			if (options.preserveQualityBand && sourceBand) {
				models = models.filter(
					(model: any) => modelQualityBand(model.id) === sourceBand,
				);
			}
			if (models.length === 0) continue;
			// Prefer the newest model that is not itself on a MODEL-level cooldown (a genuine
			// "model unavailable" error is the only sanctioned reason to fall to an older model).
			// A provider-level usage limit never demotes the model here: the flagship stays the
			// representative and the whole account simply cools — so we resume at the flagship, on
			// another account, instead of quietly dropping to a weaker model of the same account.
			const notModelCooled = (model: any) =>
				(exhaustedUntilByModel.get(`${model.provider}/${model.id}`) ?? 0) <= now;
			const flagshipPick = models.find(notModelCooled) ?? models[0];
			const currentId = currentModel?.id as string | undefined;
			const sameFamily =
				!!currentModel?.provider &&
				accountGroup(models[0].provider, config.qwenProvider) ===
					accountGroup(currentModel.provider, config.qwenProvider);
			const identityPick =
				options.preferSameIdentity !== false && sameFamily && currentId
					? models.find(
							(model: any) =>
								notModelCooled(model) &&
								sameModelIdentity(model.id, currentId),
						)
					: undefined;
			let pick = flagshipPick;
			if (identityPick) {
				const flagRank = modelRecencyRank(flagshipPick);
				const idRank = modelRecencyRank(identityPick);
				// preferLatestModel still upgrades a known older sibling (gpt-5.4 → gpt-5.5)
				// on a healthy account. An unranked catalog leftover (claude-4-sonnet beating
				// grok only because it sorts first) must never steal the user's model.
				const upgrade =
					config.preferLatestModel &&
					idRank !== Number.MAX_SAFE_INTEGER &&
					flagRank < idRank;
				pick = upgrade ? flagshipPick : identityPick;
			}
			// Leaving the current account: skip it (we only ever re-offer it via the round-robin
			// wrap-around below). Excluding by the *representative* — never by the raw current
			// model — is what stops a weaker same-account model from bubbling up as a downgrade.
			// Equivalent ids (`cursor-grok-4.6-high` vs folded `cursor-grok-4.6`) are the same
			// account still, so they must not look like a destination.
			if (
				!options.includeCurrent &&
				pick.provider === currentModel?.provider &&
				(pick.id === currentModel?.id ||
					sameModelIdentity(pick.id, currentModel?.id))
			)
				continue;
			if (seen.has(pick.provider)) continue;
			seen.add(pick.provider);

			const key = `${pick.provider}/${pick.id}`;
			const providerUntil = providerRecoveryAt(pick.provider, now);
			const modelUntil = exhaustedUntilByModel.get(key) ?? 0;
			const remaining = Math.max(0, Math.max(providerUntil, modelUntil) - now);
			const group = accountGroup(pick.provider, config.qwenProvider);
			const currentGroup = currentModel?.provider
				? accountGroup(currentModel.provider, config.qwenProvider)
				: "";
			scored.push({
				model: pick,
				remaining,
				rotIndex: i,
				rank: modelRecencyRank(pick),
				lastRefusalAt: limitStreakByProvider.get(pick.provider)?.lastAt ?? 0,
				confirmed: isConfirmedAvailable(pick.provider, now),
				predictedBusy:
					providerRecoveryAt(pick.provider, now, { ignoreCeiling: true }) >
					now,
				group,
				sameFamily: !!currentGroup && group === currentGroup,
				sameModel:
					!!currentGroup &&
					group === currentGroup &&
					sameModelIdentity(pick.id, currentModel?.id),
			});
		}
		if (scored.length === 0) return [];

		// Manual `/multi-account next`: walk the rotation forward from the current account,
		// wrapping around, so repeated presses cycle through EVERY account. This is an explicit user
		// override: quota/cooldown metadata may be stale after an early provider reset, purchased
		// credits, or a plan upgrade, so it must never reorder the manual ring or permanently starve
		// an account. Automatic failover still prefers accounts known to be available right now.
		if (options.manualRoundRobin) {
			const n = fallbacks.length;
			const currentRotIndex = currentModel?.provider
				? fallbacks.findIndex(
						(t) => parseTarget(t)?.provider === currentModel.provider,
					)
				: -1;
			const forwardDistance = (rotIndex: number) =>
				currentRotIndex < 0
					? rotIndex
					: (rotIndex - currentRotIndex + n) % n || n;
			const byDistance = (a: Scored, b: Scored) =>
				forwardDistance(a.rotIndex) - forwardDistance(b.rotIndex);
			let ordered = [...scored].sort(byDistance);
			if (
				lastLeftProvider &&
				now - lastLeftAt < ANTI_PINGPONG_MS &&
				ordered.length > 1 &&
				ordered[0].model.provider === lastLeftProvider
			) {
				ordered = [...ordered.slice(1), ordered[0]];
			}
			return ordered.map((s) => s.model);
		}

		// Among accounts that are selectable right now, prefer the one that refused LONGEST ago —
		// an account that just answered "usage limit reached" is the least likely to answer
		// differently seconds later, no matter how good its position or model rank is. Without this
		// the rotation order alone could send us straight back to the account we just left, get the
		// same refusal, and loop between two spent accounts while a live one sat further down.
		const byRefusalAgeThenRank = (a: Scored, b: Scored) =>
			// Among accounts not ruled out by liveness, stay in the same family and model first.
			// A fresh blocked/100% verdict is filtered below before this preference is considered.
			(options.preferSameIdentity !== false
				? Number(b.sameModel) - Number(a.sameModel) ||
					Number(b.sameFamily) - Number(a.sameFamily)
				: 0) ||
			Number(b.confirmed) - Number(a.confirmed) ||
			Number(a.predictedBusy) - Number(b.predictedBusy) ||
			// Every account of the family is spent — the step that had no policy at all. Of 602
			// automatic failovers in the black box, 588 stayed inside the family and the other 14
			// scattered across five different destinations, because nothing above rotation index
			// expressed a preference and the index almost never got a say.
			//
			// It sits BELOW the two liveness signals on purpose, and an earlier draft that put it
			// above them was wrong: evidence about a specific account has to beat a preference
			// about its category, or a group ranked first would pull work onto an account the
			// provider has already reported as spent while a live one waited. Two existing tests
			// said so before this comment did. What is left for the ladder is exactly the case
			// that was arbitrary — candidates the telemetry cannot separate — where it replaces
			// "whoever refused longest ago, then whatever order discovery happened to produce"
			// with a stated answer.
			comparePriority(a.group, b.group, config.providerPriority) ||
			a.lastRefusalAt - b.lastRefusalAt ||
			byRankThenRot(a, b);
		// Automatic routing never spends a user turn on an account whose fresh quota verdict says
		// it is unavailable. Background usage refresh is the proof that revives it. Manual `next`
		// remains the explicit override for stale forecasts and therefore uses the separate ring
		// above, which deliberately ignores cooldown ordering.
		let availableNow = scored
			.filter((s) => s.remaining === 0)
			.sort(byRefusalAgeThenRank);
		if (
			lastLeftProvider &&
			now - lastLeftAt < ANTI_PINGPONG_MS &&
			availableNow.length > 1
		) {
			const otherProvider = availableNow.filter(
				(s) => s.model.provider !== lastLeftProvider,
			);
			if (otherProvider.length > 0) availableNow = otherProvider;
		}
		if (availableNow.length > 0) return availableNow.map((s) => s.model);

		if (options.availableNowOnly) return [];
		return scored
			.sort(
				(a, b) => a.remaining - b.remaining || byRefusalAgeThenRank(a, b),
			)
			.map((s) => s.model);
	}

	/**
	 * Say where a manual selection actually landed, and what we believe about that account.
	 *
	 * `next` walks the ring regardless of cooldowns, so it can legitimately land on an account we
	 * think is spent. Saying so turns a confusing silent double-switch — land on a cooled account,
	 * get moved off it a second later — into one honest sentence, and it also reserves the one
	 * attempt that lets the user prove our bookkeeping wrong.
	 */
	function announceManualChoice(ctx: any) {
		const model = ctx.model;
		if (!model?.provider || !model?.id) return;
		pinManualChoice(model.provider);
		const now = Date.now();
		const until = providerRecoveryAt(model.provider, now, {
			ignoreCeiling: true,
		});
		const spent = until > now;
		// Quote the forecast AND the guarantee that limits it. The raw number alone — "cooling
		// down, ~672h left" — reads as a four-week lockout, when the account is in fact re-asked
		// within `maxRecheckIntervalMs` no matter what the forecast says. Someone reading only the
		// forecast concludes the extension has written the account off for a month and stopped
		// picking up accounts that freed up, which is the opposite of what it does.
		ctx.ui.notify(
			spent
				? `pi-multi-account: switched to ${model.provider}/${model.id} — its quota forecast still says spent (~${formatUntil(until)}), but a forecast is not a verdict: it is tried right now, and re-checked at least every ${formatDelay(config.maxRecheckIntervalMs)} regardless`
				: `pi-multi-account: switched to ${model.provider}/${model.id}`,
			"info",
		);
	}

	async function activateFallback(
		ctx: any,
		sourceModel: any,
		candidates: any[],
		reason: string,
		options: { armContinuation?: boolean; manual?: boolean } = {},
	) {
		// A switch the user asked for is not an automatic step: it is never refused, and it clears
		// the governor, because a person choosing an account is the clearest possible signal that
		// the session is under control again.
		if (options.manual) resetGovernor();
		else if (!allowAction("account switch", ctx)) return false;
		const from =
			sourceModel?.provider && sourceModel?.id
				? ref(sourceModel.provider, sourceModel.id)
				: ("unavailable/account" as ModelRef);
		const failedProviders = new Set<string>();
		for (const fallback of candidates) {
			if (failedProviders.has(fallback.provider)) continue;
			const to = ref(fallback.provider, fallback.id);
			if (to === from) {
				if (options.manual && candidates.length === 1) {
					modelPreferenceChanged = true;
					rememberUserModel(sourceModel);
					return true;
				}
				markExhausted(fallback.provider, config.transientCooldownMs);
				failedProviders.add(fallback.provider);
				continue;
			}
			let ok = true;
			if (
				ctx.model?.provider !== fallback.provider ||
				ctx.model?.id !== fallback.id
			) {
				automaticModelTarget = to;
				try {
					ok = await setModelEnsuringVisible(fallback, ctx);
				} catch {
					ok = false;
				}
				if (!ok && automaticModelTarget === to)
					automaticModelTarget = undefined;
			}
			if (!ok) {
				reloadHostAuth(ctx);
				refreshDiscovery(true, ctx);
				if (providerHasUsableAuth(ctx, fallback.provider)) {
					automaticModelTarget = to;
					try {
						ok = await setModelEnsuringVisible(fallback, ctx);
					} catch {
						ok = false;
					}
					if (!ok && automaticModelTarget === to)
						automaticModelTarget = undefined;
				}
			}
			if (!ok) {
				ctx.ui.notify(
					`Provider failover: ${to} could not be activated; skipping it briefly`,
					"warning",
				);
				// A setModel failure is not a quota/rate-limit and must not receive the normal
				// multi-hour cooldown. Still cool it briefly so a broken or half-logged-in slot
				// does not get retried on every failover attempt.
				markExhausted(fallback.provider, config.transientCooldownMs);
				failedProviders.add(fallback.provider);
				continue;
			}
			if (options.manual) {
				modelPreferenceChanged = true;
				rememberUserModel(ctx.model ?? fallback);
			}
			restoreDesiredThinking(ctx);
			applyOnlyActiveFilter(ctx, fallback.provider);
			setLastProbe(fallback.provider);
			if (options.armContinuation !== false) {
				pinFailoverProbe(fallback.provider);
			}
			const record = { from, to, reason, at: Date.now() };
			currentPromptSwitch =
				options.armContinuation === false ? undefined : record;
			logEvent("switch", { session: sessionInstanceId, from, to, reason });
			pi.appendEntry("provider-failover", record);
			persist({
				lastSwitches: [record, ...(persistedState.lastSwitches ?? [])].slice(
					0,
					20,
				),
			});
			ctx.ui.notify(
				`Provider failover [v${VERSION}]: ${from} → ${to} (${reason})`,
				"warning",
			);
			return true;
		}
		return false;
	}

	async function switchToFallback(
		ctx: any,
		failedModel: any,
		reason: string,
		cooldownMs = config.cooldownMs,
		options: { manual?: boolean; scope?: "provider" | "model" } = {},
	) {
		if (!automaticFailoverEnabled() || !failedModel?.provider || !failedModel?.id)
			return false;

		if (options.scope === "model") {
			markModelExhausted(failedModel, cooldownMs);
		} else {
			markExhausted(failedModel.provider, cooldownMs);
			lastLeftProvider = failedModel.provider;
			lastLeftAt = Date.now();
		}

		if (
			!options.manual &&
			autoContinuesThisPrompt >= config.maxAutoContinuesPerPrompt
		) {
			ctx.ui.notify(
				`Provider failover: stopped after ${autoContinuesThisPrompt} auto-continues. Send a new message or run /multi-account reset to retry.`,
				"warning",
			);
			return false;
		}

		const excludeProviders = /auth (invalid|failure)/i.test(reason)
			? new Set<string>([failedModel.provider])
			: undefined;
		const candidates = findFallbackModels(ctx, failedModel, {
			availableNowOnly: !options.manual,
			manualRoundRobin: options.manual,
			excludeProviders,
			preserveQualityBand: true,
		});
		// No OTHER account to move to. Because each account now offers only its flagship (the
		// never-downgrade rule), a single-account session with a just-cleared cooldown lands here
		// instead of enumerating a weaker sibling model — so this is the path that must resume the
		// current account when usage shows it actually recovered, rather than downgrading.
		if (candidates.length === 0) {
			if (armSameAccountResumeIfReady(ctx, failedModel, reason, options))
				return false;
			const cooldowns = [...exhaustedUntilByProvider.entries()]
				.filter(
					([provider, until]) => until > Date.now() && !isInvalidated(provider),
				)
				.map(([provider, until]) => `${provider}: ${formatUntil(until)}`)
				.join(", ");
			const invalids = [...invalidatedByProvider.keys()].join(", ");
			const availability = [
				cooldowns ? `Cooldowns: ${cooldowns}` : undefined,
				invalids ? `Invalidated (need re-login): ${invalids}` : undefined,
			]
				.filter(Boolean)
				.join(". ");
			logEvent("no_fallback", {
				after: `${failedModel.provider}/${failedModel.id}`,
				availability: availability || "none",
			});
			ctx.ui.notify(
				`Provider failover: no immediately available fallback after ${failedModel.provider}/${failedModel.id}. ${availability || "All known accounts may be unauthenticated, invalidated, or duplicate slots."}`,
				"warning",
			);
			if (!options.manual && config.autoContinue)
				setPendingContinuation(ctx, failedModel, reason);
			return false;
		}

		const switched = await activateFallback(
			ctx,
			failedModel,
			candidates,
			reason,
			{ armContinuation: !options.manual, manual: options.manual },
		);
		if (!switched && !options.manual && config.autoContinue) {
			if (!armSameAccountResumeIfReady(ctx, failedModel, reason, options))
				setPendingContinuation(ctx, failedModel, reason);
		}
		return switched;
	}

	// If the account we just failed off is actually READY again (usage reconciliation cleared its
	// cooldown), arm a same-account resume instead of demoting the model or parking a pending wait.
	// Returns true when it armed the resume. Never fires for manual switches.
	function armSameAccountResumeIfReady(
		ctx: any,
		failedModel: any,
		reason: string,
		options: { manual?: boolean } = {},
	): boolean {
		if (options.manual || !config.autoContinue) return false;
		reconcileCooldownsFromUsage(ctx);
		pruneCooldowns();
		if (!isCurrentModelReady(ctx)) return false;
		const target = ref(failedModel.provider, failedModel.id);
		currentPromptSwitch = {
			from: target,
			to: target,
			reason: `${reason} (same account recovered)`,
			at: Date.now(),
		};
		return true;
	}

	function isCurrentModelReady(ctx: any) {
		const model = ctx.model;
		if (!model?.provider || !model?.id) return false;
		if (
			!providerHasUsableAuth(ctx, model.provider) ||
			isInvalidated(model.provider)
		)
			return false;
		const now = Date.now();
		return (
			providerRecoveryAt(model.provider, now) <= now &&
			(exhaustedUntilByModel.get(ref(model.provider, model.id)) ?? 0) <= now
		);
	}

	function rememberUserModel(model: { provider?: string; id?: string } | undefined) {
		if (
			subagentChild ||
			!model?.provider ||
			!model?.id ||
			(!modelPreferenceChanged && !thinkingPreferenceChanged)
		)
			return;
		const rememberedModel = modelPreferenceChanged
			? { provider: model.provider, id: model.id }
			: persistedState.lastUserModel;
		if (!rememberedModel?.provider || !rememberedModel.id) return;
		if (modelPreferenceChanged) {
			const family = classifyProvider(model.provider, config.qwenProvider);
			if (family) lastModelByFamily[family] = model.id;
		}
		persist(
			{
				lastUserModel: rememberedModel,
				lastUserThinkingLevel: thinkingPreferenceChanged
					? desiredThinkingLevel ?? readThinkingLevel()
					: persistedState.lastUserThinkingLevel,
				lastModelByFamily: { ...lastModelByFamily },
			},
			{ writeUserPreferences: true },
		);
	}

	function intendedStartupModel(): { provider: string; id: string } | undefined {
		const remembered = persistedState.lastUserModel;
		if (remembered?.provider && remembered?.id) return remembered;
		return readHostDefaultModel();
	}

	async function restoreRememberedModel(ctx: any) {
		if (subagentChild) {
			logEvent("remembered_model_skipped", { reason: "pi-subagents child owns model selection" });
			return false;
		}
		if (explicitCli.model) {
			logEvent("remembered_model_skipped", { reason: "explicit CLI model" });
			return false;
		}
		const cliThinkingLevel = explicitCli.thinking
			? (explicitCliThinkingLevel ?? readThinkingLevel())
			: undefined;
		const intended = intendedStartupModel();
		if (!intended) {
			logEvent("remembered_model_skipped", { reason: "no intended model" });
			return false;
		}
		const alreadyThere =
			ctx.model?.provider === intended.provider &&
			ctx.model?.id === intended.id;
		if (alreadyThere) {
			if (explicitCli.thinking) desiredThinkingLevel = cliThinkingLevel ?? desiredThinkingLevel;
			restoreDesiredThinking(ctx);
			return true;
		}
		if (cursorReady) {
			await cursorReady.catch(() => undefined);
		}
		let found = findModelIncludingHidden(
			ctx,
			intended.provider,
			intended.id,
		);
		if (!found || !providerHasUsableAuth(ctx, intended.provider)) {
			logEvent("remembered_model_unavailable", {
				provider: intended.provider,
				model: intended.id,
				reason: !found ? "not in registry" : "no auth",
			});
			return false;
		}
		const from =
			ctx.model?.provider && ctx.model?.id
				? ref(ctx.model.provider, ctx.model.id)
				: "none";
		const to = ref(intended.provider, intended.id);
		if (explicitCli.thinking) {
			desiredThinkingLevel = cliThinkingLevel ?? desiredThinkingLevel;
		} else {
			const rememberedLevel = persistedState.lastUserThinkingLevel;
			if (rememberedLevel) desiredThinkingLevel = rememberedLevel as ReasoningLevel;
		}
		automaticModelTarget = to;
		let ok = false;
		try {
			ok = await setModelEnsuringVisible(found, ctx);
		} catch {
			ok = false;
		}
		if (automaticModelTarget === to) automaticModelTarget = undefined;
		logEvent("remembered_model_restored", {
			from,
			to,
			ok,
			source: persistedState.lastUserModel ? "state" : "settings",
		});
		if (ok) {
			// Pi resets thinking while changing models. Re-assert either the explicit CLI level
			// captured before that reset or the ordinary remembered level.
			if (explicitCli.thinking) {
				desiredThinkingLevel = cliThinkingLevel ?? desiredThinkingLevel;
			} else {
				const rememberedLevel = persistedState.lastUserThinkingLevel;
				if (rememberedLevel) desiredThinkingLevel = rememberedLevel as ReasoningLevel;
			}
			restoreDesiredThinking(ctx);
			ctx.ui?.notify?.(
				`pi-multi-account: restored ${to} after catalog load (Pi had fallen back to ${from})`,
				"info",
			);
		}
		return ok;
	}

	async function ensureReadyModel(ctx: any, reason: string) {
		// The launch candidate is authoritative in a pi-subagents child. Let the
		// request produce its real error so the parent runner can advance its own
		// fallbackModels chain instead of starting a competing router here.
		if (subagentChild) return true;
		refreshDiscovery(false, ctx);
		pruneCooldowns();
		const intended = intendedStartupModel();
		const onIntended =
			!!intended &&
			ctx.model?.provider === intended.provider &&
			ctx.model?.id === intended.id;
		// Pi's createAgentSession often parks us on kimi/anthropic because Cursor was not
		// in the registry yet. That fallback is not the user's choice — restore first,
		// otherwise startup preflight failovers *away* from the accidental model.
		if (intended && !onIntended) {
			await restoreRememberedModel(ctx);
		}
		if (isCurrentModelReady(ctx)) return true;
		// The user chose this account by hand and has not spent the attempt yet. Let the request
		// through: our reason for believing it unusable is a forecast, and this is the only way
		// anyone finds out the forecast was stale. Merely being asked about it never spends it —
		// every readiness check of the same message must get the same answer.
		if (hasManualPin(ctx.model?.provider)) {
			markManualPinUsed(ctx.model?.provider);
			return true;
		}
		if (hasFailoverPin(ctx.model?.provider)) {
			markFailoverPinUsed(ctx.model?.provider);
			return true;
		}
		const candidates = findFallbackModels(ctx, ctx.model, {
			availableNowOnly: true,
			includeCurrent: true,
			preserveQualityBand: true,
		});
		if (candidates.length === 0) return false;
		return activateFallback(ctx, ctx.model, candidates, reason, {
			armContinuation: false,
		});
	}

	// ----- pending auto-resume ---------------------------------------------

	function hasPendingResume(): boolean {
		return !!pendingResume;
	}

	// Reject a promise that does not settle within `ms`. Used to bound every network-bound
	// hand-off (compaction summary) so a wedged provider call can never hang the session.
	// `onTimeout` MUST abort the underlying work — otherwise the timed-out compact() keeps
	// running, Pi starts a second one, and the "Compacting context…" spinner never clears.
	function withTimeout<T>(
		p: Promise<T>,
		ms: number,
		label: string,
		onTimeout?: () => void,
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				try {
					onTimeout?.();
				} catch {
					/* abort must never mask the timeout */
				}
				reject(new Error(`${label} timed out after ${formatDelay(ms)}`));
			}, ms);
			timer.unref?.();
			p.then(
				(v) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve(v);
				},
				(e) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					reject(e);
				},
			);
		});
	}

	function abortQuietly(controller?: AbortController) {
		try {
			controller?.abort();
		} catch {
			/* already aborted or unimplemented */
		}
	}

	// A context-size error (vs. a quota/auth/transient error). Detected against the intrinsic
	// overflow vocabulary so a user override of ignoreErrorPatterns cannot accidentally make us
	// treat "input is too long" as a rotate-able limit (rotating just hands the SAME oversized
	// context to the next account, which overflows again).
	function isContextOverflowError(text: string): boolean {
		if (!text.trim()) return false;
		return patternMatch(text, DEFAULT_IGNORE_PATTERNS);
	}

	// ----- forward-progress watchdog ---------------------------------------
	// A resumed turn (one WE started via continueAgent after a switch) must keep showing
	// activity. Any stream token / tool event / provider response calls noteResumeProgress and
	// disarms the timer. Total silence past stuckWatchdogMs surfaces an actionable recovery
	// instead of an eternal "Working…" spinner. This is a generic net: it catches stalls we
	// never specifically predicted, not just the ones we know about.
	// ----- circuit breaker (reliability floor) -----------------------------
	function isBreakerOpen(): boolean {
		return breakerOpenUntil > Date.now();
	}

	// Any genuine forward progress (a successful provider response / assistant turn) proves
	// recovery is working, so reset the failure streak and close advisory mode.
	function noteRecoveryProgress() {
		if (recoveryFailures !== 0 || breakerOpenUntil !== 0) {
			const wasOpen = breakerOpenUntil > Date.now();
			recoveryFailures = 0;
			breakerOpenUntil = 0;
			if (wasOpen) logEvent("breaker_close", { reason: "forward progress" });
		}
	}

	// A failed auto-recovery (a wedged/aborted resume, a resume that errored out). After
	// BREAKER_FAILURE_THRESHOLD in a row, trip the breaker: pause auto-continue and tell the
	// user we are now only advising manual switches — never hanging on a doomed auto-resume.
	function noteRecoveryFailure(ctx: any) {
		recoveryFailures++;
		logEvent("recovery_failure", { count: recoveryFailures });
		if (recoveryFailures >= BREAKER_FAILURE_THRESHOLD && !isBreakerOpen()) {
			breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
			logEvent("breaker_open", {
				failures: recoveryFailures,
				cooldownMs: BREAKER_COOLDOWN_MS,
			});
			ctx?.ui?.notify?.(
				`pi-multi-account [v${VERSION}]: automatic resume failed ${recoveryFailures}× in a row, so it is pausing auto-continue for ${formatDelay(BREAKER_COOLDOWN_MS)} (safe mode) to avoid making things worse. ` +
					"It still flags rate limits and switches you to a fresh account — just send your next message, or use /multi-account next. (/multi-account reset re-enables auto-continue immediately.)",
				"warning",
			);
		}
	}

	function clearProgressWatchdog() {
		if (progressWatchdogTimer) {
			clearTimeout(progressWatchdogTimer);
			progressWatchdogTimer = undefined;
		}
	}

	function armStuckWatchdog() {
		clearProgressWatchdog();
		if (!activeResumeWatch || !automaticFailoverEnabled()) return;
		progressWatchdogTimer = setTimeout(
			onResumeStuck,
			Math.max(25, config.stuckWatchdogMs),
		);
		progressWatchdogTimer.unref?.();
	}

	function noteResumeProgress() {
		if (!activeResumeWatch) return;
		lastResumeProgressAt = Date.now();
		stuckReminders = 0;
		armStuckWatchdog();
	}

	function beginResumeWatch(ctx: any): () => void {
		const owner = Symbol("resume watch");
		activeResumeWatch = owner;
		watchdogCtx = ctx;
		lastResumeProgressAt = Date.now();
		stuckReminders = 0;
		toolInFlight = 0;
		armStuckWatchdog();
		return () => {
			if (activeResumeWatch === owner) endResumeWatch();
		};
	}

	function endResumeWatch() {
		activeResumeWatch = undefined;
		watchdogCtx = undefined;
		stuckReminders = 0;
		toolInFlight = 0;
		clearProgressWatchdog();
	}

	function onResumeStuck() {
		progressWatchdogTimer = undefined;
		if (!activeResumeWatch) return;
		// A timer callback that throws crashes the whole Pi process — the exact "everything
		// dies" failure we are trying to eliminate. Never let anything escape here.
		try {
			const ctx = watchdogCtx;
			// A tool (build/test/long bash) running silently for minutes is NOT stuck. Never
			// abort real work — just re-check later.
			if (toolInFlight > 0) {
				armStuckWatchdog();
				return;
			}
			const silentMs = Date.now() - lastResumeProgressAt;
			const where = ctx?.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: "the active account";
			logEvent("resume_stuck", {
				model: where,
				silentMs,
				action: config.autoRecoverStuck !== false ? "auto_cancel" : "notify",
			});
			let recovery = "";
			try {
				const status = nextRecoveryStatus(ctx);
				if (status) recovery = ` (next recovery ${status})`;
			} catch {
				/* status is best-effort */
			}

			// ACTIVE recovery (default): the wedge is almost always a provider request or a
			// compaction that hung on an exhausted account. Just telling the user to press Esc
			// is not enough — they should not have to babysit it. So we abort the wedged turn
			// ourselves (which unblocks ctx.isIdle) and arm auto-resume; the pending-wake timer
			// then continues the work automatically the moment any account recovers. The abort
			// is flagged so agent_end treats it as recovery, not a user cancel.
			// A wedge is a failed recovery — feed the circuit breaker so repeated wedges drop us
			// to advisory mode instead of aborting/re-resuming forever.
			noteRecoveryFailure(ctx);
			if (
				config.autoRecoverStuck !== false &&
				typeof ctx?.abort === "function"
			) {
				ctx?.ui?.notify?.(
					`Provider failover [v${VERSION}]: the resumed turn on ${where} has been silent for ${formatDelay(silentMs)} — auto-cancelling it and will resume automatically when an account is free${recovery}. (/multi-account stop to cancel, /multi-account status to inspect.)`,
					"warning",
				);
				watchdogAborting = true;
				// Cool the wedged account briefly so the auto-resume does not immediately re-wedge
				// on the same dead account before usage reconciliation catches up.
				if (ctx.model?.provider)
					markExhausted(ctx.model.provider, config.transientCooldownMs);
				try {
					ctx.abort();
				} catch {
					/* if abort is unavailable, fall through to the reminder path below */
					watchdogAborting = false;
				}
				if (watchdogAborting) return; // agent_end(aborted) will arm the auto-resume
			}

			// Fallback (auto-recover disabled, or no abort available): notify + periodic reminder.
			ctx?.ui?.notify?.(
				`Provider failover: the resumed turn on ${where} has shown no activity for ${formatDelay(silentMs)} and looks stuck${recovery}. ` +
					"Press Esc to cancel it, then /multi-account next to rotate, or /compact to shrink the context.",
				"warning",
			);
			stuckReminders++;
			if (stuckReminders < 5 && activeResumeWatch) {
				progressWatchdogTimer = setTimeout(
					onResumeStuck,
					Math.max(25, STUCK_REMINDER_MS),
				);
				progressWatchdogTimer.unref?.();
			}
		} catch {
			/* never crash the host from a watchdog tick */
		}
	}

	// ----- account-aware compaction ----------------------------------------
	// When the active account is spent, generate the summary on a live account. If every live
	// attempt fails or times out, CANCEL — returning undefined lets Pi run default compaction
	// on the spent account with no bound, which is the infinite "Compacting context…" spinner.
	type CompactFn = (
		preparation: unknown,
		model: unknown,
		apiKey: string | undefined,
		headers: Record<string, string> | undefined,
		customInstructions: string | undefined,
		signal: AbortSignal | undefined,
		thinkingLevel: unknown,
	) => Promise<any>;

	async function resolveCompactFn(): Promise<CompactFn | undefined> {
		if (Object.prototype.hasOwnProperty.call(pi, "__testCompactFn")) {
			const injected = (pi as any).__testCompactFn;
			return typeof injected === "function" ? (injected as CompactFn) : undefined;
		}
		const mod = (await import("@earendil-works/pi-coding-agent").catch(
			() => undefined,
		)) as { compact?: CompactFn } | undefined;
		return typeof mod?.compact === "function" ? mod.compact : undefined;
	}

	function compactionCancelled(reason: string): {
		cancel: true;
		reason: string;
	} {
		compactionRoutedNote = reason;
		return { cancel: true, reason };
	}

	/** Accounts a recent compaction refusal has benched for a reason that needs a human. */
	const compactionUnfitUntil = new Map<string, number>();

	function compactionUnfit(provider: string, now = Date.now()): boolean {
		const until = compactionUnfitUntil.get(provider);
		if (until === undefined) return false;
		if (until > now) return true;
		compactionUnfitUntil.delete(provider);
		return false;
	}

	function noteCompactionRefusal(provider: string, error: string) {
		const text = error.toLowerCase();
		if (!COMPACTION_UNFIT_PATTERNS.some((pattern) => text.includes(pattern)))
			return;
		compactionUnfitUntil.set(provider, Date.now() + COMPACTION_UNFIT_MS);
	}

	function compactionCandidates(ctx: any): any[] {
		const now = Date.now();
		return findFallbackModels(ctx, ctx.model, {
			availableNowOnly: true,
			includeCurrent: false,
		}).filter(
			(model: any) =>
				model &&
				!compactionUnfit(model.provider, now) &&
				!(
					model.provider === ctx.model?.provider &&
					model.id === ctx.model?.id
				),
		);
	}

	async function runHealthyCompaction(
		event: any,
		ctx: any,
	): Promise<
		{ compaction: any } | { cancel: true; reason: string } | undefined
	> {
		try {
			if (!automaticFailoverEnabled() || !config.routeCompactionToHealthyAccount)
				return undefined;
			// A healthy active model already has Pi's complete native compaction path: it
			// supplies the stream function, auth environment, retry policy and lifecycle
			// callbacks. Do not replace that path with the extension's low-level helper.
			// Routing is only needed when the active account is unavailable.
			const currentReady = isCurrentModelReady(ctx);
			if (currentReady) {
				compactionRoutedNote = undefined;
				return undefined;
			}
			const preparation = event?.preparation;
			if (!preparation) return undefined;
			if (event?.signal?.aborted) {
				return compactionCancelled("compaction aborted");
			}
			const compactFn = await resolveCompactFn();
			const candidates = compactionCandidates(ctx);
			if (candidates.length === 0) {
				ctx.ui?.notify?.(
					"Provider failover: no live account can summarize; cancelled instead of hanging on the spent account.",
					"warning",
				);
				return compactionCancelled(
					"no live account for compaction; cancelled",
				);
			}
			let thinkingLevel: any;
			try {
				thinkingLevel = (pi as any).getThinkingLevel?.();
			} catch {
				/* optional */
			}
			// `compactionWatchdogMs` is the bound for ONE provider attempt. Dividing it by
			// the attempt cap turned the default eight-minute allowance into 160 seconds,
			// aborting ordinary slow summaries before they could finish. The attempt cap
			// still bounds the number of fallback providers, while each provider gets the
			// configured time it needs to produce a complete summary.
			const timeoutMs = Math.max(1, config.compactionWatchdogMs);
			const tried: string[] = [];
			let attempts = 0;
			for (const model of candidates) {
				if (event?.signal?.aborted) {
					return compactionCancelled("compaction aborted");
				}
				if (attempts >= COMPACTION_MAX_ATTEMPTS) {
					// Never drop coverage silently: the log has to show what was left unasked, or a
					// capped pass reads exactly like a pass that tried everything.
					logEvent("compaction_attempts_capped", {
						attempts,
						skipped: candidates
							.slice(candidates.indexOf(model))
							.map((m: any) => m.provider),
					});
					break;
				}
				const auth = await ctx.modelRegistry?.getApiKeyAndHeaders?.(model);
				if (!auth?.ok || (!auth.apiKey && !auth.headers)) {
					tried.push(`${model.provider} (no auth)`);
					continue;
				}
				const isCurrent =
					model.provider === ctx.model?.provider &&
					model.id === ctx.model?.id;
				if (!isCurrent) {
					ctx.ui?.notify?.(
						`Provider failover: ${ctx.model?.provider ?? "active"} account is unavailable for compaction; summarizing on ${model.provider} instead.`,
						"info",
					);
				}
				if (typeof compactFn !== "function") {
					tried.push(`${model.provider} (host cannot compact)`);
					continue;
				}
				const attempt = new AbortController();
				const onParentAbort = () => abortQuietly(attempt);
				if (typeof event?.signal?.addEventListener === "function") {
					event.signal.addEventListener("abort", onParentAbort, {
						once: true,
					});
				}
				attempts++;
				try {
					const result = await withTimeout(
						compactFn(
							preparation,
							model,
							auth.apiKey,
							auth.headers,
							event?.customInstructions,
							attempt.signal,
							thinkingLevel,
						),
						timeoutMs,
						`compaction on ${model.provider}`,
						() => abortQuietly(attempt),
					);
					if (
						result &&
						typeof result.summary === "string" &&
						result.summary.trim()
					) {
						// Pi drops the accumulated summary when a compaction lands with no
						// history left to summarize — put it back before the entry is saved.
						if (droppedPreviousSummary(result.summary, preparation.previousSummary)) {
							logEvent("compaction_summary_repaired", {
								provider: model.provider,
								previousSummaryChars: preparation.previousSummary.length,
								droppedSummaryChars: result.summary.length,
							});
							result.summary = restorePreviousSummary(
								result.summary,
								preparation.previousSummary,
							);
						}
						compactionRoutedNote = `compacted on ${model.provider}`;
						logEvent("compaction_routed", {
							to: model.provider,
							reason: event?.reason,
							from: ctx.model?.provider,
						});
						return { compaction: result };
					}
					tried.push(`${model.provider} (empty)`);
				} catch (error) {
					abortQuietly(attempt);
					if (event?.signal?.aborted) {
						return compactionCancelled("compaction aborted");
					}
					tried.push(`${model.provider} (${String(error).slice(0, 80)})`);
					// Remember the refusals that will still be refusals in five minutes, so the
					// next compaction does not walk the same wall of empty wallets again.
					noteCompactionRefusal(model.provider, String(error));
					logEvent("compaction_failed", {
						error: String(error),
						provider: model.provider,
					});
				} finally {
					if (typeof event?.signal?.removeEventListener === "function") {
						event.signal.removeEventListener("abort", onParentAbort);
					}
				}
			}
			if (typeof compactFn !== "function") {
				// A spent account must not fall through to Pi's untimed native summary when
				// this host cannot provide the routed helper.
				ctx.ui?.notify?.(
					"Provider failover: the active account cannot compact and this Pi build cannot reroute the summary; cancelled instead of hanging.",
					"warning",
				);
				return compactionCancelled(
					"cannot route compaction on this host",
				);
			}
			const detail = tried.join("; ") || "no candidates";
			ctx.ui?.notify?.(
				`Provider failover: could not finish compaction on any live account (${detail.slice(0, 140)}); cancelled instead of hanging on the spent one.`,
				"warning",
			);
			return compactionCancelled(
				"healthy-account compaction failed; cancelled",
			);
		} catch (error) {
			logEvent("compaction_failed", { error: String(error) });
			if (event?.signal?.aborted) {
				return compactionCancelled("compaction aborted");
			}
			ctx?.ui?.notify?.(
				`Provider failover: compaction routing failed (${String(error).slice(0, 100)}); cancelled instead of hanging.`,
				"warning",
			);
			return compactionCancelled(
				`healthy compaction failed: ${String(error).slice(0, 60)}`,
			);
		}
	}

	// Graceful degradation when a seamless in-place resume is not possible — either the host build
	// predates pi.continueAgent(), or the transcript tail is a completed assistant message that
	// continueAgent() cannot pick up. Inject the continuation prompt as a fresh USER turn so the
	// session keeps moving on the account we just switched to, WITHOUT the user re-typing anything.
	// Bounded by maxAutoContinuesPerPrompt. Returns true when it started a continuation turn.
	function injectContinuationPrompt(
		ctx: any,
		resumeFrom?: { from?: ModelRef; reason?: string },
	): boolean {
		// `currentPromptSwitch` is set ONLY when we actually rotated accounts. The pending-resume
		// path (transient overload, or a cooldown that expired on the same account) deliberately
		// returns to the SAME account, so it never has a switch record. Requiring one here meant
		// that on every host without `pi.continueAgent` — i.e. every pi-coding-agent 0.80.3+,
		// where seamless resume was removed — the pending resume silently refused to inject, and
		// the user had to re-send the prompt by hand. Accept an explicit resume context instead.
		const source = currentPromptSwitch ?? resumeFrom;
		const blocked = !source
			? "no switch or resume context"
			: !config.autoContinue
				? "autoContinue disabled"
				: userAbortedChain
					? "user aborted the chain"
					: ctx.signal?.aborted
						? "abort signal raised"
						: autoContinuesThisPrompt >= config.maxAutoContinuesPerPrompt
							? `auto-continue budget spent (${autoContinuesThisPrompt}/${config.maxAutoContinuesPerPrompt})`
							: typeof pi.sendUserMessage !== "function"
								? "host build has no pi.sendUserMessage"
								: undefined;
		if (blocked) {
			// Every refusal used to be silent, so a session that stopped continuing by itself left
			// nothing in the debug log to explain why. Record the reason.
			logEvent("continuation_injection_blocked", { reason: blocked });
			return false;
		}
		const to =
			currentPromptSwitch?.to ??
			(ctx.model
				? ref(ctx.model.provider, ctx.model.id)
				: "the active account");
		const sameModelRetry = source?.from === to;
		const prompt = sameModelRetry
			? `Provider retry activated: retrying ${to} after a temporary failure; no account or model switch occurred. Continue the interrupted task from where it stopped. The interrupted turn is preserved verbatim in this session as a [handoff:interrupted-turn] record — read it before acting and do not restart the task from the beginning.`
			: config.continuationPrompt
					.replaceAll("{from}", String(source?.from ?? "the previous account"))
					.replaceAll("{to}", String(to))
					.replaceAll("{reason}", source?.reason ?? "provider failover");
		try {
			expectingInjectedContinuation = true;
			// The host throws "Agent is already processing. Specify streamingBehavior ('steer' or
			// 'followUp')" if we inject while the previous turn is still streaming (exactly the race
			// that fires right after a failover switch). The extension-facing option is `deliverAs`
			// (the host maps deliverAs → streamingBehavior internally — see the queued-input resume
			// path below which already uses it). "followUp" QUEUES the continuation to run after the
			// current turn settles instead of being rejected; the host ignores it when not streaming.
			// `sendUserMessage` is async on the host: a rejected promise would otherwise escape this
			// synchronous try/catch as an unhandled rejection AND still report success here.
			const dispatched = pi.sendUserMessage(prompt, {
				deliverAs: "followUp",
			}) as unknown;
			if (
				dispatched &&
				typeof (dispatched as Promise<void>).catch === "function"
			) {
				(dispatched as Promise<void>).catch((error) => {
					expectingInjectedContinuation = false;
					logEvent("continuation_injection_failed", {
						error: String(error).slice(0, 200),
					});
					reportExtensionError("continuation injection", error, ctx);
				});
			}
			logEvent("continuation_injected", {
				session: sessionInstanceId,
				from: source?.from,
				to,
				sameModelRetry,
			});
			autoContinuesThisPrompt++;
			return true;
		} catch (error) {
			expectingInjectedContinuation = false;
			logEvent("continuation_injection_failed", {
				error: String(error).slice(0, 200),
			});
			return false;
		}
	}

	async function resumeWithExistingContext(
		ctx: any,
		// Set by the pending-resume path, which returns to the SAME account and therefore has no
		// `currentPromptSwitch`. Without it the prompt-injection fallback refuses to fire.
		resumeFrom?: { from?: ModelRef; reason?: string },
	): Promise<boolean> {
		const epoch = chainEpoch;
		if (userAbortedChain || ctx.signal?.aborted) return false;
		// One logical action per resume attempt. `injectContinuationPrompt` is only ever reached
		// from inside this function, so gating here counts the attempt once however it is carried
		// out — seamless continue, or the prompt-injection fallback.
		if (!allowAction("resume the interrupted turn", ctx)) return false;
		const continueAgent = (
			pi as {
				continueAgent?: (options?: {
					stripErrorAssistant?: boolean;
				}) => Promise<void>;
			}
		).continueAgent;
		if (typeof continueAgent !== "function") {
			// Host build predates pi.continueAgent() (seamless in-place resume was added in a later
			// @earendil-works/pi-coding-agent). Do NOT dead-end the failover with a red error that
			// leaves the user reloading by hand: fall back to injecting the continuation prompt so the
			// work resumes by itself on the account we just switched to.
			if (injectContinuationPrompt(ctx, resumeFrom)) return true;
			// Reaching here means the injection fallback ALSO declined — the reason is in the
			// debug log as continuation_injection_blocked/_failed. Do not blame the Pi build:
			// the missing pi.continueAgent is only why we took the fallback path, never why the
			// fallback itself refused.
			ctx.ui.notify(
				`Provider failover [v${VERSION}]: could not auto-resume this turn; send your message to continue on ${
					ctx.model
						? ref(ctx.model.provider, ctx.model.id)
						: "the active account"
				}. Run /multi-account status for the reason.`,
				"warning",
			);
			return false;
		}
		// Bounded wait for the prior turn to go idle — NEVER an unbounded busy-loop. If it does
		// not free up within resumeIdleTimeoutMs we return false; the caller (agent_end or the
		// pending-wake timer) re-arms and tries again, so the session can't wedge here forever.
		if (!ctx.isIdle()) {
			const waitUntil = Date.now() + config.resumeIdleTimeoutMs;
			while (epoch === chainEpoch && !ctx.isIdle() && !userAbortedChain && !ctx.signal?.aborted) {
				if (Date.now() >= waitUntil) {
					ctx.ui.notify(
						`Provider failover [v${VERSION}]: the previous turn did not go idle within ${formatDelay(config.resumeIdleTimeoutMs)}; auto-retrying the resume in the background.`,
						"warning",
					);
					// Actually schedule the retry instead of just promising it: arm pending
					// auto-resume, which polls until the turn frees up and then continues by
					// itself — the user does not have to re-send the prompt.
					const failed =
						ctx.model?.provider && ctx.model?.id ? ctx.model : undefined;
					if (failed && automaticFailoverEnabled() && config.autoContinue)
						setPendingContinuation(ctx, failed, BUSY_RETRY_REASON);
					return false;
				}
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		}
		if (epoch !== chainEpoch || userAbortedChain || ctx.signal?.aborted) return false;
		const stopResumeWatch = beginResumeWatch(ctx);
		logEvent("resume_start", {
			session: sessionInstanceId,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown",
			hop: autoContinuesThisPrompt + 1,
		});
		try {
			await continueAgent({ stripErrorAssistant: true });
			if (epoch !== chainEpoch) return false;
			autoContinuesThisPrompt++;
			logEvent("resume_ok", {
				session: sessionInstanceId,
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown",
			});
			return true;
		} catch (error) {
			const text = String(error);
			// A deliberate abort (our watchdog recovery, or the user pressing Esc) is not an error
			// to report — agent_end handles what happens next. Stay silent.
			if (
				watchdogAborting ||
				epoch !== chainEpoch ||
				userAbortedChain ||
				ctx.signal?.aborted ||
				/abort/i.test(text)
			) {
				return false;
			}
			// "Cannot continue from message role: assistant" means the transcript tail is a
			// COMPLETED assistant message (a finished reply OR a turn we aborted for recovery),
			// so continueAgent cannot pick it up.
			if (/cannot continue from message role/i.test(text)) {
				// If a switch/recovery is genuinely in progress, the work is NOT done — inject the
				// continuation prompt as a user message instead. That always starts a turn, so the
				// session keeps moving by itself (this is how auto-recovery after a watchdog abort
				// continues without the user re-typing anything). Bounded by maxAutoContinuesPerPrompt.
				if (injectContinuationPrompt(ctx, resumeFrom)) return true;
				// Nothing to continue (spurious) or injection unavailable — drop stale state quietly.
				currentPromptSwitch = undefined;
				clearPendingContinuation();
				return false;
			}
			noteRecoveryFailure(ctx);
			ctx.ui.notify(
				`Provider failover: could not resume with existing context (${text})`,
				"error",
			);
			return false;
		} finally {
			stopResumeWatch();
		}
	}

	async function maybeDispatchContinuation(ctx: any): Promise<boolean> {
		if (
			!config.autoContinue ||
			userAbortedChain ||
			ctx.signal?.aborted ||
			!currentPromptSwitch ||
			autoContinuesThisPrompt >= config.maxAutoContinuesPerPrompt
		)
			return false;
		// Circuit breaker open → advisory mode. The account switch already happened (useful);
		// we just don't attempt the auto-resume that has been failing. The user's next message
		// runs on the fresh account. This is the floor: never worse than switching by hand.
		if (isBreakerOpen()) {
			ctx.ui?.notify?.(
				`Provider failover: switched to ${ctx.model?.provider ?? "a fresh account"} but auto-continue is paused (safe mode after repeated failures). Send your message to continue here, or /multi-account reset to re-enable auto-continue.`,
				"warning",
			);
			return false;
		}
		// Never resume onto an account that is ITSELF cooling down. We may have just switched to a
		// sibling whose 5h limit is also spent (its cooldown only became visible after a usage
		// refresh). Resuming there burns a request and lands us right back here, or wedges
		// compaction on a dead account (the "Working…" hang at high context). Pause instead and
		// let the wake timer resume on the first account that genuinely recovers.
		reconcileCooldownsFromUsage(ctx);
		pruneCooldowns();
		if (!isCurrentModelReady(ctx)) {
			const failed =
				ctx.model?.provider && ctx.model?.id ? ctx.model : undefined;
			if (failed && config.autoContinue) {
				setPendingContinuation(
					ctx,
					failed,
					currentPromptSwitch?.reason ?? "account is cooling down",
				);
			}
			return false;
		}
		const resumed = await resumeWithExistingContext(ctx);
		if (resumed) continuationDispatchedForAgentTurn = true;
		return resumed;
	}

	// ----- the governor, continued -----------------------------------------

	/** A request left the machine. Whatever it answered, the session is not spinning. */
	function noteProviderRequestObserved() {
		requestSignalSeen = true;
		actionsSinceRequest = 0;
		firstActionSinceRequestAt = 0;
	}

	/** A provider answered successfully — the strongest evidence there is that work is moving. */
	function noteProviderSuccessObserved() {
		successSignalSeen = true;
		noteProviderRequestObserved();
		actionsSinceSuccess = 0;
	}

	/**
	 * The user said something, or explicitly reset: the session is theirs again.
	 *
	 * Clears the counters WITHOUT touching `requestSignalSeen`/`successSignalSeen`. Those two
	 * record something quite different — whether this host has ever been observed emitting the
	 * hooks the governor watches — and only the host may set them. Letting an internal reset set
	 * them would arm the invariants on a host that never reports anything, which is the one way
	 * this mechanism could stop a session that was working fine.
	 */
	function resetGovernor() {
		actionsSinceRequest = 0;
		actionsSinceSuccess = 0;
		firstActionSinceRequestAt = 0;
		governorStoppedReason = undefined;
	}

	function governorStopped(): boolean {
		return governorStoppedReason !== undefined;
	}

	/**
	 * Stop every automatic mechanism at once, and say so.
	 *
	 * Deliberately total. A partial stop — pause this timer, leave that one armed — is how a
	 * session ends up looking stopped while something quietly restarts it, which is exactly what
	 * made `/multi-account stop` need typing three times.
	 */
	function stopEverything(ctx: any, reason: string) {
		if (governorStopped()) return;
		governorStoppedReason = reason;
		chainEpoch++;
		userAbortedChain = true;
		currentPromptSwitch = undefined;
		watchdogAborting = false;
		expectingInjectedContinuation = false;
		startFreshFailoverChain();
		clearPendingContinuation();
		if (queuedInputWakeTimer) {
			clearTimeout(queuedInputWakeTimer);
			queuedInputWakeTimer = undefined;
		}
		clearProgressWatchdog();
		const heldNote = takeHeldMessagesNote();
		logEvent("governor_stopped", {
			reason,
			actionsSinceRequest,
			actionsSinceSuccess,
		});
		try {
			ctx?.ui?.notify?.(
				`pi-multi-account [v${VERSION}]: automatic failover has STOPPED itself — ${reason}. ` +
					"Nothing is retrying in the background any more. Run /multi-account status to see when an account recovers, " +
					"/multi-account next to pick one by hand, or just send a message: your next message re-enables everything." +
					heldNote,
				"error",
			);
		} catch {
			/* a safety stop must never be the thing that throws */
		}
	}

	/**
	 * Empty the wait queue and render what was in it, for whoever is about to say why they stopped.
	 *
	 * The user's own words are the one thing in this extension's state that cannot be
	 * reconstructed from anywhere else. Every place that abandons the queue therefore hands them
	 * back in the same sentence that explains the abandonment — `/multi-account stop` used to
	 * discard them in silence, which from the outside is indistinguishable from "I typed something
	 * and the tool ate it".
	 */
	function takeHeldMessagesNote(): string {
		const held = queuedUserInputs
			.splice(0)
			.map((input) => input.text)
			.filter((text) => text.trim().length > 0);
		if (held.length === 0) return "";
		logEvent("held_messages_returned", { count: held.length });
		const what = held.length === 1 ? "message was" : `${held.length} messages were`;
		const which = held.length === 1 ? "it is" : "they are";
		return ` Your held ${what} not sent — here ${which}, to re-send: ${held
			.map((text) => JSON.stringify(text.slice(0, 200)))
			.join(" · ")}`;
	}

	/**
	 * Ask before every automatic action that touches the session.
	 *
	 * `false` means the governor has stopped: the caller must do nothing at all, not fall back to
	 * some quieter version of itself.
	 */
	function allowAction(kind: string, ctx: any): boolean {
		if (governorStopped()) return false;
		actionsSinceRequest++;
		actionsSinceSuccess++;
		if (firstActionSinceRequestAt === 0) firstActionSinceRequestAt = Date.now();
		if (
			requestSignalSeen &&
			actionsSinceRequest >= GOVERNOR_ACTIONS_WITHOUT_REQUEST
		) {
			const spanMs = Date.now() - firstActionSinceRequestAt;
			stopEverything(
				ctx,
				`${actionsSinceRequest} automatic steps in ${formatDelay(spanMs)} without a single request reaching a provider (last: ${kind})`,
			);
			return false;
		}
		if (
			successSignalSeen &&
			actionsSinceSuccess >= GOVERNOR_ACTIONS_WITHOUT_SUCCESS
		) {
			stopEverything(
				ctx,
				`${actionsSinceSuccess} automatic steps without one provider answering successfully (last: ${kind})`,
			);
			return false;
		}
		return true;
	}

	function clearPendingContinuation(options: { allowLegacy?: boolean } = {}) {
		if (pendingWakeTimer) {
			clearTimeout(pendingWakeTimer);
			pendingWakeTimer = undefined;
		}
		pendingResume = undefined;
		persistedState = {
			...persistedState,
			pendingContinuationPrompt: undefined,
			pendingFrom: undefined,
			pendingSince: undefined,
			pendingReason: undefined,
			pendingOwner: undefined,
		};
		persist(undefined, {
			clearPending: options.allowLegacy ? "owned-or-legacy" : "owned",
		});
	}

	function pendingWakeProviders(): string[] {
		if (isSameModelResumeReason(pendingResume?.reason ?? "")) {
			const parsed = pendingResume?.from
				? parseTarget(pendingResume.from)
				: undefined;
			return parsed?.provider && !isInvalidated(parsed.provider)
				? [parsed.provider]
				: [];
		}
		return [
			...new Set(
				activeFallbacks()
					.map((target) => parseTarget(target)?.provider)
					.filter((p): p is string => !!p),
			),
		].filter((provider) => !isInvalidated(provider));
	}

	function nextPendingWakeDelayMs(): number | undefined {
		const now = Date.now();
		const providers = pendingWakeProviders();
		if (providers.length === 0) return undefined;
		const nextAt = Math.min(
			...providers.map((p) => providerRecoveryAt(p, now)),
		);
		// The floor is a backoff, not a constant: see `pendingWakeBackoffMs`. Taking the minimum
		// recovery time across every rotation account means one free account elsewhere holds this
		// at the floor indefinitely, which is how a wait that never changed anything re-checked
		// once a second for four minutes.
		return Math.max(pendingWakeBackoffMs, nextAt - now);
	}

	/** A wake that changed nothing waits twice as long as the last one, up to the poll interval. */
	function growPendingWakeBackoff() {
		pendingWakeBackoffMs = Math.min(
			config.pendingPollMs,
			pendingWakeBackoffMs * 2,
		);
	}

	/** Anything that counts as forward progress puts the wait back on the floor. */
	function resetPendingWakeBackoff() {
		pendingWakeBackoffMs = MIN_PENDING_WAKE_MS;
		pendingResumeHops = 0;
	}

	/**
	 * A genuine new prompt — or an explicit stop — begins a fresh chain.
	 *
	 * Every one-attempt reprieve an account spent on the previous chain is handed back (the user
	 * asking again is a new reason to believe a stale forecast may have turned over), the rotation
	 * budget starts from zero, and the wait returns to its floor.
	 */
	function startFreshFailoverChain() {
		resetPendingWakeBackoff();
	}

	/**
	 * A real user action owns the session from this point forward.
	 *
	 * Advancing the epoch invalidates timer callbacks that already escaped `clearTimeout`; clearing
	 * pending state handles callbacks that have not started yet. Both are required — clearing only
	 * one is how an old automatic chain resumed after `/multi-account next` had already found a
	 * working account.
	 */
	function claimUserControl(reason: string) {
		chainEpoch++;
		autoContinuesThisPrompt = 0;
		resetGovernor();
		startFreshFailoverChain();
		userAbortedChain = false;
		currentPromptSwitch = undefined;
		continuationDispatchedForAgentTurn = false;
		expectingInjectedContinuation = false;
		endResumeWatch();
		if (hasPendingResume()) clearPendingContinuation();
		logEvent("user_control_claimed", { session: sessionInstanceId, reason, epoch: chainEpoch });
	}

	function schedulePendingWake(ctx: any) {
		if (pendingWakeTimer) clearTimeout(pendingWakeTimer);
		pendingWakeTimer = undefined;
		if (
			governorStopped() ||
			isBreakerOpen() ||
			!hasPendingResume() ||
			userAbortedChain ||
			!automaticFailoverEnabled() ||
			!config.autoContinue
		)
			return;
		const delay = nextPendingWakeDelayMs();
		if (delay === undefined) return;
		const epoch = chainEpoch;
		// Cap the sleep so we re-check availability periodically instead of trusting a single
		// multi-hour estimate. Each poll reconciles cooldowns against fresh usage, so the first
		// account that truly recovers wakes the session.
		pendingWakeTimer = setTimeout(
			() => {
				pendingWakeTimer = undefined;
				if (epoch !== chainEpoch) return; // stopped while we slept
				runBackground("pending auto-resume", ctx, () =>
					attemptPendingResume(ctx),
				);
			},
			Math.min(delay, config.pendingPollMs),
		);
		pendingWakeTimer.unref?.();
	}

	async function attemptPendingResume(ctx: any) {
		const epoch = chainEpoch;
		if (
			!hasPendingResume() ||
			isBreakerOpen() ||
			userAbortedChain ||
			!automaticFailoverEnabled() ||
			!config.autoContinue
		)
			return;
		if (!ctx.isIdle()) {
			schedulePendingWake(ctx);
			return;
		}
		if (autoContinuesThisPrompt >= config.maxAutoContinuesPerPrompt) {
			clearPendingContinuation();
			ctx.ui.notify(
				`Provider failover: pending resume cancelled after ${autoContinuesThisPrompt} auto-continues.`,
				"warning",
			);
			return;
		}
		// Rotations that started no turn are the ones `autoContinuesThisPrompt` cannot see, and
		// they are exactly what the ping-pong was made of. Stop, and say so in terms of what the
		// user can do about it — the alternative is a wait that looks identical to a hang.
		if (pendingResumeHops >= config.maxAutoContinuesPerPrompt) {
			clearPendingContinuation();
			logEvent("pending_resume_exhausted", {
				hops: pendingResumeHops,
				budget: config.maxAutoContinuesPerPrompt,
			});
			ctx.ui.notify(
				`Provider failover: stopped after ${pendingResumeHops} account switches that all landed on a spent account. ` +
					"Nothing was sent. Run /multi-account status to see when the first account recovers, or send a message to try again.",
				"warning",
			);
			return;
		}

		refreshDiscovery();
		reconcileCooldownsFromUsage(ctx);
		pruneCooldowns();
		const parsedFrom = pendingResume?.from
			? parseTarget(pendingResume.from)
			: undefined;
		const sourceModel = parsedFrom
			? {
					provider: parsedFrom.provider,
					id: parsedFrom.modelId ?? ctx.model?.id,
				}
			: ctx.model;
		if (!sourceModel?.provider || !sourceModel?.id) {
			clearPendingContinuation();
			return;
		}

		// Transient server errors (overload, 503, websocket) and "still busy" auto-retries are
		// NOT account/model failures: retry the SAME account/model after any brief cooldown —
		// never rotate to a sibling model (which would silently downgrade e.g. gpt-5.5 → gpt-5.4
		// on the same account, whose quota is shared, so the downgrade escapes nothing).
		if (isSameModelResumeReason(pendingResume?.reason ?? "")) {
			const now = Date.now();
			if (providerRecoveryAt(sourceModel.provider, now) <= now) {
				clearPendingContinuation();
				const same = ref(sourceModel.provider, sourceModel.id);
				// Deliberately NOT routed through the governor: this is not a rotation, it is
				// putting the session back on the account it was already using so the resume can
				// happen. The resume immediately below IS governed, so this cannot become a loop
				// on its own — and `test/governed-actions.test.ts` records the exemption so it
				// cannot be copied into a new path by accident.
				if (
					ctx.model?.provider !== sourceModel.provider ||
					ctx.model?.id !== sourceModel.id
				) {
					automaticModelTarget = same;
					if (onlyActiveModels) unhideProvider(sourceModel.provider);
					internalModelChanges++;
					try {
						await pi.setModel(
							ctx.modelRegistry.find(sourceModel.provider, sourceModel.id) ?? {
								provider: sourceModel.provider,
								id: sourceModel.id,
							},
						);
					} finally {
						internalModelChanges--;
						if (automaticModelTarget === same) automaticModelTarget = undefined;
					}
				}
				// Same-account resume: no rotation happened, so there is no currentPromptSwitch.
				// Pass the context explicitly or the injection fallback declines and the user has
				// to re-send the prompt by hand.
				if (epoch !== chainEpoch) return;
				await resumeWithExistingContext(ctx, {
					from: same,
					reason: pendingResume?.reason,
				});
				return;
			}
			schedulePendingWake(ctx);
			return;
		}

		const pendingReason = pendingResume?.reason ?? "";
		const now = Date.now();
		const sourceRef = ref(sourceModel.provider, sourceModel.id);
		const sourceRecovered =
			!isAuthPendingReason(pendingReason) &&
			providerRecoveryAt(sourceModel.provider, now) <= now &&
			(exhaustedUntilByModel.get(sourceRef) ?? 0) <= now &&
			providerHasUsableAuth(ctx, sourceModel.provider) &&
			!isInvalidated(sourceModel.provider);
		const candidates = findFallbackModels(ctx, sourceModel, {
			availableNowOnly: true,
			includeCurrent: false,
			preserveQualityBand: true,
			excludeProviders: isAuthPendingReason(pendingReason)
				? new Set<string>([sourceModel.provider])
				: undefined,
		});
		// Only accounts that are usable RIGHT NOW may be rotated onto here, and that is a stricter
		// rule than the one selection applies elsewhere on purpose.
		//
		// Everywhere else, admitting a forecast-spent sibling buys something real: a request goes
		// out under it, and a request is the only thing that can prove a stale meter wrong. On this
		// path nothing goes out — the dispatch immediately below refuses to resume onto a cooling
		// account, and rightly so, since resuming there burns the turn and lands straight back
		// here. So rotating onto one tests nothing, changes nothing, and costs a switch. Doing it
		// once a second between two spent Codex slots, while a free Anthropic account waited, is
		// exactly what this path was observed doing 275 times in four minutes.
		const otherCandidates = candidates.filter(
			(m: any) =>
				ref(m.provider, m.id) !== sourceRef &&
				providerRecoveryAt(m.provider, now) <= now &&
				(exhaustedUntilByModel.get(ref(m.provider, m.id)) ?? 0) <= now,
		);
		if (otherCandidates.length === 0) {
			if (sourceRecovered) {
				clearPendingContinuation();
				// The original account came back and there is no alternative: this is also a
				// same-account resume with no switch record.
				await resumeWithExistingContext(ctx, {
					from: sourceRef,
					reason: pendingResume?.reason,
				});
				return;
			}
			// Nothing to move to. The wait itself achieved nothing, so slow it down before the
			// next look — otherwise this is the 1 Hz poll that filled four megabytes of log.
			growPendingWakeBackoff();
			schedulePendingWake(ctx);
			return;
		}

		const reason = pendingResume?.reason ?? "account cooldown expired";
		const switched = await activateFallback(
			ctx,
			sourceModel,
			otherCandidates,
			reason,
		);
		if (epoch !== chainEpoch) return; // stopped while the switch was in flight
		if (!switched || !currentPromptSwitch) {
			growPendingWakeBackoff();
			schedulePendingWake(ctx);
			return;
		}
		// A rotation happened. Whether it was worth anything is decided by the dispatch below;
		// either way it counts against the budget, because a rotation that starts no turn is
		// precisely the move that used to be free and therefore unbounded.
		pendingResumeHops++;
		clearPendingContinuation();
		const dispatched = await maybeDispatchContinuation(ctx);
		if (epoch !== chainEpoch) return;
		if (dispatched) resetPendingWakeBackoff();
		else growPendingWakeBackoff();
	}

	function setPendingContinuation(ctx: any, failedModel: any, reason: string) {
		// A stop that leaves an armed resume behind in the state file is not a stop: the next
		// session reads it, `status` reports work pending, and the user is told something is
		// waiting to continue when nothing is.
		if (governorStopped() || isBreakerOpen()) return;
		const from = ref(failedModel.provider, failedModel.id);
		const alreadyPending = hasPendingResume();
		pendingResume = {
			from,
			reason,
			since: pendingResume?.since ?? Date.now(),
		};
		logEvent("pending_resume_set", {
			session: sessionInstanceId,
			from,
			reason,
		});
		persistedState = {
			...persistedState,
			pendingReason: reason,
			pendingFrom: from,
			pendingContinuationPrompt: undefined,
			pendingSince: pendingResume.since,
			pendingOwner: sessionInstanceId,
		};
		persist();
		const delay = nextPendingWakeDelayMs();
		if (delay === undefined) {
			clearPendingContinuation();
			if (!alreadyPending) {
				ctx.ui.notify(
					"Provider failover: no recoverable account is available; automatic resume is stopped.",
					"warning",
				);
			}
			return;
		}
		schedulePendingWake(ctx);
		if (!alreadyPending) {
			const busy = isBusyRetryPendingReason(reason);
			const transient = isTransientPendingReason(reason);
			ctx.ui.notify(
				busy
					? `Provider failover [v${VERSION}]: the previous turn is still busy on ${failedModel.provider}/${failedModel.id}. Resuming the SAME model in ~${formatDelay(delay)} (re-checks every ${formatDelay(config.pendingPollMs)}) — it will not be downgraded. Esc, a new message, or /multi-account stop cancels it.`
					: transient
						? `Provider failover: temporary server error on ${failedModel.provider}. Retrying the same account in ~${formatDelay(delay)} (re-checks every ${formatDelay(config.pendingPollMs)}). Esc, a new message, or /multi-account stop cancels it.`
						: `Provider failover: all accounts are cooling down. This session will retry automatically in ~${formatDelay(delay)} (and re-checks every ${formatDelay(config.pendingPollMs)}). Esc during a run, a new user message, /multi-account stop, or leaving the session cancels it.`,
				"warning",
			);
		}
	}

	// ----- cold-start input hold -------------------------------------------

	function clearQueuedInputs() {
		queuedWakeBackoffMs = AUTH_CHANGE_POLL_MS;
		if (queuedInputWakeTimer) {
			clearTimeout(queuedInputWakeTimer);
			queuedInputWakeTimer = undefined;
		}
		queuedUserInputs.length = 0;
	}

	function nextModelAvailabilityDelayMs(ctx: any): number | undefined {
		const candidates = findFallbackModels(ctx, ctx.model, {
			includeCurrent: true,
		});
		if (candidates.length === 0) return undefined;
		const now = Date.now();
		const nextAt = Math.min(
			...candidates.map((model: any) => {
				const modelUntil =
					exhaustedUntilByModel.get(ref(model.provider, model.id)) ?? now;
				return Math.max(providerRecoveryAt(model.provider, now), modelUntil);
			}),
		);
		return Math.max(MIN_PENDING_WAKE_MS, nextAt - now);
	}

	function queuedInputContent(input: { text: string; images?: any[] }) {
		if (!input.images?.length) return input.text;
		return [{ type: "text", text: input.text }, ...input.images];
	}

	function scheduleQueuedInputWake(ctx: any) {
		if (queuedInputWakeTimer) clearTimeout(queuedInputWakeTimer);
		if (
			governorStopped() ||
			queuedUserInputs.length === 0 ||
			userAbortedChain ||
			!automaticFailoverEnabled()
		) {
			queuedInputWakeTimer = undefined;
			return;
		}
		const availabilityDelay = nextModelAvailabilityDelayMs(ctx);
		if (availabilityDelay === undefined) {
			queuedInputWakeTimer = undefined;
			return;
		}
		// Poll auth.json too, so a /login in another Pi process wakes this session quickly
		// instead of waiting for a multi-hour quota cooldown.
		// Poll auth.json quickly at first, then relax. Picking up a `/login` from another process
		// within seconds is worth a fast poll for the first minute; keeping that rate for the six
		// hours a real quota window can last is how a waiting session produced megabytes of log
		// and a usage probe per account every five seconds, for nothing.
		const delay = Math.min(
			availabilityDelay,
			Math.max(AUTH_CHANGE_POLL_MS, queuedWakeBackoffMs),
		);
		queuedWakeBackoffMs = Math.min(
			config.pendingPollMs,
			Math.max(AUTH_CHANGE_POLL_MS, queuedWakeBackoffMs * 2),
		);
		const epoch = chainEpoch;
		queuedInputWakeTimer = setTimeout(() => {
			queuedInputWakeTimer = undefined;
			if (epoch !== chainEpoch) return; // stopped while we slept
			runBackground("queued input resume", ctx, () =>
				attemptQueuedInputResume(ctx),
			);
		}, delay);
		queuedInputWakeTimer.unref?.();
	}

	async function attemptQueuedInputResume(ctx: any) {
		const epoch = chainEpoch;
		if (
			queuedUserInputs.length === 0 ||
			userAbortedChain ||
			!automaticFailoverEnabled()
		)
			return;
		if (!ctx.isIdle()) {
			scheduleQueuedInputWake(ctx);
			return;
		}
		reconcileCooldownsFromUsage(ctx);
		const ready = await ensureReadyModel(
			ctx,
			"queued input: account became available",
		);
		if (epoch !== chainEpoch) return; // stopped while the preflight was in flight
		if (!ready) {
			scheduleQueuedInputWake(ctx);
			return;
		}
		if (!allowAction("send a held message", ctx)) return;
		const count = queuedUserInputs.length;
		if (queuedInputWakeTimer) {
			clearTimeout(queuedInputWakeTimer);
			queuedInputWakeTimer = undefined;
		}
		logEvent("queued_input_flush_started", {
			count,
			provider: ctx.model?.provider,
			model: ctx.model?.id,
		});
		while (queuedUserInputs.length > 0) {
			const input = queuedUserInputs[0];
			// Supplying followUp is harmless while idle, but closes the check→send race if another
			// automatic turn starts after the idle check and before this call. Await each submission so
			// two held messages cannot both observe the same idle gap and start competing runs. Remove
			// an item only after the host accepted it; a rejected dispatch must never eat the user's text.
			try {
				await pi.sendUserMessage(queuedInputContent(input), { deliverAs: "followUp" });
				queuedUserInputs.shift();
			} catch (error) {
				logEvent("queued_input_dispatch_failed", {
					remaining: queuedUserInputs.length,
					error: String(error).slice(0, 200),
				});
				scheduleQueuedInputWake(ctx);
				ctx.ui.notify(
					"Provider failover: the selected account is ready, but Pi did not accept the held message yet; it remains queued and will retry automatically.",
					"warning",
				);
				return;
			}
		}
		logEvent("queued_input_flushed", { count });
		ctx.ui.notify(
			`Provider failover: resumed ${count} queued message(s) on ${ctx.model.provider}/${ctx.model.id}.`,
			"info",
		);
	}

	async function resumeQueuedInputsAfterManualSwitch(ctx: any, switched: boolean) {
		if (!switched || queuedUserInputs.length === 0) return;
		// A manual account choice is direct evidence that the user wants the held work to run there.
		// Do not leave it sleeping behind the cooldown timestamp that belonged to the old account.
		userAbortedChain = false;
		await attemptQueuedInputResume(ctx);
	}

	function queueUserInput(ctx: any, text: string, images?: any[]) {
		if (queuedUserInputs.length >= MAX_QUEUED_USER_INPUTS) {
			ctx.ui.notify(
				`Provider failover: the automatic wait queue is full (${MAX_QUEUED_USER_INPUTS}); use /multi-account stop before retrying.`,
				"error",
			);
			return;
		}
		queuedUserInputs.push({ text, images });
		logEvent("queued_input_held", { count: queuedUserInputs.length });
		const delay = nextModelAvailabilityDelayMs(ctx);
		if (delay === undefined) return;
		scheduleQueuedInputWake(ctx);
		ctx.ui.notify(
			`Provider failover: all usable accounts are cooling down. Your message is held in memory and will be sent automatically in ~${formatDelay(delay)}; /multi-account stop cancels it.`,
			"warning",
		);
	}

	// ----- error classification --------------------------------------------

	function isAuthError(text: string) {
		if (!text.trim()) return false;
		if (patternMatch(text, config.ignoreErrorPatterns)) return false;
		return patternMatch(text, config.authErrorPatterns);
	}

	function isLimitError(text: string) {
		if (!text.trim()) return false;
		if (patternMatch(text, config.ignoreErrorPatterns)) return false;
		return patternMatch(text, config.limitErrorPatterns);
	}

	function isTransientError(text: string) {
		if (!text.trim()) return false;
		if (patternMatch(text, config.ignoreErrorPatterns)) return false;
		return patternMatch(text, config.transientErrorPatterns);
	}

	function isModelError(text: string) {
		if (!text.trim()) return false;
		if (patternMatch(text, config.ignoreErrorPatterns)) return false;
		return patternMatch(text, config.modelErrorPatterns);
	}

	function assistantErrorText(message: any) {
		const parts: string[] = [];
		if (typeof message?.errorMessage === "string")
			parts.push(message.errorMessage);
		for (const diagnostic of Array.isArray(message?.diagnostics)
			? message.diagnostics
			: []) {
			if (typeof diagnostic?.error?.message === "string")
				parts.push(diagnostic.error.message);
			if (diagnostic?.error?.code !== undefined)
				parts.push(String(diagnostic.error.code));
		}
		for (const block of Array.isArray(message?.content)
			? message.content
			: []) {
			if (block?.type === "text" && typeof block.text === "string")
				parts.push(block.text);
		}
		return [...new Set(parts.map((part) => part.trim()).filter(Boolean))].join(
			"\n",
		);
	}

	// ----- command ----------------------------------------------------------

	function clearProviderRuntimeState(provider: string) {
		invalidatedByProvider.delete(provider);
		exhaustedUntilByProvider.delete(provider);
		authFailures.delete(provider);
		usageByProvider.delete(provider);
		usageErrors.delete(provider);
		codexModelCatalogByProvider.delete(provider);
		credentialHashes.delete(provider);
		credentialIdentities.delete(provider);
		registeredSlots.delete(provider);
		for (const key of [...exhaustedUntilByModel.keys()]) {
			if (key.startsWith(`${provider}/`)) exhaustedUntilByModel.delete(key);
		}
	}

	async function removeAuthSlot(ctx: any, id: string): Promise<boolean> {
		const auth = readAuthFile();
		if (!auth[id]) return false;
		const kept = { ...auth };
		delete kept[id];
		try {
			writeFileSync(AUTH_PATH, `${JSON.stringify(kept, null, "\t")}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
		} catch {
			ctx.ui.notify(
				"pi-multi-account: could not update auth.json (file may be locked). Try again.",
				"error",
			);
			return false;
		}
		clearProviderRuntimeState(id);
		persist();
		const wasCurrent = ctx.model?.provider === id;
		reloadHostAuth(ctx);
		refreshDiscovery(true, ctx);
		if (wasCurrent) {
			await ensureReadyModel(ctx, `removed current account ${id}`);
		}
		return true;
	}

	async function handleCommand(args: string, ctx: any) {
		const [commandRaw, arg1] = args.trim().split(/\s+/);
		const command = (commandRaw || "status").toLowerCase();

		if (command === "log" || command === "logs" || command === "debug") {
			// Show the diagnostic black box so a misbehaviour can be reported precisely.
			if (arg1 === "off") {
				config = { ...config, debugLog: false };
				debugLogEnabled = false;
				ctx.ui.notify(
					'pi-multi-account: debug logging disabled for this session. Set "debugLog": true in the config to re-enable permanently.',
					"info",
				);
				return;
			}
			if (arg1 === "on") {
				config = { ...config, debugLog: true };
				debugLogEnabled = true;
				logEvent("debug_enabled", { version: VERSION });
				ctx.ui.notify(
					`pi-multi-account: debug logging enabled. File: ${DEBUG_LOG_PATH}`,
					"info",
				);
				return;
			}
			const n = Math.min(
				200,
				Math.max(1, Number.parseInt(arg1 ?? "", 10) || 40),
			);
			const tail = readDebugLogTail(n);
			ctx.ui.notify(
				tail
					? `pi-multi-account debug log (last ${n} events) — ${DEBUG_LOG_PATH}\n${tail}`
					: `pi-multi-account: no debug log yet at ${DEBUG_LOG_PATH} (it fills as failover events happen; enable with /multi-account log on if needed).`,
				"info",
			);
			return;
		}

		if (command === "models" || command === "model") {
			// Show, per account in the rotation, the model order this extension would use
			// (★ = the one that would be selected). Lets you SEE whether the latest model is
			// actually available and chosen on each account.
			refreshDiscovery(false, ctx);
			const lines = [
				`pi-multi-account models (prefer-latest: ${config.preferLatestModel ? "ON" : "OFF"}) — ★ = selected first:`,
			];
			for (const target of activeFallbacks()) {
				const parsed = parseTarget(target);
				if (!parsed) continue;
				const ordered = resolveTargets(ctx, target, ctx.model).map(
					(m: any, i: number) => (i === 0 ? `★${m.id}` : m.id),
				);
				lines.push(
					`  ${parsed.provider}: ${ordered.join(", ") || "(no models registered — check /login)"}`,
				);
			}
			const overrides = Object.entries(config.preferredModels);
			if (overrides.length > 0) {
				lines.push(
					`Config overrides: ${overrides.map(([fam, list]) => `${fam}=[${list.join(", ")}]`).join("; ")}`,
				);
			} else {
				lines.push(
					`Live Codex discovery: ${config.autoDiscoverModels ? `ON${discoveredCodexModelOrder.length ? ` — ${discoveredCodexModelOrder.join(" → ")}` : " — no cached catalog yet"}` : "OFF"}.`,
				);
			}
			ctx.ui.notify(lines.join("\n"), "info");
			return;
		}

		if (command === "reload") {
			const previousAutoDiscoverModels = config.autoDiscoverModels;
			config = loadConfig();
			if (config.onlyActive !== onlyActiveModels) {
				onlyActiveModels = config.onlyActive;
				if (onlyActiveModels) applyOnlyActiveFilter(ctx);
				else clearOnlyActiveFilter();
			}
			debugLogEnabled = config.debugLog;
			configuredFallbacks = config.fallbacks.slice();
			if (config.autoDiscoverModels !== previousAutoDiscoverModels) {
				registryCodexModelOrder = [];
				if (!config.autoDiscoverModels) {
					discoveredCodexModelOrder = [];
					discoveredOllamaModelIds = [];
					ollamaCatalogFetchedAt = 0;
				}
			}
			refreshDiscovery(true, ctx);
			startUsageStatusTimer(ctx);
			runBackground("reload account metadata refresh", ctx, async () => {
				await refreshRotationUsage(ctx);
				await syncCodexModelCatalog(ctx, true);
				await syncOllamaModelCatalog(ctx, true);
			});
			ctx.ui.notify(
				"pi-multi-account: config reloaded and accounts re-discovered",
				"info",
			);
			return;
		}
		if (command === "rediscover") {
			const changed = refreshDiscovery(true, ctx);
			runBackground("rediscover slot proxy republish", ctx, async () => {
				await publishProxiedSlots(ctx);
				publishOwnedNativeAliases(ctx);
			});
			runBackground("rediscover account metadata refresh", ctx, async () => {
				await refreshRotationUsage(ctx);
				await syncCodexModelCatalog(ctx, true);
				await syncOllamaModelCatalog(ctx, true);
			});
			ctx.ui.notify(
				`pi-multi-account: rediscovered accounts${changed ? "" : " (no auth.json change)"}. Rotation: ${rotation.join(" → ") || "none"}`,
				"info",
			);
			return;
		}
		if (command === "add") {
			const family = parseFamilyArg(arg1);
			if (!family) {
				ctx.ui.notify(
					"pi-multi-account: usage: /multi-account add <anthropic|codex|kimi|cursor|ollama|qwen>",
					"warning",
				);
				return;
			}
			const auth = readAuthFile();
			let n = 2;
			while (
				auth[slotId(family, n, config.qwenProvider)] &&
				n <= config.maxAccountsPerProvider
			)
				n++;
			if (n > config.maxAccountsPerProvider) {
				ctx.ui.notify(
					`pi-multi-account: no free ${family} slot (max ${config.maxAccountsPerProvider}). Remove an unused one from auth.json first.`,
					"warning",
				);
				return;
			}
			const id = slotId(family, n, config.qwenProvider);
			if (family === "cursor" && !isCursorProviderInstalled()) {
				// Asked for by name → this is exactly when the clone instruction is useful.
				await refreshCursorSlots(auth, ctx, true);
				return;
			}
			syncRegisteredSlots(auth, ctx);
			if (
				family === "anthropic" ||
				family === "openai-codex" ||
				family === "kimi-coding" ||
				family === "cursor"
			) {
				const loginHint =
					family === "cursor"
						? `run /login, authenticate your Cursor subscription in the browser, select ${id}`
						: `run /login, choose "Use a subscription", select ${id}`;
				ctx.ui.notify(
					`pi-multi-account: ${loginHint}, then run /multi-account rediscover`,
					"info",
				);
			} else {
				ctx.ui.notify(
					`pi-multi-account: add an entry "${id}" to ~/.pi/agent/auth.json with {"type":"api_key","key":"<your key>"} and run /multi-account rediscover`,
					"info",
				);
			}
			return;
		}
		if (command === "remove" || command === "rm" || command === "delete") {
			const targetRaw = arg1?.trim();
			if (!targetRaw) {
				ctx.ui.notify(
					"pi-multi-account: usage: /multi-account remove <anthropic|codex|cursor|ollama|qwen|provider-id>",
					"warning",
				);
				return;
			}
			const auth = readAuthFile();
			const id = resolveRemoveTarget(targetRaw, auth, config.qwenProvider);
			if (!id) {
				const family = parseFamilyArg(targetRaw);
				ctx.ui.notify(
					family
						? `pi-multi-account: no ${family} account to remove.`
						: `pi-multi-account: unknown or missing account "${targetRaw}". Rotation: ${rotation.join(", ") || "none"}`,
					"warning",
				);
				return;
			}
			const removed = await removeAuthSlot(ctx, id);
			if (removed) {
				ctx.ui.notify(
					`pi-multi-account: removed ${id}. Rotation: ${rotation.join(" → ") || "none"}`,
					"info",
				);
			}
			return;
		}
		if (command === "revive") {
			const target = arg1?.trim();
			if (!target) {
				ctx.ui.notify(
					"pi-multi-account: usage: /multi-account revive <provider|all>",
					"warning",
				);
				return;
			}
			const targets =
				target === "all" ? [...invalidatedByProvider.keys()] : [target];
			let revived = 0;
			for (const p of targets) {
				if (invalidatedByProvider.delete(p)) revived++;
				exhaustedUntilByProvider.delete(p);
				authFailures.delete(p);
			}
			if (revived > 0) persist();
			refreshDiscovery(true, ctx);
			ctx.ui.notify(
				`pi-multi-account: revived ${revived} account(s)${target === "all" ? "" : ` (${target})`}. They are back in rotation.`,
				"info",
			);
			return;
		}
		if (command === "clear") {
			// Wipe EVERYTHING: fallbacks config, rotation state, cooldowns,
			// invalidations, usage, pending work, AND alias slots from auth.json —
			// so the user can rebuild the fallback list from scratch starting at
			// account-2. Base providers (anthropic, openai-codex, ollama, alibaba)
			// stay in auth.json; only numbered alias slots are removed.
			configuredFallbacks = [];
			config = { ...config, fallbacks: [] };
			try {
				const raw = existsSync(CONFIG_PATH)
					? JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
					: {};
				raw.fallbacks = [];
				writeFileSync(CONFIG_PATH, `${JSON.stringify(raw, null, "\t")}\n`, {
					encoding: "utf8",
					mode: 0o600,
				});
			} catch {
				// non-fatal: in-memory state is still cleared
			}
			// Remove all numbered alias slots from auth.json so /multi-account add
			// starts fresh at account-2. Keep base providers (no -account-N suffix)
			// and keep unrelated providers (openrouter, deepseek, zai, etc.).
			const removedSlots: string[] = [];
			try {
				const auth = readAuthFile();
				const kept: Record<string, AuthEntry> = {};
				for (const [id, entry] of Object.entries(auth)) {
					if (/-account-\d+$/.test(id)) {
						removedSlots.push(id);
					} else {
						kept[id] = entry;
					}
				}
				if (removedSlots.length > 0) {
					writeFileSync(AUTH_PATH, `${JSON.stringify(kept, null, "\t")}\n`, {
						encoding: "utf8",
						mode: 0o600,
					});
				}
			} catch {
				// non-fatal: auth.json may be locked by a concurrent Pi process
			}
			// Forget every alias slot we ever registered with Pi — they no longer
			// have credentials, so re-discovery will not pick them up.
			registeredSlots.clear();
			exhaustedUntilByProvider.clear();
			exhaustedUntilByModel.clear();
			invalidatedByProvider.clear();
			authFailures.clear();
			usageByProvider.clear();
			usageErrors.clear();
			codexModelCatalogByProvider.clear();
			discoveredCodexModelOrder = [];
			responseCooldownHints.clear();
			handledAssistantErrors.clear();
			currentPromptSwitch = undefined;
			chainEpoch++;
			autoContinuesThisPrompt = 0;
			resetGovernor();
			startFreshFailoverChain();
			userAbortedChain = false;
			clearPendingContinuation();
			clearQueuedInputs();
			persistedState = {
				stateVersion: STATE_VERSION,
				exhaustedUntilByProvider: {},
				exhaustedUntilByModel: {},
				lastProbeAtByProvider: {},
				invalidatedByProvider: {},
				usageByProvider: {},
				codexModelCatalogByProvider: {},
				lastSwitches: [],
			};
			saveState(persistedState);
			rotation = [];
			duplicateSlots = [];
			reloadHostAuth(ctx);
			ctx.ui.notify(
				`pi-multi-account: cleared all fallbacks, state and ${removedSlots.length} alias slot(s)${removedSlots.length ? ` (${removedSlots.join(", ")})` : ""}. Run /multi-account add <family> then /login to rebuild.`,
				"info",
			);
			return;
		}
		if (command === "reset") {
			chainEpoch++;
			exhaustedUntilByProvider.clear();
			currentPromptSwitch = undefined;
			autoContinuesThisPrompt = 0;
			resetGovernor();
			startFreshFailoverChain();
			userAbortedChain = false;
			recoveryFailures = 0;
			breakerOpenUntil = 0;
			watchdogAborting = false;
			expectingInjectedContinuation = false;
			authFailures.clear();
			responseCooldownHints.clear();
			handledAssistantErrors.clear();
			usageByProvider.clear();
			usageErrors.clear();
			clearPendingContinuation();
			clearQueuedInputs();
			exhaustedUntilByModel.clear();
			persistedState = {
				stateVersion: STATE_VERSION,
				exhaustedUntilByProvider: {},
				exhaustedUntilByModel: {},
				lastProbeAtByProvider: {},
				invalidatedByProvider: {},
				usageByProvider: {},
				codexModelCatalogByProvider: Object.fromEntries(
					codexModelCatalogByProvider.entries(),
				),
				lastSwitches: [],
			};
			invalidatedByProvider.clear();
			saveState(persistedState);
			refreshDiscovery(true, ctx);
			ctx.ui.notify(
				"pi-multi-account: cooldowns, invalidations and pending resume reset",
				"info",
			);
			return;
		}
		if (command === "accounts" || command === "account") {
			if (arg1 && arg1 !== "refresh") {
				ctx.ui.notify(
					"pi-multi-account: usage: /multi-account accounts [refresh]",
					"warning",
				);
				return;
			}
			if (arg1 === "refresh") {
				refreshDiscovery(false, ctx);
				const auth = readAuthFile();
				const duplicates = new Set(
					duplicateSlots.map(({ duplicate }) => duplicate),
				);
				const providers = Object.entries(auth)
					.filter(
						([provider, entry]) =>
							!!usageFamily(provider) &&
							isEntryUsable(entry) &&
							!duplicates.has(provider),
					)
					.map(([provider]) => provider);
				await Promise.all(
					providers.map((provider) => refreshUsage(ctx, provider, true, true)),
				);
			}
			ctx.ui.notify(renderAccountTable(ctx), "info");
			return;
		}
		if (command === "limits" || command === "usage" || command === "quota") {
			const provider = ctx.model?.provider;
			if (!provider || !usageFamily(provider)) {
				ctx.ui.notify(
					`pi-multi-account: usage limits are not available for ${provider ?? "the current model"}`,
					"warning",
				);
				return;
			}
			const snapshot = await refreshUsage(ctx, provider, arg1 === "refresh");
			const warning = usageErrors.get(provider);
			if (!snapshot) {
				ctx.ui.notify(
					`pi-multi-account: could not load limits for ${provider}${warning ? `: ${warning}` : ""}`,
					"warning",
				);
				return;
			}
			ctx.ui.notify(
				`${formatUsageDetails(displayUsageSnapshot(snapshot))}${warning ? `\nRefresh warning: ${warning}` : ""}`,
				warning ? "warning" : "info",
			);
			return;
		}
		if (command === "switch" || command === "use") {
			const target = arg1?.trim();
			if (!target) {
				ctx.ui.notify(
					`pi-multi-account: usage: /multi-account switch <provider>. Available: ${rotation.join(", ") || "none"}`,
					"warning",
				);
				return;
			}
			const parsed = resolveSwitchTarget(target, ctx);
			if (!parsed) {
				ctx.ui.notify(
					`pi-multi-account: unknown provider "${target}". Rotation: ${rotation.join(", ") || "none"}`,
					"warning",
				);
				return;
			}
			if ("ambiguous" in parsed) {
				ctx.ui.notify(
					`pi-multi-account: "${target}" matches ${parsed.ambiguous.join(", ")} — name one of them.`,
					"warning",
				);
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify(
					"pi-multi-account: no active model to switch from",
					"warning",
				);
				return;
			}
			claimUserControl(`manual switch ${target}`);
			// Manual switch is an EXPLICIT override, so give the target a clean slate:
			//  - clear any cooldown (the user is overriding a rate-limit wait), AND
			//  - clear a STALE invalidation. An account can stay invalidated long after its real
			//    cause is gone — e.g. it was killed by a since-fixed provider bug (the wrong Qwen
			//    endpoint), or the key was replaced but its hash-based auto-revive never ran because
			//    the auth-file mtime hadn't changed. Refusing the user's own switch in that state was
			//    the "fresh key still says: not logged in" bug. Revive, reload auth, force
			//    re-discovery, and let the account prove itself on the real request instead.
			const wasInvalid = invalidatedByProvider.delete(parsed.provider);
			authFailures.delete(parsed.provider);
			exhaustedUntilByProvider.delete(parsed.provider);
			for (const key of [...exhaustedUntilByModel.keys()]) {
				if (key.startsWith(`${parsed.provider}/`)) {
					exhaustedUntilByModel.delete(key);
				}
			}
			persist();
			refreshDiscovery(true, ctx);
			// Use the RESOLVED slot id, not the raw text: a short name that resolved above would
			// otherwise be handed on verbatim and find nothing.
			const resolvedTarget = parsed.modelId
				? `${parsed.provider}/${parsed.modelId}`
				: parsed.provider;
			const candidates = resolveTargets(ctx, resolvedTarget, ctx.model, true).filter(
				(model: any) => providerHasUsableAuth(ctx, model.provider),
			);
			if (candidates.length === 0) {
				const hasAuth = providerHasUsableAuth(ctx, parsed.provider);
				ctx.ui.notify(
					hasAuth
						? `pi-multi-account: "${target}" is logged in but the host exposes no model for it yet. Run /multi-account rediscover, or restart Pi if you just logged in.`
						: `pi-multi-account: no credentials for "${target}" in auth.json — run /login and pick it. Rotation: ${rotation.join(", ") || "none"}`,
					"warning",
				);
				return;
			}
			if (wasInvalid)
				ctx.ui.notify(
					`pi-multi-account: cleared a stale invalidation on "${parsed.provider}" and is retrying it now.`,
					"info",
				);
			currentPromptSwitch = undefined;
			const switched = await activateFallback(
				ctx,
				ctx.model,
				candidates,
				`manual /multi-account switch ${target}`,
				{ armContinuation: false, manual: true },
			);
			currentPromptSwitch = undefined;
			if (switched) {
				announceManualChoice(ctx);
				await resumeQueuedInputsAfterManualSwitch(ctx, true);
			} else {
				ctx.ui.notify(
					`pi-multi-account: could not switch to "${target}"`,
					"warning",
				);
			}
			return;
		}
		/**
		 * Resolve what the user typed to a real slot.
		 *
		 * The slot ids are internal (`kimi-coding`, `openai-codex-account-6`) and `switch` demanded
		 * one exactly, so the only command that reaches a chosen account directly answered
		 * `unknown provider "kimi"` to the name a person would actually type — leaving `next` and
		 * its walk through every spent account as the only way there. An exact id always wins; a
		 * short name resolves only when it is unambiguous, because guessing between two Codex slots
		 * would silently spend the wrong account's quota.
		 */
		function resolveSwitchTarget(
			target: string,
			ctx: any,
		):
			| { provider: string; modelId?: string }
			| { ambiguous: string[] }
			| undefined {
			const parsed = parseTarget(target);
			if (!parsed) return undefined;
			const known = new Set([...rotation, ...Object.keys(readAuthFile())]);
			if (known.has(parsed.provider)) return parsed;
			if (providerHasUsableAuth(ctx, parsed.provider)) return parsed;
			const needle = parsed.provider.toLowerCase();
			const matches = [...known].filter(
				(id) =>
					id.toLowerCase().startsWith(needle) || id.toLowerCase().includes(needle),
			);
			if (matches.length === 1) return { ...parsed, provider: matches[0] };
			if (matches.length > 1) return { ambiguous: matches.sort() };
			return parsed;
		}

		if (command === "best" || command === "live") {
			// `next` walks the ring a step at a time and `switch` needs an exact name, so on a
			// machine with a dozen accounts — most of them spent — reaching a working one meant
			// pressing next until something answered, landing on and being bounced off each dead
			// account on the way. This asks the one question a person actually has: put me
			// somewhere that can work right now.
			if (!ctx.model) {
				ctx.ui.notify(
					"pi-multi-account: no active model to switch from",
					"warning",
				);
				return;
			}
			claimUserControl("manual best");
			const candidates = findFallbackModels(ctx, ctx.model, {
				availableNowOnly: true,
				includeCurrent: true,
				preferSameIdentity: false,
				preserveQualityBand: true,
			});
			if (candidates.length === 0) {
				const wait = nextRecoveryStatus(ctx);
				ctx.ui.notify(
					`pi-multi-account: no account can serve work right now. ${wait}`,
					"warning",
				);
				return;
			}
			if (
				candidates[0].provider === ctx.model.provider &&
				candidates[0].id === ctx.model.id
			) {
				modelPreferenceChanged = true;
				rememberUserModel(ctx.model);
				ctx.ui.notify(
					`pi-multi-account: already on the best available account (${ctx.model.provider}/${ctx.model.id})`,
					"info",
				);
				await resumeQueuedInputsAfterManualSwitch(ctx, true);
				return;
			}
			currentPromptSwitch = undefined;
			const verified = isConfirmedAvailable(candidates[0].provider);
			const switched = await activateFallback(
				ctx,
				ctx.model,
				candidates,
				"manual /multi-account best",
				{ armContinuation: false, manual: true },
			);
			currentPromptSwitch = undefined;
			if (switched) {
				announceManualChoice(ctx);
				await resumeQueuedInputsAfterManualSwitch(ctx, true);
				// Saying "best" of an account nobody can measure overstates what was done. When no
				// account confirms availability, this is the least-bad guess, and calling it that
				// is the difference between a considered choice and looking random.
				if (!verified)
					ctx.ui.notify(
						`pi-multi-account: no account confirmed availability — ${ctx.model?.provider} has no quota endpoint to check, so this is an unverified guess. Everything measurable is spent.`,
						"warning",
					);
			}
			else
				ctx.ui.notify(
					"pi-multi-account: could not switch to the best available account",
					"warning",
				);
			return;
		}
		if (command === "only-active" || command === "focus") {
			const next2 =
				arg1 === "on" ? true : arg1 === "off" ? false : !onlyActiveModels;
			onlyActiveModels = next2;
			config = { ...config, onlyActive: next2 };
			try {
				const raw = existsSync(CONFIG_PATH)
					? JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
					: {};
				raw.onlyActive = next2;
				writeFileSync(CONFIG_PATH, `${JSON.stringify(raw, null, "\t")}\n`, {
					encoding: "utf8",
					mode: 0o600,
				});
			} catch {
				// non-fatal: the in-memory flag still applies for this session
			}
			if (next2) applyOnlyActiveFilter(ctx);
			else clearOnlyActiveFilter();
			ctx.ui.notify(
				next2
					? "pi-multi-account: only-active ON — /model shows only the active account's models; the filter follows every switch"
					: "pi-multi-account: only-active OFF — every provider's models restored",
				"info",
			);
			return;
		}
		if (command === "priority" || command === "order") {
			const rest = args.trim().split(/\s+/).slice(1).join(" ").trim();
			const groupsPresent = [
				...new Set(rotation.map((id) => normalizeGroup(id))),
			].filter(Boolean);

			// No argument: report, never change. The ladder is the kind of setting people check
			// far more often than they set.
			if (!rest) {
				const lines = describePriority(config.providerPriority, groupsPresent);
				ctx.ui.notify(
					[
						"pi-multi-account: failover priority — where work goes once EVERY account of the",
						"current provider is spent. Same-provider failover always runs first, and an account",
						"on cooldown is never chosen over a free one; this only orders the rest.",
						"",
						...lines,
						"",
						"Set:   /multi-account priority anthropic openai-codex kimi-coding cursor",
						"Reset: /multi-account priority reset",
					].join("\n"),
					"info",
				);
				return;
			}

			const reset = /^(reset|default|defaults)$/i.test(rest);
			const cleared = /^(none|off|clear)$/i.test(rest);
			// "none" is a real answer, distinct from resetting: it says "I have no preference,
			// decide by liveness alone", which is what an empty ladder means to the comparator.
			const next = reset
				? [...DEFAULT_PROVIDER_PRIORITY]
				: cleared
					? []
					: normalizePriority(rest);
			if (!reset && !cleared && next.length === 0) {
				ctx.ui.notify(
					`pi-multi-account: could not read any provider name in "${rest}". Try: /multi-account priority anthropic openai-codex kimi-coding cursor`,
					"warning",
				);
				return;
			}

			config = { ...config, providerPriority: next };
			try {
				const raw = existsSync(CONFIG_PATH)
					? JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
					: {};
				raw.providerPriority = next;
				writeFileSync(CONFIG_PATH, `${JSON.stringify(raw, null, "\t")}\n`, {
					encoding: "utf8",
					mode: 0o600,
				});
			} catch {
				// non-fatal: the ladder still applies for this session
			}
			logEvent("priority_set", { priority: next, reset, cleared });

			// Naming a provider that is not logged in is not an error — people set the ladder they
			// intend to have, then log in. But it must be said, or a typo looks like it worked.
			const unknown = next.filter((group) => !groupsPresent.includes(group));
			ctx.ui.notify(
				[
					cleared
						? "pi-multi-account: failover priority cleared — order decided by live availability alone."
						: reset
							? "pi-multi-account: failover priority reset to the default ladder."
							: "pi-multi-account: failover priority set.",
					...describePriority(next, groupsPresent),
					...(unknown.length > 0
						? [
								"",
								`Not logged in (kept in the ladder for when you are): ${unknown.join(", ")}`,
							]
						: []),
				].join("\n"),
				"info",
			);
			return;
		}
		if (command === "next") {
			if (ctx.model) {
				claimUserControl("manual next");
				// Manual rotation is a user override, NOT a rate-limit event: cooling the account
				// we're leaving (the old 5-minute cooldown) drained the pool — after one lap every
				// provider was "cooling" and the round-robin collapsed onto whatever was left. Pass
				// 0 so we only record lastLeftProvider (anti-ping-pong) and keep every account
				// selectable, so repeated /multi-account next truly cycles through them all.
				const switched = await switchToFallback(
					ctx,
					ctx.model,
					"manual /multi-account next",
					0,
					{ manual: true },
				);
				currentPromptSwitch = undefined;
				if (switched) {
					announceManualChoice(ctx);
					await resumeQueuedInputsAfterManualSwitch(ctx, true);
				}
			}
			return;
		}
		if (command === "stop") {
			// First, so every async chain already past its guards abandons itself instead of
			// re-arming the wait a moment after this line clears it. That race is why stop used to
			// need typing two or three times.
			chainEpoch++;
			userAbortedChain = true;
			resetGovernor();
			startFreshFailoverChain();
			currentPromptSwitch = undefined;
			watchdogAborting = false;
			expectingInjectedContinuation = false;
			clearPendingContinuation();
			const heldNote = takeHeldMessagesNote();
			clearQueuedInputs();
			endResumeWatch();
			ctx.abort();
			ctx.ui.notify(
				`pi-multi-account: automatic failover/resume stopped for the current task.${heldNote}`,
				"info",
			);
			return;
		}
		if (command === "enable" || command === "disable") {
			config = { ...config, enabled: command === "enable" };
			if (!config.enabled) clearPendingContinuation();
			ctx.ui.notify(
				`pi-multi-account: failover ${config.enabled ? "enabled" : "disabled"} for this Pi process`,
				"info",
			);
			return;
		}

		refreshDiscovery(false, ctx);
		const current = ctx.model
			? `${ctx.model.provider}/${ctx.model.id}`
			: "none";
		// What the rotation looks like to anything that does NOT load this extension: a memory
		// extension consolidating its notes, an external CLI, any `pi -p --no-extensions` child.
		// Such a child reads settings.json for the active account, and if that slot is one it
		// cannot authenticate to it does not fail — it quietly runs on Pi's first available
		// provider instead, which is a different account and usually a different vendor.
		const childView = slotsAsAChildSeesThem(rotation, readAuthFileRaw());
		const childUnusable = childView.filter((verdict) => !verdict.usable);
		const childRouteWarning = defaultRouteWarning(
			readHostDefaultModel()?.provider,
			(slotId) => slotsAsAChildSeesThem([slotId], readAuthFileRaw())[0],
		);
		const currentUsage = ctx.model
			? cachedUsage(ctx.model.provider)
			: undefined;
		const cooldowns = [...exhaustedUntilByProvider.entries()]
			.filter(([p, until]) => until > Date.now() && !isInvalidated(p))
			.map(([p, until]) => `${p}: ${formatUntil(until)}`);
		const invalids = [...invalidatedByProvider.entries()].map(
			([p, r]) => `${p} (${r.reason.slice(0, 40)})`,
		);
		ctx.ui.notify(
			[
				`pi-multi-account v${VERSION}: ${config.enabled ? "enabled" : "disabled"}${config.autoDiscover ? " · auto-discover ON" : " · auto-discover OFF"}`,
				`Current: ${current}`,
				`Current limits: ${
					currentUsage
						? formatUsageCompact(displayUsageSnapshot(currentUsage))
						: ctx.model && usageFamily(ctx.model.provider) === "qwen"
							? `${providerUsageLabel(ctx.model.provider)} | ${qwenLiveStatus(ctx.model.provider)}`
							: "not loaded"
				}`,
				`Rotation (${rotation.length}): ${rotation.join(" → ") || "none — log in to an account"}`,
				// Naming them is the point: they used to be dropped from rotation in silence, so
				// nothing inside the tool ever revealed that logged-in accounts were sitting idle.
				`Other providers (no quota tracking): ${unmanagedRotationMembers().join(", ") || (config.includeOtherProviders ? "none" : "disabled by includeOtherProviders")}`,
				`Needs models configured (in rotation but unusable): ${unconfiguredRotationMembers(ctx).join(", ") || "none"}`,
				`Duplicate slots skipped: ${duplicateSlots.length ? duplicateSlots.map(({ duplicate, primary }) => `${duplicate} = ${primary}`).join(", ") : "none"}`,
				`Registered login slots: ${[...registeredSlots].join(", ") || "(base accounts only)"}`,
				`Cooldowns: ${cooldowns.length ? cooldowns.join(", ") : "none"}`,
				`Next recovery: ${nextRecoveryStatus(ctx)}`,
				`Invalidated (need re-login): ${invalids.length ? invalids.join(", ") : "none"}`,
				`Pending auto-resume: ${hasPendingResume() ? `yes (reason: ${pendingResume?.reason ?? "unknown"})` : "none"}`,
				`Queued user messages: ${queuedUserInputs.length}`,
				`Resume watchdog: ${activeResumeWatch ? `watching${toolInFlight ? " · tool running" : ""}` : "idle"} · auto-recover ${config.autoRecoverStuck ? "ON" : "OFF"}`,
				`Compaction routing: ${config.routeCompactionToHealthyAccount ? "to healthy account" : "off"}${compactionRoutedNote ? ` (last: ${compactionRoutedNote})` : ""}${lastContextOverflowAt ? ` · last overflow ${formatUntil(lastContextOverflowAt)}` : ""}`,
				`Auto-continue breaker: ${isBreakerOpen() ? `OPEN — advisory mode until ${formatUntil(breakerOpenUntil)} (manual switching; /multi-account reset to re-enable)` : `closed${recoveryFailures ? ` (${recoveryFailures}/${BREAKER_FAILURE_THRESHOLD} recent failures)` : ""}`}`,
				// The one line that answers "is it spinning?" without reading a log. A session that
				// has stopped itself must be able to say so when asked, or the stop is just a
				// quieter version of the hang.
				`Governor: ${
					governorStopped()
						? `STOPPED — ${governorStoppedReason}. Send a message or run /multi-account reset to re-enable.`
						: `running · ${actionsSinceRequest}/${GOVERNOR_ACTIONS_WITHOUT_REQUEST} steps since a request reached a provider · ${actionsSinceSuccess}/${GOVERNOR_ACTIONS_WITHOUT_SUCCESS} since one answered`
				}`,
				`Debug log: ${config.debugLog ? `on → ${DEBUG_LOG_PATH} (/multi-account log to view)` : "off"}`,
				`Extension-free children: ${childView.length - childUnusable.length}/${childView.length} rotation slots usable${
					childUnusable.length
						? ` · cannot authenticate: ${childUnusable.map((verdict) => verdict.slotId).join(", ")}`
						: ""
				}${childRouteWarning ? `\n  ⚠️ ${childRouteWarning}` : ""}`,
				`Config: ${CONFIG_PATH}`,
				// Pi publishes three files and versions none of the formats, so a silent upgrade is
				// the failure mode. Stating the last look at them here is what makes it checkable.
				`Pi file contract: ${
					lastContractVerdicts.length === 0
						? "not checked yet"
						: lastContractVerdicts.every((verdict) => verdict.ok)
							? `${lastContractVerdicts.map((verdict) => verdict.file).join(", ")} as expected`
							: lastContractVerdicts
									.filter((verdict) => !verdict.ok)
									.map((verdict) => `${verdict.file}: ${verdict.problems.join("; ")}`)
									.join(" | ")
				}`,
				// The ladder decides a step people only notice when it surprises them — the hop taken
				// once a whole provider is spent. Stating it here is what makes it checkable before it
				// matters, rather than after.
				`Failover priority (after every account of the current provider is spent): ${
					config.providerPriority.length > 0
						? `${config.providerPriority.join(" → ")} → everything else`
						: "none set — decided by live availability alone"
				} · /multi-account priority to change`,
				// Switching accounts is the reason most people open this at all, so it gets its own
				// line with a real account name filled in. Buried mid-way through the pipe-separated
				// list below, `switch` was effectively undiscoverable and `next` pressed repeatedly
				// was the only way anyone found to reach a chosen account.
				`Switch accounts: /multi-account best — jump straight to an account that can work now · /multi-account switch <provider> — e.g. /multi-account switch ${rotation.find((p) => p !== ctx.model?.provider) ?? rotation[0] ?? "<provider>"} · /multi-account next steps through the rotation in order`,
				`Other commands: status | accounts [refresh] | best | priority [...] | limits [refresh] | models | log [N|on|off] | only-active [on|off] | rediscover | add [anthropic|codex|kimi|cursor|ollama|qwen] | remove [anthropic|codex|kimi|cursor|ollama|qwen|<provider-id>] | revive <provider|all> | clear | stop | reset | reload | enable | disable`,
			].join("\n"),
			"info",
		);
	}

	// A throw inside a command handler should surface as a friendly message, never crash Pi
	// or leave the user with a raw stack trace.
	const safeHandleCommand = async (args: string, ctx: any) => {
		try {
			return await handleCommand(args, ctx);
		} catch (error) {
			reportExtensionError(
				`/multi-account ${args.trim().split(/\s+/)[0] || "status"}`,
				error,
				ctx,
			);
			return undefined;
		}
	};
	for (const name of ["multi-account", "provider-failover", "failover"]) {
		pi.registerCommand(name, {
			description: "Manage automatic multi-account failover & rotation",
			handler: safeHandleCommand,
		});
	}

	// ----- Anthropic OAuth out of the box -----------------------------------
	// Enable Claude Pro/Max OAuth login on the base `anthropic` provider and shape
	// every Anthropic OAuth request so subscription tokens are accepted — without
	// requiring a separate pi-anthropic-auth install. Idempotent, so it coexists
	// safely if pi-anthropic-auth is also present.
	pi.registerProvider("anthropic", {
		baseUrl: "https://api.anthropic.com",
		oauth: anthropicOAuthOverride("anthropic", "Anthropic (Claude Pro/Max)"),
	} as any);
	pi.registerProvider("openai-codex", {
		oauth: codexOAuthOverride(
			"openai-codex",
			"ChatGPT Plus/Pro (Codex Subscription)",
		),
	} as any);

	// ----- API-key base providers (Ollama, Alibaba/Qwen) ---------------------
	// Pi registers providers from models.json, but if the apiKey field there is a
	// placeholder (e.g. "ollama") Pi may not expose the provider to modelRegistry,
	// which makes resolveTargets() return [] and the family never failovers. To
	// make the extension self-contained, register the base API-key provider here
	// whenever a real key exists in auth.json. Idempotent: if Pi already registered
	// it natively, registerProvider merges/overrides harmlessly.
	const ensureApiKeyBaseProvider = (
		family: "ollama" | "qwen",
		baseId: string,
	) => {
		const entry = readAuthFile()[baseId];
		const key =
			entry && typeof entry.key === "string" && entry.key.length > 0
				? entry.key
				: undefined;
		if (!key) return; // nothing to register — no real credential
		const baseUrl = family === "ollama" ? OLLAMA_CLOUD_BASE_URL : QWEN_BASE_URL;
		const preferred =
			family === "ollama" ? DEFAULT_OLLAMA_MODELS : DEFAULT_QWEN_MODELS;
		// Built-in tags lead, so the flagship this extension knows stays the representative and
		// nothing is downgraded — but everything the user configured is carried too, instead of
		// being replaced by this list.
		const ids = [...preferred];
		if (family === "ollama") {
			for (const discovered of discoveredOllamaModelIds) {
				if (!ids.includes(discovered)) ids.push(discovered);
			}
		}
		for (const configured of configuredModelIds(baseId)) {
			if (!ids.includes(configured)) ids.push(configured);
		}
		const models = ids.map((m) =>
			family === "ollama" ? ollamaModelDef(m, baseId) : qwenModelDef(m, baseId),
		);
		pi.registerProvider(baseId, {
			name: family === "ollama" ? "Ollama" : "Alibaba/Qwen",
			baseUrl,
			api: "openai-completions" as any,
			apiKey: key,
			models: models as any,
		} as any);
	};
	ensureApiKeyBaseProvider("ollama", OLLAMA_BASE);
	ensureApiKeyBaseProvider("qwen", config.qwenProvider);

	// Runs before every LLM request, on AgentMessage[] — the last point where a turn that
	// pi-ai is about to drop (stopReason error/aborted) is still intact. Rewriting it into a
	// `user` record is what lets the account we failed over TO see where the previous one
	// actually stopped, instead of being told "don't repeat completed work" with no record
	// of that work. See preserveInterruptedTurns() for the full rationale.
	safeOn("context", (event: any) => {
		if (!automaticFailoverEnabled() || !config.preserveInterruptedContext) return undefined;
		const messages = event?.messages;
		if (!Array.isArray(messages) || messages.length === 0) return undefined;
		const preserved = preserveInterruptedTurns(messages);
		if (preserved === messages) return undefined;
		const rescued = messages.length - preserved.length;
		logEvent("interrupted_context_preserved", {
			messages: messages.length,
			folded: rescued,
		});
		return { messages: preserved };
	});

	// ---- mid-run context guard --------------------------------------------
	// Pi measures the context in exactly two places: after a whole agent run has ended, and just
	// before a new user prompt. Inside a run — which is where an autonomous session spends almost
	// all of its time — nothing measures anything. Worse, a retryable provider error takes the
	// retry branch of _handlePostAgentRun() and returns BEFORE the compaction check, so the one
	// checkpoint that exists is routinely spent on a retry.
	//
	// Measured across 18 real sessions: one 78-minute agent run grew from 85 663 to 542 529 tokens
	// against a 272 000 window without a single check; across the corpus 30 % of all requests on
	// gpt-5.6-sol went out above 100 % of the advertised window.
	//
	// So the guard measures every outgoing request itself and, above the soft line, elides the
	// oldest tool results out of THAT REQUEST ONLY — the session transcript is never touched. Real
	// compaction is requested separately and only at a settled boundary, because ctx.compact()
	// begins with an abort() and mid-run would kill the agent's work.
	//
	// It deliberately does not trust the provider's reported prompt size: Cursor answers from its
	// own checkpointed conversation and openai-codex continues one server-side via WebSocket
	// deltas and `previous_response_id`, so both report their bookkeeping rather than the request
	// we built. See context-guard.ts for the accounting and the evidence behind each threshold.
	const contextGuardTrackers = new Map<string, OverheadTracker>();
	const contextGuardElided = new Set<string>();
	let contextGuardLastRaw = 0;
	let contextGuardTrimmedLastRequest = false;
	let contextGuardWantsCompaction = false;
	let contextGuardCompactionInFlight = false;
	let contextGuardCompactionRetryAfter = 0;
	let contextGuardLastCompactionAt = 0;
	// `ctx.compact()` is fire-and-forget. Keep this separate from the in-flight flag because the
	// host invokes onComplete only AFTER it emits session_compact; the callback is the first safe
	// idle boundary at which a guard-triggered summary can start the next turn.
	let contextGuardContinuationPending = false;
	let contextGuardNotifiedThisRun = false;
	// Health of the guard itself. Nothing here lives inside Pi — the guard hangs entirely off Pi's
	// extension hooks — so a host update cannot delete it, but it CAN quietly stop calling it. Every
	// handler is crash-isolated, which means a removed or renamed hook does not fail loudly: the
	// guard simply never runs again and the session goes back to overflowing with nobody watching.
	// Silent inertness is the failure mode worth reporting, so it is detected and said out loud.
	let contextGuardHookSeen = false;
	let contextGuardWindowSeen = false;
	let contextGuardLlmCalls = 0;
	const contextGuardWarned = new Set<string>();

	/** How many real LLM responses to wait for before concluding the guard is not being called. */
	const CONTEXT_GUARD_HEALTH_AFTER_CALLS = 5;

	function contextGuardWarn(ctx: any, kind: string, message: string) {
		if (contextGuardWarned.has(kind)) return;
		contextGuardWarned.add(kind);
		logEvent("context_guard_inert", { kind, message });
		try {
			ctx?.ui?.notify?.(`pi-multi-account: ${message}`, "warning");
		} catch {
			/* a health warning must never be the thing that breaks a turn */
		}
	}

	/** Minimum spacing between two guard-driven compactions, so a session cannot loop on them. */
	const CONTEXT_GUARD_COMPACTION_COOLDOWN_MS = 120_000;
	/** After a failed/cancelled compaction, do not retry the same still-large context immediately. */
	const CONTEXT_GUARD_COMPACTION_FAILURE_BACKOFF_MS = 120_000;
	/**
	 * Grace on top of the routing budget before an unanswered `ctx.compact()` is written off.
	 *
	 * Proportional rather than a flat half minute, so a session configured for a short compaction
	 * budget does not have to sit through a fixed 30 s of extra silence to get its guard back.
	 */
	const contextGuardCompactionWaitMs = () =>
		config.compactionWatchdogMs + Math.min(30_000, config.compactionWatchdogMs);

	function contextGuardTracker(ctx: any): OverheadTracker {
		const key = `${ctx?.model?.provider ?? "?"}/${ctx?.model?.id ?? "?"}`;
		let tracker = contextGuardTrackers.get(key);
		if (!tracker) {
			tracker = createOverheadTracker();
			contextGuardTrackers.set(key, tracker);
		}
		return tracker;
	}

	function contextGuardActive(): boolean {
		return automaticFailoverEnabled() && config.contextGuard.enabled;
	}

	safeOn("context", (event: any, ctx: any) => {
		if (!contextGuardActive()) return undefined;
		contextGuardHookSeen = true; // proof the host still calls us before each request
		if (typeof ctx?.compact !== "function")
			contextGuardWarn(
				ctx,
				"compact_missing",
				"this Pi build no longer exposes compaction to extensions, so the context guard can trim " +
					"requests but can never ask for a summary. Check for an extension update.",
			);
		const settings = config.contextGuard;
		const messages = event?.messages;
		if (!Array.isArray(messages) || messages.length === 0) return undefined;

		let systemPrompt = "";
		try {
			systemPrompt = ctx?.getSystemPrompt?.() ?? "";
		} catch {
			systemPrompt = ""; // a provider-less context still deserves a measurement
		}
		const raw = estimateRawTokens(messages as GuardMessage[], systemPrompt);
		const tracker = contextGuardTracker(ctx);
		const decision = decideGuard(
			tracker.adjust(raw),
			Number(ctx?.model?.contextWindow ?? 0),
			settings,
		);
		contextGuardLastRaw = raw;
		contextGuardTrimmedLastRequest = false;
		if (decision.window <= 0) return undefined; // unknown window ⇒ no basis to act
		contextGuardWindowSeen = true;
		if (decision.wantCompaction) {
			// Demand is level-triggered, but a failed compaction must not immediately
			// re-arm itself on the next settled event. The next context observation after
			// the bounded backoff may request it again.
			if (Date.now() >= contextGuardCompactionRetryAfter)
				contextGuardWantsCompaction = true;
		} else {
			// If the context has fallen back below the compaction line, an old demand is
			// no longer actionable and must not fire later after an unrelated event.
			contextGuardWantsCompaction = false;
		}
		// Below the soft line there is still work to do once anything has been elided: re-apply it,
		// or the request prefix flips back and forth and the prompt cache is thrown away each turn.
		if (!decision.trim && contextGuardElided.size === 0) return undefined;

		const plan = planElision(messages as GuardMessage[], contextGuardElided, {
			targetTokens: decision.trim ? decision.targetTokens : Number.POSITIVE_INFINITY,
			keepVerbatimTokens: settings.keepVerbatimTokens,
			minElideTokens: settings.minElideTokens,
		});
		if (!plan.changed) return undefined;
		contextGuardTrimmedLastRequest = true;
		if (plan.elidedNow > 0) {
			logEvent("context_guard_trimmed", {
				model: `${ctx?.model?.provider}/${ctx?.model?.id}`,
				window: decision.window,
				percentBefore: Math.round(decision.percent * 100),
				rawTokens: raw,
				overhead: tracker.overhead(),
				elidedNow: plan.elidedNow,
				elidedTotal: plan.elidedTotal,
				freedTokens: plan.freedTokens,
				tokensAfter: plan.tokensAfter,
			});
			if (!contextGuardNotifiedThisRun) {
				contextGuardNotifiedThisRun = true;
				try {
					ctx?.ui?.notify?.(
						`pi-multi-account: context reached ${Math.round(decision.percent * 100)}% of the ` +
							`${decision.window.toLocaleString("en-US")}-token window mid-run; older tool output is ` +
							`being left out of requests and a summary is queued. Nothing was removed from the transcript.`,
						"info",
					);
				} catch {
					/* a notification must never break the request */
				}
			}
		}
		return { messages: plan.messages };
	});

	// Learn how far the provider's real prompt count sits above our estimate — but only from a
	// request we left alone, and only when the number is plausible. An implausible one is the
	// provider reporting its own copy of the conversation, and learning from it would wedge the
	// guard's accounting for the rest of the session.
	safeOn("message_end", (event: any, ctx: any) => {
		if (!contextGuardActive()) return undefined;
		const usage = event?.message?.usage;
		if (usage) contextGuardLlmCalls++;
		if (contextGuardLlmCalls >= CONTEXT_GUARD_HEALTH_AFTER_CALLS) {
			if (!contextGuardHookSeen) {
				contextGuardWarn(
					ctx,
					"hook_missing",
					"the context guard is NOT running: this Pi build no longer calls the pre-request hook it " +
						"needs, so long autonomous runs are unprotected against context overflow again. Check for " +
						"an extension update.",
				);
			} else if (!contextGuardWindowSeen) {
				contextGuardWarn(
					ctx,
					"window_unknown",
					`the context guard is standing down on ${ctx?.model?.provider}/${ctx?.model?.id}: Pi does not ` +
						"know this model's context window, so there is nothing to measure against. Give the model a " +
						"contextWindow in models.json to switch the guard back on.",
				);
			}
		}
		if (contextGuardTrimmedLastRequest) return undefined;
		if (!usage || contextGuardLastRaw <= 0) return undefined;
		const reported =
			Number(usage.input ?? 0) + Number(usage.cacheRead ?? 0) + Number(usage.cacheWrite ?? 0);
		if (!(reported > 0)) return undefined;
		contextGuardTracker(ctx).observe(contextGuardLastRaw, reported);
		return undefined;
	});

	safeOn("agent_start", () => {
		contextGuardNotifiedThisRun = false;
		return undefined;
	});

	let contextGuardCompactionTimer: ReturnType<typeof setTimeout> | undefined;

	/** The compaction we asked for has reported back (either way): let the next one be asked for. */
	function settleContextGuardCompaction() {
		contextGuardCompactionInFlight = false;
		if (contextGuardCompactionTimer) {
			clearTimeout(contextGuardCompactionTimer);
			contextGuardCompactionTimer = undefined;
		}
	}

	/**
	 * Mark the current guard request as failed. This is intentionally separate from merely
	 * settling the in-flight flag: a failed request must clear its level-triggered demand and
	 * enter backoff, otherwise `agent_settled` starts the same compaction again immediately.
	 */
	function failContextGuardCompaction(
		kind: "context_guard_compaction_failed" | "context_guard_compaction_unanswered",
		error?: unknown,
	) {
		const hadDemand = contextGuardWantsCompaction || contextGuardCompactionInFlight;
		contextGuardWantsCompaction = false;
		contextGuardContinuationPending = false;
		if (hadDemand) {
			contextGuardCompactionRetryAfter =
				Date.now() + CONTEXT_GUARD_COMPACTION_FAILURE_BACKOFF_MS;
			settleContextGuardCompaction();
			logEvent(kind, {
				...(error === undefined ? {} : { error: String(error) }),
				backoffMs: CONTEXT_GUARD_COMPACTION_FAILURE_BACKOFF_MS,
			});
			return;
		}
		settleContextGuardCompaction();
	}

	/** Nothing reported back in time ⇒ assume it will not, and let the guard retry only after backoff. */
	function armContextGuardCompactionWatchdog() {
		if (contextGuardCompactionTimer) clearTimeout(contextGuardCompactionTimer);
		const waitedMs = contextGuardCompactionWaitMs();
		contextGuardCompactionTimer = setTimeout(() => {
			contextGuardCompactionTimer = undefined;
			if (!contextGuardCompactionInFlight) return;
			failContextGuardCompaction("context_guard_compaction_unanswered");
		}, waitedMs);
		contextGuardCompactionTimer.unref?.();
	}

	// The only safe place to run a real compaction: the agent has settled, nothing is streaming,
	// and no continuation is waiting to be dispatched (compact() aborts, and aborting a queued
	// continuation would strand the work the failover logic just rescued).
	safeOn("agent_settled", (_event: any, ctx: any) => {
		if (!contextGuardActive()) return undefined;
		if (!contextGuardWantsCompaction || contextGuardCompactionInFlight) return undefined;
		if (Date.now() < contextGuardCompactionRetryAfter) return undefined;
		if (Date.now() - contextGuardLastCompactionAt < CONTEXT_GUARD_COMPACTION_COOLDOWN_MS)
			return undefined;
		if (!ctx?.isIdle?.()) return undefined;
		if (ctx?.hasPendingMessages?.()) return undefined;
		if (hasPendingResume()) return undefined;
		// Asking for a summary is an action like any other. In a healthy session it produces a
		// provider request, which clears the governor's counter, so gating it costs nothing there
		// — and in a session where compaction is failing repeatedly, it is one of the mechanisms
		// that must be allowed to stop.
		if (!allowAction("ask for a summary", ctx)) return undefined;
		contextGuardCompactionInFlight = true;
		contextGuardContinuationPending = true;
		contextGuardLastCompactionAt = Date.now();
		logEvent("context_guard_compaction_requested", {
			model: `${ctx?.model?.provider}/${ctx?.model?.id}`,
			elided: contextGuardElided.size,
		});
		// `ctx.compact()` reports back through two callbacks, and this flag is the only thing
		// standing between the guard and a second compaction. So a host that answers with
		// NEITHER callback — a cancel that reports nowhere, a build that drops the handler — does
		// not merely lose one summary: the guard is switched off for the rest of the session
		// while the context keeps growing, which from the outside is a session that stops being
		// able to compact at all and then stops being able to do anything. Time-bound the wait.
		armContextGuardCompactionWatchdog();
		try {
			ctx.compact({
				onComplete: () => {
					settleContextGuardCompaction();
					dispatchContextGuardContinuation(ctx);
				},
				onError: (error: Error) => {
					// "Nothing to compact" is a normal answer, not a reason to retry on
					// every settled event. Clear the demand and back off until a fresh
					// context observation proves the context still needs a summary.
					failContextGuardCompaction(
						"context_guard_compaction_failed",
						String(error?.message ?? error),
					);
				},
			});
		} catch (error) {
			failContextGuardCompaction("context_guard_compaction_failed", error);
		}
		return undefined;
	});

	// A compaction happened (ours, Pi's, or the user's /compact): the message list is rebuilt, so
	// every elision key now points at history that is no longer in the request. Start clean.
	safeOn("session_compact", () => {
		contextGuardElided.clear();
		contextGuardWantsCompaction = false;
		contextGuardCompactionRetryAfter = 0;
		settleContextGuardCompaction();
		contextGuardLastRaw = 0;
		contextGuardTrimmedLastRequest = false;
		return undefined;
	});

	// ---- carry the task on after an automatic compaction --------------------
	// Pi stops the run whenever a threshold compaction fires, and the user has to type
	// "продовжуй" to get the work moving again. That is not a missing feature so much as an
	// unused one: `_runAutoCompaction` ends with
	//
	//     return this.agent.hasQueuedMessages();
	//
	// and `_runAgentPrompt` turns a `true` there into `await this.agent.continue()`, which drains
	// the follow-up queue and resumes the run. Pi relies on that path for overflow recovery but
	// never queues anything itself after a threshold compaction, so `hasQueuedMessages()` is
	// false and the run simply ends. Queueing one follow-up while the compaction is still in
	// flight is therefore not a workaround — it is the host's own documented continuation route
	// ("Auto-compaction can complete while follow-up/steering/custom messages are waiting").
	//
	// Measured across this machine's logs (59 compactions): 49 % were followed by the user
	// typing a short "продовжуй", and most of the remainder were the user pasting the summary
	// back in by hand or the failover's own continuation prompt. Only a handful were a genuinely
	// new task.
	//
	// `stopReason` does NOT separate "unfinished" from "finished" — after a clean `stop` the
	// split was 17 continues to 15 new tasks — and neither does any cheap textual signal (no
	// assistant message in the corpus even ends in a question mark). So instead of guessing from
	// the outside, the follow-up says plainly that finishing is an allowed answer: a genuinely
	// complete task is reported in one line rather than padded with invented work.
	const CONTINUE_AFTER_COMPACTION_TYPE = "multi-account:continue-after-compaction";
	const CONTINUE_AFTER_COMPACTION_PROMPT = [
		"The conversation history above was just compacted automatically: it is now a summary plus",
		"the most recent messages. Nothing was cancelled and nothing was asked of you — carry on with",
		"the task you were already working on, from the point where it stopped.",
		"",
		"- Do not restart the task, and do not redo work the summary records as already done.",
		"- If you need a result the summary does not carry, re-read the file or re-run the command",
		"  rather than assuming what it said.",
		"- If the task really is finished, do not invent more work: say so in one line and stop.",
	].join("\n");

	/**
	 * Resume a compaction requested by the context guard only after Pi's completion callback.
	 * Unlike threshold compaction, this path starts while Pi is already idle; queueing a follow-up
	 * during session_compact would merely append it to history and never run it. A user message
	 * after the callback both starts a real turn and keeps the normal continuation budget/marker.
	 */
	function dispatchContextGuardContinuation(ctx: any) {
		if (!contextGuardContinuationPending) return;
		contextGuardContinuationPending = false;
		if (!config.enabled || !config.continueAfterCompaction) {
			logEvent("compaction_continue_skipped", {
				reason: "post-compaction continuation disabled",
				compactionReason: "context_guard",
			});
			return;
		}
		if (userAbortedChain || ctx?.signal?.aborted) {
			logEvent("compaction_continue_skipped", {
				reason: "user aborted while context-guard compaction was running",
			});
			return;
		}
		if (ctx?.hasPendingMessages?.()) {
			logEvent("compaction_continue_skipped", {
				reason: "another message is already queued after context-guard compaction",
			});
			return;
		}
		if (ctx?.isIdle?.() === false) {
			logEvent("compaction_continue_skipped", {
				reason: "another turn already started after context-guard compaction",
			});
			return;
		}
		if (autoContinuesThisPrompt >= config.maxAutoContinuesPerPrompt) {
			logEvent("compaction_continue_skipped", {
				reason: "auto-continue budget spent",
				used: autoContinuesThisPrompt,
				budget: config.maxAutoContinuesPerPrompt,
			});
			return;
		}
		if (!allowAction("carry on after context-guard compaction", ctx)) return;
		expectingInjectedContinuation = true;
		try {
			pi.sendUserMessage(CONTINUE_AFTER_COMPACTION_PROMPT, {
				deliverAs: "followUp",
			});
			autoContinuesThisPrompt++;
			logEvent("compaction_continue", {
				compactionReason: "context_guard",
				model: `${ctx?.model?.provider}/${ctx?.model?.id}`,
				hop: autoContinuesThisPrompt,
				budget: config.maxAutoContinuesPerPrompt,
			});
		} catch (error) {
			expectingInjectedContinuation = false;
			logEvent("compaction_continue_failed", {
				error: String(error).slice(0, 200),
			});
		}
	}

	safeOn("session_compact", (event: any, ctx: any) => {
		if (!automaticFailoverEnabled() || !config.continueAfterCompaction) return undefined;
		// Only automatic compactions. A manual /compact (or the context guard's own request at a
		// settled boundary) is a deliberate pause, not an interruption to paper over.
		if (event?.reason !== "threshold" && event?.reason !== "overflow") return undefined;
		// Pi is already retrying this turn by itself; a second queued message would double up.
		if (event?.willRetry) return undefined;
		// The run loop must still be live: that is what makes `hasQueuedMessages()` be consulted
		// and the follow-up queue be drained. When the session is idle the same call would instead
		// append a stray message that nothing ever delivers.
		if (ctx?.isIdle?.() !== false) return undefined;
		// The user pressed Esc, or something is already queued and Pi will continue regardless.
		if (userAbortedChain || ctx?.signal?.aborted) return undefined;
		if (ctx?.hasPendingMessages?.()) return undefined;
		// Shares the failover budget on purpose: between them they must not be able to keep a
		// task alive forever without the user saying anything.
		if (autoContinuesThisPrompt >= config.maxAutoContinuesPerPrompt) {
			logEvent("compaction_continue_skipped", {
				reason: "auto-continue budget spent",
				used: autoContinuesThisPrompt,
				budget: config.maxAutoContinuesPerPrompt,
			});
			return undefined;
		}

		if (!allowAction("carry on after compaction", ctx)) return undefined;
		autoContinuesThisPrompt++;
		logEvent("compaction_continue", {
			compactionReason: event?.reason,
			model: `${ctx?.model?.provider}/${ctx?.model?.id}`,
			hop: autoContinuesThisPrompt,
			budget: config.maxAutoContinuesPerPrompt,
		});
		// Queued synchronously: `sendCustomMessage` reaches `agent.followUp()` before its first
		// await, so the queue is populated by the time `_runAutoCompaction` reads
		// `hasQueuedMessages()` a few lines later.
		pi.sendMessage(
			{
				customType: CONTINUE_AFTER_COMPACTION_TYPE,
				content: CONTINUE_AFTER_COMPACTION_PROMPT,
				// Visible on purpose: the agent carrying on by itself must be something the user
				// can see a reason for in the transcript, not something that just happens.
				display: true,
			} as any,
			{ deliverAs: "followUp" },
		);
		return undefined;
	});

	safeOn("before_provider_request", (event: any, ctx?: any) => {
		// A payload is being built, so a request is on its way out. This is the earliest and most
		// reliable place to say "the session is not spinning", and it is a hook this extension
		// already depends on — so the governor is watching something known to work on this host
		// rather than something it hopes exists.
		noteProviderRequestObserved();
		const shaped = shapeAnthropicOAuthPayload(event.payload);
		const payload = (shaped ?? event.payload) as
			| Record<string, unknown>
			| undefined;
		const provider = ctx?.model?.provider;
		if (payload && typeof provider === "string") {
			if (isCursorProviderId(provider)) {
				payload.pi_session_id = ctx?.sessionManager?.getSessionId?.();
			}
			// Qwen/Alibaba rejects the OpenAI-only `developer` role — normalize it to `system`.
			if (classifyProvider(provider, config.qwenProvider) === "qwen") {
				rewriteDeveloperRoleToSystem(payload);
			}
		}
		return shaped;
	});

	// ----- lifecycle hooks --------------------------------------------------

	let slotProxyServer: Server | undefined;
	let slotProxyPort: number | undefined;
	let slotProxyStarting: Promise<number | undefined> | undefined;
	/**
	 * Another live process already holds the canonical port.
	 *
	 * The port is the ownership token for the SHARED FILES published under it. Listening on an
	 * ephemeral port instead is harmless and stays process-local; rewriting models.json and
	 * auth.json is not. A short-lived process — a second session, or a `pi-subagents` child,
	 * which is just another process on this machine — that republished the fleet against itself
	 * would point the owner's children at a socket that dies with it, and would then restore
	 * credentials and unpublish routes that were never its own on its way out.
	 */
	let slotProxyForeignOwner = false;
	let slotProxyContext: any;
	const slotProxyRoutes = new Map<string, ProxyRoute>();
	/**
	 * Preferred port, so a route published last session usually still works. Holding it is what
	 * makes this process the publisher of the shared files. Overridable because a fixed port can
	 * collide with unrelated software, and because the suite needs a port it can own outright.
	 */
	const SLOT_PROXY_PORT =
		Number(process.env.PI_MULTI_ACCOUNT_SLOT_PROXY_PORT) || 41977;

	/**
	 * One process owns every child-facing file publication. With the normal proxy enabled, the
	 * canonical listening port is the ownership token. A pi-subagents child is never an owner,
	 * even if no parent happens to be listening when it starts.
	 */
	function ownsSharedChildPublication(): boolean {
		if (subagentChild) return false;
		if (!config.childProxy) return true;
		return !slotProxyForeignOwner && slotProxyPort === SLOT_PROXY_PORT;
	}

	refreshDiscovery(true);

	// Runtime capability preflight. The RECURRING class of breakage in this extension is the
	// pi↔extension BOUNDARY drifting: a host method the failover depends on gets renamed or removed
	// (e.g. pi.continueAgent() vanished in @earendil-works/pi-coding-agent 0.80.3), and the failure
	// only surfaces weeks later as a cryptic error the instant a real limit hits. Unit tests can
	// never catch this — they mock `pi` and always implement every method. So we probe the REAL host
	// object at every session start: record which capabilities are present (dated, in the debug log
	// for instant diagnosis) and, ONCE per process, tell the user in plain terms if switching is
	// impossible or resume is degraded — instead of letting them discover it under fire.
	// ----- parent-owned slot proxy ------------------------------------------
	//
	// Everything spawned without this extension loaded reads settings.json to find the active
	// account. A numbered OAuth slot resolves by name for such a child and then fails at auth,
	// because Pi honours an OAuth credential only for a provider definition declaring the flow —
	// so the child silently reroutes to whichever provider Pi finds first. The Cursor slots
	// already solve this by publishing a loopback route the parent serves with a non-secret
	// placeholder; this extends the same pattern to the Anthropic and Codex families. Decisions
	// live in slot-proxy.ts; what is here is the socket and the credential lookup.

	function proxyFamilyOf(slotId: string): ProxyFamily | undefined {
		return proxyFamilyFor(slotId);
	}

	function numberedSlotBaseUrl(id: string, family: ProxyFamily): string {
		if (typeof slotProxyPort === "number") return publishedRouteFor(slotProxyPort, id);
		return family === "anthropic"
			? "https://api.anthropic.com"
			: "https://chatgpt.com/backend-api";
	}

	function restoreChildFacingAuth(): void {
		const restored = applyRestoreAll(readAuthFileRaw(), readProxyOAuthSidecar());
		if (restored.changed) persistChildFacingAuth(restored.auth, restored.sidecar);
	}

	function shadowChildFacingAuth(slotIds: readonly string[]): void {
		const shadowed = applyShadowAll(slotIds, readAuthFileRaw(), readProxyOAuthSidecar());
		if (shadowed.changed) persistChildFacingAuth(shadowed.auth, shadowed.sidecar);
	}

	/** The credential to send upstream, refreshed first when the stored one has expired. */
	async function credentialForProxy(slotId: string): Promise<AuthEntry | undefined> {
		let entry = readAuthFile()[slotId];
		if (!entry) return undefined;
		if (entry.type !== "oauth" || typeof entry.access !== "string") return entry;
		const expiry = jwtExpMs(entry.access);
		// A minute of slack: a token that expires mid-flight fails the child's whole request, and
		// refreshing one turn early costs nothing.
		if (expiry !== undefined && expiry - 60_000 <= Date.now()) {
			try {
				await forceRefreshProvider(slotProxyContext, slotId);
				entry = readAuthFile()[slotId] ?? entry;
			} catch (error) {
				logEvent("slot_proxy_refresh_failed", {
					slot: slotId,
					reason: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return entry;
	}

	async function readRequestBody(req: any): Promise<Buffer> {
		const chunks: Buffer[] = [];
		for await (const chunk of req) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}
		return Buffer.concat(chunks);
	}

	async function handleProxyRequest(req: any, res: any): Promise<void> {
		// Pi's Codex API tries a WebSocket first and falls back to SSE when it cannot connect
		// (measured: one GET, then POSTs, on a real bare child). Refusing the upgrade here makes
		// that fallback immediate instead of spending an upstream round trip on a request that
		// could never have been a WebSocket.
		if (typeof req.headers?.upgrade === "string") {
			logEvent("slot_proxy_upgrade_refused", { upgrade: req.headers.upgrade });
			res.writeHead(501, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "this route serves HTTP only" } }));
			return;
		}
		const parsed = parseProxyPath(req.url ?? "");
		const presentedSecret =
			parsed && typeof readAuthFile()[parsed.slotId]?.access === "string"
				? readAuthFile()[parsed.slotId]?.access
				: undefined;
		const verdict = admitRequest({
			rawUrl: req.url ?? "",
			headers: req.headers ?? {},
			routes: slotProxyRoutes,
			acceptedSecrets: presentedSecret ? [presentedSecret] : [],
		});
		if (!verdict.ok) {
			logEvent("slot_proxy_refused", { status: verdict.status, reason: verdict.message });
			res.writeHead(verdict.status, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: verdict.message } }));
			return;
		}
		const credential = await credentialForProxy(verdict.route.slotId);
		const shaped = shapeUpstreamRequest({
			route: verdict.route,
			rest: verdict.rest ?? "/",
			headers: req.headers ?? {},
			credential,
		});
		if (!shaped.ok) {
			logEvent("slot_proxy_no_credential", {
				slot: verdict.route.slotId,
				status: shaped.status,
			});
			res.writeHead(shaped.status, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: shaped.message } }));
			return;
		}

		let body: Buffer | undefined =
			req.method === "GET" || req.method === "HEAD" ? undefined : await readRequestBody(req);
		if (body && verdict.route.family === "anthropic" && credential?.type === "oauth") {
			// The same shaping the in-process path applies: without it Anthropic rejects a
			// subscription token outright. Done here because the child cannot do it — it has no
			// idea it is talking to a proxy.
			try {
				const parsed = JSON.parse(body.toString("utf8"));
				const reshaped = shapeAnthropicOAuthPayload(parsed);
				if (reshaped && reshaped !== parsed) body = Buffer.from(JSON.stringify(reshaped));
			} catch {
				// Not JSON, or not a messages payload — forward exactly as received.
			}
		}

		try {
			const upstream = await fetch(shaped.url, {
				method: req.method ?? "POST",
				headers: shaped.headers,
				body: body && body.length ? new Uint8Array(body) : undefined,
			});
			const outgoing: Record<string, string> = {};
			upstream.headers.forEach((value, name) => {
				// Length and encoding are recomputed for the connection we are answering on.
				if (name === "content-length" || name === "content-encoding") return;
				outgoing[name] = value;
			});
			res.writeHead(upstream.status, outgoing);
			if (upstream.body) {
				await new Promise<void>((resolve) => {
					const stream = Readable.fromWeb(upstream.body as any);
					stream.on("error", () => resolve());
					res.on("close", () => resolve());
					stream.pipe(res);
					res.on("finish", () => resolve());
				});
			} else {
				res.end();
			}
			logEvent("slot_proxy_forwarded", {
				slot: verdict.route.slotId,
				status: upstream.status,
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			logEvent("slot_proxy_upstream_failed", { slot: verdict.route.slotId, reason });
			if (!res.headersSent) {
				res.writeHead(502, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: `upstream request failed: ${reason}` } }));
			} else {
				res.end();
			}
		}
	}

	/** Start the loopback listener once, preferring a stable port so published routes survive. */
	function startSlotProxy(): Promise<number | undefined> {
		if (slotProxyPort !== undefined) return Promise.resolve(slotProxyPort);
		if (slotProxyStarting) return slotProxyStarting;
		slotProxyStarting = new Promise<number | undefined>((resolve) => {
			let retriedOnEphemeralPort = false;
			const server = createServer((req, res) => {
				handleProxyRequest(req, res).catch((error) => {
					logEvent("slot_proxy_handler_failed", {
						reason: error instanceof Error ? error.message : String(error),
					});
					try {
						if (!res.headersSent) res.writeHead(500);
						res.end();
					} catch {
						/* the socket is already gone */
					}
				});
			});
			// A WebSocket handshake that got past the request handler is closed at the socket, so
			// nothing is left half-open waiting for an upgrade this proxy will never perform.
			server.on("upgrade", (_req: any, socket: any) => {
				try {
					socket.destroy();
				} catch {
					/* already gone */
				}
			});
			// A dead listener must never take Pi down with it — the same rule the Cursor bridge
			// learned the hard way.
			server.on("error", (error: NodeJS.ErrnoException) => {
				if (
					error.code === "EADDRINUSE" &&
					server.listening === false &&
					!slotProxyPort &&
					!retriedOnEphemeralPort
				) {
					// Another live process owns this port, and with it every route published
					// against it. We still take an ephemeral port — serving our own in-process
					// callers costs nothing — but we are no longer the publisher: the shared
					// files stay exactly as the owner left them. See slotProxyForeignOwner.
					//
					// Do not re-enter listen() from the error callback. With an independent
					// process holding the port, Pi's compiled Bun runtime can leave the server
					// in its failed-listen transition until the next event-loop turn, so the retry never
					// reaches the original callback and session_start remains pending forever.
					retriedOnEphemeralPort = true;
					slotProxyForeignOwner = true;
					logEvent("slot_proxy_foreign_owner", { port: SLOT_PROXY_PORT });
					setImmediate(() => {
						try {
							server.listen(0, "127.0.0.1");
						} catch (retryError) {
							logEvent("slot_proxy_listen_failed", {
								reason: retryError instanceof Error ? retryError.message : String(retryError),
							});
							resolve(undefined);
						}
					});
					return;
				}
				logEvent("slot_proxy_listen_failed", { reason: error.message });
				resolve(undefined);
			});
			// Register independently of either listen() attempt. A callback passed only to the
			// canonical listen can be lost when that attempt emits EADDRINUSE before the server
			// retries on an ephemeral port.
			server.once("listening", () => {
				const address = server.address();
				slotProxyPort = typeof address === "object" && address ? address.port : undefined;
				slotProxyServer = server;
				server.unref(); // never hold Pi open on our account
				logEvent("slot_proxy_listening", { port: slotProxyPort });
				resolve(slotProxyPort);
			});
			server.listen(SLOT_PROXY_PORT, "127.0.0.1");
		}).finally(() => {
			slotProxyStarting = undefined;
		});
		return slotProxyStarting;
	}

	function stopSlotProxy() {
		// Capture authority before clearing the port that proves it.
		const publishedSharedFiles = ownsSharedChildPublication();
		try {
			slotProxyServer?.close();
		} catch {
			/* closing a server that never opened is not a problem */
		}
		slotProxyServer = undefined;
		slotProxyPort = undefined;
		slotProxyRoutes.clear();
		if (!publishedSharedFiles) return; // the owner's state outlives this process
		restoreChildFacingAuth();
		unprovisionOwnLoopbacks();
	}

	/**
	 * Publish every proxied OAuth account against the running proxy, so a child resolves the
	 * account AND can authenticate to it. Without the second half the first is a trap.
	 */
	async function publishProxiedSlots(ctx: any): Promise<void> {
		if (!config.childProxy) return;
		slotProxyContext = ctx ?? slotProxyContext;
		const parent = readAuthFile();
		const slots = [
			...new Set([
				...registeredSlots,
				...Object.keys(parent).filter((id) => proxyFamilyOf(id) !== undefined),
			]),
		].filter((id) => proxyFamilyOf(id) !== undefined && isEntryUsable(parent[id]));
		if (slots.length === 0) {
			if (ownsSharedChildPublication()) {
				restoreChildFacingAuth();
				unprovisionOwnLoopbacks();
			}
			return;
		}
		const port = await startSlotProxy();
		if (port === undefined) {
			if (ownsSharedChildPublication()) {
				restoreChildFacingAuth();
				unprovisionOwnLoopbacks();
			}
			return;
		}
		// Every process needs local routes for the providers it registered against its own socket.
		// Only the canonical interactive owner may advertise those routes through shared files.
		for (const id of slots) {
			const family = proxyFamilyOf(id);
			if (family) slotProxyRoutes.set(id, { slotId: id, family });
		}
		if (!ownsSharedChildPublication()) {
			logEvent("slot_proxy_local_routes_ready", { port, slots });
			return;
		}
		shadowChildFacingAuth(slots);
		for (const id of slots) {
			const family = proxyFamilyOf(id);
			if (!family) continue;
			const baseUrl = publishedRouteFor(port, id);
			if (family === "anthropic") {
				provisionNativeSlot(id, {
					api: "anthropic-messages",
					baseUrl,
					apiKey: placeholderKeyFor(family),
					models: DEFAULT_ANTHROPIC_MODELS.map((modelId) => ({
						...anthropicModelDef(modelId, id),
						baseUrl,
					})),
				});
			} else {
				const cached = codexModelCatalogByProvider.get(id)?.models as
					| Array<Record<string, unknown>>
					| undefined;
				const models = (cached?.length ? cached : DEFAULT_CODEX_MODELS.map(codexModelDef)) as Array<
					Record<string, unknown>
				>;
				// Published as Codex's own API on purpose: Pi then shapes the body the way that
				// backend requires (`store: false`, the instructions field, its own headers), which
				// a generic `openai-responses` slot would not. The cost is that Pi insists on
				// reading an account id out of the key, which is why that family's placeholder is
				// JWT-shaped.
				provisionNativeSlot(id, {
					api: "openai-codex-responses",
					baseUrl,
					apiKey: placeholderKeyFor(family),
					models,
				});
			}
		}
		logEvent("slot_proxy_published", { port, slots });
	}

	function preflightHostCapabilities(ctx: any) {
		const has = (name: string) =>
			typeof (pi as unknown as Record<string, unknown>)[name] === "function";
		const caps = {
			setModel: has("setModel"), // switch accounts at all
			registerProvider: has("registerProvider"), // register extra account slots
			sendUserMessage: has("sendUserMessage"), // fallback resume (inject prompt)
			continueAgent: has("continueAgent"), // seamless in-place resume
			on: has("on"),
			registerCommand: has("registerCommand"),
		};
		const canSwitch = caps.setModel;
		const canResume = caps.continueAgent || caps.sendUserMessage;
		const seamlessResume = caps.continueAgent;
		logEvent("host_capabilities", {
			version: VERSION,
			...caps,
			canSwitch,
			canResume,
			seamlessResume,
			...(oauthUnavailable ? { oauthUnavailable } : {}),
		});
		// One notice per process — informative, never nagging on every session.
		if (!preflightNotified) {
			preflightNotified = true;
			if (oauthUnavailable) {
				// The extension is alive (api-key accounts keep rotating) but no
				// subscription account can log in or refresh — say so plainly instead of
				// letting the user hit it mid-failover.
				ctx.ui?.notify?.(
					`pi-multi-account v${VERSION}: subscription (OAuth) logins are unavailable — ${oauthUnavailable}`,
					"warning",
				);
			}
			if (!canSwitch) {
				ctx.ui?.notify?.(
					`pi-multi-account v${VERSION}: this Pi build does not expose pi.setModel() — automatic account switching is IMPOSSIBLE on this host, so failover cannot work until it is restored. Check your @earendil-works/pi-coding-agent version.`,
					"error",
				);
			} else if (!canResume) {
				ctx.ui?.notify?.(
					`pi-multi-account v${VERSION}: this Pi build exposes neither pi.continueAgent() nor pi.sendUserMessage() — after a switch the task cannot auto-continue; you will have to re-send your prompt on the new account.`,
					"warning",
				);
			} else if (!seamlessResume) {
				ctx.ui?.notify?.(
					`pi-multi-account v${VERSION}: seamless in-place resume (pi.continueAgent) is not available on this Pi build — failover WILL still switch accounts and auto-continue by re-injecting your task as a fresh turn. This is the expected fallback, not an error.`,
					"info",
				);
			}
		}
		return { canSwitch, canResume, seamlessResume };
	}

	safeOn("session_start", async (_event, ctx) => {
		lastObservedModelKey = thinkingModelKey(ctx);
		lastObservedThinkingLevel = readThinkingLevel();
		pendingModelThinkingChange = undefined;
		modelCatalogContext = ctx;
		if (!explicitCliThinkingLevel) {
			const resolved = await resolveExplicitCliModelThinkingLevel(
				explicitCliArgs,
				ctx,
			);
			if (resolved) {
				explicitCli.thinking = true;
				explicitCliThinkingLevel = resolved;
				desiredThinkingLevel = resolved;
			}
		}
		if (!subagentChild) preflightHostCapabilities(ctx);
		// Looked at BEFORE discovery touches anything, so what is judged is the files as Pi
		// published them rather than the version our own slot provisioning has just rewritten.
		checkPiContract(ctx, "session_start");
		slotProxyContext = ctx;
		// Bind the loopback before discovery so numbered slots register against this process,
		// not the real upstream, while a child-facing placeholder is in auth.json.
		if (config.childProxy) await startSlotProxy();
		refreshDiscovery(true, ctx);
		// Publish the OAuth slots against a route this process serves, so anything spawned
		// without this extension can actually run on the account the rotation chose.
		await publishProxiedSlots(ctx);
		publishOwnedNativeAliases(ctx);
		// Not installed → silent skip (refreshCursorSlots warns only on the explicit path).
		if (config.includeCursor) await refreshCursorSlots(readAuthFile(), ctx);
		applyOnlyActiveFilter(ctx);
		installControllerProvider(ctx);
		pruneCooldowns();
		// Tight session binding: every session starts as a clean slate. Auto-resume only ever
		// runs *inside the live session that hit the limit* (its timer is armed by
		// setPendingContinuation). A new session — or a reopened one after a crash — must NEVER
		// inherit and silently restart a previous session's paused work, so we drop any leftover
		// pending state and reset all in-memory guards here. A delegated child shares
		// the state file with its parent process and must not erase the parent's wake.
		if (
			!subagentChild &&
			((persistedState.pendingFrom && persistedState.pendingReason) ||
				persistedState.pendingContinuationPrompt)
		)
			clearPendingContinuation({ allowLegacy: true });
		autoContinuesThisPrompt = 0;
		resetGovernor();
		startFreshFailoverChain();
		userAbortedChain = false;
		watchdogAborting = false;
		expectingInjectedContinuation = false;
		recoveryFailures = 0;
		breakerOpenUntil = 0;
		responseCooldownHints.clear();
		handledAssistantErrors.clear();
		clearQueuedInputs();
		logEvent("session_start", {
			session: sessionInstanceId,
			version: VERSION,
			enabled: automaticFailoverEnabled(),
			mode: subagentChild ? "subagent-child-passive" : "interactive",
			rotation: rotation.length,
		});
		ctx.ui.notify(
			subagentChild
				? `pi-multi-account v${VERSION} loaded in passive pi-subagents child mode. Model routing remains owned by the parent runner.`
				: `pi-multi-account v${VERSION} loaded (${config.enabled ? "enabled" : "disabled"}). ${rotation.length} account(s) in rotation. Config: ${CONFIG_PATH}`,
			"info",
		);
		if (duplicateSlots.length > 0) {
			ctx.ui.notify(
				`pi-multi-account: duplicate account slot(s) skipped: ${duplicateSlots.map(({ duplicate, primary }) => `${duplicate} duplicates ${primary}`).join(", ")}. Log the duplicate slot into a different account.`,
				"warning",
			);
		}
		// Refresh every account BEFORE deciding the selected model is unavailable. Otherwise a
		// plan upgrade can revive the current account milliseconds after startup preflight has
		// already switched away from it using the old plan's stale 100% snapshot. The delegated
		// runner owns fallback selection in a child, so multiplying that fleet-wide probe across
		// every parallel child buys nothing.
		if (!subagentChild) await refreshRotationUsage(ctx);
		await syncCodexModelCatalog(ctx);
		await syncOllamaModelCatalog(ctx);
		// Pi restores the session model BEFORE extension catalogs finish registering
		// unless the factory returned the Cursor setup promise. Re-apply anyway: a
		// cold catalog, a compaction inner session, or a git-reset leftover can still
		// leave getModel(cursor, grok-4.6) empty.
		if (cursorReady) await cursorReady.catch(() => undefined);
		// Cursor slot catalogs changed too — same stale-hidden-copy repair as the model syncs.
		applyOnlyActiveFilter(ctx);
		emitModelCatalogSnapshot(ctx);
		if (!subagentChild) {
			await restoreRememberedModel(ctx);
			await ensureReadyModel(
				ctx,
				"startup preflight: selected account unavailable",
			);
		}
		startUsageStatusTimer(ctx);
	});

	// CRITICAL: when the current session ends — for ANY reason (quit, reload, or replacement
	// by a new/resumed/forked session) — the extension's background activity must end with it.
	// Kill every timer and drop the pending continuation so nothing survives the session.
	safeOn("session_shutdown", async (_event, ctx) => {
		modelCatalogContext = undefined;
		rememberUserModel(ctx?.model);
		if (pendingWakeTimer) {
			clearTimeout(pendingWakeTimer);
			pendingWakeTimer = undefined;
		}
		clearQueuedInputs();
		if (!subagentChild) clearPendingContinuation();
		clearUsageStatusTimer();
		contextGuardWantsCompaction = false;
		contextGuardCompactionRetryAfter = 0;
		settleContextGuardCompaction();
		endResumeWatch();
		// The published routes point at this process; nothing must be left listening after it.
		stopSlotProxy();
		watchdogAborting = false;
		expectingInjectedContinuation = false;
		userAbortedChain = false;
		autoContinuesThisPrompt = 0;
		manualPinnedProvider = undefined;
		failoverPinnedProvider = undefined;
		responseCooldownHints.clear();
		handledAssistantErrors.clear();
		ctx?.ui?.setStatus?.("multi-account-quota", undefined);
	});

	// Make compaction survive account exhaustion. When the active account is rate-limited /
	// invalidated and Pi needs to summarize (context overflow or threshold), Pi's default would
	// run the summary on that dead account and hang ("Compacting context…" forever). We generate
	// the summary on a healthy account instead. If that cannot finish, we CANCEL — never return
	// undefined onto a spent account, because Pi's default has no timeout of its own.
	safeOn("session_before_compact", async (event: any, ctx: any) => {
		if (!automaticFailoverEnabled()) return undefined;
		if (event?.reason === "overflow") lastContextOverflowAt = Date.now();
		const result = await runHealthyCompaction(event, ctx);
		if (result !== undefined) return result;
		// The host runs its own default compaction on the ACTIVE account with no timeout.
		// Only intercept when we are genuinely holding a cancellation message;
		// otherwise leave the host alone (and its queue alone).
		//
		// "Holding a message" is only a reason to wait if the message is about to go out. When
		// every account is hours away the queue cannot flush, and cancelling compaction to protect
		// it is a deadlock with no exit: the context never shrinks, so every request overflows, so
		// compaction fires again, and the held message is no closer to being sent. Let the
		// compaction through in that case — a smaller context is what the queued message will need
		// when an account finally frees up.
		if (queuedUserInputs.length > 0) {
			const flushDelay = nextModelAvailabilityDelayMs(ctx);
			if (flushDelay !== undefined && flushDelay <= QUEUE_FLUSH_SOON_MS) {
				return { cancel: true, reason: "compaction cancelled: failover queue must flush" };
			}
			logEvent("compaction_allowed_over_queue", {
				queued: queuedUserInputs.length,
				flushDelayMs: flushDelay ?? null,
			});
		}
		// runHealthyCompaction returns undefined only when routing is off or the current
		// account is healthy. If the current account is still spent, do not let Pi default
		// compact on it — that is the hang.
		if (
			config.routeCompactionToHealthyAccount &&
			!isCurrentModelReady(ctx)
		) {
			return {
				cancel: true,
				reason: "active account unavailable for compaction",
			};
		}
		return undefined;
	});

	// Pi cancelled compaction (or it failed). If we had queued user input for the cooldown,
	// those messages would sit forever — flush them now so the queue is not the dead end.
	safeOn("compaction_end", (event: any, ctx: any) => {
		// `session_compact` only fires when a compaction actually LANDED. On a
		// cancelled/failed compaction, clear any guard demand and back off before
		// another settled boundary can request the same failed operation.
		if (event?.result) {
			contextGuardWantsCompaction = false;
			contextGuardCompactionRetryAfter = 0;
			settleContextGuardCompaction();
		} else if (contextGuardWantsCompaction || contextGuardCompactionInFlight) {
			failContextGuardCompaction(
				"context_guard_compaction_failed",
				event?.errorMessage ?? (event?.aborted ? "Compaction cancelled" : undefined),
			);
		}
		if (queuedUserInputs.length === 0) return;
		if (!ctx.isIdle()) return;
		runBackground("post-compaction queued flush", ctx, () =>
			attemptQueuedInputResume(ctx),
		);
	});

	// Forward-progress signals: any of these means the resumed turn is alive, so reset the
	// stuck watchdog. Cheap no-ops when no resume is in flight.
	for (const evt of [
		"turn_start",
		"message_start",
		"message_update",
		"tool_execution_update",
	] as const) {
		safeOn(evt, () => {
			noteResumeProgress();
		});
	}
	// Async re-registrations (Cursor/Codex catalog discovery) restore full model lists
	// behind the filter's back; re-narrow at the start of every turn.
	safeOn("message_start", (_event, ctx) => applyOnlyActiveFilter(ctx));
	// Tool lifecycle also adjusts the in-flight count so a long, silent build/test command is
	// never mistaken for a wedge and aborted mid-run.
	safeOn("tool_execution_start", () => {
		toolInFlight++;
		noteResumeProgress();
	});
	safeOn("tool_execution_end", () => {
		toolInFlight = Math.max(0, toolInFlight - 1);
		noteResumeProgress();
	});

	safeOn("input", async (event, ctx) => {
		if (
			!automaticFailoverEnabled() ||
			(event as any).source === "extension"
		)
			return { action: "continue" as const };
		const text =
			typeof (event as any).text === "string" ? (event as any).text : "";
		// Slash commands and shell shortcuts belong to Pi itself. Holding them in the cooldown queue
		// makes /login, /model, /export, and even recovery commands appear completely broken.
		if (/^\s*[/!]/.test(text)) return { action: "continue" as const };
		claimUserControl("interactive input");
		noteRecoveryProgress(); // a fresh user prompt → clean slate, re-enable auto-continue
		// A manual choice is owed ONE message. This is the next one, so a reprieve that already
		// carried a message retires here — before the readiness check consults it.
		retireSpentManualPin();
		retireSpentFailoverPin();

		// A prompt can arrive while a broker wake or another automatic continuation is starting.
		// The host's ordinary `prompt()` path has no streamingBehavior in that race and would throw
		// "Agent is already processing" (or abort the active turn). Re-enter through the explicit
		// follow-up queue so the user's newer intent is serialized rather than competing with it.
		if (!ctx.isIdle()) {
			if ((event as any).streamingBehavior === "steer" || (event as any).streamingBehavior === "followUp") {
				return { action: "continue" as const };
			}
			if (typeof pi.sendUserMessage === "function") {
				await pi.sendUserMessage(queuedInputContent({ text, images: (event as any).images }), {
					deliverAs: "followUp",
				});
				return { action: "handled" as const };
			}
			return { action: "continue" as const };
		}

		if (
			await ensureReadyModel(ctx, "preflight: selected account unavailable")
		) {
			// Readiness preflight awaits auth/catalog work. The session may have become busy while it
			// was awaiting; re-check before allowing the original prompt to enter the host run.
			if (!ctx.isIdle()) {
				if (typeof pi.sendUserMessage === "function") {
					await pi.sendUserMessage(queuedInputContent({ text, images: (event as any).images }), {
						deliverAs: "followUp",
					});
					return { action: "handled" as const };
				}
			}
			return { action: "continue" as const };
		}

		const delay = nextModelAvailabilityDelayMs(ctx);
		if (delay !== undefined) {
			// Never remove a fresh user message from Pi's transcript and hide it in extension-owned
			// memory. Let the real request record its refusal; the normal failed-turn preservation +
			// pending resume path can then carry the visible message when an account becomes ready.
			logEvent("input_passthrough_while_cooling", {
				session: sessionInstanceId,
				delayMs: delay,
				provider: ctx.model?.provider,
				model: ctx.model?.id,
			});
			ctx.ui.notify(
				`pi-multi-account: no account is ready right now. Your message stays in Pi's transcript; if this request is refused, it will resume automatically when a compatible account recovers (next check in ~${formatDelay(delay)}).`,
				"warning",
			);
			return { action: "continue" as const };
		}

		const providers = [
			...new Set(
				activeFallbacks()
					.map((target) => parseTarget(target)?.provider)
					.filter(Boolean),
			),
		];
		const slotHint =
			providers.length > 0 ? ` Select one of: ${providers.join(", ")}.` : "";
		// Selection came up empty — but WHY it came up empty is the whole message. Reporting
		// "no authenticated account exists" for every empty result told people with several
		// logged-in accounts, quota still showing on them, that they had none. That reads as the
		// extension failing to see accounts it can plainly list in `status`, and it buries the one
		// action that fixes it. Say which accounts exist and what is actually wrong with them.
		// Invalidated accounts are dropped from `rotation` by design, so the rotation list is the
		// one place that cannot name them — read the accounts themselves.
		const auth = readAuthFile();
		const deadAuth = [...invalidatedByProvider.keys()].filter((provider) =>
			isEntryUsable(auth[provider]),
		);
		const unconfigured = unconfiguredRotationMembers(ctx);
		if (deadAuth.length > 0 || unconfigured.length > 0) {
			const parts: string[] = [];
			if (deadAuth.length > 0)
				parts.push(
					`${deadAuth.join(", ")} — authorization expired, so re-login is the only fix: run /login, choose "Use a subscription", then select each of them`,
				);
			if (unconfigured.length > 0)
				parts.push(
					`${unconfigured.join(", ")} — logged in, but Pi knows no model for them, so they cannot be selected`,
				);
			ctx.ui.notify(
				`Provider failover: every account is currently unusable. ${parts.join(". ")}.`,
				"error",
			);
			return { action: "continue" as const };
		}
		ctx.ui.notify(
			`Provider failover: no usable authenticated account exists. Run /login, choose "Use a subscription", then select an account slot.${slotHint}`,
			"error",
		);
		return { action: "continue" as const };
	});

	// Distinguish a genuine new user prompt from our own failover continuation. Only a
	// genuine prompt resets the per-task auto-continue counter and cancels any pending
	// resurrection — this is what stops maxAutoContinuesPerPrompt from resetting every
	// iteration (the bug that let the failover loop run forever).
	safeOn("before_agent_start", async (_event, ctx) => {
		// The child shares the persisted recovery file with its parent. It must not only avoid
		// switching models here; it must avoid clearing the parent's pending wake when its own
		// explicitly selected turn starts.
		if (subagentChild) return;
		// Our own injected continuation (recovery fallback) must NOT be mistaken for a genuine
		// new user prompt — otherwise it resets the auto-continue counter every iteration and the
		// recovery loop becomes unbounded. Preserve the chain in that case.
		if (expectingInjectedContinuation) {
			expectingInjectedContinuation = false;
			continuationDispatchedForAgentTurn = true; // this turn IS the continuation
			await ensureReadyModel(
				ctx,
				"last-moment preflight: selected account unavailable",
			);
			return;
		}
		// Genuine user input → fresh task: reset the chain and stop any auto-resume.
		claimUserControl("before agent start");
		await ensureReadyModel(
			ctx,
			"last-moment preflight: selected account unavailable",
		);
	});

	safeOn("agent_start", async (_event, ctx) => {
		noteResumeProgress(); // a resumed turn actually started → it is making progress
		currentPromptSwitch = undefined;
		automaticModelTarget = undefined;
		responseCooldownHints.clear();
		handledAssistantErrors.clear();
		captureDesiredThinking(ctx); // remember the level BEFORE any failover can clamp it
		refreshDiscovery(false, ctx); // also refresh Pi's in-memory AuthStorage
		if (pendingSettingsCheck) {
			// A switch happened; Pi should have rewritten settings.json to name it. If it did not,
			// every extension-free child spawned from here on runs on the wrong account, and this
			// is the last place that is still explainable.
			pendingSettingsCheck = false;
			checkPiContract(ctx, "after_model_switch", true);
		}
		if (!usageStatusTimer) startUsageStatusTimer(ctx);
		updateUsageStatus(ctx);
	});

	safeOn("thinking_level_select", (event, ctx) => {
		if (subagentChild) return;
		const level = (event as any).level;
		if (thinkingRank(level) < 0) return;
		const appliedLevel = level as ReasoningLevel;
		const previousLevel = (event as any).previousLevel;
		const previouslyObserved = lastObservedThinkingLevel;
		if (thinkingChangeSource.getStore() === "extension") {
			lastObservedThinkingLevel = appliedLevel;
			return;
		}
		if (internalModelChanges > 0) {
			lastObservedThinkingLevel = appliedLevel;
			return;
		}
		const modelKey = thinkingModelKey(ctx);
		if (
			pendingModelThinkingChange?.model === modelKey &&
			pendingModelThinkingChange.previousLevel === previousLevel &&
			pendingModelThinkingChange.appliedLevel === appliedLevel
		) {
			pendingModelThinkingChange = undefined;
			lastObservedThinkingLevel = appliedLevel;
			return;
		}
		// Pi changes ctx.model and applies its default/clamp before model_select. When this handler
		// wins the fire-and-forget race, the old model and exact level transition identify that one
		// native change. model_select handles the opposite order below.
		if (
			lastObservedModelKey &&
			modelKey !== "unknown" &&
			modelKey !== lastObservedModelKey &&
			thinkingRank(previousLevel) >= 0 &&
			previousLevel === previouslyObserved
		) {
			pendingModelThinkingChange = {
				model: modelKey,
				previousLevel,
				appliedLevel,
			};
			lastObservedThinkingLevel = appliedLevel;
			return;
		}
		lastObservedThinkingLevel = appliedLevel;
		thinkingPreferenceChanged = true;
		desiredThinkingLevel = appliedLevel;
		thinkingClamp = undefined;
		rememberUserModel(ctx?.model);
	});

	safeOn("model_select", (event, ctx) => {
		const model = (event as any).model;
		if (!model?.provider || !model?.id || subagentChild) return;
		// A user-driven switch goes through Pi's own path, which is the same path that is supposed
		// to rewrite settings.json — so it deserves the same verification as one of ours.
		pendingSettingsCheck = true;
		updateUsageStatus(ctx, model.provider);
		runBackground("model_select usage refresh", ctx, () =>
			refreshUsage(ctx, model.provider),
		);
		const selected = ref(model.provider, model.id);
		const appliedThinkingLevel = readThinkingLevel();
		const pendingThinking = pendingModelThinkingChange;
		pendingModelThinkingChange = undefined;
		if (
			pendingThinking?.model === selected &&
			(!appliedThinkingLevel || pendingThinking.appliedLevel === appliedThinkingLevel)
		) {
			thinkingClamp = {
				model: selected,
				level: pendingThinking.appliedLevel,
			};
		} else if (
			appliedThinkingLevel &&
			lastObservedThinkingLevel &&
			appliedThinkingLevel !== lastObservedThinkingLevel
		) {
			pendingModelThinkingChange = {
				model: selected,
				previousLevel: lastObservedThinkingLevel,
				appliedLevel: appliedThinkingLevel,
			};
			thinkingClamp = { model: selected, level: appliedThinkingLevel };
		}
		if (appliedThinkingLevel) lastObservedThinkingLevel = appliedThinkingLevel;
		lastObservedModelKey = selected;
		if (automaticModelTarget === selected) {
			automaticModelTarget = undefined;
			rememberUserModel(model);
			return;
		}
		if ((event as any).source === "restore") return;
		modelPreferenceChanged = true;
		rememberUserModel(model);
		// A manual model change is user control, not a permanent "never fail over" pin.
		// Cancel stale pending work; if the selected model then returns a real limit, normal
		// failover still applies to that completed request.
		claimUserControl("manual model selection");
		if (queuedUserInputs.length > 0) {
			runBackground("manual model selection queued input resume", ctx, () =>
				attemptQueuedInputResume(ctx),
			);
		}
	});

	safeOn("after_provider_response", (event, ctx) => {
		noteResumeProgress(); // a provider response arrived → the resumed turn is alive
		// The governor's ground truth. Deliberately ahead of every other check, `config.enabled`
		// included: whether a request reached a provider is a fact about the session, not
		// something this extension's own settings get an opinion about.
		noteProviderRequestObserved();
		if (ctx.model && usageFamily(ctx.model.provider) === "codex") {
			const entry = readAuthFile()[ctx.model.provider];
			const snapshot = parseCodexUsageHeaders(
				ctx.model.provider,
				(event as any).headers ?? {},
				Date.now(),
				entry ? credentialHash(entry) : undefined,
			);
			if (snapshot) storeUsage(ctx, snapshot);
		}
		if (!automaticFailoverEnabled()) return;
		const status = (event as any).status;
		if (status < 400 && ctx.model) {
			noteProviderSuccessObserved();
			noteAuthSuccess(ctx.model.provider, ctx.model.id);
			noteRecoveryProgress(); // a good response → recovery works → close the breaker
			responseCooldownHints.delete(ctx.model.provider);
			return;
		}
		if ((status === 429 || status === 402 || status === 403) && ctx.model) {
			// Only set cooldown hints for providers this extension manages.
			// Without this guard, a 429 on any provider pollutes cooldown state.
			if (!classifyProvider(ctx.model.provider, config.qwenProvider)) return;
			const cooldownMs = cooldownFromHeaders((event as any).headers ?? {});
			if (cooldownMs !== undefined) {
				responseCooldownHints.set(
					ctx.model.provider,
					Math.max(
						responseCooldownHints.get(ctx.model.provider) ?? 0,
						cooldownMs,
					),
				);
			}
		}
	});

	safeOn("message_end", async (event, ctx) => {
		const message = (event as any).message;
		if (message?.role !== "assistant" || !automaticFailoverEnabled()) return;
		if (message.stopReason !== "error") {
			// A model reply that is not an error is a request that went out and came back — the
			// second, independent witness for the governor, so a host that reports responses
			// differently cannot make a healthy session look like a spinning one.
			noteProviderSuccessObserved();
			if (message.provider) noteAuthSuccess(message.provider, message.model);
			return;
		}
		if (userAbortedChain || ctx.signal?.aborted) return; // user is cancelling — don't fail over
		const errorText = assistantErrorText(message);
		const provider =
			typeof message.provider === "string"
				? message.provider
				: ctx.model?.provider;
		const modelId =
			typeof message.model === "string" ? message.model : ctx.model?.id;
		if (!provider || !modelId) return;
		// Normally we only react to errors from providers this extension manages. But if the
		// user's ACTIVE model is on an unmanaged provider (e.g. a plain `openai` API key that hit
		// its billing quota — "You exceeded your current quota"), we still rescue the task by
		// failing over to a managed account, which is exactly what the user expects. We only skip
		// errors from unmanaged providers that are NOT the model the user is currently on (those
		// are unrelated background errors we must not hijack).
		const managed = !!classifyProvider(provider, config.qwenProvider);
		const isCurrentModelProvider = provider === ctx.model?.provider;
		if (!managed && !isCurrentModelProvider) return;
		const errorKey = `${provider}/${modelId}:${message.timestamp ?? "unknown"}:${errorText}`;
		if (handledAssistantErrors.has(errorKey)) return;
		handledAssistantErrors.add(errorKey);
		const failedModel = ctx.modelRegistry.find(provider, modelId) ?? {
			provider,
			id: modelId,
		};
		logEvent("assistant_error", {
			session: sessionInstanceId,
			provider,
			model: modelId,
			classified: isAuthError(errorText)
				? "auth"
				: isContextOverflowError(errorText)
					? "context_overflow"
					: isLimitError(errorText)
						? "limit"
						: isModelError(errorText)
							? "model"
							: isTransientError(errorText)
								? "transient"
								: "unhandled",
			error: errorText,
		});

		// Unmanaged active provider (e.g. plain `openai` API quota): we cannot manage its
		// cooldown/refresh lifecycle, but we rescue the task by switching to a managed account on
		// any actionable error. scope:"model" + a short cooldown so we never poison a provider we
		// don't own.
		if (!managed) {
			// Opt-out for unmanaged providers that run their own retry logic (usually a companion
			// extension owning retries for that provider). Switching accounts underneath it would
			// fight those retries, so leave the turn alone entirely.
			if (config.neverFailoverProviders.includes(provider)) {
				logEvent("failover_suppressed", {
					provider,
					model: modelId,
					reason: "neverFailoverProviders",
				});
				return;
			}
			// A quota or authorization refusal is about the ACCOUNT, not the model, and it does not
			// clear in a minute: an unmanaged account out of credits refuses everything until it is
			// topped up. Benching only the model for `transientCooldownMs` let the very next switch
			// pick the same account, get the same refusal, and close the loop — which is precisely
			// how a session ended up answering every user message with the same "out of credits"
			// error while live accounts sat unused. Transient blips and model-specific errors keep
			// the light touch, because those genuinely are momentary or model-scoped.
			const accountLevel = isLimitError(errorText) || isAuthError(errorText);
			if (
				accountLevel ||
				isModelError(errorText) ||
				isTransientError(errorText)
			) {
				await switchToFallback(
					ctx,
					failedModel,
					`external provider out of quota: ${errorText.slice(0, 100)}`,
					accountLevel ? config.cooldownMs : config.transientCooldownMs,
					{ scope: accountLevel ? "provider" : "model" },
				);
			}
			return;
		}

		if (isAuthError(errorText)) {
			let killed = false;
			let reason = errorText;
			if (
				isRefreshable(provider) &&
				patternMatch(errorText, FORCE_REFRESH_AUTH_ERROR_PATTERNS)
			) {
				const refresh = await forceRefreshProvider(ctx, provider);
				if (refresh.status === "refreshed") {
					noteAuthSuccess(provider, modelId);
					const target = ref(provider, modelId);
					currentPromptSwitch = {
						from: target,
						to: target,
						reason:
							"OAuth access token was revoked early and refreshed automatically",
						at: Date.now(),
					};
					ctx.ui.notify(
						`Provider failover: ${provider} access token was invalidated, refreshed successfully, and will retry on the same account.`,
						"info",
					);
					return;
				}
				if (refresh.status === "terminal") {
					reason = `OAuth refresh failed permanently: ${refresh.error}`;
					markInvalid(provider, reason);
					killed = true;
				} else if (refresh.status === "transient") {
					reason = `OAuth refresh failed temporarily: ${refresh.error}`;
					markExhausted(provider, config.transientCooldownMs);
				} else {
					killed = markAuthFailure(provider, errorText);
				}
			} else {
				killed = markAuthFailure(provider, errorText);
			}
			if (killed) {
				// For a Claude login, "run /login" alone sends people round a loop they have often
				// already been round: log in, work for a few hours, get kicked out, log in again.
				// The reason is not in the error text and cannot be guessed from it — every CLI that
				// signs into Claude Pro/Max uses the SAME client id, and Anthropic keeps one live
				// refresh token per account for that client. So signing the same account into another
				// tool, another machine, or a second slot here revokes this one, quietly, hours later.
				// Naming that is the difference between a fix and a ritual.
				const sharedClientHint =
					classifyProvider(provider, config.qwenProvider) === "anthropic" &&
					/invalid_grant|revoked/i.test(reason)
						? ' Its refresh token was revoked server-side. Claude Pro/Max logins from every CLI share one client id and Anthropic keeps a single live refresh token per account, so signing this same account into another tool (Claude Code, another machine, or a second slot here) revokes this one. Use a different Claude account per slot, and keep the account another tool is signed into out of this rotation.'
						: "";
				ctx.ui.notify(
					`Provider failover: ${provider} authorization is invalid. Run /login, choose "Use a subscription", then select ${provider}.${sharedClientHint}`,
					"warning",
				);
			}
			// A killed account is already in invalidatedByProvider (no cooldown entry needed —
			// that was the v1.8.x "8696h cooldown" bug). A transient auth failure gets the brief
			// TRANSIENT_AUTH_COOLDOWN_MS so selection skips it for a moment and Pi can refresh.
			const cooldownMs = killed ? 0 : TRANSIENT_AUTH_COOLDOWN_MS;
			await switchToFallback(
				ctx,
				failedModel,
				killed
					? `auth invalid: ${reason.slice(0, 100)}`
					: `transient auth failure: ${reason.slice(0, 100)}`,
				cooldownMs,
			);
			return;
		}
		if (isLimitError(errorText)) {
			const cooldownMs = await resolveLimitCooldownMs(ctx, provider, errorText);
			responseCooldownHints.delete(provider);
			await switchToFallback(
				ctx,
				failedModel,
				`assistant error: ${errorText.slice(0, 120)}`,
				cooldownMs,
			);
			return;
		}
		if (isModelError(errorText)) {
			await switchToFallback(
				ctx,
				failedModel,
				`model unavailable: ${errorText.slice(0, 120)}`,
				config.transientCooldownMs,
				{ scope: "model" },
			);
			return;
		}
		if (isTransientError(errorText)) {
			// A temporary error on an ordinary user turn gets one same-model retry. The same error on
			// a turn WE resumed is a failed recovery and must feed the breaker; otherwise the provider's
			// own four HTTP retries are wrapped in eight extension retries (32 requests and eight
			// synthetic user prompts), exactly the Kimi 500 loop seen in the incident transcript.
			if (continuationDispatchedForAgentTurn || activeResumeWatch) {
				noteRecoveryFailure(ctx);
				if (isBreakerOpen()) {
					currentPromptSwitch = undefined;
					clearPendingContinuation();
					return;
				}
			}
			const reason = `${TRANSIENT_PENDING_PREFIX} ${errorText.slice(0, 120)}`;
			markExhausted(provider, config.transientCooldownMs);
			if (!config.autoContinue) {
				ctx.ui.notify(
					`Provider failover: temporary server error on ${provider}/${modelId}. Retry manually in ~${formatDelay(config.transientCooldownMs)}.`,
					"warning",
				);
				return;
			}
			setPendingContinuation(ctx, failedModel, reason);
		}
	});

	safeOn("agent_end", async (event, ctx) => {
		if (!automaticFailoverEnabled()) return;
		const stop = lastAssistantStopReason((event as any).messages ?? []);
		// Our own watchdog aborted a wedged resumed turn — this is RECOVERY, not a user cancel.
		// Arm auto-resume so the work continues by itself the moment any account is free again;
		// the user should never have to re-type the prompt to get unstuck.
		if (watchdogAborting) {
			watchdogAborting = false;
			endResumeWatch();
			const failed =
				ctx.model?.provider && ctx.model?.id ? ctx.model : undefined;
			currentPromptSwitch = undefined;
			continuationDispatchedForAgentTurn = false;
			if (failed && config.enabled && config.autoContinue) {
				setPendingContinuation(
					ctx,
					failed,
					"auto-recovered a stuck resume; waiting for an account to free up",
				);
			}
			return;
		}
		// Respect the user: if they pressed Esc, the last assistant message is "aborted".
		if (stop === "aborted" || ctx.signal?.aborted) {
			// Esc must reach the timers too, not only this turn: a wake already past its guards
			// would otherwise switch account and re-arm the wait right after the cancel landed.
			chainEpoch++;
			userAbortedChain = true;
			startFreshFailoverChain();
			clearPendingContinuation();
			currentPromptSwitch = undefined;
			continuationDispatchedForAgentTurn = false;
			endResumeWatch();
			return;
		}
		// The resumed/continued turn has ended — stop watching it for stalls.
		endResumeWatch();
		// CRITICAL (fixes "Cannot continue from message role: assistant"): only resume when the
		// turn actually ended in an ERROR we can continue from. A non-error end means the work
		// already advanced on the (switched) account; there is nothing to resume. The old code
		// kept currentPromptSwitch set across later agent_end cycles and re-dispatched a resume
		// on a SUCCESSFUL assistant tail, which threw that cryptic error into the transcript.
		if (stop !== "error") {
			chainEpoch++;
			clearPendingContinuation();
			currentPromptSwitch = undefined;
			continuationDispatchedForAgentTurn = false;
			return;
		}
		if (continuationDispatchedForAgentTurn) {
			continuationDispatchedForAgentTurn = false;
			return;
		}
		if (!config.enabled || !config.autoContinue || userAbortedChain) return;
		await maybeDispatchContinuation(ctx);
	});

	// Pi `await`s the factory. Returning the Cursor setup promise means
	// createAgentSession's getModel(cursor, cursor-grok-4.6) runs AFTER fallback
	// models are registered, so the host restore does not print
	// "Could not restore model" and dump the session onto kimi/anthropic.
	return cursorReady;
}
