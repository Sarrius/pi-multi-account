export type CodexCatalogCredential = {
	type?: string;
	access?: string;
	accountId?: string;
};

export type CodexCatalogModel = {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	/** OpenAI's lower-is-better catalog priority. Missing on models learned from Pi itself. */
	priority?: number;
};

export type CodexCatalogSnapshot = {
	fetchedAt: number;
	models: CodexCatalogModel[];
};

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEFAULT_CONTEXT_WINDOW = 272_000;
const DEFAULT_MAX_TOKENS = 128_000;
// Levels Pi itself understands, weakest → strongest. This is a FILTER, not a grant: a model's
// own advertised efforts are intersected with this list (see thinkingLevelMap), so a level named
// here only ever reaches a model that asked for it. Provider gradations differ wildly and do not
// nest — Claude Opus 4.6 advertises `max` alone, glm-5.2 has `max` but no `xhigh`, gpt-5.6 has
// `max`/`xhigh`/`minimal` but no `medium` — which is exactly why the per-model intersection, not
// this list, decides what a given model gets.
const KNOWN_PI_THINKING_LEVELS = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

function record(value: unknown): Record<string, any> {
	return value && typeof value === "object" ? (value as Record<string, any>) : {};
}

function positiveInteger(value: unknown, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function reasoningEfforts(source: Record<string, any>): string[] {
	const raw = source.supported_reasoning_levels ?? source.supported_reasoning_efforts;
	if (!Array.isArray(raw)) return [];
	return raw
		.map((item) => {
			if (typeof item === "string") return item;
			const value = record(item).effort ?? record(item).level;
			return typeof value === "string" ? value : undefined;
		})
		.filter((value): value is string => !!value);
}

function thinkingLevelMap(efforts: string[]): Record<string, string | null> | undefined {
	if (efforts.length === 0) return undefined;
	const supported = new Set(efforts);
	const result: Record<string, string | null> = {};
	for (const level of KNOWN_PI_THINKING_LEVELS) {
		if (supported.has(level)) result[level] = level;
	}
	// Pi has a `minimal` setting while some Codex catalogs begin at `low`.
	if (!("minimal" in result) && supported.has("low")) result.minimal = "low";
	return Object.keys(result).length > 0 ? result : undefined;
}

function versionParts(id: string): number[] {
	const match = id.match(/(?:^|[-_])(?:gpt[-_]?)?(\d+)(?:\.(\d+))?(?:\.(\d+))?/i);
	return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : [0, 0, 0];
}

function variantPower(id: string): number {
	const lower = id.toLowerCase();
	if (/(?:^|[-_])sol(?:$|[-_])/.test(lower)) return 100;
	if (/(?:^|[-_])max(?:$|[-_])/.test(lower)) return 95;
	if (/(?:^|[-_])terra(?:$|[-_])/.test(lower)) return 75;
	if (/(?:^|[-_])luna(?:$|[-_])/.test(lower)) return 50;
	if (/(?:^|[-_])mini(?:$|[-_])/.test(lower)) return 30;
	if (/(?:^|[-_])spark(?:$|[-_])/.test(lower)) return 20;
	if (/(?:^|[-_])nano(?:$|[-_])/.test(lower)) return 10;
	return 85;
}

/**
 * Strongest-first fallback ordering when a provider catalog does not carry priorities.
 * Server priority always wins when both models came from the live OpenAI catalog.
 */
export function compareCodexModelStrength(
	a: Pick<CodexCatalogModel, "id" | "priority">,
	b: Pick<CodexCatalogModel, "id" | "priority">,
): number {
	if (a.priority !== undefined && b.priority !== undefined && a.priority !== b.priority) {
		return a.priority - b.priority;
	}
	if (a.priority !== undefined && b.priority === undefined) return -1;
	if (a.priority === undefined && b.priority !== undefined) return 1;
	const av = versionParts(a.id);
	const bv = versionParts(b.id);
	for (let i = 0; i < Math.max(av.length, bv.length); i++) {
		if ((av[i] ?? 0) !== (bv[i] ?? 0)) return (bv[i] ?? 0) - (av[i] ?? 0);
	}
	const variant = variantPower(b.id) - variantPower(a.id);
	return variant || a.id.localeCompare(b.id);
}

/** Anthropic ships dated aliases (`claude-opus-4-5-20251101`) beside the rolling id. */
function isDatedAnthropicAlias(id: string): boolean {
	return /-\d{8}$/.test(id);
}

function anthropicTierRank(id: string): number {
	const lower = id.toLowerCase();
	if (lower.includes("opus")) return 3;
	if (lower.includes("sonnet")) return 2;
	if (lower.includes("haiku")) return 1;
	return 0;
}

/** Numeric generation parts after the tier: `claude-opus-4-8` -> [4,8], `claude-opus-5` -> [5]. */
function anthropicVersionParts(id: string): number[] {
	const tail = id.toLowerCase().replace(/^.*?(opus|sonnet|haiku)/, "");
	return (tail.match(/\d+/g) ?? [])
		.map(Number)
		.filter((n) => Number.isFinite(n) && n < 100_000);
}

/**
 * Strongest-first ordering for Anthropic model ids, so a newly released flagship (e.g.
 * `claude-opus-5` arriving in Pi's registry) outranks the newest id this extension happened to
 * be released with — the same release-per-model treadmill that was removed for Codex.
 *
 * Tier dominates version: Anthropic's flagship line is Opus, and the project's hard rule is to
 * stay on a provider's top model. Within a tier, the higher generation wins.
 */
export function compareAnthropicModelStrength(a: string, b: string): number {
	const tier = anthropicTierRank(b) - anthropicTierRank(a);
	if (tier !== 0) return tier;
	const av = anthropicVersionParts(a);
	const bv = anthropicVersionParts(b);
	for (let i = 0; i < Math.max(av.length, bv.length); i++) {
		if ((av[i] ?? 0) !== (bv[i] ?? 0)) return (bv[i] ?? 0) - (av[i] ?? 0);
	}
	// Prefer the rolling id over its dated alias so the list is not doubled up.
	const dated = Number(isDatedAnthropicAlias(a)) - Number(isDatedAnthropicAlias(b));
	return dated || a.localeCompare(b);
}

/** Known Anthropic chat model ids, strongest first, deduped and without dated aliases. */
export function rankAnthropicModelIds(ids: Iterable<string>): string[] {
	const seen = new Set<string>();
	for (const id of ids) {
		if (typeof id !== "string" || !id.trim()) continue;
		if (!/claude/i.test(id) || isDatedAnthropicAlias(id)) continue;
		seen.add(id);
	}
	return [...seen].sort(compareAnthropicModelStrength);
}

export function parseCodexModelCatalog(body: unknown): CodexCatalogModel[] {
	const source = record(body);
	const rawModels = Array.isArray(source.models)
		? source.models
		: Array.isArray(source.data)
			? source.data
			: [];
	const byId = new Map<string, CodexCatalogModel>();
	for (const raw of rawModels) {
		const model = record(raw);
		const id = model.slug ?? model.id ?? model.model;
		if (typeof id !== "string" || !id.trim()) continue;
		// The backend may retain migration-only entries but marks picker-ready models as `list`.
		if (typeof model.visibility === "string" && model.visibility.toLowerCase() !== "list") continue;
		const efforts = reasoningEfforts(model);
		const modalities = Array.isArray(model.input_modalities)
			? model.input_modalities.filter(
					(value: unknown): value is "text" | "image" => value === "text" || value === "image",
				)
			: ["text", "image"] as ("text" | "image")[];
		const priority = Number(model.priority);
		byId.set(id, {
			id,
			name:
				typeof model.display_name === "string"
					? model.display_name
					: typeof model.name === "string"
						? model.name
						: id,
			reasoning: efforts.length > 0 || !!model.default_reasoning_level,
			thinkingLevelMap: thinkingLevelMap(efforts),
			input: modalities.length > 0 ? modalities : ["text"],
			cost: ZERO_COST,
			contextWindow: positiveInteger(
				model.context_window ?? model.max_context_window,
				DEFAULT_CONTEXT_WINDOW,
			),
			maxTokens: positiveInteger(
				model.max_output_tokens ?? model.max_tokens,
				DEFAULT_MAX_TOKENS,
			),
			...(Number.isFinite(priority) ? { priority } : {}),
		});
	}
	return [...byId.values()].sort(compareCodexModelStrength);
}

function accountIdFromToken(token: string): string | undefined {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
		const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof id === "string" ? id : undefined;
	} catch {
		return undefined;
	}
}

