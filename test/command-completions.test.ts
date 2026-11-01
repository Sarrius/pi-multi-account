import assert from "node:assert/strict";
import test from "node:test";
import { completeCommandArguments, type CompletionItem } from "../command-completions.ts";

const rotation = ["anthropic", "anthropic-account-2", "pi-sub-anthropic"];
const complete = (prefix: string) => completeCommandArguments(prefix, {
	rotation, invalidated: ["dead-account"], excluded: ["excluded-account", "anthropic/hidden-model"],
});
const values = (items: CompletionItem[] | null) => items?.map(item => item.value);

test("an empty prefix offers every subcommand with a description", () => {
	const items = complete("");
	assert.ok(items && items.length > 20);
	for (const item of items) assert.ok(item.description && item.description.length > 0, item.value);
	for (const name of ["status", "switch ", "priority ", "rediscover"]) assert.ok(values(items)?.includes(name), name);
});

test("a partial subcommand narrows the list", () => {
	assert.deepEqual(values(complete("sw")), ["switch "]);
	assert.deepEqual(values(complete("re"))?.sort(), ["rediscover", "reload", "remove ", "reset", "revive "]);
	assert.deepEqual(complete("zzz"), []);
});

test("switch offers the accounts in the rotation", () => {
	assert.deepEqual(values(complete("switch ")), ["switch anthropic", "switch anthropic-account-2", "switch pi-sub-anthropic"]);
	assert.deepEqual(values(complete("switch anthropic-")), ["switch anthropic-account-2"]);
	assert.equal(complete("switch anthropic")?.[0]?.label, "anthropic");
});

test("recovery completions offer excluded and invalidated targets absent from rotation", () => {
	assert.deepEqual(values(complete("exclude pi")), ["exclude pi-sub-anthropic"]);
	assert.deepEqual(values(complete("include ")), ["include excluded-account", "include anthropic/hidden-model"]);
	assert.deepEqual(values(complete("revive ")), ["revive dead-account", "revive all"]);
	assert.deepEqual(values(complete("remove anthropic")), ["remove anthropic", "remove anthropic-account-2"]);
});

test("limits and accounts offer refresh", () => {
	assert.deepEqual(values(complete("limits ")), ["limits refresh"]);
	assert.deepEqual(values(complete("accounts r")), ["accounts refresh"]);
});

test("add and remove offer the account families", () => {
	assert.deepEqual(values(complete("add ")), ["add anthropic", "add openai", "add codex", "add kimi", "add cursor", "add ollama", "add qwen"]);
	assert.deepEqual(values(complete("remove k")), ["remove kimi"]);
	assert.ok(values(complete("remove "))?.includes("remove anthropic-account-2"));
});

test("priority offers reset and none", () => {
	assert.deepEqual(values(complete("priority ")), ["priority reset", "priority none"]);
});

test("log and only-active offer on and off", () => {
	assert.deepEqual(values(complete("log ")), ["log on", "log off"]);
	assert.deepEqual(values(complete("only-active o")), ["only-active on", "only-active off"]);
});

test("aliases complete the same arguments as their subcommand", () => {
	assert.deepEqual(values(complete("use pi")), ["use pi-sub-anthropic"]);
	assert.deepEqual(values(complete("quota ")), ["quota refresh"]);
	assert.deepEqual(values(complete("rm k")), ["rm kimi"]);
});

test("nothing is offered for commands without arguments, unknown commands or extra words", () => {
	assert.equal(complete("status "), null);
	assert.equal(complete("bogus "), null);
	assert.equal(complete("switch anthropic extra"), null);
});

test("native Pi completion replaces the entire subcommand tail", async () => {
	const { CombinedAutocompleteProvider } = await import("@earendil-works/pi-tui");
	for (const name of ["multi-account", "provider-failover", "failover"]) {
		const provider = new CombinedAutocompleteProvider([{ name, description: "Accounts", getArgumentCompletions: complete }], process.cwd());
		const line = `/${name} switch anthropic-a`;
		const suggestions = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
		assert.ok(suggestions);
		const applied = provider.applyCompletion([line], 0, line.length, suggestions.items[0], suggestions.prefix);
		assert.deepEqual(applied.lines, [`/${name} switch anthropic-account-2`]);
	}
});

test("an empty rotation offers no accounts", () => {
	assert.deepEqual(completeCommandArguments("switch ", { rotation: [] }), []);
});
