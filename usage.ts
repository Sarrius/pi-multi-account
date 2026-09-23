import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type UsageFamily = "codex" | "anthropic" | "ollama" | "cursor" | "qwen" | "kimi-coding" | "xai" | "zai-coding-cn";

export type UsageWindow = {
	usedPercent: number;
	resetAt: number;
	windowSeconds?: number;
};

export type UsageSnapshot = {
	provider: string;
	family: UsageFamily;
	fetchedAt: number;
	credentialHash?: string;
	plan?: string;
	/**
	 * Which real account this is — the email the provider reports, when it reports one.
	 *
	 * Slot ids (`openai-codex-account-5`) are positions in a config file, not identities. With
	 * several slots the position says nothing about whose quota is being spent, which is the fact
	 * a person actually needs when deciding where to switch.
	 */
	account?: string;
	/**
	 * The provider's OWN verdict on whether this account can be used right now.
	 *
	 * Everything else in this snapshot is arithmetic we do on quota windows — a forecast about
	 * one window, which cannot see session limits, plan limits or an early reset. This field is
	 * not that: it is the account answering the question directly. `undefined` means the response
	 * stated no verdict, and only then is the forecast the best information available.
	 */
	serviceable?: boolean;
	primary?: UsageWindow;
	secondary?: UsageWindow;
	/**
	 * A third, separately-metered bucket a provider exposes BESIDE the two rotation windows.
	 *
	 * Cursor is the reason it exists: one Pro+ subscription bills three independent pools —
	 * included models (`primary`), the third-party "other models" pool (`secondary`) and the
	 * Grok Bot product, which meters on its own weekly reset. Unlike primary/secondary it does
	 * not gate the account: a maxed extra bucket still leaves the other pools able to serve
	 * work, so it is displayed but never treated as a rotation cooldown.
	 */
	tertiary?: UsageWindow;
	credits?: {
		hasCredits?: boolean;
		unlimited?: boolean;
		balance?: string;
	};
};

export type UsageCredential = {
	type?: string;
	access?: string;
	accountId?: string;
	key?: string;
	expires?: number;
};

export class UsageFetchError extends Error {
	readonly status?: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "UsageFetchError";
		this.status = status;
	}
}

function record(value: unknown): Record<string, any> {
	return value && typeof value === "object" ? (value as Record<string, any>) : {};
}

function finiteNumber(value: unknown): number | undefined {
	if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
	const number = typeof value === "number" ? value : Number(value);
	return Number.isFinite(number) ? number : undefined;
}

function percent(value: unknown): number | undefined {
	const number = finiteNumber(value);
	return number === undefined ? undefined : Math.min(100, Math.max(0, number));
}

