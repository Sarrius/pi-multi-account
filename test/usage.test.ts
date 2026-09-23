import assert from "node:assert/strict";
import test from "node:test";
import {
	fetchUsageSnapshot,
	formatUsageCompact,
	parseAnthropicUsageBody,
	parseCodexUsageBody,
	parseXaiUsageBody,
	parseZaiCodingCnUsageBody,
	ZAI_CODING_CN_USAGE_URL,
	usageFamily,
	xaiHostClientVersion,
	xaiUserIdFromAccessToken,
	XAI_SUBSCRIPTION_USAGE_URL,
	parseCodexUsageHeaders,
	mergeUsageSnapshot,
	parseCursorCurrentPeriodUsage,
	parseCursorSandUsage,
	parseOllamaMeBody,
	parseOllamaUsageBody,
	UsageFetchError,
} from "../usage.ts";

const NOW = Date.UTC(2026, 5, 13, 12, 0, 0);

test("parses Codex 5h and weekly usage response", () => {
	const snapshot = parseCodexUsageBody(
		"openai-codex-account-2",
		{
			plan_type: "plus",
			rate_limit: {
				primary_window: {
					used_percent: 100,
					limit_window_seconds: 18_000,
					reset_at: NOW / 1000 + 3600,
				},
				secondary_window: {
					used_percent: 58,
					limit_window_seconds: 604_800,
					reset_at: NOW / 1000 + 2 * 86_400,
				},
			},
			credits: { has_credits: false, unlimited: false, balance: "0" },
		},
		NOW,
		"credential",
	);
	assert.ok(snapshot);
	assert.equal(snapshot.plan, "plus");
	assert.equal(snapshot.primary?.usedPercent, 100);
	assert.equal(snapshot.secondary?.usedPercent, 58);
	assert.equal(
		formatUsageCompact(snapshot, NOW),
		"Codex A2 | plus | 5h 0% left/1h | 7d 42% left/2d",
	);
});

test("Ollama /api/me surfaces plan tier, renewal date, and suspended status", () => {
	// /api/me carries account metadata while /api/usage carries the quota windows. Keep this useful
	// fallback when the best-effort quota request is unavailable.
	const active = parseOllamaMeBody(
		"ollama",
		{
			Plan: "pro",
			SubscriptionPeriodEnd: { Time: "2026-07-16T06:31:51Z", Valid: true },
			SuspendedAt: { Time: null, Valid: false },
		},
		NOW,
		"cred",
	);
	assert.equal(active.plan, "pro · renews 2026-07-16");
	assert.equal(
		formatUsageCompact(active, NOW),
		"Ollama | pro · renews 2026-07-16 · quota unavailable",
	);

	const suspended = parseOllamaMeBody(
		"ollama",
		{ Plan: "pro", SuspendedAt: { Time: "2026-07-01T00:00:00Z", Valid: true } },
		NOW,
		"cred",
	);
	assert.ok(
		suspended.plan?.includes("SUSPENDED"),
		`suspended plan should flag it, got ${suspended.plan}`,
	);
});

test("parses Ollama session and weekly quota fractions with forecast reset boundaries", () => {
	const snapshot = parseOllamaUsageBody(
		"ollama-account-2",
		{
			limits: {
				session: { usage: 0.046, models: [{ name: "glm-5", request_count: 3 }] },
				weekly: { usage: 0.051, models: [] },
			},
		},
		NOW,
		"cred",
	);
	assert.ok(snapshot);
	assert.equal(snapshot.primary?.usedPercent, 4.6);
	assert.equal(snapshot.primary?.windowSeconds, 18_000);
	// Session epochs are exact 18,000-second multiples from Unix epoch, so their UTC wall-clock
	// hour moves across days rather than always landing on 00/05/10/15/20.
	assert.equal(snapshot.primary?.resetAt, Date.UTC(2026, 5, 13, 17, 0, 0));
	assert.equal(snapshot.secondary?.usedPercent, 5.1);
	assert.equal(snapshot.secondary?.resetAt, Date.UTC(2026, 5, 15, 0, 0, 0));
	assert.equal(
		formatUsageCompact(snapshot, NOW),
		"Ollama A2 | session 95% left/5h | weekly 95% left/1d12h",
	);
});

