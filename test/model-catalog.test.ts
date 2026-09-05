import assert from "node:assert/strict";
import test from "node:test";
import {
	compareCodexModelStrength,
	parseCodexModelCatalog,
	rankAnthropicModelIds,
} from "../model-catalog.ts";

test("a newly released Claude flagship outranks the newest one this extension shipped with", () => {
	// The exact miss that prompted this: Pi's registry already had claude-opus-5 while the
	// extension's static list still topped out at claude-opus-4-8, so failover stayed on 4-8.
	const ranked = rankAnthropicModelIds([
		"claude-opus-4-8",
		"claude-sonnet-4-6",
		"claude-opus-5",
		"claude-haiku-4-5",
	]);
	assert.equal(ranked[0], "claude-opus-5");
});

test("Fable is an apex Anthropic line above Opus and ranks newest-first", () => {
	assert.deepEqual(
		rankAnthropicModelIds([
			"claude-opus-5",
			"claude-fable-5",
			"claude-fable-5-1",
			"claude-sonnet-5",
		]),
		[
			"claude-fable-5-1",
			"claude-fable-5",
			"claude-opus-5",
			"claude-sonnet-5",
		],
	);
});

test("Claude ordering is tier-first, then generation", () => {
	assert.deepEqual(
		rankAnthropicModelIds([
			"claude-haiku-4-5",
			"claude-sonnet-4-5",
			"claude-opus-4-5",
			"claude-sonnet-4-6",
			"claude-opus-4-8",
		]),
		[
			"claude-opus-4-8",
			"claude-opus-4-5",
			"claude-sonnet-4-6",
			"claude-sonnet-4-5",
			"claude-haiku-4-5",
		],
	);
});

test("an unreleased future Claude generation ranks without an extension release", () => {
	const ranked = rankAnthropicModelIds([
		"claude-opus-5",
		"claude-opus-6",
		"claude-opus-5-2",
	]);
	assert.deepEqual(ranked, ["claude-opus-6", "claude-opus-5-2", "claude-opus-5"]);
});

test("dated Claude aliases and non-Claude ids never pollute the ranking", () => {
	assert.deepEqual(
		rankAnthropicModelIds([
			"claude-opus-4-5-20251101",
			"claude-opus-4-5",
			"gpt-5.5",
			"",
		]),
		["claude-opus-4-5"],
	);
});

test("live Codex catalog follows server priority: Sol beats Terra and Luna", () => {
	const models = parseCodexModelCatalog({
		models: [
			{
				slug: "gpt-5.6-luna",
				display_name: "5.6 Luna",
				visibility: "list",
				priority: 30,
				supported_reasoning_levels: [{ effort: "high" }, { effort: "xhigh" }],
				context_window: 272_000,
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
				input_modalities: ["text", "image"],
			},
			{
				slug: "gpt-5.6-terra",
				display_name: "5.6 Terra",
				visibility: "list",
				priority: 20,
				supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }],
			},
			{
				slug: "retired-hidden-model",
				display_name: "Hidden",
				visibility: "hide",
				priority: 0,
			},
		],
	});

	assert.deepEqual(
		models.map((model) => model.id),
		["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
	);
	assert.equal(models[0].thinkingLevelMap?.xhigh, "xhigh");
	assert.equal(models[0].thinkingLevelMap?.minimal, "low");
	assert.deepEqual(models[0].input, ["text", "image"]);
});

