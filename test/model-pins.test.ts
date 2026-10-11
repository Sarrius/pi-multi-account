import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { normalizeModelPins, persistModelPin } from "../model-pins.ts";

const require = createRequire(import.meta.url);

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "pmacct-pins-"));
	const path = join(dir, "provider-failover.json");
	writeFileSync(path, JSON.stringify({ untouched: { privateSetting: "kept" }, preferredModels: { anthropic: ["claude-opus-5"] },
		pinnedModels: { "openai-codex": "gpt-5.5", future: { unknownVersion: true } } }));
	return { dir, path, read: () => JSON.parse(readFileSync(path, "utf8")), close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("model pin normalization accepts only model IDs in valid scopes", () => {
	assert.deepEqual(normalizeModelPins({ anthropic: " claude-opus-5 ", "openai-codex": "namespace/model", "bad/scope": "model", "": "model", blank: " ", spaced: "not a model", numeric: 3 }),
		{ anthropic: "claude-opus-5", "openai-codex": "namespace/model" });
	for (const value of [undefined, null, [], "anthropic", 1]) assert.deepEqual(normalizeModelPins(value), {});
});

test("pin persistence mutates one scope and preserves latest unrelated configuration", () => {
	const t = fixture();
	try {
		assert.deepEqual(persistModelPin(t.path, "anthropic", "claude-opus-4-8"), { "openai-codex": "gpt-5.5", anthropic: "claude-opus-4-8" });
		const changed = t.read(); changed.pinnedModels.cursor = "cursor-grok-4.6"; changed.concurrentRoot = "kept";
		writeFileSync(t.path, JSON.stringify(changed));
		persistModelPin(t.path, "anthropic", "claude-opus-5");
		persistModelPin(t.path, "anthropic", undefined);
		persistModelPin(t.path, "anthropic", undefined);
		assert.deepEqual(t.read(), { ...changed, pinnedModels: { "openai-codex": "gpt-5.5", future: { unknownVersion: true }, cursor: "cursor-grok-4.6" } });
		assert.equal(statSync(t.path).mode & 0o777, 0o600);
		assert.deepEqual(readdirSync(t.dir), ["provider-failover.json"]);
	} finally { t.close(); }
});

test("pin persistence preserves corrupt config, invalid maps and invalid references", () => {
	const t = fixture();
	try {
		for (const raw of ["{invalid", "null", "[]", '{"pinnedModels":null}', '{"pinnedModels":[]}']) {
			writeFileSync(t.path, raw);
			assert.throws(() => persistModelPin(t.path, "anthropic", "claude-opus-5"));
			assert.equal(readFileSync(t.path, "utf8"), raw);
		}
		writeFileSync(t.path, "{}");
		for (const [scope, model] of [["bad/scope", "model"], ["", "model"], ["anthropic", "bad model"]]) {
			assert.throws(() => persistModelPin(t.path, scope, model));
			assert.equal(readFileSync(t.path, "utf8"), "{}");
		}
	} finally { t.close(); }
});

test("pin persistence rechecks session authority before the atomic commit", () => {
	const t = fixture();
	try {
		const before = readFileSync(t.path, "utf8");
		let checks = 0;
		assert.throws(() => persistModelPin(t.path, "anthropic", "claude-opus-5", () => ++checks < 3));
		assert.equal(readFileSync(t.path, "utf8"), before);
		assert.deepEqual(readdirSync(t.dir), ["provider-failover.json"]);
	} finally { t.close(); }
});

test("pin persistence bounds lock contention without changing the config", () => {
	const t = fixture();
	const unlock = require("proper-lockfile").lockSync(t.path, { realpath: false });
	try {
		const before = readFileSync(t.path, "utf8");
		const started = Date.now();
		assert.throws(() => persistModelPin(t.path, "anthropic", "claude-opus-5"), { code: "ELOCKED" });
		assert.ok(Date.now() - started < 2000);
		assert.equal(readFileSync(t.path, "utf8"), before);
	} finally { unlock(); t.close(); }
});

test("pin persistence preserves a user config symlink", () => {
	const t = fixture();
	try {
		const link = join(t.dir, "config-link.json"); symlinkSync(t.path, link);
		persistModelPin(link, "anthropic", "claude-opus-5");
		assert.equal(t.read().pinnedModels.anthropic, "claude-opus-5");
		assert.equal(readFileSync(link, "utf8"), readFileSync(t.path, "utf8"));
	} finally { t.close(); }
});