export class CodexCatalogFetchError extends Error {
	readonly status?: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "CodexCatalogFetchError";
		this.status = status;
	}
}

export async function fetchCodexModelCatalog(
	credential: CodexCatalogCredential,
	options: {
		fetchImpl?: typeof fetch;
		timeoutMs?: number;
		clientVersion?: string;
	} = {},
): Promise<CodexCatalogModel[]> {
	if (credential.type !== "oauth" || !credential.access) {
		throw new CodexCatalogFetchError("Codex account has no OAuth access token");
	}
	const accountId = credential.accountId ?? accountIdFromToken(credential.access);
	if (!accountId) throw new CodexCatalogFetchError("Codex access token has no account id");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
	try {
		const response = await (options.fetchImpl ?? fetch)(
			`https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(options.clientVersion ?? "pi-multi-account")}`,
			{
				method: "GET",
				headers: {
					Authorization: `Bearer ${credential.access}`,
					"ChatGPT-Account-Id": accountId,
					Accept: "application/json",
					originator: "pi",
					"User-Agent": "pi-multi-account",
				},
				signal: controller.signal,
			},
		);
		if (!response.ok) {
			throw new CodexCatalogFetchError(
				`Codex model catalog returned HTTP ${response.status}`,
				response.status,
			);
		}
		const models = parseCodexModelCatalog(await response.json());
		if (models.length === 0) {
			throw new CodexCatalogFetchError("Codex model catalog returned no selectable models");
		}
		return models;
	} catch (error) {
		if (error instanceof CodexCatalogFetchError) throw error;
		if ((error as any)?.name === "AbortError") {
			throw new CodexCatalogFetchError("Codex model catalog request timed out");
		}
		throw new CodexCatalogFetchError(
			`Codex model catalog request failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		clearTimeout(timer);
	}
}
