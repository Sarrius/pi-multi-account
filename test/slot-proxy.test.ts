/**
 * The rules a parent-owned loopback route has to hold.
 *
 * A port on 127.0.0.1 is reachable by every process on the machine, and what sits behind this one
 * is the user's subscription. So the interesting tests here are refusals, not forwards.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	PROXY_PLACEHOLDER_JWT,
	PROXY_PLACEHOLDER_KEY,
	UPSTREAM_BASE,
	admitRequest,
	parseProxyPath,
	isPublishedPlaceholder,
	placeholderKeyFor,
	presentedCredential,
	proxyFamilyFor,
	needsChildFacingApiKey,
	publishedRouteFor,
	dropOwnLoopbackPublications,
	isOwnLoopbackPublication,
	shapeUpstreamRequest,
	type ProxyRoute,
} from "../slot-proxy.ts";

const ROUTES = new Map<string, ProxyRoute>([
	["anthropic-account-2", { slotId: "anthropic-account-2", family: "anthropic" }],
	["openai-codex-account-4", { slotId: "openai-codex-account-4", family: "codex" }],
]);
const withKey = (key = PROXY_PLACEHOLDER_KEY) => ({ authorization: `Bearer ${key}` });

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

test("a slot route splits into the slot and the path to forward", () => {
	assert.deepEqual(parseProxyPath("/anthropic-account-2/v1/messages"), {
		slotId: "anthropic-account-2",
		rest: "/v1/messages",
	});
	assert.deepEqual(parseProxyPath("/openai-codex-account-4/codex/responses?stream=1"), {
		slotId: "openai-codex-account-4",
		rest: "/codex/responses?stream=1",
	});
	// A bare slot with no path is legitimate; it forwards to the upstream root.
	assert.deepEqual(parseProxyPath("/zai"), { slotId: "zai", rest: "/" });
});

test("anything that is not a slot route is refused rather than guessed at", () => {
	for (const url of ["", "v1/messages", "//v1", "/../etc/passwd", "/%2e%2e/x"]) {
		assert.equal(parseProxyPath(url), undefined, JSON.stringify(url));
	}
});

test("a path trying to climb out of its slot is refused, not normalised", () => {
	// Normalising is where traversal bugs live; there is no caller that needs `..`.
	for (const url of [
		"/anthropic-account-2/../openai-codex-account-4/v1",
		"/anthropic-account-2/v1/%2E%2E/admin",
	]) {
		assert.equal(parseProxyPath(url), undefined, url);
	}
});

// ---------------------------------------------------------------------------
// Admission — the two gates
// ---------------------------------------------------------------------------

test("a published slot presenting the placeholder is admitted", () => {
	const verdict = admitRequest({
		rawUrl: "/anthropic-account-2/v1/messages",
		headers: withKey(),
		routes: ROUTES,
	});
	assert.equal(verdict.ok, true);
	if (!verdict.ok) return;
	assert.equal(verdict.route.family, "anthropic");
	assert.equal(verdict.rest, "/v1/messages");
});

test("a slot we never published is not served", () => {
	// Otherwise the port is a way to reach any upstream on the user's tokens.
	const verdict = admitRequest({
		rawUrl: "/some-other-provider/v1/messages",
		headers: withKey(),
		routes: ROUTES,
	});
	assert.equal(verdict.ok, false);
	if (verdict.ok) return;
	assert.equal(verdict.status, 404);
});

test("a caller that does not present the placeholder is refused", () => {
	// Every process on this machine can find a loopback port. Without this gate, any of them
	// could spend the user's subscription.
	for (const headers of [{}, withKey("something-else"), { "x-api-key": "sk-real-looking" }]) {
		const verdict = admitRequest({
			rawUrl: "/anthropic-account-2/v1/messages",
			headers,
			routes: ROUTES,
		});
		assert.equal(verdict.ok, false, JSON.stringify(headers));
		if (verdict.ok) return;
		assert.equal(verdict.status, 401);
	}
});

test("a refusal never echoes what the caller presented", () => {
	// It may be a real credential belonging to whoever called, and refusals get logged.
	const verdict = admitRequest({
		rawUrl: "/anthropic-account-2/v1/messages",
		headers: { "x-api-key": "sk-caller-secret" },
		routes: ROUTES,
	});
	assert.equal(verdict.ok, false);
	if (verdict.ok) return;
	assert.equal(JSON.stringify(verdict).includes("sk-caller-secret"), false);
});

test("the placeholder is read from either header a Pi provider might use", () => {
	assert.equal(presentedCredential({ authorization: "Bearer abc" }), "abc");
	assert.equal(presentedCredential({ "x-api-key": "abc" }), "abc");
	assert.equal(presentedCredential({ authorization: ["Bearer abc"] }), "abc");
	assert.equal(presentedCredential({}), undefined);
});

// ---------------------------------------------------------------------------
// The outgoing request
// ---------------------------------------------------------------------------

const anthropicRoute: ProxyRoute = { slotId: "anthropic-account-2", family: "anthropic" };
const codexRoute: ProxyRoute = { slotId: "openai-codex-account-4", family: "codex" };

test("the placeholder never reaches the upstream; the real token does", () => {
	const shaped = shapeUpstreamRequest({
		route: anthropicRoute,
		rest: "/v1/messages",
		headers: { authorization: `Bearer ${PROXY_PLACEHOLDER_KEY}`, "content-type": "application/json" },
		credential: { type: "oauth", access: "real-anthropic-token" },
	});
	assert.equal(shaped.ok, true);
	if (!shaped.ok) return;
	assert.equal(shaped.url, `${UPSTREAM_BASE.anthropic}/v1/messages`);
	assert.equal(shaped.headers.authorization, "Bearer real-anthropic-token");
	assert.equal(JSON.stringify(shaped.headers).includes(PROXY_PLACEHOLDER_KEY), false);
	assert.equal(shaped.headers["content-type"], "application/json");
});

test("Anthropic gets the header without which a subscription token is rejected", () => {
	const shaped = shapeUpstreamRequest({
		route: anthropicRoute,
		rest: "/v1/messages",
		headers: {},
		credential: { type: "oauth", access: "t" },
	});
	assert.equal(shaped.ok, true);
	if (!shaped.ok) return;
	assert.equal(shaped.headers["anthropic-beta"], "oauth-2025-04-20");
});

test("a beta flag the caller already asked for is kept, and ours is added once", () => {
	const shaped = shapeUpstreamRequest({
		route: anthropicRoute,
		rest: "/v1/messages",
		headers: { "anthropic-beta": "fine-grained-tool-streaming-2025-05-14, oauth-2025-04-20" },
		credential: { type: "oauth", access: "t" },
	});
	assert.equal(shaped.ok, true);
	if (!shaped.ok) return;
	assert.equal(
		shaped.headers["anthropic-beta"],
		"fine-grained-tool-streaming-2025-05-14,oauth-2025-04-20",
	);
});

test("Codex is routed by account, which it refuses to serve without", () => {
	const shaped = shapeUpstreamRequest({
		route: codexRoute,
		rest: "/codex/responses",
		headers: {},
		credential: { type: "oauth", access: "t", accountId: "acct-9" },
	});
	assert.equal(shaped.ok, true);
	if (!shaped.ok) return;
	assert.equal(shaped.url, `${UPSTREAM_BASE.codex}/codex/responses`);
	assert.equal(shaped.headers["chatgpt-account-id"], "acct-9");
	assert.equal(shaped.headers.originator, "pi");
});

test("an API-key slot uses the header its family actually reads", () => {
	const anthropic = shapeUpstreamRequest({
		route: anthropicRoute,
		rest: "/v1/messages",
		headers: {},
		credential: { type: "api_key", key: "sk-real" },
	});
	assert.equal(anthropic.ok, true);
	if (!anthropic.ok) return;
	assert.equal(anthropic.headers["x-api-key"], "sk-real");
	assert.equal(anthropic.headers.authorization, undefined);
});

test("hop-by-hop and recomputed headers are not copied through", () => {
	const shaped = shapeUpstreamRequest({
		route: anthropicRoute,
		rest: "/v1/messages",
		headers: {
			host: "127.0.0.1:41977",
			"content-length": "9999",
			connection: "keep-alive",
			"transfer-encoding": "chunked",
			"accept-encoding": "gzip",
			"user-agent": "pi",
		},
		credential: { type: "oauth", access: "t" },
	});
	assert.equal(shaped.ok, true);
	if (!shaped.ok) return;
	for (const dropped of ["host", "content-length", "connection", "transfer-encoding", "accept-encoding"]) {
		assert.equal(shaped.headers[dropped], undefined, dropped);
	}
	// A header the caller legitimately set still travels.
	assert.equal(shaped.headers["user-agent"], "pi");
});

test("a slot with no usable credential is refused, and the message says what to do", () => {
	for (const credential of [undefined, {}, { type: "oauth" }, { type: "api_key" }]) {
		const shaped = shapeUpstreamRequest({
			route: anthropicRoute,
			rest: "/v1/messages",
			headers: {},
			credential,
		});
		assert.equal(shaped.ok, false, JSON.stringify(credential));
		if (shaped.ok) return;
		assert.equal(shaped.status, 401);
		assert.match(shaped.message, /\/login/);
	}
});

test("no failure path ever puts the real token in its message", () => {
	const shaped = shapeUpstreamRequest({
		route: { slotId: "x", family: "nonsense" as any },
		rest: "/v1",
		headers: {},
		credential: { type: "oauth", access: "REAL-TOKEN" },
	});
	assert.equal(shaped.ok, false);
	if (shaped.ok) return;
	assert.equal(shaped.message.includes("REAL-TOKEN"), false);
});

test("the published route points at this machine and carries the slot", () => {
	const url = publishedRouteFor(41977, "anthropic-account-2");
	assert.equal(url, "http://127.0.0.1:41977/anthropic-account-2");
	assert.equal(new URL(url).hostname, "127.0.0.1");
});

// ---------------------------------------------------------------------------
// The Codex placeholder has to survive being parsed as a token
// ---------------------------------------------------------------------------

test("Pi reads an account id out of the Codex key, so that placeholder is token-shaped", () => {
	// Measured against a real `pi -p --no-extensions` child: a plain placeholder fails before any
	// request with "Failed to extract accountId from token". Pi splits on ".", base64-decodes the
	// middle segment and reads chatgpt_account_id — no signature is checked.
	const parts = PROXY_PLACEHOLDER_JWT.split(".");
	assert.equal(parts.length, 3);
	const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
	assert.equal(payload["https://api.openai.com/auth"].chatgpt_account_id, PROXY_PLACEHOLDER_KEY);
	// Nothing real is in it: no signature, no algorithm, and the user's own account id stays out.
	assert.equal(parts[2], "");
	assert.equal(JSON.parse(Buffer.from(parts[0], "base64").toString("utf8")).alg, "none");
});

test("each family is published with the placeholder its own API will accept", () => {
	assert.equal(placeholderKeyFor("codex"), PROXY_PLACEHOLDER_JWT);
	assert.equal(placeholderKeyFor("anthropic"), PROXY_PLACEHOLDER_KEY);
});

test("both placeholders are admitted; nothing else is", () => {
	assert.equal(isPublishedPlaceholder(PROXY_PLACEHOLDER_KEY), true);
	assert.equal(isPublishedPlaceholder(PROXY_PLACEHOLDER_JWT), true);
	for (const other of [undefined, "", "sk-real", `${PROXY_PLACEHOLDER_JWT}x`]) {
		assert.equal(isPublishedPlaceholder(other), false, String(other));
	}
});

test("a Codex slot presenting the JWT placeholder is admitted", () => {
	const verdict = admitRequest({
		rawUrl: "/openai-codex-account-4/codex/responses",
		headers: { authorization: `Bearer ${PROXY_PLACEHOLDER_JWT}` },
		routes: ROUTES,
	});
	assert.equal(verdict.ok, true);
});

test("the account id Pi filled in from the placeholder is replaced, never merely defaulted", () => {
	// Pi sets chatgpt-account-id from whatever it read out of the key. Left alone, the request
	// would reach Codex naming an account that does not exist.
	const shaped = shapeUpstreamRequest({
		route: codexRoute,
		rest: "/codex/responses",
		headers: { "chatgpt-account-id": PROXY_PLACEHOLDER_KEY },
		credential: { type: "oauth", access: "t", accountId: "acct-9" },
	});
	assert.equal(shaped.ok, true);
	if (!shaped.ok) return;
	assert.equal(shaped.headers["chatgpt-account-id"], "acct-9");
});

test("a Codex credential with no account id sends none, rather than the placeholder", () => {
	const shaped = shapeUpstreamRequest({
		route: codexRoute,
		rest: "/codex/responses",
		headers: { "chatgpt-account-id": PROXY_PLACEHOLDER_KEY },
		credential: { type: "oauth", access: "t" },
	});
	assert.equal(shaped.ok, true);
	if (!shaped.ok) return;
	assert.equal(shaped.headers["chatgpt-account-id"], undefined);
});

test("base Anthropic and numbered Anthropic/Codex slots are proxied; base Codex is not", () => {
	assert.equal(proxyFamilyFor("anthropic"), "anthropic");
	assert.equal(proxyFamilyFor("anthropic-account-2"), "anthropic");
	assert.equal(proxyFamilyFor("openai-codex-account-4"), "codex");
	assert.equal(proxyFamilyFor("openai-codex"), undefined);
	assert.equal(proxyFamilyFor("zai"), undefined);
	assert.equal(needsChildFacingApiKey("anthropic-account-2"), true);
	assert.equal(needsChildFacingApiKey("openai-codex-account-4"), true);
	assert.equal(needsChildFacingApiKey("anthropic"), false);
});

test("a built-in Anthropic child is admitted when it presents the current access token", () => {
	const verdict = admitRequest({
		rawUrl: "/anthropic/v1/messages",
		headers: { "x-api-key": "live-access-token" },
		routes: new Map([["anthropic", { slotId: "anthropic", family: "anthropic" }]]),
		acceptedSecrets: ["live-access-token"],
	});
	assert.equal(verdict.ok, true);
	if (!verdict.ok) return;
	assert.equal(verdict.route.slotId, "anthropic");
});

test("an access token for a different slot is not admitted, and the refusal does not echo it", () => {
	const verdict = admitRequest({
		rawUrl: "/anthropic/v1/messages",
		headers: { authorization: "Bearer other-token" },
		routes: new Map([["anthropic", { slotId: "anthropic", family: "anthropic" }]]),
		acceptedSecrets: ["live-access-token"],
	});
	assert.equal(verdict.ok, false);
	if (verdict.ok) return;
	assert.equal(verdict.status, 401);
	assert.equal(verdict.message.includes("other-token"), false);
	assert.equal(verdict.message.includes("live-access-token"), false);
});

test("stop drops every own loopback, including numbered slots left on a dead port", () => {
	const providers = {
		anthropic: {
			apiKey: PROXY_PLACEHOLDER_KEY,
			baseUrl: "http://127.0.0.1:41977/anthropic",
		},
		"anthropic-account-2": {
			apiKey: PROXY_PLACEHOLDER_KEY,
			baseUrl: "http://127.0.0.1:41977/anthropic-account-2",
		},
		"openai-codex-account-4": {
			apiKey: PROXY_PLACEHOLDER_JWT,
			baseUrl: "http://127.0.0.1:41977/openai-codex-account-4",
		},
		cursor: {
			apiKey: "cursor-own-placeholder",
			baseUrl: "http://127.0.0.1:59265/v1",
		},
		zai: { apiKey: "sk-real", baseUrl: "https://api.z.ai" },
	};
	const next = dropOwnLoopbackPublications(providers);
	assert.equal(next.anthropic, undefined);
	assert.equal(next["anthropic-account-2"], undefined);
	assert.equal(next["openai-codex-account-4"], undefined);
	assert.equal(next.cursor, providers.cursor);
	assert.equal(next.zai, providers.zai);
});

test("stop removes a dead loopback publication but retains user modelOverrides", () => {
	const modelOverrides = {
		"claude-opus-5": { contextWindow: 466_384, maxTokens: 64_000 },
	};
	const next = dropOwnLoopbackPublications({
		anthropic: {
			api: "anthropic-messages",
			apiKey: PROXY_PLACEHOLDER_KEY,
			baseUrl: "http://127.0.0.1:41977/anthropic",
			models: [{ id: "claude-opus-5", contextWindow: 1_000_000 }],
			modelOverrides,
		},
	});
	assert.deepEqual(next.anthropic, { modelOverrides });
});

test("a user's own Anthropic models.json entry is not treated as our loopback", () => {
	const providers = {
		anthropic: {
			apiKey: "sk-user",
			baseUrl: "https://api.anthropic.com",
		},
	};
	assert.equal(isOwnLoopbackPublication(providers.anthropic, "anthropic"), false);
	assert.deepEqual(dropOwnLoopbackPublications(providers), providers);
});