test("Ollama null or non-fraction quota values do not invent windows", () => {
	assert.equal(
		parseOllamaUsageBody("ollama", {
			limits: { session: { usage: null }, weekly: { usage: 52 } },
		}),
		undefined,
	);
});

test("Ollama combines /api/me metadata with best-effort /api/usage windows", async () => {
	const calls: Array<{ url: string; method: string }> = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, method: init?.method ?? "GET" });
		if (url.endsWith("/api/me")) {
			return new Response(JSON.stringify({ Plan: "pro" }), { status: 200 });
		}
		return new Response(
			JSON.stringify({ limits: { session: { usage: 0.25 }, weekly: { usage: 0.5 } } }),
			{ status: 200 },
		);
	}) as typeof fetch;

	const snapshot = await fetchUsageSnapshot(
		"ollama",
		{ type: "api_key", key: "ollama-secret" },
		{ fetchImpl, credentialHash: "safe-hash" },
	);
	assert.deepEqual(calls, [
		{ url: "https://ollama.com/api/me", method: "POST" },
		{ url: "https://ollama.com/api/usage", method: "GET" },
	]);
	assert.equal(snapshot.plan, "pro");
	assert.equal(snapshot.primary?.usedPercent, 25);
	assert.equal(snapshot.secondary?.usedPercent, 50);
	assert.equal(snapshot.credentialHash, "safe-hash");
	assert.ok(!JSON.stringify(snapshot).includes("ollama-secret"));
});

test("Ollama keeps the plan snapshot when the best-effort usage endpoint fails", async () => {
	const fetchImpl = (async (input: string | URL | Request) => {
		return String(input).endsWith("/api/me")
			? new Response(JSON.stringify({ Plan: "pro" }), { status: 200 })
			: new Response("unavailable", { status: 503 });
	}) as typeof fetch;
	const snapshot = await fetchUsageSnapshot(
		"ollama",
		{ type: "api_key", key: "ollama-secret" },
		{ fetchImpl },
	);
	assert.equal(snapshot.plan, "pro");
	assert.equal(snapshot.primary, undefined);
	assert.match(formatUsageCompact(snapshot), /quota unavailable/);
});

test("parses case-insensitive Codex response headers", () => {
	const snapshot = parseCodexUsageHeaders(
		"openai-codex-account-4",
		{
			"X-Codex-Primary-Used-Percent": "73",
			"x-codex-primary-window-minutes": "300",
			"X-Codex-Primary-Reset-At": String(NOW / 1000 + 1800),
			"x-codex-secondary-used-percent": "9",
			"X-Codex-Secondary-Window-Minutes": "10080",
			"x-codex-secondary-reset-at": String(NOW / 1000 + 86_400),
		},
		NOW,
	);
	assert.ok(snapshot);
	assert.equal(snapshot.primary?.windowSeconds, 18_000);
	assert.equal(snapshot.secondary?.windowSeconds, 604_800);
	assert.equal(formatUsageCompact(snapshot, NOW), "Codex A4 | 5h 27% left/30m | 7d 91% left/1d");
});

test("preserves Codex identity metadata when headers refresh quota windows", () => {
	const body = parseCodexUsageBody(
		"openai-codex-account-2",
		{
			plan_type: "pro",
			email: "second@example.com",
			rate_limit: {
				primary_window: { used_percent: 10, reset_at: NOW / 1000 + 3600 },
				secondary_window: { used_percent: 20, reset_at: NOW / 1000 + 86_400 },
			},
			credits: { has_credits: false, unlimited: false, balance: "0" },
		},
		NOW,
		"same-credential",
	);
	const headers = parseCodexUsageHeaders(
		"openai-codex-account-2",
		{
			"x-codex-primary-used-percent": "25",
			"x-codex-primary-reset-at": String(NOW / 1000 + 7200),
		},
		NOW + 1_000,
		"same-credential",
	);
	assert.ok(body);
	assert.ok(headers);
	const merged = mergeUsageSnapshot(body, headers);
	assert.equal(merged.account, "second@example.com");
	assert.equal(merged.plan, "pro");
	assert.equal(merged.primary?.usedPercent, 25);
	assert.equal(merged.secondary, undefined);
	assert.equal(merged.credits?.hasCredits, undefined);
	assert.equal(merged.credits?.unlimited, undefined);
	assert.equal(merged.credits?.balance, undefined);
	assert.deepEqual(mergeUsageSnapshot(undefined, headers), headers);
});

