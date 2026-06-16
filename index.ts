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
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai";
import {
	loginAnthropic,
	openaiCodexOAuthProvider,
	refreshAnthropicToken,
} from "@earendil-works/pi-ai/oauth";
import {
	fetchUsageSnapshot,
	formatUsageCompact,
	formatUsageDetails,
	parseCodexUsageHeaders,
	usageColor,
	usageFamily,
	UsageFetchError,
	type UsageSnapshot,
	type UsageWindow,
} from "./usage.ts";

type ModelRef = `${string}/${string}`;
type ProviderFamily = "anthropic" | "openai-codex" | "qwen";

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
	maxAccountsPerProvider?: number;
	includeQwen?: boolean;
	qwenProvider?: string;
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
};

type RuntimeConfig = Required<
	Pick<
		ProviderFailoverConfig,
		| "enabled"
		| "autoContinue"
		| "autoDiscover"
		| "maxAccountsPerProvider"
		| "includeQwen"
		| "qwenProvider"
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
const STATE_VERSION = 5;
const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const DEFAULT_PROBE_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_INVALID_COOLDOWN_MS = 365 * 24 * 60 * 60 * 1000; // effectively "until re-login"
const DEFAULT_TRANSIENT_COOLDOWN_MS = 60 * 1000;
const DEFAULT_USAGE_REFRESH_MS = 5 * 60 * 1000;
const DEFAULT_USAGE_STATUS_REFRESH_MS = 60 * 1000;
const MIN_ANTHROPIC_USAGE_REFRESH_MS = 10 * 60 * 1000;
const MAX_MIGRATED_COOLDOWN_MS = 8 * 24 * 60 * 60 * 1000;
const MIN_PENDING_WAKE_MS = 1000;
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
const VERSION = "1.7.0";
const MAX_CONSECUTIVE_AUTH_FAILURES = 3;
const TRANSIENT_AUTH_COOLDOWN_MS = 60 * 1000; // brief skip after a 401 so the next call can refresh

const ANTHROPIC_BASE = "anthropic";
const CODEX_BASE = "openai-codex";
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
	"incorrect api key",
];

const FORCE_REFRESH_AUTH_ERROR_PATTERNS = [
	"authentication token has been invalidated",
	"token has been invalidated",
];

const TERMINAL_REFRESH_ERROR_PATTERNS = [
	"refresh_token_invalidated",
	"invalid_grant",
	"session has ended",
	"please log in again",
	"please sign in again",
	"revoked",
];

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
	"Provider failover activated: the previous provider/account hit a quota or rate limit, and Pi switched to {to}.",
	"Continue the interrupted user task from the last safe point.",
	"Do not repeat destructive actions or duplicate completed work. If state is uncertain, inspect current files/session state first, then continue.",
].join(" ");

