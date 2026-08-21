import assert from "node:assert/strict";
import test from "node:test";
import {
	compareCodexModelStrength,
	parseCodexModelCatalog,
	preserveHostMaxReasoningLevel,
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
				supported_reasoning_levels: [{ effort: "high" }, { effort: "xhigh" }, { effort: "max" }],
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
	assert.equal(models[2].thinkingLevelMap?.max, "max");
	assert.deepEqual(models[0].input, ["text", "image"]);
});

test("host Codex metadata preserves max when the live catalog omits it", () => {
	const live = parseCodexModelCatalog({
		models: [
			{
				slug: "gpt-5.6-luna",
				visibility: "list",
				supported_reasoning_levels: [{ effort: "high" }, { effort: "xhigh" }],
			},
		],
	});
	const preserved = preserveHostMaxReasoningLevel(live, [
		{
			id: "gpt-5.6-luna",
			thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		},
	]);
	assert.equal(preserved[0].thinkingLevelMap?.max, "max");
});

test("explicitly reported live max metadata wins", () => {
	const models = preserveHostMaxReasoningLevel(
		[
			{
				id: "gpt-5.6-luna",
				name: "Luna",
				reasoning: true,
				thinkingLevelMap: { max: null },
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1,
				maxTokens: 1,
			},
		],
		[{ id: "gpt-5.6-luna", thinkingLevelMap: { max: "max" } }],
	);
	assert.equal(models[0].thinkingLevelMap?.max, null);
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