test("does not renew old credit evidence when headers omit it", () => {
	const previous = parseCodexUsageBody(
		"openai-codex-account-2",
		{
			plan_type: "pro",
			rate_limit: {
				primary_window: { used_percent: 10, reset_at: NOW / 1000 + 3600 },
			},
			credits: { has_credits: true, unlimited: true, balance: "0" },
		},
		NOW,
		"same-credential",
	);
	const next = parseCodexUsageHeaders(
		"openai-codex-account-2",
		{
			"x-codex-primary-used-percent": "25",
			"x-codex-primary-reset-at": String(NOW / 1000 + 7200),
		},
		NOW + 1_000,
		"same-credential",
	);
	assert.ok(previous);
	assert.ok(next);
	const merged = mergeUsageSnapshot(previous, next);
	assert.equal(merged.credits?.hasCredits, undefined);
	assert.equal(merged.credits?.unlimited, undefined);
	assert.equal(merged.credits?.balance, undefined);
});

test("does not carry identity across credential changes", () => {
	const previous = parseCodexUsageBody(
		"openai-codex-account-2",
		{
			plan_type: "pro",
			email: "old@example.com",
			rate_limit: {
				primary_window: { used_percent: 10, reset_at: NOW / 1000 + 3600 },
			},
		},
		NOW,
		"old-credential",
	);
	const next = parseCodexUsageHeaders(
		"openai-codex-account-2",
		{
			"x-codex-primary-used-percent": "25",
			"x-codex-primary-reset-at": String(NOW / 1000 + 7200),
		},
		NOW + 1_000,
		"new-credential",
	);
	assert.ok(previous);
	assert.ok(next);
	assert.equal(mergeUsageSnapshot(previous, next).account, undefined);
});

test("partial usage never refreshes stale serviceability or missing quota windows", () => {
	const provider = "openai-codex-account-2";
	for (const allowed of [true, false]) {
		const old = parseCodexUsageBody(provider, {
			email: "fixture@example.com", plan_type: "pro",
			rate_limit: { allowed, primary_window: { used_percent: 10, reset_at: NOW / 1000 + 3600 },
				secondary_window: { used_percent: 100, reset_at: NOW / 1000 + 86400 } },
		}, NOW - 3600000, "same");
		const next = parseCodexUsageHeaders(provider, {
			"x-codex-primary-used-percent": "100",
			"x-codex-primary-reset-at": String(NOW / 1000 + 3600),
			"x-codex-credits-has-credits": "malformed",
		}, NOW, "same")!;
		const merged = mergeUsageSnapshot(old, next);
		assert.equal(merged.serviceable, undefined, "old verdict is not fresh provider evidence");
		assert.equal(merged.secondary, undefined);
		assert.equal(merged.primary?.usedPercent, 100);
		assert.equal(merged.credits?.hasCredits, undefined);
		assert.equal(merged.account, "fixture@example.com");
		assert.equal(merged.fetchedAt, NOW);
		assert.equal(mergeUsageSnapshot(old, { ...next, credentialHash: undefined }).account, undefined);
	}
});

test("parses Anthropic OAuth usage windows", () => {
	const snapshot = parseAnthropicUsageBody(
		"anthropic-account-2",
		{
			five_hour: { utilization: 84, resets_at: new Date(NOW + 90 * 60_000).toISOString() },
			seven_day: { utilization: 12, resets_at: new Date(NOW + 3 * 86_400_000).toISOString() },
		},
		NOW,
	);
	assert.ok(snapshot);
	assert.equal(snapshot.primary?.usedPercent, 84);
	assert.equal(formatUsageCompact(snapshot, NOW), "Claude A2 | 5h 16% left/1h30m | 7d 88% left/3d");
});