const DEFAULT_PROVIDER_ORDER: ProviderFamily[] = [
	"anthropic",
	"openai-codex",
	"qwen",
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

const DEFAULT_CODEX_MODELS = [
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.3-codex-spark",
];
const DEFAULT_ANTHROPIC_MODELS = [
	"claude-opus-4-8",
	"claude-opus-4-5",
	"claude-sonnet-4-6",
	"claude-sonnet-4-5",
	"claude-haiku-4-5",
];

const DEFAULT_CONFIG: ProviderFailoverConfig = {
	enabled: true,
	autoContinue: true,
	autoDiscover: true,
	maxAccountsPerProvider: 10,
	includeQwen: true,
	qwenProvider: DEFAULT_QWEN_PROVIDER,
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

function normalizeConfig(raw: ProviderFailoverConfig): RuntimeConfig {
	const order =
		Array.isArray(raw.providerOrder) && raw.providerOrder.length > 0
			? raw.providerOrder
			: DEFAULT_PROVIDER_ORDER;
	return {
		enabled: raw.enabled ?? true,
		autoContinue: raw.autoContinue ?? true,
		autoDiscover: raw.autoDiscover ?? true,
		maxAccountsPerProvider: Math.max(
			1,
			Math.floor(positiveOr(raw.maxAccountsPerProvider, 10)),
		),
		includeQwen: raw.includeQwen ?? true,
		qwenProvider: raw.qwenProvider?.trim() || DEFAULT_QWEN_PROVIDER,
		providerOrder: order.filter(
			(f): f is ProviderFamily =>
				f === "anthropic" || f === "openai-codex" || f === "qwen",
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
		fallbacks: Array.isArray(raw.fallbacks) ? raw.fallbacks : [],
		openaiCodexAliases: Array.isArray(raw.openaiCodexAliases)
			? raw.openaiCodexAliases
			: [],
		anthropicOAuthAliases: Array.isArray(raw.anthropicOAuthAliases)
			? raw.anthropicOAuthAliases
			: [],
		limitErrorPatterns:
			Array.isArray(raw.limitErrorPatterns) && raw.limitErrorPatterns.length > 0
				? raw.limitErrorPatterns
				: DEFAULT_LIMIT_PATTERNS,
		authErrorPatterns:
			Array.isArray(raw.authErrorPatterns) && raw.authErrorPatterns.length > 0
				? raw.authErrorPatterns
				: DEFAULT_AUTH_ERROR_PATTERNS,
		transientErrorPatterns:
			Array.isArray(raw.transientErrorPatterns) &&
			raw.transientErrorPatterns.length > 0
				? raw.transientErrorPatterns
				: DEFAULT_TRANSIENT_ERROR_PATTERNS,
		modelErrorPatterns:
			Array.isArray(raw.modelErrorPatterns) && raw.modelErrorPatterns.length > 0
				? raw.modelErrorPatterns
				: DEFAULT_MODEL_ERROR_PATTERNS,
		ignoreErrorPatterns:
			Array.isArray(raw.ignoreErrorPatterns) &&
			raw.ignoreErrorPatterns.length > 0
				? raw.ignoreErrorPatterns
				: DEFAULT_IGNORE_PATTERNS,
		continuationPrompt:
			raw.continuationPrompt?.trim() || DEFAULT_CONTINUATION_PROMPT,
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
	mkdirSync(dirname(STATE_PATH), { recursive: true, mode: 0o700 });
	writeFileSync(
		STATE_PATH,
		`${JSON.stringify({ stateVersion: STATE_VERSION, ...state }, null, "\t")}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
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

function classifyProvider(
	id: string,
	qwenProvider: string,
): ProviderFamily | undefined {
	if (id === ANTHROPIC_BASE || /^anthropic-account-\d+$/.test(id))
		return "anthropic";
	if (id === CODEX_BASE || /^openai-codex-account-\d+$/.test(id))
		return "openai-codex";
	if (id === qwenProvider || /^qwen/i.test(id)) return "qwen";
	return undefined;
}

function slotIndex(id: string): number {
	const m = id.match(/-account-(\d+)$/);
	return m ? Number(m[1]) : 1; // base provider counts as slot 1
}

function slotId(family: "anthropic" | "openai-codex", index: number): string {
	const base = family === "anthropic" ? ANTHROPIC_BASE : CODEX_BASE;
	return index <= 1 ? base : `${base}-account-${index}`;
}

function ref(provider: string, modelId: string): ModelRef {
	return `${provider}/${modelId}` as ModelRef;
}

function parseTarget(
	target: string,
): { provider: string; modelId?: string } | undefined {
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
	const canonical = getModel("anthropic", id as any) as any;
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
		await refreshAnthropicToken(credentials.refresh),
	);
}

function registerAnthropicSlot(pi: ExtensionAPI, id: string) {
	if (id === ANTHROPIC_BASE) return; // base provider: oauth + shaping registered in piMultiAccount()
	const models = DEFAULT_ANTHROPIC_MODELS.map((m) => anthropicModelDef(m, id));
	pi.registerProvider(id, {
		name: `Claude Pro/Max (${id})`,
		baseUrl: "https://api.anthropic.com",
		api: "anthropic-messages" as any,
		oauth: {
			name: `Claude Pro/Max (${id})`,
			async login(callbacks: any) {
				return rejectDuplicateLogin(id, await loginAnthropic(callbacks));
			},
			refreshToken: refreshAnthropicCredentials,
			getApiKey: (credentials: any) => credentials.access,
		},
		models: models as any,
	});
}

function codexOAuthOverride(providerId: string, name: string) {
	return {
		name,
		usesCallbackServer: openaiCodexOAuthProvider.usesCallbackServer,
		async login(callbacks: any) {
			return rejectDuplicateLogin(
				providerId,
				await openaiCodexOAuthProvider.login(callbacks),
			);
		},
		refreshToken: openaiCodexOAuthProvider.refreshToken,
		getApiKey: openaiCodexOAuthProvider.getApiKey,
	};
}

function registerCodexSlot(pi: ExtensionAPI, id: string) {
	if (id === CODEX_BASE) return; // base provider is native
	const models = DEFAULT_CODEX_MODELS.map(codexModelDef);
	pi.registerProvider(id, {
		name: `ChatGPT Plus/Pro (Codex ${id})`,
		baseUrl: "https://chatgpt.com/backend-api",
		api: "openai-codex-responses" as any,
		oauth: codexOAuthOverride(id, `ChatGPT Plus/Pro (Codex ${id})`),
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

/** OAuth override enabling Claude Pro/Max login on a provider (base or alias). */
function anthropicOAuthOverride(providerId: string, name: string) {
	return {
		name,
		usesCallbackServer: true,
		async login(callbacks: any) {
			return rejectDuplicateLogin(providerId, await loginAnthropic(callbacks));
		},
		refreshToken: refreshAnthropicCredentials,
		getApiKey: (credentials: any) => credentials.access,
	};
}

// ===========================================================================
// Extension entry point
// ===========================================================================

export default function piMultiAccount(pi: ExtensionAPI) {
	let config = loadConfig();
	let configuredFallbacks = config.fallbacks.slice();
	let persistedState = loadState();

	const exhaustedUntilByProvider = new Map<string, number>(
		Object.entries(persistedState.exhaustedUntilByProvider ?? {}),
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

	// Discovered, authed, deduped provider ids in rotation order.
	let rotation: string[] = [];
	let duplicateSlots: Array<{ duplicate: string; primary: string }> = [];
	// Slot ids registered as targets in the interactive /login provider picker.
	const registeredSlots = new Set<string>();
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
	let expectingSelfContinuation = false; // true between our sendUserMessage and its agent_start
	let lastSentContinuationPrompt = ""; // secondary check to recognise our own re-prompt
	let userAbortedChain = false; // user pressed Esc → stop auto-continuing until a new prompt
	let lastLeftProvider: string | undefined; // account we just failed away from (anti-ping-pong)
	let lastLeftAt = 0;
	let automaticModelTarget: ModelRef | undefined;
	// The thinking level the user intended for this turn. pi.setModel() re-clamps and
	// persists the thinking level on every model switch, so without this it drifts
	// downward across failovers ("thinking level keeps dropping"). We capture it before
	// any switch and re-assert it after each successful switch.
	let desiredThinkingLevel: any;

	function captureDesiredThinking() {
		try {
			const level = (pi as any).getThinkingLevel?.();
			if (level) desiredThinkingLevel = level;
		} catch {
			/* getThinkingLevel may be unavailable on older Pi — degrade gracefully */
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
		// Also keep a long cooldown so in-flight selection logic skips it immediately.
		exhaustedUntilByProvider.set(
			provider,
			Date.now() + config.invalidCooldownMs,
		);
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
					await openaiCodexOAuthProvider.refreshToken(entry as any),
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
		return usageFamily(provider) === "anthropic"
			? Math.max(config.usageRefreshMs, MIN_ANTHROPIC_USAGE_REFRESH_MS)
			: config.usageRefreshMs;
	}

	function updateUsageStatus(ctx: any, provider = ctx?.model?.provider) {
		if (typeof ctx?.ui?.setStatus !== "function") return;
		if (!config.showUsage || !provider || !usageFamily(provider)) {
			ctx.ui.setStatus("multi-account-quota", undefined);
			return;
		}
		const snapshot = cachedUsage(provider);
		if (!snapshot) {
			ctx.ui.setStatus("multi-account-quota", undefined);
			return;
		}
		const text = formatUsageCompact(snapshot);
		const color = usageColor(snapshot);
		ctx.ui.setStatus(
			"multi-account-quota",
			ctx.ui.theme?.fg ? ctx.ui.theme.fg(color, text) : text,
		);
	}

	function storeUsage(ctx: any, snapshot: UsageSnapshot) {
		usageByProvider.set(snapshot.provider, snapshot);
		usageErrors.delete(snapshot.provider);
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

	function clearUsageStatusTimer() {
		if (!usageStatusTimer) return;
		clearInterval(usageStatusTimer);
		usageStatusTimer = undefined;
	}

	function startUsageStatusTimer(ctx: any) {
		clearUsageStatusTimer();
		if (!config.showUsage || typeof ctx?.ui?.setStatus !== "function") {
			updateUsageStatus(ctx);
			return;
		}
		usageStatusTimer = setInterval(() => {
			void refreshUsage(ctx);
		}, config.usageStatusRefreshMs);
		(usageStatusTimer as any).unref?.();
	}

	/** A successful response → this account's auth is fine; clear its 401 streak. */
	function noteAuthSuccess(provider: string, modelId?: string) {
		let changed = authFailures.delete(provider);
		changed = exhaustedUntilByProvider.delete(provider) || changed;
		changed = invalidatedByProvider.delete(provider) || changed;
		if (modelId)
			changed = exhaustedUntilByModel.delete(ref(provider, modelId)) || changed;
		if (changed) persist();
	}

	/**
	 * Handle a 401/auth failure WITHOUT nuking an account that just needs a token refresh.
	 * Non-refreshable (API key): a 401 is genuinely fatal, mark invalid at once.
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
		if (!isRefreshable(provider)) {
			markInvalid(provider, reason);
			return true;
		}
		const entry = readAuthFile()[provider];
		const hash = (entry ? credentialHash(entry) : undefined) ?? "";
		const prev = authFailures.get(provider);
		if (prev && prev.hash === hash) {
			// Same token failed again → Pi's refresh never reached the wire. Do NOT advance toward a
			// permanent kill (this is exactly how an account whose refresh was being dropped got wrongly
			// revoked). Keep it on a transient cooldown so the next call still has a chance to refresh.
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
		for (const [provider, until] of exhaustedUntilByProvider) {
			if (until <= now && !isInvalidated(provider)) {
				exhaustedUntilByProvider.delete(provider);
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
		const until = Date.now() + Math.max(cooldownMs, 1000);
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
			// even if our original estimate hasn't expired yet.
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
			void refreshUsage(ctx, provider, true);
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
			qwen: [],
		};
		for (const [id, entry] of Object.entries(auth)) {
			const family = classifyProvider(id, config.qwenProvider);
			if (!family) continue;
			if (family === "qwen" && !config.includeQwen) continue;
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

	/** Register authed alias slots plus one spare per family for the next interactive /login. */
	function syncRegisteredSlots(auth: Record<string, AuthEntry>) {
		for (const family of ["anthropic", "openai-codex"] as const) {
			const authedIndexes = Object.keys(auth)
				.filter(
					(id) =>
						classifyProvider(id, config.qwenProvider) === family &&
						isEntryUsable(auth[id]),
				)
				.map(slotIndex);
			const wanted = new Set<number>(authedIndexes);
			// Add the next free slot (>=2) so the user can select it from /login.
			let spare = 2;
			while (wanted.has(spare) && spare <= config.maxAccountsPerProvider)
				spare++;
			if (spare <= config.maxAccountsPerProvider) wanted.add(spare);
			for (const index of wanted) {
				if (index <= 1) continue; // base provider is native
				const id = slotId(family, index);
				if (registeredSlots.has(id)) continue;
				if (family === "anthropic") registerAnthropicSlot(pi, id);
				else registerCodexSlot(pi, id);
				registeredSlots.add(id);
			}
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
				exhaustedUntilByModel.forEach((_until, key) => {
					if (key.startsWith(`${provider}/`)) {
						exhaustedUntilByModel.delete(key);
						cooldownsCleared = true;
					}
				});
			}
			// The usage snapshot is tied to the token, so refresh it whenever the credential blob
			// changes (cheap to re-fetch, and never used to gate availability).
			if (previousHash && nextHash !== previousHash) {
				usageByProvider.delete(provider);
				usageErrors.delete(provider);
			}
			if (nextHash) credentialHashes.set(provider, nextHash);
			else credentialHashes.delete(provider);
			if (nextIdentity) credentialIdentities.set(provider, nextIdentity);
			else credentialIdentities.delete(provider);
		}
		if (cooldownsCleared) persist();
		clearReauthedInvalidations(auth);
		syncRegisteredSlots(auth);
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

	function resolveTargets(ctx: any, target: string, currentModel: any) {
		const parsed = parseTarget(target);
		if (!parsed) return [];
		if (parsed.modelId) {
			const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
			return model ? [model] : [];
		}

		const family = classifyProvider(parsed.provider, config.qwenProvider);
		const preferred =
			family === "anthropic"
				? DEFAULT_ANTHROPIC_MODELS
				: family === "openai-codex"
					? DEFAULT_CODEX_MODELS
					: [];
		const modelIds = [
			...(currentModel?.id ? [currentModel.id] : []),
			...preferred,
			...ctx.modelRegistry
				.getAll()
				.filter((model: any) => model.provider === parsed.provider)
				.map((model: any) => model.id),
		];
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
		} = {},
	) {
		const fallbacks = activeFallbacks();
		if (fallbacks.length === 0) return [];

		const now = Date.now();

		type Scored = { model: any; remaining: number; rotIndex: number };
		const scored: Scored[] = [];
		const seen = new Set<string>();

		for (let i = 0; i < fallbacks.length; i++) {
			for (const model of resolveTargets(ctx, fallbacks[i], currentModel)) {
				if (
					!options.includeCurrent &&
					model.provider === currentModel?.provider &&
					model.id === currentModel?.id
				)
					continue;
				if (
					isInvalidated(model.provider) ||
					!providerHasUsableAuth(ctx, model.provider)
				)
					continue;
				const key = `${model.provider}/${model.id}`;
				if (seen.has(key)) continue;
				seen.add(key);

				const providerUntil = exhaustedUntilByProvider.get(model.provider) ?? 0;
				const modelUntil = exhaustedUntilByModel.get(key) ?? 0;
				const remaining = Math.max(
					0,
					Math.max(providerUntil, modelUntil) - now,
				);
				scored.push({ model, remaining, rotIndex: i });
			}
		}
		if (scored.length === 0) return [];

		// Manual `/multi-account next`: walk the rotation forward from the current account,
		// wrapping around, so repeated presses cycle through EVERY account instead of bouncing
		// between the two whose cooldowns happen to be shortest. Accounts that are free RIGHT NOW
		// are offered first (still in rotation order); only if none are free do we cycle through
		// the cooling ones — the user is explicitly overriding the cooldown in that case.
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
			let ordered = [
				...scored.filter((s) => s.remaining === 0).sort(byDistance),
				...scored.filter((s) => s.remaining > 0).sort(byDistance),
			];
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
			.sort((a, b) => a.rotIndex - b.rotIndex);
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
			.sort((a, b) => a.remaining - b.remaining || a.rotIndex - b.rotIndex)
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
				markExhausted(fallback.provider, config.transientCooldownMs);
				failedProviders.add(fallback.provider);
				continue;
			}
			restoreDesiredThinking();
			setLastProbe(fallback.provider);
			const record = { from, to, reason, at: Date.now() };
			currentPromptSwitch =
				options.armContinuation === false ? undefined : record;
			pi.appendEntry("provider-failover", record);
			persist({
				lastSwitches: [record, ...(persistedState.lastSwitches ?? [])].slice(
					0,
					20,
				),
			});
			ctx.ui.notify(
				`Provider failover: ${from} → ${to} (${reason})`,
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

		const candidates = findFallbackModels(ctx, failedModel, {
			availableNowOnly: !options.manual,
			manualRoundRobin: options.manual,
		});
		if (candidates.length === 0) {
			const cooldowns = [...exhaustedUntilByProvider.entries()]
				.filter(([, until]) => until > Date.now())
				.map(([c, until]) => `${c}: ${formatUntil(until)}`)
				.join(", ");
			ctx.ui.notify(
				`Provider failover: no immediately available fallback after ${failedModel.provider}/${failedModel.id}. ${cooldowns ? `Cooldowns: ${cooldowns}` : "All known accounts may be unauthenticated, invalidated, or duplicate slots."}`,
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
			setPendingContinuation(ctx, failedModel, reason);
		}
		return switched;
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
			(exhaustedUntilByProvider.get(model.provider) ?? 0) <= now &&
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

	function continuationPrompt(record: SwitchRecord) {
		return config.continuationPrompt
			.replaceAll("{from}", record.from)
			.replaceAll("{to}", record.to)
			.replaceAll("{reason}", record.reason);
	}

	function dispatchSelfContinuation(ctx: any, prompt: string): boolean {
		if (userAbortedChain || ctx.signal?.aborted) return false;
		lastSentContinuationPrompt = prompt;
		expectingSelfContinuation = true;
		try {
			if (ctx.isIdle()) pi.sendUserMessage(prompt);
			else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			return true;
		} catch (error) {
			expectingSelfContinuation = false;
			lastSentContinuationPrompt = "";
			ctx.ui.notify(
				`Provider failover: could not queue continuation (${String(error)})`,
				"error",
			);
			return false;
		}
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

	function nextPendingWakeDelayMs(): number | undefined {
		const now = Date.now();
		const providers = [
			...new Set(
				activeFallbacks()
					.map((target) => parseTarget(target)?.provider)
					.filter((p): p is string => !!p),
			),
		].filter((provider) => !isInvalidated(provider));
		if (providers.length === 0) return undefined;
		const nextAt = Math.min(
			...providers.map((provider) =>
				Math.max(now, exhaustedUntilByProvider.get(provider) ?? now),
			),
		);
		return Math.max(MIN_PENDING_WAKE_MS, nextAt - now);
	}

	function schedulePendingWake(ctx: any) {
		if (pendingWakeTimer) clearTimeout(pendingWakeTimer);
		pendingWakeTimer = undefined;
		if (
			!persistedState.pendingContinuationPrompt ||
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
				void attemptPendingResume(ctx);
			},
			Math.min(delay, config.pendingPollMs),
		);
	}

	async function attemptPendingResume(ctx: any) {
		if (
			!persistedState.pendingContinuationPrompt ||
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
		const candidates = findFallbackModels(ctx, sourceModel, {
			availableNowOnly: true,
			includeCurrent: true,
		});
		if (candidates.length === 0) {
			schedulePendingWake(ctx);
			return;
		}

		const reason = persistedState.pendingReason ?? "account cooldown expired";
		const switched = await activateFallback(
			ctx,
			sourceModel,
			candidates,
			reason,
		);
		if (!switched || !currentPromptSwitch) {
			schedulePendingWake(ctx);
			return;
		}
		const prompt = continuationPrompt(currentPromptSwitch);
		clearPendingContinuation();
		if (dispatchSelfContinuation(ctx, prompt)) autoContinuesThisPrompt++;
	}

	function setPendingContinuation(ctx: any, failedModel: any, reason: string) {
		const from = ref(failedModel.provider, failedModel.id);
		const placeholder: SwitchRecord = {
			from,
			to: "next-available/account" as ModelRef,
			reason,
			at: Date.now(),
		};
		const alreadyPending = !!persistedState.pendingContinuationPrompt;
		persistedState = {
			...persistedState,
			pendingReason: reason,
			pendingFrom: from,
			pendingContinuationPrompt: continuationPrompt(placeholder),
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
			ctx.ui.notify(
				`Provider failover: all accounts are cooling down. This session will retry automatically in ~${formatDelay(delay)} (and re-checks every ${formatDelay(config.pendingPollMs)}). Esc during a run, a new user message, /multi-account stop, or leaving the session cancels it.`,
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
			...candidates.map((model: any) =>
				Math.max(
					now,
					exhaustedUntilByProvider.get(model.provider) ?? now,
					exhaustedUntilByModel.get(ref(model.provider, model.id)) ?? now,
				),
			),
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
			void attemptQueuedInputResume(ctx);
		}, delay);
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

	async function handleCommand(args: string, ctx: any) {
		const [commandRaw, arg1] = args.trim().split(/\s+/);
		const command = (commandRaw || "status").toLowerCase();

		if (command === "reload") {
			config = loadConfig();
			configuredFallbacks = config.fallbacks.slice();
			refreshDiscovery(true, ctx);
			startUsageStatusTimer(ctx);
			void refreshUsage(ctx);
			ctx.ui.notify(
				"pi-multi-account: config reloaded and accounts re-discovered",
				"info",
			);
			return;
		}
		if (command === "rediscover") {
			const changed = refreshDiscovery(true, ctx);
			ctx.ui.notify(
				`pi-multi-account: rediscovered accounts${changed ? "" : " (no auth.json change)"}. Rotation: ${rotation.join(" → ") || "none"}`,
				"info",
			);
			return;
		}
		if (command === "add") {
			const family =
				arg1 === "codex" || arg1 === "openai" ? "openai-codex" : "anthropic";
			const auth = readAuthFile();
			let n = 2;
			while (auth[slotId(family, n)] && n <= config.maxAccountsPerProvider) n++;
			const id = slotId(family, n);
			syncRegisteredSlots(auth);
			ctx.ui.notify(
				`pi-multi-account: run /login, choose "Use a subscription", select ${id}, then run /multi-account rediscover`,
				"info",
			);
			return;
		}
		if (command === "reset") {
			exhaustedUntilByProvider.clear();
			currentPromptSwitch = undefined;
			autoContinuesThisPrompt = 0;
			userAbortedChain = false;
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
				`${formatUsageDetails(snapshot)}${warning ? `\nRefresh warning: ${warning}` : ""}`,
				warning ? "warning" : "info",
			);
			return;
		}
		if (command === "next") {
			if (ctx.model) {
				currentPromptSwitch = undefined;
				await switchToFallback(
					ctx,
					ctx.model,
					"manual /multi-account next",
					5 * 60 * 1000,
					{ manual: true },
				);
				currentPromptSwitch = undefined;
			}
			return;
		}
		if (command === "stop") {
			userAbortedChain = true;
			currentPromptSwitch = undefined;
			clearPendingContinuation();
			clearQueuedInputs();
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
				`Current limits: ${currentUsage ? formatUsageCompact(currentUsage) : "not loaded"}`,
				`Rotation (${rotation.length}): ${rotation.join(" → ") || "none — log in to an account"}`,
				`Duplicate slots skipped: ${duplicateSlots.length ? duplicateSlots.map(({ duplicate, primary }) => `${duplicate} = ${primary}`).join(", ") : "none"}`,
				`Registered login slots: ${[...registeredSlots].join(", ") || "(base accounts only)"}`,
				`Cooldowns: ${cooldowns.length ? cooldowns.join(", ") : "none"}`,
				`Invalidated (need re-login): ${invalids.length ? invalids.join(", ") : "none"}`,
				`Pending auto-resume: ${persistedState.pendingContinuationPrompt ? `yes (reason: ${persistedState.pendingReason ?? "unknown"})` : "none"}`,
				`Queued user messages: ${queuedUserInputs.length}`,
				`Config: ${CONFIG_PATH}`,
				`Commands: status | limits [refresh] | rediscover | add [anthropic|codex] | next | stop | reset | reload | enable | disable`,
			].join("\n"),
			"info",
		);
	}

	for (const name of ["multi-account", "provider-failover", "failover"]) {
		pi.registerCommand(name, {
			description: "Manage automatic multi-account failover & rotation",
			handler: handleCommand,
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
	pi.on("before_provider_request", (event: any) =>
		shapeAnthropicOAuthPayload(event.payload),
	);

	// ----- lifecycle hooks --------------------------------------------------

	refreshDiscovery(true);

	pi.on("session_start", async (_event, ctx) => {
		refreshDiscovery(true, ctx);
		pruneCooldowns();
		// Tight session binding: every session starts as a clean slate. Auto-resume only ever
		// runs *inside the live session that hit the limit* (its timer is armed by
		// setPendingContinuation). A new session — or a reopened one after a crash — must NEVER
		// inherit and silently restart a previous session's paused work, so we drop any leftover
		// pending state and reset all in-memory guards here.
		if (persistedState.pendingContinuationPrompt) clearPendingContinuation();
		autoContinuesThisPrompt = 0;
		userAbortedChain = false;
		expectingSelfContinuation = false;
		lastSentContinuationPrompt = "";
		responseCooldownHints.clear();
		handledAssistantErrors.clear();
		clearQueuedInputs();
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
		await ensureReadyModel(
			ctx,
			"startup preflight: selected account unavailable",
		);
		await refreshUsage(ctx);
		startUsageStatusTimer(ctx);
	});

	// CRITICAL: when the current session ends — for ANY reason (quit, reload, or replacement
	// by a new/resumed/forked session) — the extension's background activity must end with it.
	// Kill every timer and drop the pending continuation so nothing survives the session.
	pi.on("session_shutdown", async (_event, ctx) => {
		if (pendingWakeTimer) {
			clearTimeout(pendingWakeTimer);
			pendingWakeTimer = undefined;
		}
		clearQueuedInputs();
		clearPendingContinuation();
		clearUsageStatusTimer();
		userAbortedChain = false;
		expectingSelfContinuation = false;
		autoContinuesThisPrompt = 0;
		lastSentContinuationPrompt = "";
		responseCooldownHints.clear();
		handledAssistantErrors.clear();
		ctx?.ui?.setStatus?.("multi-account-quota", undefined);
	});

	pi.on("input", async (event, ctx) => {
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
		lastSentContinuationPrompt = "";
		if (persistedState.pendingContinuationPrompt) clearPendingContinuation();

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
	pi.on("before_agent_start", async (event, ctx) => {
		await ensureReadyModel(
			ctx,
			"last-moment preflight: selected account unavailable",
		);
		const prompt =
			typeof (event as any).prompt === "string" ? (event as any).prompt : "";
		const isSelfContinuation =
			expectingSelfContinuation ||
			(!!lastSentContinuationPrompt &&
				prompt.trim() === lastSentContinuationPrompt.trim());
		if (isSelfContinuation) return;
		// Genuine user input → fresh task: reset the chain and stop any auto-resume so the
		// user is fully back in control.
		autoContinuesThisPrompt = 0;
		userAbortedChain = false;
		lastSentContinuationPrompt = "";
		if (persistedState.pendingContinuationPrompt) clearPendingContinuation();
	});

	pi.on("agent_start", async (_event, ctx) => {
		currentPromptSwitch = undefined;
		automaticModelTarget = undefined;
		expectingSelfContinuation = false; // consume the flag once the run has started
		responseCooldownHints.clear();
		handledAssistantErrors.clear();
		captureDesiredThinking(); // remember the level BEFORE any failover can clamp it
		refreshDiscovery(false, ctx); // also refresh Pi's in-memory AuthStorage
		if (!usageStatusTimer) startUsageStatusTimer(ctx);
		updateUsageStatus(ctx);
	});

	pi.on("model_select", (event, ctx) => {
		const model = (event as any).model;
		if (!model?.provider || !model?.id) return;
		updateUsageStatus(ctx, model.provider);
		void refreshUsage(ctx, model.provider);
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
		if (persistedState.pendingContinuationPrompt) clearPendingContinuation();
	});

	pi.on("after_provider_response", (event, ctx) => {
		if (ctx.model && usageFamily(ctx.model.provider)) {
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
			responseCooldownHints.delete(ctx.model.provider);
			return;
		}
		if ((status === 429 || status === 402 || status === 403) && ctx.model) {
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

	pi.on("message_end", async (event, ctx) => {
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
		const errorKey = `${provider}/${modelId}:${message.timestamp ?? "unknown"}:${errorText}`;
		if (handledAssistantErrors.has(errorKey)) return;
		handledAssistantErrors.add(errorKey);
		const failedModel = ctx.modelRegistry.find(provider, modelId) ?? {
			provider,
			id: modelId,
		};

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
			const cooldownMs = killed
				? config.invalidCooldownMs
				: TRANSIENT_AUTH_COOLDOWN_MS;
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
			const hintedCooldowns = [
				responseCooldownHints.get(provider),
				cooldownFromErrorText(errorText),
			].filter(
				(value): value is number => typeof value === "number" && value > 0,
			);
			const cooldownMs =
				hintedCooldowns.length > 0
					? Math.max(...hintedCooldowns)
					: config.cooldownMs;
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
			await switchToFallback(
				ctx,
				failedModel,
				`temporary provider failure: ${errorText.slice(0, 120)}`,
				config.transientCooldownMs,
			);
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		// Respect the user: if they pressed Esc, the last assistant message is "aborted".
		if (
			lastAssistantStopReason((event as any).messages ?? []) === "aborted" ||
			ctx.signal?.aborted
		) {
			userAbortedChain = true;
			clearPendingContinuation();
			currentPromptSwitch = undefined;
			return;
		}
		if (!config.enabled || !config.autoContinue || userAbortedChain) return;
		if (
			currentPromptSwitch &&
			autoContinuesThisPrompt < config.maxAutoContinuesPerPrompt
		) {
			const prompt = continuationPrompt(currentPromptSwitch);
			if (dispatchSelfContinuation(ctx, prompt)) autoContinuesThisPrompt++;
		}
	});
}
