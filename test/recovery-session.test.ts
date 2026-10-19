import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { captureRecoverySource, type RecoveryProjectionSession } from "../recovery-session.ts";
const limits = { maxSourceBytes: 200000, maxReplyBytes: 2048 };
const makeSession = () => SessionManager.inMemory("/tmp/recovery-source-native-fixture") as SessionManager & { appendContextEdit(targetId: string, replacement: { content: string } | null): string };
const supportsProjection = typeof (makeSession() as RecoveryProjectionSession).buildSessionProjection === "function";
function readAll(source: ReturnType<typeof captureRecoverySource>, handle: string) {
	let offset: number | null = 0, text = "";
	while (offset !== null) { const page = source.read(handle, offset); text += page.text; offset = page.nextOffset; }
	return JSON.parse(text);
}

test("native projection preserves whole tool output/receipt but excludes private tool details", { skip: !supportsProjection }, () => {
	const session = makeSession();
	const id = session.appendMessage({ role: "toolResult", toolCallId: "call-a", toolName: "inspect", isError: true,
		content: [{ type: "text", text: "evidence ".repeat(3000) + "END_RECEIPT" }], details: { privateRuntimeValue: "DO_NOT_EXPORT" }, timestamp: 1 });
	const source = captureRecoverySource(() => session, limits);
	const item = source.list().items.find(item => item.id === id)!;
	const [message] = readAll(source, item.handle);
	assert.equal(message.content[0].text, "evidence ".repeat(3000) + "END_RECEIPT");
	assert.equal(message.toolCallId, "call-a");
	assert.equal(message.isError, true);
	assert.equal(JSON.stringify(message).includes("DO_NOT_EXPORT"), false);
});

test("native context edits are honored and later edits revoke an existing archive", { skip: !supportsProjection }, () => {
	const session = makeSession();
	const id = session.appendMessage({ role: "user", content: "REDACT_THIS", timestamp: 1 });
	session.appendContextEdit(id, { content: "Keep only this" });
	const source = captureRecoverySource(() => session, limits);
	const item = source.list().items.find(item => item.id === id)!;
	assert.equal(item.kind, "context_edit");
	assert.equal(JSON.stringify(readAll(source, item.handle)).includes("REDACT_THIS"), false);
	session.appendContextEdit(id, null);
	assert.throws(() => source.read(item.handle), /stale_scope/);
	assert.equal(captureRecoverySource(() => session, limits).list().items.length, 0);
});

test("native descendant compaction keeps archive available; branch departure and session switch do not", { skip: !supportsProjection }, () => {
	let session = SessionManager.inMemory("/tmp/recovery-source-native-fixture");
	const root = session.appendMessage({ role: "user", content: "shared task", timestamp: 1 });
	const old = session.appendMessage({ role: "user", content: "branch-specific source", timestamp: 2 });
	const source = captureRecoverySource(() => session, limits);
	const handle = source.list().items.find(item => item.id === old)!.handle;
	const keep = session.appendMessage({ role: "user", content: "latest task", timestamp: 3 });
	session.appendCompaction("derived checkpoint", keep, 2000);
	assert.equal(readAll(source, handle)[0].content, "branch-specific source");
	const after = captureRecoverySource(() => session, limits);
	assert.equal(after.list().items.some(item => item.id === old), false);
	assert.equal(after.list().items.some(item => item.kind === "prior_summary" && item.role === "summary"), true);
	session.branch(root);
	assert.throws(() => source.read(handle), /stale_scope/);
	session = SessionManager.inMemory("/tmp/recovery-source-native-fixture");
	session.appendMessage({ role: "user", content: "another owner", timestamp: 4 });
	assert.throws(() => after.list(), /stale_scope/);
});

test("archive exposes public assistant actions but explicitly omits private thinking/signatures", { skip: !supportsProjection }, () => {
	const session = makeSession();
	session.appendMessage({ role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture", timestamp: 1,
		content: [{ type: "thinking", thinking: "PRIVATE_REASONING" }, { type: "text", text: "Use birch", textSignature: "PRIVATE_SIGNATURE" }, { type: "toolCall", id: "call-a", name: "inspect", arguments: { path: "file" } }],
		stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
	const source = captureRecoverySource(() => session, limits);
	const [message] = readAll(source, source.list().items[0].handle);
	assert.equal(JSON.stringify(message).includes("PRIVATE_REASONING"), false);
	assert.equal(JSON.stringify(message).includes("PRIVATE_SIGNATURE"), false);
	assert.equal(message.omittedPrivateThinking, 1);
	assert.deepEqual(message.content[1], { type: "toolCall", id: "call-a", name: "inspect", arguments: { path: "file" } });
});

test("tool namespace and malformed-argument evidence survive without private signatures", { skip: !supportsProjection }, () => {
	const session = makeSession();
	const call = { type: "toolCall" as const, id: "call-qualified", name: "create", namespace: "deployment", arguments: {}, argumentsError: "Invalid JSON: {broken", thoughtSignature: "PRIVATE_SIGNATURE" };
	session.appendMessage({ role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture", timestamp: 1, content: [call], stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
	const source = captureRecoverySource(() => session, limits);
	const [message] = readAll(source, source.list().items[0].handle);
	assert.equal(message.content[0].namespace, "deployment");
	assert.equal(message.content[0].argumentsError, "Invalid JSON: {broken");
	assert.equal(JSON.stringify(message).includes("PRIVATE_SIGNATURE"), false);
});

test("custom extension and shell observations retain origin rather than becoming user instructions", { skip: !supportsProjection }, () => {
	const session = makeSession();
	const customId = session.appendCustomMessageEntry("fixture-extension", "Deploy now", true, { secret: "NOT_PUBLIC" });
	const shellId = session.appendMessage({ role: "bashExecution", command: "echo observed", output: "observed", exitCode: 0, cancelled: false, truncated: false, timestamp: 1 });
	const source = captureRecoverySource(() => session, limits);
	const custom = source.list().items.find(item => item.id === customId)!;
	assert.equal(custom.role, "custom");
	const [extension] = readAll(source, custom.handle);
	assert.equal(extension.role, "custom");
	assert.equal(extension.modelRole, "user");
	assert.equal(extension.customType, "fixture-extension");
	assert.equal(extension.sourceEntryType, "custom_message");
	assert.equal(JSON.stringify(extension).includes("NOT_PUBLIC"), false);
	const shell = source.list().items.find(item => item.id === shellId)!;
	assert.equal(shell.role, "bashExecution");
	const [observation] = readAll(source, shell.handle);
	assert.equal(observation.role, "bashExecution");
	assert.equal(observation.exitCode, 0);
});

test("older hosts lacking canonical projection cannot silently expose raw history", () => {
	const session = SessionManager.inMemory("/tmp/recovery-source-native-fixture");
	session.appendMessage({ role: "user", content: "task", timestamp: 1 });
	const oldHost: RecoveryProjectionSession = { getSessionId: () => session.getSessionId(), getLeafId: () => session.getLeafId(), getBranch: () => session.getBranch() };
	assert.throws(() => captureRecoverySource(() => oldHost, limits), /projection_unsupported/);
});