test("Codex usage fetch sends the account id and never exposes the token in the snapshot", async () => {
	let seenHeaders: Headers | undefined;
	const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
		seenHeaders = new Headers(init?.headers);
		return new Response(
			JSON.stringify({
				plan_type: "plus",
				rate_limit: {
					primary_window: { used_percent: 10, reset_at: NOW / 1000 + 3600 },
					secondary_window: { used_percent: 20, reset_at: NOW / 1000 + 86_400 },
				},
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}) as typeof fetch;

	const snapshot = await fetchUsageSnapshot(
		"openai-codex-account-2",
		{ type: "oauth", access: "secret-access-token", accountId: "account-id" },
		{ fetchImpl, credentialHash: "safe-hash" },
	);
	assert.equal(seenHeaders?.get("ChatGPT-Account-Id"), "account-id");
	assert.equal(seenHeaders?.get("Authorization"), "Bearer secret-access-token");
	assert.equal(snapshot.credentialHash, "safe-hash");
	assert.ok(!JSON.stringify(snapshot).includes("secret-access-token"));
});

test("the provider's own allowed/limit_reached verdict is carried, not just the percentages", () => {
	// The Codex usage response answers the question directly — `rate_limit.allowed` /
	// `limit_reached` — and that answer was being dropped on the floor in favour of deriving an
	// opinion from `used_percent`. On a real machine two accounts answered `allowed: true` while
	// reading 98%, and the extension kept them benched: the account said "yes", the percentage
	// said "nearly out", and only the percentage was ever read.
	const free = parseCodexUsageBody("openai-codex-account-2", {
		plan_type: "free",
		rate_limit: {
			allowed: true,
			limit_reached: false,
			primary_window: {
				used_percent: 98,
				limit_window_seconds: 2592000,
				reset_at: Math.floor(Date.now() / 1000) + 2_387_570,
			},
			secondary_window: null,
		},
	});
	assert.equal(free?.serviceable, true, "an account the provider allows must be marked usable");

	const spent = parseCodexUsageBody("openai-codex-account-3", {
		plan_type: "free",
		rate_limit: {
			allowed: false,
			limit_reached: true,
			primary_window: {
				used_percent: 100,
				limit_window_seconds: 2592000,
				reset_at: Math.floor(Date.now() / 1000) + 2_397_006,
			},
			secondary_window: null,
		},
	});
	assert.equal(spent?.serviceable, false, "and one it refuses must be marked blocked");

	const silent = parseCodexUsageBody("openai-codex", {
		plan_type: "plus",
		rate_limit: {
			primary_window: {
				used_percent: 50,
				limit_window_seconds: 18000,
				reset_at: Math.floor(Date.now() / 1000) + 3600,
			},
		},
	});
	assert.equal(
		silent?.serviceable,
		undefined,
		"a response that states no verdict must not have one invented for it",
	);
});

test("the account's identity travels with its usage, and shows in the footer", () => {
	// With seven Codex slots called A2…A7, the footer named the SLOT and nothing else, so there
	// was no way to tell which real account was in use — the one piece of information needed to
	// know whose quota is burning. The usage response carries the email; it was thrown away.
	const snapshot = parseCodexUsageBody("openai-codex-account-2", {
		plan_type: "free",
		email: "alice@example.com",
		rate_limit: {
			allowed: true,
			limit_reached: false,
			primary_window: {
				used_percent: 40,
				limit_window_seconds: 18000,
				reset_at: Math.floor(Date.now() / 1000) + 3600,
			},
		},
	});
	assert.equal(snapshot?.account, "alice@example.com");

	const footer = formatUsageCompact(snapshot!, Date.now());
	assert.match(footer, /Codex A2/, "the slot is still named");
	assert.match(footer, /alice/, `and the account local-part with it; footer: ${footer}`);
	assert.match(footer, /free/, `along with the plan; footer: ${footer}`);
	assert.match(footer, /60% left/, `without losing the quota; footer: ${footer}`);
});

test("a footer for an account with no email is unchanged", () => {
	// Nothing may become noisier for providers that expose no identity.
	const snapshot = parseCodexUsageBody("openai-codex", {
		plan_type: "plus",
		rate_limit: {
			primary_window: {
				used_percent: 10,
				limit_window_seconds: 18000,
				reset_at: Math.floor(Date.now() / 1000) + 3600,
			},
		},
	});
	assert.equal(snapshot?.account, undefined);
	assert.doesNotMatch(formatUsageCompact(snapshot!, Date.now()), /·\s*\|/);
});

test("a Kimi Coding slot reports itself instead of throwing", async () => {
	// kimi-coding became a managed family, but nothing taught the usage layer about it — so every
	// probe fell through to the OAuth branch and threw "has no OAuth access token" for a perfectly
	// healthy API key. That turns the footer blank and fills the log with failures for an account
	// that is working. Kimi exposes no quota endpoint at all (every documented path 404s), so the
	// honest answer is the plan, not an invented number.
	const snapshot = await fetchUsageSnapshot("kimi-coding", {
		type: "api_key",
		key: "sk-kimi-test",
	});
	assert.equal(snapshot.family, "kimi-coding");
	assert.equal(snapshot.primary, undefined, "no window may be invented");
	assert.match(
		snapshot.plan ?? "",
		/subscription|no usage endpoint/i,
		`the plan line must say what is known; got: ${snapshot.plan}`,
	);
	assert.doesNotMatch(
		JSON.stringify(snapshot),
		/sk-kimi-test/,
		"and the key must never travel in the snapshot",
	);
});

test("a window is labelled by its real length, and the provider's verdict beats the percentage", () => {
	// Two ways the footer misled at once. A Codex free plan meters a THIRTY-DAY window, and it was
	// labelled "5h" because that is the slot the field sits in — so a number that resets next month
	// read as one that resets this afternoon. And the account this was shown for was answering
	// `allowed: true`: it could serve work while the footer said `0% left`, which is exactly the
	// reading that convinces someone their working accounts are being ignored.
	const now = Date.now();
	const snapshot = parseCodexUsageBody(
		"openai-codex-account-6",
		{
			plan_type: "free",
			email: "bob@example.com",
			rate_limit: {
				allowed: true,
				limit_reached: false,
				primary_window: {
					used_percent: 100,
					limit_window_seconds: 2592000,
					reset_at: Math.floor(now / 1000) + 27 * 86400,
				},
				secondary_window: null,
			},
		},
		now,
	);
	const footer = formatUsageCompact(snapshot!, now);
	assert.doesNotMatch(footer, /5h/, `a 30-day window must not be labelled 5h; footer: ${footer}`);
	assert.match(footer, /30d/, `it must carry its real length; footer: ${footer}`);
	assert.match(
		footer,
		/ok|usable|✓/i,
		`and an account the provider allows must not read as spent; footer: ${footer}`,
	);
});

test("a blocked account still reads as blocked", () => {
	const now = Date.now();
	const snapshot = parseCodexUsageBody(
		"openai-codex-account-3",
		{
			plan_type: "free",
			rate_limit: {
				allowed: false,
				limit_reached: true,
				primary_window: {
					used_percent: 100,
					limit_window_seconds: 2592000,
					reset_at: Math.floor(now / 1000) + 27 * 86400,
				},
			},
		},
		now,
	);
	assert.match(
		formatUsageCompact(snapshot!, now),
		/spent|blocked|✗/i,
		"the negative verdict must be just as visible",
	);
});

test("Cursor's three Pro+ pools arrive as three labelled windows and never leak the token", async () => {
	// Verified live 2026-09-12: aiserver.v1.DashboardService answers both methods for the same
	// OAuth session token the bridge already holds, and the numbers match Cursor's dashboard
	// exactly (included models 97%, other models 35%, Grok Bot weekly 0%). Before this, the
	// extension honestly reported "subscription" because no quota API was known.
	const calls: Array<{ url: string; authorization: string | null; connect: string | null }> = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		const url = String(input);
		calls.push({
			url,
			authorization: headers.get("authorization"),
			connect: headers.get("connect-protocol-version"),
		});
		return url.endsWith("/GetCurrentPeriodUsage")
			? new Response(
					JSON.stringify({
						billingCycleStart: "1787120231000",
						billingCycleEnd: "1789798631000",
						planUsage: { autoPercentUsed: 97.32, apiPercentUsed: 35.18 },
					}),
					{ status: 200 },
				)
			: new Response(
					JSON.stringify({
						currentPeriodStart: "2026-09-09T21:00:13.847Z",
						nextResetTimestampUtc: "2026-09-16T21:00:13.847Z",
						usagePercent: 0,
						cursorPlanName: "Pro",
					}),
					{ status: 200 },
				);
	}) as typeof fetch;

	const snapshot = await fetchUsageSnapshot(
		"cursor",
		{ type: "oauth", access: "secret-cursor-token" },
		{ fetchImpl, credentialHash: "safe-hash" },
	);
	assert.deepEqual(
		calls.map((call) => call.url),
		[
			"https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
			"https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus",
		],
	);
	assert.equal(calls[0]?.authorization, "Bearer secret-cursor-token");
	assert.equal(calls[0]?.connect, "1");
	assert.equal(snapshot.plan, "Pro");
	assert.equal(snapshot.credentialHash, "safe-hash");
	assert.equal(snapshot.primary?.usedPercent, 97.32, "included models are the primary pool");
	assert.equal(snapshot.secondary?.usedPercent, 35.18, "third-party models are the secondary pool");
	assert.equal(snapshot.secondary?.resetAt, 1_789_798_631_000);
	assert.equal(snapshot.tertiary?.usedPercent, 0, "Grok Bot is the extra weekly pool");
	assert.equal(snapshot.tertiary?.resetAt, Date.parse("2026-09-16T21:00:13.847Z"));
	const footer = formatUsageCompact(snapshot, NOW);
	assert.match(footer, /^Cursor \| Pro \| models 3% left\//, footer);
	assert.match(footer, /other 65% left\//, footer);
	assert.match(footer, /grok bot 100% left\//, footer);
	assert.ok(
		footer.indexOf("models") < footer.indexOf("other") && footer.indexOf("other") < footer.indexOf("grok bot"),
		`pool order must follow primary/secondary/tertiary; footer: ${footer}`,
	);
	assert.ok(!JSON.stringify(snapshot).includes("secret-cursor-token"));
});

test("Cursor keeps the honest subscription snapshot when the undocumented rpc fails", async () => {
	// The quota numbers are an enrichment on top of the old plan-only snapshot. A refusal must
	// not blank the footer or report a working account as "usage unavailable".
	const fetchImpl = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
	const snapshot = await fetchUsageSnapshot(
		"cursor",
		{ type: "oauth", access: "secret" },
		{ fetchImpl },
	);
	assert.equal(snapshot.plan, "subscription");
	assert.equal(snapshot.primary, undefined, "no window may be invented");
	assert.equal(snapshot.tertiary, undefined);
	assert.equal(formatUsageCompact(snapshot), "Cursor | subscription");
});

test("a 401 from the dashboard service is surfaced so the OAuth refresh can retry", async () => {
	const fetchImpl = (async () => new Response("{}", { status: 401 })) as typeof fetch;
	await assert.rejects(
		fetchUsageSnapshot("cursor", { type: "oauth", access: "secret" }, { fetchImpl }),
		(error: unknown) => error instanceof UsageFetchError && error.status === 401,
	);
});

test("Cursor parsers accept the snake_case wire shape and refuse to invent windows", () => {
	const period = parseCursorCurrentPeriodUsage(
		"cursor",
		{ billing_cycle_end: "1789798631000", plan_usage: { auto_percent_used: 12, api_percent_used: 34 } },
		NOW,
		"hash",
	);
	assert.ok(period);
	assert.equal(period.primary?.usedPercent, 12);
	assert.equal(period.secondary?.usedPercent, 34);
	assert.equal(parseCursorCurrentPeriodUsage("cursor", { plan_usage: {} }, NOW), undefined);
	assert.equal(
		parseCursorSandUsage({ usage_percent: 5 }),
		undefined,
		"a percent without a reset is not a window",
	);
});

function unsignedJwt(payload: Record<string, unknown>): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
		"base64url",
	);
	const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
	return `${header}.${body}.sig`;
}

