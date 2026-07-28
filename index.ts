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

import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_BASE,
	getCursorProviderRoot,
	isCursorProviderId,
	isCursorProviderInstalled,
	setupCursorSubscription,
} from "./cursor-bridge.ts";

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
		refresh: (credentials: any) => Promise<any>;
	};
	codex: {
		usesCallbackServer: boolean;
		login: (callbacks: any) => Promise<any>;
		refresh: (credentials: any) => Promise<any>;
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
			refresh: (credentials) => mod.refreshAnthropicToken(credentials.refresh),
		},
		codex: {
			usesCallbackServer: codex.usesCallbackServer ?? true,
			login: (callbacks) => codex.login(callbacks),
			refresh: (credentials) => codex.refreshToken(credentials),
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
): PiAiOauthBridge | undefined {
	const anthropicOauth = anthropicMod?.anthropicProvider?.()?.auth?.oauth;
	const codexOauth = codexMod?.openaiCodexProvider?.()?.auth?.oauth;
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
			refresh: (credentials) => anthropicOauth.refresh(credentials),
		},
		codex: {
			// The flag is gone from the new shape; both eras of pi-ai's Codex flow use a
			// local callback server, and Pi only reads this to decide how to present login.
			usesCallbackServer: true,
			login: (callbacks) => codexOauth.login(toAuthInteraction(callbacks)),
			refresh: (credentials) => codexOauth.refresh(credentials),
			// Identical to what pi-ai <= 0.79's getApiKey did (verified in its source).
			getApiKey: (credentials) => credentials.access,
		},
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
	compareCodexModelStrength,
	fetchCodexModelCatalog,
	rankAnthropicModelIds,
	type CodexCatalogModel,
	type CodexCatalogSnapshot,
} from "./model-catalog.ts";
import {
	fetchUsageSnapshot,
	formatUsageCompact,
	formatUsageDetails,
	parseCodexUsageHeaders,
	providerUsageLabel,
	usageColor,
	usageFamily,
	UsageFetchError,
	type UsageSnapshot,
	type UsageWindow,
} from "./usage.ts";

type ModelRef = `${string}/${string}`;
type ProviderFamily =
	| "anthropic"
	| "openai-codex"
	| "qwen"
	| "ollama"
	| "cursor";
type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

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
	includeCursor?: boolean;
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
	// When the active account is rate-limited/cooling/invalid and Pi needs to compact
	// (context overflow or threshold), run the summary on a HEALTHY fallback account
	// instead of letting the default summary die on the dead account. Default: true.
	routeCompactionToHealthyAccount?: boolean;
	// When a resumed turn wedges (silent past stuckWatchdogMs with no tool running), auto-cancel
	// it and auto-resume when an account frees, instead of only notifying. Default: true.
	autoRecoverStuck?: boolean;
	// Write a structured "black box" decision log to provider-failover-debug.log. Default: true.
	// Contains no credentials — only provider/model ids, decisions, and truncated reasons.
	debugLog?: boolean;
	// Always upgrade to the newest available model on failover instead of carrying a
	// previously-downgraded model forward forever. Default: true.
	preferLatestModel?: boolean;
	// Reasoning effort to apply at the start of every turn and restore after model/account
	// switches. Default: high. Extreme levels such as xhigh are opt-in only.
	reasoningLevel?: ReasoningLevel;
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
		| "includeCursor"
		| "neverFailoverProviders"
		| "providerOrder"
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
		| "routeCompactionToHealthyAccount"
		| "autoRecoverStuck"
		| "debugLog"
		| "preferLatestModel"
		| "reasoningLevel"
		| "preferredModels"
		| "resumeIdleTimeoutMs"
		| "stuckWatchdogMs"
	>
> & {
	openaiCodexAliases: OpenAICodexAliasConfig[];
	anthropicOAuthAliases: AnthropicOAuthAliasConfig[];
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
	usageByProvider?: Record<string, UsageSnapshot>;
	codexModelCatalogByProvider?: Record<string, CodexCatalogSnapshot>;
	pendingContinuationPrompt?: string;
	pendingFrom?: ModelRef;
	pendingSince?: number;
	pendingReason?: string;
	lastSwitches?: SwitchRecord[];
};

const AGENT_DIR =
	process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "provider-failover.json");
const STATE_PATH = join(AGENT_DIR, "provider-failover-state.json");
const AUTH_PATH = join(AGENT_DIR, "auth.json");
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
const VERSION = "1.14.1";
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
const COMPACTION_WATCHDOG_MS = 150 * 1000; // a healthy-account compaction summary may not exceed this

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
];

// Errors that mean "this account's authorization is dead" → drop from rotation
// until the user re-logs in (not a temporary cooldown).
const DEFAULT_AUTH_ERROR_PATTERNS = [
	"401",
	"unauthorized",
	"authentication_error",
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
	"Do not repeat completed work or duplicate actions.",
	"The full conversation context is already in this session — just continue working.",
].join(" ");

