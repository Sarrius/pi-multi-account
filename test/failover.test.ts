/**
 * State-machine tests for pi-multi-account.
 *
 * The harness drives the real extension in Pi's actual event order:
 * provider responses (possibly retried) -> final assistant message -> agent_end.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const AGENT_DIR = mkdtempSync(join(tmpdir(), "pmacct-test-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
// The Cursor provider lives in a separate, optional repo. Point the bridge at a directory we
// control so a test can toggle "installed" / "not installed" — the default is NOT installed,
// which is what the overwhelming majority of users run.
// The canonical slot-proxy port decides which extension instance publishes the shared files.
// Tests routinely leave an instance listening, so every setup() gets its own port: otherwise
// the first instance would own the port for the whole file and every later publication test
// would silently exercise the non-owner path instead. `reuseSlotProxyPort` is how a test asks
// for the opposite — a second instance contending for a port the first one still holds.
let nextSlotProxyPort = 41500;
function currentSlotProxyPort(): number {
	return Number(process.env.PI_MULTI_ACCOUNT_SLOT_PROXY_PORT);
}
const CURSOR_ROOT = join(AGENT_DIR, "cursor-provider");
process.env.PI_CURSOR_PROVIDER_ROOT = CURSOR_ROOT;

const CURSOR_PROVIDER_STUB = `export const FALLBACK_MODELS = [
	{ id: "cursor-grok-4.6", name: "Grok 4.6", reasoning: true, input: ["text"] },
	{ id: "composer-2.5", name: "Composer 2.5", reasoning: true, input: ["text"] },
];
export async function ensureCursorProxy() {
	return 41999;
}
export function registerCursorProvider(pi, id, _port, models) {
	pi.registerProvider(id, { name: \`Cursor (\${id})\`, models });
}
`;

// Cursor's OAuth refresh, as the vendored provider exposes it (`auth.ts` next to
// `cursor-shared.ts`). It rotates the refresh token — like Anthropic and Cursor really do —
// and records every call, so a test can prove a token was NOT burned.
const CURSOR_REFRESH_LOG = join(AGENT_DIR, "cursor-refresh-calls.json");
const CURSOR_AUTH_STUB = `import { appendFileSync } from "node:fs";
export async function refreshCursorToken(token) {
	appendFileSync(${JSON.stringify(CURSOR_REFRESH_LOG)}, JSON.stringify(token) + "\\n");
	return { access: "rotated-access:" + token, refresh: "rotated-refresh:" + token, expires: 4102444800000 };
}
`;

function cursorRefreshCalls(): string[] {
	if (!existsSync(CURSOR_REFRESH_LOG)) return [];
	return readFileSync(CURSOR_REFRESH_LOG, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as string);
}

function installCursorProvider() {
	mkdirSync(CURSOR_ROOT, { recursive: true });
	writeFileSync(join(CURSOR_ROOT, "cursor-shared.ts"), CURSOR_PROVIDER_STUB);
	// The forced-refresh path imports this from the SAME root — it used to import it from
	// ~/.pi/agent/git/github.com/ndraiman/pi-cursor-provider/auth.ts, a path that no longer
	// exists for anyone since the provider was vendored (issue #20).
	writeFileSync(join(CURSOR_ROOT, "auth.ts"), CURSOR_AUTH_STUB);
	rmSync(CURSOR_REFRESH_LOG, { force: true });
}

function uninstallCursorProvider() {
	rmSync(CURSOR_ROOT, { recursive: true, force: true });
}

// A Cursor provider that is present but UNLOADABLE is covered in test/cursor-optional.test.ts:
// that case needs a fresh process, because the cursor bridge caches the loaded module and an
// earlier test in this file loads a working stub.

const {
	default: piMultiAccount,
	explicitCliSelections,
	canPersistRefreshedCredentials,
	mergeRefreshedCredentials,
	modelIdentityKey,
	modelQualityBand,
	persistRefreshedCredentials,
	sameModelIdentity,
} = (await import("../index.ts")) as {
	default: (pi: any) => void;
	explicitCliSelections: (
		argv?: readonly string[],
	) => { model: boolean; thinking: boolean };
	canPersistRefreshedCredentials: (
		authStorage: any,
		authWritable?: () => boolean,
	) => boolean;
	mergeRefreshedCredentials: (credentials: any, refreshed: any) => any;
	modelIdentityKey: (modelId: string) => string;
	modelQualityBand: (modelId: string) => "frontier" | "balanced" | "fast" | undefined;
	persistRefreshedCredentials: (
		authStorage: any,
		provider: string,
		credential: Record<string, unknown>,
		io?: {
			read?: () => Record<string, any>;
			write?: (data: Record<string, any>) => void;
		},
	) => Promise<boolean>;
	sameModelIdentity: (a: string | undefined, b: string | undefined) => boolean;
};

test("explicit CLI selection detection follows Pi option parsing", () => {
	assert.deepEqual(
		explicitCliSelections([
			"node",
			"pi",
			"--model",
			"openai/gpt-5.5",
			"--thinking",
			"high",
		]),
		{ model: true, thinking: true },
	);
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
		assert.equal(
			explicitCliSelections(["node", "pi", "--thinking", level]).thinking,
			true,
		);
	}
	assert.deepEqual(
		explicitCliSelections([
			"node",
			"pi",
			"--model",
			"openrouter/acme:model/v1.2+fast@2026-09-01:high",
		]),
		{ model: true, thinking: false },
		"a model suffix cannot be classified until the session catalog is available",
	);
	assert.deepEqual(
		explicitCliSelections(["node", "pi", "--thinking", "invalid"]),
		{ model: false, thinking: false },
	);
	assert.deepEqual(
		explicitCliSelections([
			"node",
			"pi",
			"--model",
			"openrouter/acme:model/v1.2+fast@2026-09-01:turbo",
		]),
		{ model: true, thinking: false },
	);
	assert.deepEqual(
		explicitCliSelections(["node", "pi", "--", "--model", "openai/gpt-5.5:high"]),
		{ model: false, thinking: false },
	);
	assert.deepEqual(
		explicitCliSelections(["node", "pi", "--models", "openai/*:high"]),
		{ model: false, thinking: false },
	);
});

test("model identity folds Cursor effort suffixes and the cursor- prefix", () => {
	assert.equal(modelIdentityKey("cursor-grok-4.6-high"), "grok-4.6");
	assert.equal(modelIdentityKey("cursor-grok-4.6"), "grok-4.6");
	assert.equal(modelIdentityKey("grok-4.6"), "grok-4.6");
	assert.equal(modelIdentityKey("cursor-grok-4.6-high-fast"), "grok-4.6");
	assert.ok(sameModelIdentity("cursor-grok-4.6-high", "cursor-grok-4.6"));
	assert.ok(sameModelIdentity("cursor-grok-4.6-high", "grok-4.6"));
	assert.ok(!sameModelIdentity("cursor-grok-4.6", "claude-4-sonnet"));
	assert.ok(!sameModelIdentity("gpt-5.4", "gpt-5.4-mini"));
	assert.ok(!sameModelIdentity("k3", "k3-256k"));
});

test("cross-provider quality bands map Sol/Opus, Terra/Sonnet, and Luna/Haiku", () => {
	assert.equal(modelQualityBand("gpt-5.6-sol"), "frontier");
	assert.equal(modelQualityBand("claude-opus-5"), "frontier");
	assert.equal(modelQualityBand("composer-2.5"), "frontier");
	assert.equal(modelQualityBand("qwen3.8-max"), "frontier");
	assert.equal(modelQualityBand("glm-5.2:cloud"), "frontier");
	assert.equal(modelQualityBand("gpt-5.6-terra"), "balanced");
	assert.equal(modelQualityBand("claude-sonnet-4-6"), "balanced");
	assert.equal(modelQualityBand("gpt-5.6-luna"), "fast");
	assert.equal(modelQualityBand("claude-haiku-4-5"), "fast");
});

const AUTH = join(AGENT_DIR, "auth.json");
const CONFIG = join(AGENT_DIR, "provider-failover.json");
const STATE = join(AGENT_DIR, "provider-failover-state.json");
const SETTINGS = join(AGENT_DIR, "settings.json");
const MODELS = join(AGENT_DIR, "models.json");
const DEBUG_LOG = join(AGENT_DIR, "provider-failover-debug.log");

function readDebugLog(): Array<Record<string, any>> {
	try {
		return readFileSync(DEBUG_LOG, "utf8")
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}

type Credential = {
	type?: string;
	access?: string;
	refresh?: string;
	expires?: number;
	key?: string;
	accountId?: string;
};
type Account = Record<string, Credential>;

function codexAccessToken(
	workspaceId: string,
	accountUserId: string,
	tokenVersion = "1",
): string {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": {
				chatgpt_account_id: workspaceId,
				chatgpt_account_user_id: accountUserId,
			},
		}),
	).toString("base64url");
	return `eyJhbGciOiJub25lIn0.${payload}.${tokenVersion}`;
}

function legacyCodexAccessToken(
	workspaceId: string,
	userId: string,
	tokenVersion = "1",
): string {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": {
				chatgpt_account_id: workspaceId,
				chatgpt_user_id: userId,
			},
		}),
	).toString("base64url");
	return `eyJhbGciOiJub25lIn0.${payload}.${tokenVersion}`;
}

const TWO_ACCOUNTS: Account = {
	anthropic: { type: "oauth", access: "a-tok-1", refresh: "a-ref-1" },
	"openai-codex-account-2": {
		type: "oauth",
		access: "c-tok-2",
		refresh: "c-ref-2",
		accountId: "codex-2",
	},
};
const ONE_ACCOUNT: Account = {
	anthropic: { type: "oauth", access: "a-tok-1", refresh: "a-ref-1" },
};

let messageTimestamp = 1;

function setup(opts: {
	accounts?: Account;
	current?: { provider: string; id: string };
	config?: Record<string, unknown>;
	idle?: boolean;
	aborted?: boolean;
	seedCooldownsMsFromNow?: Record<string, number>;
	seedState?: Record<string, unknown>;
	setModelFailures?: string[];
	setModelBlocks?: () => Promise<void>;
	forceRefreshResults?: Record<
		string,
		| { status: "refreshed" }
		| { status: "terminal"; error: string }
		| { status: "transient"; error: string }
	>;
	compactionAuth?: {
		ok: boolean;
		error?: string;
		apiKey?: string;
		headers?: Record<string, string>;
	};
	compactFn?: (...args: any[]) => Promise<any>;
	/**
	 * A host whose `ctx.compact()` answers through NEITHER callback.
	 *
	 * Not hypothetical: a compaction cancelled by an extension reports through `compaction_end`,
	 * and the guard's own `onComplete`/`onError` are never called. If that leaves the guard's
	 * in-flight flag set, it never asks for another summary for the rest of the session.
	 */
	compactSilent?: boolean;
	contextUsage?: {
		tokens: number | null;
		contextWindow: number;
		percent: number | null;
	};
	continueThrows?: string;
	continueBlocks?: () => Promise<void>;
	omitContinueAgent?: boolean;
	omitSendUserMessage?: boolean;
	/** Models the HOST (Pi) itself publishes for the base Codex provider. */
	hostCodexModels?: string[];
	/** Accounts Pi does NOT know any model for — logged in, but unusable until configured. */
	unknownProviders?: string[];
	/** The level the SESSION runs at (what `--thinking` / `/thinking` produced). */
	thinkingLevel?: string;
	/** Thinking level Pi applies while changing models, before model_select is emitted. */
	modelSetThinkingLevel?: string;
	/** Deliver a model-induced thinking event before or after model_select. */
	modelThinkingLevelSelectDelivery?: "before" | "after";
	/** Emit setThinkingLevel's fire-and-forget host event, optionally after a prior-handler yield. */
	thinkingLevelSelectDelivery?: "sync" | "delayed";
	/** Highest thinking level a provider's models support — Pi clamps anything above it. */
	thinkingCaps?: Record<string, string>;
	/** Pi settings.json defaultProvider/defaultModel, used after catalog load. */
	settings?: { defaultProvider: string; defaultModel: string };
	/** Simulate a child process launched by pi-subagents. */
	subagentChild?: boolean;
	/** Simulate Pi CLI arguments before the extension is loaded. */
	cliArgs?: string[];
	/**
	 * Shape of the host's AuthStorage.
	 *
	 * "pi-0.84" is the REAL surface of pi 0.84.x: `read`/`modify`/`delete`/`list`/`reload`,
	 * and neither the `set()` this extension used to persist with nor a host-side
	 * `forceRefreshProvider`. Every other test uses the convenience stub that provides
	 * `forceRefreshProvider`, which short-circuits the extension's own refresh path.
	 */
	hostAuthStorage?: "pi-0.84";
	/** Contend for the port the previous instance is still listening on, instead of a fresh one. */
	reuseSlotProxyPort?: boolean;
}) {
	if (!opts.reuseSlotProxyPort) {
		process.env.PI_MULTI_ACCOUNT_SLOT_PROXY_PORT = String(nextSlotProxyPort++);
	}
	const accounts = opts.accounts ?? TWO_ACCOUNTS;
	writeFileSync(AUTH, JSON.stringify(accounts));
	writeFileSync(
		CONFIG,
		JSON.stringify({
			enabled: true,
			autoContinue: true,
			autoDiscover: true,
			autoDiscoverModels: false,
			showUsage: false,
			fallbacks: [],
			...(opts.config ?? {}),
		}),
	);

	if (opts.seedState) {
		writeFileSync(STATE, JSON.stringify(opts.seedState));
	} else if (opts.seedCooldownsMsFromNow) {
		const now = Date.now();
		const exhaustedUntilByProvider: Record<string, number> = {};
		for (const [provider, ms] of Object.entries(opts.seedCooldownsMsFromNow)) {
			exhaustedUntilByProvider[provider] = now + ms;
		}
		writeFileSync(
			STATE,
			JSON.stringify({
				stateVersion: 4,
				exhaustedUntilByProvider,
				lastProbeAtByProvider: {},
				invalidatedByProvider: {},
				lastSwitches: [],
			}),
		);
	} else {
		rmSync(STATE, { force: true });
	}
	if (opts.settings) {
		writeFileSync(SETTINGS, JSON.stringify(opts.settings));
	} else {
		rmSync(SETTINGS, { force: true });
	}

	const known = new Set<string>(
		Object.keys(accounts).filter((id) => !opts.unknownProviders?.includes(id)),
	);
	const registeredModels = new Map<string, any[]>();
	const providerConfigs = new Map<string, any>();
	const mkModel = (provider: string, id: string) => ({ provider, id });
	const rec = {
		sent: [] as Array<{ prompt: string; options?: Record<string, unknown> }>,
		continueCalls: [] as Array<{ options?: Record<string, unknown> }>,
		setModels: [] as string[],
		notifies: [] as string[],
		statuses: [] as Array<{ key: string; value: string | undefined }>,
		compacts: [] as Array<Record<string, unknown>>,
		customMessages: [] as Array<{ message: any; options?: any }>,
		compactionAuthFor: [] as string[],
		thinkingLevels: [] as string[],
		registrations: [] as Array<{ provider: string; models: number | undefined }>,
		catalogSnapshots: [] as any[],
		aborts: 0,
		authReloads: 0,
	};
	// Pi's real thinking-level semantics: a single mutable session level, clamped to what the
	// CURRENT model supports, and re-clamped on every model switch (see AgentSession.setModel).
	// That re-clamp is exactly how the level used to drift downward across failovers.
	const THINKING_ORDER = [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	];
	let sessionThinkingLevel = opts.thinkingLevel ?? "high";
	const clampThinking = (level: string) => {
		const cap = opts.thinkingCaps?.[ctx.model?.provider ?? ""];
		if (!cap) return level;
		return THINKING_ORDER.indexOf(level) > THINKING_ORDER.indexOf(cap)
			? cap
			: level;
	};
	let idle = opts.idle ?? true;
	// Pi runs EVERY handler registered for an event, threading the result through for `context`
	// and `message_end`. Keeping only the last one registered (which this fixture used to do) made
	// the harness silently disagree with the host the moment a second handler was added for an
	// event — the interrupted-turn hook stopped being exercised at all. Chain them, like Pi does.
	const events: Record<string, Array<(event: any, ctx?: any) => any>> = {};
	const busEvents = new Map<string, Array<(payload: any) => void>>();
	const commands: Record<string, (args: string, ctx: any) => any> = {};
	const pendingThinkingLevelSelects: Array<{
		delivery: Promise<void>;
		release?: () => void;
	}> = [];

	const ctx: any = {
		model: opts.current
			? mkModel(opts.current.provider, opts.current.id)
			: undefined,
		isIdle: () => idle,
		// The host's ctx.compact(): fire-and-forget, resolves through the callbacks. The guard calls
		// this only at a settled boundary, because the real one begins with an abort().
		compact: (options?: { onComplete?: (r: unknown) => void; onError?: (e: Error) => void }) => {
			rec.compacts.push(options ?? {});
			if (opts.compactSilent) return;
			queueMicrotask(() => options?.onComplete?.({ summary: "test summary" }));
		},
		signal: { aborted: opts.aborted ?? false },
		hasPendingMessages: () => false,
		abort: () => {
			rec.aborts++;
			ctx.signal.aborted = true;
		},
		ui: {
			notify: (message: string) => rec.notifies.push(message),
			setStatus: (key: string, value: string | undefined) =>
				rec.statuses.push({ key, value }),
		},
		modelRegistry: {
			find: (provider: string, id: string) => {
				const models = registeredModels.get(provider);
				if (models) return models.find((model) => model.id === id);
				return known.has(provider) ? mkModel(provider, id) : undefined;
			},
			getProvider: () => ({ streamSimple: async function* () {} }),
			getAll: () =>
				[...known].flatMap((provider) => {
					if (opts.hostCodexModels && provider === "openai-codex") {
						return opts.hostCodexModels.map((id) => mkModel(provider, id));
					}
					return (
						registeredModels.get(provider) ?? [
							mkModel(provider, "claude-opus-4-8"),
						]
					);
				}),
			authStorage:
				opts.hostAuthStorage === "pi-0.84"
					? {
							reload: () => {
								rec.authReloads++;
							},
							read: async (provider: string) =>
								JSON.parse(readFileSync(AUTH, "utf8"))[provider],
							list: async () =>
								Object.entries(
									JSON.parse(readFileSync(AUTH, "utf8")) as Record<string, any>,
								).map(([providerId, credential]) => ({
									providerId,
									type: credential.type,
								})),
							modify: async (
								provider: string,
								fn: (current: any) => any | Promise<any>,
							) => {
								const data = JSON.parse(readFileSync(AUTH, "utf8"));
								const next = await fn(data[provider]);
								if (next === undefined) return data[provider];
								writeFileSync(
									AUTH,
									JSON.stringify({ ...data, [provider]: next }, null, 2),
								);
								return next;
							},
							delete: async (provider: string) => {
								const data = JSON.parse(readFileSync(AUTH, "utf8"));
								delete data[provider];
								writeFileSync(AUTH, JSON.stringify(data, null, 2));
							},
							hasAuth: (provider: string) => {
								const entry = JSON.parse(readFileSync(AUTH, "utf8"))[provider];
								return !!(entry?.key || entry?.access);
							},
						}
					: {
							reload: () => {
								rec.authReloads++;
							},
							forceRefreshProvider: async (provider: string) =>
								opts.forceRefreshResults?.[provider] ?? {
									status: "terminal",
									error: "refresh_token_invalidated: session has ended",
								},
							hasAuth: (provider: string) => {
								const entry = JSON.parse(readFileSync(AUTH, "utf8"))[provider];
								return !!(entry?.key || entry?.access);
							},
						},
			getProviderAuthStatus: (provider: string) => ({
				configured: known.has(provider),
			}),
			getApiKeyAndHeaders: async (model: { provider: string; id: string }) => {
				rec.compactionAuthFor.push(`${model.provider}/${model.id}`);
				return (
					opts.compactionAuth ?? { ok: false as const, error: "no key in test" }
				);
			},
		},
		getContextUsage: () => opts.contextUsage,
	};

	const dispatchThinkingLevelSelect = (
		payload: { level: string; previousLevel: string },
		delayed = opts.thinkingLevelSelectDelivery === "delayed",
	) => {
		let release: (() => void) | undefined;
		const gate = delayed
			? new Promise<void>((resolve) => {
					release = resolve;
				})
			: undefined;
		const delivery = (async () => {
			if (gate) await gate;
			for (const handler of events.thinking_level_select ?? [])
				await handler(payload, ctx);
		})();
		pendingThinkingLevelSelects.push({ delivery, release });
		return delivery;
	};

	const pi: any = {
		events: {
			on: (name: string, handler: (payload: any) => void) => {
				const handlers = busEvents.get(name) ?? [];
				handlers.push(handler);
				busEvents.set(name, handlers);
			},
			emit: (name: string, payload: any) => {
				if (name === "pi:model-catalog:snapshot:v1") rec.catalogSnapshots.push(payload);
				for (const handler of busEvents.get(name) ?? []) handler(payload);
			},
		},
		registerProvider: (name: string, providerConfig?: { models?: any[] }) => {
			known.add(name);
			providerConfigs.set(name, providerConfig);
			rec.registrations.push({
				provider: name,
				models: providerConfig?.models?.length,
			});
			if (providerConfig?.models) {
				registeredModels.set(
					name,
					providerConfig.models.map((model) => ({ ...model, provider: name })),
				);
			}
		},
		registerCommand: (
			name: string,
			options: { handler: (args: string, ctx: any) => any },
		) => {
			commands[name] = options.handler;
		},
		on: (event: string, handler: any) => {
			(events[event] ??= []).push(handler);
		},
		setModel: async (model: any) => {
			const previousModel = ctx.model;
			const target = `${model.provider}/${model.id}`;
			rec.setModels.push(target);
			if (opts.setModelFailures?.includes(target)) return false;
			if (opts.setModelBlocks) await opts.setModelBlocks();
			ctx.model = mkModel(model.provider, model.id);
			// Pi applies a model default/clamp before emitting model_select.
			const previousThinkingLevel = sessionThinkingLevel;
			sessionThinkingLevel = opts.modelSetThinkingLevel ?? clampThinking(sessionThinkingLevel);
			if (sessionThinkingLevel !== previousThinkingLevel) {
				const payload = {
					level: sessionThinkingLevel,
					previousLevel: previousThinkingLevel,
				};
				if (opts.modelThinkingLevelSelectDelivery === "after") {
					dispatchThinkingLevelSelect(payload, true);
				} else {
					for (const handler of events.thinking_level_select ?? [])
						await handler(payload, ctx);
				}
			}
			for (const handler of events.model_select ?? [])
				await handler({ model: ctx.model, previousModel, source: "set" }, ctx);
			return true;
		},
		sendUserMessage: (prompt: string, options?: Record<string, unknown>) =>
			rec.sent.push({ prompt, options }),
		sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => {
			rec.customMessages.push({ message, options });
			return Promise.resolve();
		},
		continueAgent: async (options?: Record<string, unknown>) => {
			rec.continueCalls.push({ options });
			if (opts.continueThrows) throw new Error(opts.continueThrows);
			if (opts.continueBlocks) await opts.continueBlocks();
		},
		appendEntry: () => {},
		getThinkingLevel: () => sessionThinkingLevel,
		setThinkingLevel: (level: string) => {
			rec.thinkingLevels.push(level); // what the extension ASKED for
			const previousLevel = sessionThinkingLevel;
			sessionThinkingLevel = clampThinking(level); // what the host actually applied
			if (
				opts.thinkingLevelSelectDelivery &&
				sessionThinkingLevel !== previousLevel
			) {
				dispatchThinkingLevelSelect({
					level: sessionThinkingLevel,
					previousLevel,
				});
			}
		},
	};

	// Simulate a host Pi build that predates pi.continueAgent() (seamless in-place resume). The
	// extension must degrade to injecting the continuation prompt, never dead-end with a red error.
	if (opts.omitContinueAgent) delete pi.continueAgent;
	// Simulate a host with no prompt-injection fallback either — the worst case, where the extension
	// can still switch accounts but cannot auto-continue at all.
	if (opts.omitSendUserMessage) delete pi.sendUserMessage;
	// Tests always take this hook so they never import the real compact() (network).
	(pi as any).__testCompactFn = opts.compactFn;

	const previousSubagentChild = process.env.PI_SUBAGENT_CHILD;
	const previousArgv = process.argv;
	if (opts.subagentChild) process.env.PI_SUBAGENT_CHILD = "1";
	else delete process.env.PI_SUBAGENT_CHILD;
	process.argv = ["node", "pi", ...(opts.cliArgs ?? [])];
	try {
		piMultiAccount(pi);
	} finally {
		process.argv = previousArgv;
		if (previousSubagentChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previousSubagentChild;
	}

	const fire = async (event: string, payload: any = {}) => {
		const handlers = events[event];
		if (!handlers || handlers.length === 0) return undefined;
		if (event === "context") {
			let messages = payload?.messages;
			let changed = false;
			for (const handler of handlers) {
				const out = await handler({ ...payload, messages }, ctx);
				if (out?.messages) {
					messages = out.messages;
					changed = true;
				}
			}
			return changed ? { messages } : undefined;
		}
		if (event === "message_end") {
			let message = payload?.message;
			let changed = false;
			for (const handler of handlers) {
				const out = await handler({ ...payload, message }, ctx);
				if (out?.message) {
					message = out.message;
					changed = true;
				}
			}
			return changed ? { message } : undefined;
		}
		let result: any;
		for (const handler of handlers) {
			const out = await handler(payload, ctx);
			if (out !== undefined) {
				result = out;
				if (out?.cancel) return out;
			}
		}
		return result;
	};
	const setIdle = (value: boolean) => {
		idle = value;
	};
	const setCurrent = (provider: string, id: string) => {
		ctx.model = mkModel(provider, id);
	};
	const setModel = (provider: string, id: string) =>
		pi.setModel(mkModel(provider, id));
	const readState = () => {
		try {
			return JSON.parse(readFileSync(STATE, "utf8"));
		} catch {
			return {};
		}
	};
	// Stays synchronous on purpose: the host shapes the payload inline, and the tests read the
	// shaped result straight back rather than awaiting it.
	const beforeReq = (payload: unknown) => {
		let result: any;
		for (const handler of events.before_provider_request ?? []) {
			const out = handler({ payload }, ctx);
			if (out !== undefined) result = out;
		}
		return result;
	};
	const command = async (args: string) =>
		commands["multi-account"]?.(args, ctx);
	const input = async (text: string, images?: any[]) =>
		fire("input", { type: "input", text, images, source: "interactive" });

	// The level the session is actually running at, and the user changing it via `/thinking`.
	const thinkingLevel = () => sessionThinkingLevel;
	const userSetsThinking = (level: string) => {
		sessionThinkingLevel = clampThinking(level);
	};
	const settleThinkingLevelSelects = async () => {
		while (pendingThinkingLevelSelects.length > 0) {
			const pending = pendingThinkingLevelSelects.splice(0);
			for (const item of pending) item.release?.();
			await Promise.all(pending.map((item) => item.delivery));
		}
	};

	return {
		ctx,
		rec,
		fire,
		setIdle,
		setCurrent,
		setModel,
		readState,
		beforeReq,
		command,
		input,
		thinkingLevel,
		userSetsThinking,
		settleThinkingLevelSelects,
		providerConfigs,
	};
}

function wait(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function assistantError(provider: string, model: string, errorMessage: string) {
	return {
		role: "assistant",
		content: [],
		provider,
		model,
		stopReason: "error",
		errorMessage,
		timestamp: messageTimestamp++,
	};
}

async function finishError(
	t: ReturnType<typeof setup>,
	provider: string,
	model: string,
	errorMessage: string,
) {
	const message = assistantError(provider, model, errorMessage);
	await t.fire("message_end", { message });
	t.setIdle(true);
	await t.fire("agent_end", { messages: [message] });
	return message;
}

// ---------------------------------------------------------------------------
// Usage footer
// ---------------------------------------------------------------------------

test("usage footer countdown refreshes while the session is idle", async () => {
	const provider = "openai-codex-account-2";
	const now = Date.now();
	const t = setup({
		current: { provider, id: "gpt-5.5" },
		config: { showUsage: true, usageStatusRefreshMs: 20 },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {},
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			usageByProvider: {
				[provider]: {
					provider,
					family: "codex",
					fetchedAt: now,
					primary: { usedPercent: 1, resetAt: now + 61_000 },
				},
			},
			lastSwitches: [],
		},
	});

	await t.fire("session_start");
	const readCountdown = () => {
		const value = t.rec.statuses.at(-1)?.value ?? "";
		const match = /^Codex A2 \| 5h 99% left\/(\d+)m \| (?:\+\d+ ready|no spare)$/.exec(value);
		assert.ok(match, `unexpected footer value: ${JSON.stringify(value)}`);
		return Number(match[1]);
	};
	const first = readCountdown();
	const updatesAfterStart = t.rec.statuses.length;

	// The countdown is minute-granular, so which minute it lands on depends on how long the
	// harness took to boot (that made this assertion flaky). What must hold is that the idle
	// timer keeps repainting the footer and the countdown only ever runs down.
	await wait(1_100);
	assert.ok(
		t.rec.statuses.length > updatesAfterStart,
		"the idle timer must keep repainting the footer",
	);
	assert.ok(
		readCountdown() <= first,
		`the countdown must never run backwards: ${first}m -> ${readCountdown()}m`,
	);
	await t.fire("session_shutdown");
});

test(
	"background usage refresh discovers an early Codex reset or plan upgrade on every benched account",
	{ concurrency: false },
	async () => {
		const now = Date.now();
		const accounts: Account = {
			"openai-codex-account-2": {
				type: "oauth",
				access: "codex-access-2",
				refresh: "codex-refresh-2",
				accountId: "codex-account-2",
			},
			"openai-codex-account-3": {
				type: "oauth",
				access: "codex-access-3",
				refresh: "codex-refresh-3",
				accountId: "codex-account-3",
			},
			alibaba: { type: "api_key", key: "qwen-key" },
		};
		const hash = (value: string) =>
			createHash("sha256").update(value).digest("hex").slice(0, 12);
		const staleBlocked = (provider: string, access: string) => ({
			provider,
			family: "codex",
			fetchedAt: now - 60_000,
			credentialHash: hash(access),
			plan: "free",
			primary: {
				usedPercent: 100,
				resetAt: now + 30 * 24 * 60 * 60 * 1000,
			},
		});
		const seenAccountIds: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			seenAccountIds.push(headers.get("ChatGPT-Account-Id") ?? "missing");
			return new Response(
				JSON.stringify({
					plan_type: "pro",
					rate_limit: {
						primary_window: {
							used_percent: 10,
							reset_at: Math.floor((now + 60 * 60 * 1000) / 1000),
						},
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof fetch;

		const t = setup({
			accounts,
			current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
			config: {
				showUsage: true,
				usageRefreshMs: 20,
				usageStatusRefreshMs: 60_000,
			},
			seedState: {
				stateVersion: 5,
				exhaustedUntilByProvider: {
					"openai-codex-account-2": now + 6 * 60 * 60 * 1000,
					"openai-codex-account-3": now + 6 * 60 * 60 * 1000,
				},
				exhaustedUntilByModel: {},
				lastProbeAtByProvider: {},
				invalidatedByProvider: {},
				usageByProvider: {
					"openai-codex-account-2": staleBlocked(
						"openai-codex-account-2",
						"codex-access-2",
					),
					"openai-codex-account-3": staleBlocked(
						"openai-codex-account-3",
						"codex-access-3",
					),
				},
				lastSwitches: [],
			},
		});

		try {
			await t.fire("session_start");
			assert.deepEqual(seenAccountIds.sort(), [
				"codex-account-2",
				"codex-account-3",
			]);
			const state = t.readState();
			assert.equal(
				state.usageByProvider["openai-codex-account-2"].primary.usedPercent,
				10,
			);
			assert.equal(
				state.usageByProvider["openai-codex-account-3"].plan,
				"pro",
			);
			assert.deepEqual(
				t.rec.setModels,
				[],
				"startup must refresh the upgraded current account before switching away from it",
			);
			assert.ok(
				!state.exhaustedUntilByProvider?.["openai-codex-account-2"] &&
					!state.exhaustedUntilByProvider?.["openai-codex-account-3"],
				"fresh headroom after a plan change must clear both stale cooldowns",
			);
		} finally {
			await t.fire("session_shutdown");
			globalThis.fetch = originalFetch;
		}
	},
);

// ---------------------------------------------------------------------------
// One final error -> one decision
// ---------------------------------------------------------------------------

test("HTTP retry responses never switch early; one final 429 switches exactly once", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		idle: false,
	});
	await t.fire("agent_start");
	for (let attempt = 0; attempt < 4; attempt++) {
		await t.fire("after_provider_response", {
			status: 429,
			headers: { "retry-after": "60" },
		});
	}
	assert.equal(
		t.rec.setModels.length,
		0,
		"must not mutate the active model while Pi is retrying HTTP",
	);

	await finishError(
		t,
		"anthropic",
		"claude-opus-4-8",
		'429 {"type":"rate_limit_error"}',
	);
	assert.deepEqual(t.rec.setModels, ["openai-codex-account-2/gpt-5.5"]);
	assert.equal(
		t.rec.continueCalls.length,
		1,
		"the interrupted task should resume once with existing context",
	);
	assert.equal(t.rec.sent.length, 0, "must not inject a fake user message");
});

test("cross-family failover picks the target provider's default model, not the source model id", async () => {
	const accounts: Account = {
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
		"openai-codex": {
			type: "oauth",
			access: "c",
			refresh: "cr",
			accountId: "codex-1",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate_limit_error");
	assert.deepEqual(t.rec.setModels, ["openai-codex/gpt-5.5"]);
});

test("Anthropic third-party extra-usage 400 is a limit, not a request bug", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await finishError(
		t,
		"anthropic",
		"claude-opus-4-8",
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage, not your plan limits"}}',
	);
	assert.deepEqual(t.rec.setModels, ["openai-codex-account-2/gpt-5.5"]);
});

test("Cursor resource_exhausted (gRPC quota) is a limit, so failover moves off the spent account", async () => {
	const t = setup({
		current: { provider: "cursor", id: "cursor-grok-4.6" },
	});
	await finishError(
		t,
		"cursor",
		"cursor-grok-4.6",
		"Connect error resource_exhausted: Error",
	);
	// Must have switched away from the spent Cursor account — not died in place.
	assert.ok(
		t.rec.setModels.length > 0 && t.rec.setModels[0] !== "cursor/cursor-grok-4.6",
		`resource_exhausted must trigger failover, got ${JSON.stringify(t.rec.setModels)}`,
	);
});

test("failover resumes with existing context instead of injecting a user message", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		idle: false,
	});
	await t.fire("before_agent_start", {
		prompt: "Refactor the auth module and add tests",
	});
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	assert.equal(
		t.rec.continueCalls.length,
		1,
		"must resume on the new provider",
	);
	assert.equal(
		t.rec.sent.length,
		0,
		"must not inject a continuation user message",
	);
});

test("the failed assistant provider is authoritative even if ctx.model changed", async () => {
	const accounts: Account = {
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
		"openai-codex-account-2": {
			type: "oauth",
			access: "b",
			refresh: "br",
			accountId: "b",
		},
		"openai-codex-account-3": {
			type: "oauth",
			access: "c",
			refresh: "cr",
			accountId: "c",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	t.setCurrent("openai-codex-account-2", "gpt-5.5");
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate_limit_error");
	const state = t.readState();
	assert.ok(
		state.exhaustedUntilByProvider?.anthropic,
		"the provider named by the assistant error is cooled down",
	);
	assert.ok(
		!state.exhaustedUntilByProvider?.["openai-codex-account-2"],
		"the current ctx provider is not falsely blamed",
	);
});

test("a manual model selection does not disable failover for a real limit", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await t.fire("model_select", {
		model: { provider: "anthropic", id: "claude-opus-4-8" },
		previousModel: undefined,
		source: "set",
	});
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	assert.equal(
		t.rec.setModels.length,
		1,
		"a real 429 must still rotate after a manual selection",
	);
});

test("the same final assistant error is handled only once", async () => {
	const t = setup({
		accounts: ONE_ACCOUNT,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { autoContinue: false },
	});
	const message = assistantError(
		"anthropic",
		"claude-opus-4-8",
		"401 authentication_error",
	);
	await t.fire("message_end", { message });
	await t.fire("message_end", { message });
	assert.ok(
		!t.readState().invalidatedByProvider?.anthropic,
		"one event delivered twice must still count as one 401",
	);
});

// ---------------------------------------------------------------------------
// Cooldowns, ordering, and duplicate accounts
// ---------------------------------------------------------------------------

test("picks a fresh account and skips one that is still on cooldown", async () => {
	const accounts: Account = {
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
		"openai-codex-account-2": {
			type: "oauth",
			access: "b",
			refresh: "br",
			accountId: "b",
		},
		"openai-codex-account-3": {
			type: "oauth",
			access: "c",
			refresh: "cr",
			accountId: "c",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedCooldownsMsFromNow: { "openai-codex-account-2": 60 * 60 * 1000 },
	});
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	assert.deepEqual(t.rec.setModels, ["openai-codex-account-3/gpt-5.5"]);
});

test("no-fallback warning reports invalidated accounts separately from cooldowns", async () => {
	const deadAccess = "dead-2";
	const deadTokenHash = createHash("sha256")
		.update(deadAccess)
		.digest("hex")
		.slice(0, 12);
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
			"openai-codex-account-2": {
				type: "oauth",
				access: deadAccess,
				refresh: "dead-r",
				accountId: "dead-account",
			},
			"openai-codex-account-3": {
				type: "oauth",
				access: "cooldown-3",
				refresh: "cooldown-r",
				accountId: "cooldown-account",
			},
		},
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: {
			autoContinue: false,
			autoDiscover: false,
			fallbacks: [
				"anthropic",
				"openai-codex-account-2",
				"openai-codex-account-3",
			],
		},
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {
				"openai-codex-account-2": Date.now() + 365 * 24 * 60 * 60 * 1000,
				"openai-codex-account-3": Date.now() + 60 * 60 * 1000,
			},
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {
				"openai-codex-account-2": {
					tokenHash: deadTokenHash,
					at: Date.now(),
					reason: "OAuth refresh failed permanently: OpenAI",
				},
			},
			lastSwitches: [],
		},
	});
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	const warning = t.rec.notifies.find((message) =>
		message.includes("no immediately available fallback"),
	);
	assert.ok(warning);
	assert.ok(warning.includes("openai-codex-account-3"));
	assert.ok(
		warning.includes("Invalidated (need re-login): openai-codex-account-2"),
	);
	assert.ok(!warning.includes("Cooldowns: openai-codex-account-2"));
});

test("same Codex workspace membership in two slots is one rotation account and shares cooldown", async () => {
	const accounts: Account = {
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
		"openai-codex": {
			type: "oauth",
			access: codexAccessToken("shared-workspace", "membership-a", "base"),
			refresh: "base-r",
			accountId: "shared-workspace",
		},
		"openai-codex-account-2": {
			type: "oauth",
			access: codexAccessToken("other-workspace", "membership-b", "other"),
			refresh: "other-r",
			accountId: "other-workspace",
		},
		"openai-codex-account-3": {
			type: "oauth",
			access: codexAccessToken("shared-workspace", "membership-a", "refreshed"),
			refresh: "duplicate-r",
			accountId: "shared-workspace",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "openai-codex", id: "gpt-5.5" },
		config: {
			fallbacks: [
				"openai-codex",
				"openai-codex-account-3",
				"openai-codex-account-2",
				"anthropic",
			],
			autoContinue: false,
		},
	});
	await finishError(t, "openai-codex", "gpt-5.5", "429 usage_limit_reached");
	assert.equal(
		t.rec.setModels[0],
		"openai-codex-account-2/gpt-5.5",
		"duplicate slot must be skipped",
	);
	const state = t.readState();
	assert.ok(state.exhaustedUntilByProvider?.["openai-codex"]);
	assert.ok(
		state.exhaustedUntilByProvider?.["openai-codex-account-3"],
		"all slots for the real account share cooldown",
	);
});

test("different users in the same Codex workspace remain distinct rotation accounts", async () => {
	const workspace = "shared-team-workspace";
	const t = setup({
		accounts: {
			"openai-codex": {
				type: "oauth",
				access: codexAccessToken(workspace, "membership-alice"),
				refresh: "alice-r",
				accountId: workspace,
			},
			"openai-codex-account-2": {
				type: "oauth",
				access: codexAccessToken(workspace, "membership-bob"),
				refresh: "bob-r",
				accountId: workspace,
			},
		},
		current: { provider: "openai-codex", id: "gpt-5.5" },
		config: {
			fallbacks: ["openai-codex", "openai-codex-account-2"],
			autoContinue: false,
		},
	});

	await finishError(t, "openai-codex", "gpt-5.5", "429 usage_limit_reached");
	assert.equal(
		t.rec.setModels[0],
		"openai-codex-account-2/gpt-5.5",
		"a second user in the same workspace must remain available as a fallback",
	);
	assert.ok(t.readState().exhaustedUntilByProvider?.["openai-codex"]);
	assert.ok(
		!t.readState().exhaustedUntilByProvider?.["openai-codex-account-2"],
		"one workspace member's cooldown must not fan out to another member",
	);
});

test("documented Codex user + workspace claims distinguish legacy workspace memberships", async () => {
	const workspace = "shared-team-workspace";
	const t = setup({
		accounts: {
			"openai-codex": {
				type: "oauth",
				access: legacyCodexAccessToken(workspace, "user-alice"),
				refresh: "alice-r",
				accountId: workspace,
			},
			"openai-codex-account-2": {
				type: "oauth",
				access: legacyCodexAccessToken(workspace, "user-bob"),
				refresh: "bob-r",
				accountId: workspace,
			},
		},
		current: { provider: "openai-codex", id: "gpt-5.5" },
		config: {
			fallbacks: ["openai-codex", "openai-codex-account-2"],
			autoContinue: false,
		},
	});

	await finishError(t, "openai-codex", "gpt-5.5", "429 usage_limit_reached");
	assert.equal(t.rec.setModels[0], "openai-codex-account-2/gpt-5.5");
});

test("session start reports deterministic duplicate account slots", async () => {
	const accounts: Account = {
		"openai-codex": {
			type: "oauth",
			access: codexAccessToken("shared-workspace", "membership-a", "base"),
			refresh: "base-r",
			accountId: "shared-workspace",
		},
		"openai-codex-account-2": {
			type: "oauth",
			access: codexAccessToken("shared-workspace", "membership-a", "refreshed"),
			refresh: "duplicate-r",
			accountId: "shared-workspace",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "openai-codex", id: "gpt-5.5" },
	});
	await t.fire("session_start", { reason: "startup" });
	assert.ok(
		t.rec.notifies.some((message) =>
			message.includes("openai-codex-account-2 duplicates openai-codex"),
		),
		"the user should be told which redundant slot to replace",
	);
});

test("an activation failure is retried after auth reload, cooled briefly, and skipped", async () => {
	const accounts: Account = {
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
		"openai-codex-account-2": {
			type: "oauth",
			access: "b",
			refresh: "br",
			accountId: "b",
		},
		"openai-codex-account-3": {
			type: "oauth",
			access: "c",
			refresh: "cr",
			accountId: "c",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		setModelFailures: ["openai-codex-account-2/gpt-5.5"],
	});
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	assert.deepEqual(t.rec.setModels, [
		"openai-codex-account-2/gpt-5.5",
		"openai-codex-account-2/gpt-5.5",
		"openai-codex-account-3/gpt-5.5",
	]);
	assert.ok(t.readState().exhaustedUntilByProvider?.["openai-codex-account-2"]);
	assert.ok(!t.readState().invalidatedByProvider?.["openai-codex-account-2"]);
});

test("v3 one-year poisoned invalidations are removed during migration", () => {
	const now = Date.now();
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedState: {
			stateVersion: 3,
			exhaustedUntilByProvider: {
				anthropic: now + 60_000,
				"openai-codex-account-2": now + 365 * 24 * 60 * 60 * 1000,
			},
			invalidatedByProvider: {
				"openai-codex-account-2": {
					tokenHash: "old",
					at: now,
					reason: "401 terminated",
				},
			},
		},
	});
	const state = t.readState();
	assert.equal(state.stateVersion, 5);
	assert.ok(
		state.exhaustedUntilByProvider?.anthropic,
		"plausible quota cooldown is retained",
	);
	assert.ok(
		!state.exhaustedUntilByProvider?.["openai-codex-account-2"],
		"one-year poison is removed",
	);
	assert.deepEqual(state.invalidatedByProvider, {});
});

test("re-login clears a persisted invalidation when the slot credential changes", () => {
	const provider = "openai-codex-account-2";
	const oldTokenHash = createHash("sha256")
		.update("old-access")
		.digest("hex")
		.slice(0, 12);
	const t = setup({
		accounts: {
			[provider]: {
				type: "oauth",
				access: "new-access",
				refresh: "new-refresh",
				accountId: "codex-2",
			},
		},
		current: { provider, id: "gpt-5.5" },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {
				[provider]: Date.now() + 365 * 24 * 60 * 60 * 1000,
			},
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {
				[provider]: {
					tokenHash: oldTokenHash,
					at: Date.now(),
					reason: "refresh token invalidated",
				},
			},
			lastSwitches: [],
		},
	});
	const state = t.readState();
	assert.ok(!state.invalidatedByProvider?.[provider]);
	assert.ok(!state.exhaustedUntilByProvider?.[provider]);
});

// ---------------------------------------------------------------------------
// Auth failures are counted per final assistant message
// ---------------------------------------------------------------------------

test("one final 401 is counted once, does not invalidate OAuth, and fails over", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	for (let attempt = 0; attempt < 3; attempt++) {
		await t.fire("after_provider_response", { status: 401, headers: {} });
	}
	await finishError(
		t,
		"anthropic",
		"claude-opus-4-8",
		"401 authentication_error",
	);
	const state = t.readState();
	assert.ok(
		!state.invalidatedByProvider?.anthropic,
		"one request must not become three auth failures",
	);
	assert.equal(
		t.rec.setModels.length,
		1,
		"the current task should continue on another account",
	);
});

test("an explicitly invalidated OAuth token is removed immediately and failover continues", async () => {
	const accounts: Account = {
		"openai-codex-account-2": {
			type: "oauth",
			access: "dead-2",
			refresh: "refresh-2",
			accountId: "codex-2",
		},
		"openai-codex-account-4": {
			type: "oauth",
			access: "live-4",
			refresh: "refresh-4",
			accountId: "codex-4",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		config: {
			autoContinue: false,
			autoDiscover: false,
			fallbacks: [
				"openai-codex-account-2",
				"openai-codex-account-4",
				"anthropic",
			],
		},
	});
	await finishError(
		t,
		"openai-codex-account-2",
		"gpt-5.5",
		"Your authentication token has been invalidated. Please try signing in again.",
	);
	assert.ok(t.readState().invalidatedByProvider?.["openai-codex-account-2"]);
	assert.deepEqual(t.rec.setModels, ["openai-codex-account-4/gpt-5.5"]);
	assert.ok(
		t.rec.notifies.some(
			(message) =>
				message.includes("Run /login") &&
				message.includes("openai-codex-account-2"),
		),
	);
});

test("an early-invalidated access token is force-refreshed and retried on the same account", async () => {
	const accounts: Account = {
		"openai-codex-account-2": {
			type: "oauth",
			access: "stale-2",
			refresh: "working-refresh-2",
			accountId: "codex-2",
		},
		"openai-codex-account-4": {
			type: "oauth",
			access: "live-4",
			refresh: "refresh-4",
			accountId: "codex-4",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		forceRefreshResults: { "openai-codex-account-2": { status: "refreshed" } },
	});
	await finishError(
		t,
		"openai-codex-account-2",
		"gpt-5.5",
		"Your authentication token has been invalidated. Please try signing in again.",
	);
	assert.deepEqual(
		t.rec.setModels,
		[],
		"a successful refresh must stay on the same account",
	);
	assert.equal(
		t.rec.continueCalls.length,
		1,
		"the interrupted task should retry once with the refreshed token",
	);
	assert.equal(t.rec.sent.length, 0);
	assert.ok(!t.readState().invalidatedByProvider?.["openai-codex-account-2"]);
	assert.ok(
		t.rec.notifies.some((message) =>
			message.includes("refreshed successfully"),
		),
	);
});

test("a temporary forced-refresh failure cools the slot without permanently invalidating it", async () => {
	const accounts: Account = {
		"openai-codex-account-2": {
			type: "oauth",
			access: "stale-2",
			refresh: "working-refresh-2",
			accountId: "codex-2",
		},
		"openai-codex-account-4": {
			type: "oauth",
			access: "live-4",
			refresh: "refresh-4",
			accountId: "codex-4",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		config: { autoContinue: false },
		forceRefreshResults: {
			"openai-codex-account-2": {
				status: "transient",
				error: "network timeout",
			},
		},
	});
	await finishError(
		t,
		"openai-codex-account-2",
		"gpt-5.5",
		"Your authentication token has been invalidated. Please try signing in again.",
	);
	assert.ok(!t.readState().invalidatedByProvider?.["openai-codex-account-2"]);
	assert.ok(t.readState().exhaustedUntilByProvider?.["openai-codex-account-2"]);
	assert.deepEqual(t.rec.setModels, ["openai-codex-account-4/gpt-5.5"]);
});

test("usage footer survives an OAuth token rotation instead of blanking", async () => {
	// Real report: the quota footer showed nothing for the current Codex account even though fresh
	// usage was stored. One cause: the OAuth access token rotates, so the snapshot's credentialHash
	// no longer matches and cachedUsage() rejected it — leaving the footer blank. For DISPLAY we now
	// fall back to the last stored snapshot: a slightly stale "% left" beats an empty footer.
	const now = Date.now();
	const t = setup({
		accounts: {
			"openai-codex-account-2": {
				type: "oauth",
				access: "rotated-live-token",
				refresh: "r",
				accountId: "c2",
			},
		},
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		config: { showUsage: true },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {},
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			lastSwitches: [],
			usageByProvider: {
				"openai-codex-account-2": {
					provider: "openai-codex-account-2",
					family: "codex",
					fetchedAt: now,
					// Hash from the PREVIOUS token — no longer matches the rotated one above.
					credentialHash: "stale-hash-from-old-token",
					primary: { usedPercent: 98, resetAt: now + 3_600_000 },
					secondary: { usedPercent: 32, resetAt: now + 7 * 86_400_000 },
					plan: "plus",
				},
			},
		},
	});
	await t.fire("agent_start");
	const footer = t.rec.statuses
		.filter((s) => s.key === "multi-account-quota")
		.map((s) => s.value);
	assert.ok(
		footer.some(
			(v) => typeof v === "string" && v.includes("Codex") && v.includes("left"),
		),
		`footer must still show usage after a token rotation; got ${JSON.stringify(footer)}`,
	);
});

test("Qwen shows live availability / rate-limit status (it has no quota API)", async () => {
	// Alibaba publishes no usage/quota endpoint, so instead of a useless "no usage endpoint" the
	// status must show the account's real live state: available now, or rate-limited until recovery.
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
			alibaba: { type: "api_key", key: "sk-qwen" },
		},
		current: { provider: "alibaba", id: "qwen3.7-max" },
	});
	await t.fire("session_start");
	await t.command("status");
	assert.ok(
		t.rec.notifies.some((m) => m.includes("Qwen/Alibaba | available")),
		`available before any limit; notifies=${t.rec.notifies.join(" | ")}`,
	);

	// A caught 429 cools alibaba → its status must now read rate-limited, not "available".
	await finishError(t, "alibaba", "qwen3.7-max", "usage limit reached");
	t.setCurrent("alibaba", "qwen3.7-max");
	t.rec.notifies.length = 0;
	await t.command("status");
	assert.ok(
		t.rec.notifies.some((m) => /Qwen\/Alibaba \| rate-limited/.test(m)),
		`rate-limited after a 429; notifies=${t.rec.notifies.join(" | ")}`,
	);
});

test("Qwen requests rewrite the OpenAI-only 'developer' role to 'system'", async () => {
	// Real report: with a WORKING alibaba key, turns routed to Qwen failed with
	// `400 invalid_parameter_error: developer is not one of ['system',...]`. Pi sends the system
	// instructions as the OpenAI-only `developer` role; Qwen's compatible-mode API rejects it.
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
			alibaba: { type: "api_key", key: "sk-qwen" },
			"openai-codex-account-2": {
				type: "oauth",
				access: "c",
				refresh: "cr",
				accountId: "codex-2",
			},
		},
		current: { provider: "alibaba", id: "qwen3.7-max" },
	});
	await t.fire("session_start");

	const qwenPayload = {
		messages: [
			{ role: "developer", content: "You are helpful." },
			{ role: "user", content: "hi" },
		],
	};
	t.beforeReq(qwenPayload);
	assert.equal(
		qwenPayload.messages[0].role,
		"system",
		"Qwen must never receive the `developer` role",
	);

	// Codex/OpenAI DOES support `developer` — it must be left untouched there.
	t.setCurrent("openai-codex-account-2", "gpt-5.5");
	const codexPayload = {
		messages: [
			{ role: "developer", content: "You are helpful." },
			{ role: "user", content: "hi" },
		],
	};
	t.beforeReq(codexPayload);
	assert.equal(
		codexPayload.messages[0].role,
		"developer",
		"non-Qwen providers keep the developer role",
	);
});

test("manual switch revives a stuck invalidation and selects the account", async () => {
	// Real report: `/multi-account switch alibaba` answered "no usable model, make sure it is logged
	// in" for a freshly-keyed account. Cause: the slot was invalidated earlier (e.g. by the wrong
	// Qwen endpoint, since fixed). markInvalid stored the CURRENT key's hash, so the hash-based
	// auto-revive never fires while the key is unchanged — the invalidation is permanent even though
	// its cause is gone. An explicit switch is the user overriding that: it must revive and select.
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
			alibaba: { type: "api_key", key: "fresh-qwen-key" },
		},
		current: { provider: "alibaba", id: "qwen3.7-max" },
	});
	await t.fire("session_start");
	// Terminally invalidate alibaba WITHOUT changing its key → the invalidation sticks across
	// discovery (currentHash === record.tokenHash), reproducing the stuck state.
	await finishError(t, "alibaba", "qwen3.7-max", "invalid api key");
	assert.ok(
		t.readState().invalidatedByProvider?.alibaba,
		"precondition: alibaba is stuck-invalidated with its current key",
	);
	t.rec.setModels.length = 0;
	t.setCurrent("anthropic", "claude-opus-4-8");
	await t.command("switch alibaba");
	assert.ok(
		!t.readState().invalidatedByProvider?.alibaba,
		"explicit switch must clear the stuck invalidation",
	);
	assert.ok(
		t.rec.setModels.some((m) => m.startsWith("alibaba/")),
		`explicit switch must actually select alibaba; setModels=${t.rec.setModels.join(",")}`,
	);
});

test("a second account failure in the same agent chain is not hidden by the previous switch", async () => {
	const accounts: Account = {
		"openai-codex-account-2": {
			type: "oauth",
			access: "dead-2",
			refresh: "refresh-2",
			accountId: "codex-2",
		},
		"openai-codex-account-4": {
			type: "oauth",
			access: "dead-4",
			refresh: "refresh-4",
			accountId: "codex-4",
		},
		anthropic: { type: "oauth", access: "live-a", refresh: "refresh-a" },
	};
	const t = setup({
		accounts,
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		config: {
			autoContinue: false,
			autoDiscover: false,
			fallbacks: [
				"openai-codex-account-2",
				"openai-codex-account-4",
				"anthropic",
			],
		},
	});
	const error =
		"Your authentication token has been invalidated. Please try signing in again.";
	await t.fire("message_end", {
		message: assistantError("openai-codex-account-2", "gpt-5.5", error),
	});
	await t.fire("message_end", {
		message: assistantError("openai-codex-account-4", "gpt-5.5", error),
	});
	assert.deepEqual(t.rec.setModels, [
		"openai-codex-account-4/gpt-5.5",
		"anthropic/claude-opus-5",
	]);
	assert.ok(t.readState().invalidatedByProvider?.["openai-codex-account-2"]);
	assert.ok(t.readState().invalidatedByProvider?.["openai-codex-account-4"]);
});

test("rotated (refreshed) tokens 401ing past the threshold invalidate a refreshable account", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { autoContinue: false },
	});
	// MAX_CONSECUTIVE_AUTH_FAILURES is 8 in v1.9.0+. Each attempt rotates the access token
	// (simulating Pi refreshing and the NEW token still failing) — distinct refreshed tokens
	// advance the kill counter. Below the threshold the account must stay alive.
	for (let attempt = 0; attempt < 7; attempt++) {
		writeFileSync(
			AUTH,
			JSON.stringify({
				anthropic: {
					type: "oauth",
					access: `a-tok-${attempt}`,
					refresh: "a-ref-1",
				},
			}),
		);
		t.setCurrent("anthropic", "claude-opus-4-8");
		await t.fire("agent_start");
		await finishError(
			t,
			"anthropic",
			"claude-opus-4-8",
			"401 authentication_error",
		);
	}
	assert.ok(
		!t.readState().invalidatedByProvider?.anthropic,
		"seven rotated-token 401s must NOT invalidate (threshold is 8)",
	);
	// One more rotated-token failure crosses the threshold → invalidate.
	writeFileSync(
		AUTH,
		JSON.stringify({
			anthropic: {
				type: "oauth",
				access: `a-tok-7`,
				refresh: "a-ref-1",
			},
		}),
	);
	t.setCurrent("anthropic", "claude-opus-4-8");
	await t.fire("agent_start");
	await finishError(
		t,
		"anthropic",
		"claude-opus-4-8",
		"401 authentication_error",
	);
	assert.ok(t.readState().invalidatedByProvider?.anthropic);
});

test("repeated 401s on the SAME unrefreshed token never permanently invalidate", async () => {
	// Reproduces the alias-refresh bug class: the access token never changes between 401s because the
	// refresh isn't reaching the wire. The account must stay recoverable, not be killed-until-relogin.
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { autoContinue: false },
	});
	for (let attempt = 0; attempt < 5; attempt++) {
		t.setCurrent("anthropic", "claude-opus-4-8");
		await t.fire("agent_start");
		await finishError(
			t,
			"anthropic",
			"claude-opus-4-8",
			"401 authentication_error",
		);
	}
	assert.ok(
		!t.readState().invalidatedByProvider?.anthropic,
		"a static unrefreshed token must not be mistaken for a revoked account",
	);
});

test("a successful response resets the 401 streak", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { autoContinue: false },
	});
	await finishError(
		t,
		"anthropic",
		"claude-opus-4-8",
		"401 authentication_error",
	);
	t.setCurrent("anthropic", "claude-opus-4-8");
	await t.fire("after_provider_response", { status: 200, headers: {} });
	for (let attempt = 0; attempt < 2; attempt++) {
		t.setCurrent("anthropic", "claude-opus-4-8");
		await t.fire("agent_start");
		await finishError(
			t,
			"anthropic",
			"claude-opus-4-8",
			"401 authentication_error",
		);
	}
	assert.ok(!t.readState().invalidatedByProvider?.anthropic);
});

test("a non-limit error does not trigger failover", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await finishError(
		t,
		"anthropic",
		"claude-opus-4-8",
		"context window exceeded",
	);
	assert.equal(t.rec.setModels.length, 0);
	assert.equal(t.rec.sent.length, 0);
});

test("the per-task auto-continue cap survives the extension's own follow-up", async () => {
	const accounts: Account = {
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
		"openai-codex-account-2": {
			type: "oauth",
			access: "b",
			refresh: "br",
			accountId: "b",
		},
		"openai-codex-account-3": {
			type: "oauth",
			access: "c",
			refresh: "cr",
			accountId: "c",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { maxAutoContinuesPerPrompt: 1 },
	});
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	assert.equal(t.rec.continueCalls.length, 1);
	assert.equal(t.rec.sent.length, 0);

	await finishError(
		t,
		"openai-codex-account-2",
		"claude-opus-4-8",
		"429 rate limit",
	);
	assert.equal(
		t.rec.continueCalls.length,
		1,
		"the second failure must stop instead of creating another resume",
	);
	assert.equal(
		t.rec.setModels.length,
		1,
		"the cap must prevent another automatic account switch",
	);
});

test("dead authorization with no fallback does not leave fake pending work", async () => {
	const t = setup({
		accounts: { anthropic: { type: "api_key", key: "dead-key" } },
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await finishError(t, "anthropic", "claude-opus-4-8", "401 invalid api key");
	assert.ok(t.readState().invalidatedByProvider?.anthropic);
	assert.ok(!t.readState().pendingFrom);
});

test("manual next can override cooldowns without arming an automatic continuation", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedCooldownsMsFromNow: { "openai-codex-account-2": 60 * 60 * 1000 },
	});
	await t.command("next");
	assert.deepEqual(t.rec.setModels, ["openai-codex-account-2/gpt-5.5"]);
	await t.fire("agent_end", { messages: [] });
	assert.equal(
		t.rec.sent.length,
		0,
		"manual account selection must not enqueue extension work",
	);
});

test("manual next cancels the old automatic resume chain before it rotates", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedCooldownsMsFromNow: {
			anthropic: 60 * 60 * 1000,
			"openai-codex-account-2": 60 * 60 * 1000,
		},
	});
	await finishError(t, "anthropic", "claude-opus-4-8", "429 usage limit");
	assert.ok(t.readState().pendingFrom, "precondition: the failed turn armed a wake");

	await t.command("next");
	assert.equal(
		t.readState().pendingFrom,
		undefined,
		"the user's new route owns the session; the old wake must not survive",
	);
	await t.fire("session_shutdown");
});

test("a fresh user message is never swallowed into a private cooldown queue", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedCooldownsMsFromNow: {
			anthropic: 60 * 60 * 1000,
			"openai-codex-account-2": 60 * 60 * 1000,
		},
	});

	const result = await t.input("keep this visible in the transcript");
	assert.deepEqual(
		result,
		{ action: "continue" },
		"Pi must receive the original input so the user's text remains visible and recoverable",
	);
	assert.equal(t.rec.sent.length, 0, "the extension must not clone the prompt into its own queue");
	assert.ok(
		t.rec.notifies.some((message) => /no account is ready|keeps? your message/i.test(message)),
		"the user must be told why the current request may fail over",
	);
});

test("slash commands bypass the cooldown input queue", async () => {
	const t = setup({
		accounts: ONE_ACCOUNT,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedCooldownsMsFromNow: { anthropic: 60 * 60 * 1000 },
	});
	const result = await t.input("/login");
	assert.deepEqual(result, { action: "continue" });
	assert.ok(
		!t.rec.notifies.some((message) => message.includes("held in memory")),
	);
	assert.equal(t.rec.sent.length, 0);
});

test("a user prompt arriving during an automatic turn is queued as a follow-up instead of racing the active run", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		idle: false,
	});
	const result = await t.input("new owner intent");
	assert.deepEqual(result, { action: "handled" });
	assert.deepEqual(t.rec.sent, [
		{ prompt: "new owner intent", options: { deliverAs: "followUp" } },
	]);
});

// ---------------------------------------------------------------------------
// User control and session-bound automatic resume
// ---------------------------------------------------------------------------

test("Esc abort stops the chain and clears pending resume", async () => {
	const t = setup({
		accounts: ONE_ACCOUNT,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	const message = assistantError(
		"anthropic",
		"claude-opus-4-8",
		"429 rate limit",
	);
	await t.fire("message_end", { message });
	assert.ok(t.readState().pendingFrom && t.readState().pendingReason);
	await t.fire("agent_end", {
		messages: [{ role: "assistant", stopReason: "aborted" }],
	});
	assert.equal(t.rec.sent.length, 0);
	assert.ok(!t.readState().pendingFrom);
	await new Promise((resolve) => setTimeout(resolve, 1100));
	assert.equal(
		t.rec.sent.length,
		0,
		"cancelled timer must not resurrect the task",
	);
});

test("all-limited work resumes in the same live session after cooldown", async () => {
	const t = setup({
		accounts: ONE_ACCOUNT,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { cooldownMs: 1000, probeCooldownMs: 1000 },
	});
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	assert.equal(t.rec.sent.length, 0, "nothing is available immediately");
	assert.ok(t.readState().pendingFrom && t.readState().pendingReason);
	await new Promise((resolve) => setTimeout(resolve, 1200));
	assert.equal(
		t.rec.continueCalls.length,
		1,
		"the task resumes once the account cooldown expires",
	);
	assert.ok(!t.readState().pendingFrom);
});

test("session shutdown cancels pending work permanently", async () => {
	const t = setup({
		accounts: ONE_ACCOUNT,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { cooldownMs: 1000 },
	});
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	await t.fire("session_shutdown", { reason: "quit" });
	await new Promise((resolve) => setTimeout(resolve, 1100));
	assert.equal(t.rec.sent.length, 0);
	assert.ok(!t.readState().pendingFrom);
});

test("a cooled account stays skipped after its OAuth access token refreshes", async () => {
	const accounts: Account = {
		anthropic: { type: "oauth", access: "a-tok", refresh: "a-ref" },
		"openai-codex-account-2": {
			type: "oauth",
			access: codexAccessToken("workspace-2", "membership-2", "old"),
			refresh: "c-ref",
			accountId: "workspace-2",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedCooldownsMsFromNow: { "openai-codex-account-2": 60 * 60 * 1000 },
	});
	await t.fire("session_start");
	t.rec.setModels.length = 0;
	// Pi rotates the OAuth access token in place — same workspace membership, new token.
	writeFileSync(
		AUTH,
		JSON.stringify({
			...accounts,
			"openai-codex-account-2": {
				type: "oauth",
				access: codexAccessToken("workspace-2", "membership-2", "new"),
				refresh: "c-ref",
				accountId: "workspace-2",
			},
		}),
	);
	await t.command("rediscover");
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	assert.deepEqual(
		t.rec.setModels,
		[],
		"a routine token refresh must not wipe a still-active rate-limit cooldown",
	);
	assert.ok(
		t.readState().pendingFrom && t.readState().pendingReason,
		"both accounts cooling → pending resume armed",
	);
});

test("re-login as another user in the same Codex workspace clears the old user's cooldown", async () => {
	const provider = "openai-codex-account-2";
	const workspace = "shared-team-workspace";
	const accounts: Account = {
		anthropic: { type: "oauth", access: "a-tok", refresh: "a-ref" },
		[provider]: {
			type: "oauth",
			access: codexAccessToken(workspace, "membership-alice"),
			refresh: "alice-r",
			accountId: workspace,
		},
	};
	const t = setup({
		accounts,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedCooldownsMsFromNow: { [provider]: 60 * 60 * 1000 },
		config: { autoContinue: false },
	});
	await t.fire("session_start");

	writeFileSync(
		AUTH,
		JSON.stringify({
			...accounts,
			[provider]: {
				type: "oauth",
				access: codexAccessToken(workspace, "membership-bob"),
				refresh: "bob-r",
				accountId: workspace,
			},
		}),
	);
	await t.command("rediscover");

	assert.ok(
		!t.readState().exhaustedUntilByProvider?.[provider],
		"a different workspace membership must not inherit the previous user's cooldown",
	);
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	assert.equal(t.rec.setModels[0], `${provider}/gpt-5.5`);
});

test("manual next cycles through every account instead of ping-ponging between two", async () => {
	const accounts: Account = {
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
		"anthropic-account-2": { type: "oauth", access: "a2", refresh: "a2r" },
		"openai-codex-account-2": {
			type: "oauth",
			access: "b",
			refresh: "br",
			accountId: "b",
		},
		"openai-codex-account-4": {
			type: "oauth",
			access: "d",
			refresh: "dr",
			accountId: "d",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		// All cooling, codex soonest — exactly the shape from the real failure logs.
		seedCooldownsMsFromNow: {
			anthropic: 4 * 60 * 60 * 1000,
			"anthropic-account-2": 3 * 60 * 60 * 1000,
			"openai-codex-account-2": 4 * 60 * 60 * 1000,
			"openai-codex-account-4": 2 * 60 * 60 * 1000,
		},
	});
	await t.fire("session_start");
	const providers: string[] = [];
	for (let i = 0; i < 4; i++) {
		await t.command("next");
		providers.push(t.ctx.model.provider);
	}
	assert.ok(
		providers.some((p) => p.startsWith("anthropic")),
		`next must reach an anthropic slot; visited=${providers.join(",")}`,
	);
	assert.ok(
		new Set(providers).size >= 3,
		`next must visit >=3 distinct accounts; visited=${providers.join(",")}`,
	);
});

test("high reasoning is the baseline and is restored across every provider rotation", async () => {
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "anthropic", refresh: "anthropic-refresh" },
			"openai-codex-account-2": {
				type: "oauth",
				access: "codex",
				refresh: "codex-refresh",
				accountId: "codex-account",
			},
			alibaba: { type: "api_key", key: "qwen-key" },
			ollama: { type: "api_key", key: "ollama-key" },
		},
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});

	await t.fire("session_start");
	await t.fire("agent_start");
	for (let i = 0; i < 4; i++) await t.command("next");

	assert.deepEqual(
		new Set(t.rec.setModels.map((model) => model.split("/")[0])),
		new Set(["openai-codex-account-2", "alibaba", "ollama", "anthropic"]),
	);
	assert.ok(
		t.rec.thinkingLevels.length >= 5,
		`high must be applied at turn start and after every switch: ${JSON.stringify(t.rec.thinkingLevels)}`,
	);
	assert.ok(
		t.rec.thinkingLevels.every((level) => level === "high"),
		`no provider may escalate reasoning above high by default: ${JSON.stringify(t.rec.thinkingLevels)}`,
	);
});

// ---------------------------------------------------------------------------
// v1.14.2: the session owns the thinking level; the extension only preserves it
// ---------------------------------------------------------------------------

const THINKING_ACCOUNTS: Account = {
	anthropic: {
		type: "oauth",
		access: "anthropic",
		refresh: "anthropic-refresh",
	},
	"openai-codex-account-2": {
		type: "oauth",
		access: "codex",
		refresh: "codex-refresh",
		accountId: "codex-account",
	},
};

test("a per-agent thinking level (--thinking low) is never clobbered to the global default", async () => {
	const t = setup({
		accounts: THINKING_ACCOUNTS,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		thinkingLevel: "low", // this delegated agent is configured for low thinking
	});

	await t.fire("session_start");
	await t.fire("agent_start");

	assert.equal(
		t.thinkingLevel(),
		"low",
		"agent_start must not raise a session configured for low thinking",
	);
	assert.ok(
		!t.rec.thinkingLevels.includes("high"),
		`the global default must never be forced onto the session: ${JSON.stringify(t.rec.thinkingLevels)}`,
	);

	// ...and it stays low across a failover switch too.
	await t.command("next");
	assert.equal(t.thinkingLevel(), "low");
	assert.ok(t.rec.thinkingLevels.every((level) => level === "low"));
});

test("a weaker fallback model's clamp never ratchets the thinking level down", async () => {
	const t = setup({
		accounts: THINKING_ACCOUNTS,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		thinkingLevel: "high",
		// The codex account's models top out at medium — Pi clamps high down to medium there.
		thinkingCaps: { "openai-codex-account-2": "medium" },
	});

	await t.fire("session_start");
	await t.fire("agent_start");
	assert.equal(t.thinkingLevel(), "high");

	await t.command("next"); // → codex, where high is clamped to medium
	assert.equal(t.thinkingLevel(), "medium", "the host clamp is expected here");

	// The next turn starts on the clamped account. The clamp is the MODEL's cap, not the user's
	// choice: it must not become the new intent.
	await t.fire("agent_start");
	await t.command("next"); // → back to a provider that supports high
	assert.equal(
		t.thinkingLevel(),
		"high",
		`thinking must return to the user's level once a capable model is back: ${JSON.stringify(t.rec.thinkingLevels)}`,
	);
	assert.ok(
		!t.rec.thinkingLevels.includes("medium"),
		`the extension must never ASK for the clamped level: ${JSON.stringify(t.rec.thinkingLevels)}`,
	);
});

test("a mid-session /thinking change is honoured on the next turn and across failover", async () => {
	const t = setup({
		accounts: THINKING_ACCOUNTS,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		thinkingLevel: "high",
	});

	await t.fire("session_start");
	await t.fire("agent_start");
	assert.equal(t.thinkingLevel(), "high");

	t.userSetsThinking("low"); // user runs /thinking low between turns
	await t.fire("agent_start");
	assert.equal(
		t.thinkingLevel(),
		"low",
		`an explicit user choice must win over the previous level: ${JSON.stringify(t.rec.thinkingLevels)}`,
	);

	await t.command("next");
	assert.equal(
		t.thinkingLevel(),
		"low",
		"failover restores the user's CURRENT level, not the one from the first turn",
	);
});

test("an explicit reasoningLevel in config still forces that level on every turn", async () => {
	const t = setup({
		accounts: THINKING_ACCOUNTS,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		thinkingLevel: "low",
		config: { reasoningLevel: "high" }, // opt-in override
	});

	await t.fire("session_start");
	await t.fire("agent_start");

	assert.equal(
		t.thinkingLevel(),
		"high",
		"an explicitly configured level is an override and must be applied",
	);
});

test("manual next reaches an account blocked only by stale usage while free providers remain", async () => {
	const now = Date.now();
	const t = setup({
		accounts: {
			"openai-codex-account-2": {
				type: "oauth",
				access: "codex-access",
				refresh: "codex-refresh",
				accountId: "codex-account",
			},
			alibaba: { type: "api_key", key: "qwen-key" },
			ollama: { type: "api_key", key: "ollama-key" },
		},
		current: { provider: "alibaba", id: "qwen3.7-max" },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {},
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			usageByProvider: {
				"openai-codex-account-2": {
					provider: "openai-codex-account-2",
					family: "codex",
					fetchedAt: now - 7 * 24 * 60 * 60 * 1000,
					primary: {
						usedPercent: 100,
						resetAt: now + 30 * 24 * 60 * 60 * 1000,
					},
				},
			},
			lastSwitches: [],
		},
	});

	await t.fire("session_start");
	await t.command("next");
	await t.command("next");
	assert.deepEqual(t.rec.setModels.slice(-2), [
		"ollama/glm-5.2:cloud",
		"openai-codex-account-2/gpt-5.5",
	]);
});

test("manual next never downgrades to a weaker model of the same account (no mini flap)", async () => {
	// Real report: on gpt-5.4 with gpt-5.5 momentarily unavailable, repeated /multi-account next
	// flapped gpt-5.4 ↔ gpt-5.4-mini. HARD RULE: failover switches the ACCOUNT, never demotes the
	// model. With only one account whose flagship is unavailable, next must NOT drop to a weaker
	// model — it holds the current model and reports that there is nothing better to move to.
	const now = Date.now();
	const t = setup({
		accounts: {
			"openai-codex-account-2": {
				type: "oauth",
				access: "c",
				refresh: "cr",
				accountId: "codex-2",
			},
		},
		current: { provider: "openai-codex-account-2", id: "gpt-5.4" },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {},
			// The flagship gpt-5.5 is individually unavailable for a while; only weaker models
			// (gpt-5.4-mini, spark) are "free" — exactly the trap that produced the flap.
			exhaustedUntilByModel: {
				"openai-codex-account-2/gpt-5.5": now + 2 * 60 * 60 * 1000,
			},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			lastSwitches: [],
		},
	});
	await t.fire("session_start");
	for (let i = 0; i < 5; i++) await t.command("next");
	assert.ok(
		t.rec.setModels.every((m) => !/mini|spark/.test(m)),
		`next must never select a weaker model; setModels=${t.rec.setModels.join(",")}`,
	);
	assert.equal(
		t.ctx.model.id,
		"gpt-5.4",
		"the model must stay put rather than be auto-downgraded",
	);
});

test("manual next keeps every account selectable and always at its flagship model", async () => {
	// Real report: after pressing /multi-account next enough times, only openai stayed in the
	// queue. Cause: manual next cooled the account it left for 5 min, so after one lap every
	// account was "cooling" and the rotation collapsed. Manual rotation is a user override, not a
	// rate-limit event, so it must NOT record a cooldown — every account stays selectable.
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
			"anthropic-account-2": { type: "oauth", access: "a2", refresh: "a2r" },
			"openai-codex-account-2": {
				type: "oauth",
				access: "b",
				refresh: "br",
				accountId: "b",
			},
		},
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
	});
	await t.fire("session_start");
	const seen: string[] = [];
	for (let i = 0; i < 6; i++) {
		await t.command("next");
		seen.push(`${t.ctx.model.provider}/${t.ctx.model.id}`);
	}
	const live = Object.entries(
		t.readState().exhaustedUntilByProvider ?? {},
	).filter(([, until]) => (until as number) > Date.now());
	assert.equal(
		live.length,
		0,
		`manual next must not cool the account it leaves; live cooldowns=${JSON.stringify(live)}`,
	);
	assert.ok(
		new Set(seen.map((s) => s.split("/")[0])).size >= 3,
		`next must keep cycling through every account; visited=${seen.join(",")}`,
	);
	assert.ok(
		seen.every((s) => s.endsWith("/gpt-5.5") || s.endsWith("/claude-opus-5")),
		`every account must be offered at its flagship model; visited=${seen.join(",")}`,
	);
});

test("resume fires on whichever account recovers first, not rotation order", async () => {
	const accounts: Account = {
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
		"openai-codex-account-2": {
			type: "oauth",
			access: "b",
			refresh: "br",
			accountId: "b",
		},
	};
	// codex-2 (rotation slot 1) recovers FIRST; anthropic is the failed model, cooled long.
	const t = setup({
		accounts,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedCooldownsMsFromNow: { "openai-codex-account-2": 1000 },
	});
	await t.fire("session_start");
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	assert.ok(
		t.readState().pendingFrom && t.readState().pendingReason,
		"pending must be armed",
	);
	await wait(1400);
	assert.equal(
		t.rec.continueCalls.length,
		1,
		"work resumes when codex-2 recovers first",
	);
	assert.equal(t.rec.sent.length, 0);
	assert.equal(
		t.rec.setModels.at(-1),
		"openai-codex-account-2/gpt-5.5",
		"resume on the first-recovered account",
	);
});

test("a long over-estimated cooldown is corrected by fresh usage and resumes", async () => {
	const now = Date.now();
	const t = setup({
		accounts: ONE_ACCOUNT,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { pendingPollMs: 150 },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {},
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			// Fresh usage says the 5h window is empty — the account is actually free again.
			usageByProvider: {
				anthropic: {
					provider: "anthropic",
					family: "anthropic",
					fetchedAt: now,
					primary: { usedPercent: 0, resetAt: now - 1000 },
				},
			},
			lastSwitches: [],
		},
	});
	await t.fire("session_start");
	// 429 with no reset hint → recorded cooldown defaults to a long (6h) estimate.
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	assert.equal(
		t.rec.continueCalls.length,
		1,
		"usage reconciliation should resume immediately on the same account",
	);
	assert.equal(t.rec.sent.length, 0);
	// Without reconciliation this would sleep ~6h; usage shows recovery, so the next poll resumes.
	await wait(450);
	assert.equal(
		t.rec.continueCalls.length,
		1,
		"must resume once fresh usage shows the account recovered",
	);
});

test("a session limit the usage window can't see is not hot-retried every second", async () => {
	// Real report: an account 429'd "usage limit has been reached", but its usage-% window still
	// showed headroom (session/rate limits aren't in that window). The code trusted usage, reported
	// the account "free now", scheduled a ~1s retry, got 429 again, and looped — while the displayed
	// cooldown said hours. After the SECOND limit error the usage reading must be distrusted so the
	// account is benched (a real future recovery), not hot-retried.
	const now = Date.now();
	const t = setup({
		accounts: ONE_ACCOUNT,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { pendingPollMs: 40 },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {},
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			// Usage claims the account is free (primary window at 50%, reset far away) even though the
			// API keeps rejecting it — the exact "usage lies about a session limit" shape.
			usageByProvider: {
				anthropic: {
					provider: "anthropic",
					family: "anthropic",
					fetchedAt: now,
					primary: { usedPercent: 50, resetAt: now + 5 * 60 * 60 * 1000 },
				},
			},
			lastSwitches: [],
		},
	});
	await t.fire("session_start");
	await finishError(t, "anthropic", "claude-opus-4-8", "usage limit has been reached");
	await finishError(t, "anthropic", "claude-opus-4-8", "usage limit has been reached");
	// Let several poll cycles elapse. The lying "usage says free" must no longer wipe the recorded
	// cooldown, so the account stays benched with a real FUTURE recovery instead of being cleared and
	// hot-retried. (Old code deleted the cooldown via applyUsageToCooldown → state was empty.)
	await wait(260);
	const until = t.readState().exhaustedUntilByProvider?.anthropic;
	assert.ok(
		typeof until === "number" && until > Date.now() + 60_000,
		`a repeatedly session-limited account must stay benched with a real cooldown, got ${JSON.stringify(until)}`,
	);
	// And the paused session must wait for that real recovery, never announce a ~seconds retry.
	assert.ok(
		t.rec.notifies.some((m) => /retry automatically in ~\d+[hm]\b/.test(m)) &&
			!t.rec.notifies.some((m) => /retry automatically in ~\d+s\b/.test(m)),
		`must schedule the retry for the real recovery, not ~seconds; notifies=${t.rec.notifies.join(" | ")}`,
	);
});

// ---------------------------------------------------------------------------
// Bogus far-future cooldowns must never evict a live account for weeks (v1.13.7)
// Regression: a maxed long/rolling limit window (or a mis-parsed reset) recorded a
// weeks-away cooldown; the account was skipped forever because cooling-down accounts
// are never re-probed. openai-codex-account-2 was locked until Aug 3 in the wild.
// ---------------------------------------------------------------------------

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

test("a persisted far-future cooldown is clamped to the live ceiling on load", async () => {
	const now = Date.now();
	const provider = "openai-codex-account-2";
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedState: {
			stateVersion: 5,
			// 30 days away — the exact class of value seen in the wild (until 2026-08-03).
			exhaustedUntilByProvider: { [provider]: now + 30 * 24 * 60 * 60 * 1000 },
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			lastSwitches: [],
		},
	});
	await t.fire("session_start");
	// Force a persist of the clamped map via a normal failover cycle.
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	const until = t.readState().exhaustedUntilByProvider?.[provider];
	assert.ok(until, "the cooldown is clamped, not deleted");
	assert.ok(
		until <= now + SIX_HOURS_MS + 60_000,
		`far-future cooldown must be clamped to <= 6h, got ${(until - now) / 3600000}h`,
	);
});

test("a 429 whose error body carries a weeks-away resets_at is capped at the ceiling", async () => {
	const now = Date.now();
	const t = setup({
		accounts: ONE_ACCOUNT,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await t.fire("session_start");
	// resets_at is unix SECONDS; 30 days out. Taken literally this evicts the account for a month.
	const resetsAt = Math.floor(now / 1000) + 30 * 24 * 60 * 60;
	await finishError(
		t,
		"anthropic",
		"claude-opus-4-8",
		`429 rate limit {"resets_at": ${resetsAt}}`,
	);
	const until = t.readState().exhaustedUntilByProvider?.anthropic;
	assert.ok(until, "a cooldown is recorded");
	assert.ok(
		until <= now + SIX_HOURS_MS + 60_000,
		`live cooldown must be capped at 6h, got ${(until - now) / 3600000}h`,
	);
});

// ---------------------------------------------------------------------------
// Anthropic OAuth request shaping
// ---------------------------------------------------------------------------

test("OAuth-marked Anthropic payload gets one billing header", () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	const payload = {
		model: "claude-opus-4-8",
		stream: true,
		messages: [{ role: "user", content: "hello world this is a test message" }],
		system: [
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for working.",
			},
		],
	};
	const once = t.beforeReq(payload) as any;
	assert.match(once.system[0].text, /^x-anthropic-billing-header:/);
	// Pinned to the constant in index.ts, never a literal: the weekly version-check workflow bumps
	// that constant, and a hardcoded copy here would turn every automated bump into a red CI run.
	const expectedCcVersion = readFileSync(
		new URL("../index.ts", import.meta.url),
		"utf8",
	).match(/CLAUDE_CODE_VERSION = "([^"]+)"/)![1]!;
	assert.ok(
		once.system[0].text.includes(`cc_version=${expectedCcVersion}.`),
		`billing header must carry CLAUDE_CODE_VERSION (${expectedCcVersion}), got: ${once.system[0].text}`,
	);
	const billingCount = (system: any[]) =>
		system.filter((block) => /x-anthropic-billing-header:/.test(block.text))
			.length;
	assert.equal(billingCount(once.system), 1);
	assert.equal(
		billingCount((t.beforeReq(once) as any).system),
		1,
		"shaping is idempotent",
	);
});

test("non-OAuth Anthropic payload is unchanged", () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	const payload = {
		model: "claude-opus-4-8",
		stream: true,
		messages: [{ role: "user", content: "hi" }],
		system: [{ type: "text", text: "Normal system prompt." }],
	};
	assert.deepEqual(t.beforeReq(payload), payload);
});

// ---------------------------------------------------------------------------
// OAuth refresh merge — the base provider and aliases must share this logic so a
// refreshed access token is never silently dropped (which 401s an account to death).
// ---------------------------------------------------------------------------

test("a refresh replaces the stale access token (not just the refresh token)", () => {
	const merged = mergeRefreshedCredentials(
		{ type: "oauth", access: "STALE", refresh: "OLD-R", expires: 1 },
		{ access: "FRESH", refresh: "NEW-R", expires: 2 },
	);
	assert.equal(
		merged.access,
		"FRESH",
		"the refreshed access token must win — dropping it 401s forever",
	);
	assert.equal(merged.refresh, "NEW-R");
	assert.equal(merged.expires, 2);
});

test("a refresh keeps the old refresh token when the provider mints no new one", () => {
	const merged = mergeRefreshedCredentials(
		{ type: "oauth", access: "STALE", refresh: "KEEP-ME" },
		{ access: "FRESH", refresh: "   " },
	);
	assert.equal(merged.access, "FRESH");
	assert.equal(
		merged.refresh,
		"KEEP-ME",
		"a blank refresh from the provider must not wipe the working one",
	);
});

// ---------------------------------------------------------------------------
// v1.9.0 regressions:
//  - invalidated accounts no longer carry a 365-day cooldown entry
//  - /multi-account revive restores an account to rotation
//  - api_key providers (Ollama, Alibaba) survive a transient 401 without being
//    killed for a year (only terminal auth patterns invalidate immediately)
//  - Ollama/Alibaba alias slots (ollama-account-2, alibaba-account-2) are
//    discovered and join the rotation just like OAuth alias slots.
// ---------------------------------------------------------------------------

test("invalidation no longer writes a 365-day cooldown entry", async () => {
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
		},
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { autoContinue: false },
	});
	// Force a terminal invalidation: "invalid api key" matches TERMINAL_AUTH_ERROR_PATTERNS.
	await finishError(t, "anthropic", "claude-opus-4-8", "invalid api key");
	assert.ok(t.readState().invalidatedByProvider?.anthropic);
	// The cooldown map must NOT contain an ~365-day entry for the invalidated account.
	const until = t.readState().exhaustedUntilByProvider?.anthropic;
	assert.ok(
		until === undefined,
		`invalidation must not pollute cooldowns (found ${until})`,
	);
});

test("/multi-account revive restores an invalidated account to rotation", async () => {
	const accounts = {
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
		"openai-codex-account-2": {
			type: "oauth",
			access: "live-2",
			refresh: "refresh-2",
			accountId: "codex-2",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: {
			autoContinue: false,
			autoDiscover: true,
			fallbacks: ["anthropic", "openai-codex-account-2"],
		},
	});
	// Kill anthropic with a terminal pattern.
	await finishError(t, "anthropic", "claude-opus-4-8", "invalid api key");
	assert.ok(t.readState().invalidatedByProvider?.anthropic);
	// Revive it.
	await t.command("revive anthropic");
	assert.ok(
		!t.readState().invalidatedByProvider?.anthropic,
		"revive must clear the invalidation",
	);
});

test("an api_key provider's bare 401 is transient, not a year-long kill", async () => {
	const accounts = {
		ollama: { type: "api_key", key: "ollama-key" },
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
	};
	const t = setup({
		accounts,
		current: { provider: "ollama", id: "glm-5.2:cloud" },
		config: {
			autoContinue: false,
			autoDiscover: true,
			fallbacks: ["ollama", "anthropic"],
		},
	});
	// A transient 401 (not "invalid api key", just "401 unauthorized") must NOT
	// immediately invalidate an api_key slot.
	await finishError(t, "ollama", "glm-5.2:cloud", "401 unauthorized");
	assert.ok(
		!t.readState().invalidatedByProvider?.ollama,
		"a bare 401 on an api_key provider must not kill it for a year",
	);
	// It SHOULD be on a short transient cooldown so selection skips it briefly.
	const until = t.readState().exhaustedUntilByProvider?.ollama ?? 0;
	assert.ok(
		until > Date.now() && until - Date.now() <= 120_000,
		`api_key transient cooldown should be brief (sub-2min), got ${until - Date.now()}ms`,
	);
});

test("Ollama alias slots (ollama-account-2) join the rotation", async () => {
	const accounts = {
		ollama: { type: "api_key", key: "k1" },
		"ollama-account-2": { type: "api_key", key: "k2" },
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
	};
	const t = setup({
		accounts,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: {
			autoDiscover: true,
			fallbacks: ["anthropic", "ollama", "ollama-account-2"],
		},
	});
	await t.fire("session_start", { reason: "startup" });
	// The startup notify reports "<N> account(s) in rotation" — with ollama +
	// ollama-account-2 + anthropic all authed, N must be 3.
	const startup = t.rec.notifies.find((m) =>
		m.includes("account(s) in rotation"),
	);
	assert.ok(startup, "session_start must report rotation size");
	assert.ok(
		/3 account\(s\) in rotation/.test(startup),
		`expected 3 accounts in rotation, got: ${startup}`,
	);
	// And a real failover lands on an ollama-family provider.
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate_limit_error");
	const switchedToOllama = t.rec.setModels.some(
		(m) => m.startsWith("ollama") || m.startsWith("ollama-account-"),
	);
	assert.ok(
		switchedToOllama,
		"a 429 on anthropic must fail over to an ollama-family slot",
	);
});

test("Alibaba/Qwen alias slots (alibaba-account-2) join the rotation", async () => {
	const accounts = {
		alibaba: { type: "api_key", key: "k1" },
		"alibaba-account-2": { type: "api_key", key: "k2" },
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
	};
	const t = setup({
		accounts,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: {
			autoDiscover: true,
			fallbacks: ["anthropic", "alibaba", "alibaba-account-2"],
		},
	});
	await t.fire("session_start", { reason: "startup" });
	const startup = t.rec.notifies.find((m) =>
		m.includes("account(s) in rotation"),
	);
	assert.ok(startup, "session_start must report rotation size");
	assert.ok(
		/3 account\(s\) in rotation/.test(startup),
		`expected 3 accounts in rotation, got: ${startup}`,
	);
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate_limit_error");
	const switchedToQwen = t.rec.setModels.some(
		(m) => m.startsWith("alibaba") || m.startsWith("alibaba-account-"),
	);
	assert.ok(
		switchedToQwen,
		"a 429 on anthropic must fail over to an alibaba/qwen-family slot",
	);
});

test("Kimi alias slots (kimi-coding-account-2) join the rotation", async () => {
	const accounts = {
		"kimi-coding": { type: "oauth", access: "k1", refresh: "kr1" },
		"kimi-coding-account-2": { type: "oauth", access: "k2", refresh: "kr2" },
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
	};
	const t = setup({
		accounts,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: {
			autoDiscover: true,
			fallbacks: ["anthropic", "kimi-coding", "kimi-coding-account-2"],
		},
	});
	await t.fire("session_start", { reason: "startup" });
	const startup = t.rec.notifies.find((m) =>
		m.includes("account(s) in rotation"),
	);
	assert.ok(startup, "session_start must report rotation size");
	assert.ok(
		/3 account\(s\) in rotation/.test(startup),
		`expected 3 accounts in rotation, got: ${startup}`,
	);
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate_limit_error");
	const switchedToKimi = t.rec.setModels.some((m) => m.startsWith("kimi-coding"));
	assert.ok(
		switchedToKimi,
		`a 429 on anthropic must fail over to a Kimi slot, got: ${t.rec.setModels.join(", ")}`,
	);
});

test("a Kimi subscription slot is registered so /login can offer it", async () => {
	// The whole point of `add kimi`: the NEXT free slot must exist as a real provider
	// before the user runs /login, or the picker has nothing to select.
	const t = setup({
		accounts: {
			"kimi-coding": { type: "oauth", access: "k1", refresh: "kr1" },
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
		},
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await t.fire("session_start");
	const slot = t.providerConfigs.get("kimi-coding-account-2");
	assert.ok(slot, "the spare Kimi slot must be registered as a provider");
	assert.equal(slot.baseUrl, "https://api.kimi.com/coding");
	assert.equal(slot.api, "anthropic-messages");
	assert.ok(
		slot.models.some((model: any) => model.id === "k3"),
		"the slot must carry Kimi's own catalog, not an empty model list",
	);
	assert.equal(
		slot.oauth.isSubscription,
		true,
		"it must present as a subscription login, not an API key",
	);
	assert.equal(
		typeof slot.oauth.login,
		"function",
		"/login needs a real login flow on the slot",
	);
	assert.equal(
		slot.oauth.getApiKey({ type: "oauth", access: "tok", refresh: "r" }),
		"tok",
		"requests must authenticate with THIS slot's access token",
	);
	// The base provider is Pi's own; the extension must not shadow it.
	assert.equal(
		t.providerConfigs.has("kimi-coding"),
		false,
		"the native base Kimi provider must be left alone",
	);
});

test("session_start restores lastUserModel after Pi falls back to anthropic/claude-opus-4-8", async () => {
	installCursorProvider();
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
			cursor: { type: "oauth", access: "c", refresh: "cr" },
		},
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		thinkingLevel: "high",
		modelSetThinkingLevel: "low",
		config: { includeCursor: true, fallbacks: ["anthropic", "cursor"] },
		seedState: {
			stateVersion: 5,
			lastUserModel: { provider: "cursor", id: "cursor-grok-4.6" },
			lastUserThinkingLevel: "high",
			lastModelByFamily: { cursor: "cursor-grok-4.6" },
			exhaustedUntilByProvider: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			lastSwitches: [],
		},
	});
	await t.fire("session_start", { reason: "startup" });
	assert.deepEqual(
		t.ctx.model,
		{ provider: "cursor", id: "cursor-grok-4.6" },
		`startup must put the session back on the last live model, not Pi's anthropic default; setModels=${t.rec.setModels.join(",")}`,
	);
	assert.equal(t.thinkingLevel(), "high");
	uninstallCursorProvider();
});

test("explicit CLI model wins over remembered startup state and is not remembered on shutdown", async () => {
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
			"openai-codex-account-2": {
				type: "oauth",
				access: "c",
				refresh: "cr",
				accountId: "codex-2",
			},
		},
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		thinkingLevel: "high",
		config: { enabled: false },
		cliArgs: ["--model", "openai-codex-account-2/gpt-5.5"],
		seedState: {
			stateVersion: 5,
			lastUserModel: { provider: "anthropic", id: "claude-opus-4-8" },
			lastUserThinkingLevel: "low",
			lastModelByFamily: { anthropic: "claude-opus-4-8" },
			lastSwitches: [],
		},
	});
	await t.fire("session_start", { reason: "startup" });
	assert.deepEqual(t.ctx.model, {
		provider: "openai-codex-account-2",
		id: "gpt-5.5",
	});
	assert.equal(t.thinkingLevel(), "high");
	assert.ok(!t.rec.notifies.some((message) => message.includes("restored")));
	await t.fire("session_shutdown");
	assert.deepEqual(t.readState().lastUserModel, {
		provider: "anthropic",
		id: "claude-opus-4-8",
	});
	assert.equal(t.readState().lastUserThinkingLevel, "low");
});

test("explicit CLI model thinking is catalog-resolved before startup fallback", async (suite) => {
	const provider = "openai-codex";
	const base = "acme:model/v1.2+fast@2026-09-01";
	for (const scenario of [
		{
			name: "a complete real model ID ending in :high wins",
			models: [`${base}:high`],
			currentId: `${base}:high`,
			cliArgs: ["--model", `${provider}/${base}:high`],
			expectedThinking: "low",
		},
		{
			name: "a valid suffix applies when the stripped model resolves",
			models: [base],
			currentId: base,
			cliArgs: ["--model", `${provider}/${base}:high`],
			expectedThinking: "high",
		},
		{
			name: "a valid suffix applies to a recognized-provider custom model",
			models: [base],
			currentId: "future-model",
			cliArgs: ["--model", `${provider}/future-model:high`],
			expectedThinking: "high",
		},
		{
			name: "--provider custom model shorthand follows the same resolution",
			models: [base],
			currentId: "future-model",
			cliArgs: ["--provider", provider, "--model", "future-model:high"],
			expectedThinking: "high",
		},
		{
			name: "an invalid suffix is not a thinking override",
			models: [base],
			currentId: `${base}:turbo`,
			cliArgs: ["--model", `${provider}/${base}:turbo`],
			expectedThinking: "low",
		},
		{
			name: "standalone --thinking takes precedence",
			models: [base],
			currentId: base,
			cliArgs: ["--thinking", "high", "--model", `${provider}/${base}:low`],
			expectedThinking: "high",
		},
		{
			name: "invalid standalone --thinking does not suppress model shorthand",
			models: [base],
			currentId: base,
			cliArgs: ["--thinking", "invalid", "--model", `${provider}/${base}:high`],
			expectedThinking: "high",
		},
	]) {
		await suite.test(scenario.name, async () => {
			const t = setup({
				accounts: {
					[provider]: { type: "api_key" },
					anthropic: { type: "oauth", access: "a", refresh: "ar" },
				},
				hostCodexModels: scenario.models,
				current: { provider, id: scenario.currentId },
				thinkingLevel: "medium",
				modelSetThinkingLevel: "low",
				config: { fallbacks: ["anthropic"] },
				cliArgs: scenario.cliArgs,
			});
			await t.fire("session_start", { reason: "startup" });
			assert.equal(
				t.ctx.model.provider,
				"anthropic",
				"the unavailable launch model must fall back before agent_start",
			);
			assert.equal(t.thinkingLevel(), scenario.expectedThinking);
			await t.fire("session_shutdown");
		});
	}
});

test("explicit CLI thinking wins while ordinary model restoration remains enabled", async () => {
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
			"openai-codex-account-2": {
				type: "oauth",
				access: "c",
				refresh: "cr",
				accountId: "codex-2",
			},
		},
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		thinkingLevel: "high",
		modelSetThinkingLevel: "low",
		config: { enabled: false },
		cliArgs: ["--thinking", "high"],
		seedState: {
			stateVersion: 5,
			lastUserModel: {
				provider: "openai-codex-account-2",
				id: "gpt-5.5",
			},
			lastUserThinkingLevel: "medium",
			lastModelByFamily: { "openai-codex": "gpt-5.5" },
			lastSwitches: [],
		},
	});
	await t.fire("session_start", { reason: "startup" });
	assert.deepEqual(t.ctx.model, {
		provider: "openai-codex-account-2",
		id: "gpt-5.5",
	});
	assert.equal(t.thinkingLevel(), "high");
	assert.deepEqual(t.rec.thinkingLevels, ["high"]);
	await t.setModel("anthropic", "claude-opus-4-8");
	await t.fire("session_shutdown");
	assert.deepEqual(t.readState().lastUserModel, {
		provider: "anthropic",
		id: "claude-opus-4-8",
	});
	assert.equal(t.readState().lastUserThinkingLevel, "medium");
});

test("internal thinking restores do not become explicit CLI intent", async (suite) => {
	for (const delivery of ["sync", "delayed"] as const) {
		await suite.test(`${delivery} thinking event delivery`, async () => {
			const t = setup({
				accounts: {
					anthropic: { type: "oauth", access: "a", refresh: "ar" },
				},
				current: { provider: "anthropic", id: "claude-opus-4-8" },
				thinkingLevel: "low",
				thinkingLevelSelectDelivery: delivery,
				config: { enabled: false },
				cliArgs: ["--thinking", "high"],
				seedState: {
					stateVersion: 5,
					lastUserModel: { provider: "anthropic", id: "claude-opus-4-8" },
					lastUserThinkingLevel: "medium",
					lastModelByFamily: { anthropic: "claude-opus-4-8" },
					lastSwitches: [],
				},
			});
			await t.fire("session_start", { reason: "startup" });
			assert.equal(t.thinkingLevel(), "high");
			assert.equal(
				t.readState().lastUserThinkingLevel,
				"medium",
				"the extension's own restore must not persist the one-shot CLI level",
			);

			// For delayed delivery, make the genuine identical low -> high transition arrive first.
			t.userSetsThinking("low");
			await t.fire("thinking_level_select", {
				level: "low",
				previousLevel: "high",
			});
			t.userSetsThinking("high");
			await t.fire("thinking_level_select", {
				level: "high",
				previousLevel: "low",
			});
			assert.equal(
				t.readState().lastUserThinkingLevel,
				"high",
				"the genuine identical choice must be recorded before delayed internal delivery",
			);
			await t.settleThinkingLevelSelects();
			await t.fire("session_shutdown");
			assert.equal(
				t.readState().lastUserThinkingLevel,
				"high",
				"a later genuine identical choice must take ownership of thinking intent",
			);
		});
	}
});

test("native model thinking resets do not become explicit CLI intent", async (suite) => {
	for (const delivery of ["before", "after"] as const) {
		await suite.test(`${delivery} model_select delivery`, async () => {
			const t = setup({
				accounts: {
					anthropic: { type: "oauth", access: "a", refresh: "ar" },
					"openai-codex-account-2": {
						type: "oauth",
						access: "c",
						refresh: "cr",
						accountId: "codex-2",
					},
				},
				current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
				thinkingLevel: "high",
				modelSetThinkingLevel: "low",
				modelThinkingLevelSelectDelivery: delivery,
				config: { enabled: false },
				cliArgs: ["--model", "openai-codex-account-2/gpt-5.5"],
				seedState: {
					stateVersion: 5,
					lastUserModel: { provider: "anthropic", id: "claude-opus-4-8" },
					lastUserThinkingLevel: "high",
					lastModelByFamily: { anthropic: "claude-opus-4-8" },
					lastSwitches: [],
				},
			});
			await t.fire("session_start", { reason: "startup" });
			await t.setModel("anthropic", "claude-opus-4-8");
			await t.settleThinkingLevelSelects();
			assert.equal(t.thinkingLevel(), "low");
			assert.equal(
				t.readState().lastUserThinkingLevel,
				"high",
				"the model's native reset must not become remembered user intent",
			);

			// Recreate the same high -> low key after its one-shot evidence was consumed.
			t.userSetsThinking("high");
			await t.fire("thinking_level_select", {
				level: "high",
				previousLevel: "low",
			});
			t.userSetsThinking("low");
			await t.fire("thinking_level_select", {
				level: "low",
				previousLevel: "high",
			});
			await t.fire("session_shutdown");
			assert.deepEqual(t.readState().lastUserModel, {
				provider: "anthropic",
				id: "claude-opus-4-8",
			});
			assert.equal(
				t.readState().lastUserThinkingLevel,
				"low",
				"a later genuine identical choice must not be hidden",
			);
		});
	}
});

test("explicit CLI model can be replaced by a genuine thinking selection only", async () => {
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
			"openai-codex-account-2": {
				type: "oauth",
				access: "c",
				refresh: "cr",
				accountId: "codex-2",
			},
		},
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		thinkingLevel: "high",
		config: { enabled: false },
		cliArgs: ["--model", "openai-codex-account-2/gpt-5.5"],
		seedState: {
			stateVersion: 5,
			lastUserModel: { provider: "anthropic", id: "claude-opus-4-8" },
			lastUserThinkingLevel: "low",
			lastModelByFamily: { anthropic: "claude-opus-4-8" },
			lastSwitches: [],
		},
	});
	await t.fire("session_start", { reason: "startup" });
	t.userSetsThinking("medium");
	await t.fire("thinking_level_select", {
		level: "medium",
		previousLevel: "high",
	});
	await t.fire("session_shutdown");
	assert.deepEqual(t.readState().lastUserModel, {
		provider: "anthropic",
		id: "claude-opus-4-8",
	});
	assert.equal(t.readState().lastUserThinkingLevel, "medium");
});

test("no-session explicit launch neither restores nor overwrites the global preference", async () => {
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
			"openai-codex-account-2": {
				type: "oauth",
				access: "c",
				refresh: "cr",
				accountId: "codex-2",
			},
		},
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		thinkingLevel: "high",
		config: { enabled: false },
		cliArgs: [
			"--no-session",
			"--model",
			"openai-codex-account-2/gpt-5.5",
			"--thinking",
			"high",
		],
		seedState: {
			stateVersion: 5,
			lastUserModel: { provider: "anthropic", id: "claude-opus-4-8" },
			lastUserThinkingLevel: "low",
			lastModelByFamily: { anthropic: "claude-opus-4-8" },
			lastSwitches: [],
		},
	});
	await t.fire("session_start", { reason: "startup" });
	assert.deepEqual(t.ctx.model, {
		provider: "openai-codex-account-2",
		id: "gpt-5.5",
	});
	await t.fire("session_shutdown");
	assert.deepEqual(t.readState().lastUserModel, {
		provider: "anthropic",
		id: "claude-opus-4-8",
	});
	assert.equal(t.readState().lastUserThinkingLevel, "low");
});

test("explicit CLI preference can be replaced by a genuine user model selection", async () => {
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
			"openai-codex-account-2": {
				type: "oauth",
				access: "c",
				refresh: "cr",
				accountId: "codex-2",
			},
		},
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		thinkingLevel: "high",
		config: { enabled: false },
		cliArgs: ["--model", "openai-codex-account-2/gpt-5.5"],
		seedState: {
			stateVersion: 5,
			lastUserModel: { provider: "anthropic", id: "claude-opus-4-8" },
			lastUserThinkingLevel: "low",
			lastModelByFamily: { anthropic: "claude-opus-4-8" },
			lastSwitches: [],
		},
	});
	await t.fire("session_start", { reason: "startup" });
	t.setCurrent("anthropic", "claude-opus-4-8");
	await t.fire("model_select", {
		model: { provider: "anthropic", id: "claude-opus-4-8" },
		previousModel: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		source: "set",
	});
	await t.fire("session_shutdown");
	assert.deepEqual(t.readState().lastUserModel, {
		provider: "anthropic",
		id: "claude-opus-4-8",
	});
});

test("manual rotation commands own the model preference after an explicit CLI launch", async (suite) => {
	for (const command of ["next", "switch anthropic", "best"]) {
		await suite.test(command, async () => {
			const t = setup({
				accounts: {
					anthropic: { type: "oauth", access: "a", refresh: "ar" },
					"openai-codex-account-2": {
						type: "oauth",
						access: "c",
						refresh: "cr",
						accountId: "codex-2",
					},
				},
				current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
				thinkingLevel: "high",
				cliArgs: ["--model", "openai-codex-account-2/gpt-5.5"],
				seedState: {
					stateVersion: 5,
					lastUserModel: { provider: "alibaba", id: "qwen3.7-max" },
					lastUserThinkingLevel: "low",
					lastModelByFamily: { qwen: "qwen3.7-max" },
					lastSwitches: [],
				},
			});
			await t.fire("session_start", { reason: "startup" });
			await t.command(command);
			assert.notEqual(t.ctx.model.provider, "openai-codex-account-2");
			await t.fire("session_shutdown");
			assert.deepEqual(t.readState().lastUserModel, t.ctx.model);
			assert.equal(
				t.readState().lastUserThinkingLevel,
				"low",
				"a manual model choice must not take ownership of thinking",
			);
		});
	}
});

test("manual no-op choices own the model preference after an explicit CLI launch", async (suite) => {
	for (const command of ["best", "switch openai-codex-account-2/gpt-5.5"]) {
		await suite.test(command, async () => {
			const current = { provider: "openai-codex-account-2", id: "gpt-5.5" };
			const t = setup({
				accounts: {
					"openai-codex-account-2": {
						type: "oauth",
						access: "c",
						refresh: "cr",
						accountId: "codex-2",
					},
				},
				current,
				thinkingLevel: "high",
				cliArgs: ["--model", `${current.provider}/${current.id}`],
				seedState: {
					stateVersion: 5,
					lastUserModel: { provider: "anthropic", id: "claude-opus-4-8" },
					lastUserThinkingLevel: "low",
					lastModelByFamily: { anthropic: "claude-opus-4-8" },
					lastSwitches: [],
				},
			});
			await t.fire("session_start", { reason: "startup" });
			await t.command(command);
			await t.fire("session_shutdown");
			assert.deepEqual(t.readState().lastUserModel, current);
			assert.equal(t.readState().lastUserThinkingLevel, "low");
		});
	}
});

test("pi-subagents child keeps its explicit launch model and delegates fallback to the parent runner", async () => {
	const t = setup({
		accounts: {
			qoder: { type: "api_key", key: "qoder-key" },
			"openai-codex-account-2": {
				type: "oauth",
				access: "codex-token",
				refresh: "codex-refresh",
				accountId: "codex-2",
			},
		},
		current: { provider: "qoder", id: "qfmodel" },
		thinkingLevel: "high",
		subagentChild: true,
		settings: {
			defaultProvider: "openai-codex-account-2",
			defaultModel: "gpt-5.6-sol",
		},
		seedState: {
			stateVersion: 5,
			lastUserModel: {
				provider: "openai-codex-account-2",
				id: "gpt-5.6-sol",
			},
			lastUserThinkingLevel: "medium",
			lastModelByFamily: { "openai-codex": "gpt-5.6-sol" },
			exhaustedUntilByProvider: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			lastSwitches: [],
			pendingFrom: "openai-codex-account-2/gpt-5.6-sol",
			pendingReason: "parent session is waiting for quota reset",
			pendingSince: 123,
			pendingOwner: "parent-session-fixture",
		},
	});
	const authBeforeChild = readFileSync(AUTH, "utf8");
	const modelsBeforeChild = existsSync(MODELS)
		? readFileSync(MODELS, "utf8")
		: undefined;

	await t.fire("session_start", { reason: "startup" });
	assert.equal(
		t.readState().pendingFrom,
		"openai-codex-account-2/gpt-5.6-sol",
		"child startup must preserve the parent's persisted pending recovery",
	);
	assert.deepEqual(t.ctx.model, { provider: "qoder", id: "qfmodel" });
	assert.equal(t.thinkingLevel(), "high");
	assert.deepEqual(
		t.rec.setModels,
		[],
		"child startup must not restore the parent process's remembered model",
	);
	assert.equal(
		readFileSync(AUTH, "utf8"),
		authBeforeChild,
		"a delegated child must not replace shared OAuth credentials with proxy placeholders",
	);
	assert.equal(
		existsSync(MODELS) ? readFileSync(MODELS, "utf8") : undefined,
		modelsBeforeChild,
		"a delegated child must not publish its short-lived routes into shared models.json",
	);
	const localCodex = t.providerConfigs.get("openai-codex-account-2");
	assert.match(String(localCodex?.baseUrl), /^http:\/\/127\.0\.0\.1:\d+\//);
	assert.equal(
		(
			await callProxy(localCodex.baseUrl, "/codex/responses", {
				authorization: "Bearer deliberately-wrong",
			})
		).status,
		401,
		"the child still needs a process-local route for the exact provider it was launched on",
	);
	assert.equal(
		t.readState().pendingFrom,
		"openai-codex-account-2/gpt-5.6-sol",
		"serving a child proxy request must preserve the parent's pending recovery",
	);

	await t.fire("before_agent_start");
	assert.equal(
		t.readState().pendingFrom,
		"openai-codex-account-2/gpt-5.6-sol",
		"starting the child turn must not clear the parent's persisted pending recovery",
	);
	await finishError(t, "qoder", "qfmodel", "429 rate limit");
	assert.deepEqual(
		t.rec.setModels,
		[],
		"child errors must surface to pi-subagents instead of starting a competing failover chain",
	);
	assert.equal(t.rec.continueCalls.length, 0);
	assert.equal(t.rec.sent.length, 0);
	await t.fire("model_select", {
		model: { provider: "qoder", id: "qfmodel" },
		source: "set",
	});
	await t.fire("session_shutdown");
	assert.equal(readFileSync(AUTH, "utf8"), authBeforeChild);
	assert.equal(
		existsSync(MODELS) ? readFileSync(MODELS, "utf8") : undefined,
		modelsBeforeChild,
		"child shutdown must not restore or unpublish files it never owned",
	);
	assert.equal(
		t.readState().pendingFrom,
		"openai-codex-account-2/gpt-5.6-sol",
		"a delegated child must not clear the parent process's pending recovery",
	);
	assert.equal(
		t.readState().pendingReason,
		"parent session is waiting for quota reset",
	);
});

test("session_start restores settings.json default when lastUserModel is missing", async () => {
	installCursorProvider();
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
			cursor: { type: "oauth", access: "c", refresh: "cr" },
		},
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { includeCursor: true, fallbacks: ["anthropic", "cursor"] },
		settings: {
			defaultProvider: "cursor",
			defaultModel: "cursor-grok-4.6",
		},
	});
	await t.fire("session_start", { reason: "startup" });
	assert.deepEqual(
		t.ctx.model,
		{ provider: "cursor", id: "cursor-grok-4.6" },
		`settings.json default must win over Pi's anthropic fallback; setModels=${t.rec.setModels.join(",")}`,
	);
	uninstallCursorProvider();
});

test("startup preflight restores lastUserModel instead of failing over Pi's accidental kimi fallback", async () => {
	installCursorProvider();
	const t = setup({
		accounts: {
			"kimi-coding": { type: "oauth", access: "k", refresh: "kr" },
			cursor: { type: "oauth", access: "c", refresh: "cr" },
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
		},
		current: { provider: "kimi-coding", id: "k3" },
		config: {
			includeCursor: true,
			fallbacks: ["kimi-coding", "anthropic", "cursor"],
		},
		seedState: {
			stateVersion: 5,
			lastUserModel: { provider: "cursor", id: "cursor-grok-4.6" },
			lastModelByFamily: { cursor: "cursor-grok-4.6" },
			exhaustedUntilByProvider: { "kimi-coding": Date.now() + 60 * 60 * 1000 },
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			lastSwitches: [],
		},
	});
	await t.fire("session_start", { reason: "startup" });
	assert.deepEqual(
		t.ctx.model,
		{ provider: "cursor", id: "cursor-grok-4.6" },
		`kimi-on-cooldown must not steal startup; Pi's fallback is not the user's model; setModels=${t.rec.setModels.join(",")}`,
	);
	uninstallCursorProvider();
});

test("a state-version migration still remembers the last live model", async () => {
	installCursorProvider();
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
			cursor: { type: "oauth", access: "c", refresh: "cr" },
		},
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { includeCursor: true, fallbacks: ["anthropic", "cursor"] },
		seedState: {
			stateVersion: 3,
			lastUserModel: { provider: "cursor", id: "cursor-grok-4.6" },
			lastModelByFamily: { cursor: "cursor-grok-4.6" },
			exhaustedUntilByProvider: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			lastSwitches: [],
		},
	});
	await t.fire("session_start", { reason: "startup" });
	assert.deepEqual(
		t.ctx.model,
		{ provider: "cursor", id: "cursor-grok-4.6" },
		`migrating state must keep lastUserModel; setModels=${t.rec.setModels.join(",")}`,
	);
	uninstallCursorProvider();
});

test("a logged-in kimi slot is provisioned into models.json so bare children resolve it natively", async () => {
	const t = setup({
		accounts: {
			"kimi-coding": { type: "oauth", access: "k", refresh: "kr" },
			"kimi-coding-account-2": { type: "oauth", access: "k2", refresh: "kr2" },
		},
	});
	await t.fire("session_start");
	const modelsJson = JSON.parse(readFileSync(MODELS, "utf8"));
	const slot = modelsJson.providers?.["kimi-coding-account-2"];
	assert.ok(slot, "kimi-coding-account-2 must be provisioned into models.json");
	assert.equal(slot.api, "anthropic-messages");
	assert.equal(slot.baseUrl, "https://api.kimi.com/coding");
	assert.ok(
		Array.isArray(slot.models) &&
			slot.models.every(
				(model: unknown) =>
					!!model &&
					typeof model === "object" &&
					typeof (model as { id?: unknown }).id === "string",
			),
		"Pi's models.json schema requires model objects, not string ids",
	);
	assert.ok(slot.models.some((model: { id: string }) => model.id === "k3"));
	// settings.json untouched — Pi owns defaults; we only provision resolution data.
	assert.equal(existsSync(SETTINGS), false);
});

test("string model ids already in models.json are rewritten as objects", async () => {
	writeFileSync(
		MODELS,
		JSON.stringify({
			providers: {
				"kimi-coding-account-2": {
					api: "anthropic-messages",
					baseUrl: "https://api.kimi.com/coding",
					models: ["k3", "k3-256k"],
				},
			},
		}),
	);
	const t = setup({
		accounts: {
			"kimi-coding-account-2": { type: "oauth", access: "k2", refresh: "kr2" },
		},
	});
	await t.fire("session_start");
	const slot = JSON.parse(readFileSync(MODELS, "utf8")).providers[
		"kimi-coding-account-2"
	];
	assert.ok(
		slot.models.every(
			(model: unknown) =>
				!!model &&
				typeof model === "object" &&
				typeof (model as { id?: unknown }).id === "string",
		),
	);
	assert.ok(slot.models.some((model: { id: string }) => model.id === "k3"));
});

test("a failover switch never rewrites settings.json — the user's base config stays in base form", async () => {
	const t = setup({
		accounts: {
			"kimi-coding-account-2": { type: "oauth", access: "k2", refresh: "kr2" },
		},
		current: { provider: "kimi-coding-account-2", id: "k3" },
		settings: { defaultProvider: "cursor", defaultModel: "cursor-grok-4.6" },
	});
	await t.fire("model_select", {
		model: { provider: "kimi-coding-account-2", id: "k3" },
	});
	const settings = JSON.parse(readFileSync(SETTINGS, "utf8"));
	assert.equal(settings.defaultProvider, "cursor");
	assert.equal(settings.defaultModel, "cursor-grok-4.6");
});

test("session_shutdown remembers the live model so the next start can restore it", async () => {
	const t = setup({
		accounts: {
			cursor: { type: "oauth", access: "c", refresh: "cr" },
		},
		current: { provider: "cursor", id: "cursor-grok-4.6" },
	});
	await t.fire("session_shutdown");
	const state = t.readState();
	assert.deepEqual(state.lastUserModel, {
		provider: "cursor",
		id: "cursor-grok-4.6",
	});
	assert.equal(state.lastModelByFamily?.cursor, "cursor-grok-4.6");
});

test("add kimi points at the interactive subscription login, not a manual api key", async () => {
	const t = setup({
		accounts: {
			"kimi-coding": { type: "oauth", access: "k1", refresh: "kr1" },
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
		},
	});
	await t.fire("session_start");
	await t.command("add kimi");
	const notice = t.rec.notifies.at(-1) ?? "";
	assert.match(notice, /kimi-coding-account-2/);
	assert.match(notice, /\/login/);
	assert.doesNotMatch(
		notice,
		/auth\.json/,
		"Kimi has a device-code OAuth flow; telling the user to paste an API key by hand was the bug",
	);
});

test("only-active narrows /model to the active account and persists", async () => {
	const t = setup({
		accounts: TWO_ACCOUNTS,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await t.fire("session_start");
	await t.command("only-active on");
	const codex = [...t.rec.registrations]
		.reverse()
		.find((r) => r.provider === "openai-codex-account-2");
	assert.equal(codex?.models, 0, "the inactive codex slot must be hidden");
	const anthropic = [...t.rec.registrations]
		.reverse()
		.find((r) => r.provider === "anthropic");
	assert.notEqual(anthropic?.models, 0, "the active provider keeps its models");
	const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
	assert.equal(cfg.onlyActive, true, "the flag must survive restarts via config");
	assert.ok(t.rec.notifies.at(-1)?.includes("only-active ON"));
});

test("failover under only-active unhides the target before switching and re-narrows after", async () => {
	const t = setup({
		accounts: TWO_ACCOUNTS,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await t.fire("session_start");
	await t.command("only-active on");
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate_limit_error");
	const lastSwitch = t.rec.setModels.at(-1) ?? "";
	assert.ok(
		lastSwitch.startsWith("openai-codex-account-2/"),
		`the failover must still reach the hidden account, got ${lastSwitch}`,
	);
	const codex = [...t.rec.registrations]
		.reverse()
		.find((r) => r.provider === "openai-codex-account-2");
	assert.ok(
		(codex?.models ?? 0) > 0,
		"the new active account must be visible in /model again",
	);
	// The spent account here is Pi's OWN `anthropic` provider, not a slot this extension
	// invented, so the filter must leave it alone — see the only-active invariant below.
	assert.ok(
		![...t.rec.registrations].some(
			(r) => r.provider === "anthropic" && r.models === 0,
		),
		"a provider Pi knows on its own is never emptied to narrow /model",
	);
	assert.ok(
		[...t.rec.registrations].some(
			(r) => r.provider === "openai-codex-account-2" && r.models === 0,
		),
		"the extension's own spare slot IS narrowed while another account is active",
	);
});

test("only-active off restores every hidden provider", async () => {
	const t = setup({
		accounts: TWO_ACCOUNTS,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await t.fire("session_start");
	await t.command("only-active"); // toggle on
	assert.ok(t.rec.notifies.at(-1)?.includes("only-active ON"));
	await t.command("only-active"); // toggle back off
	assert.ok(t.rec.notifies.at(-1)?.includes("only-active OFF"));
	const codex = [...t.rec.registrations]
		.reverse()
		.find((r) => r.provider === "openai-codex-account-2");
	assert.ok(
		(codex?.models ?? 0) > 0,
		"the hidden account's models must be restored",
	);
	const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
	assert.equal(cfg.onlyActive, false);
});

test("only-active re-apply on message_start is a no-op when nothing changed", async () => {
	const t = setup({
		accounts: TWO_ACCOUNTS,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await t.fire("session_start");
	await t.command("only-active on");
	const before = t.rec.registrations.length;
	await t.fire("message_start", {});
	await t.fire("message_start", {});
	assert.equal(
		t.rec.registrations.length,
		before,
		"a steady registry must not be re-registered on every turn",
	);
});

test("immediate failover never injects a continuation user message", async () => {
	const t = setup({
		accounts: TWO_ACCOUNTS,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { autoDiscover: true },
	});
	await t.fire("session_start");
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	assert.equal(t.rec.continueCalls.length, 1);
	assert.equal(t.rec.sent.length, 0);
});
test("malformed config arrays are sanitized instead of crashing failover", async () => {
	const t = setup({
		accounts: TWO_ACCOUNTS,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: {
			autoDiscover: true,
			fallbacks: ["openai-codex-account-2", 42, null, ""],
			limitErrorPatterns: [null, "usage limit", 0],
			ignoreErrorPatterns: [false, "context window"],
		} as any,
	});
	await t.fire("session_start");
	await finishError(t, "anthropic", "claude-opus-4-8", "usage limit reached");
	assert.equal(t.ctx.model.provider, "openai-codex-account-2");
});

test("corrupt pending target state is ignored safely on resume checks", async () => {
	const t = setup({
		accounts: ONE_ACCOUNT,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {},
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			pendingContinuationPrompt: "old pending prompt",
			pendingFrom: { provider: "anthropic" },
			pendingReason: "account cooldown expired",
			lastSwitches: [],
		} as any,
	});
	await t.fire("session_start");
	assert.ok(!t.readState().pendingFrom);
});

test("reload re-reads config from disk before handling the next failure", async () => {
	const t = setup({
		accounts: TWO_ACCOUNTS,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { enabled: false, fallbacks: [] },
	});
	await t.fire("session_start");
	writeFileSync(
		CONFIG,
		`${JSON.stringify({ enabled: true, autoDiscover: false, fallbacks: ["openai-codex-account-2"] }, null, "\t")}\n`,
	);
	await t.command("reload");
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	assert.equal(t.ctx.model.provider, "openai-codex-account-2");
});

test("disable blocks automatic failover and enable restores it", async () => {
	const t = setup({
		accounts: TWO_ACCOUNTS,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { autoDiscover: true },
	});
	await t.fire("session_start");
	await t.command("disable");
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	assert.equal(t.ctx.model.provider, "anthropic");

	await t.command("enable");
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit again");
	assert.equal(t.ctx.model.provider, "openai-codex-account-2");
});

test("add cursor guides the user through subscription login, not API-key setup", async () => {
	installCursorProvider();
	try {
		const t = setup({ accounts: ONE_ACCOUNT });
		await t.command("add cursor");
		const notice = t.rec.notifies.at(-1) ?? "";
		assert.match(notice, /authenticate your Cursor subscription in the browser/);
		assert.doesNotMatch(notice, /api[_ -]?key/i);
	} finally {
		uninstallCursorProvider();
	}
});

// ---------------------------------------------------------------------------
// Cursor is optional: nothing about it may leak into a session that never asked
// ---------------------------------------------------------------------------

test(
	"includeCursor default-on never registers a phantom cursor slot nor warns while the Cursor provider is not installed",
	{ concurrency: false },
	async () => {
		uninstallCursorProvider();
		const t = setup({ accounts: ONE_ACCOUNT, config: { includeCursor: true } });

		await t.fire("session_start");
		await wait(120);
		await t.command("status");

		const status = t.rec.notifies.find((message) =>
			message.includes("Registered login slots"),
		);
		// A cursor slot backed by nothing would be offered by /login and could never work.
		assert.ok(status, "status output should be produced");
		assert.doesNotMatch(status, /cursor-account-\d/);
		// And no unsolicited `git clone` instructions for a provider the user never asked for.
		assert.equal(
			t.rec.notifies.some((message) =>
				message.includes("Cursor subscription support not found"),
			),
			false,
		);
		await t.fire("session_shutdown");
	},
);

test(
	"cloning the Cursor provider is enough: the spare cursor slot appears on the next rediscover",
	{ concurrency: false },
	async () => {
		uninstallCursorProvider();
		const t = setup({ accounts: ONE_ACCOUNT, config: { includeCursor: true } });
		await t.fire("session_start");
		await wait(120);

		installCursorProvider();
		try {
			await t.command("rediscover");
			await wait(120);
			await t.command("status");
			const status = t.rec.notifies
				.filter((message) => message.includes("Registered login slots"))
				.at(-1);
			assert.match(status ?? "", /cursor-account-2/);
		} finally {
			uninstallCursorProvider();
			await t.fire("session_shutdown");
		}
	},
);

test("remove codex drops the highest numbered authed alias slot", async () => {
	const accounts: Account = {
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
		"openai-codex": {
			type: "oauth",
			access: "c1",
			refresh: "cr1",
			accountId: "codex-1",
		},
		"openai-codex-account-2": {
			type: "oauth",
			access: "c2",
			refresh: "cr2",
			accountId: "codex-2",
		},
		"openai-codex-account-3": {
			type: "oauth",
			access: "c3",
			refresh: "cr3",
			accountId: "codex-3",
		},
	};
	const t = setup({ accounts });
	await t.fire("session_start");
	await t.command("remove codex");
	const auth = JSON.parse(readFileSync(AUTH, "utf8"));
	assert.ok(!auth["openai-codex-account-3"]);
	assert.ok(auth["openai-codex-account-2"]);
	assert.ok(auth["openai-codex"]);
	const notice = t.rec.notifies.at(-1) ?? "";
	assert.match(notice, /removed openai-codex-account-3/);
});

test("remove <provider-id> deletes a specific slot from auth.json", async () => {
	const t = setup({ accounts: TWO_ACCOUNTS });
	await t.fire("session_start");
	await t.command("remove openai-codex-account-2");
	const auth = JSON.parse(readFileSync(AUTH, "utf8"));
	assert.ok(!auth["openai-codex-account-2"]);
	assert.ok(auth.anthropic);
});

test("remove anthropic with only the base slot removes that credential", async () => {
	const t = setup({ accounts: ONE_ACCOUNT });
	await t.fire("session_start");
	await t.command("remove anthropic");
	const auth = JSON.parse(readFileSync(AUTH, "utf8"));
	assert.ok(!auth.anthropic);
});

test("remove without args prints usage", async () => {
	const t = setup({ accounts: ONE_ACCOUNT });
	await t.command("remove");
	const notice = t.rec.notifies.at(-1) ?? "";
	assert.match(notice, /usage:.*remove/i);
});

test("transient overload retries the same account instead of rotating siblings", async () => {
	const accounts: Account = {
		"openai-codex-account-2": {
			type: "oauth",
			access: "b",
			refresh: "br",
			accountId: "codex-2",
		},
		"openai-codex-account-4": {
			type: "oauth",
			access: "d",
			refresh: "dr",
			accountId: "codex-4",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		config: { transientCooldownMs: 500, pendingPollMs: 200 },
	});
	await t.fire("session_start");
	await finishError(
		t,
		"openai-codex-account-2",
		"gpt-5.5",
		"Codex err: Our servers are currently overloaded. Please try again later.",
	);
	assert.equal(
		t.rec.setModels.length,
		0,
		"transient overload must not switch to a sibling account",
	);
	assert.ok(
		t.readState().pendingFrom && t.readState().pendingReason,
		"pending retry must be armed",
	);
	await wait(1300);
	assert.equal(
		t.rec.setModels.length,
		0,
		"retry must stay on the same account",
	);
	assert.equal(
		t.rec.continueCalls.length,
		1,
		"resume must fire after cooldown",
	);
	assert.equal(t.rec.sent.length, 0);
});

test("hyphenated Invalid API-key immediately invalidates Alibaba and fails over", async () => {
	const accounts: Account = {
		alibaba: { type: "api_key", key: "bad-key" },
		cursor: { type: "oauth", access: "c-tok", refresh: "c-ref" },
	};
	const t = setup({
		accounts,
		current: { provider: "alibaba", id: "qwen3.7-max" },
		config: {
			fallbacks: ["cursor/composer-2.5", "alibaba"],
			includeCursor: true,
		},
	});
	await t.fire("session_start");
	await finishError(
		t,
		"alibaba",
		"qwen3.7-max",
		"401 Invalid API-key provided. For details, see: https://www.alibabacloud.com/help/en/model-studio/error-code#apikey-error",
	);
	const state = t.readState();
	assert.ok(
		state.invalidatedByProvider?.alibaba,
		"bad Alibaba API-key must invalidate the slot immediately",
	);
	assert.notEqual(
		t.ctx.model.provider,
		"alibaba",
		"must not keep serving requests on invalidated Alibaba",
	);
});

test("pending resume after auth failure does not rotate back to the same provider", async () => {
	const accounts: Account = {
		alibaba: { type: "api_key", key: "bad-key" },
		cursor: { type: "oauth", access: "c-tok", refresh: "c-ref" },
	};
	const t = setup({
		accounts,
		current: { provider: "alibaba", id: "qwen3.7-max" },
		config: {
			fallbacks: ["cursor/composer-2.5", "alibaba"],
			includeCursor: true,
			pendingPollMs: 200,
		},
	});
	await t.fire("session_start");
	await finishError(
		t,
		"alibaba",
		"qwen3.7-max",
		"401 Invalid API-key provided. For details, see: https://www.alibabacloud.com/help/en/model-studio/error-code#apikey-error",
	);
	const switches = t.readState().lastSwitches ?? [];
	const selfSwitch = switches.find(
		(s: { from?: string; to?: string }) => s.from === s.to,
	);
	assert.equal(
		selfSwitch,
		undefined,
		"failover must never record alibaba -> alibaba",
	);
});

// ---------------------------------------------------------------------------
// v1.12.0 robustness: no spurious resume, account-aware compaction, watchdog
// ---------------------------------------------------------------------------

function okAssistant(provider: string, model: string) {
	return {
		role: "assistant",
		content: [],
		provider,
		model,
		stopReason: "stop",
		timestamp: messageTimestamp++,
	};
}

test("does not re-resume from a successful assistant turn (the 'Cannot continue from message role: assistant' bug)", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		idle: false,
	});
	await t.fire("before_agent_start", {});
	// A real 429 switches to codex and resumes the interrupted work exactly once.
	const err = assistantError("anthropic", "claude-opus-4-8", "429 rate limit");
	await t.fire("message_end", { message: err });
	t.setIdle(true);
	await t.fire("agent_end", { messages: [err] });
	assert.equal(t.rec.continueCalls.length, 1, "the error turn resumes once");

	// The switched-to account then completes a SUCCESSFUL turn. This agent_end consumes the
	// internal dispatch flag.
	const ok = okAssistant("openai-codex-account-2", "gpt-5.5");
	await t.fire("agent_end", { messages: [ok] });
	assert.equal(
		t.rec.continueCalls.length,
		1,
		"a successful turn is never resumed",
	);

	// A LATER agent_end (e.g. the agent ran another tool loop) with a successful tail. The old
	// bug re-dispatched a resume here because currentPromptSwitch was still set, and
	// pi.continueAgent() then threw "Cannot continue from message role: assistant".
	await t.fire("agent_end", { messages: [ok] });
	assert.equal(
		t.rec.continueCalls.length,
		1,
		"must never resume from a completed assistant message",
	);
});

test("successful completion cancels a pending same-model retry", async () => {
	const t = setup({
		accounts: ONE_ACCOUNT,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { transientCooldownMs: 25, pendingPollMs: 25 },
		omitContinueAgent: true,
	});
	await t.fire("session_start");
	try {
		await finishError(t, "anthropic", "claude-opus-4-8", "500 server error");
		assert.ok(t.readState().pendingFrom, "a retry must be pending before completion");
		const ok = okAssistant("anthropic", "claude-opus-4-8");
		await t.fire("message_end", { message: ok });
		await t.fire("agent_end", { messages: [ok] });
		assert.equal(t.readState().pendingFrom, undefined, "completion must clear the pending retry");
		await wait(1100);
		assert.equal(t.rec.sent.length, 0, "completed work must not receive a synthetic retry prompt");
		assert.equal(t.rec.continueCalls.length, 0);
	} finally {
		await t.fire("session_shutdown");
	}
});

test("successful completion cancels a resume already waiting for the host to go idle", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		idle: false,
	});
	try {
		await t.fire("before_agent_start", {});
		const err = assistantError("anthropic", "claude-opus-4-8", "429 rate limit");
		await t.fire("message_end", { message: err });
		const pending = t.fire("agent_end", { messages: [err] });
		await wait(30);
		await t.fire("agent_end", { messages: [okAssistant(t.ctx.model.provider, t.ctx.model.id)] });
		t.setIdle(true);
		await pending;
		assert.equal(t.rec.continueCalls.length, 0, "an in-flight resume must not restart completed work");
		assert.equal(t.rec.sent.length, 0);
	} finally {
		t.setIdle(true);
		await t.fire("session_shutdown");
	}
});

test("successful completion cancels a retry waiting for its model switch", async () => {
	let release: () => void = () => {};
	const blocked = new Promise<void>((resolve) => { release = resolve; });
	let switchStarted = false;
	let blockSwitch = false;
	const t = setup({
		accounts: ONE_ACCOUNT,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { transientCooldownMs: 25, pendingPollMs: 25 },
		omitContinueAgent: true,
		setModelBlocks: async () => {
			if (blockSwitch) {
				switchStarted = true;
				await blocked;
			}
		},
	});
	await t.fire("session_start");
	try {
		await finishError(t, "anthropic", "claude-opus-4-8", "500 server error");
		t.setCurrent("anthropic", "claude-sonnet-4-6");
		blockSwitch = true;
		await wait(1100);
		assert.ok(switchStarted, "the retry must be waiting for its model switch");
		await t.fire("agent_end", { messages: [okAssistant(t.ctx.model.provider, t.ctx.model.id)] });
		release();
		await wait(30);
		assert.equal(t.rec.sent.length, 0, "a completed model switch must not inject a stale retry");
		assert.equal(t.readState().pendingFrom, undefined);
	} finally {
		release();
		await t.fire("session_shutdown");
	}
});

test("successful completion cancels prompt injection after a pending continuation rejects", async () => {
	let release: () => void = () => {};
	const blocked = new Promise<void>((resolve) => { release = resolve; });
	const t = setup({
		accounts: ONE_ACCOUNT,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { transientCooldownMs: 25, pendingPollMs: 25 },
		continueBlocks: async () => {
			await blocked;
			throw new Error("Cannot continue from message role: assistant");
		},
	});
	await t.fire("session_start");
	try {
		await finishError(t, "anthropic", "claude-opus-4-8", "500 server error");
		await wait(1100);
		assert.equal(t.rec.continueCalls.length, 1, "the retry must be waiting for continueAgent");
		await t.fire("agent_end", { messages: [okAssistant(t.ctx.model.provider, t.ctx.model.id)] });
		release();
		await wait(30);
		assert.equal(t.rec.sent.length, 0, "a rejected stale continuation must not inject another prompt");
	} finally {
		release();
		await t.fire("session_shutdown");
	}
});

test("successful completion cannot let an old continuation suppress a new task retry", async () => {
	let release: () => void = () => {};
	let started: () => void = () => {};
	const blocked = new Promise<void>((resolve) => { release = resolve; });
	const continuing = new Promise<void>((resolve) => { started = resolve; });
	let first = true;
	const t = setup({
		accounts: {
			...TWO_ACCOUNTS,
			"openai-codex-account-3": { type: "oauth", access: "third-access", refresh: "third-refresh" },
		},
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		continueBlocks: async () => {
			if (first) {
				first = false;
				started();
				await blocked;
			}
		},
	});
	try {
		await t.fire("before_agent_start", {});
		const err = assistantError("anthropic", "claude-opus-4-8", "429 rate limit");
		await t.fire("message_end", { message: err });
		const pending = t.fire("agent_end", { messages: [err] });
		await continuing;
		await t.fire("agent_end", { messages: [okAssistant(t.ctx.model.provider, t.ctx.model.id)] });
		await t.fire("before_agent_start", {});
		await t.fire("agent_start", {});
		release();
		await pending;
		await finishError(t, t.ctx.model.provider, t.ctx.model.id, "429 rate limit");
		assert.equal(t.rec.continueCalls.length, 2, "the new task must receive its own retry");
	} finally {
		release();
		await t.fire("session_shutdown");
	}
});

for (const outcome of ["resolves", "rejects"] as const) {
	test(`an old continuation that ${outcome} cannot stop a new retry watchdog`, async (context) => {
		let releaseOld: () => void = () => {};
		let releaseNew: () => void = () => {};
		let oldStarted: () => void = () => {};
		let newStarted: () => void = () => {};
		const oldBlocked = new Promise<void>((resolve) => { releaseOld = resolve; });
		const newBlocked = new Promise<void>((resolve) => { releaseNew = resolve; });
		const oldReady = new Promise<void>((resolve) => { oldStarted = resolve; });
		const newReady = new Promise<void>((resolve) => { newStarted = resolve; });
		let first = true;
		const t = setup({
			accounts: {
				...TWO_ACCOUNTS,
				"openai-codex-account-3": { type: "oauth", access: "third-access", refresh: "third-refresh" },
			},
			current: { provider: "anthropic", id: "claude-opus-4-8" },
			config: { stuckWatchdogMs: 1000 },
			continueBlocks: async () => {
				if (first) {
					first = false;
					oldStarted();
					await oldBlocked;
					if (outcome === "rejects") throw new Error("Cannot continue from message role: assistant");
				} else {
					newStarted();
					await newBlocked;
				}
			},
		});
		let oldPending: Promise<unknown> | undefined;
		let newPending: Promise<unknown> | undefined;
		try {
			await t.fire("before_agent_start", {});
			const oldError = assistantError("anthropic", "claude-opus-4-8", "429 rate limit");
			await t.fire("message_end", { message: oldError });
			oldPending = t.fire("agent_end", { messages: [oldError] });
			await oldReady;
			await t.fire("agent_end", { messages: [okAssistant(t.ctx.model.provider, t.ctx.model.id)] });
			await t.fire("before_agent_start", {});
			await t.fire("agent_start", {});
			const newError = assistantError(t.ctx.model.provider, t.ctx.model.id, "429 rate limit");
			await t.fire("message_end", { message: newError });
			context.mock.timers.enable({ apis: ["setTimeout"] });
			newPending = t.fire("agent_end", { messages: [newError] });
			await newReady;
			releaseOld();
			await oldPending;
			assert.equal(t.rec.aborts, 0);
			assert.equal(t.rec.sent.length, 0, "the old continuation must not inject a stale prompt");
			context.mock.timers.tick(1000);
			assert.equal(t.rec.aborts, 1, "the newer stalled retry must retain its watchdog");
		} finally {
			releaseOld();
			releaseNew();
			await Promise.all([oldPending, newPending]);
			await t.fire("session_shutdown");
		}
	});
}

test("an un-continuable resume (e.g. tail aborted by the watchdog) recovers by injecting the continuation prompt — never a red error", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		idle: false,
		continueThrows: "Cannot continue from message role: assistant",
	});
	const err = assistantError("anthropic", "claude-opus-4-8", "429 rate limit");
	await t.fire("message_end", { message: err });
	t.setIdle(true);
	await t.fire("agent_end", { messages: [err] });
	assert.equal(
		t.rec.continueCalls.length,
		1,
		"it tries the seamless resume first",
	);
	assert.ok(
		!t.rec.notifies.some((n) =>
			/could not resume with existing context/i.test(n),
		),
		"the cryptic continue error is never surfaced as a red error",
	);
	assert.equal(
		t.rec.sent.length,
		1,
		"it falls back to injecting the continuation prompt so the work keeps moving by itself",
	);
});

test("host build WITHOUT pi.continueAgent still auto-resumes the failover (inject continuation prompt) instead of dead-ending with a red 'Update @earendil-works/pi-coding-agent' error", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		omitContinueAgent: true,
	});
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate_limit_error");
	// The account switch itself still happens.
	assert.deepEqual(t.rec.setModels, ["openai-codex-account-2/gpt-5.5"]);
	// There is no pi.continueAgent to call on this host build...
	assert.equal(
		t.rec.continueCalls.length,
		0,
		"there is no continueAgent on this host build",
	);
	// ...so the extension MUST degrade to injecting the continuation prompt so the work resumes by
	// itself on the new account — the exact scenario the user hit (repeated reloads that never continued).
	assert.equal(
		t.rec.sent.length,
		1,
		"it injects the continuation prompt so the session keeps moving without a manual reload",
	);
	// The injection MUST carry deliverAs:"followUp" — without it the host throws "Agent is already
	// processing. Specify streamingBehavior..." when the previous turn is still streaming, which is
	// exactly the race that fires right after a failover switch, and the continuation is silently lost.
	assert.equal(
		t.rec.sent[0].options?.deliverAs,
		"followUp",
		"the continuation must queue as a follow-up so it isn't rejected while the turn is still streaming",
	);
	assert.ok(
		!t.rec.notifies.some((n) => /requires pi\.continueAgent/i.test(n)),
		"the old dead-end 'seamless resume requires pi.continueAgent()' error must be gone",
	);
});

test("a genuinely maxed monthly Codex account is benched for its REAL reset, so failover advances to a healthy Qwen/Alibaba account instead of ping-ponging between spent Codex slots", async () => {
	const now = Date.now();
	const accounts: Account = {
		"openai-codex-account-2": {
			type: "oauth",
			access: "c2",
			refresh: "r2",
			accountId: "codex-2",
		},
		"openai-codex-account-3": {
			type: "oauth",
			access: "c3",
			refresh: "r3",
			accountId: "codex-3",
		},
		alibaba: { type: "api_key", key: "qwen-key" },
	};
	// Both Codex accounts report their PRIMARY (monthly, 30-day) window at 100% with a far-out reset —
	// authoritative "spent" straight from the account's own usage endpoint. The 6h re-probe cap used
	// to keep un-benching them every 6h, so auto-failover ping-ponged account-2 ↔ account-3 forever
	// and NEVER advanced to the healthy Qwen account. It must now bench them for the real reset.
	const monthly = {
		usedPercent: 100,
		resetAt: now + 30 * 24 * 60 * 60 * 1000,
	};
	const t = setup({
		accounts,
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {},
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			usageByProvider: {
				"openai-codex-account-2": {
					provider: "openai-codex-account-2",
					family: "codex",
					fetchedAt: now,
					primary: monthly,
				},
				"openai-codex-account-3": {
					provider: "openai-codex-account-3",
					family: "codex",
					fetchedAt: now,
					primary: monthly,
				},
			},
			lastSwitches: [],
		},
	});
	await finishError(
		t,
		"openai-codex-account-2",
		"gpt-5.5",
		"usage limit has been reached",
	);
	assert.ok(
		t.rec.setModels.some((m) => m.startsWith("alibaba/")),
		`a fresh 100% sibling is known dead, so failover must go directly to healthy Qwen/Alibaba; got ${JSON.stringify(t.rec.setModels)}`,
	);
	assert.ok(
		!t.rec.setModels.some((m) => m.startsWith("openai-codex-account-3/")),
		"automatic routing must not spend a user turn re-proving a fresh provider verdict",
	);
	assert.equal(
		t.rec.setModels.filter((m) => m.startsWith("openai-codex-account-2/")).length,
		0,
		"must not ping-pong back onto the Codex slot that already refused",
	);
});

test("a spent account known ONLY from a STALE usage snapshot is still tried when it is a same-family sibling", async () => {
	const now = Date.now();
	const accounts: Account = {
		"openai-codex-account-2": {
			type: "oauth",
			access: "c2",
			refresh: "r2",
			accountId: "codex-2",
		},
		"openai-codex-account-3": {
			type: "oauth",
			access: "c3",
			refresh: "r3",
			accountId: "codex-3",
		},
		alibaba: { type: "api_key", key: "qwen-key" },
	};
	// account-3 is genuinely maxed (primary 100%, reset 14 days out) but its usage snapshot is an
	// HOUR OLD and it has NO recorded cooldown — exactly the state that made real failover land on a
	// dead account: at the instant account-2 errored, account-3 looked "available". A maxed 30-day
	// window cannot have recovered in an hour, so the snapshot is authoritative regardless of age.
	const t = setup({
		accounts,
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {}, // <- account-3 has NO cooldown recorded
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			usageByProvider: {
				"openai-codex-account-3": {
					provider: "openai-codex-account-3",
					family: "codex",
					fetchedAt: now - 60 * 60 * 1000, // STALE (an hour old)
					primary: {
						usedPercent: 100,
						resetAt: now + 14 * 24 * 60 * 60 * 1000,
					},
				},
			},
			lastSwitches: [],
		},
	});
	await finishError(
		t,
		"openai-codex-account-2",
		"gpt-5.5",
		"usage limit has been reached",
	);
	assert.ok(
		t.rec.setModels.some((m) => m.startsWith("openai-codex-account-3/")),
		`same-family sibling is tried even on a stale 100% forecast; got ${JSON.stringify(t.rec.setModels)}`,
	);
	assert.ok(
		!t.rec.setModels.some((m) => m.startsWith("alibaba/")),
		"must not jump family while a Codex sibling has not refused",
	);
});

test("a 100% usage forecast still benches a dead account when failing over FROM another family", async () => {
	const now = Date.now();
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
			"openai-codex-account-3": {
				type: "oauth",
				access: "c3",
				refresh: "r3",
				accountId: "codex-3",
			},
			alibaba: { type: "api_key", key: "qwen-key" },
		},
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {},
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			usageByProvider: {
				"openai-codex-account-3": {
					provider: "openai-codex-account-3",
					family: "codex",
					fetchedAt: now - 60 * 60 * 1000,
					primary: {
						usedPercent: 100,
						resetAt: now + 14 * 24 * 60 * 60 * 1000,
					},
				},
			},
			lastSwitches: [],
		},
	});
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate_limit_error");
	assert.ok(
		t.rec.setModels.some((m) => m.startsWith("alibaba/")),
		`must fail over to the live Qwen account, got ${JSON.stringify(t.rec.setModels)}`,
	);
	assert.ok(
		!t.rec.setModels.some((m) => m.startsWith("openai-codex-account-3/")),
		"must NOT land on a spent Codex account when leaving a different family",
	);
});

test("startup capability preflight: a host missing pi.continueAgent is flagged ONCE as an expected fallback (info), not a scary error", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		omitContinueAgent: true,
	});
	await t.fire("session_start");
	assert.ok(
		t.rec.notifies.some((n) =>
			/seamless in-place resume .*not available/i.test(n),
		),
		"it states seamless resume is unavailable but failover still switches + auto-continues",
	);
	assert.ok(
		!t.rec.notifies.some((n) =>
			/IMPOSSIBLE|cannot auto-continue|does not expose pi\.setModel/i.test(n),
		),
		"switching and the injection fallback both work, so no error/warning is raised",
	);
});

test("startup capability preflight: a host missing BOTH continueAgent and sendUserMessage warns up front that auto-continue is impossible", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		omitContinueAgent: true,
		omitSendUserMessage: true,
	});
	await t.fire("session_start");
	assert.ok(
		t.rec.notifies.some((n) =>
			/neither pi\.continueAgent.*nor pi\.sendUserMessage|cannot auto-continue/i.test(
				n,
			),
		),
		"the user is warned up front they must re-send the prompt after a switch on this host",
	);
});

test("startup capability preflight: a fully-capable host raises NO capability notice (only the normal 'loaded' line)", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await t.fire("session_start");
	assert.ok(
		!t.rec.notifies.some((n) =>
			/seamless in-place resume|IMPOSSIBLE|neither pi\.continueAgent|does not expose pi\.setModel/i.test(
				n,
			),
		),
		"nothing is degraded on a normal host, so no capability warning appears",
	);
});

test("session_before_compact: leaves Pi's native compaction alone when the active account is healthy", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		compactionAuth: { ok: true, apiKey: "test-key" },
		compactFn: async () => {
			throw new Error("the extension must not replace native compaction");
		},
	});
	const result = await t.fire("session_before_compact", {
		reason: "threshold",
		preparation: {
			messagesToSummarize: [],
			firstKeptEntryId: "e1",
			tokensBefore: 1000,
		},
		signal: { aborted: false },
	});
	assert.equal(result, undefined, "healthy account → Pi's native compaction");
	assert.equal(
		t.rec.compactionAuthFor.length,
		0,
		"native compaction owns auth and stream setup on a healthy account",
	);
});

test("session_before_compact: a routed provider gets the full watchdog budget, not one third", async () => {
	const asked: string[] = [];
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a-tok-1", refresh: "a-ref-1" },
			"openai-codex-account-2": {
				type: "oauth",
				access: "c-tok-2",
				refresh: "c-ref-2",
				accountId: "codex-2",
			},
		},
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		seedCooldownsMsFromNow: { "openai-codex-account-2": 60 * 60 * 1000 },
		compactionAuth: { ok: true, apiKey: "test-key" },
		// 55 ms is longer than the old 30 ms (90 / 3), but still within the
		// configured 90 ms allowance for this provider.
		config: { compactionWatchdogMs: 90 },
		compactFn: async (_preparation, model) => {
			asked.push(model.provider);
			await wait(55);
			return COMPACTION_SUMMARY;
		},
	});
	const result = await t.fire("session_before_compact", {
		reason: "threshold",
		preparation: {
			messagesToSummarize: [],
			firstKeptEntryId: "e1",
			tokensBefore: 250000,
		},
		signal: { aborted: false },
	});
	assert.equal(result?.compaction?.summary, COMPACTION_SUMMARY.summary);
	assert.deepEqual(asked, ["anthropic"]);
});

test("session_before_compact: a healthy current account is never sent through the fallback watchdog", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		compactionAuth: { ok: true, apiKey: "test-key" },
		config: { compactionWatchdogMs: 40 },
		compactFn: async () => {
			throw new Error("native compaction must own the healthy path");
		},
	});
	const result = await t.fire("session_before_compact", {
		reason: "manual",
		preparation: {
			messagesToSummarize: [],
			firstKeptEntryId: "e1",
			tokensBefore: 250000,
		},
		signal: { aborted: false },
	});
	assert.equal(result, undefined);
	assert.equal(t.rec.compactionAuthFor.length, 0);
});

test("session_before_compact: routes the summary to a healthy account when the active account is cooling", async () => {
	const t = setup({
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		// The active codex account is itself spent — Pi's default would try to summarize on it.
		seedCooldownsMsFromNow: { "openai-codex-account-2": 60 * 60 * 1000 },
		// ok:false stops the handler before the real compact() call (no network in unit tests),
		// while still proving WHICH account it chose to summarize on.
		compactionAuth: { ok: false },
	});
	const result = await t.fire("session_before_compact", {
		reason: "overflow",
		preparation: {
			messagesToSummarize: [],
			firstKeptEntryId: "e1",
			tokensBefore: 250000,
		},
		signal: { aborted: false },
	});
	assert.ok(
		t.rec.compactionAuthFor.some((m) => m.startsWith("anthropic/")),
		"compaction is routed to the healthy anthropic account, not the cooling codex one",
	);
	assert.ok(
		!t.rec.compactionAuthFor.some((m) =>
			m.startsWith("openai-codex-account-2/"),
		),
		"the cooling account is never chosen to summarize",
	);
	assert.equal(
		result?.cancel,
		true,
		"auth unavailable → cancel, never Pi default on the spent account",
	);
});

test("session_before_compact: cancels instead of hanging on Pi default when no account is available", async () => {
	const t = setup({
		accounts: ONE_ACCOUNT,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedCooldownsMsFromNow: { anthropic: 60 * 60 * 1000 },
	});
	const result = await t.fire("session_before_compact", {
		reason: "overflow",
		preparation: {
			messagesToSummarize: [],
			firstKeptEntryId: "e1",
			tokensBefore: 250000,
		},
		signal: { aborted: false },
	});
	assert.equal(
		result?.cancel,
		true,
		"no live account → cancel (Pi default on the spent account is the hang)",
	);
	assert.equal(
		t.rec.compactionAuthFor.length,
		0,
		"no reroute attempted when nothing is healthy",
	);
});

const COMPACTION_SUMMARY = {
	summary: "the conversation so far",
	firstKeptEntryId: "e1",
	tokensBefore: 250000,
};

function hangingCompact(onAbort: () => void) {
	return (
		_preparation: unknown,
		_model: unknown,
		_apiKey: unknown,
		_headers: unknown,
		_instructions: unknown,
		signal?: AbortSignal,
	) =>
		new Promise((_, reject) => {
			const fail = () => {
				onAbort();
				const err = new Error("aborted");
				err.name = "AbortError";
				reject(err);
			};
			if (signal?.aborted) {
				fail();
				return;
			}
			signal?.addEventListener?.("abort", fail, { once: true });
		});
}

test("session_before_compact: returns the summary from a live account", async () => {
	const t = setup({
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		seedCooldownsMsFromNow: { "openai-codex-account-2": 60 * 60 * 1000 },
		compactionAuth: { ok: true, apiKey: "test-key" },
		compactFn: async () => COMPACTION_SUMMARY,
	});
	const result = await t.fire("session_before_compact", {
		reason: "manual",
		preparation: {
			messagesToSummarize: [],
			firstKeptEntryId: "e1",
			tokensBefore: 250000,
		},
		signal: { aborted: false },
	});
	assert.equal(result?.compaction?.summary, COMPACTION_SUMMARY.summary);
	assert.ok(
		t.rec.compactionAuthFor.some((m) => m.startsWith("anthropic/")),
		"summary is generated on the live anthropic account",
	);
});

test("session_before_compact: a timed-out live summary is aborted and cancelled — never handed to the spent account", async () => {
	let aborted = false;
	const t = setup({
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		seedCooldownsMsFromNow: { "openai-codex-account-2": 60 * 60 * 1000 },
		compactionAuth: { ok: true, apiKey: "test-key" },
		config: { compactionWatchdogMs: 40 },
		compactFn: hangingCompact(() => {
			aborted = true;
		}),
	});
	const result = await t.fire("session_before_compact", {
		reason: "manual",
		preparation: {
			messagesToSummarize: [],
			firstKeptEntryId: "e1",
			tokensBefore: 250000,
		},
		signal: { aborted: false },
	});
	assert.equal(
		result?.cancel,
		true,
		"timeout cancels instead of falling through to the spent Codex account",
	);
	assert.equal(
		result?.compaction,
		undefined,
		"no fake summary is returned after a timeout",
	);
	assert.equal(aborted, true, "the timed-out compact() call is aborted, not leaked");
	assert.ok(
		t.rec.notifies.some((n) => /cancelled instead of hanging/i.test(n)),
		"the user is told the spinner will stop, not that Pi default will take over",
	);
});

test("session_before_compact: Escape cancels immediately instead of starting Pi default on the spent account", async () => {
	const signal = new AbortController();
	signal.abort();
	const t = setup({
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		seedCooldownsMsFromNow: { "openai-codex-account-2": 60 * 60 * 1000 },
		compactionAuth: { ok: true, apiKey: "test-key" },
		compactFn: async () => {
			throw new Error("compact must not run after abort");
		},
	});
	const result = await t.fire("session_before_compact", {
		reason: "manual",
		preparation: {
			messagesToSummarize: [],
			firstKeptEntryId: "e1",
			tokensBefore: 250000,
		},
		signal: signal.signal,
	});
	assert.equal(result?.cancel, true);
	assert.equal(
		t.rec.compactionAuthFor.length,
		0,
		"an already-aborted compact never resolves auth or starts a summary",
	);
});

test("session_before_compact: a timeout on the first live account tries the next one", async () => {
	const tried: string[] = [];
	let abortedFirst = false;
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a-tok-1", refresh: "a-ref-1" },
			"anthropic-account-2": {
				type: "oauth",
				access: "a-tok-2",
				refresh: "a-ref-2",
			},
			"openai-codex-account-2": {
				type: "oauth",
				access: "c-tok-2",
				refresh: "c-ref-2",
				accountId: "codex-2",
			},
		},
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		seedCooldownsMsFromNow: { "openai-codex-account-2": 60 * 60 * 1000 },
		compactionAuth: { ok: true, apiKey: "test-key" },
		config: { compactionWatchdogMs: 40 },
		compactFn: (preparation, model, apiKey, headers, instructions, signal) => {
			tried.push(model.provider);
			if (model.provider === "anthropic") {
				return hangingCompact(() => {
					abortedFirst = true;
				})(
					preparation,
					model,
					apiKey,
					headers,
					instructions,
					signal,
				);
			}
			return Promise.resolve(COMPACTION_SUMMARY);
		},
	});
	const result = await t.fire("session_before_compact", {
		reason: "overflow",
		preparation: {
			messagesToSummarize: [],
			firstKeptEntryId: "e1",
			tokensBefore: 250000,
		},
		signal: { aborted: false },
	});
	assert.ok(tried.includes("anthropic"), "the first live account is tried");
	assert.equal(abortedFirst, true, "the timed-out first attempt is aborted");
	assert.ok(
		tried.includes("anthropic-account-2"),
		`the next live account is tried after the timeout; got: ${tried.join(", ")}`,
	);
	assert.equal(result?.compaction?.summary, COMPACTION_SUMMARY.summary);
});

test("the wait-for-idle before a resume is bounded — never an infinite busy-loop", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		idle: false,
		config: { resumeIdleTimeoutMs: 50 },
	});
	const err = assistantError("anthropic", "claude-opus-4-8", "429 rate limit");
	await t.fire("message_end", { message: err });
	// Deliberately keep the session non-idle so the resume's wait MUST time out instead of
	// spinning forever, then return without ever calling continueAgent.
	await t.fire("agent_end", { messages: [err] });
	assert.equal(
		t.rec.continueCalls.length,
		0,
		"must not call continueAgent while the prior turn never goes idle",
	);
	assert.ok(
		t.rec.notifies.some((n) => /did not go idle/i.test(n)),
		"the bounded wait surfaces a clear, recoverable notice",
	);
});

test("a 'still busy' auto-retry resumes the SAME model — it never downgrades gpt-5.5 to gpt-5.4 on the same account", async () => {
	// Reproduces the reported log: "openai-codex-account-4/gpt-5.5 → openai-codex-account-4/gpt-5.4
	// (previous turn was still busy; auto-retry)". A busy-retry is a TIMING issue, not a model
	// failure — the same account's quota is shared, so dropping to gpt-5.4 escapes nothing and
	// only downgrades. The resume must keep gpt-5.5.
	const t = setup({
		accounts: TWO_ACCOUNTS,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		idle: false,
		config: {
			resumeIdleTimeoutMs: 40,
			pendingPollMs: 40,
			cooldownMs: 40,
			autoContinue: true,
		},
	});
	// anthropic hits a limit and we switch to the codex account on gpt-5.5. The prior turn never
	// goes idle in time, so a "still busy" auto-retry is armed for openai-codex-account-2/gpt-5.5.
	const err = assistantError("anthropic", "claude-opus-4-8", "429 rate limit");
	await t.fire("message_end", { message: err });
	assert.deepEqual(
		t.rec.setModels,
		["openai-codex-account-2/gpt-5.5"],
		"the switch lands on the newest model",
	);
	// Keep the session non-idle so the resume's bounded wait times out and arms a busy auto-retry.
	await t.fire("agent_end", { messages: [err] });
	assert.ok(
		/still busy/i.test(t.readState().pendingReason ?? ""),
		"a busy auto-retry must be armed (not a model failure)",
	);
	// The turn frees up; let the auto-resume wake fire.
	t.setIdle(true);
	await wait(250);
	assert.ok(
		!t.rec.setModels.some((m) => m.endsWith("/gpt-5.4")),
		`busy-retry must NEVER downgrade to gpt-5.4; got: ${t.rec.setModels.join(", ")}`,
	);
	assert.ok(
		t.rec.continueCalls.length >= 1,
		"the work resumes on the same model",
	);
	assert.equal(
		t.ctx.model.id,
		"gpt-5.5",
		"the resumed model is still the latest, gpt-5.5",
	);
	await t.fire("session_shutdown");
});

test("a silent resumed turn is AUTO-cancelled and auto-resume armed — no manual prompt needed (active watchdog)", async () => {
	let release: () => void = () => {};
	const blocked = new Promise<void>((res) => {
		release = res;
	});
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		idle: false,
		config: { stuckWatchdogMs: 40 },
		continueBlocks: () => blocked,
	});
	const err = assistantError("anthropic", "claude-opus-4-8", "429 rate limit");
	await t.fire("message_end", { message: err });
	t.setIdle(true);
	// continueAgent blocks (simulating a wedged provider/compaction). Do not await agent_end yet.
	const pending = t.fire("agent_end", { messages: [err] });
	await wait(120); // let the 40ms watchdog fire with no progress events
	assert.ok(
		t.rec.aborts >= 1,
		"the watchdog ACTIVELY cancels the wedged turn — it does not just warn and wait",
	);
	assert.ok(
		t.rec.notifies.some((n) => /resume automatically|auto-cancel/i.test(n)),
		"the user is told it will continue by itself",
	);
	release();
	await pending;
	// The watchdog abort surfaces as an aborted agent_end; that must ARM auto-resume, not stop.
	await t.fire("agent_end", {
		messages: [{ role: "assistant", stopReason: "aborted" }],
	});
	const state = t.readState();
	assert.ok(
		state.pendingFrom || state.pendingReason,
		"auto-resume is armed to continue the work when an account frees up",
	);
	await t.fire("session_shutdown");
});

test("the watchdog never aborts a resumed turn while a tool (build/test) is running", async () => {
	let release: () => void = () => {};
	const blocked = new Promise<void>((res) => {
		release = res;
	});
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		idle: false,
		config: { stuckWatchdogMs: 40 },
		continueBlocks: () => blocked,
	});
	const err = assistantError("anthropic", "claude-opus-4-8", "429 rate limit");
	await t.fire("message_end", { message: err });
	t.setIdle(true);
	const pending = t.fire("agent_end", { messages: [err] });
	// A long, silent tool (e.g. an xcodebuild) is executing — silence is expected, not a wedge.
	await t.fire("tool_execution_start", {});
	await wait(120); // the watchdog window elapses, but a tool is in flight
	assert.equal(
		t.rec.aborts,
		0,
		"a running build/test command must never be killed as 'stuck'",
	);
	await t.fire("tool_execution_end", {});
	release();
	await pending;
	await t.fire("session_shutdown");
});

// ---------------------------------------------------------------------------
// v1.13.0 circuit breaker: repeated recovery failures drop to safe advisory mode
// ---------------------------------------------------------------------------

test("after repeated resume failures the breaker opens and auto-continue stops (advisory mode)", async () => {
	const accounts: Account = {
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
		"openai-codex-account-2": {
			type: "oauth",
			access: "b",
			refresh: "br",
			accountId: "b",
		},
	};
	// Every continueAgent attempt throws a hard (non-continuable, non-abort) error → each is a
	// recovery failure. After 3 in a row the breaker must trip and stop auto-continuing.
	const t = setup({
		accounts,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		continueThrows: "network exploded mid-resume",
	});
	for (let i = 0; i < 3; i++) {
		await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	}
	assert.ok(
		t.rec.notifies.some((n) => /safe mode|auto-continue/i.test(n)),
		"the breaker announces it has dropped to advisory mode",
	);
	const continueCallsAtTrip = t.rec.continueCalls.length;
	// A further limit error must NOT trigger another auto-resume while the breaker is open.
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	assert.equal(
		t.rec.continueCalls.length,
		continueCallsAtTrip,
		"while the breaker is open, no more auto-resume attempts are made (no worse than manual)",
	);
});

test("the breaker resets on a genuine new user prompt so auto-continue is restored", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		continueThrows: "network exploded mid-resume",
	});
	for (let i = 0; i < 3; i++) {
		await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	}
	// A real user message is a clean slate — it must clear the failure streak.
	await t.input("ok continue please");
	const status = await t.command("status");
	void status;
	assert.ok(
		t.rec.notifies.some((n) => /Auto-continue breaker: closed/i.test(n)),
		"a fresh user prompt closes the breaker and re-enables auto-continue",
	);
});

// ---------------------------------------------------------------------------
// v1.12.0 crash isolation: no handler/timer fault can crash Pi or freeze a turn
// ---------------------------------------------------------------------------

function faultyAssistantMessage() {
	return {
		role: "assistant",
		stopReason: "error",
		// Any property access throws — a stand-in for ANY unexpected internal fault
		// (a host payload shape change, a formatter edge case, a null deref, …).
		get errorMessage(): string {
			throw new Error("synthetic internal fault");
		},
	};
}

test("an unexpected internal fault in an event handler is contained, not propagated to the host", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	// Must resolve cleanly — the extension must never throw out into Pi.
	await t.fire("message_end", { message: faultyAssistantMessage() });
	assert.ok(
		t.rec.notifies.some((n) => /recovered from an internal error/i.test(n)),
		"the fault is reported once and swallowed",
	);
});

test("repeated identical internal faults are reported once, not spammed", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await t.fire("message_end", { message: faultyAssistantMessage() });
	await t.fire("message_end", { message: faultyAssistantMessage() });
	await t.fire("message_end", { message: faultyAssistantMessage() });
	const recovered = t.rec.notifies.filter((n) =>
		/recovered from an internal error/i.test(n),
	);
	assert.equal(
		recovered.length,
		1,
		"identical faults are deduped within the window (no notification storm)",
	);
});

test("a quota error on the ACTIVE unmanaged provider (e.g. plain openai API) still fails over to a managed account", async () => {
	const t = setup({
		// The user is actively working on a plain `openai` API model (not managed by the extension).
		current: { provider: "openai", id: "gpt-5.5" },
	});
	await finishError(
		t,
		"openai",
		"gpt-5.5",
		"You exceeded your current quota, please check your plan and billing details. insufficient_quota",
	);
	assert.ok(
		t.rec.setModels.length > 0,
		`must rescue the task by switching to a managed account, got: ${t.rec.setModels.join(", ") || "none"}`,
	);
});

test("neverFailoverProviders leaves an unmanaged provider's own retry logic alone", async () => {
	const t = setup({
		// Same situation as the test above — an actionable error on the ACTIVE unmanaged
		// provider — except the user has told us this provider owns its retries.
		current: { provider: "self-retrying", id: "some-model" },
		config: { neverFailoverProviders: ["self-retrying"] },
	});
	await finishError(
		t,
		"self-retrying",
		"some-model",
		"You exceeded your current quota, please check your plan and billing details. insufficient_quota",
	);
	assert.equal(
		t.rec.setModels.length,
		0,
		`must not switch underneath a provider that retries itself, got: ${t.rec.setModels.join(", ")}`,
	);
	const log = readDebugLog();
	assert.ok(
		log.some(
			(entry) =>
				entry.kind === "failover_suppressed" &&
				entry.provider === "self-retrying",
		),
		"the suppression must be visible in the black-box log, not silent",
	);
});

test("neverFailoverProviders does not disable failover for other providers", async () => {
	const t = setup({
		current: { provider: "openai", id: "gpt-5.5" },
		config: { neverFailoverProviders: ["some-other-provider"] },
	});
	await finishError(
		t,
		"openai",
		"gpt-5.5",
		"You exceeded your current quota, please check your plan and billing details. insufficient_quota",
	);
	assert.ok(
		t.rec.setModels.length > 0,
		"an unrelated pin must not suppress a normal rescue",
	);
});

test("a limit error on an unmanaged provider that is NOT the active model is ignored (no hijack)", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	// Background error from some unrelated provider the user is NOT on → must be ignored.
	await finishError(t, "deepseek", "deepseek-chat", "429 quota exceeded");
	assert.equal(
		t.rec.setModels.length,
		0,
		"an unrelated background provider error must not trigger a switch",
	);
});

test("failover prefers the latest model: a turn stuck on gpt-5.4 is upgraded back to gpt-5.5 on a codex→codex switch", async () => {
	const accounts: Account = {
		"openai-codex-account-2": {
			type: "oauth",
			access: "b",
			refresh: "br",
			accountId: "b",
		},
		"openai-codex-account-3": {
			type: "oauth",
			access: "c",
			refresh: "cr",
			accountId: "c",
		},
	};
	// The active codex turn is on the OLD model gpt-5.4. A same-family failover must NOT carry
	// 5.4 forward — it must select the newest preferred model (gpt-5.5).
	const t = setup({
		accounts,
		current: { provider: "openai-codex-account-2", id: "gpt-5.4" },
	});
	await finishError(
		t,
		"openai-codex-account-2",
		"gpt-5.4",
		"429 rate_limit_error",
	);
	assert.ok(
		t.rec.setModels.some((m) => m.endsWith("/gpt-5.5")),
		`must upgrade to the latest model, got: ${t.rec.setModels.join(", ")}`,
	);
	assert.ok(
		!t.rec.setModels.some((m) => m.endsWith("/gpt-5.4")),
		"must not carry the downgraded gpt-5.4 forward",
	);
});

test("exhausted account fails over to a sibling with the same model before any other family", async () => {
	// Live log 2026-08-19: kimi-coding-account-2/k3 exhausted → anthropic-account-2/claude-opus-5
	// because confirmation and preferLatestModel ranked across families. Anthropic is FIRST in
	// the ring so only same-identity ranking can save this.
	const t = setup({
		accounts: {
			"kimi-coding": { type: "oauth", access: "k1", refresh: "kr1" },
			"kimi-coding-account-2": { type: "oauth", access: "k2", refresh: "kr2" },
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
		},
		current: { provider: "kimi-coding-account-2", id: "k3" },
		thinkingLevel: "high",
		config: { providerOrder: ["anthropic", "kimi-coding"] },
	});
	await t.fire("session_start");
	await t.fire("agent_start");
	await finishError(
		t,
		"kimi-coding-account-2",
		"k3",
		"429 rate_limit_error",
	);
	assert.equal(
		t.rec.setModels[0],
		"kimi-coding/k3",
		`must take the other Kimi slot at k3, not a random family flagship; got ${t.rec.setModels.join(", ")}`,
	);
	assert.ok(
		!t.rec.setModels.some((m) => m.startsWith("anthropic")),
		`must not jump to Claude while a Kimi sibling can take k3; got ${t.rec.setModels.join(", ")}`,
	);
	assert.equal(
		t.thinkingLevel(),
		"high",
		"the session thinking level must survive the sibling switch",
	);
});

test("a sibling that already refused yields to another family", async () => {
	const t = setup({
		accounts: {
			"kimi-coding": { type: "oauth", access: "k1", refresh: "kr1" },
			"kimi-coding-account-2": { type: "oauth", access: "k2", refresh: "kr2" },
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
		},
		current: { provider: "kimi-coding", id: "k3" },
		config: { providerOrder: ["anthropic", "kimi-coding"] },
	});
	await t.fire("session_start");
	await t.fire("agent_start");
	await finishError(t, "kimi-coding", "k3", "429 rate_limit_error");
	assert.equal(
		t.rec.setModels[0],
		"kimi-coding-account-2/k3",
		`first hop stays in family; got ${t.rec.setModels.join(", ")}`,
	);
	await finishError(
		t,
		"kimi-coding-account-2",
		"k3",
		"429 rate_limit_error",
	);
	assert.ok(
		t.rec.setModels.some((m) => m.startsWith("anthropic/")),
		`after the sibling also refused, another family must take over; got ${t.rec.setModels.join(", ")}`,
	);
	assert.equal(
		t.rec.setModels.filter((m) => m.startsWith("kimi-coding/")).length,
		0,
		`must not ping-pong back to the sibling that just refused; got ${t.rec.setModels.join(", ")}`,
	);
});

test("a fresh provider verdict of 100% skips the dead Codex sibling", async () => {
	// Live 2026-09-03: Sol failed, then automation selected two Codex accounts whose fresh usage
	// snapshots already said 100% / blocked. The user paid for those redundant refusals with two
	// broken turns. Only a manual next may override this evidence; automatic routing must not.
	const now = Date.now();
	const t = setup({
		accounts: {
			"openai-codex": {
				type: "oauth",
				access: "c1",
				refresh: "cr1",
				accountId: "plus-1",
			},
			"openai-codex-account-2": {
				type: "oauth",
				access: "c2",
				refresh: "cr2",
				accountId: "free-2",
			},
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
		},
		current: { provider: "openai-codex", id: "gpt-5.5" },
		thinkingLevel: "high",
		config: { providerOrder: ["anthropic", "openai-codex"] },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {
				"openai-codex-account-2": now + 10 * 60 * 1000,
			},
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			usageByProvider: {
				"openai-codex-account-2": {
					provider: "openai-codex-account-2",
					family: "codex",
					fetchedAt: now,
					serviceable: false,
					plan: "free",
					primary: {
						usedPercent: 100,
						resetAt: now + 60 * 60 * 1000,
					},
				},
			},
			lastSwitches: [],
		},
	});
	await t.fire("session_start");
	await t.fire("agent_start");
	await finishError(
		t,
		"openai-codex",
		"gpt-5.5",
		"You have hit your ChatGPT usage limit (plus plan). Try again in ~1596 min.",
	);
	assert.ok(
		t.rec.setModels.some((m) => m.startsWith("anthropic/claude-opus-")),
		`Opus is the compatible live peer after a frontier Codex slot is known spent; got ${t.rec.setModels.join(", ")}`,
	);
	assert.ok(
		!t.rec.setModels.some((m) => m.startsWith("openai-codex-account-2/")),
		`the explicitly blocked sibling must not be retried automatically; got ${t.rec.setModels.join(", ")}`,
	);
	assert.equal(
		t.thinkingLevel(),
		"high",
		"the session thinking level must survive the cross-provider switch",
	);
	const afterHop = t.rec.setModels.length;
	await t.fire("before_agent_start", {});
	assert.equal(
		t.rec.setModels.length,
		afterHop,
		`the compatible live hop must survive last-moment preflight; it bounced to ${t.rec.setModels.slice(afterHop).join(", ")}`,
	);
});

test("cursor failover keeps grok and thinking level instead of jumping to another family", async () => {
	installCursorProvider();
	const t = setup({
		accounts: {
			cursor: { type: "oauth", access: "c1", refresh: "cr1" },
			"cursor-account-2": { type: "oauth", access: "c2", refresh: "cr2" },
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
		},
		current: { provider: "cursor-account-2", id: "cursor-grok-4.6" },
		thinkingLevel: "high",
		config: { includeCursor: true, providerOrder: ["anthropic", "cursor"] },
	});
	await t.fire("session_start");
	await t.fire("agent_start");
	await finishError(
		t,
		"cursor-account-2",
		"cursor-grok-4.6",
		"429 rate_limit_error",
	);
	assert.equal(
		t.rec.setModels[0],
		"cursor/cursor-grok-4.6",
		`must take the other Cursor slot at grok, not Claude; got ${t.rec.setModels.join(", ")}`,
	);
	assert.equal(t.thinkingLevel(), "high");
	uninstallCursorProvider();
});

test("cursor-grok-4.6-high on one account matches folded grok on a sibling", async () => {
	installCursorProvider();
	const t = setup({
		accounts: {
			cursor: { type: "oauth", access: "c1", refresh: "cr1" },
			"cursor-account-2": { type: "oauth", access: "c2", refresh: "cr2" },
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
		},
		current: { provider: "cursor-account-2", id: "cursor-grok-4.6-high" },
		thinkingLevel: "high",
		config: { includeCursor: true, providerOrder: ["anthropic", "cursor"] },
	});
	await t.fire("session_start");
	await t.fire("agent_start");
	await finishError(
		t,
		"cursor-account-2",
		"cursor-grok-4.6-high",
		"429 rate_limit_error",
	);
	assert.equal(
		t.rec.setModels[0],
		"cursor/cursor-grok-4.6",
		`effort suffix is the thinking level, not a different model; got ${t.rec.setModels.join(", ")}`,
	);
	assert.equal(t.thinkingLevel(), "high");
	uninstallCursorProvider();
});

// ---------------------------------------------------------------------------
// A new OpenAI generation must not require a release of this extension (issue #2)
// ---------------------------------------------------------------------------

test("a Codex generation only the HOST knows about (gpt-5.6) wins without a release: no silent fallback to gpt-5.5", async () => {
	const accounts: Account = {
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
		"openai-codex-account-2": {
			type: "oauth",
			access: "c",
			refresh: "cr",
			accountId: "codex-2",
		},
	};
	// Pi already ships gpt-5.6; this extension's static list stops at gpt-5.5. Before the fix
	// the static list was consulted first, so failover landed on gpt-5.5 — a silent downgrade
	// that needed a new release for every OpenAI generation.
	const t = setup({
		accounts,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		hostCodexModels: ["gpt-5.6", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
	});

	await t.fire("session_start");
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate_limit_error");

	assert.ok(
		t.rec.setModels.some((m) => m.endsWith("/gpt-5.6")),
		`must select the newest generation the host knows, got: ${t.rec.setModels.join(", ")}`,
	);
	assert.ok(
		!t.rec.setModels.some((m) => m.endsWith("/gpt-5.5")),
		`must not fall back to the older generation, got: ${t.rec.setModels.join(", ")}`,
	);
	await t.fire("session_shutdown");
});

test("an unreleased Codex generation is also selectable on a numbered account alias, not just the base provider", async () => {
	const accounts: Account = {
		"openai-codex-account-2": {
			type: "oauth",
			access: "c",
			refresh: "cr",
			accountId: "codex-2",
		},
		"openai-codex-account-3": {
			type: "oauth",
			access: "d",
			refresh: "dr",
			accountId: "codex-3",
		},
	};
	// Alias slots are registered from the extension's static model list, so a host-only model
	// would not be *findable* on them even once it was ranked first.
	const t = setup({
		accounts,
		current: { provider: "openai-codex-account-2", id: "gpt-5.6" },
		hostCodexModels: ["gpt-5.6", "gpt-5.5"],
	});

	await t.fire("session_start");
	await finishError(t, "openai-codex-account-2", "gpt-5.6", "429 rate_limit_error");

	assert.equal(t.rec.setModels.at(-1), "openai-codex-account-3/gpt-5.6");
	await t.fire("session_shutdown");
});

test("failover never downgrades across accounts: gpt-5.5 on a healthy account beats gpt-5.4 on a nearer account", async () => {
	// Reproduces the reported bug: on rotation the model silently dropped from gpt-5.5 to gpt-5.4.
	// Root cause: fallback candidates were ranked ONLY by account rotation index + cooldown, so an
	// older model on a nearer (lower-index) account beat the newest model on a healthy farther
	// account. Model recency must be the PRIMARY tiebreak when preferLatestModel is on.
	const now = Date.now();
	const accounts: Account = {
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
		"openai-codex-account-2": {
			type: "oauth",
			access: "b",
			refresh: "br",
			accountId: "b",
		},
		"openai-codex-account-3": {
			type: "oauth",
			access: "c",
			refresh: "cr",
			accountId: "c",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: {
			autoContinue: false,
			fallbacks: [
				"anthropic",
				"openai-codex-account-2",
				"openai-codex-account-3",
			],
		},
		// gpt-5.5 is model-cooled on the NEARER account (account-2) only; that account is otherwise
		// healthy, so account-2/gpt-5.4 is available RIGHT NOW. account-3/gpt-5.5 is fully healthy.
		// The old rotIndex-only ranking would grab account-2/gpt-5.4 (nearer) and downgrade.
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {},
			exhaustedUntilByModel: {
				"openai-codex-account-2/gpt-5.5": now + 30 * 60 * 1000,
			},
			invalidatedByProvider: {},
			lastSwitches: [],
		},
	});
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate_limit_error");
	assert.equal(
		t.rec.setModels[0],
		"openai-codex-account-3/gpt-5.5",
		`must pick the newest model on a healthy account, not a nearer account's gpt-5.4; got: ${t.rec.setModels.join(", ")}`,
	);
	assert.ok(
		!t.rec.setModels.some((m) => m.endsWith("/gpt-5.4")),
		"must never downgrade to gpt-5.4 while gpt-5.5 is available on any healthy account",
	);
});

test("preferredModels config override pins the newest model per provider without a code change", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { preferredModels: { "openai-codex": ["gpt-5.5", "gpt-5.4"] } },
	});
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate_limit_error");
	assert.ok(
		t.rec.setModels.some((m) => m.endsWith("/gpt-5.5")),
		`override should select gpt-5.5, got: ${t.rec.setModels.join(", ")}`,
	);
});

test("failover messages are stamped with the running version so a stale (un-restarted) Pi window is obvious at a glance", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate_limit_error");
	assert.ok(
		t.rec.notifies.some((n) => /Provider failover \[v\d+\.\d+\.\d+\]:/.test(n)),
		"the switch message carries [vX.Y.Z]; its ABSENCE in a window means that window runs old code",
	);
});

test("persisted Codex catalog is registered before session_start so scoped models can resolve", () => {
	const provider = "openai-codex-account-2";
	const model = {
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
	};
	const t = setup({
		config: { autoDiscoverModels: true },
		seedState: {
			stateVersion: 5,
			codexModelCatalogByProvider: {
				[provider]: { fetchedAt: Date.now(), models: [model] },
			},
		},
	});

	assert.equal(
		t.ctx.modelRegistry.find(provider, model.id)?.name,
		model.name,
		"the cached alias model must exist during extension initialization, before Pi resolves enabledModels",
	);
});

test("an empty persisted Codex catalog keeps the static fallback through session_start", async () => {
	const provider = "openai-codex-account-2";
	const t = setup({
		config: { autoDiscoverModels: true },
		seedState: {
			stateVersion: 5,
			codexModelCatalogByProvider: {
				[provider]: { fetchedAt: Date.now(), models: [] },
			},
		},
	});

	await t.fire("session_start");
	assert.equal(t.ctx.modelRegistry.find(provider, "gpt-5.5")?.name, "GPT-5.5");
	await t.fire("session_shutdown");
});

test("disabled Codex discovery ignores persisted catalogs and keeps host models on aliases", async () => {
	const provider = "openai-codex-account-2";
	const t = setup({
		config: { autoDiscoverModels: false },
		hostCodexModels: ["gpt-5.7-sol"],
		seedState: {
			stateVersion: 5,
			codexModelCatalogByProvider: {
				[provider]: {
					fetchedAt: Date.now(),
					models: [{ id: "gpt-5.6-sol", name: "Cached 5.6 Sol" }],
				},
			},
		},
	});

	await t.fire("session_start");
	assert.equal(t.ctx.modelRegistry.find(provider, "gpt-5.7-sol")?.id, "gpt-5.7-sol");
	assert.equal(t.ctx.modelRegistry.find(provider, "gpt-5.6-sol"), undefined);
	await t.fire("session_shutdown");
});

test("reload disabling Codex discovery replaces cached alias models with host models", async () => {
	const provider = "openai-codex-account-2";
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { autoDiscoverModels: true },
		hostCodexModels: ["gpt-5.7-sol"],
		seedState: {
			stateVersion: 5,
			codexModelCatalogByProvider: {
				[provider]: {
					fetchedAt: Date.now(),
					models: [{ id: "gpt-5.6-sol", name: "Cached 5.6 Sol" }],
				},
			},
		},
	});
	await t.fire("session_start");
	assert.equal(t.ctx.modelRegistry.find(provider, "gpt-5.6-sol")?.name, "Cached 5.6 Sol");

	writeFileSync(CONFIG, JSON.stringify({ autoDiscoverModels: false }));
	await t.command("reload");
	assert.equal(t.ctx.modelRegistry.find(provider, "gpt-5.7-sol")?.id, "gpt-5.7-sol");
	assert.equal(t.ctx.modelRegistry.find(provider, "gpt-5.6-sol"), undefined);
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	assert.equal(t.rec.setModels.at(-1), provider + "/gpt-5.7-sol");
	await t.fire("session_shutdown");
});

test("credential-free catalog snapshots preserve account-specific Codex availability", async () => {
	const accounts = {
		"openai-codex": { type: "oauth", access: "base", refresh: "base-r", accountId: "base" },
		"openai-codex-account-5": { type: "oauth", access: "five", refresh: "five-r", accountId: "five" },
	};
	const model = (id: string) => ({ id, name: id, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 128000 });
	const t = setup({
		accounts,
		current: { provider: "openai-codex", id: "gpt-5.6-sol" },
		config: { autoDiscoverModels: true, onlyActive: true },
		seedState: {
			stateVersion: 5,
			codexModelCatalogByProvider: {
				"openai-codex": { fetchedAt: Date.now(), models: [model("gpt-5.6-sol"), model("gpt-5.6-terra")] },
				"openai-codex-account-5": { fetchedAt: Date.now(), models: [model("gpt-5.6-terra"), model("gpt-5.5")] },
			},
		},
	});
	await t.fire("session_start");
	const snapshot = t.rec.catalogSnapshots.at(-1);
	const base = snapshot.models.filter((entry: any) => entry.provider === "openai-codex").map((entry: any) => entry.id);
	const account5 = snapshot.models.filter((entry: any) => entry.provider === "openai-codex-account-5").map((entry: any) => entry.id);
	assert.ok(base.includes("gpt-5.6-sol"));
	assert.deepEqual(account5.sort(), ["gpt-5.5", "gpt-5.6-terra"]);
});

test("Sol rotation stays frontier: next skips a Terra-only account and preserves effort", async () => {
	const accounts = {
		"openai-codex": { type: "oauth", access: "base", refresh: "base-r", accountId: "base" },
		"openai-codex-account-2": { type: "oauth", access: "two", refresh: "two-r", accountId: "two" },
		"openai-codex-account-5": { type: "oauth", access: "five", refresh: "five-r", accountId: "five" },
		anthropic: { type: "oauth", access: "anthropic", refresh: "anthropic-r" },
	};
	const model = (id: string) => ({
		id,
		name: id,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	});
	const t = setup({
		accounts,
		current: { provider: "openai-codex", id: "gpt-5.6-sol" },
		thinkingLevel: "xhigh",
		config: { autoDiscoverModels: true, preferLatestModel: false },
		seedState: {
			stateVersion: 5,
			codexModelCatalogByProvider: {
				"openai-codex": { fetchedAt: Date.now(), models: [model("gpt-5.6-sol")] },
				"openai-codex-account-2": { fetchedAt: Date.now(), models: [model("gpt-5.6-sol")] },
				"openai-codex-account-5": { fetchedAt: Date.now(), models: [model("gpt-5.6-terra")] },
			},
		},
	});
	await t.fire("agent_start");
	await t.command("next");
	assert.equal(t.rec.setModels.at(-1), "openai-codex-account-2/gpt-5.6-sol");
	assert.equal(t.thinkingLevel(), "xhigh");

	await t.command("next");
	assert.match(
		t.rec.setModels.at(-1) ?? "",
		/^anthropic\/claude-opus-/,
		"a Terra-only slot must be skipped; Opus is the cross-provider frontier peer",
	);
	assert.equal(t.thinkingLevel(), "xhigh", "manual rotation must keep the user's effort");
	assert.ok(
		!t.rec.setModels.includes("openai-codex-account-5/gpt-5.6-terra"),
		"Sol must never silently become Terra",
	);
	await t.fire("session_shutdown");
});

test("automatic failover from Sol never lands on a Terra-only account", async () => {
	const accounts = {
		"openai-codex": { type: "oauth", access: "base", refresh: "base-r", accountId: "base" },
		"openai-codex-account-5": { type: "oauth", access: "five", refresh: "five-r", accountId: "five" },
		anthropic: { type: "oauth", access: "anthropic", refresh: "anthropic-r" },
	};
	const model = (id: string) => ({ id, name: id, reasoning: true, input: ["text"] });
	const t = setup({
		accounts,
		current: { provider: "openai-codex", id: "gpt-5.6-sol" },
		config: { autoDiscoverModels: true, preferLatestModel: false },
		seedState: {
			stateVersion: 5,
			codexModelCatalogByProvider: {
				"openai-codex": { fetchedAt: Date.now(), models: [model("gpt-5.6-sol")] },
				"openai-codex-account-5": { fetchedAt: Date.now(), models: [model("gpt-5.6-terra")] },
			},
		},
	});
	await finishError(t, "openai-codex", "gpt-5.6-sol", "429 usage limit");
	assert.match(t.rec.setModels.at(-1) ?? "", /^anthropic\/claude-opus-/);
	assert.ok(!t.rec.setModels.some((entry) => entry.endsWith("/gpt-5.6-terra")));
	await t.fire("session_shutdown");
});

test(
	"live OpenAI catalog adds an unseen flagship to account aliases and failover selects it at high",
	{ concurrency: false },
	async (testContext) => {
		testContext.mock.method(globalThis, "fetch", async () =>
			new Response(
				JSON.stringify({
					models: [
						{
							slug: "gpt-5.6-luna",
							display_name: "5.6 Luna",
							visibility: "list",
							priority: 30,
							supported_reasoning_levels: [{ effort: "high" }],
						},
						{
							slug: "gpt-5.6-sol",
							display_name: "5.6 Sol",
							visibility: "list",
							priority: 10,
							supported_reasoning_levels: [
								{ effort: "low" },
								{ effort: "medium" },
								{ effort: "high" },
								{ effort: "xhigh" },
							],
						},
						{
							slug: "gpt-5.6-terra",
							display_name: "5.6 Terra",
							visibility: "list",
							priority: 20,
							supported_reasoning_levels: [{ effort: "high" }],
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		const t = setup({
			accounts: {
				anthropic: { type: "oauth", access: "anthropic-access", refresh: "anthropic-refresh" },
				"openai-codex-account-2": {
					type: "oauth",
					access: "codex-access",
					refresh: "codex-refresh",
					accountId: "codex-account",
				},
			},
			current: { provider: "anthropic", id: "claude-opus-4-8" },
			config: { autoDiscoverModels: true, reasoningLevel: "high" },
		});

		await t.fire("session_start");
		await t.fire("agent_start");
		await finishError(t, "anthropic", "claude-opus-4-8", "429 rate_limit_error");

		assert.ok(
			t.rec.setModels.includes("openai-codex-account-2/gpt-5.6-sol"),
			`new flagship must be selectable without a static extension edit: ${JSON.stringify(t.rec.setModels)}`,
		);
		assert.ok(t.rec.thinkingLevels.includes("high"));
		assert.ok(
			!t.rec.thinkingLevels.includes("xhigh"),
			"xhigh is an extreme opt-in level and must never be selected by default",
		);
		await t.fire("session_shutdown");
	},
);

// ---------------------------------------------------------------------------
// v1.13.0 black box: every decision is recorded so real bugs become reproducible
// ---------------------------------------------------------------------------

test("a real failover writes a structured switch + assistant_error to the debug log", async () => {
	rmSync(DEBUG_LOG, { force: true });
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate_limit_error");
	const events = readDebugLog();
	const classified = events.find((e) => e.kind === "assistant_error");
	assert.equal(
		classified?.classified,
		"limit",
		"the error is logged and classified",
	);
	const sw = events.find((e) => e.kind === "switch");
	assert.ok(sw, "the actual account switch is recorded");
	assert.match(
		String(sw?.to),
		/openai-codex-account-2/,
		"the log captures which account it switched to",
	);
});

test("the debug log never contains token-like material (defensive redaction)", async () => {
	rmSync(DEBUG_LOG, { force: true });
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	// An error string that embeds a JWT/token-shaped blob must be redacted in the log.
	await finishError(
		t,
		"anthropic",
		"claude-opus-4-8",
		"429 rate limit; token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payloadpayloadpayload.sigsigsig",
	);
	const raw = (() => {
		try {
			return readFileSync(DEBUG_LOG, "utf8");
		} catch {
			return "";
		}
	})();
	assert.ok(raw.length > 0, "something was logged");
	assert.ok(
		!/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.payloadpayloadpayload/.test(raw),
		"the JWT-shaped blob is redacted, never written verbatim",
	);
	assert.ok(raw.includes("«redacted»"), "redaction marker is present");
});

test("/multi-account log shows recent events and reports the file path", async () => {
	rmSync(DEBUG_LOG, { force: true });
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate_limit_error");
	t.rec.notifies.length = 0;
	await t.command("log 20");
	assert.ok(
		t.rec.notifies.some(
			(n) => /debug log/i.test(n) && /switch|assistant_error/.test(n),
		),
		"the log command surfaces the recorded events to the user",
	);
});

test("/multi-account log off then on toggles recording without crashing", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await t.command("log off");
	rmSync(DEBUG_LOG, { force: true });
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate_limit_error");
	assert.equal(
		readDebugLog().length,
		0,
		"with logging off, no events are written",
	);
	await t.command("log on");
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate_limit_error");
	assert.ok(readDebugLog().length > 0, "with logging on again, events resume");
});

// ---------------------------------------------------------------------------
// v1.13.6 regression tests:
//  - API-key providers: repeated same-key 401s eventually invalidate (was an
//    infinite 1-minute cooldown loop because same-hash failures never advanced
//    toward the kill threshold).
//  - Re-login (credential change) clears stale authFailures tracking for accounts
//    on transient cooldown (not just invalidated ones).
// ---------------------------------------------------------------------------

test("api_key provider: repeated same-key 401s eventually invalidate (no infinite loop)", async () => {
	const accounts = {
		ollama: { type: "api_key", key: "dead-key" },
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
	};
	const t = setup({
		accounts,
		current: { provider: "ollama", id: "glm-5.2:cloud" },
		config: {
			autoContinue: false,
			autoDiscover: true,
			fallbacks: ["ollama", "anthropic"],
		},
	});
	// First 401: transient cooldown, not invalidated.
	t.setCurrent("ollama", "glm-5.2:cloud");
	await t.fire("agent_start");
	await finishError(t, "ollama", "glm-5.2:cloud", "401 Unauthorized");
	assert.ok(
		!t.readState().invalidatedByProvider?.ollama,
		"first 401 must not invalidate an api_key provider",
	);
	// Second 401: still transient, but the same-key counter advances.
	t.setCurrent("ollama", "glm-5.2:cloud");
	await t.fire("agent_start");
	await finishError(t, "ollama", "glm-5.2:cloud", "401 Unauthorized");
	assert.ok(
		!t.readState().invalidatedByProvider?.ollama,
		"second 401 must not invalidate yet",
	);
	// Third 401: same key has failed MAX_SAME_KEY_AUTH_FAILURES times → invalidate.
	t.setCurrent("ollama", "glm-5.2:cloud");
	await t.fire("agent_start");
	await finishError(t, "ollama", "glm-5.2:cloud", "401 Unauthorized");
	assert.ok(
		t.readState().invalidatedByProvider?.ollama,
		"after 3 consecutive same-key 401s, an api_key provider must be invalidated to break the loop",
	);
});

test("oauth provider: repeated same-token 401s do NOT invalidate (refresh-fault tolerant)", async () => {
	const accounts = {
		anthropic: { type: "oauth", access: "static-tok", refresh: "static-ref" },
		"openai-codex-account-2": {
			type: "oauth",
			access: "c",
			refresh: "cr",
			accountId: "c2",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: {
			autoContinue: false,
			fallbacks: ["anthropic", "openai-codex-account-2"],
		},
	});
	// 10 repeated 401s on the SAME token (same hash) — must NEVER invalidate.
	for (let i = 0; i < 10; i++) {
		t.setCurrent("anthropic", "claude-opus-4-8");
		await t.fire("agent_start");
		await finishError(t, "anthropic", "claude-opus-4-8", "401 Unauthorized");
	}
	assert.ok(
		!t.readState().invalidatedByProvider?.anthropic,
		"same-hash 401s on an OAuth provider must not invalidate (refresh-fault, not revoked)",
	);
});

test("re-login with new credentials clears stale authFailures for transient-cooldown accounts", async () => {
	const accounts = {
		ollama: { type: "api_key", key: "old-key" },
		anthropic: { type: "oauth", access: "a", refresh: "ar" },
	};
	const t = setup({
		accounts,
		current: { provider: "ollama", id: "glm-5.2:cloud" },
		config: {
			autoContinue: false,
			autoDiscover: true,
			fallbacks: ["ollama", "anthropic"],
		},
	});
	// Trigger two 401s to build up a same-key failure streak.
	for (let i = 0; i < 2; i++) {
		t.setCurrent("ollama", "glm-5.2:cloud");
		await t.fire("agent_start");
		await finishError(t, "ollama", "glm-5.2:cloud", "401 Unauthorized");
	}
	assert.ok(!t.readState().invalidatedByProvider?.ollama);
	// Simulate re-login: write new credentials to auth.json.
	writeFileSync(
		AUTH,
		JSON.stringify({
			ollama: { type: "api_key", key: "new-valid-key" },
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
		}),
	);
	// Trigger refreshDiscovery via session_start (detects auth.json mtime change).
	await t.fire("session_start", { reason: "startup" });
	// After re-login, the stale authFailures entry must be cleared. A single new 401
	// should NOT immediately invalidate (the counter starts fresh).
	t.setCurrent("ollama", "glm-5.2:cloud");
	await t.fire("agent_start");
	await finishError(t, "ollama", "glm-5.2:cloud", "401 Unauthorized");
	assert.ok(
		!t.readState().invalidatedByProvider?.ollama,
		"after re-login, a single 401 must not invalidate — stale same-key counter was cleared",
	);
});

// ---------------------------------------------------------------------------
// Interrupted-turn preservation across a real failover
// ---------------------------------------------------------------------------

test("the turn that triggered the failover survives into the account that takes over", async () => {
	const t = setup({
		current: { provider: "openai-codex", id: "gpt-5.5" },
		config: { autoDiscover: true, fallbacks: ["ollama"] },
	});
	await t.fire("agent_start");
	// A turn that got real work done before the quota wall hit mid tool-batch.
	const interrupted = {
		role: "assistant",
		provider: "openai-codex",
		model: "gpt-5.5",
		stopReason: "error",
		errorMessage: "Codex error: The usage limit has been reached",
		timestamp: messageTimestamp++,
		content: [
			{ type: "thinking", thinking: "Schema first, then the seed." },
			{ type: "text", text: "Applied migration 0042." },
			{
				type: "toolCall",
				id: "call_seed",
				name: "bash",
				arguments: { command: "npm run db:seed" },
			},
		],
	};
	await t.fire("message_end", { message: interrupted });
	t.setIdle(true);
	await t.fire("agent_end", { messages: [interrupted] });
	assert.ok(t.rec.setModels.length > 0, "the account must actually have switched");

	// The next request on the account we switched TO goes through the context hook.
	const result = await t.fire("context", {
		messages: [
			{ role: "user", content: [{ type: "text", text: "migrate + seed" }], timestamp: 1 },
			interrupted,
		],
	});
	assert.ok(result?.messages, "the hook must rewrite the transcript");
	assert.equal(
		result.messages.some((m: any) => m.role === "assistant"),
		false,
		"nothing may be left for pi-ai to drop",
	);
	const handoff = JSON.stringify(result.messages);
	assert.ok(handoff.includes("Schema first, then the seed."), "reasoning survives");
	assert.ok(handoff.includes("Applied migration 0042."), "output survives");
	assert.ok(handoff.includes("npm run db:seed"), "the unfinished tool call survives");
	assert.ok(
		handoff.includes("result: NONE"),
		"the account taking over must be told which call never returned",
	);
});

test("preserveInterruptedContext: false restores the old drop-everything behaviour", async () => {
	const t = setup({
		current: { provider: "openai-codex", id: "gpt-5.5" },
		config: { autoDiscover: true, preserveInterruptedContext: false },
	});
	const result = await t.fire("context", {
		messages: [
			{
				role: "assistant",
				provider: "openai-codex",
				model: "gpt-5.5",
				stopReason: "error",
				content: [{ type: "text", text: "work" }],
				timestamp: messageTimestamp++,
			},
		],
	});
	assert.equal(result, undefined, "opted out: the transcript must pass through untouched");
});

// ---------------------------------------------------------------------------
// Auto-continue on hosts without pi.continueAgent (0.80.3+)
// ---------------------------------------------------------------------------

test("a same-account pending resume auto-continues on a host without pi.continueAgent", async () => {
	// The regression: `currentPromptSwitch` is set only when we ROTATE accounts. A transient
	// overload deliberately retries the SAME account, so there is no switch record — and the
	// injection fallback used to require one. On every build since pi-coding-agent 0.80.3
	// (where continueAgent was removed) that combination silently refused to continue and told
	// the user "this Pi build cannot auto-resume", leaving them to re-send the prompt by hand.
	const accounts: Account = {
		"openai-codex-account-2": {
			type: "oauth",
			access: "b",
			refresh: "br",
			accountId: "codex-2",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		config: { transientCooldownMs: 500, pendingPollMs: 200 },
		omitContinueAgent: true,
	});
	await t.fire("session_start");
	await finishError(
		t,
		"openai-codex-account-2",
		"gpt-5.5",
		"Codex err: Our servers are currently overloaded. Please try again later.",
	);
	assert.ok(
		t.readState().pendingFrom && t.readState().pendingReason,
		"pending retry must be armed",
	);
	await wait(1300);
	assert.equal(
		t.rec.setModels.length,
		0,
		"a transient overload must still not rotate accounts",
	);
	assert.equal(
		t.rec.sent.length,
		1,
		"without continueAgent the continuation prompt MUST be injected instead of stalling",
	);
	assert.equal(
		t.rec.sent[0].options?.deliverAs,
		"followUp",
		"the injection must queue behind the current turn, never be rejected as 'already processing'",
	);
	assert.match(String(t.rec.sent[0].prompt), /retrying .*no account or model switch occurred/i);
	assert.doesNotMatch(String(t.rec.sent[0].prompt), /switched to .* after .*\/gpt-5\.5/i);
});

test("one Pi window never resumes another window's pending task", async () => {
	const provider = "openai-codex-account-2";
	const t = setup({
		accounts: {
			[provider]: {
				type: "oauth",
				access: "b",
				refresh: "br",
				accountId: "codex-2",
			},
		},
		current: { provider, id: "gpt-5.5" },
		config: { transientCooldownMs: 500, pendingPollMs: 200 },
		omitContinueAgent: true,
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {},
			exhaustedUntilByModel: {},
			invalidatedByProvider: {},
			lastProbeAtByProvider: {},
			pendingFrom: "anthropic/claude-opus-5",
			pendingReason: "another window's task",
			pendingSince: Date.now(),
			pendingOwner: "some-other-live-session",
		},
	});
	await t.fire("session_start");
	await finishError(t, provider, "gpt-5.5", "500 server error");
	await wait(1300);

	assert.equal(t.rec.sent.length, 1, "this session's own retry must still run");
	assert.match(String(t.rec.sent[0].prompt), new RegExp(provider));
	assert.doesNotMatch(String(t.rec.sent[0].prompt), /another window|anthropic/);
	assert.equal(
		t.readState().pendingOwner,
		"some-other-live-session",
		"the shared diagnostic marker remains owned by the other window",
	);
	await t.fire("session_shutdown");
});

test("repeated 500s on an automatic same-model retry trip the breaker instead of looping eight times", async () => {
	const provider = "openai-codex-account-2";
	const error = "500 server error";
	const t = setup({
		accounts: {
			[provider]: {
				type: "oauth",
				access: "b",
				refresh: "br",
				accountId: "codex-2",
			},
		},
		current: { provider, id: "gpt-5.5" },
		config: { transientCooldownMs: 25, pendingPollMs: 25 },
		omitContinueAgent: true,
	});
	await t.fire("session_start");
	await finishError(t, provider, "gpt-5.5", error);

	for (let attempt = 0; attempt < 3; attempt++) {
		await wait(1100);
		assert.equal(t.rec.sent.length, attempt + 1, "one extension retry per recovery attempt");
		await t.fire("before_agent_start", {});
		await finishError(t, provider, "gpt-5.5", error);
	}

	assert.ok(
		t.rec.notifies.some((message) => /safe mode|pausing auto-continue/i.test(message)),
		"three failed retries must visibly stop automatic continuation",
	);
	assert.equal(t.readState().pendingFrom, undefined, "the breaker must leave no wake armed");
	await wait(1100);
	assert.equal(t.rec.sent.length, 3, "no fourth synthetic user prompt may be injected");
	await t.fire("session_shutdown");
});

test("a blocked continuation records why, instead of failing silently", async () => {
	// Every refusal used to be silent, so a session that stopped continuing by itself left
	// nothing in the debug log to explain it — the visible warning blamed the Pi build even
	// when the real cause was a spent auto-continue budget or a disabled autoContinue.
	const accounts: Account = {
		"openai-codex-account-2": {
			type: "oauth",
			access: "b",
			refresh: "br",
			accountId: "codex-2",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		config: {
			transientCooldownMs: 500,
			pendingPollMs: 200,
			autoContinue: false,
		},
		omitContinueAgent: true,
	});
	await t.fire("session_start");
	await finishError(
		t,
		"openai-codex-account-2",
		"gpt-5.5",
		"Codex err: Our servers are currently overloaded. Please try again later.",
	);
	await wait(1300);
	assert.equal(t.rec.sent.length, 0, "autoContinue: false must not inject");
	const log = readFileSync(join(AGENT_DIR, "provider-failover-debug.log"), "utf8");
	assert.ok(
		!log.includes("continuation_injection_blocked") ||
			/"reason":"autoContinue disabled"/.test(log),
		"if a refusal is logged at all it must name the real reason, never a generic failure",
	);
});

// ---------------------------------------------------------------------------
// Verify, don't predict: a provider's forecast never parks an account
// ---------------------------------------------------------------------------

test("a month-long quota forecast cannot park an account past the recheck ceiling", async () => {
	// Providers reset quota windows early and unannounced, and resize the windows themselves, so
	// "used 100%, resets in 29 days" is a forecast about the future — not evidence. Before the
	// ceiling it was treated as authoritative ground truth REGARDLESS of snapshot age, so a single
	// stale reading could park an account for weeks and the work simply waited. Now the forecast
	// only orders the queue; the account is asked again within maxRecheckIntervalMs and answers
	// for itself. (A refused request costs no tokens, so asking is close to free.)
	const now = Date.now();
	const accounts: Account = {
		"openai-codex-account-2": {
			type: "oauth",
			access: "b",
			refresh: "br",
			accountId: "codex-2",
		},
		"openai-codex-account-6": {
			type: "oauth",
			access: "f",
			refresh: "fr",
			accountId: "codex-6",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		// Ceiling squeezed to sub-second so the test asserts the mechanism, not the clock.
		config: { maxRecheckIntervalMs: 700, pendingPollMs: 150 },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {},
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			usageByProvider: {
				"openai-codex-account-6": {
					provider: "openai-codex-account-6",
					family: "codex",
					fetchedAt: now,
					primary: {
						usedPercent: 100,
						resetAt: now + 29 * 24 * 60 * 60 * 1000,
					},
				},
			},
			lastSwitches: [],
		},
	});
	await t.fire("session_start");
	await finishError(
		t,
		"openai-codex-account-2",
		"gpt-5.5",
		"You have hit your ChatGPT usage limit (free plan). Try again in ~41762 min.",
	);
	// account-6 is the only other account and its forecast says "29 days". The work must still
	// reach it once the ceiling elapses, instead of waiting out a prediction.
	await wait(1500);
	assert.ok(
		t.rec.setModels.some((target: string) =>
			target.startsWith("openai-codex-account-6/"),
		),
		`a forecast must not park an account past the ceiling; switches were ${JSON.stringify(t.rec.setModels)}`,
	);
});

test("once the recheck ceiling elapses, an untried account still outranks one that refused", async () => {
	// The ceiling deliberately puts a refused account BACK in the candidate pool. Ordering is then
	// the only thing keeping us off it: rotation position alone would send us straight back to the
	// account that just said "usage limit reached", get the same refusal, and loop between spent
	// accounts while a never-tried one sat further down the ring.
	const accounts: Account = {
		"openai-codex-account-2": {
			type: "oauth",
			access: "b",
			refresh: "br",
			accountId: "codex-2",
		},
		"openai-codex-account-6": {
			type: "oauth",
			access: "f",
			refresh: "fr",
			accountId: "codex-6",
		},
		"openai-codex-account-7": {
			type: "oauth",
			access: "g",
			refresh: "gr",
			accountId: "codex-7",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "openai-codex-account-7", id: "gpt-5.5" },
		// Squeezed so the ceiling elapses inside the test rather than in ten minutes.
		config: { autoDiscover: true, maxRecheckIntervalMs: 300 },
	});
	await t.fire("session_start");
	// account-2 refuses. It is not the account we are on, so it earns no anti-ping-pong credit.
	await finishError(
		t,
		"openai-codex-account-2",
		"gpt-5.5",
		"You have hit your ChatGPT usage limit (free plan). Try again in ~41762 min.",
	);
	// Let its (ceiling-capped) cooldown lapse: account-2 is selectable again on paper.
	await wait(600);
	const before = t.rec.setModels.length;
	t.setCurrent("openai-codex-account-7", "gpt-5.5");
	await finishError(
		t,
		"openai-codex-account-7",
		"gpt-5.5",
		"You have hit your ChatGPT usage limit (free plan). Try again in ~43190 min.",
	);
	const landed = t.rec.setModels.slice(before);
	assert.ok(landed.length > 0, "the refusal must move us somewhere");
	assert.ok(
		landed[0].startsWith("openai-codex-account-6/"),
		`the never-tried account must win over the one that refused moments ago (went to ${landed[0]})`,
	);
});

test("reasoningLevel: max is honoured instead of being silently dropped to auto", async () => {
	// Issue #15, second half: adding `max` to the catalog is not enough. The config parser
	// enumerated the accepted levels and stopped at `xhigh`, so `reasoningLevel: "max"` fell
	// through to "auto" — the level was never forced, and nothing said why.
	const t = setup({
		accounts: THINKING_ACCOUNTS,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		thinkingLevel: "low",
		config: { reasoningLevel: "max" }, // opt-in override, same as any other explicit level
	});

	await t.fire("session_start");
	await t.fire("agent_start");

	assert.equal(
		t.thinkingLevel(),
		"max",
		"an explicitly configured max must be applied, not discarded as unknown",
	);
});

test("max survives a switch through a weaker model, exactly like every other level", async () => {
	// Guarantee #22 ("your thinking level is yours") must hold for the newly-accepted level too:
	// a weaker fallback model's clamp is restored, never adopted as the new intent.
	const t = setup({
		accounts: THINKING_ACCOUNTS,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		thinkingLevel: "max",
		// The codex account tops out at high — Pi clamps max down to high there.
		thinkingCaps: { "openai-codex-account-2": "high" },
	});

	await t.fire("session_start");
	await t.fire("agent_start");
	assert.equal(t.thinkingLevel(), "max");

	await t.command("next"); // → codex, where max is clamped to high
	assert.equal(t.thinkingLevel(), "high", "the host clamp is expected here");

	await t.fire("agent_start");
	await t.command("next"); // → back to a model that supports max
	assert.equal(
		t.thinkingLevel(),
		"max",
		`max must return once a capable model is back: ${JSON.stringify(t.rec.thinkingLevels)}`,
	);
	assert.ok(
		!t.rec.thinkingLevels.includes("high"),
		`the extension must never ASK for the clamped level: ${JSON.stringify(t.rec.thinkingLevels)}`,
	);
});

// ---------------------------------------------------------------------------
// A refusal outranks the quota meter (issue: bounced back onto a spent account)
// ---------------------------------------------------------------------------

test("the FIRST refusal already benches an account whose usage meter claims headroom", async () => {
	// Real report: seven Codex accounts, six at 100% and one reading 98%. The 98% account was
	// picked, greeted the user, then refused the first real request with "You have hit your
	// ChatGPT usage limit (free plan)". It was benched — and the very next usage refresh saw
	// 98% (< 100%), decided the account was free, wiped the cooldown, and rotation walked
	// straight back onto it. The loop only broke on the SECOND refusal.
	//
	// One refusal is already proof. A used-percentage is a forecast about a quota window that
	// cannot see this account's real (session/plan) limit; a refusal is an observation that just
	// happened. The observation must win the first time, not the second.
	const now = Date.now();
	const t = setup({
		accounts: ONE_ACCOUNT,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { pendingPollMs: 40 },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {},
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			usageByProvider: {
				anthropic: {
					provider: "anthropic",
					family: "anthropic",
					fetchedAt: now,
					// The exact shape that caused it: just short of the cap, so the meter says "free".
					primary: { usedPercent: 98, resetAt: now + 5 * 60 * 60 * 1000 },
				},
			},
			lastSwitches: [],
		},
	});
	await t.fire("session_start");

	await finishError(
		t,
		"anthropic",
		"claude-opus-4-8",
		"You have hit your ChatGPT usage limit (free plan). Try again in ~41615 min.",
	);
	// Let the usage reconciliation run: this is where the 98% reading used to clear the bench.
	await wait(260);

	const until = t.readState().exhaustedUntilByProvider?.anthropic;
	assert.ok(
		typeof until === "number" && until > Date.now() + 60_000,
		`one refusal must bench the account for a real interval, got ${JSON.stringify(until)}`,
	);
});

test("a distrusted usage meter survives a restart instead of re-opening the loop", async () => {
	// The distrust flag lived only in memory. Every new Pi session started believing the meter
	// again, so a spent account was re-selected once per session — which is why this kept
	// recurring all day rather than settling after the first two refusals.
	const now = Date.now();
	const seedState = {
		stateVersion: 5,
		exhaustedUntilByProvider: {},
		exhaustedUntilByModel: {},
		lastProbeAtByProvider: {},
		invalidatedByProvider: {},
		usageByProvider: {
			anthropic: {
				provider: "anthropic",
				family: "anthropic",
				fetchedAt: now,
				primary: { usedPercent: 98, resetAt: now + 5 * 60 * 60 * 1000 },
			},
		},
		lastSwitches: [],
	};

	const first = setup({
		accounts: ONE_ACCOUNT,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { pendingPollMs: 40 },
		seedState,
	});
	await first.fire("session_start");
	await finishError(
		first,
		"anthropic",
		"claude-opus-4-8",
		"You have hit your ChatGPT usage limit (free plan). Try again in ~41615 min.",
	);
	await wait(120);

	const carried = first.readState();
	assert.ok(
		carried.usageUntrustedUntilByProvider?.anthropic > Date.now(),
		"the proof that this account's meter lies must be written down, not held in memory",
	);

	// A brand-new session reads that state back.
	const second = setup({
		accounts: ONE_ACCOUNT,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { pendingPollMs: 40 },
		seedState: carried,
	});
	await second.fire("session_start");
	await wait(260);

	const until = second.readState().exhaustedUntilByProvider?.anthropic;
	assert.ok(
		typeof until === "number" && until > Date.now() + 60_000,
		`a restart must not re-trust a meter already proven wrong, got ${JSON.stringify(until)}`,
	);
});

test("a real success re-trusts the meter and clears the bench", async () => {
	// The distrust must not be permanent: the account genuinely recovering has to be able to
	// undo it, otherwise a spent account would never come back.
	const now = Date.now();
	const t = setup({
		accounts: ONE_ACCOUNT,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { pendingPollMs: 40 },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {},
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			usageUntrustedUntilByProvider: { anthropic: now + 30 * 60 * 1000 },
			usageByProvider: {
				anthropic: {
					provider: "anthropic",
					family: "anthropic",
					fetchedAt: now,
					primary: { usedPercent: 98, resetAt: now + 5 * 60 * 60 * 1000 },
				},
			},
			lastSwitches: [],
		},
	});
	await t.fire("session_start");
	const ok = {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		provider: "anthropic",
		model: "claude-opus-4-8",
		stopReason: "end_turn",
		timestamp: messageTimestamp++,
	};
	await t.fire("message_end", { message: ok });
	t.setIdle(true);
	await t.fire("agent_end", { messages: [ok] });
	await wait(80);

	const state = t.readState();
	assert.ok(
		!(state.usageUntrustedUntilByProvider?.anthropic > Date.now()),
		"a successful response proves the account works and must restore trust",
	);
	assert.ok(
		state.exhaustedUntilByProvider?.anthropic === undefined,
		"and it must not stay benched",
	);
});

test("a bare throttle with no stated horizon still defers to the usage meter", async () => {
	// The narrow half of the same rule. When the provider says only "429 rate limit" it has made
	// no claim about when the account returns, so the meter remains the better evidence and an
	// account whose window is genuinely empty must not be benched.
	const now = Date.now();
	const t = setup({
		accounts: ONE_ACCOUNT,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { pendingPollMs: 40 },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {},
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			usageByProvider: {
				anthropic: {
					provider: "anthropic",
					family: "anthropic",
					fetchedAt: now,
					primary: { usedPercent: 0, resetAt: now - 1_000 },
				},
			},
			lastSwitches: [],
		},
	});
	await t.fire("session_start");
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate limit");
	await wait(120);

	assert.ok(
		!(t.readState().usageUntrustedUntilByProvider?.anthropic > Date.now()),
		"a horizon-free throttle is not evidence that the meter is lying",
	);
});

// ---------------------------------------------------------------------------
// Manual selection: it must hold, and it must say where it put you
// ---------------------------------------------------------------------------

test("a manually chosen account survives the preflight for one attempt", async () => {
	// `next` deliberately ignores cooldowns, because the quota bookkeeping is a guess and trying
	// the account is the only way to prove the guess wrong. But the preflight that runs on the
	// user's very next message re-applied that same bookkeeping and moved them off — so the
	// override held only until it was used, which is exactly when it mattered. One attempt must
	// go where the user asked; ordinary failover takes over from there.
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedCooldownsMsFromNow: { "openai-codex-account-2": 60 * 60 * 1000 },
	});
	await t.command("next");
	assert.deepEqual(t.rec.setModels, ["openai-codex-account-2/gpt-5.5"]);

	const before = t.rec.setModels.length;
	await t.input("do the thing");

	assert.equal(
		t.rec.setModels.length,
		before,
		`the preflight must not undo an explicit choice; it moved to ${t.rec.setModels.slice(before).join(", ")}`,
	);
});

test("the manual reprieve is spent after one attempt", async () => {
	// It is one attempt, not a permanent pin: once the chosen account has had its chance, normal
	// routing resumes, otherwise a user could strand themselves on a genuinely dead account.
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedCooldownsMsFromNow: { "openai-codex-account-2": 60 * 60 * 1000 },
	});
	await t.command("next");
	await t.input("first");
	const before = t.rec.setModels.length;
	await t.input("second");

	assert.ok(
		t.rec.setModels.length > before,
		"the second attempt must fall back to normal routing",
	);
});

test("next says where it landed and whether that account is believed spent", async () => {
	// It used to switch silently onto a cooled account and then be silently moved off it, so the
	// user saw two switches and ended up somewhere they never chose. Saying it plainly costs
	// nothing and removes the whole confusion.
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedCooldownsMsFromNow: { "openai-codex-account-2": 60 * 60 * 1000 },
	});
	await t.command("next");

	const said = t.rec.notifies.join("\n");
	assert.match(said, /openai-codex-account-2/, "it must name the account it chose");
	assert.match(
		said,
		/spent|cooling|cooldown/i,
		`and admit that account is believed spent; said: ${said}`,
	);
});

test("status shows how to switch to a specific account, not just next", async () => {
	// The direct switch existed all along but was buried mid-way through one dense pipe-separated
	// line of eighteen commands, so the only discoverable way to reach a chosen account was
	// pressing `next` repeatedly until it came round.
	const t = setup({ current: { provider: "anthropic", id: "claude-opus-4-8" } });
	await t.command("status");

	const said = t.rec.notifies.join("\n");
	assert.match(
		said,
		/switch <provider>.*openai-codex-account-2|switch openai-codex-account-2/,
		`status must show a usable switch example; said: ${said}`,
	);
});

test("accounts lists provider identity, quota and routing state without credentials", async () => {
	const now = Date.now();
	const accounts: Account = {
		anthropic: { type: "oauth", access: "anthropic-secret", refresh: "anthropic-refresh" },
		"openai-codex-account-2": {
			type: "oauth",
			access: "codex-secret",
			refresh: "codex-refresh",
			accountId: "workspace-safe-id",
		},
	};
	const t = setup({
		accounts,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {
				"openai-codex-account-2": now + 30 * 60_000,
			},
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			usageByProvider: {
				"openai-codex-account-2": {
					provider: "openai-codex-account-2",
					family: "codex",
					fetchedAt: now,
					account: "alice@example.com",
					plan: "plus",
					serviceable: false,
					primary: {
						usedPercent: 20,
						resetAt: now + 60 * 60_000,
						windowSeconds: 18_000,
					},
					secondary: {
						usedPercent: 50,
						resetAt: now + 2 * 86_400_000,
						windowSeconds: 604_800,
					},
				},
			},
			lastSwitches: [],
		},
	});

	await t.command("accounts");
	const table = t.rec.notifies.at(-1) ?? "";
	assert.match(table, /Slot\s+Alias\s+Account\s+Plan\s+Primary\s+Secondary\s+Status/);
	assert.match(table, /openai-codex-account-2\s+alice\s+alice@example\.com\s+plus/);
	assert.match(table, /5h 80%/);
	assert.match(table, /7d 50%/);
	assert.match(table, /cooldown \d+m/);
	assert.match(table, /\banthropic\b[\s\S]*\bready\b/);
	assert.doesNotMatch(table, /anthropic-secret|anthropic-refresh|codex-secret|codex-refresh|workspace-safe-id/);
});

test("accounts refresh explicitly loads every supported account while the footer is disabled", async () => {
	const originalFetch = globalThis.fetch;
	let authorization = "";
	globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
		authorization = new Headers(init?.headers).get("Authorization") ?? "";
		return new Response(
			JSON.stringify({
				plan_type: "plus",
				email: "bob@example.com",
				rate_limit: {
					allowed: true,
					primary_window: {
						used_percent: 25,
						limit_window_seconds: 18_000,
						reset_at: Math.floor(Date.now() / 1000) + 3600,
					},
				},
			}),
			{ status: 200 },
		);
	}) as typeof fetch;
	try {
		const t = setup({
			accounts: {
				"openai-codex": {
					type: "oauth",
					access: "refresh-only-secret",
					refresh: "refresh-only-token",
					accountId: "workspace-id",
				},
			},
			current: { provider: "openai-codex", id: "gpt-5.5" },
			config: { showUsage: false },
		});
		await t.command("accounts refresh");
		const table = t.rec.notifies.at(-1) ?? "";
		assert.equal(authorization, "Bearer refresh-only-secret");
		assert.match(table, /bob\s+bob@example\.com\s+plus/);
		assert.match(table, /5h 75%/);
		assert.doesNotMatch(table, /refresh-only-secret|refresh-only-token|workspace-id/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

// ---------------------------------------------------------------------------
// Providers outside the five specially-managed families
// ---------------------------------------------------------------------------

const MIXED_ACCOUNTS: Account = {
	anthropic: { type: "oauth", access: "a-tok-1", refresh: "a-ref-1" },
	zai: { type: "api_key", key: "zai-key" },
	"kimi-coding": { type: "api_key", key: "kimi-key" },
};

test("a provider outside the known families still joins the rotation", async () => {
	// Rotation membership required a provider to be recognised as one of five families by name,
	// and everything else was dropped by a single `continue` — silently, with no mention in
	// status. On a real machine that meant six of fourteen logged-in accounts, and roughly four
	// hundred models, sat unused while the managed accounts burned out one by one.
	const t = setup({
		accounts: MIXED_ACCOUNTS,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await t.fire("session_start");
	await finishError(
		t,
		"anthropic",
		"claude-opus-4-8",
		"You have hit your usage limit. Try again in ~600 min.",
	);

	assert.ok(
		t.rec.setModels.some((target: string) => target.startsWith("zai/") || target.startsWith("kimi-coding/")),
		`an unmanaged account must be a usable destination; switches were ${JSON.stringify(t.rec.setModels)}`,
	);
});

test("an unmanaged provider can be selected by name", async () => {
	const t = setup({
		accounts: MIXED_ACCOUNTS,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await t.fire("session_start");
	await t.command("switch zai");

	assert.ok(
		t.rec.setModels.some((target: string) => target.startsWith("zai/")),
		`switch must reach an unmanaged provider; switches were ${JSON.stringify(t.rec.setModels)}`,
	);
});

test("status names the unmanaged providers instead of hiding them", async () => {
	// The silent drop was the worst part: nothing anywhere said these accounts existed but were
	// not being used, so there was no way to notice from inside the tool.
	const t = setup({
		accounts: MIXED_ACCOUNTS,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await t.fire("session_start");
	await t.command("status");

	const said = t.rec.notifies.join("\n");
	assert.match(said, /zai/, `status must list unmanaged rotation members; said: ${said}`);
	assert.match(
		said,
		/no quota tracking|without quota|no usage/i,
		`and be honest that their quota is not tracked; said: ${said}`,
	);
});

test("unmanaged providers can be switched off", async () => {
	// Someone paying per token on a plain API key may deliberately not want background failover
	// spending it, so the new behaviour has an off switch.
	const t = setup({
		accounts: MIXED_ACCOUNTS,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { includeOtherProviders: false },
	});
	await t.fire("session_start");
	await finishError(
		t,
		"anthropic",
		"claude-opus-4-8",
		"You have hit your usage limit. Try again in ~600 min.",
	);

	// kimi-coding is a specially-managed family now, so it is NOT what this switch governs —
	// only the accounts we cannot measure are.
	assert.ok(
		!t.rec.setModels.some((target: string) => target.startsWith("zai/")),
		`opting out must keep unmanaged accounts unused; switches were ${JSON.stringify(t.rec.setModels)}`,
	);
});

test("a specially-managed family is still preferred over an unmanaged provider", async () => {
	// Managed accounts have quota telemetry, OAuth refresh and live catalogs; unmanaged ones are
	// a blind spend. They belong at the end of the ring, not ahead of an account we can measure.
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a-tok-1", refresh: "a-ref-1" },
			zai: { type: "api_key", key: "zai-key" },
			"openai-codex-account-2": {
				type: "oauth",
				access: "c-tok-2",
				refresh: "c-ref-2",
				accountId: "codex-2",
			},
		},
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await t.fire("session_start");
	await finishError(
		t,
		"anthropic",
		"claude-opus-4-8",
		"You have hit your usage limit. Try again in ~600 min.",
	);

	assert.ok(
		t.rec.setModels[0]?.startsWith("openai-codex-account-2/"),
		`a measurable account must win; went to ${t.rec.setModels[0]}`,
	);
});

test("registering the Ollama base provider must not narrow the user's own model list", async () => {
	// The base registration exists because a placeholder apiKey in models.json can stop Pi
	// exposing the provider at all. But it called registerProvider with only the one built-in tag,
	// which REPLACED a models.json that configured six — so a user running six Ollama cloud models
	// could reach exactly the one written into this extension. Ollama and Qwen are the only two
	// families whose model list still comes from an array in this file; Anthropic and Codex were
	// taught to learn from the host precisely so a new generation needs no release.
	writeFileSync(
		join(AGENT_DIR, "models.json"),
		JSON.stringify({
			providers: {
				ollama: {
					api: "openai-completions",
					models: [
						{ id: "glm-5.2:cloud" },
						{ id: "qwen3.5:cloud" },
						{ id: "deepseek-v4-flash:cloud" },
					],
				},
			},
		}),
		{ mode: 0o600 },
	);
	try {
		const t = setup({
			accounts: {
				anthropic: { type: "oauth", access: "a", refresh: "r" },
				ollama: { type: "api_key", key: "ollama-base-key" },
			},
			config: { includeOllama: true },
		});
		await t.fire("session_start");

		const models = t.ctx.modelRegistry
			.getAll()
			.filter((model: any) => model.provider === "ollama")
			.map((model: any) => model.id);
		for (const expected of ["glm-5.2:cloud", "qwen3.5:cloud", "deepseek-v4-flash:cloud"]) {
			assert.ok(
				models.includes(expected),
				`a configured model must survive registration; got ${JSON.stringify(models)}`,
			);
		}
	} finally {
		rmSync(join(AGENT_DIR, "models.json"), { force: true });
	}
});

test("a catalog sync refreshes the only-active hidden copy, so an immediate switch shows fresh models", async () => {
	// Real-world miss (2026-08-21): Ollama was hidden by only-active holding the pre-sync list;
	// the catalog sync then replaced the live registration with kimi-k3 et al, but a manual
	// switch BEFORE the next message_start re-hidden the provider from the STALE stored copy —
	// /model showed the old six. The sync now re-applies the filter in the same tick.
	writeFileSync(
		join(AGENT_DIR, "models.json"),
		JSON.stringify({
			providers: {
				ollama: {
					api: "openai-completions",
					models: [{ id: "glm-5.2:cloud" }],
				},
			},
		}),
		{ mode: 0o600 },
	);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: any) => {
		const url = String(input);
		if (url.startsWith("https://ollama.com/v1/models")) {
			return new Response(
				JSON.stringify({
					object: "list",
					data: [{ id: "kimi-k3" }, { id: "glm-5.2" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		return new Response(JSON.stringify({}), {
			status: 404,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	try {
		const t = setup({
			accounts: {
				anthropic: { type: "oauth", access: "a", refresh: "r" },
				ollama: { type: "api_key", key: "ollama-base-key" },
			},
			current: { provider: "anthropic", id: "claude-opus-4-8" },
			config: { includeOllama: true, autoDiscoverModels: true, onlyActive: true },
		});
		await t.fire("session_start");
		// ollama must be hidden now (inactive), then the user switches immediately — no message_start
		// in between. The restored list must already contain the synced kimi-k3.
		await t.command("switch ollama");
		const ids = t.ctx.modelRegistry
			.getAll()
			.filter((model: any) => model.provider === "ollama")
			.map((model: any) => model.id);
		assert.ok(
			ids.includes("kimi-k3"),
			`the synced catalog must survive the hide→switch round-trip; got ${JSON.stringify(ids)}`,
		);
		assert.ok(
			ids.includes("glm-5.2:cloud"),
			`configured ids must survive too; got ${JSON.stringify(ids)}`,
		);
		await t.fire("session_shutdown");
	} finally {
		globalThis.fetch = originalFetch;
		rmSync(join(AGENT_DIR, "models.json"), { force: true });
	}
});

test("a provider Pi has no models for is marked unconfigured instead of looking healthy", async () => {
	// Joining the rotation is not the same as being usable. An account whose models Pi does not
	// know contributes no candidate at selection time, so it can never be chosen — but it was
	// listed in `Rotation` exactly like a working one, which reads as an account in service and
	// is really dead weight. It has to be named as needing configuration.
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a", refresh: "r" },
			zai: { type: "api_key", key: "z" },
		},
		unknownProviders: ["zai"],
	});
	await t.fire("session_start");
	await t.command("status");

	const said = t.rec.notifies.join("\n");
	assert.match(
		said,
		/needs? (a )?model|unconfigured|no models/i,
		`an unusable account must say why; said: ${said}`,
	);
	assert.match(said, /zai/, "and name it");
});

// ---------------------------------------------------------------------------
// A provider that cannot serve the request at all
// ---------------------------------------------------------------------------

const OPENROUTER_402 =
	'402: {"message":"Prompt tokens limit exceeded: 38075 > 16958. To increase, visit ' +
	"https://openrouter.ai/settings/credits and upgrade to a paid account\",\"code\":402," +
	'"metadata":{"limit_source":"openrouter_credits","remedy_hint":"Add credits at ' +
	"https://openrouter.ai/settings/credits, or lower max_tokens / prompt size to fit your " +
	'remaining balance.","provider_name":null}}';

test("a 402 'out of credits' refusal is actionable, not unhandled", async () => {
	// The real-world dead end: an account whose free allowance no longer covers the request
	// refuses with 402. Nothing in the vocabulary matched it, so it classified as `unhandled` —
	// no cooldown, no failover, no message. The session sat on that provider and every single
	// user prompt produced the same 402 forever, while live accounts waited in the rotation.
	rmSync(DEBUG_LOG, { force: true });
	const t = setup({
		current: { provider: "openrouter", id: "ai21/jamba-large-1.7" },
	});
	const before = t.rec.setModels.length;
	await finishError(t, "openrouter", "ai21/jamba-large-1.7", OPENROUTER_402);

	const classified = readDebugLog()
		.filter(
			(entry) =>
				entry.kind === "assistant_error" && entry.provider === "openrouter",
		)
		.at(-1)?.classified;
	assert.equal(
		classified,
		"limit",
		"a provider stating it cannot serve the request must be understood, not shrugged at",
	);
	assert.ok(
		t.rec.setModels.length > before,
		`must move off a provider that refuses every request, got: ${t.rec.setModels.slice(before).join(", ") || "none"}`,
	);
});

test("a provider that is out of credits is benched, so failover cannot land back on it", async () => {
	// Failing over once is not enough: openrouter was also the configured fallback target, so the
	// next switch chose it again, it refused again, and the loop closed. It has to carry a
	// cooldown like any other refusing account.
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a-tok-1", refresh: "a-ref-1" },
			openrouter: { type: "api_key", key: "or-key" },
			"openai-codex-account-2": {
				type: "oauth",
				access: "c-tok-2",
				refresh: "c-ref-2",
				accountId: "codex-2",
			},
		},
		current: { provider: "openrouter", id: "ai21/jamba-large-1.7" },
	});
	await t.fire("session_start");
	await finishError(t, "openrouter", "ai21/jamba-large-1.7", OPENROUTER_402);

	const cooldown = t.readState().exhaustedUntilByProvider?.openrouter ?? 0;
	assert.ok(
		cooldown > Date.now(),
		"the refusing account must be benched so the rotation stops returning to it",
	);
	assert.ok(
		!t.rec.setModels.some((target: string) => target.startsWith("openrouter/")),
		`and must never be chosen as the failover target; switches were ${JSON.stringify(t.rec.setModels)}`,
	);
});

test("a manually chosen account survives BOTH preflights of the same message", async () => {
	// Pi runs the readiness preflight twice for one user message: once on `input`, then again in
	// `before_agent_start`. The one-attempt reprieve was consumed by the first, so the second saw
	// no reprieve and moved the user off the account they had just picked by hand — the switch
	// notice read `last-moment preflight: selected account unavailable`. The reprieve covers the
	// attempt, not the first function call that happens to ask about it.
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedCooldownsMsFromNow: { "openai-codex-account-2": 60 * 60 * 1000 },
	});
	await t.command("next");
	assert.deepEqual(t.rec.setModels, ["openai-codex-account-2/gpt-5.5"]);

	const before = t.rec.setModels.length;
	await t.input("do the thing");
	await t.fire("before_agent_start", {});

	assert.equal(
		t.rec.setModels.length,
		before,
		`the explicit choice must reach the provider; it was moved to ${t.rec.setModels.slice(before).join(", ")}`,
	);
	assert.equal(
		t.ctx.model.provider,
		"openai-codex-account-2",
		"the user must still be on the account they chose",
	);
});

test("the reprieve is still spent after that one attempt", async () => {
	// The double-preflight fix must not turn the reprieve into a permanent pin: once the attempt
	// has happened, normal routing resumes so nobody is stranded on a dead account.
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedCooldownsMsFromNow: { "openai-codex-account-2": 60 * 60 * 1000 },
	});
	await t.command("next");
	await t.input("first");
	await t.fire("before_agent_start", {});
	const before = t.rec.setModels.length;
	await t.input("second");

	assert.ok(
		t.rec.setModels.length > before,
		"the second message must go back to normal routing",
	);
});

test("'no account' is only said when there is no account — otherwise it says what is wrong", async () => {
	// The message claimed nothing was logged in whenever selection came up empty, which is a
	// different fact from the one that was true: accounts existed, had credentials, and even had
	// quota left — their authorization had expired. Being told "no authenticated account exists"
	// while `status` lists two accounts with quota is what makes the extension look broken rather
	// than the accounts, and it hides the one action that actually fixes it.
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await t.fire("session_start");
	// Both accounts lose their authorization for real, exactly as an expired refresh token does.
	await finishError(t, "anthropic", "claude-opus-4-8", "invalid_grant");
	await finishError(t, "openai-codex-account-2", "gpt-5.5", "invalid_grant");
	assert.ok(
		t.readState().invalidatedByProvider?.anthropic &&
			t.readState().invalidatedByProvider?.["openai-codex-account-2"],
		"precondition: both accounts are logged in but no longer authorized",
	);

	t.rec.notifies.length = 0;
	await t.input("continue please");

	const said = t.rec.notifies.join("\n");
	assert.doesNotMatch(
		said,
		/no usable authenticated account exists/,
		`two logged-in accounts must not be reported as none; said: ${said}`,
	);
	assert.match(
		said,
		/anthropic/,
		`the accounts that need attention must be named; said: ${said}`,
	);
	assert.match(
		said,
		/openai-codex-account-2/,
		`including the one the user never switched to; said: ${said}`,
	);
	assert.match(
		said,
		/log ?in|re-?login|authoriz/i,
		`and the message must say what to do about them; said: ${said}`,
	);
});

test("a month-long 'believed spent' notice admits it is a forecast, not a month-long lockout", async () => {
	// The notice quoted the RAW forecast — "cooling down, ~678h 28m left" — while the extension's
	// own rule is to re-ask any account at least every `maxRecheckIntervalMs`. Reading that an
	// account is locked for 28 days, when it is really re-probed within hours, is what convinced
	// a user that freed-up accounts were never being picked up again.
	const now = Date.now();
	const provider = "openai-codex-account-2";
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {},
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			usageByProvider: {
				[provider]: {
					provider,
					family: "codex",
					fetchedAt: now,
					plan: "free",
					primary: {
						usedPercent: 100,
						resetAt: now + 28 * 24 * 60 * 60 * 1000,
						windowSeconds: 2592000,
					},
				},
			},
			lastSwitches: [],
		},
	});
	await t.command("next");

	const said = t.rec.notifies.join("\n");
	assert.match(said, new RegExp(provider), "it must still name the account");
	assert.match(
		said,
		/forecast|re-?check|re-?tr(y|ied)/i,
		`and must not present a quota forecast as a settled lockout; said: ${said}`,
	);
});

test("an account the provider says is usable right now is used, whatever our bookkeeping predicted", async () => {
	// The exact shape of the real complaint: accounts had recovered — ChatGPT itself answered
	// `rate_limit.allowed: true, limit_reached: false` — and the extension kept skipping them,
	// because it had benched them earlier and was consulting only its own recorded cooldown and a
	// used-percentage that still read 98%. A cooldown is a guess about the future; the account
	// saying "yes" right now is not, and it has to win.
	const now = Date.now();
	const revived = "openai-codex-account-2";
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedState: {
			stateVersion: 5,
			// Benched by an earlier refusal, and its meter distrusted because of it.
			exhaustedUntilByProvider: { [revived]: now + 6 * 60 * 60 * 1000 },
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			usageUntrustedUntilByProvider: { [revived]: now + 6 * 60 * 60 * 1000 },
			usageByProvider: {
				[revived]: {
					provider: revived,
					family: "codex",
					fetchedAt: now,
					plan: "free",
					serviceable: true,
					primary: {
						usedPercent: 98,
						resetAt: now + 27 * 24 * 60 * 60 * 1000,
						windowSeconds: 2592000,
					},
				},
			},
			lastSwitches: [],
		},
	});
	await t.fire("session_start");
	await finishError(
		t,
		"anthropic",
		"claude-opus-4-8",
		"429 usage limit reached",
	);

	assert.ok(
		t.rec.setModels.some((target: string) => target.startsWith(`${revived}/`)),
		`the recovered account must be picked up; switches were ${JSON.stringify(t.rec.setModels)}`,
	);
});

test("an account the provider says is blocked is not tried, even while its meter shows headroom", async () => {
	// The mirror image, and the reason this must read the verdict rather than just ignore
	// cooldowns: a free-plan account can be refused outright while its monthly window still shows
	// room. Believing the percentage there is what sent turn after turn into an account that had
	// already said no.
	const now = Date.now();
	const blocked = "openai-codex-account-2";
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a-tok-1", refresh: "a-ref-1" },
			[blocked]: {
				type: "oauth",
				access: "c-tok-2",
				refresh: "c-ref-2",
				accountId: "codex-2",
			},
			"openai-codex-account-3": {
				type: "oauth",
				access: "c-tok-3",
				refresh: "c-ref-3",
				accountId: "codex-3",
			},
		},
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {},
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			usageByProvider: {
				[blocked]: {
					provider: blocked,
					family: "codex",
					fetchedAt: now,
					plan: "free",
					serviceable: false,
					primary: {
						usedPercent: 40,
						resetAt: now + 27 * 24 * 60 * 60 * 1000,
						windowSeconds: 2592000,
					},
				},
			},
			lastSwitches: [],
		},
	});
	await t.fire("session_start");
	await finishError(
		t,
		"anthropic",
		"claude-opus-4-8",
		"429 usage limit reached",
	);

	assert.ok(
		!t.rec.setModels.some((target: string) => target.startsWith(`${blocked}/`)),
		`an account that already said no must be skipped; switches were ${JSON.stringify(t.rec.setModels)}`,
	);
	assert.ok(
		t.rec.setModels.some((target: string) =>
			target.startsWith("openai-codex-account-3/"),
		),
		`and the turn must land on an account that has not; switches were ${JSON.stringify(t.rec.setModels)}`,
	);
});

test("a provider verdict of 'usable' clears the recorded bench, it does not merely bypass it", async () => {
	// Bypassing the cooldown at selection time is not enough: the record stays on disk, keeps the
	// account looking spent in `status`, and is what the pending-resume timer waits on. When the
	// account itself says it is usable again, the bench is wrong and has to go — including the
	// distrust flag that was set when it refused, since that distrust was about the METER, and
	// the account has now spoken for itself.
	const now = Date.now();
	const revived = "openai-codex-account-2";
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { showUsage: false },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: { [revived]: now + 6 * 60 * 60 * 1000 },
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			usageUntrustedUntilByProvider: { [revived]: now + 6 * 60 * 60 * 1000 },
			usageByProvider: {
				[revived]: {
					provider: revived,
					family: "codex",
					fetchedAt: now,
					plan: "free",
					serviceable: true,
					primary: {
						usedPercent: 98,
						resetAt: now + 27 * 24 * 60 * 60 * 1000,
						windowSeconds: 2592000,
					},
				},
			},
			lastSwitches: [],
		},
	});
	await t.fire("session_start");
	await t.command("status");

	const state = t.readState();
	assert.ok(
		!(state.exhaustedUntilByProvider?.[revived] > Date.now()),
		`the bench must be lifted, not just ignored; state was ${JSON.stringify(state.exhaustedUntilByProvider)}`,
	);
	assert.ok(
		!(state.usageUntrustedUntilByProvider?.[revived] > Date.now()),
		`and the meter regains trust once the account itself confirms it; state was ${JSON.stringify(state.usageUntrustedUntilByProvider)}`,
	);
});

// ---------------------------------------------------------------------------
// A newly managed family must not fall out of an existing config
// ---------------------------------------------------------------------------

test("a managed family missing from a saved providerOrder still joins the rotation", async () => {
	// `/multi-account` writes the whole config to disk, `providerOrder` included, so every
	// installed config pins the family list as it stood that day. When a provider is promoted to a
	// managed family in a later release, an existing config lists neither it (the order predates
	// it) nor lets it in as an "other" provider (it is managed now) — so an account that worked
	// yesterday silently vanishes from the ring, and `rediscover` cannot bring it back because
	// nothing is broken from discovery's point of view. Exactly what happened to kimi-coding.
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a-tok-1", refresh: "a-ref-1" },
			"kimi-coding": { type: "api_key", key: "kimi-key" },
		},
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: {
			// A config written before kimi-coding became a managed family.
			providerOrder: ["anthropic", "openai-codex", "cursor", "qwen", "ollama"],
		},
	});
	await t.fire("session_start");
	await t.command("status");

	const said = t.rec.notifies.join("\n");
	const rotation = /Rotation \(\d+\): ([^\n]*)/.exec(said)?.[1] ?? "";
	assert.match(
		rotation,
		/kimi-coding/,
		`a managed account must never be dropped by an older saved order; rotation was: ${rotation}`,
	);
	assert.match(
		rotation,
		/anthropic/,
		"and the user's own ordering is still respected",
	);
});

test("an account of a family missing from providerOrder is reachable by failover", async () => {
	// Being listed is not enough — it has to actually be selectable, which is the difference
	// between a cosmetic fix and the account carrying work when everything else is spent.
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a-tok-1", refresh: "a-ref-1" },
			"kimi-coding": { type: "api_key", key: "kimi-key" },
		},
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: {
			providerOrder: ["anthropic", "openai-codex", "cursor", "qwen", "ollama"],
		},
	});
	await t.fire("session_start");
	await finishError(
		t,
		"anthropic",
		"claude-opus-4-8",
		"429 usage limit reached",
	);

	assert.ok(
		t.rec.setModels.some((target: string) => target.startsWith("kimi-coding/")),
		`the work must reach it; switches were ${JSON.stringify(t.rec.setModels)}`,
	);
});

test("the footer says how many other accounts are ready, so 'switch to what?' has an answer", async () => {
	// The footer described the current account and stopped there. The question a person actually
	// has when an account runs dry — is there anywhere to go, and how many — had no answer
	// anywhere short of running `status` and reading fifteen lines.
	const now = Date.now();
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a-tok-1", refresh: "a-ref-1" },
			"openai-codex-account-2": {
				type: "oauth",
				access: "c-tok-2",
				refresh: "c-ref-2",
				accountId: "codex-2",
			},
			"openai-codex-account-3": {
				type: "oauth",
				access: "c-tok-3",
				refresh: "c-ref-3",
				accountId: "codex-3",
			},
		},
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		config: { showUsage: true },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {},
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			usageByProvider: {
				"openai-codex-account-2": {
					provider: "openai-codex-account-2",
					family: "codex",
					fetchedAt: now,
					plan: "free",
					account: "someone@example.com",
					primary: { usedPercent: 40, resetAt: now + 3_600_000 },
				},
			},
			lastSwitches: [],
		},
	});
	await t.fire("session_start");

	const footer = t.rec.statuses.at(-1)?.value ?? "";
	assert.match(footer, /someone/, `the footer must name the account in use; got: ${footer}`);
	assert.match(
		footer,
		/\+\d+ ready|\d+ ready|no spare/i,
		`and say whether anywhere else can take over; got: ${footer}`,
	);
});

// ---------------------------------------------------------------------------
// OAuth refresh: losing a race must not be reported as a dead account
// ---------------------------------------------------------------------------

const { refreshWithDiskRetry } = (await import("../index.ts")) as {
	refreshWithDiskRetry: (opts: {
		credentials: any;
		refresh: (credentials: any) => Promise<any>;
		storedRefresh: () => string | undefined;
	}) => Promise<any>;
};

test("an invalid_grant is retried with the token another process just wrote", async () => {
	// Anthropic rotates the refresh token on every use and invalidates the old one immediately.
	// Any second holder of that credential — another Pi window, a usage probe that raced the
	// request — therefore presents a token that was valid when it was read and is dead by the time
	// it is sent. That is a lost race, not a dead account, and the fresh token is already sitting
	// on disk. Retrying with it is the difference between a working account and one that gets
	// dropped and demands a re-login it does not need.
	const attempts: string[] = [];
	const result = await refreshWithDiskRetry({
		credentials: { type: "oauth", access: "old-access", refresh: "stale-refresh" },
		refresh: async (credentials: any) => {
			attempts.push(credentials.refresh);
			if (credentials.refresh === "stale-refresh")
				throw new Error(
					'HTTP request failed. status=400; body={"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}',
				);
			return { access: "new-access", refresh: "newer-refresh", expires: 123 };
		},
		storedRefresh: () => "fresh-refresh-from-disk",
	});

	assert.deepEqual(
		attempts,
		["stale-refresh", "fresh-refresh-from-disk"],
		"the retry must use what is on disk now, not the credential it was handed",
	);
	assert.equal(result.access, "new-access", "and the refreshed token is what comes back");
});

test("a genuinely revoked token is not retried in a loop", async () => {
	// When disk holds the same token that just failed, nothing has changed and there is nothing to
	// retry — the account really is revoked and must fail fast so the rotation moves on.
	let calls = 0;
	await assert.rejects(
		refreshWithDiskRetry({
			credentials: { type: "oauth", access: "a", refresh: "same-refresh" },
			refresh: async () => {
				calls++;
				throw new Error('status=400; body={"error": "invalid_grant"}');
			},
			storedRefresh: () => "same-refresh",
		}),
		/invalid_grant/,
	);
	assert.equal(calls, 1, "one attempt, because a second would send the identical token");
});

test("a network failure is not mistaken for a revoked token", async () => {
	// Only invalid_grant means "this token is dead". A timeout must surface as itself, or a blip
	// would drop a perfectly good account out of the rotation.
	let calls = 0;
	await assert.rejects(
		refreshWithDiskRetry({
			credentials: { type: "oauth", access: "a", refresh: "r" },
			refresh: async () => {
				calls++;
				throw new Error("fetch failed: ETIMEDOUT");
			},
			storedRefresh: () => "different-token-on-disk",
		}),
		/ETIMEDOUT/,
	);
	assert.equal(calls, 1, "a transient error is not a reason to burn the disk token");
});

test("a revoked Claude login explains what revoked it, not just 'run /login'", async () => {
	// Re-logging in and being kicked out again hours later, repeatedly, with the tool saying only
	// "authorization is invalid, run /login", gives a person no way to break the cycle. Claude
	// Pro/Max logins from every CLI share ONE client id, and Anthropic keeps one live refresh
	// token per account for it — so signing the same account into a second tool, a second machine,
	// or a second slot here silently kills the first. That is the fact that ends the loop.
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await t.fire("session_start");
	await finishError(
		t,
		"anthropic",
		"claude-opus-4-8",
		'OAuth refresh failed: status=400; body={"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}',
	);

	const said = t.rec.notifies.join("\n");
	assert.match(said, /anthropic/, "it must name the slot");
	assert.match(
		said,
		/same account|another (tool|app|client)|signed in|elsewhere/i,
		`and name the cause, so re-logging in is not the only idea on offer; said: ${said}`,
	);
});

test("'best' switches straight to an account that can work right now", async () => {
	// `next` walks the ring one step at a time and `switch` needs a name typed exactly, so with
	// fourteen accounts — most of them spent — reaching a working one meant pressing next until
	// something answered. There was no way to say "just put me somewhere that works".
	const now = Date.now();
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a-tok-1", refresh: "a-ref-1" },
			"openai-codex-account-2": {
				type: "oauth",
				access: "c-tok-2",
				refresh: "c-ref-2",
				accountId: "codex-2",
			},
			"kimi-coding": { type: "api_key", key: "kimi-key" },
		},
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {
				anthropic: now + 6 * 60 * 60 * 1000,
				"openai-codex-account-2": now + 6 * 60 * 60 * 1000,
			},
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			usageByProvider: {
				"openai-codex-account-2": {
					provider: "openai-codex-account-2",
					family: "codex",
					fetchedAt: now,
					plan: "free",
					serviceable: false,
					primary: { usedPercent: 100, resetAt: now + 27 * 86_400_000 },
				},
			},
			lastSwitches: [],
		},
	});
	await t.fire("session_start");
	// Pin the starting point so the assertion can only be satisfied by `best` itself.
	t.setCurrent("anthropic", "claude-opus-4-8");
	t.rec.setModels.length = 0;
	await t.command("best");

	assert.equal(
		t.rec.setModels.length,
		1,
		`one decisive switch, not a walk through the ring; switches: ${JSON.stringify(t.rec.setModels)}`,
	);
	assert.ok(
		t.rec.setModels[0].startsWith("kimi-coding/"),
		`it must land on the one account that can serve work; switches: ${JSON.stringify(t.rec.setModels)}`,
	);
	assert.equal(t.ctx.model.provider, "kimi-coding");
});

test("'best' says so plainly when nothing can work", async () => {
	// Silence here would read as "it ignored me". If every account is spent, that is the answer.
	const now = Date.now();
	const t = setup({
		accounts: { anthropic: { type: "oauth", access: "a", refresh: "r" } },
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: { anthropic: now + 6 * 60 * 60 * 1000 },
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			lastSwitches: [],
		},
	});
	await t.fire("session_start");
	t.rec.notifies.length = 0;
	await t.command("best");

	const said = t.rec.notifies.join("\n");
	assert.match(
		said,
		/pi-multi-account:.*(no account|nothing|none)/i,
		`it must answer rather than do nothing silently; said: ${said}`,
	);
	assert.doesNotMatch(
		said,
		/unknown command|usage:/i,
		`and the command must exist; said: ${said}`,
	);
});

test("an account we cannot cheaply re-probe is not re-tried every ten minutes", async () => {
	// The recheck ceiling exists because a quota forecast is a guess and asking again is nearly
	// free — for accounts with a usage endpoint, where "asking" is a background probe that costs
	// the user nothing. Kimi publishes no such endpoint (every path 404s), so the only way to ask
	// is to spend a real turn: the user sends a message, it lands on the spent account, refuses,
	// and gets bounced. Doing that every ten minutes to an account that just said its quota
	// returns "in the next billing cycle" is exactly the thrashing this ceiling was meant to stop.
	const t = setup({
		accounts: {
			"kimi-coding": { type: "api_key", key: "kimi-key" },
			"openai-codex-account-2": {
				type: "oauth",
				access: "c-tok-2",
				refresh: "c-ref-2",
				accountId: "codex-2",
			},
		},
		current: { provider: "kimi-coding", id: "k3" },
		config: { maxRecheckIntervalMs: 600_000, cooldownMs: 21_600_000 },
	});
	await t.fire("session_start");
	await finishError(
		t,
		"kimi-coding",
		"k3",
		'403 {"error":{"message":"You\'ve reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle.","type":"access_terminated_error"}}',
	);

	const until = t.readState().exhaustedUntilByProvider?.["kimi-coding"] ?? 0;
	const minutes = Math.round((until - Date.now()) / 60_000);
	assert.ok(
		minutes > 30,
		`an account that can only be re-probed by spending a user turn must rest longer than the ceiling; got ${minutes}m`,
	);
});

test("an account with a usage endpoint still honours the recheck ceiling", async () => {
	// The ceiling must stay exactly as it was wherever asking is genuinely cheap — that is the
	// behaviour that stops a month-long forecast from parking a Codex account for weeks.
	const t = setup({
		accounts: {
			"openai-codex-account-2": {
				type: "oauth",
				access: "c-tok-2",
				refresh: "c-ref-2",
				accountId: "codex-2",
			},
			"openai-codex-account-3": {
				type: "oauth",
				access: "c-tok-3",
				refresh: "c-ref-3",
				accountId: "codex-3",
			},
		},
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		config: { maxRecheckIntervalMs: 600_000, cooldownMs: 21_600_000 },
	});
	await t.fire("session_start");
	await finishError(
		t,
		"openai-codex-account-2",
		"gpt-5.5",
		"You have hit your ChatGPT usage limit. Try again in ~40000 min.",
	);

	const until = t.readState().exhaustedUntilByProvider?.["openai-codex-account-2"] ?? 0;
	const minutes = Math.round((until - Date.now()) / 60_000);
	assert.ok(
		minutes <= 11,
		`a cheaply re-probed account must still come back at the ceiling; got ${minutes}m`,
	);
});

test("switch accepts the name people actually type", async () => {
	// `switch kimi` answered `unknown provider "kimi"`, because the slot is called kimi-coding —
	// so the one command that reaches a chosen account directly required knowing the exact id,
	// and `next` was the only fallback. A short, unambiguous name is what a person types.
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a", refresh: "r" },
			"kimi-coding": { type: "api_key", key: "kimi-key" },
		},
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await t.fire("session_start");
	t.rec.setModels.length = 0;
	await t.command("switch kimi");

	assert.ok(
		t.rec.setModels.some((target: string) => target.startsWith("kimi-coding/")),
		`a short name must resolve; switches: ${JSON.stringify(t.rec.setModels)}, said: ${t.rec.notifies.join(" | ")}`,
	);
});

test("an ambiguous short name is refused with the options, not guessed", async () => {
	// Guessing between two Codex slots would silently spend the wrong account's quota.
	const t = setup({
		accounts: {
			"openai-codex-account-2": {
				type: "oauth",
				access: "c2",
				refresh: "r2",
				accountId: "codex-2",
			},
			"openai-codex-account-3": {
				type: "oauth",
				access: "c3",
				refresh: "r3",
				accountId: "codex-3",
			},
		},
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
	});
	await t.fire("session_start");
	t.rec.notifies.length = 0;
	await t.command("switch codex");

	const said = t.rec.notifies.join("\n");
	assert.match(said, /openai-codex-account-2/, `it must list the candidates; said: ${said}`);
	assert.match(said, /openai-codex-account-3/, `both of them; said: ${said}`);
});

test("an exact id still wins over any prefix match", async () => {
	// `ollama` must never resolve to `ollama-account-2` just because both start the same way.
	const t = setup({
		accounts: {
			ollama: { type: "api_key", key: "k1" },
			"ollama-account-2": { type: "api_key", key: "k2" },
			anthropic: { type: "oauth", access: "a", refresh: "r" },
		},
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await t.fire("session_start");
	t.rec.setModels.length = 0;
	await t.command("switch ollama");

	assert.ok(
		t.rec.setModels.some((target: string) => target.startsWith("ollama/")),
		`the exact id must win; switches: ${JSON.stringify(t.rec.setModels)}`,
	);
});

test("a confirmed-available account outranks one whose state is merely unknown", async () => {
	// `best` promised "an account that can work right now" and landed on Kimi, which was out of
	// quota. Ranking treated "the provider told us allowed:true" and "we have no idea" as the same
	// thing, so an unmeasurable account sitting earlier in the ring beat a measured, confirmed one.
	// Confirmation is evidence; absence of a cooldown is not.
	const now = Date.now();
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a", refresh: "r" },
			"kimi-coding": { type: "api_key", key: "kimi-key" },
			"openai-codex-account-7": {
				type: "oauth",
				access: "c7",
				refresh: "r7",
				accountId: "codex-7",
			},
		},
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		// Kimi sits EARLIER in the ring than the codex slot, so only ranking can save this.
		config: { providerOrder: ["anthropic", "kimi-coding", "openai-codex"] },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {},
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			usageByProvider: {
				"openai-codex-account-7": {
					provider: "openai-codex-account-7",
					family: "codex",
					fetchedAt: now,
					plan: "free",
					serviceable: true,
					primary: { usedPercent: 90, resetAt: now + 86_400_000 },
				},
			},
			lastSwitches: [],
		},
	});
	await t.fire("session_start");
	t.setCurrent("anthropic", "claude-opus-4-8");
	t.rec.setModels.length = 0;
	await t.command("best");

	assert.ok(
		t.rec.setModels.some((m: string) => m.startsWith("openai-codex-account-7/")),
		`the confirmed account must win; switches: ${JSON.stringify(t.rec.setModels)}`,
	);
});

test("when nothing is confirmed, best says the choice is a guess", async () => {
	// With every measurable account spent, the only candidates left are ones we cannot check.
	// Switching there silently reads as "it threw me somewhere random again" — which is exactly
	// how it looked. Saying it is an unverified guess makes the same action honest.
	const now = Date.now();
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a", refresh: "r" },
			"kimi-coding": { type: "api_key", key: "kimi-key" },
		},
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: { anthropic: now + 3_600_000 },
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			lastSwitches: [],
		},
	});
	await t.fire("session_start");
	t.setCurrent("anthropic", "claude-opus-4-8");
	t.rec.notifies.length = 0;
	await t.command("best");

	const said = t.rec.notifies.join("\n");
	assert.match(
		said,
		/not confirmed|cannot be checked|unverified|no quota/i,
		`it must not present a guess as a verified choice; said: ${said}`,
	);
});

// ---------------------------------------------------------------------------
// Forced OAuth refresh: a rotated token must never be thrown away (issue #22)
// ---------------------------------------------------------------------------
//
// Anthropic (and Cursor) rotate the refresh token on every refresh call and revoke the old
// one immediately. So a forced refresh we cannot PERSIST does not merely fail — it destroys
// the account's credential and discards the replacement. On pi 0.84.x that is exactly what
// happened: `AuthStorage` no longer exposes the `set()` this extension persisted with, the
// post-refresh guard tripped every single time, and the user lost their Claude login roughly
// once a day, needing a manual `/login`.

test("a refreshed credential is persisted through pi 0.84's AuthStorage, which has no set()", async () => {
	installCursorProvider();
	const t = setup({
		accounts: {
			cursor: { type: "oauth", access: "stale", refresh: "live-refresh" },
			anthropic: { type: "oauth", access: "a-tok-1", refresh: "a-ref-1" },
		},
		config: { includeCursor: true },
		current: { provider: "cursor", id: "cursor-grok-4.6" },
		hostAuthStorage: "pi-0.84",
	});
	await t.fire("session_start");
	await finishError(
		t,
		"cursor",
		"cursor-grok-4.6",
		"Your authentication token has been invalidated. Please try signing in again.",
	);

	const childFacing = JSON.parse(readFileSync(AUTH, "utf8")).cursor;
	assert.equal(childFacing.type, "api_key");
	assert.equal(childFacing.key, "cursor-proxy");
	const sidecar = JSON.parse(
		readFileSync(join(AGENT_DIR, "pi-multi-account-proxy-oauth.json"), "utf8"),
	).cursor;
	assert.equal(
		sidecar.refresh,
		"rotated-refresh:live-refresh",
		"the rotated refresh token must reach the parent sidecar — the old one is already dead server-side",
	);
	assert.equal(sidecar.access, "rotated-access:live-refresh");
	assert.ok(
		!t.readState().invalidatedByProvider?.cursor,
		"a successful refresh is not a dead account",
	);
	assert.deepEqual(
		t.rec.setModels,
		[],
		"and a successful refresh stays on the same account",
	);
	uninstallCursorProvider();
});

test("with nowhere to persist, the token is never rotated in the first place", async () => {
	// The order matters more than the outcome: checking persistence AFTER the network call
	// is what burned the credential. A host that cannot store the result must never get as
	// far as asking the provider to rotate it.
	assert.equal(
		canPersistRefreshedCredentials({ read: async () => undefined }, () => false),
		false,
		"read-only storage plus an unwritable auth.json means no refresh may be attempted",
	);
	assert.equal(
		canPersistRefreshedCredentials({ modify: async () => {} }, () => false),
		true,
		"pi 0.84's modify() is a persistence path",
	);
	assert.equal(
		canPersistRefreshedCredentials({ set: () => {} }, () => false),
		true,
		"and so is the older set()",
	);
	assert.equal(
		canPersistRefreshedCredentials(undefined, () => true),
		true,
		"no AuthStorage at all still leaves our own writable auth.json",
	);
});

test("persistence falls through modify -> set -> auth.json instead of dropping the token", async () => {
	const credential = { type: "oauth", access: "new", refresh: "new-refresh" };

	const modified: any[] = [];
	assert.equal(
		await persistRefreshedCredentials(
			{
				modify: async (provider: string, fn: (current: any) => any) => {
					modified.push({ provider, next: await fn(undefined) });
				},
				set: () => assert.fail("modify succeeded; set must not be called"),
			},
			"anthropic",
			credential,
		),
		true,
	);
	assert.deepEqual(modified, [{ provider: "anthropic", next: credential }]);

	// A host whose modify() throws (locked file, read-only storage) must still land the token.
	const setCalls: any[] = [];
	assert.equal(
		await persistRefreshedCredentials(
			{
				modify: async () => {
					throw new Error("Read-only credential storage cannot modify auth.json");
				},
				set: (provider: string, value: any) => setCalls.push({ provider, value }),
			},
			"anthropic",
			credential,
		),
		true,
	);
	assert.deepEqual(setCalls, [{ provider: "anthropic", value: credential }]);

	// Neither method exists: write auth.json ourselves rather than lose a rotated token.
	let written: any;
	assert.equal(
		await persistRefreshedCredentials({ reload: () => {} }, "anthropic", credential, {
			read: () => ({ "openai-codex": { type: "oauth", access: "keep" } }),
			write: (data) => {
				written = data;
			},
		}),
		true,
	);
	assert.deepEqual(written, {
		"openai-codex": { type: "oauth", access: "keep" },
		anthropic: credential,
	});

	// And when nothing can store it, say so — never report a refresh that did not stick.
	assert.equal(
		await persistRefreshedCredentials({}, "anthropic", credential, {
			read: () => ({}),
			write: () => {
				throw new Error("EROFS");
			},
		}),
		false,
	);
});

test("a forced Cursor refresh loads the vendored provider, not the retired clone path", async () => {
	// Cursor's refresh used to be imported from
	// ~/.pi/agent/git/github.com/ndraiman/pi-cursor-provider/auth.ts — a path that stopped
	// existing when the provider was vendored into this extension (issue #20), so every
	// forced Cursor refresh threw before it could refresh anything.
	installCursorProvider();
	const t = setup({
		accounts: {
			cursor: { type: "oauth", access: "stale", refresh: "cursor-refresh-token" },
			anthropic: { type: "oauth", access: "a-tok-1", refresh: "a-ref-1" },
		},
		config: { includeCursor: true },
		current: { provider: "cursor", id: "cursor-grok-4.6" },
		hostAuthStorage: "pi-0.84",
	});
	await t.fire("session_start");
	await finishError(
		t,
		"cursor",
		"cursor-grok-4.6",
		"Your authentication token has been invalidated. Please try signing in again.",
	);
	assert.deepEqual(
		cursorRefreshCalls(),
		["cursor-refresh-token"],
		"the refresh must actually reach the vendored provider's auth module",
	);
	uninstallCursorProvider();
});

// ---------------------------------------------------------------------------
// The registry is Pi's, not ours: narrowing /model must not delete models
// ---------------------------------------------------------------------------
//
// Pi's model registry is the single place ANYTHING — Pi itself, a `--models` pattern,
// another extension pinning a model by reference — asks "does this model exist?".
// Re-registering a provider with `models: []` answers "no" to every one of them, so
// emptying a provider Pi knows on its own does not hide a model, it deletes it. The
// caller then falls back to whatever the session is running on, which under rotation is
// a different account every few turns: invisible from here, undebuggable from there.

test("only-active never makes a model Pi knows on its own unresolvable", async () => {
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
			"openai-codex-account-2": {
				type: "oauth",
				access: "c2",
				refresh: "cr2",
				accountId: "codex-2",
			},
			// A provider Pi knows from models.json / its own built-ins. This extension
			// never registered it and must never unregister it.
			zai: { type: "api_key", key: "sk-zai" },
		},
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await t.fire("session_start");
	await t.command("only-active on");

	// Exactly how an outside caller resolves a pinned model.
	const resolvable = (provider: string) =>
		t.ctx.modelRegistry
			.getAll()
			.some((model: { provider: string }) => model.provider === provider);

	assert.ok(
		resolvable("zai"),
		"a pinned zai/* model must still resolve while /model is narrowed",
	);
	assert.ok(
		resolvable("anthropic"),
		"and so must Pi's own anthropic provider, even though it is not the active one",
	);
	assert.ok(
		!resolvable("openai-codex-account-2"),
		"this extension's own spare slot is what only-active narrows",
	);
});

test("only-active empties this extension's own slots and nothing else, ever", async () => {
	// The blast radius, stated as a rule rather than per provider: a name with an
	// `-account-N` suffix exists only because this extension registered it, so narrowing
	// it takes nothing away from Pi. Every other name in the registry came from
	// somewhere else and is not ours to unregister.
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
			"openai-codex-account-2": {
				type: "oauth",
				access: "c2",
				refresh: "cr2",
				accountId: "codex-2",
			},
			zai: { type: "api_key", key: "sk-zai" },
			openrouter: { type: "api_key", key: "sk-or" },
			ollama: { type: "api_key", key: "sk-ollama" },
		},
		current: { provider: "anthropic", id: "claude-opus-4-8" },
	});
	await t.fire("session_start");
	await t.command("only-active on");
	const emptied = [
		...new Set(
			[...t.rec.registrations]
				.filter((r) => r.models === 0)
				.map((r) => r.provider),
		),
	];
	assert.deepEqual(
		emptied.filter((provider) => !/-account-\d+$/.test(provider)),
		[],
		`only-active emptied a provider it did not invent: ${emptied.join(", ")}`,
	);
});

test("a slot published into models.json is usable by a bare child, not just resolvable", async () => {
	// Publishing a provider Pi cannot authenticate is worse than not publishing it: the
	// model resolves and every call then dies at `credentials_not_configured`. Cursor's
	// real credential is an OAuth token this extension holds and a child cannot read, so
	// the published entry carries the proxy's own placeholder — the proxy recognises it
	// and supplies the real token itself.
	installCursorProvider();
	const t = setup({
		accounts: { cursor: { type: "oauth", access: "c", refresh: "cr" } },
		config: { includeCursor: true },
	});
	await t.fire("session_start");
	await wait(20);
	const slot = JSON.parse(readFileSync(MODELS, "utf8")).providers?.cursor;
	assert.ok(slot, "the cursor slot must be provisioned into models.json");
	assert.equal(
		slot.apiKey,
		"cursor-proxy",
		"without a key Pi refuses the provider it can otherwise resolve",
	);
	assert.match(slot.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
	uninstallCursorProvider();
});

test("the published placeholder is the one the vendored proxy actually accepts", async () => {
	// The placeholder only works because cursor/cursor-shared.ts treats this exact string
	// as "no token on this request". If the vendored provider ever stops doing that,
	// publishing it would send a bogus bearer instead of falling back to the real token.
	const shared = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "..", "cursor", "cursor-shared.ts"),
		"utf8",
	);
	assert.match(
		shared,
		/token === "cursor-proxy"/,
		"the vendored proxy must still recognise the placeholder we publish",
	);
});

// ---------------------------------------------------------------------------
// Mid-run context guard — wiring
//
// context-guard.test.ts proves the accounting and the elision. These prove the extension
// actually reaches them: the guard has to fire from inside the `context` hook (the only hook Pi
// runs before EVERY LLM call, including the hundreds inside one autonomous run) and it has to ask
// for a real summary only once the agent has settled.
// ---------------------------------------------------------------------------

/** A conversation shaped like the real 78-minute run: mostly large tool results. */
function bigConversation(turns: number) {
	const messages: any[] = [
		{ role: "user", content: [{ type: "text", text: "продовжуй" }], timestamp: 1 },
	];
	for (let i = 0; i < turns; i++) {
		messages.push({
			role: "assistant",
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			stopReason: "toolUse",
			timestamp: 1000 + i,
			content: [{ type: "toolCall", id: `call-${i}`, name: "read", arguments: { path: `f${i}.ts` } }],
		});
		messages.push({
			role: "toolResult",
			toolCallId: `call-${i}`,
			toolName: "read",
			isError: false,
			timestamp: 2000 + i,
			content: [{ type: "text", text: "x".repeat(20_000) }], // 5 000 tokens each
		});
	}
	return messages;
}

test("the context guard trims a mid-run request instead of letting it overflow", async () => {
	const t = setup({ current: { provider: "openai-codex", id: "gpt-5.6-sol" } });
	t.ctx.model.contextWindow = 272_000;
	t.ctx.getSystemPrompt = () => "s".repeat(24_000);

	// ~250 000 tokens of tool results: past the soft line, and the point at which Pi itself would
	// still be doing nothing at all because the run has not ended.
	const messages = bigConversation(50);
	const result = await t.fire("context", { messages });

	assert.ok(result?.messages, "the guard must rewrite the outgoing request");
	assert.equal(result.messages.length, messages.length, "no message may be dropped");
	const stubbed = result.messages.filter(
		(m: any) =>
			m.role === "toolResult" && String(m.content?.[0]?.text ?? "").includes("context-guard"),
	);
	assert.ok(stubbed.length > 0, "old tool output must be left out of the request");
	// The tail the agent is actively working in stays verbatim.
	const last = result.messages[result.messages.length - 1];
	assert.equal(String(last.content[0].text).includes("context-guard"), false);
	// And the transcript Pi holds is untouched — we only shape what goes over the wire.
	assert.equal(messages[2].content[0].text.length, 20_000);
});

test("the context guard asks for a real summary only once the agent has settled", async () => {
	const t = setup({ current: { provider: "openai-codex", id: "gpt-5.6-sol" } });
	t.ctx.model.contextWindow = 272_000;
	t.ctx.getSystemPrompt = () => "";

	await t.fire("context", { messages: bigConversation(50) });
	// Mid-run: nothing may call compact(), because the real one starts with an abort() and would
	// throw away the work the agent is in the middle of.
	t.setIdle(false);
	await t.fire("agent_settled", {});
	assert.equal(t.rec.compacts.length, 0, "compaction must never be triggered mid-run");

	t.setIdle(true);
	await t.fire("agent_settled", {});
	assert.equal(t.rec.compacts.length, 1, "a settled boundary is where the summary belongs");

	// A compaction rebuilds the message list, so every elision key now points at history that is
	// no longer in the request. If the guard kept them, the next small request would come back
	// stubbed for no reason — and the prompt cache would be thrown away with it.
	await t.fire("session_compact", {});
	// 20 turns: comfortably under the soft line, but long enough that part of it sits outside the
	// protected tail — so a stale elision key would visibly stub it.
	const afterCompaction = await t.fire("context", { messages: bigConversation(20) });
	assert.equal(afterCompaction, undefined, "stale elisions must not survive a summary");
	t.setIdle(true);
	await t.fire("agent_settled", {});
	assert.equal(t.rec.compacts.length, 1, "and it must not immediately ask again");
});

test("a context-guard compaction continues only after its completion callback", async () => {
	const t = setup({
		current: { provider: "openai-codex", id: "gpt-5.6-sol" },
		compactSilent: true,
	});
	t.ctx.model.contextWindow = 272_000;
	t.ctx.getSystemPrompt = () => "";

	await t.fire("context", { messages: bigConversation(50) });
	t.setIdle(true);
	await t.fire("agent_settled", {});
	assert.equal(t.rec.compacts.length, 1);
	assert.equal(
		t.rec.sent.length,
		0,
		"a guard compaction must not start a new turn while the summary is still in flight",
	);

	const onComplete = t.rec.compacts[0].onComplete as
		| ((result: unknown) => void)
		| undefined;
	onComplete?.({ summary: "test summary" });
	assert.equal(t.rec.sent.length, 1, "the completion callback must wake the unfinished task");
	assert.equal(t.rec.sent[0].options?.deliverAs, "followUp");
	assert.match(t.rec.sent[0].prompt, /compacted automatically/i);
});

test("continueAfterCompaction also opts out of context-guard wake", async () => {
	const t = setup({
		current: { provider: "openai-codex", id: "gpt-5.6-sol" },
		compactSilent: true,
		config: { continueAfterCompaction: false },
	});
	t.ctx.model.contextWindow = 272_000;
	t.ctx.getSystemPrompt = () => "";

	await t.fire("context", { messages: bigConversation(50) });
	t.setIdle(true);
	await t.fire("agent_settled", {});
	const onComplete = t.rec.compacts[0].onComplete as
		| ((result: unknown) => void)
		| undefined;
	onComplete?.({ summary: "test summary" });
	assert.equal(t.rec.sent.length, 0, "explicit opt-out must not start a new turn");
});

test("the context guard stands down when the model's window is unknown", async () => {
	const t = setup({ current: { provider: "openai-codex", id: "gpt-5.6-sol" } });
	// mkModel deliberately has no contextWindow: with no window there is no basis for a decision.
	const messages = bigConversation(50);
	const result = await t.fire("context", { messages });
	assert.equal(result, undefined, "no window ⇒ no opinion, never a guess");
	t.setIdle(true);
	await t.fire("agent_settled", {});
	assert.equal(t.rec.compacts.length, 0);
});

test("the context guard leaves an ordinary conversation completely alone", async () => {
	const t = setup({ current: { provider: "openai-codex", id: "gpt-5.6-sol" } });
	t.ctx.model.contextWindow = 272_000;
	t.ctx.getSystemPrompt = () => "s".repeat(24_000);
	const result = await t.fire("context", { messages: bigConversation(2) });
	assert.equal(result, undefined);
	t.setIdle(true);
	await t.fire("agent_settled", {});
	assert.equal(t.rec.compacts.length, 0);
});

// The guard lives entirely in this extension, so a Pi update cannot delete it — but it CAN stop
// calling it. Every handler here is crash-isolated, so a removed hook does not fail loudly: the
// guard just never runs again. These lock the detection of that silent death.

test("the context guard reports itself when the host stops calling the pre-request hook", async () => {
	const t = setup({ current: { provider: "openai-codex", id: "gpt-5.6-sol" } });
	t.ctx.model.contextWindow = 272_000;
	const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110 };
	// Six LLM responses and not one `context` event: the hook the guard hangs off is gone.
	for (let i = 0; i < 6; i++) {
		await t.fire("message_end", {
			message: {
				role: "assistant",
				provider: "openai-codex",
				model: "gpt-5.6-sol",
				stopReason: "stop",
				timestamp: 5000 + i,
				content: [{ type: "text", text: "ok" }],
				usage,
			},
		});
	}
	const warning = t.rec.notifies.find((n: string) => n.includes("context guard is NOT running"));
	assert.ok(warning, `expected a warning, got: ${JSON.stringify(t.rec.notifies)}`);
	// Said once, not on every turn.
	assert.equal(
		t.rec.notifies.filter((n: string) => n.includes("context guard is NOT running")).length,
		1,
	);
});

test("the context guard says so when it has no window to measure against", async () => {
	const t = setup({ current: { provider: "openai-codex", id: "gpt-5.6-sol" } });
	// mkModel has no contextWindow — the guard stands down, and silently standing down is exactly
	// the state a user must be told about rather than left to discover from an overflow.
	const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110 };
	for (let i = 0; i < 6; i++) {
		await t.fire("context", { messages: bigConversation(1) });
		await t.fire("message_end", {
			message: {
				role: "assistant",
				provider: "openai-codex",
				model: "gpt-5.6-sol",
				stopReason: "stop",
				timestamp: 6000 + i,
				content: [{ type: "text", text: "ok" }],
				usage,
			},
		});
	}
	assert.ok(
		t.rec.notifies.some((n: string) => n.includes("standing down")),
		`expected a stand-down warning, got: ${JSON.stringify(t.rec.notifies)}`,
	);
	assert.equal(
		t.rec.notifies.some((n: string) => n.includes("context guard is NOT running")),
		false,
		"the hook is alive here — only the window is missing",
	);
});

test("a healthy guarded session says nothing at all", async () => {
	const t = setup({ current: { provider: "openai-codex", id: "gpt-5.6-sol" } });
	t.ctx.model.contextWindow = 272_000;
	t.ctx.getSystemPrompt = () => "";
	const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110 };
	for (let i = 0; i < 6; i++) {
		await t.fire("context", { messages: bigConversation(1) });
		await t.fire("message_end", {
			message: {
				role: "assistant",
				provider: "openai-codex",
				model: "gpt-5.6-sol",
				stopReason: "stop",
				timestamp: 7000 + i,
				content: [{ type: "text", text: "ok" }],
				usage,
			},
		});
	}
	assert.equal(
		t.rec.notifies.some((n: string) => n.includes("context guard")),
		false,
		`a working guard must be silent; got: ${JSON.stringify(t.rec.notifies)}`,
	);
});

// ---------------------------------------------------------------------------
// Carrying the task on after an automatic compaction
//
// Pi ends the run whenever a threshold compaction fires. The continuation route is Pi's own:
// `_runAutoCompaction` returns `this.agent.hasQueuedMessages()`, and `_runAgentPrompt` turns a
// `true` there into `agent.continue()`, which drains the follow-up queue. Pi uses that for
// overflow recovery but queues nothing on the threshold path. These lock the one queued
// follow-up, and every case where it must stay silent.
// ---------------------------------------------------------------------------

/** Fire session_compact the way Pi does mid-run: the run loop is still live. */
async function fireCompact(t: ReturnType<typeof setup>, over: Record<string, unknown> = {}) {
	t.setIdle(false);
	return t.fire("session_compact", {
		compactionEntry: { type: "compaction", summary: "s", firstKeptEntryId: "e1" },
		fromExtension: false,
		reason: "threshold",
		willRetry: false,
		...over,
	});
}

const continuations = (t: ReturnType<typeof setup>) =>
	t.rec.customMessages.filter(
		(m) => m.message?.customType === "multi-account:continue-after-compaction",
	);

test("an automatic compaction carries the task on when explicitly enabled", async () => {
	const t = setup({
		current: { provider: "openai-codex", id: "gpt-5.6-sol" },
		config: { continueAfterCompaction: true },
	});
	await t.fire("agent_start");
	await fireCompact(t);

	const queued = continuations(t);
	assert.equal(queued.length, 1, "exactly one follow-up may be queued");
	// followUp is what agent.continue() drains when the last message is an assistant — which is
	// always the case right after a compaction rebuilt the context.
	assert.equal(queued[0].options?.deliverAs, "followUp");
	assert.equal(queued[0].message.display, true, "the user must be able to see why it carried on");
	const text = String(queued[0].message.content);
	assert.match(text, /compacted/i);
	// The escape hatch that makes this safe: ~a third of compactions land on finished work, and
	// no cheap signal separates them, so the model is told plainly that "done" is a valid answer.
	assert.match(text, /really is finished/i);
	assert.match(text, /[Dd]o not restart/);
});

test("it stays out of the way when Pi is already continuing the turn itself", async () => {
	const t = setup({ current: { provider: "openai-codex", id: "gpt-5.6-sol" } });
	await t.fire("agent_start");
	// Overflow recovery: Pi returns true from _runAutoCompaction on its own and calls continue().
	await fireCompact(t, { reason: "overflow", willRetry: true });
	assert.equal(continuations(t).length, 0, "a second queued message would double the turn");
});

test("a manual /compact is a deliberate pause and is never resumed", async () => {
	const t = setup({ current: { provider: "openai-codex", id: "gpt-5.6-sol" } });
	await t.fire("agent_start");
	await fireCompact(t, { reason: "manual" });
	assert.equal(continuations(t).length, 0);
});

test("nothing is queued once the session is idle", async () => {
	const t = setup({ current: { provider: "openai-codex", id: "gpt-5.6-sol" } });
	await t.fire("agent_start");
	t.setIdle(true);
	// With no live run the follow-up queue is never drained; the same call would instead append a
	// stray message that nothing delivers.
	await t.fire("session_compact", {
		compactionEntry: { type: "compaction", summary: "s", firstKeptEntryId: "e1" },
		reason: "threshold",
		willRetry: false,
	});
	assert.equal(continuations(t).length, 0);
});

test("pressing Esc stops the work; a compaction must not undo that", async () => {
	const t = setup({ current: { provider: "openai-codex", id: "gpt-5.6-sol" } });
	await t.fire("agent_start");
	const aborted = {
		role: "assistant",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		stopReason: "aborted",
		timestamp: messageTimestamp++,
		content: [{ type: "text", text: "half a thought" }],
	};
	t.setIdle(true);
	await t.fire("agent_end", { messages: [aborted] });
	await fireCompact(t);
	assert.equal(continuations(t).length, 0, "the user cancelled — carrying on would override them");
});

test("the auto-continue budget is shared with failover, not doubled", async () => {
	const t = setup({
		current: { provider: "openai-codex", id: "gpt-5.6-sol" },
		config: { maxAutoContinuesPerPrompt: 2, continueAfterCompaction: true },
	});
	await t.fire("agent_start");
	await fireCompact(t);
	await fireCompact(t);
	assert.equal(continuations(t).length, 2, "within budget");
	await fireCompact(t);
	assert.equal(continuations(t).length, 2, "a task must not be able to keep itself alive forever");
});

test("contextGuard and continueAfterCompaction can each be turned off alone", async () => {
	const defaultOn = setup({
		current: { provider: "openai-codex", id: "gpt-5.6-sol" },
	});
	await defaultOn.fire("agent_start");
	await fireCompact(defaultOn);
	assert.equal(
		continuations(defaultOn).length,
		1,
		"post-compaction continuation is enabled by default for run-to-completion",
	);

	const off = setup({
		current: { provider: "openai-codex", id: "gpt-5.6-sol" },
		config: { continueAfterCompaction: false },
	});
	await off.fire("agent_start");
	await fireCompact(off);
	assert.equal(continuations(off).length, 0);

	const on = setup({
		current: { provider: "openai-codex", id: "gpt-5.6-sol" },
		config: { continueAfterCompaction: true },
	});
	await on.fire("agent_start");
	await fireCompact(on);
	assert.equal(continuations(on).length, 1, "explicit opt-in is on");
});

// ---------------------------------------------------------------------------
// The failover ladder — where work goes once the whole provider is spent
//
// Rotation's first step already works: 588 of 602 automatic failovers in the black box stayed
// inside the same provider family. The other 14 had no policy behind them and scattered across
// five destinations, and not one of the 602 ever reached a per-token account. These lock the
// ladder that replaces that, and — just as importantly — the two things it must never override.
// ---------------------------------------------------------------------------

/** Three live families plus a per-token provider, none of them cooling. */
const LADDER_ACCOUNTS = {
	anthropic: { type: "oauth" as const, access: "a", refresh: "ar" },
	"kimi-coding-account-2": { type: "oauth" as const, access: "k", refresh: "kr", accountId: "k2" },
	cursor: { type: "oauth" as const, access: "c", refresh: "cr", accountId: "cur" },
	openrouter: { type: "api_key" as const, key: "or-key" },
};

test("the ladder decides the hop the telemetry cannot", async () => {
	// Leaving Codex with nothing to separate the survivors: all live, none refused. This is the
	// exact spot where the old order fell through to discovery sequence and the destination was
	// effectively arbitrary.
	const t = setup({
		accounts: { ...LADDER_ACCOUNTS, "openai-codex": { type: "oauth", access: "o", refresh: "or2" } },
		current: { provider: "openai-codex", id: "gpt-5.5" },
		config: { providerPriority: ["cursor", "kimi-coding", "anthropic"] },
	});
	await finishError(t, "openai-codex", "gpt-5.5", "429 rate limit");
	assert.ok(
		t.rec.setModels[0]?.startsWith("cursor/"),
		`the ladder's first rung must win; got ${JSON.stringify(t.rec.setModels)}`,
	);
});

test("reordering the ladder reorders the hop", async () => {
	// The same starting position, one setting different — nothing else may explain the change.
	const t = setup({
		accounts: { ...LADDER_ACCOUNTS, "openai-codex": { type: "oauth", access: "o", refresh: "or2" } },
		current: { provider: "openai-codex", id: "gpt-5.5" },
		config: { providerPriority: ["anthropic", "cursor", "kimi-coding"] },
	});
	await finishError(t, "openai-codex", "gpt-5.5", "429 rate limit");
	assert.ok(
		t.rec.setModels[0]?.startsWith("anthropic/"),
		`got ${JSON.stringify(t.rec.setModels)}`,
	);
});

test("a per-token account is not spent while a flat-rate one is free", async () => {
	// Never reached automatically in 602 failovers, which was right — but by accident of
	// `providerOrder` being unable to name it, not by a policy anyone chose. Now it is the policy.
	const t = setup({
		accounts: { ...LADDER_ACCOUNTS, "openai-codex": { type: "oauth", access: "o", refresh: "or2" } },
		current: { provider: "openai-codex", id: "gpt-5.5" },
	});
	await finishError(t, "openai-codex", "gpt-5.5", "429 rate limit");
	assert.ok(t.rec.setModels.length > 0, "something must have been chosen");
	assert.equal(
		t.rec.setModels[0]?.startsWith("openrouter/"),
		false,
		`a subscription account was free; got ${JSON.stringify(t.rec.setModels)}`,
	);
});

test("naming a per-token provider first is honoured — it is the user's money", async () => {
	const t = setup({
		accounts: { ...LADDER_ACCOUNTS, "openai-codex": { type: "oauth", access: "o", refresh: "or2" } },
		current: { provider: "openai-codex", id: "gpt-5.5" },
		config: { providerPriority: ["openrouter", "anthropic"] },
	});
	await finishError(t, "openai-codex", "gpt-5.5", "429 rate limit");
	assert.ok(
		t.rec.setModels[0]?.startsWith("openrouter/"),
		`got ${JSON.stringify(t.rec.setModels)}`,
	);
});

test("the ladder never pulls work off the current family while a sibling is free", async () => {
	// The step that already worked, and the one the ladder must not touch: staying on the family
	// keeps the model the user chose. A ladder that ranks anthropic first must still try the other
	// Codex slot before leaving Codex at all.
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
			"openai-codex": { type: "oauth", access: "o", refresh: "or2", accountId: "c1" },
			"openai-codex-account-2": { type: "oauth", access: "o2", refresh: "or3", accountId: "c2" },
		},
		current: { provider: "openai-codex", id: "gpt-5.5" },
		config: { providerPriority: ["anthropic", "openai-codex"] },
	});
	await finishError(t, "openai-codex", "gpt-5.5", "429 rate limit");
	assert.ok(
		t.rec.setModels[0]?.startsWith("openai-codex-account-2/"),
		`same-family failover outranks the ladder; got ${JSON.stringify(t.rec.setModels)}`,
	);
});

test("the ladder never sends work to an account the provider says is spent", async () => {
	// Evidence about one account beats a preference about its category. An earlier draft put the
	// ladder above the liveness signals and this is the case that caught it.
	const now = Date.now();
	const t = setup({
		accounts: {
			anthropic: { type: "oauth", access: "a", refresh: "ar" },
			"openai-codex-account-3": { type: "oauth", access: "c3", refresh: "r3", accountId: "codex-3" },
			alibaba: { type: "api_key", key: "qwen-key" },
		},
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		// Codex is ranked ahead of Qwen — and is also reported 100 % used.
		config: { providerPriority: ["openai-codex", "qwen"] },
		seedState: {
			stateVersion: 5,
			exhaustedUntilByProvider: {},
			exhaustedUntilByModel: {},
			lastProbeAtByProvider: {},
			invalidatedByProvider: {},
			usageByProvider: {
				"openai-codex-account-3": {
					provider: "openai-codex-account-3",
					family: "codex",
					fetchedAt: now - 60 * 60 * 1000,
					primary: { usedPercent: 100, resetAt: now + 14 * 24 * 60 * 60 * 1000 },
				},
			},
			lastSwitches: [],
		},
	});
	await finishError(t, "anthropic", "claude-opus-4-8", "429 rate_limit_error");
	assert.ok(
		t.rec.setModels.some((m) => m.startsWith("alibaba/")),
		`the live account must win over a higher-ranked spent one; got ${JSON.stringify(t.rec.setModels)}`,
	);
});

test("an empty ladder leaves every ordering exactly as it was", async () => {
	const t = setup({
		accounts: { ...LADDER_ACCOUNTS, "openai-codex": { type: "oauth", access: "o", refresh: "or2" } },
		current: { provider: "openai-codex", id: "gpt-5.5" },
		config: { providerPriority: [] },
	});
	await finishError(t, "openai-codex", "gpt-5.5", "429 rate limit");
	assert.ok(t.rec.setModels.length > 0, "failover must still happen with no stated preference");
});

// ---- the command -----------------------------------------------------------

test("/multi-account priority reports the ladder without changing it", async () => {
	const t = setup({ current: { provider: "anthropic", id: "claude-opus-5" } });
	await t.command("priority");
	const said = t.rec.notifies.join("\n");
	assert.match(said, /failover priority/i);
	assert.match(said, /1\. anthropic/);
	assert.match(said, /everything else/);
	assert.equal(
		JSON.parse(readFileSync(CONFIG, "utf8")).providerPriority,
		undefined,
		"reporting must not write",
	);
});

test("/multi-account priority sets, persists and confirms a new ladder", async () => {
	const t = setup({ current: { provider: "anthropic", id: "claude-opus-5" } });
	await t.command("priority cursor claude kimi");
	const said = t.rec.notifies.join("\n");
	assert.match(said, /1\. cursor/);
	assert.match(said, /2\. anthropic/, "nicknames are resolved before being stored");
	assert.match(said, /3\. kimi-coding/);
	const raw = JSON.parse(readFileSync(CONFIG, "utf8"));
	assert.deepEqual(raw.providerPriority, ["cursor", "anthropic", "kimi-coding"]);
});

test("/multi-account priority names providers you are not logged in to", async () => {
	// Otherwise a typo produces a ladder that looks accepted and silently never applies.
	const t = setup({ current: { provider: "anthropic", id: "claude-opus-5" } });
	await t.command("priority anthropic totally-made-up");
	assert.match(t.rec.notifies.join("\n"), /Not logged in.*totally-made-up/s);
});

test("/multi-account priority rejects an unreadable list instead of wiping the ladder", async () => {
	const t = setup({ current: { provider: "anthropic", id: "claude-opus-5" } });
	await t.command("priority ///");
	assert.match(t.rec.notifies.join("\n"), /could not read any provider name/i);
	assert.equal(
		JSON.parse(readFileSync(CONFIG, "utf8")).providerPriority,
		undefined,
		"a rejected list must leave the stored ladder untouched",
	);
});

test("/multi-account priority distinguishes reset from clear", async () => {
	const t = setup({ current: { provider: "anthropic", id: "claude-opus-5" } });
	await t.command("priority none");
	assert.deepEqual(JSON.parse(readFileSync(CONFIG, "utf8")).providerPriority, []);
	assert.match(t.rec.notifies.join("\n"), /cleared/i);

	await t.command("priority reset");
	const raw = JSON.parse(readFileSync(CONFIG, "utf8"));
	assert.deepEqual(raw.providerPriority, [
		"anthropic",
		"openai-codex",
		"kimi-coding",
		"cursor",
		"qwen",
		"ollama",
	]);
});

// ---------------------------------------------------------------------------
// Pi's published files: the contract this extension actually depends on
//
// Two Pi changes have broken this extension without announcing themselves, because neither
// auth.json nor models.json carries a schema version. These lock the detection: the extension
// looks at the files, and says so when one stops matching.
// ---------------------------------------------------------------------------

const contractWarning = (t: ReturnType<typeof setup>) =>
	t.rec.notifies.find((message) => message.includes("no longer matches what this extension"));

test("a healthy install says nothing about the file contract", async () => {
	rmSync(MODELS, { force: true });
	const t = setup({ current: { provider: "anthropic", id: "claude-opus-4-8" } });
	await t.fire("session_start");
	assert.equal(contractWarning(t), undefined, `notifies=${t.rec.notifies.join(" | ")}`);
	await t.fire("session_shutdown");
});

test("a models.json written with bare model ids is reported at session start", async () => {
	// The real incident: bare strings where Pi requires objects made Pi reject the WHOLE file, so
	// every custom provider the user had vanished at once, silently.
	writeFileSync(
		MODELS,
		JSON.stringify({
			// A third-party provider on purpose: our own slots get rewritten by provisioning, and
			// the point of the check is the file as the USER left it.
			providers: { "my-local-thing": { api: "openai-completions", models: ["k3"] } },
		}),
	);
	try {
		const t = setup({ current: { provider: "anthropic", id: "claude-opus-4-8" } });
		await t.fire("session_start");
		const warning = contractWarning(t);
		assert.ok(warning, `expected a contract warning; notifies=${t.rec.notifies.join(" | ")}`);
		assert.match(warning, /models\.json/);
		assert.match(warning, /bare string/);
		// Blast radius, or it reads like a problem confined to one slot.
		assert.match(warning, /ENTIRE file/);
		await t.fire("session_shutdown");
	} finally {
		rmSync(MODELS, { force: true });
	}
});

test("a corrupt published file is reported rather than silently ignored", async () => {
	writeFileSync(MODELS, "{ this is not json");
	try {
		const t = setup({ current: { provider: "anthropic", id: "claude-opus-4-8" } });
		await t.fire("session_start");
		const warning = contractWarning(t);
		assert.ok(warning, `notifies=${t.rec.notifies.join(" | ")}`);
		assert.match(warning, /will not parse/);
		await t.fire("session_shutdown");
	} finally {
		rmSync(MODELS, { force: true });
	}
});

test("settings.json is NOT judged before a switch has happened", async () => {
	// At session start the file legitimately still names the previous session's choice. Warning
	// about that would be noise on every single startup.
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		settings: { defaultProvider: "openai-codex-account-2", defaultModel: "gpt-5.5" },
	});
	await t.fire("session_start");
	assert.equal(contractWarning(t), undefined, `notifies=${t.rec.notifies.join(" | ")}`);
	await t.fire("session_shutdown");
});

test("after a switch, settings.json failing to name the live model is called out", async () => {
	// This is the live failure that started all of this: the rotation was on Codex, settings.json
	// said Anthropic, and a bare `--no-extensions` child ran on Anthropic and was billing-refused.
	// Nothing in Pi promises those keys are maintained, so the only defence is to look.
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		settings: { defaultProvider: "anthropic", defaultModel: "claude-opus-4-8" },
		config: { debugLog: true },
	});
	await t.fire("session_start");
	assert.equal(contractWarning(t), undefined, "nothing to judge yet");

	// The session moves to another account and Pi does NOT rewrite settings.json — the exact
	// failure being guarded against.
	t.setCurrent("openai-codex-account-2", "gpt-5.5");
	await t.fire("model_select", { model: { provider: "openai-codex-account-2", id: "gpt-5.5" } });
	await t.fire("agent_start");

	const warning = contractWarning(t);
	assert.ok(warning, `expected a stale-default warning; notifies=${t.rec.notifies.join(" | ")}`);
	assert.match(warning, /anthropic\/claude-opus-4-8/);
	assert.match(warning, /openai-codex-account-2\/gpt-5\.5/);
	// The consequence is the whole reason this matters — a child, not a cosmetic file.
	assert.match(warning, /child/);

	const logged = readDebugLog().filter((entry) => entry.kind === "pi_contract_checked");
	assert.ok(logged.length > 0, "the black box must record the check");
	assert.ok(
		logged.at(-1)?.unpromised?.includes("settings-default-model-autowritten"),
		"the log must name the unpromised assumption this check exists for",
	);
	await t.fire("session_shutdown");
});

test("after a switch, settings.json naming the live model is silent", async () => {
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		settings: { defaultProvider: "anthropic", defaultModel: "claude-opus-4-8" },
	});
	await t.fire("session_start");
	// Pi did its job: the file follows the switch.
	t.setCurrent("openai-codex-account-2", "gpt-5.5");
	writeFileSync(
		SETTINGS,
		JSON.stringify({ defaultProvider: "openai-codex-account-2", defaultModel: "gpt-5.5" }),
	);
	await t.fire("model_select", { model: { provider: "openai-codex-account-2", id: "gpt-5.5" } });
	await t.fire("agent_start");
	assert.equal(contractWarning(t), undefined, `notifies=${t.rec.notifies.join(" | ")}`);
	await t.fire("session_shutdown");
});

// ---------------------------------------------------------------------------
// What the rotation looks like to something that does NOT load this extension
// ---------------------------------------------------------------------------

test("with the proxy off, status says which slots an extension-free child cannot authenticate to", async () => {
	// Measured 2026-08-24: a numbered slot with an OAuth credential resolves by name and then
	// fails with "No API key found", because Pi honours OAuth only for a provider definition that
	// declares the flow. Publishing the name is not publishing a usable route.
	rmSync(MODELS, { force: true });
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { childProxy: false },
		accounts: {
			anthropic: { type: "oauth", access: "a-tok-1", refresh: "a-ref-1" },
			"openai-codex-account-2": { type: "oauth", access: "c-tok-2", refresh: "c-ref-2" },
			zai: { type: "api_key", key: "sk-zai" },
		},
	});
	await t.fire("session_start");
	t.rec.notifies.length = 0;
	await t.command("status");
	const status = t.rec.notifies.at(-1) ?? "";
	assert.match(status, /Extension-free children: \d+\/\d+ rotation slots usable/);
	// The numbered OAuth slot is the unusable one; the built-in and the API-key account are not.
	assert.match(status, /cannot authenticate: [^\n]*openai-codex-account-2/);
	assert.equal(/cannot authenticate: [^\n]*\bzai\b/.test(status), false, status);
	await t.fire("session_shutdown");
});

test("with the proxy off, status warns that the account a bare child picks up is unusable", async () => {
	// settings.json is how anything spawned without this extension finds the active account. When
	// that account is unusable the child does not fail — it silently runs on another vendor. This
	// is the shape of the real incident: rotation on Codex, consolidation child on Anthropic.
	rmSync(MODELS, { force: true });
	const t = setup({
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		settings: { defaultProvider: "openai-codex-account-2", defaultModel: "gpt-5.5" },
		config: { childProxy: false },
	});
	await t.fire("session_start");
	t.rec.notifies.length = 0;
	await t.command("status");
	const status = t.rec.notifies.at(-1) ?? "";
	assert.match(status, /openai-codex-account-2/);
	assert.match(status, /first-available provider/);
	await t.fire("session_shutdown");
});

test("a canonical port held by an independent process cannot hang session_start", async () => {
	// A same-process listener can re-enter listen() synchronously after EADDRINUSE on some Node
	// versions, which let the ownership test below pass while every second real Pi process hung.
	// Hold the canonical port from another process to reproduce the actual multi-session boundary.
	process.env.PI_MULTI_ACCOUNT_SLOT_PROXY_PORT = String(nextSlotProxyPort++);
	const port = currentSlotProxyPort();
	const blocker = spawn(
		process.execPath,
		[
			"-e",
			`require("node:net").createServer().listen(${port}, "127.0.0.1", () => process.stdout.write("ready\\n"))`,
		],
		{ stdio: ["ignore", "pipe", "inherit"] },
	);
	await new Promise<void>((resolve, reject) => {
		blocker.once("error", reject);
		blocker.stdout.once("data", () => resolve());
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const t = setup({
			reuseSlotProxyPort: true,
			current: { provider: "anthropic", id: "claude-opus-4-8" },
		});
		await Promise.race([
			t.fire("session_start"),
			new Promise((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("session_start remained pending after EADDRINUSE")),
					2_000,
				);
			}),
		]);
		await t.fire("session_shutdown");
	} finally {
		if (timer) clearTimeout(timer);
		blocker.kill();
	}
});

test("a second process that cannot own the canonical port leaves the owner's files alone", async () => {
	// The listening port IS the ownership token for the SHARED files. A second Pi process — and
	// a `pi-subagents` child is just another process on this machine — used to hit EADDRINUSE,
	// quietly take a RANDOM port, and republish every rotation slot against itself. The owner's
	// children were then pointed at a socket that died the moment that short-lived process
	// exited, and its shutdown restored auth.json and unpublished routes that were never its
	// own. A non-owner may serve its own callers, but must not touch models.json or auth.json.
	const owner = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		accounts: {
			anthropic: { type: "oauth", access: "a-tok-1", refresh: "a-ref-1" },
			"openai-codex-account-2": { type: "oauth", access: "c-tok-2", refresh: "c-ref-2" },
		},
	});
	await owner.fire("session_start");
	const ownerRoute = JSON.parse(readFileSync(MODELS, "utf8")).providers[
		"openai-codex-account-2"
	]?.baseUrl;
	assert.match(
		String(ownerRoute),
		new RegExp(`^http://127\\.0\\.0\\.1:${currentSlotProxyPort()}/`),
		"precondition: the owner published its own loopback route",
	);
	assert.equal(
		JSON.parse(readFileSync(AUTH, "utf8"))["openai-codex-account-2"]?.type,
		"api_key",
		"precondition: the owner shadowed the credential a child must not see",
	);

	// A second instance on the same machine, contending for the port the owner still holds. It
	// starts from the files exactly as the owner left them — that is what a real second process
	// finds on disk, shadow and all.
	const second = setup({
		reuseSlotProxyPort: true,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		accounts: JSON.parse(readFileSync(AUTH, "utf8")),
	});
	await second.fire("session_start");
	assert.equal(
		JSON.parse(readFileSync(MODELS, "utf8")).providers["openai-codex-account-2"].baseUrl,
		ownerRoute,
		"a non-owner must not repoint the owner's published route at itself",
	);

	await second.fire("session_shutdown");
	const after = JSON.parse(readFileSync(MODELS, "utf8"));
	assert.equal(
		after.providers?.["openai-codex-account-2"]?.baseUrl,
		ownerRoute,
		"a non-owner must not unpublish the owner's route on its own shutdown",
	);
	assert.equal(
		JSON.parse(readFileSync(AUTH, "utf8"))["openai-codex-account-2"]?.type,
		"api_key",
		"a non-owner must not restore credentials the owner is still shadowing",
	);
	await owner.fire("session_shutdown");
});

test("a slot published against a parent-owned loopback route counts as usable", async () => {
	// This is what the Cursor slots already do: a non-secret placeholder plus a route the parent
	// serves, so the child authenticates to this machine and the real token never leaves.
	writeFileSync(
		MODELS,
		JSON.stringify({
			providers: {
				"openai-codex-account-2": {
					api: "openai-codex-responses",
					baseUrl: "http://127.0.0.1:41999/v1",
					apiKey: "codex-proxy",
					models: [{ id: "gpt-5.5" }],
				},
			},
		}),
	);
	try {
		const t = setup({ current: { provider: "anthropic", id: "claude-opus-4-8" } });
		await t.fire("session_start");
		t.rec.notifies.length = 0;
		await t.command("status");
		const status = t.rec.notifies.at(-1) ?? "";
		assert.equal(
			/cannot authenticate: [^\n]*openai-codex-account-2/.test(status),
			false,
			status,
		);
		await t.fire("session_shutdown");
	} finally {
		rmSync(MODELS, { force: true });
	}
});

test("user modelOverrides survive proxy publication, rediscovery, and shutdown cleanup", async () => {
	rmSync(MODELS, { force: true });
	const modelOverrides = {
		"claude-opus-5": { contextWindow: 466_384, maxTokens: 64_000 },
	};
	writeFileSync(
		MODELS,
		JSON.stringify({
			providers: {
				anthropic: {
					api: "anthropic-messages",
					baseUrl: "https://stale.example.invalid",
					models: [{ id: "claude-opus-5", contextWindow: 1_000_000 }],
					modelOverrides,
				},
			},
		}),
	);
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-5" },
		accounts: {
			anthropic: { type: "oauth", access: "a-tok-1", refresh: "a-ref-1" },
		},
	});
	try {
		await t.fire("session_start");
		let provider = JSON.parse(readFileSync(MODELS, "utf8")).providers.anthropic;
		assert.match(provider.baseUrl, /^http:\/\/127\.0\.0\.1:/);
		assert.deepEqual(provider.modelOverrides, modelOverrides);

		// Force rediscovery to replace stale generated routing/catalog data again. The user's
		// override layer must survive even when provisioning cannot take its no-op fast path.
		provider.baseUrl = "https://stale-again.example.invalid";
		provider.models = [{ id: "claude-opus-5", contextWindow: 1_000_000 }];
		writeFileSync(MODELS, JSON.stringify({ providers: { anthropic: provider } }));
		await t.command("rediscover");
		await new Promise<void>((resolve) => setImmediate(resolve));
		provider = JSON.parse(readFileSync(MODELS, "utf8")).providers.anthropic;
		assert.match(provider.baseUrl, /^http:\/\/127\.0\.0\.1:/);
		assert.deepEqual(provider.modelOverrides, modelOverrides);
	} finally {
		await t.fire("session_shutdown");
	}
	assert.deepEqual(
		JSON.parse(readFileSync(MODELS, "utf8")).providers.anthropic,
		{ modelOverrides },
		"shutdown must remove the dead loopback route without deleting user model metadata",
	);
	rmSync(MODELS, { force: true });
});

test("with the proxy on, the OAuth slots a child could not use become usable", async () => {
	// The whole point of the parent-owned route: the slot the rotation chose is the slot the
	// child runs on, instead of Pi's first-available provider on some other vendor.
	rmSync(MODELS, { force: true });
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		settings: { defaultProvider: "openai-codex-account-2", defaultModel: "gpt-5.5" },
		accounts: {
			anthropic: { type: "oauth", access: "a-tok-1", refresh: "a-ref-1" },
			"openai-codex-account-2": { type: "oauth", access: "c-tok-2", refresh: "c-ref-2" },
		},
	});
	try {
		await t.fire("session_start");
		t.rec.notifies.length = 0;
		await t.command("status");
		const status = t.rec.notifies.at(-1) ?? "";
		assert.equal(
			/cannot authenticate: [^\n]*openai-codex-account-2/.test(status),
			false,
			status,
		);
		assert.equal(/first-available provider/.test(status), false, status);

		// And the route it was published against is this machine, with a non-secret placeholder —
		// the real OAuth token must never be written into a file a child reads.
		const slot = JSON.parse(readFileSync(MODELS, "utf8")).providers["openai-codex-account-2"];
		assert.ok(slot, "the slot must be published for a bare child to resolve it");
		assert.equal(new URL(slot.baseUrl).hostname, "127.0.0.1");
		// A key must be published or Pi refuses the provider outright; which shape it takes per
		// family is covered by its own test.
		assert.ok(typeof slot.apiKey === "string" && slot.apiKey.length > 0);
		const published = readFileSync(MODELS, "utf8");
		assert.equal(published.includes("c-tok-2"), false, "no real token in a published file");
		assert.equal(published.includes("c-ref-2"), false);
	} finally {
		await t.fire("session_shutdown");
		rmSync(MODELS, { force: true });
	}
});

/** Talk to the running proxy the way a bare child would: plain HTTP on loopback. */
function callProxy(
	baseUrl: string,
	path: string,
	headers: Record<string, string>,
	body = "{}",
): Promise<{ status: number; body: string }> {
	const url = new URL(baseUrl + path);
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{
				hostname: url.hostname,
				port: url.port,
				path: url.pathname + url.search,
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
			},
			(res) => {
				let text = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					text += chunk;
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
			},
		);
		req.on("error", reject);
		req.end(body);
	});
}

test("the proxy swaps the placeholder for the real token and never forwards the placeholder", async () => {
	rmSync(MODELS, { force: true });
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		accounts: {
			"openai-codex-account-2": {
				type: "oauth",
				access: "c-tok-2",
				refresh: "c-ref-2",
				accountId: "acct-9",
			},
		},
	});
	const realFetch = globalThis.fetch;
	const seen: Array<{ url: string; headers: Record<string, string> }> = [];
	try {
		await t.fire("session_start");
		const slot = JSON.parse(readFileSync(MODELS, "utf8")).providers["openai-codex-account-2"];
		assert.ok(slot?.baseUrl, "the slot must be published against the running proxy");

		globalThis.fetch = (async (input: any, init: any) => {
			seen.push({ url: String(input), headers: { ...(init?.headers ?? {}) } });
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;

		const response = await callProxy(slot.baseUrl, "/codex/responses", {
			authorization: `Bearer ${slot.apiKey}`,
			// Pi fills this in from the placeholder it was given; the proxy must replace it.
			"chatgpt-account-id": "pi-multi-account-proxy",
		});
		assert.equal(response.status, 200);
		assert.equal(seen.length, 1, "the request must reach the upstream exactly once");
		assert.equal(seen[0].url, "https://chatgpt.com/backend-api/codex/responses");
		// The real credential is added here and only here — a child never holds it.
		assert.equal(seen[0].headers.authorization, "Bearer c-tok-2");
		assert.equal(seen[0].headers["chatgpt-account-id"], "acct-9");
		assert.equal(
			JSON.stringify(seen[0].headers).includes(slot.apiKey),
			false,
			"the placeholder must never travel upstream",
		);
	} finally {
		globalThis.fetch = realFetch;
		await t.fire("session_shutdown");
		rmSync(MODELS, { force: true });
	}
});

test("the proxy refuses a caller that did not come from a slot we published", async () => {
	// A loopback port is reachable by every process on this machine, and what sits behind it is
	// the user's subscription. Anything that cannot present the published placeholder is refused
	// before a single upstream call is made.
	rmSync(MODELS, { force: true });
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		accounts: {
			"openai-codex-account-2": { type: "oauth", access: "c-tok-2", refresh: "c-ref-2" },
		},
	});
	const realFetch = globalThis.fetch;
	let upstreamCalls = 0;
	try {
		await t.fire("session_start");
		const slot = JSON.parse(readFileSync(MODELS, "utf8")).providers["openai-codex-account-2"];
		globalThis.fetch = (async () => {
			upstreamCalls++;
			return new Response("{}", { status: 200 });
		}) as typeof fetch;

		const noKey = await callProxy(slot.baseUrl, "/codex/responses", {});
		assert.equal(noKey.status, 401);
		const wrongKey = await callProxy(slot.baseUrl, "/codex/responses", {
			authorization: "Bearer sk-someone-elses-key",
		});
		assert.equal(wrongKey.status, 401);
		// Nor may the refusal repeat back what was presented — refusals get logged.
		assert.equal(wrongKey.body.includes("sk-someone-elses-key"), false);

		const port = new URL(slot.baseUrl).port;
		const unknownSlot = await callProxy(`http://127.0.0.1:${port}/anthropic-account-9`, "/v1/messages", {
			authorization: `Bearer ${slot.apiKey}`,
		});
		assert.equal(unknownSlot.status, 404);

		assert.equal(upstreamCalls, 0, "no refused request may reach an upstream");
	} finally {
		globalThis.fetch = realFetch;
		await t.fire("session_shutdown");
		rmSync(MODELS, { force: true });
	}
});

test("the proxy refuses a WebSocket upgrade so Pi falls back to SSE without a wasted round trip", async () => {
	// Measured on a real bare child: Pi's Codex API tries a WebSocket first and only then POSTs
	// over SSE. Forwarding that attempt upstream would spend a request that could never work.
	rmSync(MODELS, { force: true });
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		accounts: {
			"openai-codex-account-2": { type: "oauth", access: "c-tok-2", refresh: "c-ref-2" },
		},
	});
	const realFetch = globalThis.fetch;
	let upstreamCalls = 0;
	try {
		await t.fire("session_start");
		const slot = JSON.parse(readFileSync(MODELS, "utf8")).providers["openai-codex-account-2"];
		globalThis.fetch = (async () => {
			upstreamCalls++;
			return new Response("{}", { status: 200 });
		}) as typeof fetch;
		const response = await callProxy(slot.baseUrl, "/codex/responses", {
			authorization: `Bearer ${slot.apiKey}`,
			upgrade: "websocket",
			// `connection: upgrade` would make Node treat this as a real handshake; the header
			// alone is enough to prove the request path refuses it.
		});
		assert.equal(response.status, 501);
		assert.equal(upstreamCalls, 0);
	} finally {
		globalThis.fetch = realFetch;
		await t.fire("session_shutdown");
		rmSync(MODELS, { force: true });
	}
});

test("the Codex slot is published with a token-shaped placeholder that carries nothing real", async () => {
	// Pi's Codex API reads an account id out of the key before it will send anything at all
	// (measured: "Failed to extract accountId from token" on a plain placeholder). The shape is
	// therefore required — the content must still be worthless.
	rmSync(MODELS, { force: true });
	const t = setup({
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		accounts: {
			"openai-codex-account-2": {
				type: "oauth",
				access: "c-tok-2",
				refresh: "c-ref-2",
				accountId: "acct-real-9",
			},
		},
	});
	try {
		await t.fire("session_start");
		const published = readFileSync(MODELS, "utf8");
		const slot = JSON.parse(published).providers["openai-codex-account-2"];
		assert.equal(slot.api, "openai-codex-responses");
		const payload = JSON.parse(
			Buffer.from(String(slot.apiKey).split(".")[1], "base64").toString("utf8"),
		);
		// The user's real account id must not be in a file a child reads — the proxy substitutes it.
		assert.equal(payload["https://api.openai.com/auth"].chatgpt_account_id, "pi-multi-account-proxy");
		assert.equal(published.includes("acct-real-9"), false);
		assert.equal(published.includes("c-tok-2"), false);
	} finally {
		await t.fire("session_shutdown");
		rmSync(MODELS, { force: true });
	}
});

// ---------------------------------------------------------------------------
// The rotation that never sent a request
//
// Recorded on a real machine: 275 account switches in four minutes, alternating between
// openai-codex-account-2 and openai-codex-account-3 roughly every 1.24 s, with not one request
// leaving the machine and a free Anthropic account sitting unasked at the top of the ladder.
// Esc did nothing because there was no run to cancel, and `/multi-account stop` had to be typed
// several times before it took.
//
// The mechanism: `findFallbackModels` admits a same-family sibling whose meter reads 100 % as
// long as it has "not refused this session", and the pending-resume path rotates onto an account
// without ever sending it a request — so it never refuses, so it stays admissible for ever. Two
// such siblings re-admit each other indefinitely, and same-model ranks them above the free
// account every time.
// ---------------------------------------------------------------------------

/** Four accounts: three spent Codex slots and one live Anthropic one. */
const SPENT_CODEX_FLEET: Account = {
	"openai-codex": { type: "oauth", access: "c1", refresh: "r1", accountId: "codex-1" },
	"openai-codex-account-2": { type: "oauth", access: "c2", refresh: "r2", accountId: "codex-2" },
	"openai-codex-account-3": { type: "oauth", access: "c3", refresh: "r3", accountId: "codex-3" },
	anthropic: { type: "oauth", access: "a1", refresh: "ar1" },
};

/** A meter that reads "spent" without any refusal having happened yet. */
function spentCodexUsage(provider: string, now: number) {
	return {
		provider,
		family: "codex",
		fetchedAt: now,
		serviceable: false,
		plan: "free",
		primary: { usedPercent: 100, resetAt: now + 5 * 60 * 60 * 1000 },
	};
}

function spentCodexFleetState(now: number, extra: Record<string, unknown> = {}) {
	return {
		stateVersion: 5,
		exhaustedUntilByProvider: {},
		exhaustedUntilByModel: {},
		lastProbeAtByProvider: {},
		invalidatedByProvider: {},
		usageByProvider: {
			"openai-codex": spentCodexUsage("openai-codex", now),
			"openai-codex-account-2": spentCodexUsage("openai-codex-account-2", now),
			"openai-codex-account-3": spentCodexUsage("openai-codex-account-3", now),
			...extra,
		},
		lastSwitches: [],
	};
}

test("two spent siblings cannot rotate onto each other for ever while a live account waits", async () => {
	const now = Date.now();
	const t = setup({
		accounts: SPENT_CODEX_FLEET,
		current: { provider: "openai-codex", id: "gpt-5.5" },
		config: { pendingPollMs: 25, providerOrder: ["openai-codex", "anthropic"] },
		seedState: spentCodexFleetState(now),
	});
	await t.fire("session_start");
	await t.fire("agent_start");

	await finishError(
		t,
		"openai-codex",
		"gpt-5.5",
		"Codex error: The usage limit has been reached",
	);
	// Long enough for a 25 ms poll to make a dozen hops if nothing bounds it.
	await wait(500);

	const switches = t.rec.setModels;
	// Each spent sibling is owed exactly one attempt — its meter is a forecast, and a forecast is
	// worth one request. Rotating onto it IS that request's worth of doubt, spent.
	const perAccount = new Map<string, number>();
	for (const target of switches) {
		const provider = target.split("/")[0];
		perAccount.set(provider, (perAccount.get(provider) ?? 0) + 1);
	}
	for (const [provider, count] of perAccount) {
		assert.ok(
			count <= 1,
			`no account may be rotated onto twice in one chain; ${provider} was chosen ${count} times (${switches.join(", ")})`,
		);
	}
	assert.ok(
		switches.some((target) => target.startsWith("anthropic/")),
		`the live account must be reached once the family is exhausted; got: ${switches.join(", ")}`,
	);
	assert.ok(
		t.rec.continueCalls.length >= 1,
		"and the interrupted task must actually be resumed there",
	);
	// Not merely finite: direct. A wait that has to walk every spent slot in the family before it
	// reaches the account it can actually use is a minute of switching for nothing, and on a fleet
	// of seven Codex slots it would spend the whole hop budget getting there.
	assert.ok(
		switches.length <= 3,
		`the live account must be reached without walking the spent ones; got: ${switches.join(", ")}`,
	);
	await t.fire("session_shutdown");
});

test("the resume timer only rotates onto an account it could actually resume on", async () => {
	// The dispatch that follows a timer rotation refuses to resume onto a cooling account — so
	// rotating onto one tests nothing and changes nothing, it just moves the session sideways.
	// Everywhere a request is genuinely sent, a forecast-spent sibling still gets its attempt.
	const now = Date.now();
	const t = setup({
		accounts: SPENT_CODEX_FLEET,
		current: { provider: "openai-codex-account-2", id: "gpt-5.5" },
		config: { pendingPollMs: 25 },
		seedState: spentCodexFleetState(now),
	});
	await t.fire("session_start");
	await t.fire("agent_start");
	const before = t.rec.setModels.length;

	await finishError(
		t,
		"openai-codex-account-2",
		"gpt-5.5",
		"Codex error: The usage limit has been reached",
	);
	await wait(400);

	const chosen = t.rec.setModels.slice(before);
	const spent = chosen.filter((target) => target.startsWith("openai-codex"));
	assert.ok(
		spent.length <= 1,
		`at most the one sibling that gets a real request may be tried; got: ${chosen.join(", ")}`,
	);
	assert.ok(
		t.ctx.model.provider === "anthropic" ||
			chosen.some((target) => target.startsWith("anthropic/")),
		`and the session must land somewhere it can actually work; got current ${t.ctx.model.provider}/${t.ctx.model.id}, switches: ${chosen.join(", ")}`,
	);
	await t.fire("session_shutdown");
});

test("a rotation that reaches nothing usable stops instead of polling for ever", async () => {
	// Same fleet, but the Anthropic account is spent too — so there is genuinely nowhere to go.
	// The wait itself must then be finite and say so, rather than switching account every second
	// until the user kills the session.
	const now = Date.now();
	const t = setup({
		accounts: SPENT_CODEX_FLEET,
		current: { provider: "openai-codex", id: "gpt-5.5" },
		config: { pendingPollMs: 25, maxAutoContinuesPerPrompt: 2 },
		seedState: spentCodexFleetState(now, {
			anthropic: {
				provider: "anthropic",
				family: "anthropic",
				fetchedAt: now,
				serviceable: false,
				primary: { usedPercent: 100, resetAt: now + 5 * 60 * 60 * 1000 },
			},
		}),
	});
	await t.fire("session_start");
	await t.fire("agent_start");

	await finishError(
		t,
		"openai-codex",
		"gpt-5.5",
		"Codex error: The usage limit has been reached",
	);
	await wait(500);

	const settled = t.rec.setModels.length;
	assert.ok(
		settled <= 4,
		`a hopeless fleet must stop rotating, not keep switching; got ${settled} switches (${t.rec.setModels.join(", ")})`,
	);
	await wait(300);
	assert.equal(
		t.rec.setModels.length,
		settled,
		"and once stopped it must stay stopped",
	);
	// Parking is the right answer — but it has to be said, or a session that has quietly stopped
	// looks exactly like one that is about to do something.
	assert.ok(
		t.rec.notifies.some((message) =>
			/all accounts are cooling down\. This session will retry automatically/.test(message),
		),
		`the user must be told the session is waiting, and for how long; got: ${t.rec.notifies.join(" | ")}`,
	);
	await t.fire("session_shutdown");
});

test("one /multi-account stop is enough to end a rotation", async () => {
	const now = Date.now();
	const t = setup({
		accounts: SPENT_CODEX_FLEET,
		current: { provider: "openai-codex", id: "gpt-5.5" },
		config: { pendingPollMs: 25 },
		seedState: spentCodexFleetState(now, {
			anthropic: {
				provider: "anthropic",
				family: "anthropic",
				fetchedAt: now,
				serviceable: false,
				primary: { usedPercent: 100, resetAt: now + 5 * 60 * 60 * 1000 },
			},
		}),
	});
	await t.fire("session_start");
	await t.fire("agent_start");
	await finishError(
		t,
		"openai-codex",
		"gpt-5.5",
		"Codex error: The usage limit has been reached",
	);
	await wait(80);

	await t.command("stop");
	const atStop = t.rec.setModels.length;
	await wait(300);

	assert.equal(
		t.rec.setModels.length,
		atStop,
		`stop must take on the first attempt; ${t.rec.setModels.length - atStop} further switches happened`,
	);
	assert.equal(
		t.readState().pendingFrom,
		undefined,
		"and nothing may be left armed to restart it",
	);
	await t.fire("session_shutdown");
});

// ---------------------------------------------------------------------------
// Compaction that walked the whole fleet
//
// Also recorded: 98 consecutive compaction failures — "insufficient balance", "requires a
// subscription", "no endpoints found", "does not exist or you do not have access" — because the
// summary was offered to every account in the rotation in turn, each with the full hang bound of
// its own, while the user watched "Compacting context…".
// ---------------------------------------------------------------------------

test("a routed compaction asks a few accounts, not the whole fleet", async () => {
	const asked: string[] = [];
	const t = setup({
		accounts: {
			"openai-codex": { type: "oauth", access: "c1", refresh: "r1", accountId: "codex-1" },
			"openai-codex-account-2": { type: "oauth", access: "c2", refresh: "r2", accountId: "codex-2" },
			"openai-codex-account-3": { type: "oauth", access: "c3", refresh: "r3", accountId: "codex-3" },
			anthropic: { type: "oauth", access: "a1", refresh: "ar1" },
			"anthropic-account-2": { type: "oauth", access: "a2", refresh: "ar2" },
			openrouter: { type: "api_key", key: "or-key" },
			zai: { type: "api_key", key: "zai-key" },
		},
		current: { provider: "openai-codex", id: "gpt-5.5" },
		seedCooldownsMsFromNow: { "openai-codex": 60 * 60 * 1000 },
		compactionAuth: { ok: true, apiKey: "test-key" },
		config: { compactionWatchdogMs: 60 },
		compactFn: (_preparation, model) => {
			asked.push((model as any).provider);
			return Promise.reject(new Error("500 the server had an error"));
		},
	});

	const result = await t.fire("session_before_compact", {
		reason: "threshold",
		preparation: { messagesToSummarize: [], firstKeptEntryId: "e1", tokensBefore: 250000 },
		signal: { aborted: false },
	});

	assert.ok(
		asked.length <= 3,
		`a compaction must not walk seven accounts; it asked ${asked.length} (${asked.join(", ")})`,
	);
	assert.ok(asked.length > 0, "and it must genuinely try");
	assert.equal(result?.cancel, true, "with nothing to summarize on, it cancels rather than hangs");
	await t.fire("session_shutdown");
});

test("an account with no balance is not asked to summarize again five seconds later", async () => {
	const asked: string[] = [];
	const t = setup({
		accounts: {
			"openai-codex": { type: "oauth", access: "c1", refresh: "r1", accountId: "codex-1" },
			anthropic: { type: "oauth", access: "a1", refresh: "ar1" },
		},
		current: { provider: "openai-codex", id: "gpt-5.5" },
		seedCooldownsMsFromNow: { "openai-codex": 60 * 60 * 1000 },
		compactionAuth: { ok: true, apiKey: "test-key" },
		config: { compactionWatchdogMs: 60 },
		compactFn: (_preparation, model) => {
			asked.push((model as any).provider);
			return Promise.reject(
				new Error('401: {"type":"CreditsError","message":"Insufficient balance."}'),
			);
		},
	});
	const preparation = {
		messagesToSummarize: [],
		firstKeptEntryId: "e1",
		tokensBefore: 250000,
	};

	await t.fire("session_before_compact", {
		reason: "threshold",
		preparation,
		signal: { aborted: false },
	});
	const firstPass = [...asked];
	assert.ok(
		firstPass.includes("anthropic"),
		`the first pass must have tried it; got: ${firstPass.join(", ")}`,
	);

	asked.length = 0;
	await t.fire("session_before_compact", {
		reason: "threshold",
		preparation,
		signal: { aborted: false },
	});
	assert.equal(
		asked.includes("anthropic"),
		false,
		`an empty wallet does not refill in seconds; it was asked again: ${asked.join(", ")}`,
	);
	await t.fire("session_shutdown");
});

test("a compaction that answers through neither callback does not switch the guard off", async () => {
	// A cancelled compaction reports through `compaction_end`; `onComplete`/`onError` may never
	// fire. The in-flight flag is the only thing gating the next request, so leaving it set costs
	// the session every remaining summary — the context then grows until nothing can be sent.
	const t = setup({
		current: { provider: "openai-codex", id: "gpt-5.6-sol" },
		config: { compactionWatchdogMs: 30 },
		compactSilent: true,
	});
	t.ctx.model.contextWindow = 272_000;
	t.ctx.getSystemPrompt = () => "";

	await t.fire("context", { messages: bigConversation(50) });
	t.setIdle(true);
	await t.fire("agent_settled", {});
	assert.equal(t.rec.compacts.length, 1, "the guard asked for a summary");

	await wait(200);
	assert.ok(
		readDebugLog().some((entry) => entry.kind === "context_guard_compaction_unanswered"),
		"an unanswered compaction must be written off rather than blocking every later one",
	);
	await t.fire("session_shutdown");
});

test("a failed guard compaction clears demand and backs off before retrying", async () => {
	const t = setup({
		current: { provider: "openai-codex", id: "gpt-5.6-sol" },
		config: { compactionWatchdogMs: 30 },
		compactSilent: true,
	});
	t.ctx.model.contextWindow = 272_000;
	t.ctx.getSystemPrompt = () => "";

	await t.fire("context", { messages: bigConversation(50) });
	t.setIdle(true);
	await t.fire("agent_settled", {});
	assert.equal(t.rec.compacts.length, 1, "the guard asks once");

	// A real cancelled host compaction emits compaction_end with no result and may
	// never invoke either callback supplied to ctx.compact().
	await t.fire("compaction_end", {
		reason: "manual",
		result: undefined,
		aborted: true,
		willRetry: false,
	});
	await t.fire("context", { messages: bigConversation(50) });
	await t.fire("agent_settled", {});
	assert.equal(
		t.rec.compacts.length,
		1,
		"the next settled boundary must not immediately repeat a failed compaction",
	);
	await t.fire("session_shutdown");
});

// ---------------------------------------------------------------------------
// The governor
//
// Eight separate entries in this changelog fix the same shape: an automatic mechanism that ran
// without progress and could not be stopped. "Runaway failover loop that could freeze the
// machine", "Escape did not stop the loop", "API-key providers no longer loop forever on a dead
// key", "a session/rate limit is no longer hot-retried every second", "Compaction no longer
// leaves 'Compacting context…' spinning forever", "a refusal that cannot be classified no longer
// strands the session forever", "the stuck-resume watchdog now ACTS instead of only warning",
// and the 275-switch rotation. Every one was fixed in its own path, and the next path was
// unbounded again by default.
//
// These tests are deliberately about the INVARIANT rather than any of those paths, because a
// test per path is what has already been tried eight times.
// ---------------------------------------------------------------------------

/**
 * A fleet the size of a real one — fifteen accounts across six vendors — so a rotation always has
 * somewhere else to go and the governor is the only thing that can end the sequence.
 */
const WIDE_FLEET: Account = {
	anthropic: { type: "oauth", access: "a1", refresh: "r1" },
	"anthropic-account-2": { type: "oauth", access: "a2", refresh: "r2" },
	"openai-codex": { type: "oauth", access: "c1", refresh: "r3", accountId: "codex-1" },
	"openai-codex-account-2": { type: "oauth", access: "c2", refresh: "r4", accountId: "codex-2" },
	"openai-codex-account-3": { type: "oauth", access: "c3", refresh: "r5", accountId: "codex-3" },
	"openai-codex-account-4": { type: "oauth", access: "c4", refresh: "r7", accountId: "codex-4" },
	"openai-codex-account-5": { type: "oauth", access: "c5", refresh: "r8", accountId: "codex-5" },
	"openai-codex-account-6": { type: "oauth", access: "c6", refresh: "r9", accountId: "codex-6" },
	"openai-codex-account-7": { type: "oauth", access: "c7", refresh: "r10", accountId: "codex-7" },
	"kimi-coding": { type: "api_key", key: "k1" },
	"kimi-coding-account-2": { type: "oauth", access: "k2", refresh: "r6" },
	cursor: { type: "oauth", access: "cu", refresh: "r11" },
	openrouter: { type: "api_key", key: "or" },
	zai: { type: "api_key", key: "z" },
	minimax: { type: "api_key", key: "m" },
};

test("a session that acts and acts without a single request reaching a provider stops itself", async () => {
	const t = setup({
		accounts: WIDE_FLEET,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		// Cooldowns expire at once, so there is always another account to move to. That is the
		// shape of the bug: never out of options, never actually sending anything.
		config: { pendingPollMs: 25, cooldownMs: 1, maxAutoContinuesPerPrompt: 99 },
	});
	await t.fire("session_start");
	// One real request, so the governor knows this host reports requests at all. Without having
	// seen the signal work once it stays dormant on purpose — a safety stop that fires because it
	// cannot see is worse than the hang it was meant to prevent.
	t.beforeReq({ messages: [] });

	// Now drive failure after failure. Nothing here sends anything: the harness never emits a
	// provider request or response, which is precisely the state a spinning session is in.
	for (let i = 0; i < 20; i++) {
		await t.fire("agent_start");
		await finishError(
			t,
			t.ctx.model.provider,
			t.ctx.model.id,
			"You have hit your usage limit. Try again later.",
		);
		if (t.rec.notifies.some((message) => /has STOPPED itself/.test(message))) break;
	}

	assert.ok(
		t.rec.notifies.some((message) => /has STOPPED itself/.test(message)),
		`the session must stop itself rather than keep acting; got: ${t.rec.notifies.slice(-3).join(" | ")}`,
	);
	const stopped = readDebugLog().filter((entry) => entry.kind === "governor_stopped");
	assert.ok(stopped.length > 0, "and it must be recorded, not only shown");

	// Stopped means stopped: no timer, no queue, nothing armed to start it again.
	const settled = t.rec.setModels.length;
	await wait(250);
	assert.equal(
		t.rec.setModels.length,
		settled,
		"nothing may keep switching after the governor has stopped the session",
	);
	assert.equal(t.readState().pendingFrom, undefined, "and nothing may be left armed");
	await t.fire("session_shutdown");
});

test("stopping never eats the words the user typed", async () => {
	// A fresh prompt belongs in Pi's transcript, not in extension-owned memory. That makes the
	// message recoverable by the ordinary failed-turn handoff even if the user immediately stops
	// automation; `/multi-account stop` must not claim it consumed or returned text it never owned.
	const cooling: Record<string, number> = {};
	for (const provider of Object.keys(WIDE_FLEET)) cooling[provider] = 10 * 60 * 1000;
	const t = setup({
		accounts: WIDE_FLEET,
		// A single-slot provider on purpose: a family with a spare sibling always has one more
		// account to try, so the message would go out rather than be held.
		current: { provider: "openrouter", id: "glm-5.1" },
		config: { pendingPollMs: 25, maxAutoContinuesPerPrompt: 99 },
		seedCooldownsMsFromNow: cooling,
	});
	await t.fire("session_start");

	const input = await t.input("this sentence stays in Pi's transcript");
	assert.equal(input?.action, "continue", "Pi, not the extension, must own the message");
	assert.equal(t.rec.sent.length, 0, "the extension must not make a private copy");

	await t.command("stop");
	const stop = t.rec.notifies.at(-1) ?? "";
	assert.doesNotMatch(stop, /held .*not sent/i);
	await t.fire("session_shutdown");
});

test("a working session is never stopped by the governor", async () => {
	// The failure mode that would make this cure worse than the disease: stopping a healthy
	// session because the signals it watches were never emitted. Identical to the test above in
	// every respect but one — here the requests actually reach providers — so that difference is
	// the only thing that can explain the different outcome.
	const t = setup({
		accounts: WIDE_FLEET,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { pendingPollMs: 25, cooldownMs: 1, maxAutoContinuesPerPrompt: 99 },
	});
	await t.fire("session_start");
	await t.fire("agent_start");

	for (let i = 0; i < 20; i++) {
		await t.fire("agent_start");
		// A real request goes out for each attempt, exactly as it would on a live host.
		t.beforeReq({ messages: [] });
		await finishError(
			t,
			t.ctx.model.provider,
			t.ctx.model.id,
			"You have hit your usage limit. Try again later.",
		);
	}

	assert.equal(
		t.rec.notifies.some((message) => /has STOPPED itself/.test(message)),
		false,
		`a session whose requests are reaching providers must never be stopped: ${t.rec.notifies.slice(-2).join(" | ")}`,
	);
	await t.fire("session_shutdown");
});

test("the governor stays dormant on a host that never reports requests", async () => {
	// Old and unusual Pi builds may emit neither hook. There, "no request was observed" means
	// "we cannot observe requests", and acting on it would break sessions that are perfectly fine.
	const t = setup({
		accounts: WIDE_FLEET,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { pendingPollMs: 25, cooldownMs: 1, maxAutoContinuesPerPrompt: 99 },
	});
	await t.fire("session_start");
	// Deliberately no beforeReq(): this host never tells us a request happened.

	for (let i = 0; i < 20; i++) {
		await t.fire("agent_start");
		await finishError(
			t,
			t.ctx.model.provider,
			t.ctx.model.id,
			"You have hit your usage limit. Try again later.",
		);
	}

	assert.equal(
		t.rec.notifies.some((message) => /has STOPPED itself/.test(message)),
		false,
		"an invariant that cannot see its own signal must not act on it",
	);
	await t.fire("session_shutdown");
});

test("a user message re-enables everything the governor stopped", async () => {
	const t = setup({
		accounts: WIDE_FLEET,
		current: { provider: "anthropic", id: "claude-opus-4-8" },
		config: { pendingPollMs: 25, cooldownMs: 1, maxAutoContinuesPerPrompt: 99 },
	});
	await t.fire("session_start");
	t.beforeReq({ messages: [] });
	for (let i = 0; i < 20; i++) {
		await t.fire("agent_start");
		await finishError(
			t,
			t.ctx.model.provider,
			t.ctx.model.id,
			"You have hit your usage limit. Try again later.",
		);
		if (t.rec.notifies.some((message) => /has STOPPED itself/.test(message))) break;
	}
	assert.ok(t.rec.notifies.some((message) => /has STOPPED itself/.test(message)));

	await t.command("status");
	assert.ok(
		t.rec.notifies.at(-1)?.includes("Governor: STOPPED"),
		`status must be able to say the session stopped itself; got: ${t.rec.notifies.at(-1)}`,
	);

	// A stop the user cannot undo is a session they have to kill. Their next message is the undo.
	await t.input("carry on then");
	await t.command("status");
	assert.ok(
		t.rec.notifies.at(-1)?.includes("Governor: running"),
		`a user message must re-enable the machinery; got: ${t.rec.notifies.at(-1)}`,
	);
	await t.fire("session_shutdown");
});

test("session_start installs the parent-owned controller provider pair", async () => {
	const t = setup({ current: { provider: "anthropic", id: "claude-opus-4-8" } });
	await t.fire("session_start");
	assert.deepEqual(Object.keys(t.ctx.controllerProvider).sort(), ["providerTransport", "routePreflight", "routeResolver"]);
	assert.equal(typeof t.ctx.controllerProvider.providerTransport.stream, "function");
	assert.equal(typeof t.ctx.controllerProvider.routePreflight, "function");
	assert.equal(typeof t.ctx.controllerProvider.routeResolver, "function");
	await t.fire("session_shutdown");
});