test("xAI is a usage family for the base slot and numbered aliases", () => {
	assert.equal(usageFamily("xai"), "xai");
	assert.equal(usageFamily("xai-account-2"), "xai");
	assert.equal(usageFamily("cursor"), "cursor", "Cursor Grok must not be classified as xAI");
	assert.equal(usageFamily("openai-codex"), "codex");
});

test("xAI user id comes from JWT sub / principal_id, never a generic accountId", () => {
	assert.equal(
		xaiUserIdFromAccessToken(unsignedJwt({ sub: "xai-user-123", principal_id: "other-id" })),
		"xai-user-123",
	);
	assert.equal(
		xaiUserIdFromAccessToken(unsignedJwt({ principal_id: "principal-only" })),
		"principal-only",
	);
	assert.equal(xaiUserIdFromAccessToken(unsignedJwt({ sub: "   " })), undefined);
	assert.equal(xaiUserIdFromAccessToken("not-a-jwt"), undefined);
});

test("parses modern SuperGrok billing credits and labels the period by length", () => {
	const snapshot = parseXaiUsageBody(
		"xai",
		{
			config: {
				creditUsagePercent: 42.5,
				currentPeriod: {
					type: "USAGE_PERIOD_TYPE_WEEKLY",
					start: "2026-06-08T00:00:00Z",
					end: "2026-06-15T00:00:00Z",
				},
				productUsage: [{ product: "GrokBuild", usagePercent: 61.2 }],
				onDemandCap: { val: 5_000 },
				onDemandUsed: { val: 300 },
			},
			subscriptionTier: "ignored-plan",
		},
		NOW,
		"credential",
	);
	assert.ok(snapshot);
	assert.equal(snapshot.family, "xai");
	assert.equal(snapshot.primary?.usedPercent, 42.5);
	assert.equal(snapshot.primary?.resetAt, Date.UTC(2026, 5, 15, 0, 0, 0));
	assert.equal(snapshot.primary?.windowSeconds, 7 * 24 * 60 * 60);
	assert.equal(snapshot.secondary, undefined);
	assert.equal(
		formatUsageCompact(snapshot, NOW),
		"xAI | 7d 58% left/1d12h",
	);
	assert.doesNotMatch(JSON.stringify(snapshot), /GrokBuild|ignored-plan|PRODUCT_GROK_BUILD/);
});