const DEFAULT_PROVIDER_ORDER: ProviderFamily[] = [
	"anthropic",
	"openai-codex",
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
const DEFAULT_QWEN_MODELS = ["qwen3.7-max", "qwen-max", "qwen-plus"];
const DEFAULT_CURSOR_MODELS = ["composer-2.5"];

const DEFAULT_CONFIG: ProviderFailoverConfig = {
	enabled: true,
	autoContinue: true,
	autoDiscover: true,
	autoDiscoverModels: true,
	maxAccountsPerProvider: 10,
	includeQwen: true,
	qwenProvider: DEFAULT_QWEN_PROVIDER,
	includeOllama: true,
	includeCursor: true,
	neverFailoverProviders: [],
	providerOrder: DEFAULT_PROVIDER_ORDER,
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
	routeCompactionToHealthyAccount: true,
	autoRecoverStuck: true,
	debugLog: true,
	preferLatestModel: true,
	reasoningLevel: "high",
	preferredModels: {},
	resumeIdleTimeoutMs: RESUME_IDLE_TIMEOUT_MS,
	stuckWatchdogMs: STUCK_WATCHDOG_MS,
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

function normalizeConfig(raw: ProviderFailoverConfig): RuntimeConfig {
	const order =
		Array.isArray(raw.providerOrder) && raw.providerOrder.length > 0
			? raw.providerOrder
			: DEFAULT_PROVIDER_ORDER;
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
		includeCursor: raw.includeCursor ?? true,
		neverFailoverProviders: stringArray(raw.neverFailoverProviders),
		providerOrder: order.filter(
			(f): f is ProviderFamily =>
				f === "anthropic" ||
				f === "openai-codex" ||
				f === "cursor" ||
				f === "qwen" ||
				f === "ollama",
		),
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
		limitErrorPatterns: nonEmptyStringArrayOr(
			raw.limitErrorPatterns,
			DEFAULT_LIMIT_PATTERNS,
		),
		authErrorPatterns: nonEmptyStringArrayOr(
			raw.authErrorPatterns,
			DEFAULT_AUTH_ERROR_PATTERNS,
		),
		transientErrorPatterns: nonEmptyStringArrayOr(
			raw.transientErrorPatterns,
			DEFAULT_TRANSIENT_ERROR_PATTERNS,
		),
		modelErrorPatterns: nonEmptyStringArrayOr(
			raw.modelErrorPatterns,
			DEFAULT_MODEL_ERROR_PATTERNS,
		),
		ignoreErrorPatterns: nonEmptyStringArrayOr(
			raw.ignoreErrorPatterns,
			DEFAULT_IGNORE_PATTERNS,
		),
		continuationPrompt:
			raw.continuationPrompt?.trim() || DEFAULT_CONTINUATION_PROMPT,
		routeCompactionToHealthyAccount:
			raw.routeCompactionToHealthyAccount ?? true,
		autoRecoverStuck: raw.autoRecoverStuck ?? true,
		debugLog: raw.debugLog ?? true,
		preferLatestModel: raw.preferLatestModel ?? true,
		reasoningLevel:
			raw.reasoningLevel === "off" ||
			raw.reasoningLevel === "minimal" ||
			raw.reasoningLevel === "low" ||
			raw.reasoningLevel === "medium" ||
			raw.reasoningLevel === "high" ||
			raw.reasoningLevel === "xhigh"
				? raw.reasoningLevel
				: "high",
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
		writeFileSync(
			STATE_PATH,
			`${JSON.stringify({ stateVersion: STATE_VERSION, ...state }, null, "\t")}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
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

function readAuthFile(): Record<string, AuthEntry> {
	try {
		return JSON.parse(readFileSync(AUTH_PATH, "utf8")) as Record<
			string,
			AuthEntry
		>;
	} catch {
		return {};
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

function hash12(input: string) {
	return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

/** A stable fingerprint of the current credential, used to detect re-login. */
function credentialHash(entry: AuthEntry): string | undefined {
	const secret = entry.access ?? entry.key;
	return secret ? hash12(secret) : undefined;
}

/**
 * Identity of the REAL underlying account, used to detect the same account logged into multiple
 * slots. Deterministic where the data allows it:
 *   - `accountId` stored in auth.json (Codex/ChatGPT) → rock-solid, survives re-login.
 *   - else the account id embedded in a JWT access token (Codex fallback).
 *   - else a hash of the API key (same key = same account).
 *   - else a hash of the opaque access token. Opaque OAuth tokens (Anthropic) change on every login,
 *     so this only catches the literal same-token case. Two separate logins of the same Anthropic
 *     account are not deterministically identifiable from auth.json alone.
 */
function accountIdentity(entry: AuthEntry): string | undefined {
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

/** Single source of truth for Anthropic OAuth refresh — used by BOTH the base provider and aliases. */
async function refreshAnthropicCredentials(credentials: any) {
	return mergeRefreshedCredentials(
		credentials,
		await requirePiAiOauth().anthropic.refresh(credentials),
	);
}

function registerAnthropicSlot(
	pi: ExtensionAPI,
	id: string,
	modelIds: string[] = DEFAULT_ANTHROPIC_MODELS,
) {
	if (id === ANTHROPIC_BASE) return; // base provider: oauth + shaping registered in piMultiAccount()
	const models = modelIds.map((m) => anthropicModelDef(m, id));
	pi.registerProvider(id, {
		name: `Claude Pro/Max (${id})`,
		baseUrl: "https://api.anthropic.com",
		api: "anthropic-messages" as any,
		oauth: {
			name: `Claude Pro/Max (${id})`,
			async login(callbacks: any) {
				return rejectDuplicateLogin(
					id,
					await requirePiAiOauth().anthropic.login(callbacks),
				);
			},
			refreshToken: refreshAnthropicCredentials,
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
		async refreshToken(credentials: any) {
			return getProvider().refresh(credentials);
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
) {
	if (id === CODEX_BASE) return; // base provider is native until live catalog sync enriches it
	pi.registerProvider(id, {
		name: `ChatGPT Plus/Pro (Codex ${id})`,
		baseUrl: "https://chatgpt.com/backend-api",
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
) {
	const name =
		id === CODEX_BASE
			? "ChatGPT Plus/Pro (Codex)"
			: `ChatGPT Plus/Pro (Codex ${id})`;
	pi.registerProvider(id, {
		name,
		baseUrl: "https://chatgpt.com/backend-api",
		api: "openai-codex-responses" as any,
		oauth: codexOAuthOverride(id, name),
		models: models as any,
	});
}

// Base URLs and model lists for API-key provider families that support multiple
// accounts (each account = a separate API key in a numbered slot).
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const OLLAMA_LOCAL_BASE_URL = "http://127.0.0.1:11434/v1";
const OLLAMA_CLOUD_BASE_URL = "https://ollama.com/v1";

function isOllamaCloudModel(modelId: string): boolean {
	return modelId.includes(":cloud");
}

function ollamaBaseUrlForModel(modelId: string): string {
	return isOllamaCloudModel(modelId)
		? OLLAMA_CLOUD_BASE_URL
		: OLLAMA_LOCAL_BASE_URL;
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
	return { ...def, provider: providerId, baseUrl: ollamaBaseUrlForModel(id) };
}

// Alibaba Model Studio (Qwen), OpenAI-compatible International endpoint. The old default pointed at
// a `token-plan.*.maas.aliyuncs.com` promo endpoint that ACCEPTS the key on /models but returns
// 401 invalid_api_key on /chat/completions once the token plan lapses — so a perfectly valid Qwen
// key looked "invalid" and the account was wrongly dropped from rotation. Verified with a live
// request: the same key 200s on dashscope-intl for completions.
const QWEN_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const QWEN_MODEL_DEFS: Record<string, Record<string, unknown>> = {
	"qwen3.7-max": {
		id: "qwen3.7-max",
		name: "Qwen3.7 Max",
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
function registerApiKeySlot(
	pi: ExtensionAPI,
	id: string,
	family: "ollama" | "qwen",
) {
	const baseId = family === "ollama" ? OLLAMA_BASE : OLLAMA_BASE;
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
	const models = preferred.map((m) =>
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
	if ((secondaryUsed ?? 0) >= 100) return secondaryReset ?? primaryReset;
	if ((primaryUsed ?? 0) >= 100) return primaryReset ?? secondaryReset;
	return primaryReset ?? secondaryReset;
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
const CLAUDE_CODE_VERSION = "2.1.172";
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
		refreshToken: refreshAnthropicCredentials,
		getApiKey: (credentials: any) => credentials.access,
	};
}

// ===========================================================================
// Extension entry point
// ===========================================================================

export default function piMultiAccount(pi: ExtensionAPI) {
	// Warm up the OAuth helpers before any provider registration: providers are
	// registered synchronously below and their `usesCallbackServer`/`getApiKey`
	// read from the cached module. Deliberately NON-fatal — if pi-ai's oauth entry
	// cannot be resolved (hoisted npm layout, incompatible pi-ai), the extension
	// still loads and every non-OAuth account keeps working; only subscription
	// logins are unavailable, and the user is told once at session start.
	const oauthUnavailable = piAiOauthUnavailableReason();
	let config = loadConfig();
	debugLogEnabled = config.debugLog;
	let configuredFallbacks = config.fallbacks.slice();
	let persistedState = loadState();

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
	const usageUntrustedUntilByProvider = new Map<string, number>();

	// Discovered, authed, deduped provider ids in rotation order.
	let rotation: string[] = [];
	let duplicateSlots: Array<{ duplicate: string; primary: string }> = [];
	// Whether the one-time host-capability notice has already been shown this process.
	let preflightNotified = false;
	// Slot ids registered as targets in the interactive /login provider picker.
	const registeredSlots = new Set<string>();
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
	let pendingWakeTimer: ReturnType<typeof setTimeout> | undefined;
	let queuedInputWakeTimer: ReturnType<typeof setTimeout> | undefined;
	let usageStatusTimer: ReturnType<typeof setInterval> | undefined;
	const queuedUserInputs: Array<{ text: string; images?: any[] }> = [];
	let continuationDispatchedForAgentTurn = false; // avoid agent_end double-dispatch after message_end failover
	let userAbortedChain = false; // user pressed Esc → stop auto-continuing until a new prompt
	let lastLeftProvider: string | undefined; // account we just failed away from (anti-ping-pong)
	let lastLeftAt = 0;
	let automaticModelTarget: ModelRef | undefined;
	// Forward-progress watchdog state. A "resume in flight" is a continuation WE dispatched
	// (pi.continueAgent after a switch) whose new turn must keep showing activity. Any stream
	// token, tool event, or provider response is "progress" and disarms the stuck timer; total
	// silence past stuckWatchdogMs means the rotated turn wedged and the user is staring at a
	// spinner that will never finish — so we surface a concrete, actionable recovery.
	let resumeInFlight = false;
	let progressWatchdogTimer: ReturnType<typeof setTimeout> | undefined;
	let watchdogCtx: any;
	let lastResumeProgressAt = 0;
	let stuckReminders = 0;
	// True only while WE deliberately abort a wedged resumed turn, so agent_end can tell our
	// recovery abort apart from a real user Esc and auto-continue instead of stopping.
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
	// The thinking level the user intended for this turn. pi.setModel() re-clamps and
	// persists the thinking level on every model switch, so without this it drifts
	// downward across failovers ("thinking level keeps dropping"). We capture it before
	// any switch and re-assert it after each successful switch.
	let desiredThinkingLevel: any;

	function captureDesiredThinking() {
		// Capture the session's ACTUAL thinking level (the per-agent configured value,
		// e.g. Mimir=low, Brokkr=high) rather than the global config.reasoningLevel.
		// Using the global default here clobbered per-agent thinking on every agent_start.
		// This still preserves the level across failovers via restoreDesiredThinking.
		desiredThinkingLevel = (pi as any).getThinkingLevel?.() ?? config.reasoningLevel;
		try {
			(pi as any).setThinkingLevel?.(desiredThinkingLevel);
		} catch {
			/* older hosts clamp or reject unsupported levels; failover remains functional */
		}
	}

	function restoreDesiredThinking() {
		if (!desiredThinkingLevel) return;
		try {
			(pi as any).setThinkingLevel?.(desiredThinkingLevel);
		} catch {
			/* setThinkingLevel clamps to model caps; ignore if unsupported */
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

	function persist(extra?: Partial<ProviderFailoverState>) {
		persistedState = {
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
			usageByProvider: Object.fromEntries(usageByProvider.entries()),
			codexModelCatalogByProvider: Object.fromEntries(
				codexModelCatalogByProvider.entries(),
			),
		};
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

		const family = classifyProvider(provider, config.qwenProvider);
		try {
			let refreshed: AuthEntry | undefined;
			if (family === "anthropic") {
				refreshed = await refreshAnthropicCredentials(entry);
			} else if (family === "openai-codex") {
				refreshed = mergeRefreshedCredentials(
					entry,
					await requirePiAiOauth().codex.refresh(entry as any),
				);
			} else if (family === "cursor") {
				const authMod = await import(
					join(AGENT_DIR, "git/github.com/ndraiman/pi-cursor-provider/auth.ts")
				);
				refreshed = mergeRefreshedCredentials(
					entry,
					await authMod.refreshCursorToken(entry.refresh),
				);
			} else {
				return { status: "unsupported" };
			}

			if (!refreshed?.access || typeof authStorage?.set !== "function") {
				return {
					status: "transient",
					error:
						"OAuth refresh returned no usable access token or AuthStorage cannot persist it",
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

			authStorage.set(provider, { type: "oauth", ...entry, ...refreshed });
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
			registerAnthropicSlot(pi, provider, ranked);
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
			if (codexModelCatalogByProvider.has(provider)) continue;
			registerCodexCatalog(pi, provider, merged as Array<Record<string, unknown>>);
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
			const models = codexModelCatalogByProvider.get(provider)?.models ?? registryFallback;
			registerCodexCatalog(pi, provider, models as Array<Record<string, unknown>>);
		}
		// Also keep unauthenticated spare login slots current so a newly logged-in account can select
		// the new flagship before the next restart/session refresh.
		for (const provider of registeredSlots) {
			if (classifyProvider(provider, config.qwenProvider) !== "openai-codex") continue;
			if (providers.includes(provider)) continue;
			registerCodexCatalog(pi, provider, allKnown as Array<Record<string, unknown>>);
		}
		if (changed) persist();
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
			const text = formatUsageCompact(display);
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
	): Promise<UsageSnapshot | undefined> {
		if (!config.showUsage || !provider || !usageFamily(provider)) {
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

	function clearUsageStatusTimer() {
		if (!usageStatusTimer) return;
		clearInterval(usageStatusTimer);
		usageStatusTimer = undefined;
	}

	function startUsageStatusTimer(ctx: any) {
		clearUsageStatusTimer();
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
			});
		}, config.usageStatusRefreshMs);
		(usageStatusTimer as any).unref?.();
	}

	/** A successful response → this account's auth is fine; clear its 401 streak. */
	function noteAuthSuccess(provider: string, modelId?: string) {
		// A real success proves the account works right now → the usage reading was not lying; reset
		// the limit-error streak and re-trust usage for this provider.
		limitStreakByProvider.delete(provider);
		usageUntrustedUntilByProvider.delete(provider);
		let changed = authFailures.delete(provider);
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
		if (count >= 2)
			usageUntrustedUntilByProvider.set(provider, now + USAGE_UNTRUSTED_MS);
		return count;
	}

	function providerRecoveryAt(provider: string, now = Date.now()): number {
		let at = Math.max(now, exhaustedUntilByProvider.get(provider) ?? now);
		const cached = usageByProvider.get(provider);
		if (cached) {
			const fresh = now - cached.fetchedAt < usageCacheTtl(provider);
			const usageMs = cooldownMsFromUsage(cached, now);
			// A HARD BLOCK — a usage window at >=100% whose reset is still in the future — is
			// authoritative ground truth REGARDLESS of snapshot age: a maxed 30-day (or 5h) window
			// cannot have "un-maxed" itself in the minutes since we last probed, and cooldownMsFromUsage
			// already drops any window whose reset has passed. So we trust it even when stale. This is
			// the fix for the real failure mode: a genuinely-spent account (e.g. a free-tier Codex slot
			// maxed on its monthly window) that never threw an error yet and had no recorded cooldown
			// was treated as "available" and selected as the failover target — so failover kept landing
			// on dead accounts instead of advancing to a live Qwen/Ollama one.
			if (usageMs !== undefined && usageMs > 0) return now + usageMs;
			// "Available now" (usageMs === 0) is only trusted while FRESH — a stale pre-limit reading
			// must never clear a real cooldown early — AND only while usage is still trusted for this
			// provider. A session/rate-limited account keeps 429ing while its quota window shows
			// headroom; once that has been proven (usageUntrusted), we respect the recorded cooldown
			// (`at`) instead of falsely reporting "recovered now" and hot-looping a ~1s retry.
			if (fresh && usageMs === 0) return usageUntrusted(provider, now) ? at : now;
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
		// Count this limit error. A repeat within the streak window flips usage to "distrusted".
		const streak = noteLimitError(provider, now);
		const hintedCooldowns = [
			responseCooldownHints.get(provider),
			cooldownFromErrorText(errorText),
		].filter(
			(value): value is number => typeof value === "number" && value > 0,
		);
		const snapshot = await refreshUsage(ctx, provider, true);
		if (snapshot) {
			applyUsageToCooldown(provider, snapshot, now);
			const usageMs = cooldownMsFromUsage(snapshot);
			// Fresh usage is normally GROUND TRUTH. If it says the account is available right now
			// (primary window has headroom → usageMs === 0), trust it over any pessimistic error-text
			// estimate: a maxed long/rolling window must not evict an account whose short window has
			// already freed. BUT the usage-% window does not see session/rate limits — so once the
			// account has limit-errored twice in a row while usage claimed "free", we stop believing
			// the 0 and record a real floor cooldown instead of returning 0 and hot-looping a retry.
			if (usageMs === 0) {
				if (streak < 2) return 0;
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

	function markExhausted(provider: string, cooldownMs: number) {
		if (cooldownMs <= 0) return; // killed accounts are in invalidatedByProvider, not cooldowns
		// Invariant backstop: no LIVE cooldown may exceed the ceiling, regardless of caller. A
		// far-future reset from a long/rolling limit window must never evict an account for weeks —
		// it is re-probed at the cap and usage reconciliation shortens it further if truly free.
		const until = Date.now() + Math.min(Math.max(cooldownMs, 1000), MAX_LIVE_COOLDOWN_MS);
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
		return result;
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
					`pi-multi-account: the Cursor provider at ${getCursorProviderRoot()} failed to load, so Cursor accounts are unavailable this session (${reason.slice(0, 160)}). Everything else keeps working; update that provider or set "includeCursor": false in ${CONFIG_PATH} to silence this.`,
					"warning",
				);
			}
		}
	}

	/** Register authed alias slots plus one spare per family for the next interactive /login. */
	function syncRegisteredSlots(auth: Record<string, AuthEntry>) {
		// Cursor is the one family whose provider lives in a separate, optional repo. Unlike
		// anthropic/codex/qwen/ollama — which only ever create slots backed by a real auth
		// entry — cursor used to conjure a spare `cursor-account-2` out of nothing, so /login
		// offered a slot no provider could serve. Only offer cursor slots once the provider
		// is actually on disk.
		const cursorAvailable = config.includeCursor && isCursorProviderInstalled();
		const families: ProviderFamily[] = [
			"anthropic",
			"openai-codex",
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
				if (registeredSlots.has(id)) continue;
				if (family === "anthropic") registerAnthropicSlot(pi, id);
				else if (family === "openai-codex") registerCodexSlot(pi, id);
				else if (family === "ollama") registerApiKeySlot(pi, id, "ollama");
				else if (family === "qwen") registerApiKeySlot(pi, id, "qwen");
				registeredSlots.add(id);
			}
		}
		if (cursorAvailable) void refreshCursorSlots(auth);
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
		syncRegisteredSlots(auth);
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

	// Newest-first preferred model list for a family. A per-family config override
	// (preferredModels) wins so a new flagship can be pinned without a code change.
	function familyPreferredModels(family: string | undefined): string[] {
		if (!family) return [];
		const configured = config.preferredModels[family];
		if (configured && configured.length > 0) return configured;
		return family === "anthropic"
			? registryAnthropicModelOrder.length > 0
				? registryAnthropicModelOrder
				: DEFAULT_ANTHROPIC_MODELS
			: family === "openai-codex"
				? discoveredCodexModelOrder.length > 0
					? discoveredCodexModelOrder
					: registryCodexModelOrder.length > 0
						? registryCodexModelOrder
						: DEFAULT_CODEX_MODELS
				: family === "ollama"
					? DEFAULT_OLLAMA_MODELS
					: family === "qwen"
						? DEFAULT_QWEN_MODELS
						: family === "cursor"
							? DEFAULT_CURSOR_MODELS
							: [];
	}

	// Rank of a model within its family's newest-first preferred order (0 = newest).
	// Unknown models sort last. Used to keep the latest model across accounts, not
	// just within one account, during fallback ranking.
	function modelRecencyRank(model: any): number {
		const family = classifyProvider(model?.provider, config.qwenProvider);
		const order = familyPreferredModels(family);
		const idx = order.indexOf(model?.id);
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
			const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
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
		const registryModels = preferredOnly
			? []
			: ctx.modelRegistry
					.getAll()
					.filter((model: any) => model.provider === parsed.provider)
					.map((model: any) => model.id);
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
			seen.add(modelId);
			const model = ctx.modelRegistry.find(parsed.provider, modelId);
			if (model) result.push(model);
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
			const models = resolveTargets(ctx, fallbacks[i], currentModel).filter(
				(model: any) =>
					!options.excludeProviders?.has(model.provider) &&
					!isInvalidated(model.provider) &&
					providerHasUsableAuth(ctx, model.provider),
			);
			if (models.length === 0) continue;
			// Prefer the newest model that is not itself on a MODEL-level cooldown (a genuine
			// "model unavailable" error is the only sanctioned reason to fall to an older model).
			// A provider-level usage limit never demotes the model here: the flagship stays the
			// representative and the whole account simply cools — so we resume at the flagship, on
			// another account, instead of quietly dropping to a weaker model of the same account.
			const pick =
				models.find(
					(model: any) =>
						(exhaustedUntilByModel.get(`${model.provider}/${model.id}`) ?? 0) <=
						now,
				) ?? models[0];
			// Leaving the current account: skip it (we only ever re-offer it via the round-robin
			// wrap-around below). Excluding by the *representative* — never by the raw current
			// model — is what stops a weaker same-account model from bubbling up as a downgrade.
			if (
				!options.includeCurrent &&
				pick.provider === currentModel?.provider &&
				pick.id === currentModel?.id
			)
				continue;
			if (seen.has(pick.provider)) continue;
			seen.add(pick.provider);

			const key = `${pick.provider}/${pick.id}`;
			const providerUntil = providerRecoveryAt(pick.provider, now);
			const modelUntil = exhaustedUntilByModel.get(key) ?? 0;
			const remaining = Math.max(0, Math.max(providerUntil, modelUntil) - now);
			scored.push({
				model: pick,
				remaining,
				rotIndex: i,
				rank: modelRecencyRank(pick),
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

		let availableNow = scored
			.filter((s) => s.remaining === 0)
			.sort(byRankThenRot);
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
			.sort((a, b) => a.remaining - b.remaining || byRankThenRot(a, b))
			.map((s) => s.model);
	}

	async function activateFallback(
		ctx: any,
		sourceModel: any,
		candidates: any[],
		reason: string,
		options: { armContinuation?: boolean } = {},
	) {
		const from =
			sourceModel?.provider && sourceModel?.id
				? ref(sourceModel.provider, sourceModel.id)
				: ("unavailable/account" as ModelRef);
		const failedProviders = new Set<string>();
		for (const fallback of candidates) {
			if (failedProviders.has(fallback.provider)) continue;
			const to = ref(fallback.provider, fallback.id);
			if (to === from) {
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
					ok = await pi.setModel(fallback);
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
						ok = await pi.setModel(fallback);
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
			restoreDesiredThinking();
			setLastProbe(fallback.provider);
			const record = { from, to, reason, at: Date.now() };
			currentPromptSwitch =
				options.armContinuation === false ? undefined : record;
			logEvent("switch", { from, to, reason });
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
		if (!config.enabled || !failedModel?.provider || !failedModel?.id)
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
			{ armContinuation: !options.manual },
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

	async function ensureReadyModel(ctx: any, reason: string) {
		refreshDiscovery(false, ctx);
		pruneCooldowns();
		if (isCurrentModelReady(ctx)) return true;
		const candidates = findFallbackModels(ctx, ctx.model, {
			availableNowOnly: true,
			includeCurrent: true,
		});
		if (candidates.length === 0) return false;
		return activateFallback(ctx, ctx.model, candidates, reason, {
			armContinuation: false,
		});
	}

	// ----- pending auto-resume ---------------------------------------------

	function hasPendingResume(): boolean {
		return (
			!!(persistedState.pendingFrom && persistedState.pendingReason) ||
			!!persistedState.pendingContinuationPrompt
		);
	}

	// Reject a promise that does not settle within `ms`. Used to bound every network-bound
	// hand-off (compaction summary) so a wedged provider call can never hang the session.
	function withTimeout<T>(
		p: Promise<T>,
		ms: number,
		label: string,
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`${label} timed out after ${formatDelay(ms)}`)),
				ms,
			);
			timer.unref?.();
			p.then(
				(v) => {
					clearTimeout(timer);
					resolve(v);
				},
				(e) => {
					clearTimeout(timer);
					reject(e);
				},
			);
		});
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
		if (!resumeInFlight || !config.enabled) return;
		progressWatchdogTimer = setTimeout(
			onResumeStuck,
			Math.max(25, config.stuckWatchdogMs),
		);
		progressWatchdogTimer.unref?.();
	}

	function noteResumeProgress() {
		if (!resumeInFlight) return;
		lastResumeProgressAt = Date.now();
		stuckReminders = 0;
		armStuckWatchdog();
	}

	function beginResumeWatch(ctx: any) {
		resumeInFlight = true;
		watchdogCtx = ctx;
		lastResumeProgressAt = Date.now();
		stuckReminders = 0;
		toolInFlight = 0;
		armStuckWatchdog();
	}

	function endResumeWatch() {
		resumeInFlight = false;
		watchdogCtx = undefined;
		stuckReminders = 0;
		toolInFlight = 0;
		clearProgressWatchdog();
	}

	function onResumeStuck() {
		progressWatchdogTimer = undefined;
		if (!resumeInFlight) return;
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
			if (stuckReminders < 5 && resumeInFlight) {
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
	// Pick the model that should generate the compaction summary. Prefer the current account
	// when it is genuinely healthy (no switch, cheapest); otherwise the first fallback that is
	// free RIGHT NOW. Returns undefined when nothing healthier than the (unhealthy) current
	// account exists — the caller then leaves compaction to Pi's default.
	function pickCompactionModel(ctx: any): any | undefined {
		if (isCurrentModelReady(ctx)) return ctx.model;
		const candidates = findFallbackModels(ctx, ctx.model, {
			availableNowOnly: true,
			includeCurrent: false,
		});
		return candidates[0];
	}

	// session_before_compact handler. STRICTLY fail-safe: any uncertainty returns undefined so
	// Pi runs its normal default compaction. We only take over when the active account is
	// unavailable AND a healthy account exists AND the summary succeeds — turning the classic
	// "compaction hangs because it ran on the just-rate-limited account" into a clean summary
	// generated on a live account.
	async function runHealthyCompaction(
		event: any,
		ctx: any,
	): Promise<{ compaction: any } | undefined> {
		try {
			if (!config.enabled || !config.routeCompactionToHealthyAccount)
				return undefined;
			const preparation = event?.preparation;
			if (!preparation) return undefined;
			// Current account is healthy → Pi's default (on the current account) is fine.
			if (isCurrentModelReady(ctx)) {
				compactionRoutedNote = undefined;
				return undefined;
			}
			const model = pickCompactionModel(ctx);
			if (
				!model ||
				(model.provider === ctx.model?.provider && model.id === ctx.model?.id)
			) {
				// No account is free right now. Don't make it worse — let Pi try its default; the
				// pending-resume machinery pauses the session until an account recovers.
				compactionRoutedNote = "no live account for compaction; used default";
				return undefined;
			}
			const auth = await ctx.modelRegistry?.getApiKeyAndHeaders?.(model);
			if (!auth?.ok || (!auth.apiKey && !auth.headers)) {
				compactionRoutedNote = `compaction auth unavailable for ${model.provider}`;
				return undefined;
			}
			const mod = (await import("@earendil-works/pi-coding-agent").catch(
				() => undefined,
			)) as { compact?: (...args: any[]) => Promise<any> } | undefined;
			const compactFn = mod?.compact;
			if (typeof compactFn !== "function") return undefined; // older host: cannot route
			let thinkingLevel: any;
			try {
				thinkingLevel = (pi as any).getThinkingLevel?.();
			} catch {
				/* optional */
			}
			ctx.ui?.notify?.(
				`Provider failover: ${ctx.model?.provider ?? "active"} account is unavailable for compaction; summarizing on ${model.provider} instead.`,
				"info",
			);
			const result = await withTimeout(
				compactFn(
					preparation,
					model,
					auth.apiKey,
					auth.headers,
					event?.customInstructions,
					event?.signal,
					thinkingLevel,
				),
				COMPACTION_WATCHDOG_MS,
				`compaction on ${model.provider}`,
			);
			if (
				!result ||
				typeof result.summary !== "string" ||
				!result.summary.trim()
			) {
				compactionRoutedNote = "healthy compaction empty; used default";
				return undefined;
			}
			compactionRoutedNote = `compacted on ${model.provider}`;
			logEvent("compaction_routed", {
				to: model.provider,
				reason: event?.reason,
				from: ctx.model?.provider,
			});
			return { compaction: result };
		} catch (error) {
			compactionRoutedNote = `healthy compaction failed: ${String(error).slice(0, 60)}`;
			logEvent("compaction_failed", { error: String(error) });
			ctx?.ui?.notify?.(
				`Provider failover: healthy-account compaction did not finish (${String(error).slice(0, 100)}); using Pi's default compaction.`,
				"warning",
			);
			return undefined;
		}
	}

	// Graceful degradation when a seamless in-place resume is not possible — either the host build
	// predates pi.continueAgent(), or the transcript tail is a completed assistant message that
	// continueAgent() cannot pick up. Inject the continuation prompt as a fresh USER turn so the
	// session keeps moving on the account we just switched to, WITHOUT the user re-typing anything.
	// Bounded by maxAutoContinuesPerPrompt. Returns true when it started a continuation turn.
	function injectContinuationPrompt(ctx: any): boolean {
		if (
			!currentPromptSwitch ||
			!config.autoContinue ||
			userAbortedChain ||
			ctx.signal?.aborted ||
			autoContinuesThisPrompt >= config.maxAutoContinuesPerPrompt ||
			typeof pi.sendUserMessage !== "function"
		)
			return false;
		const to =
			currentPromptSwitch.to ??
			(ctx.model
				? ref(ctx.model.provider, ctx.model.id)
				: "the active account");
		const prompt = config.continuationPrompt
			.replaceAll(
				"{from}",
				String(currentPromptSwitch.from ?? "the previous account"),
			)
			.replaceAll("{to}", String(to))
			.replaceAll(
				"{reason}",
				currentPromptSwitch.reason ?? "provider failover",
			);
		try {
			expectingInjectedContinuation = true;
			// The host throws "Agent is already processing. Specify streamingBehavior ('steer' or
			// 'followUp')" if we inject while the previous turn is still streaming (exactly the race
			// that fires right after a failover switch). The extension-facing option is `deliverAs`
			// (the host maps deliverAs → streamingBehavior internally — see the queued-input resume
			// path below which already uses it). "followUp" QUEUES the continuation to run after the
			// current turn settles instead of being rejected; the host ignores it when not streaming.
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			autoContinuesThisPrompt++;
			return true;
		} catch {
			expectingInjectedContinuation = false;
			return false;
		}
	}

	async function resumeWithExistingContext(ctx: any): Promise<boolean> {
		if (userAbortedChain || ctx.signal?.aborted) return false;
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
			if (injectContinuationPrompt(ctx)) return true;
			ctx.ui.notify(
				"Provider failover: switched account, but this Pi build cannot auto-resume the turn (needs pi.continueAgent, or the previous turn to be idle). Send your message to continue on the new account.",
				"warning",
			);
			return false;
		}
		// Bounded wait for the prior turn to go idle — NEVER an unbounded busy-loop. If it does
		// not free up within resumeIdleTimeoutMs we return false; the caller (agent_end or the
		// pending-wake timer) re-arms and tries again, so the session can't wedge here forever.
		if (!ctx.isIdle()) {
			const waitUntil = Date.now() + config.resumeIdleTimeoutMs;
			while (!ctx.isIdle() && !userAbortedChain && !ctx.signal?.aborted) {
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
					if (failed && config.enabled && config.autoContinue)
						setPendingContinuation(ctx, failed, BUSY_RETRY_REASON);
					return false;
				}
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		}
		if (userAbortedChain || ctx.signal?.aborted) return false;
		beginResumeWatch(ctx);
		logEvent("resume_start", {
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown",
			hop: autoContinuesThisPrompt + 1,
		});
		try {
			await continueAgent({ stripErrorAssistant: true });
			autoContinuesThisPrompt++;
			logEvent("resume_ok", {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown",
			});
			return true;
		} catch (error) {
			const text = String(error);
			// A deliberate abort (our watchdog recovery, or the user pressing Esc) is not an error
			// to report — agent_end handles what happens next. Stay silent.
			if (
				watchdogAborting ||
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
				if (injectContinuationPrompt(ctx)) return true;
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
			endResumeWatch();
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

	function clearPendingContinuation() {
		if (pendingWakeTimer) {
			clearTimeout(pendingWakeTimer);
			pendingWakeTimer = undefined;
		}
		persistedState = {
			...persistedState,
			pendingContinuationPrompt: undefined,
			pendingFrom: undefined,
			pendingSince: undefined,
			pendingReason: undefined,
		};
		persist();
	}

	function pendingWakeProviders(): string[] {
		if (isSameModelResumeReason(persistedState.pendingReason ?? "")) {
			const parsed = persistedState.pendingFrom
				? parseTarget(persistedState.pendingFrom)
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
		return Math.max(MIN_PENDING_WAKE_MS, nextAt - now);
	}

	function schedulePendingWake(ctx: any) {
		if (pendingWakeTimer) clearTimeout(pendingWakeTimer);
		pendingWakeTimer = undefined;
		if (
			!hasPendingResume() ||
			userAbortedChain ||
			!config.enabled ||
			!config.autoContinue
		)
			return;
		const delay = nextPendingWakeDelayMs();
		if (delay === undefined) return;
		// Cap the sleep so we re-check availability periodically instead of trusting a single
		// multi-hour estimate. Each poll reconciles cooldowns against fresh usage, so the first
		// account that truly recovers wakes the session.
		pendingWakeTimer = setTimeout(
			() => {
				pendingWakeTimer = undefined;
				runBackground("pending auto-resume", ctx, () =>
					attemptPendingResume(ctx),
				);
			},
			Math.min(delay, config.pendingPollMs),
		);
		pendingWakeTimer.unref?.();
	}

	async function attemptPendingResume(ctx: any) {
		if (
			!hasPendingResume() ||
			userAbortedChain ||
			!config.enabled ||
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

		refreshDiscovery();
		reconcileCooldownsFromUsage(ctx);
		pruneCooldowns();
		const parsedFrom = persistedState.pendingFrom
			? parseTarget(persistedState.pendingFrom)
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
		if (isSameModelResumeReason(persistedState.pendingReason ?? "")) {
			const now = Date.now();
			if (providerRecoveryAt(sourceModel.provider, now) <= now) {
				clearPendingContinuation();
				const same = ref(sourceModel.provider, sourceModel.id);
				if (
					ctx.model?.provider !== sourceModel.provider ||
					ctx.model?.id !== sourceModel.id
				) {
					automaticModelTarget = same;
					try {
						await pi.setModel(
							ctx.modelRegistry.find(sourceModel.provider, sourceModel.id) ?? {
								provider: sourceModel.provider,
								id: sourceModel.id,
							},
						);
					} finally {
						if (automaticModelTarget === same) automaticModelTarget = undefined;
					}
				}
				await resumeWithExistingContext(ctx);
				return;
			}
			schedulePendingWake(ctx);
			return;
		}

		const pendingReason = persistedState.pendingReason ?? "";
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
			excludeProviders: isAuthPendingReason(pendingReason)
				? new Set<string>([sourceModel.provider])
				: undefined,
		});
		const otherCandidates = candidates.filter(
			(m: any) => ref(m.provider, m.id) !== sourceRef,
		);
		if (otherCandidates.length === 0) {
			if (sourceRecovered) {
				clearPendingContinuation();
				await resumeWithExistingContext(ctx);
				return;
			}
			schedulePendingWake(ctx);
			return;
		}

		const reason = persistedState.pendingReason ?? "account cooldown expired";
		const switched = await activateFallback(
			ctx,
			sourceModel,
			otherCandidates,
			reason,
		);
		if (!switched || !currentPromptSwitch) {
			schedulePendingWake(ctx);
			return;
		}
		clearPendingContinuation();
		await maybeDispatchContinuation(ctx);
	}

	function setPendingContinuation(ctx: any, failedModel: any, reason: string) {
		const from = ref(failedModel.provider, failedModel.id);
		const alreadyPending = hasPendingResume();
		persistedState = {
			...persistedState,
			pendingReason: reason,
			pendingFrom: from,
			pendingContinuationPrompt: undefined,
			pendingSince: persistedState.pendingSince ?? Date.now(),
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
		if (queuedUserInputs.length === 0 || userAbortedChain || !config.enabled) {
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
		const delay = Math.min(availabilityDelay, AUTH_CHANGE_POLL_MS);
		queuedInputWakeTimer = setTimeout(() => {
			queuedInputWakeTimer = undefined;
			runBackground("queued input resume", ctx, () =>
				attemptQueuedInputResume(ctx),
			);
		}, delay);
		queuedInputWakeTimer.unref?.();
	}

	async function attemptQueuedInputResume(ctx: any) {
		if (queuedUserInputs.length === 0 || userAbortedChain || !config.enabled)
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
		if (!ready) {
			scheduleQueuedInputWake(ctx);
			return;
		}
		const inputs = queuedUserInputs.splice(0);
		if (queuedInputWakeTimer) {
			clearTimeout(queuedInputWakeTimer);
			queuedInputWakeTimer = undefined;
		}
		for (let i = 0; i < inputs.length; i++) {
			pi.sendUserMessage(
				queuedInputContent(inputs[i]),
				i === 0 ? undefined : { deliverAs: "followUp" },
			);
		}
		ctx.ui.notify(
			`Provider failover: resumed ${inputs.length} queued message(s) on ${ctx.model.provider}/${ctx.model.id}.`,
			"info",
		);
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
			config = loadConfig();
			debugLogEnabled = config.debugLog;
			configuredFallbacks = config.fallbacks.slice();
			refreshDiscovery(true, ctx);
			startUsageStatusTimer(ctx);
			runBackground("reload account metadata refresh", ctx, async () => {
				await refreshRotationUsage(ctx);
				await syncCodexModelCatalog(ctx, true);
			});
			ctx.ui.notify(
				"pi-multi-account: config reloaded and accounts re-discovered",
				"info",
			);
			return;
		}
		if (command === "rediscover") {
			const changed = refreshDiscovery(true, ctx);
			runBackground("rediscover account metadata refresh", ctx, async () => {
				await refreshRotationUsage(ctx);
				await syncCodexModelCatalog(ctx, true);
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
					"pi-multi-account: usage: /multi-account add <anthropic|codex|cursor|ollama|qwen>",
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
			syncRegisteredSlots(auth);
			if (
				family === "anthropic" ||
				family === "openai-codex" ||
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
			autoContinuesThisPrompt = 0;
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
			exhaustedUntilByProvider.clear();
			currentPromptSwitch = undefined;
			autoContinuesThisPrompt = 0;
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
			const parsed = parseTarget(target);
			if (!parsed) {
				ctx.ui.notify(
					`pi-multi-account: unknown provider "${target}". Rotation: ${rotation.join(", ") || "none"}`,
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
			const candidates = resolveTargets(ctx, target, ctx.model, true).filter(
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
				{ armContinuation: false },
			);
			currentPromptSwitch = undefined;
			if (switched) {
				ctx.ui.notify(
					`pi-multi-account: switched to ${ctx.model.provider}/${ctx.model.id}`,
					"info",
				);
			} else {
				ctx.ui.notify(
					`pi-multi-account: could not switch to "${target}"`,
					"warning",
				);
			}
			return;
		}
		if (command === "next") {
			if (ctx.model) {
				currentPromptSwitch = undefined;
				// Manual rotation is a user override, NOT a rate-limit event: cooling the account
				// we're leaving (the old 5-minute cooldown) drained the pool — after one lap every
				// provider was "cooling" and the round-robin collapsed onto whatever was left. Pass
				// 0 so we only record lastLeftProvider (anti-ping-pong) and keep every account
				// selectable, so repeated /multi-account next truly cycles through them all.
				await switchToFallback(
					ctx,
					ctx.model,
					"manual /multi-account next",
					0,
					{ manual: true },
				);
				currentPromptSwitch = undefined;
			}
			return;
		}
		if (command === "stop") {
			userAbortedChain = true;
			currentPromptSwitch = undefined;
			watchdogAborting = false;
			expectingInjectedContinuation = false;
			clearPendingContinuation();
			clearQueuedInputs();
			endResumeWatch();
			ctx.abort();
			ctx.ui.notify(
				"pi-multi-account: automatic failover/resume stopped for the current task",
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
				`Duplicate slots skipped: ${duplicateSlots.length ? duplicateSlots.map(({ duplicate, primary }) => `${duplicate} = ${primary}`).join(", ") : "none"}`,
				`Registered login slots: ${[...registeredSlots].join(", ") || "(base accounts only)"}`,
				`Cooldowns: ${cooldowns.length ? cooldowns.join(", ") : "none"}`,
				`Next recovery: ${nextRecoveryStatus(ctx)}`,
				`Invalidated (need re-login): ${invalids.length ? invalids.join(", ") : "none"}`,
				`Pending auto-resume: ${hasPendingResume() ? `yes (reason: ${persistedState.pendingReason ?? "unknown"})` : "none"}`,
				`Queued user messages: ${queuedUserInputs.length}`,
				`Resume watchdog: ${resumeInFlight ? `watching${toolInFlight ? " · tool running" : ""}` : "idle"} · auto-recover ${config.autoRecoverStuck ? "ON" : "OFF"}`,
				`Compaction routing: ${config.routeCompactionToHealthyAccount ? "to healthy account" : "off"}${compactionRoutedNote ? ` (last: ${compactionRoutedNote})` : ""}${lastContextOverflowAt ? ` · last overflow ${formatUntil(lastContextOverflowAt)}` : ""}`,
				`Auto-continue breaker: ${isBreakerOpen() ? `OPEN — advisory mode until ${formatUntil(breakerOpenUntil)} (manual switching; /multi-account reset to re-enable)` : `closed${recoveryFailures ? ` (${recoveryFailures}/${BREAKER_FAILURE_THRESHOLD} recent failures)` : ""}`}`,
				`Debug log: ${config.debugLog ? `on → ${DEBUG_LOG_PATH} (/multi-account log to view)` : "off"}`,
				`Config: ${CONFIG_PATH}`,
				`Commands: status | limits [refresh] | models | log [N|on|off] | rediscover | add [anthropic|codex|cursor|ollama|qwen] | remove [anthropic|codex|cursor|ollama|qwen|<provider-id>] | revive <provider|all> | clear | next | switch <provider> | stop | reset | reload | enable | disable`,
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
		const models = preferred.map((m) =>
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

	safeOn("before_provider_request", (event: any, ctx?: any) => {
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

	refreshDiscovery(true);

	// Runtime capability preflight. The RECURRING class of breakage in this extension is the
	// pi↔extension BOUNDARY drifting: a host method the failover depends on gets renamed or removed
	// (e.g. pi.continueAgent() vanished in @earendil-works/pi-coding-agent 0.80.3), and the failure
	// only surfaces weeks later as a cryptic error the instant a real limit hits. Unit tests can
	// never catch this — they mock `pi` and always implement every method. So we probe the REAL host
	// object at every session start: record which capabilities are present (dated, in the debug log
	// for instant diagnosis) and, ONCE per process, tell the user in plain terms if switching is
	// impossible or resume is degraded — instead of letting them discover it under fire.
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
		preflightHostCapabilities(ctx);
		refreshDiscovery(true, ctx);
		// Not installed → silent skip (refreshCursorSlots warns only on the explicit path).
		if (config.includeCursor) await refreshCursorSlots(readAuthFile(), ctx);
		pruneCooldowns();
		// Tight session binding: every session starts as a clean slate. Auto-resume only ever
		// runs *inside the live session that hit the limit* (its timer is armed by
		// setPendingContinuation). A new session — or a reopened one after a crash — must NEVER
		// inherit and silently restart a previous session's paused work, so we drop any leftover
		// pending state and reset all in-memory guards here.
		if (hasPendingResume()) clearPendingContinuation();
		autoContinuesThisPrompt = 0;
		userAbortedChain = false;
		watchdogAborting = false;
		expectingInjectedContinuation = false;
		recoveryFailures = 0;
		breakerOpenUntil = 0;
		responseCooldownHints.clear();
		handledAssistantErrors.clear();
		clearQueuedInputs();
		logEvent("session_start", {
			version: VERSION,
			enabled: config.enabled,
			rotation: rotation.length,
		});
		ctx.ui.notify(
			`pi-multi-account v${VERSION} loaded (${config.enabled ? "enabled" : "disabled"}). ${rotation.length} account(s) in rotation. Config: ${CONFIG_PATH}`,
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
		// already switched away from it using the old plan's stale 100% snapshot.
		await refreshRotationUsage(ctx);
		await syncCodexModelCatalog(ctx);
		await ensureReadyModel(
			ctx,
			"startup preflight: selected account unavailable",
		);
		startUsageStatusTimer(ctx);
	});

	// CRITICAL: when the current session ends — for ANY reason (quit, reload, or replacement
	// by a new/resumed/forked session) — the extension's background activity must end with it.
	// Kill every timer and drop the pending continuation so nothing survives the session.
	safeOn("session_shutdown", async (_event, ctx) => {
		if (pendingWakeTimer) {
			clearTimeout(pendingWakeTimer);
			pendingWakeTimer = undefined;
		}
		clearQueuedInputs();
		clearPendingContinuation();
		clearUsageStatusTimer();
		endResumeWatch();
		watchdogAborting = false;
		expectingInjectedContinuation = false;
		userAbortedChain = false;
		autoContinuesThisPrompt = 0;
		responseCooldownHints.clear();
		handledAssistantErrors.clear();
		ctx?.ui?.setStatus?.("multi-account-quota", undefined);
	});

	// Make compaction survive account exhaustion. When the active account is rate-limited /
	// invalidated and Pi needs to summarize (context overflow or threshold), Pi's default would
	// run the summary on that dead account and hang ("Working…" forever at high context). We
	// generate the summary on a healthy account instead. Strictly fail-safe: returns undefined
	// (Pi's default) whenever it cannot positively do better.
	safeOn("session_before_compact", async (event: any, ctx: any) => {
		if (event?.reason === "overflow") lastContextOverflowAt = Date.now();
		return await runHealthyCompaction(event, ctx);
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
			!config.enabled ||
			(event as any).source === "extension" ||
			!ctx.isIdle()
		)
			return { action: "continue" as const };
		const text =
			typeof (event as any).text === "string" ? (event as any).text : "";
		// Slash commands and shell shortcuts belong to Pi itself. Holding them in the cooldown queue
		// makes /login, /model, /export, and even recovery commands appear completely broken.
		if (/^\s*[/!]/.test(text)) return { action: "continue" as const };
		autoContinuesThisPrompt = 0;
		userAbortedChain = false;
		noteRecoveryProgress(); // a fresh user prompt → clean slate, re-enable auto-continue
		if (hasPendingResume()) clearPendingContinuation();

		if (
			await ensureReadyModel(ctx, "preflight: selected account unavailable")
		) {
			return { action: "continue" as const };
		}

		const delay = nextModelAvailabilityDelayMs(ctx);
		if (delay !== undefined) {
			queueUserInput(ctx, text, (event as any).images);
			return { action: "handled" as const };
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
		ctx.ui.notify(
			`Provider failover: no usable authenticated account exists. Run /login, choose "Use a subscription", then select an account slot.${slotHint}`,
			"error",
		);
		return { action: "handled" as const };
	});

	// Distinguish a genuine new user prompt from our own failover continuation. Only a
	// genuine prompt resets the per-task auto-continue counter and cancels any pending
	// resurrection — this is what stops maxAutoContinuesPerPrompt from resetting every
	// iteration (the bug that let the failover loop run forever).
	safeOn("before_agent_start", async (_event, ctx) => {
		await ensureReadyModel(
			ctx,
			"last-moment preflight: selected account unavailable",
		);
		// Our own injected continuation (recovery fallback) must NOT be mistaken for a genuine
		// new user prompt — otherwise it resets the auto-continue counter every iteration and the
		// recovery loop becomes unbounded. Preserve the chain in that case.
		if (expectingInjectedContinuation) {
			expectingInjectedContinuation = false;
			continuationDispatchedForAgentTurn = true; // this turn IS the continuation
			return;
		}
		// Genuine user input → fresh task: reset the chain and stop any auto-resume.
		autoContinuesThisPrompt = 0;
		userAbortedChain = false;
		continuationDispatchedForAgentTurn = false;
		if (hasPendingResume()) clearPendingContinuation();
	});

	safeOn("agent_start", async (_event, ctx) => {
		noteResumeProgress(); // a resumed turn actually started → it is making progress
		currentPromptSwitch = undefined;
		automaticModelTarget = undefined;
		responseCooldownHints.clear();
		handledAssistantErrors.clear();
		captureDesiredThinking(); // remember the level BEFORE any failover can clamp it
		refreshDiscovery(false, ctx); // also refresh Pi's in-memory AuthStorage
		if (!usageStatusTimer) startUsageStatusTimer(ctx);
		updateUsageStatus(ctx);
	});

	safeOn("model_select", (event, ctx) => {
		const model = (event as any).model;
		if (!model?.provider || !model?.id) return;
		updateUsageStatus(ctx, model.provider);
		runBackground("model_select usage refresh", ctx, () =>
			refreshUsage(ctx, model.provider),
		);
		const selected = ref(model.provider, model.id);
		if (automaticModelTarget === selected) {
			automaticModelTarget = undefined;
			return;
		}
		if ((event as any).source === "restore") return;
		// A manual model change is user control, not a permanent "never fail over" pin.
		// Cancel stale pending work; if the selected model then returns a real limit, normal
		// failover still applies to that completed request.
		currentPromptSwitch = undefined;
		userAbortedChain = false;
		if (hasPendingResume()) clearPendingContinuation();
	});

	safeOn("after_provider_response", (event, ctx) => {
		noteResumeProgress(); // a provider response arrived → the resumed turn is alive
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
		if (!config.enabled) return;
		const status = (event as any).status;
		if (status < 400 && ctx.model) {
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
		if (message?.role !== "assistant") return;
		if (message.stopReason !== "error") {
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
			if (
				isLimitError(errorText) ||
				isAuthError(errorText) ||
				isModelError(errorText) ||
				isTransientError(errorText)
			) {
				await switchToFallback(
					ctx,
					failedModel,
					`external provider out of quota: ${errorText.slice(0, 100)}`,
					config.transientCooldownMs,
					{ scope: "model" },
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
				ctx.ui.notify(
					`Provider failover: ${provider} authorization is invalid. Run /login, choose "Use a subscription", then select ${provider}.`,
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
			userAbortedChain = true;
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
}
