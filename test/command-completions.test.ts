import assert from "node:assert/strict";
import test from "node:test";
import { completeCommandArguments, type CompletionItem } from "../command-completions.ts";

const rotation = ["anthropic", "anthropic-account-2", "pi-sub-anthropic"];
const complete = (prefix: string) => completeCommandArguments(prefix, { rotation });
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

test("exclude, include and revive offer the rotation and revive also offers all", () => {
	assert.deepEqual(values(complete("exclude pi")), ["exclude pi-sub-anthropic"]);
	assert.deepEqual(values(complete("include anthropic-a")), ["include anthropic-account-2"]);
	assert.ok(values(complete("revive "))?.includes("revive all"));
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

test("an empty rotation offers no accounts", () => {
	assert.deepEqual(completeCommandArguments("switch ", { rotation: [] }), []);
});