test("GPT-6 Astra catalog metadata keeps its native limits, modalities, and all advertised effort levels", () => {
	const models = parseCodexModelCatalog({ models: [{
		slug: "gpt-6-astra",
		display_name: "GPT-6 Astra",
		visibility: "list",
		priority: 1,
		supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"],
		input_modalities: ["text", "image"],
		context_window: 272_000,
		max_output_tokens: 128_000,
	}] });
	assert.equal(models.length, 1);
	assert.deepEqual(models[0], {
		id: "gpt-6-astra",
		name: "GPT-6 Astra",
		reasoning: true,
		thinkingLevelMap: { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
		priority: 1,
	});
	const ranked = [{ id: "gpt-5.6-sol" }, { id: "gpt-6-astra" }];
	ranked.sort(compareCodexModelStrength);
	assert.deepEqual(ranked.map((model) => model.id), ["gpt-6-astra", "gpt-5.6-sol"]);
});

test("unknown future Codex generations rank without an extension release", () => {
	const ids = [
		"gpt-5.6-sol",
		"gpt-5.7-luna",
		"gpt-5.7-sol",
		"gpt-5.7-mini",
	].map((id) => ({ id }));
	ids.sort(compareCodexModelStrength);
	assert.deepEqual(
		ids.map((model) => model.id),
		["gpt-5.7-sol", "gpt-5.7-luna", "gpt-5.7-mini", "gpt-5.6-sol"],
	);
});

test("a model that advertises max gets max — and one that does not, does not", () => {
	// Issue #15: Pi understands `max` (ThinkingLevel includes it and `--thinking max` works), but
	// the extension's known-levels list stopped at `xhigh`, so the strongest level of a model that
	// offers it was silently filtered out.
	//
	// The list is a FILTER, never a grant. Provider gradations differ wildly and do not nest —
	// Claude Opus 4.6 advertises `max` alone, glm-5.2 has `max` but no `xhigh`, gpt-5.6 has
	// `max`/`xhigh`/`minimal` but no `medium` — so what a given model gets must come from that
	// model's own advertised efforts, never from the list.
	const models = parseCodexModelCatalog({
		models: [
			{
				slug: "advertises-max",
				display_name: "Advertises Max",
				visibility: "list",
				priority: 30,
				supported_reasoning_levels: [
					{ effort: "minimal" },
					{ effort: "xhigh" },
					{ effort: "max" },
				],
			},
			{
				slug: "no-max",
				display_name: "No Max",
				visibility: "list",
				priority: 20,
				supported_reasoning_levels: [
					{ effort: "medium" },
					{ effort: "high" },
					{ effort: "xhigh" },
				],
			},
		],
	});
	const withMax = models.find((model) => model.id === "advertises-max");
	const withoutMax = models.find((model) => model.id === "no-max");

	assert.equal(
		withMax?.thinkingLevelMap?.max,
		"max",
		"a model that advertises max must be offered max",
	);
	assert.equal(
		withoutMax?.thinkingLevelMap?.max,
		undefined,
		"a model that never advertised max must NOT be given it — the list filters, it does not grant",
	);
	// The gradations that model actually claimed are untouched.
	assert.equal(withoutMax?.thinkingLevelMap?.xhigh, "xhigh");
	assert.equal(withoutMax?.thinkingLevelMap?.high, "high");
	// And a model that never claimed `medium` does not acquire it either.
	assert.equal(withMax?.thinkingLevelMap?.medium, undefined);
});

test("fetchOllamaCloudCatalog parses the /v1/models data array into canonical ids", async () => {
	const { fetchOllamaCloudCatalog } = await import("../model-catalog.ts");
	const calls: string[] = [];
	const fakeFetch = (async (url: any, init: any) => {
		calls.push(String(url));
		return {
			ok: true,
			status: 200,
			json: async () => ({
				object: "list",
				data: [
					{ id: "kimi-k3", object: "model", owned_by: "ollama" },
					{ id: "glm-5.2", object: "model", owned_by: "ollama" },
					{ id: "kimi-k2.7-code", object: "model", owned_by: "ollama" },
				],
			}),
		} as any;
	}) as any;
	const ids = await fetchOllamaCloudCatalog("test-key", { fetchImpl: fakeFetch });
	assert.deepEqual(ids, ["kimi-k3", "glm-5.2", "kimi-k2.7-code"]);
	assert.equal(calls[0], "https://ollama.com/v1/models");
});

test("fetchOllamaCloudCatalog throws on HTTP error", async () => {
	const { fetchOllamaCloudCatalog } = await import("../model-catalog.ts");
	const fakeFetch = (async () => ({
		ok: false,
		status: 401,
		json: async () => ({}),
	}) as any);
	await assert.rejects(
		() => fetchOllamaCloudCatalog("test-key", { fetchImpl: fakeFetch }),
		/HTTP 401/,
	);
});

test("fetchOllamaCloudCatalog throws on empty catalog", async () => {
	const { fetchOllamaCloudCatalog } = await import("../model-catalog.ts");
	const fakeFetch = (async () => ({
		ok: true,
		status: 200,
		json: async () => ({ object: "list", data: [] }),
	}) as any);
	await assert.rejects(
		() => fetchOllamaCloudCatalog("test-key", { fetchImpl: fakeFetch }),
		/no models/,
	);
});