test("xAI falls back to Grok Build productUsage when creditUsagePercent is absent", () => {
	const snapshot = parseXaiUsageBody(
		"xai-account-2",
		{
			config: {
				currentPeriod: {
					type: "USAGE_PERIOD_TYPE_WEEKLY",
					start: "2026-06-08T00:00:00Z",
					end: "2026-06-15T00:00:00Z",
				},
				productUsage: [{ product: "PRODUCT_GROK_BUILD", usagePercent: 18 }],
			},
		},
		NOW,
	);
	assert.ok(snapshot);
	assert.equal(snapshot.primary?.usedPercent, 18);
	assert.equal(
		formatUsageCompact(snapshot, NOW),
		"xAI A2 | 7d 82% left/1d12h",
	);
});

test("xAI treats an omitted modern percentage as unknown even for a valid period", () => {
	const snapshot = parseXaiUsageBody(
		"xai",
		{
			config: {
				currentPeriod: {
					type: "USAGE_PERIOD_TYPE_WEEKLY",
					start: "2026-06-08T00:00:00Z",
					end: "2026-06-15T00:00:00Z",
				},
			},
		},
		NOW,
	);
	assert.equal(snapshot, undefined);
});

test("xAI prefers modern credit percent over legacy monthlyLimit/used", () => {
	const legacy = parseXaiUsageBody(
		"xai",
		{
			config: {
				monthlyLimit: { val: 2_000 },
				used: { val: 500 },
				billingPeriodStart: "2026-06-01T00:00:00Z",
				billingPeriodEnd: "2026-07-01T00:00:00Z",
			},
		},
		NOW,
	);
	const modern = parseXaiUsageBody(
		"xai",
		{
			config: {
				creditUsagePercent: 10,
				currentPeriod: {
					start: "2026-06-08T00:00:00Z",
					end: "2026-06-15T00:00:00Z",
				},
				monthlyLimit: { val: 2_000 },
				used: { val: 1_500 },
			},
		},
		NOW,
	);
	assert.equal(legacy?.primary?.usedPercent, 25);
	assert.equal(legacy?.primary?.windowSeconds, 30 * 24 * 60 * 60);
	assert.match(formatUsageCompact(legacy!, NOW), /30d 75% left/);
	assert.equal(modern?.primary?.usedPercent, 10);
});

