import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createRecoveryArchives, RECOVERY_DETAIL } from "../recovery-archive.ts";
import { prepareNativeRecovery } from "../recovery-compaction.ts";
import { recoveryTools } from "../recovery-tools.ts";
const make = () => SessionManager.inMemory("/tmp/owned-recovery-archive");
const supported = typeof (make() as any).buildSessionProjection === "function";
function commit(session: SessionManager, archive: ReturnType<typeof createRecoveryArchives>) {
	const captured = archive.capture();
	const anchor = session.appendCustomEntry("owned-recovery-anchor", {});
	session.appendCompaction("checkpoint", anchor, 10000, { [RECOVERY_DETAIL]: captured.descriptor });
	return captured;
}

test("provisional source is not exposed; committed native references restore exact public evidence", { skip: !supported }, () => {
	const session = make();
	const id = session.appendMessage({ role: "user", content: "Original ember mapping", timestamp: 1 });
	const archive = createRecoveryArchives(() => session);
	const pending = archive.capture();
	assert.equal(archive.list().items.length, 0);
	assert.throws(() => archive.query("ember"), /unavailable/);
	archive.discard(pending.descriptor.archiveId);
	const saved = commit(session, archive);
	assert.equal(archive.query("ember").items[0].id, id);
	archive.close();
	assert.equal(archive.query("ember").archiveId, saved.descriptor.archiveId);
	assert.ok(archive.read(id).text.includes("Original ember mapping"));
	assert.throws(() => archive.read(id, 0, "foreign-archive"), /unknown_id/);
	assert.throws(() => archive.list(-1), /invalid_cursor/);
});

test("archive citations survive successive checkpoints and remain branch/session scoped", { skip: !supported }, () => {
	let session = make();
	const root = session.appendMessage({ role: "user", content: "Root fact juniper", timestamp: 1 });
	const old = session.appendMessage({ role: "user", content: "Old fact ember", timestamp: 2 });
	const archive = createRecoveryArchives(() => session);
	const first = commit(session, archive);
	session.appendMessage({ role: "user", content: "New fact ridge-7", timestamp: 3 });
	commit(session, archive);
	assert.equal(archive.list().items.length, 2);
	assert.ok(archive.read(old).text.includes("Old fact ember"));
	assert.equal(archive.query("ember", 0, first.descriptor.archiveId).items[0].id, old);
	session.branch(root);
	assert.equal(archive.list().items.length, 0);
	assert.throws(() => archive.read(old), /unknown_id/);
	session = make(); session.appendMessage({ role: "user", content: "Foreign session", timestamp: 4 });
	assert.equal(archive.list().items.length, 0);
});

test("later context edits revoke both warm and reconstructed archive access", { skip: !supported }, () => {
	const session = make() as any;
	const id = session.appendMessage({ role: "user", content: "REDACTED_PRIVATE_CONTENT", timestamp: 1 });
	const archive = createRecoveryArchives(() => session);
	commit(session, archive);
	session.appendContextEdit(id, { content: "redacted" });
	assert.throws(() => archive.query("PRIVATE"), /stale_scope/);
	archive.close();
	assert.throws(() => archive.query("PRIVATE"), /stale_scope/);
	assert.throws(() => archive.read(id), /source_unavailable/);
});

test("native omission of a later failed attempt does not revoke earlier original evidence", { skip: !supported }, () => {
	const session = make() as any;
	const id = session.appendMessage({ role: "user", content: "Original ember mapping", timestamp: 1 });
	const archive = createRecoveryArchives(() => session); commit(session, archive);
	const later = session.appendMessage({ role: "user", content: "Later retry frame", timestamp: 2 });
	session.appendContextEdit(later, null);
	assert.ok(archive.read(id).text.includes("Original ember mapping"));
	archive.close();
	assert.ok(archive.read(id).text.includes("Original ember mapping"));
	session.appendContextEdit(id, null);
	assert.throws(() => archive.read(id), /source_unavailable/);
});

