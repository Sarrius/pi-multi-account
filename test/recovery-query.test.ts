import assert from "node:assert/strict";
import { test } from "node:test";
import { createRecoverySource, type RecoverySourceRecord } from "../recovery-source.ts";
const make = (records: RecoverySourceRecord[], maxReplyBytes = 1200, isCurrent = () => true) => createRecoverySource({ scopeId: "query-fixture", records, isCurrent, maxSourceBytes: 100000, maxReplyBytes });

test("keyword queries match nonadjacent terms without claiming approval or changing literal search", () => {
	const source = make([
		{ id: "mapping", role: "toolResult", kind: "original", text: "juniper uses pool ember" },
		{ id: "old", role: "toolResult", kind: "original", text: "pool ember routes to region ridge-2" },
		{ id: "new", role: "user", kind: "original", text: "For pool ember, replace the old region with ridge-7." },
	]);
	assert.equal(source.search("ember approved region").items.length, 0);
	const page = source.query("ember approved region");
	assert.deepEqual(page.items.map(x => x.id), ["new", "old", "mapping"]);
	assert.deepEqual(page.items[0].matchedTerms, ["ember", "region"]);
	assert.equal(page.items[0].excerpt.complete, true);
	assert.equal(page.items[0].role, "user");
	assert.equal("approved" in page.items[0], false);
	assert.deepEqual(source.query("region ember").items.map(x => x.id), page.items.map(x => x.id));
});

test("term repetition cannot inflate relevance and unknown words do not fabricate matches", () => {
	const source = make([{ id: "spam", role: "tool", kind: "original", text: "ember ".repeat(100) }, { id: "fact", role: "user", kind: "context_edit", text: "ember region" }]);
	const page = source.query("ember ember region");
	assert.equal(page.items[0].id, "fact");
	assert.equal(page.items[0].kind, "context_edit");
	assert.deepEqual(source.query("absentkeyword"), { items: [], nextCursor: null, totalMatches: 0 });
});

test("keyword snippets are exact source slices with explicit partial boundaries and byte-bounded pagination", () => {
	const text = '😀 "prefix" '.repeat(100) + "needle: observed receipt" + " suffix".repeat(100);
	const records: RecoverySourceRecord[] = Array.from({ length: 9 }, (_, i) => ({ id: `e${i}`, role: "tool", kind: "original", text }));
	const source = make(records, 512);let cursor: number | null = 0;const seen: string[] = [];
	while (cursor !== null) {
		const page = source.query("needle", cursor);
		assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 512);
		assert.equal(page.totalMatches, 9);
		for (const item of page.items) {
			seen.push(item.id);const excerpt = item.excerpt;
			assert.equal(excerpt.complete, false);
			assert.equal(excerpt.text, text.slice(excerpt.offset, excerpt.offset + excerpt.text.length));
			assert.ok(!/[\uDC00-\uDFFF]/.test(excerpt.text[0]));
			assert.ok(!/[\uD800-\uDBFF]/.test(excerpt.text[excerpt.text.length - 1]));
		}
		assert.ok(page.nextCursor === null || page.nextCursor > cursor);cursor = page.nextCursor;
	}
	assert.deepEqual(seen, records.map(x => x.id).reverse());
});

test("keyword matching retains original Unicode offsets across case normalization", () => {
	const text = "İ ".repeat(50) + "needle finish";
	const source = make([{ id: "unicode", role: "user", kind: "original", text }]);
	const match = source.query("NEEDLE").items[0];
	assert.equal(match.excerpt.text, text.slice(match.excerpt.offset, match.excerpt.offset + match.excerpt.text.length));
	assert.ok(match.excerpt.text.includes("needle"));
});

test("keyword queries respect snapshot ownership, close and argument bounds", () => {
	let current = true;const source = make([{ id: "e", role: "user", kind: "original", text: "needle" }], 512, () => current);
	for (const query of ["", "***", "x".repeat(257), Array.from({length:17},(_,i)=>`word${i}`).join(" ")]) assert.throws(() => source.query(query), /invalid_query/);
	for (const cursor of [-1, 2, NaN, 0.5]) assert.throws(() => source.query("needle", cursor), /invalid_cursor/);
	current = false;assert.throws(() => source.query("needle"), /stale_scope/);
	current = true;source.close();assert.throws(() => source.query("needle"), /stale_scope/);
});