test("xAI does not invent or mix partial period shapes", () => {
	assert.equal(
		parseXaiUsageBody("xai", { config: { creditUsagePercent: 12 } }, NOW),
		undefined,
	);
	assert.equal(
		parseXaiUsageBody(
			"xai",
			{
				config: {
					creditUsagePercent: 12,
					currentPeriod: { start: "not-an-instant", end: "2026-06-15T00:00:00Z" },
					billingPeriodStart: "2026-06-01T00:00:00Z",
					billingPeriodEnd: "2026-07-01T00:00:00Z",
				},
			},
			NOW,
		),
		undefined,
		"a modern percentage must not borrow legacy period metadata",
	);
	assert.equal(
		parseXaiUsageBody(
			"xai",
			{
				config: {
					creditUsagePercent: 12,
					currentPeriod: {
						start: "2026-05-01T00:00:00Z",
						end: "2026-05-08T00:00:00Z",
					},
				},
			},
			NOW,
		),
		undefined,
		"an expired period must not clear a current cooldown with stale headroom",
	);
});

test("xAI usage fetch sends conservative headers and never exposes the token", async () => {
	const now = Date.now();
	const access = unsignedJwt({
		sub: "xai-user-123",
		principal_id: "xai-user-123",
	});
	let seen: { url: string; method: string; headers: Headers } | undefined;
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		seen = {
			url: String(input),
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
		};
		return new Response(
			JSON.stringify({
				config: {
					creditUsagePercent: 2,
					currentPeriod: {
						type: "USAGE_PERIOD_TYPE_WEEKLY",
						start: new Date(now - 86_400_000).toISOString(),
						end: new Date(now + 6 * 86_400_000).toISOString(),
					},
				},
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}) as typeof fetch;

	const snapshot = await fetchUsageSnapshot(
		"xai",
		{
			type: "oauth",
			access,
			accountId: "must-not-be-used-as-xai-user-id",
		},
		{ fetchImpl, credentialHash: "safe-hash" },
	);
	assert.equal(seen?.url, XAI_SUBSCRIPTION_USAGE_URL);
	assert.equal(seen?.method, "GET");
	assert.equal(seen?.headers.get("Authorization"), `Bearer ${access}`);
	assert.equal(seen?.headers.get("Accept"), "application/json");
	assert.equal(seen?.headers.get("X-XAI-Token-Auth"), "xai-grok-cli");
	assert.equal(seen?.headers.get("x-userid"), "xai-user-123");
	assert.notEqual(seen?.headers.get("x-userid"), "must-not-be-used-as-xai-user-id");
	assert.equal(seen?.headers.get("x-grok-client-mode"), "headless");
	const clientVersion = seen?.headers.get("x-grok-client-version") ?? "";
	assert.match(clientVersion, /^pi-multi-account(\/|$)/);
	assert.equal(clientVersion, xaiHostClientVersion());
	assert.doesNotMatch(clientVersion, /grok-cli\/\d/);
	assert.equal(snapshot.family, "xai");
	assert.equal(snapshot.primary?.usedPercent, 2);
	assert.equal(snapshot.credentialHash, "safe-hash");
	assert.ok(!JSON.stringify(snapshot).includes(access));
	assert.ok(!JSON.stringify(snapshot).includes("must-not-be-used"));
});

test("an xAI API key reports itself instead of throwing", async () => {
	const snapshot = await fetchUsageSnapshot("xai", {
		type: "api_key",
		key: "xai-test-key",
	});
	assert.equal(snapshot.family, "xai");
	assert.equal(snapshot.primary, undefined, "no window may be invented for XAI_API_KEY");
	assert.match(snapshot.plan ?? "", /api-key|no usage endpoint/i);
	assert.doesNotMatch(JSON.stringify(snapshot), /xai-test-key/);
});

test("xAI usage fetch refuses to send a request without a JWT user id", async () => {
	let called = false;
	const fetchImpl = (async () => {
		called = true;
		return new Response("{}", { status: 200 });
	}) as typeof fetch;
	await assert.rejects(
		() =>
			fetchUsageSnapshot(
				"xai",
				{ type: "oauth", access: "not-a-jwt", accountId: "generic-account" },
				{ fetchImpl },
			),
		/no user id/i,
	);
	assert.equal(called, false);
});