test("native preparation is complete, read-only, source-cited and bounded", { skip: !supported }, async () => {
	const session = make();
	for (let i = 0; i < 20; i++) session.appendMessage({ role: "user", content: `record ${i} ${"source ".repeat(200)}`, timestamp: i });
	const archive = createRecoveryArchives(() => session), before = session.getEntries().length;
	const calls: number[] = [];
	const result = await prepareNativeRecovery({ archives: archive, getSession: () => session, isCurrent: () => true,
		model: { contextWindow: 16000 }, timeoutMs: 1000, protectedBytes: 0,
		generate: async request => { calls.push(Buffer.byteLength(JSON.stringify(request))); return { text: "Continue the owned task; reconcile uncertain operations.", stopReason: "stop", hasToolCalls: false }; } });
	assert.ok(result.passes > 1);
	assert.equal(session.getEntries().length, before, "preparation cannot commit");
	assert.equal(archive.list().items.length, 0, "preparation cannot expose a provisional archive");
	assert.ok(calls.every(bytes => bytes <= 9200));
	assert.ok(result.summary.includes(result.descriptor.archiveId));
	assert.equal(result.isCurrent(), true);
	session.appendMessage({ role: "user", content: "New owner direction", timestamp: 50 });
	assert.equal(result.isCurrent(), false);
});

test("deadline, cancelled or owner-changed preparation cannot expose a checkpoint", { skip: !supported }, async () => {
	for (const mode of ["abort", "new_input", "deadline"] as const) {
		const session = make(); session.appendMessage({ role: "user", content: "Original", timestamp: 1 });
		const archive = createRecoveryArchives(() => session), controller = new AbortController();
		await assert.rejects(prepareNativeRecovery({ archives: archive, getSession: () => session, isCurrent: () => true,
			model: { contextWindow: 16000 }, timeoutMs: mode === "deadline" ? 10 : 1000, protectedBytes: 0, signal: controller.signal,
			generate: async () => {
				if (mode === "abort") controller.abort();
				if (mode === "new_input") session.appendMessage({ role: "user", content: "Stop and do something else", timestamp: 2 });
				if (mode === "deadline") return new Promise(() => {});
				return { text: "Never publish this", stopReason: "stop", hasToolCalls: false };
			} }), /recovery:(cancelled|stale|deadline)/);
		assert.equal(archive.list().items.length, 0);
		assert.equal(session.getEntries().some(e => e.type === "compaction"), false);
	}
});

test("text preparation refuses native images instead of summarizing base64 fragments", { skip: !supported }, async () => {
	const session = make(); session.appendMessage({ role: "user", content: [{ type: "image", mimeType: "image/png", data: "AA==" }], timestamp: 1 });
	const archive = createRecoveryArchives(() => session); let calls = 0;
	await assert.rejects(prepareNativeRecovery({ archives: archive, getSession: () => session, isCurrent: () => true,
		model: { contextWindow: 16000 }, timeoutMs: 1000, protectedBytes: 0,
		generate: async () => { calls++; return { text: "wrong", stopReason: "stop", hasToolCalls: false }; } }), /multimodal_source_unsupported/);
	assert.equal(calls, 0); assert.equal(archive.list().items.length, 0);
	assert.equal(session.getEntries().some(e => e.type === "compaction"), false);
});

test("retrieval tools are bounded, read-only and observe cancellation", { skip: !supported }, async () => {
	const session = make(); session.appendMessage({ role: "user", content: "Evidence ember ".repeat(300), timestamp: 1 });
	const archive = createRecoveryArchives(() => session); commit(session, archive);
	const tools = recoveryTools(() => archive), search = tools.find(t => t.name === "ma_history_search")!;
	const result = await search.execute("owned", { query: "ember" }, undefined, undefined, {} as any);
	assert.ok(Buffer.byteLength(JSON.stringify(result)) < 8192);
	assert.ok(JSON.stringify(result).includes("ember"));
	const controller = new AbortController(); controller.abort();
	await assert.rejects(search.execute("cancelled", { query: "ember" }, controller.signal, undefined, {} as any), /abort/i);
	assert.equal(session.getEntries().filter(e => e.type === "compaction").length, 1);
});