function epochMs(value: unknown): number | undefined {
	if (typeof value === "string" && value.trim() && !Number.isFinite(Number(value))) {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	const number = finiteNumber(value);
	if (number === undefined || number <= 0) return undefined;
	return number < 10_000_000_000 ? number * 1000 : number;
}

function usageWindow(value: unknown, fallbackWindowSeconds?: number): UsageWindow | undefined {
	const source = record(value);
	const usedPercent = percent(source.used_percent ?? source.utilization);
	const resetAt = epochMs(source.reset_at ?? source.resets_at);
	if (usedPercent === undefined || resetAt === undefined) return undefined;
	const windowSeconds = finiteNumber(source.limit_window_seconds) ?? fallbackWindowSeconds;
	return {
		usedPercent,
		resetAt,
		...(windowSeconds !== undefined ? { windowSeconds } : {}),
	};
}

export function usageFamily(provider: string): UsageFamily | undefined {
	if (provider === "openai-codex" || /^openai-codex-account-\d+$/.test(provider)) return "codex";
	if (provider === "anthropic" || /^anthropic-account-\d+$/.test(provider)) return "anthropic";
	if (provider === "ollama" || /^ollama-account-\d+$/.test(provider)) return "ollama";
	if (provider === "cursor" || /^cursor-account-\d+$/.test(provider)) return "cursor";
	if (provider === "alibaba" || /^alibaba-account-\d+$/.test(provider) || /^qwen/i.test(provider)) return "qwen";
	if (provider === "kimi-coding" || /^kimi-coding-account-\d+$/.test(provider)) return "kimi-coding";
	if (provider === "xai" || /^xai-account-\d+$/.test(provider)) return "xai";
	if (provider === "zai-coding-cn" || /^zai-coding-cn-account-\d+$/.test(provider)) return "zai-coding-cn";
	return undefined;
}

export function parseCodexUsageBody(
	provider: string,
	body: unknown,
	fetchedAt = Date.now(),
	credentialHash?: string,
): UsageSnapshot | undefined {
	const source = record(body);
	const rateLimit = record(source.rate_limit);
	const primary = usageWindow(rateLimit.primary_window, 5 * 60 * 60);
	const secondary = usageWindow(rateLimit.secondary_window, 7 * 24 * 60 * 60);
	if (!primary && !secondary) return undefined;
	const credits = record(source.credits);
	return {
		provider,
		family: "codex",
		fetchedAt,
		credentialHash,
		plan: typeof source.plan_type === "string" ? source.plan_type : undefined,
		account: typeof source.email === "string" && source.email.trim() ? source.email : undefined,
		// `limit_reached` is the negative statement and `allowed` the positive one; either alone
		// is enough. Read both so a response that carries only one of them still answers.
		serviceable:
			typeof rateLimit.limit_reached === "boolean"
				? !rateLimit.limit_reached
				: typeof rateLimit.allowed === "boolean"
					? rateLimit.allowed
					: undefined,
		primary,
		secondary,
		credits: {
			hasCredits: typeof credits.has_credits === "boolean" ? credits.has_credits : undefined,
			unlimited: typeof credits.unlimited === "boolean" ? credits.unlimited : undefined,
			balance:
				typeof credits.balance === "string" || typeof credits.balance === "number"
					? String(credits.balance)
					: undefined,
		},
	};
}

export function parseAnthropicUsageBody(
	provider: string,
	body: unknown,
	fetchedAt = Date.now(),
	credentialHash?: string,
): UsageSnapshot | undefined {
	const source = record(body);
	const primary = usageWindow(source.five_hour, 5 * 60 * 60);
	const secondary = usageWindow(source.seven_day, 7 * 24 * 60 * 60);
	if (!primary && !secondary) return undefined;
	return {
		provider,
		family: "anthropic",
		fetchedAt,
		credentialHash,
		primary,
		secondary,
	};
}

function headerValue(headers: unknown, name: string): string | undefined {
	const getter = (headers as any)?.get;
	if (typeof getter === "function") {
		const value = getter.call(headers, name);
		return typeof value === "string" ? value : undefined;
	}
	for (const [key, value] of Object.entries(record(headers))) {
		if (key.toLowerCase() === name.toLowerCase() && value !== undefined) return String(value);
	}
	return undefined;
}

function headerBoolean(headers: unknown, name: string): boolean | undefined {
	const value = headerValue(headers, name)?.toLowerCase();
	return value === "true" ? true : value === "false" ? false : undefined;
}

function headerWindow(headers: unknown, prefix: "primary" | "secondary"): UsageWindow | undefined {
	const usedPercent = percent(headerValue(headers, `x-codex-${prefix}-used-percent`));
	const resetAt = epochMs(headerValue(headers, `x-codex-${prefix}-reset-at`));
	const windowMinutes = finiteNumber(headerValue(headers, `x-codex-${prefix}-window-minutes`));
	if (usedPercent === undefined || resetAt === undefined) return undefined;
	return {
		usedPercent,
		resetAt,
		...(windowMinutes !== undefined ? { windowSeconds: windowMinutes * 60 } : {}),
	};
}

export function parseCodexUsageHeaders(
	provider: string,
	headers: unknown,
	fetchedAt = Date.now(),
	credentialHash?: string,
): UsageSnapshot | undefined {
	const primary = headerWindow(headers, "primary");
	const secondary = headerWindow(headers, "secondary");
	if (!primary && !secondary) return undefined;
	return {
		provider,
		family: "codex",
		fetchedAt,
		credentialHash,
		plan: headerValue(headers, "x-codex-plan-type"),
		primary,
		secondary,
		credits: {
			hasCredits: headerBoolean(headers, "x-codex-credits-has-credits"),
			unlimited: headerBoolean(headers, "x-codex-credits-unlimited"),
			balance: headerValue(headers, "x-codex-credits-balance"),
		},
	};
}

export function parseOllamaMeBody(
	provider: string,
	body: unknown,
	fetchedAt = Date.now(),
	credentialHash?: string,
): UsageSnapshot {
	const source = record(body);
	const planName =
		typeof source.Plan === "string"
			? source.Plan
			: typeof source.plan === "string"
				? source.plan
				: undefined;
	// Ollama's /api/me carries the plan tier, billing-period end and suspended flag. Current cloud
	// quota windows come from /api/usage, but retain support for windows here in case Ollama folds
	// them into the documented account response later.
	const nullableTime = (value: unknown): string | undefined => {
		if (!value || typeof value !== "object") return undefined;
		const v = value as { Time?: unknown; Valid?: unknown };
		return v.Valid === true && typeof v.Time === "string" ? v.Time : undefined;
	};
	const planParts: string[] = [];
	if (planName) planParts.push(planName);
	if (nullableTime(source.SuspendedAt)) planParts.push("SUSPENDED");
	const periodEnd = nullableTime(source.SubscriptionPeriodEnd);
	if (periodEnd) {
		const d = new Date(periodEnd);
		if (!Number.isNaN(d.getTime()))
			planParts.push(`renews ${d.toISOString().slice(0, 10)}`);
	}
	const plan = planParts.length > 0 ? planParts.join(" · ") : planName;
	const sessionSource =
		source.session ??
		source.Session ??
		source.session_usage ??
		source.SessionUsage;
	const weeklySource =
		source.weekly ??
		source.Weekly ??
		source.weekly_usage ??
		source.WeeklyUsage;
	const primary = usageWindow(sessionSource, 5 * 60 * 60);
	const secondary = usageWindow(weeklySource, 7 * 24 * 60 * 60);
	return {
		provider,
		family: "ollama",
		fetchedAt,
		credentialHash,
		plan,
		primary,
		secondary,
	};
}

const OLLAMA_SESSION_SECONDS = 5 * 60 * 60;
const OLLAMA_WEEK_SECONDS = 7 * 24 * 60 * 60;
const OLLAMA_WEEK_ANCHOR_MS = 4 * 24 * 60 * 60_000; // Monday 00:00 UTC after Unix epoch.

function nextBoundary(now: number, windowMs: number, anchorMs = 0): number {
	return anchorMs + (Math.floor((now - anchorMs) / windowMs) + 1) * windowMs;
}

function ollamaFractionWindow(
	value: unknown,
	fetchedAt: number,
	windowSeconds: number,
	anchorMs = 0,
): UsageWindow | undefined {
	const rawUsage = record(value).usage;
	if (rawUsage === null || rawUsage === undefined || rawUsage === "") return undefined;
	const usage = finiteNumber(rawUsage);
	// Ollama documents this only through its live response today. Be strict about the observed
	// fractional shape so a future percentage-valued response cannot silently turn 50% into 100%.
	if (usage === undefined || usage < 0 || usage > 1) return undefined;
	return {
		usedPercent: usage * 100,
		resetAt: nextBoundary(fetchedAt, windowSeconds * 1000, anchorMs),
		windowSeconds,
	};
}

/** Parse Ollama Cloud's best-effort /api/usage session and weekly quota fractions. */
export function parseOllamaUsageBody(
	provider: string,
	body: unknown,
	fetchedAt = Date.now(),
	credentialHash?: string,
): UsageSnapshot | undefined {
	const limits = record(record(body).limits);
	const primary = ollamaFractionWindow(
		limits.session,
		fetchedAt,
		OLLAMA_SESSION_SECONDS,
	);
	const secondary = ollamaFractionWindow(
		limits.weekly,
		fetchedAt,
		OLLAMA_WEEK_SECONDS,
		OLLAMA_WEEK_ANCHOR_MS,
	);
	if (!primary && !secondary) return undefined;
	return {
		provider,
		family: "ollama",
		fetchedAt,
		credentialHash,
		primary,
		secondary,
	};
}

async function fetchOllamaUsageSnapshot(
	provider: string,
	credential: UsageCredential,
	options: {
		fetchImpl?: typeof fetch;
		timeoutMs?: number;
		credentialHash?: string;
	} = {},
): Promise<UsageSnapshot> {
	if (credential.type !== "api_key" || !credential.key) {
		throw new UsageFetchError(`${provider} has no API key`);
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
	const fetchImpl = options.fetchImpl ?? fetch;
	const headers = {
		Authorization: `Bearer ${credential.key}`,
		Accept: "application/json",
		"Content-Type": "application/json",
	};
	try {
		let response = await fetchImpl("https://ollama.com/api/me", {
			method: "POST",
			headers,
			body: "{}",
			signal: controller.signal,
		});
		if (!response.ok) {
			response = await fetchImpl("http://127.0.0.1:11434/api/me", {
				method: "POST",
				headers,
				body: "{}",
				signal: controller.signal,
			});
		}
		if (!response.ok) {
			throw new UsageFetchError(
				`${provider} Ollama account check returned HTTP ${response.status}`,
				response.status,
			);
		}
		const body = await response.json();
		const account = parseOllamaMeBody(
			provider,
			body,
			Date.now(),
			options.credentialHash,
		);
		// /api/usage is not yet a stable documented contract. Its failure must never erase the
		// useful /api/me account status or make a healthy Ollama key look invalid.
		try {
			const usageResponse = await fetchImpl("https://ollama.com/api/usage", {
				method: "GET",
				headers,
				signal: controller.signal,
			});
			if (usageResponse.ok) {
				const usage = parseOllamaUsageBody(
					provider,
					await usageResponse.json(),
					Date.now(),
					options.credentialHash,
				);
				if (usage) {
					return {
						...account,
						fetchedAt: usage.fetchedAt,
						primary: usage.primary ?? account.primary,
						secondary: usage.secondary ?? account.secondary,
					};
				}
			}
		} catch {
			// Best-effort endpoint: preserve the plan-only account snapshot.
		}
		return account;
	} catch (error) {
		if (error instanceof UsageFetchError) throw error;
		if ((error as any)?.name === "AbortError") {
			throw new UsageFetchError(`${provider} Ollama usage request timed out`);
		}
		throw new UsageFetchError(
			`${provider} Ollama usage request failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		clearTimeout(timer);
	}
}

// Cursor's own dashboard usage lives in the aiserver.v1.DashboardService Connect-RPC service.
// The methods are undocumented; they were read out of Cursor's own clients (the editor and the
// Grok Bot app) and verified live on 2026-09-12 — the same OAuth session token the bridge already
// holds answers both, and the numbers match the dashboard exactly (97% / 35% / weekly 0%).
const CURSOR_DASHBOARD_RPC_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService";

/** The monthly pools: included models (`auto`) and third-party models (`api`). */
export function parseCursorCurrentPeriodUsage(
	provider: string,
	body: unknown,
	fetchedAt = Date.now(),
	credentialHash?: string,
): UsageSnapshot | undefined {
	const source = record(body);
	const planUsage = record(source.planUsage ?? source.plan_usage);
	const cycleStart = epochMs(source.billingCycleStart ?? source.billing_cycle_start);
	const cycleEnd = epochMs(source.billingCycleEnd ?? source.billing_cycle_end);
	const windowSeconds =
		cycleStart !== undefined && cycleEnd !== undefined && cycleEnd > cycleStart
			? Math.round((cycleEnd - cycleStart) / 1000)
			: undefined;
	const periodWindow = (value: unknown): UsageWindow | undefined => {
		const usedPercent = percent(value);
		if (usedPercent === undefined || cycleEnd === undefined) return undefined;
		return {
			usedPercent,
			resetAt: cycleEnd,
			...(windowSeconds !== undefined ? { windowSeconds } : {}),
		};
	};
	const primary = periodWindow(planUsage.autoPercentUsed ?? planUsage.auto_percent_used);
	const secondary = periodWindow(planUsage.apiPercentUsed ?? planUsage.api_percent_used);
	if (!primary && !secondary) return undefined;
	return {
		provider,
		family: "cursor",
		fetchedAt,
		credentialHash,
		primary,
		secondary,
	};
}

/** The Grok Bot weekly bucket, from the same dashboard service. */
export function parseCursorSandUsage(body: unknown): UsageWindow | undefined {
	const source = record(body);
	const usedPercent = percent(source.usagePercent ?? source.usage_percent);
	const resetAt = epochMs(source.nextResetTimestampUtc ?? source.next_reset_timestamp_utc);
	const startAt = epochMs(source.currentPeriodStart ?? source.current_period_start);
	if (usedPercent === undefined || resetAt === undefined) return undefined;
	const windowSeconds =
		startAt !== undefined && resetAt > startAt
			? Math.round((resetAt - startAt) / 1000)
			: undefined;
	return {
		usedPercent,
		resetAt,
		...(windowSeconds !== undefined ? { windowSeconds } : {}),
	};
}

async function fetchCursorUsageSnapshot(
	provider: string,
	credential: UsageCredential,
	options: {
		fetchImpl?: typeof fetch;
		timeoutMs?: number;
		credentialHash?: string;
	} = {},
): Promise<UsageSnapshot> {
	if (credential.type !== "oauth" || !credential.access) {
		throw new UsageFetchError(`${provider} has no OAuth access token`);
	}
	const fetchedAt = Date.now();
	// The plan-only snapshot is the old, always-honest answer. Quota numbers are an enrichment
	// on top of it: a network hiccup must not blank the footer or report a healthy account as
	// "usage unavailable", so every failure except 401 falls back to it.
	const fallback = (): UsageSnapshot => ({
		provider,
		family: "cursor",
		fetchedAt,
		credentialHash: options.credentialHash,
		plan: "subscription",
	});
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
	const fetchImpl = options.fetchImpl ?? fetch;
	const call = async (method: string): Promise<Response> =>
		fetchImpl(`${CURSOR_DASHBOARD_RPC_URL}/${method}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${credential.access}`,
				Accept: "application/json",
				"Content-Type": "application/json",
				"Connect-Protocol-Version": "1",
			},
			body: "{}",
			signal: controller.signal,
		});
	try {
		const [period, sand] = await Promise.allSettled([
			call("GetCurrentPeriodUsage"),
			call("GetSandUsageStatus"),
		]);
		// A 401 is the one failure worth surfacing: the caller refreshes the token and retries.
		for (const result of [period, sand]) {
			if (result.status === "fulfilled" && result.value.status === 401) {
				throw new UsageFetchError(
					`${provider} Cursor usage endpoint returned HTTP 401`,
					401,
				);
			}
		}
		const bodyOf = async (result: PromiseSettledResult<Response>): Promise<unknown> => {
			if (result.status !== "fulfilled" || !result.value.ok) return undefined;
			try {
				return await result.value.json();
			} catch {
				return undefined;
			}
		};
		const periodBody = await bodyOf(period);
		const sandBody = await bodyOf(sand);
		const periodSnapshot =
			periodBody !== undefined
				? parseCursorCurrentPeriodUsage(provider, periodBody, fetchedAt, options.credentialHash)
				: undefined;
		const sandWindow = sandBody !== undefined ? parseCursorSandUsage(sandBody) : undefined;
		if (!periodSnapshot && !sandWindow) return fallback();
		const planName = record(sandBody).cursorPlanName;
		return {
			provider,
			family: "cursor",
			fetchedAt,
			credentialHash: options.credentialHash,
			plan: typeof planName === "string" && planName ? planName : "subscription",
			primary: periodSnapshot?.primary,
			secondary: periodSnapshot?.secondary,
			tertiary: sandWindow,
		};
	} catch (error) {
		if (error instanceof UsageFetchError) throw error;
		return fallback();
	} finally {
		clearTimeout(timer);
	}
}

/** SuperGrok / X Premium OAuth billing probe. Not Cursor Grok and not XAI_API_KEY. */
export const XAI_SUBSCRIPTION_USAGE_URL =
	"https://cli-chat-proxy.grok.com/v1/billing?format=credits";

function decodeJwtPayload(token: string): Record<string, any> | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		let payload = parts[1].replaceAll("-", "+").replaceAll("_", "/");
		payload += "=".repeat((4 - (payload.length % 4)) % 4);
		const parsed = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, any>) : undefined;
	} catch {
		return undefined;
	}
}

function jwtClaimString(payload: Record<string, any>, key: string): string | undefined {
	const value = payload[key];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * xAI billing requires the authenticated user id in `x-userid`.
 * Read it from the access-token JWT (`sub`, then `principal_id`). Never invent it
 * and never treat a generic OAuth `accountId` as an xAI user id.
 */
export function xaiUserIdFromAccessToken(token: string): string | undefined {
	const payload = decodeJwtPayload(token);
	if (!payload) return undefined;
	return jwtClaimString(payload, "sub") ?? jwtClaimString(payload, "principal_id");
}

let cachedXaiClientVersion: string | undefined;

/** Truthful host id. Never impersonate an official Grok CLI version. */
export function xaiHostClientVersion(): string {
	if (cachedXaiClientVersion) return cachedXaiClientVersion;
	try {
		const pkg = JSON.parse(
			readFileSync(join(dirname(fileURLToPath(import.meta.url)), "package.json"), "utf8"),
		) as { name?: unknown; version?: unknown };
		const name =
			typeof pkg.name === "string" && pkg.name.trim() ? pkg.name.trim() : "pi-multi-account";
		const version =
			typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : undefined;
		cachedXaiClientVersion = version ? `${name}/${version}` : name;
	} catch {
		cachedXaiClientVersion = "pi-multi-account";
	}
	return cachedXaiClientVersion;
}

function isGrokBuildProduct(name: unknown): boolean {
	if (typeof name !== "string") return false;
	const normalized = name.trim().toLowerCase().replace(/[_-]/g, "");
	return normalized === "productgrokbuild" || normalized === "grokbuild";
}

function grokBuildUsagePercent(productUsage: unknown): number | undefined {
	if (!Array.isArray(productUsage)) return undefined;
	for (const item of productUsage) {
		const product = record(item);
		if (!isGrokBuildProduct(product.product)) continue;
		const value = percent(product.usagePercent);
		if (value !== undefined) return value;
	}
	return undefined;
}

type XaiUsagePeriod = Pick<UsageWindow, "resetAt" | "windowSeconds">;

function xaiUsagePeriod(value: unknown, fetchedAt: number): XaiUsagePeriod | undefined {
	const source = record(value);
	const start = epochMs(source.start);
	const end = epochMs(source.end);
	if (
		start === undefined ||
		end === undefined ||
		end <= start ||
		fetchedAt < start ||
		fetchedAt >= end
	) {
		return undefined;
	}
	return {
		resetAt: end,
		windowSeconds: Math.round((end - start) / 1000),
	};
}

function xaiUsageSnapshot(
	provider: string,
	usedPercent: number,
	period: XaiUsagePeriod,
	fetchedAt: number,
	credentialHash?: string,
): UsageSnapshot {
	return {
		provider,
		family: "xai",
		fetchedAt,
		credentialHash,
		primary: { usedPercent, ...period },
	};
}

export function parseXaiUsageBody(
	provider: string,
	body: unknown,
	fetchedAt = Date.now(),
	credentialHash?: string,
): UsageSnapshot | undefined {
	const source = record(body);
	if (source.config === undefined || source.config === null) return undefined;
	const config = record(source.config);
	const modernPeriod = xaiUsagePeriod(config.currentPeriod, fetchedAt);
	let modernUsedPercent = percent(config.creditUsagePercent);
	if (modernUsedPercent === undefined) {
		modernUsedPercent = grokBuildUsagePercent(config.productUsage);
	}
	if (modernUsedPercent !== undefined) {
		return modernPeriod
			? xaiUsageSnapshot(
					provider,
					modernUsedPercent,
					modernPeriod,
					fetchedAt,
					credentialHash,
				)
			: undefined;
	}
	// A period alone is not evidence of unused quota. Private endpoint schema
	// drift must never manufacture headroom and clear a real cooldown.
	if (config.currentPeriod !== undefined) return undefined;

	const legacyPeriod = xaiUsagePeriod(
		{ start: config.billingPeriodStart, end: config.billingPeriodEnd },
		fetchedAt,
	);
	if (!legacyPeriod) return undefined;
	const monthlyLimit = finiteNumber(record(config.monthlyLimit).val);
	const used = finiteNumber(record(config.used).val);
	if (monthlyLimit === undefined || monthlyLimit <= 0 || used === undefined || used < 0) return undefined;
	const legacyUsedPercent = percent((used / monthlyLimit) * 100);
	return legacyUsedPercent === undefined
		? undefined
		: xaiUsageSnapshot(
				provider,
				legacyUsedPercent,
				legacyPeriod,
				fetchedAt,
				credentialHash,
			);
}

async function fetchXaiUsageSnapshot(
	provider: string,
	credential: UsageCredential,
	options: {
		fetchImpl?: typeof fetch;
		timeoutMs?: number;
		credentialHash?: string;
	} = {},
): Promise<UsageSnapshot> {
	if (credential.type !== "oauth" || !credential.access) {
		// XAI_API_KEY shares the `xai` provider id. It has no SuperGrok billing session,
		// so do not fall through to a doomed OAuth probe that blanks the footer.
		return {
			provider,
			family: "xai",
			fetchedAt: Date.now(),
			credentialHash: options.credentialHash,
			plan: "api-key · no usage endpoint",
		};
	}
	const userId = xaiUserIdFromAccessToken(credential.access);
	if (!userId) {
		throw new UsageFetchError(`${provider} xAI access token has no user id`);
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
	try {
		const response = await (options.fetchImpl ?? fetch)(XAI_SUBSCRIPTION_USAGE_URL, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${credential.access}`,
				Accept: "application/json",
				"X-XAI-Token-Auth": "xai-grok-cli",
				"x-userid": userId,
				"x-grok-client-version": xaiHostClientVersion(),
				"x-grok-client-mode": "headless",
			},
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new UsageFetchError(
				`${provider} usage endpoint returned HTTP ${response.status}`,
				response.status,
			);
		}
		const snapshot = parseXaiUsageBody(
			provider,
			await response.json(),
			Date.now(),
			options.credentialHash,
		);
		if (!snapshot) {
			throw new UsageFetchError(`${provider} usage endpoint returned no quota window`);
		}
		return snapshot;
	} catch (error) {
		if (error instanceof UsageFetchError) throw error;
		if ((error as any)?.name === "AbortError") {
			throw new UsageFetchError(`${provider} usage request timed out`);
		}
		throw new UsageFetchError(
			`${provider} usage request failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		clearTimeout(timer);
	}
}

export const ZAI_CODING_CN_USAGE_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";

/** Only provider-reported model credit windows; MCP counts are not model quota. */
export function parseZaiCodingCnUsageBody(
	provider: string, body: unknown, fetchedAt = Date.now(), credentialHash?: string,
): UsageSnapshot | undefined {
	const source = record(body);
	if (source.success === false || (source.code !== undefined && ![0, 200, "0", "200"].includes(source.code))) return undefined;
	const data = record(source.data);
	if (!Array.isArray(data.limits)) return undefined;
	const snapshot: UsageSnapshot = { provider, family: "zai-coding-cn", fetchedAt, credentialHash };
	if (typeof data.level === "string" && data.level.trim()) snapshot.plan = data.level.trim();
	for (const value of data.limits) {
		const item = record(value);
		if (item.type !== "CREDIT_LIMIT" && item.type !== "TOKENS_LIMIT") continue;
		const unit = finiteNumber(item.unit);
		const count = finiteNumber(item.number);
		const seconds = unit === 3 && count === 5 ? 5 * 3600 : unit === 6 && count === 1 ? 7 * 86400 : undefined;
		const usedPercent = percent(item.percentage);
		const resetAt = epochMs(item.nextResetTime);
		if (!seconds || usedPercent === undefined || resetAt === undefined || resetAt <= fetchedAt) continue;
		const key = seconds === 5 * 3600 ? "primary" : "secondary";
		// Duplicate windows cannot make a depleted account appear healthier.
		if (!snapshot[key] || usedPercent > snapshot[key]!.usedPercent)
			snapshot[key] = { usedPercent, resetAt, windowSeconds: seconds };
	}
	return snapshot.primary || snapshot.secondary ? snapshot : undefined;
}

async function fetchZaiCodingCnUsageSnapshot(
	provider: string, credential: UsageCredential,
	options: { fetchImpl?: typeof fetch; timeoutMs?: number; credentialHash?: string },
): Promise<UsageSnapshot> {
	if (credential.type !== "api_key" || !credential.key) throw new UsageFetchError(`${provider} has no Coding Plan API key`);
	try {
		const response = await (options.fetchImpl ?? fetch)(ZAI_CODING_CN_USAGE_URL, {
			headers: { Authorization: credential.key, Accept: "application/json" },
			redirect: "error",
			signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
		});
		if (!response.ok) throw new UsageFetchError(`${provider} usage endpoint returned HTTP ${response.status}`, response.status);
		const snapshot = parseZaiCodingCnUsageBody(provider, await response.json(), Date.now(), options.credentialHash);
		if (!snapshot) throw new UsageFetchError(`${provider} usage endpoint returned no current quota window`);
		return snapshot;
	} catch (error) {
		if (error instanceof UsageFetchError) throw error;
		// Never echo provider bodies or fetch errors that could embed a credential.
		throw new UsageFetchError(`${provider} usage request failed or timed out`);
	}
}

export async function fetchUsageSnapshot(
	provider: string,
	credential: UsageCredential,
	options: {
		fetchImpl?: typeof fetch;
		timeoutMs?: number;
		credentialHash?: string;
	} = {},
): Promise<UsageSnapshot> {
	const family = usageFamily(provider);
	if (!family) throw new UsageFetchError(`Usage is not supported for ${provider}`);

	if (family === "ollama") {
		return fetchOllamaUsageSnapshot(provider, credential, options);
	}
	if (family === "cursor") {
		return fetchCursorUsageSnapshot(provider, credential, options);
	}
	if (family === "kimi-coding") {
		// Kimi For Coding is a subscription behind an API key, and it publishes no quota endpoint —
		// /usage, /quota, /me, /subscription and the Moonshot balance path all 404 against
		// api.kimi.com/coding. Falling through to the OAuth branch made every probe throw
		// "has no OAuth access token" for a healthy key, blanking the footer and filling the log.
		return {
			provider,
			family: "kimi-coding",
			fetchedAt: Date.now(),
			credentialHash: options.credentialHash,
			plan: "subscription · no usage endpoint",
		};
	}
	if (family === "qwen") {
		// Qwen/Alibaba exposes no usage/quota endpoint over its API-key plans, so we
		// report the plan honestly instead of attempting (and failing) an OAuth usage
		// fetch. Keeps `limits` from throwing "not supported".
		return {
			provider,
			family: "qwen",
			fetchedAt: Date.now(),
			credentialHash: options.credentialHash,
			plan: "api-key · no usage endpoint",
		};
	}
	if (family === "xai") return fetchXaiUsageSnapshot(provider, credential, options);
	if (family === "zai-coding-cn") return fetchZaiCodingCnUsageSnapshot(provider, credential, options);
	if (credential.type !== "oauth" || !credential.access) {
		throw new UsageFetchError(`${provider} has no OAuth access token`);
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
	const headers: Record<string, string> = {
		Authorization: `Bearer ${credential.access}`,
		Accept: "application/json",
	};
	let url: string;
	if (family === "codex") {
		url = "https://chatgpt.com/backend-api/wham/usage";
		if (credential.accountId) headers["ChatGPT-Account-Id"] = credential.accountId;
	} else {
		url = "https://api.anthropic.com/api/oauth/usage";
		headers["anthropic-beta"] = "oauth-2025-04-20";
	}

	try {
		const response = await (options.fetchImpl ?? fetch)(url, {
			method: "GET",
			headers,
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new UsageFetchError(`${provider} usage endpoint returned HTTP ${response.status}`, response.status);
		}
		const body = await response.json();
		const snapshot =
			family === "codex"
				? parseCodexUsageBody(provider, body, Date.now(), options.credentialHash)
				: parseAnthropicUsageBody(provider, body, Date.now(), options.credentialHash);
		if (!snapshot) throw new UsageFetchError(`${provider} usage endpoint returned no 5h/7d windows`);
		return snapshot;
	} catch (error) {
		if (error instanceof UsageFetchError) throw error;
		if ((error as any)?.name === "AbortError") throw new UsageFetchError(`${provider} usage request timed out`);
		throw new UsageFetchError(`${provider} usage request failed: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		clearTimeout(timer);
	}
}

export function providerUsageLabel(provider: string): string {
	const index = provider.match(/-account-(\d+)$/)?.[1];
	if (provider.startsWith("openai-codex")) return index ? `Codex A${index}` : "Codex";
	if (provider.startsWith("anthropic")) return index ? `Claude A${index}` : "Claude";
	if (provider.startsWith("ollama")) return index ? `Ollama A${index}` : "Ollama";
	if (provider.startsWith("cursor")) return index ? `Cursor A${index}` : "Cursor";
	if (provider.startsWith("kimi-coding")) return index ? `Kimi A${index}` : "Kimi";
	if (provider.startsWith("xai")) return index ? `xAI A${index}` : "xAI";
	if (provider.startsWith("zai-coding-cn")) return index ? `GLM CN A${index}` : "GLM CN";
	if (provider.startsWith("alibaba") || /^qwen/i.test(provider)) return index ? `Qwen A${index}` : "Qwen/Alibaba";
	return provider;
}

export function remainingPercent(window: UsageWindow): number {
	return Math.max(0, Math.round(100 - window.usedPercent));
}

export function formatResetDuration(resetAt: number, now = Date.now()): string {
	const minutes = Math.max(0, Math.ceil((resetAt - now) / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	if (hours < 24) return restMinutes ? `${hours}h${restMinutes}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	const restHours = hours % 24;
	return restHours ? `${days}d${restHours}h` : `${days}d`;
}

/** Keep an email readable in a one-line footer without letting it dominate the line. */
export function shortAccount(account: string | undefined): string | undefined {
	if (!account) return undefined;
	const local = account.includes("@") ? account.slice(0, account.indexOf("@")) : account;
	return local.length > 18 ? `${local.slice(0, 17)}…` : local;
}

/** Where a window sits in the snapshot: the two rotation windows, or an extra metered pool. */
export type UsageWindowPosition = "primary" | "secondary" | "tertiary";

/**
 * Name a quota window by how long it actually is.
 *
 * The label used to be positional — whatever sat in the "primary" slot was called `5h` — but a
 * Codex free plan meters a THIRTY-DAY window there. A number that resets next month then read as
 * one resetting this afternoon, which is a materially different decision about whether to wait.
 */
export function windowLabel(
	window: UsageWindow,
	family: UsageFamily,
	position: UsageWindowPosition,
): string {
	// Cursor's pools are products, not durations: included models, the third-party pool, and the
	// Grok Bot weekly bucket.
	if (family === "cursor") {
		if (position === "primary") return "models";
		if (position === "secondary") return "other";
		return "grok bot";
	}
	if (family === "ollama") return position === "primary" ? "session" : "weekly";
	const seconds = window.windowSeconds;
	if (!seconds) return position === "primary" ? "5h" : position === "secondary" ? "7d" : "usage";
	if (seconds >= 20 * 86_400) return "30d";
	if (seconds >= 6 * 86_400) return "7d";
	if (seconds >= 20 * 3_600) return "24h";
	return `${Math.max(1, Math.round(seconds / 3_600))}h`;
}

/**
 * Preserve display identity across partial updates for the same credential only.
 * Never carry quota windows, credits or serviceability forward under next.fetchedAt:
 * those fields control routing and an old verdict must not acquire a new lease merely
 * because response headers refreshed a different field.
 */
export function mergeUsageSnapshot(
	previous: UsageSnapshot | undefined,
	next: UsageSnapshot,
): UsageSnapshot {
	if (
		!previous ||
		previous.provider !== next.provider ||
		!next.credentialHash ||
		previous.credentialHash !== next.credentialHash
	)
		return next;
	return {
		...next,
		account: next.account ?? previous.account,
		plan: next.plan ?? previous.plan,
	};
}

export function formatUsageCompact(snapshot: UsageSnapshot, now = Date.now()): string {
	const who = shortAccount(snapshot.account);
	const parts = [
		who
			? `${providerUsageLabel(snapshot.provider)} · ${who}`
			: providerUsageLabel(snapshot.provider),
	];
	// The plan is what decides how much quota those percentages are a percentage OF — a free slot
	// at 60% left and a Plus slot at 60% left are not comparable amounts of work.
	if (snapshot.plan && (snapshot.primary || snapshot.secondary || snapshot.tertiary)) parts.push(snapshot.plan);
	// The account's own answer, when it gave one. A percentage is arithmetic on one window and can
	// disagree with reality in both directions — an account reading 0% left was answering
	// `allowed: true`, and showing only the 0% is what makes a working account look dead.
	if (snapshot.serviceable === true) parts.push("ok");
	else if (snapshot.serviceable === false) parts.push("spent");
	if (snapshot.primary) {
		parts.push(
			`${windowLabel(snapshot.primary, snapshot.family, "primary")} ${remainingPercent(snapshot.primary)}% left/${formatResetDuration(snapshot.primary.resetAt, now)}`,
		);
	}
	if (snapshot.secondary) {
		parts.push(
			`${windowLabel(snapshot.secondary, snapshot.family, "secondary")} ${remainingPercent(snapshot.secondary)}% left/${formatResetDuration(snapshot.secondary.resetAt, now)}`,
		);
	}
	if (snapshot.tertiary) {
		parts.push(
			`${windowLabel(snapshot.tertiary, snapshot.family, "tertiary")} ${remainingPercent(snapshot.tertiary)}% left/${formatResetDuration(snapshot.tertiary.resetAt, now)}`,
		);
	}
	if (!snapshot.primary && !snapshot.secondary && !snapshot.tertiary && snapshot.plan) {
		if (snapshot.family === "ollama") {
			parts.push(`${snapshot.plan} · quota unavailable`);
		} else {
			parts.push(snapshot.plan);
		}
	}
	return parts.join(" | ");
}

export function formatUsageDetails(snapshot: UsageSnapshot, now = Date.now()): string {
	const lines = [
		`Limits for ${providerUsageLabel(snapshot.provider)}${snapshot.account ? ` — ${snapshot.account}` : ""}${snapshot.plan ? ` (${snapshot.plan})` : ""}`,
	];
	if (snapshot.serviceable !== undefined)
		lines.push(
			snapshot.serviceable
				? "The account reports it can be used right now."
				: "The account reports it is currently blocked, whatever the percentages below say.",
		);
	if (!snapshot.primary && !snapshot.secondary && !snapshot.tertiary && snapshot.plan) {
		if (snapshot.family === "ollama") {
			lines.push(
				`Plan: ${snapshot.plan}. Session/weekly quota is currently unavailable — check https://ollama.com/settings`,
			);
		} else {
			lines.push(`Status: ${snapshot.plan}`);
		}
	}
	for (const [position, window] of [
		["primary", snapshot.primary],
		["secondary", snapshot.secondary],
		["tertiary", snapshot.tertiary],
	] as const) {
		if (!window) continue;
		const label =
			snapshot.family === "ollama" && position === "primary"
				? "session"
				: windowLabel(window, snapshot.family, position);
		lines.push(
			`${label}: ${remainingPercent(window)}% left (${Math.round(window.usedPercent)}% used), resets in ${formatResetDuration(window.resetAt, now)} at ${new Date(window.resetAt).toLocaleString()}`,
		);
	}
	if (snapshot.credits?.unlimited) lines.push("Credits: unlimited");
	else if (snapshot.credits?.balance !== undefined) lines.push(`Credits: ${snapshot.credits.balance}`);
	lines.push(`Updated ${formatResetDuration(now, snapshot.fetchedAt)} ago`);
	return lines.join("\n");
}

export function usageColor(snapshot: UsageSnapshot): "success" | "warning" | "error" {
	const remaining = [snapshot.primary, snapshot.secondary]
		.filter((window): window is UsageWindow => !!window)
		.map(remainingPercent);
	const lowest = remaining.length > 0 ? Math.min(...remaining) : 100;
	if (lowest <= 10) return "error";
	if (lowest <= 30) return "warning";
	return "success";
}
