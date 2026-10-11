/**
 * Compaction on Cursor was a treadmill, observed end-to-end in a real session:
 *
 *   16:15:20  compaction succeeds, summary is 11 130 chars, real context ≈ 22k tokens
 *   16:16:16  next reply reports prompt_tokens = 208 080
 *   16:18:32  auto-compaction fires again; nothing left to summarize, so Pi drops the
 *             accumulated summary and writes a 2 032-char one starting "No prior history."
 *
 * Three independent defects stack up there:
 *
 * 1. The bridge keeps Cursor's own server-side conversation behind a checkpoint and replays
 *    it on every request — Pi's (now compacted) message list is ignored while that checkpoint
 *    exists. Compaction therefore shrinks nothing on the model side, and Cursor's usedTokens
 *    never falls back down.
 * 2. That usedTokens number was handed to Pi as prompt_tokens, so Pi kept seeing 200k+ over
 *    its 200k window and re-compacted on every single turn.
 * 3. Pi's own compact() forgets `previousSummary` when the history range is empty and only a
 *    split-turn prefix is left, silently destroying the accumulated summary.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	conversationStates,
	isStaleForTranscript,
	deterministicConversationId,
	deriveConversationKeyFromSessionId,
	forgetConversation,
	coverTranscript,
	recordAssistantResponse,
	type StoredConversation,
} from "../cursor/conversation-registry.ts";
import { registerSessionLifecycleHooks } from "../cursor/session-lifecycle.ts";
import { restorePreviousSummary } from "../compaction-summary.ts";

function seedConversation(sessionId: string): StoredConversation {
	const convKey = deriveConversationKeyFromSessionId(sessionId);
	const stored: StoredConversation = {
		conversationId: deterministicConversationId(convKey),
		checkpoint: new Uint8Array([1, 2, 3]),
		sessionScoped: true,
		blobStore: new Map(),
		lastAccessMs: Date.now(),
		turnsCovered: 0,
	};
	conversationStates.set(convKey, stored);
	return stored;
}

test("compaction drops the Cursor-side checkpoint so the next request is rebuilt from Pi's compacted turns", () => {
	const sessionId = "session-compaction-1";
	const convKey = deriveConversationKeyFromSessionId(sessionId);
	const before = seedConversation(sessionId);
	try {
		const idBefore = before.conversationId;

		const forgotten = forgetConversation(convKey);

		assert.equal(forgotten, true, "the stored conversation must be reported as dropped");
		assert.equal(
			conversationStates.has(convKey),
			false,
			"a surviving checkpoint makes Cursor replay the pre-compaction context",
		);
		// A fresh id matters as much as the dropped checkpoint: reusing the old conversation id
		// lets Cursor resurrect its own server-side state for that conversation.
		assert.notEqual(
			deterministicConversationId(convKey),
			idBefore,
			"the conversation id must change so Cursor starts a new server-side conversation",
		);
	} finally {
		conversationStates.delete(convKey);
	}
});

test("a second compaction of the same session keeps moving to a new conversation id", () => {
	const sessionId = "session-compaction-2";
	const convKey = deriveConversationKeyFromSessionId(sessionId);
	try {
		const ids = new Set<string>([deterministicConversationId(convKey)]);
		for (let i = 0; i < 3; i++) {
			seedConversation(sessionId);
			forgetConversation(convKey);
			ids.add(deterministicConversationId(convKey));
		}
		assert.equal(ids.size, 4, "every compaction must yield a distinct Cursor conversation");
	} finally {
		conversationStates.delete(convKey);
	}
});

test("forgetting an unknown conversation is a no-op that still advances the generation", () => {
	const convKey = deriveConversationKeyFromSessionId("session-compaction-unknown");
	const before = deterministicConversationId(convKey);
	assert.equal(forgetConversation(convKey), false);
	assert.notEqual(deterministicConversationId(convKey), before);
});

test("Pi's post-compaction event resets the Cursor conversation for that session", () => {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const reset: string[] = [];
	const pi = {
		on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
	} as never;
	const ctx = { sessionManager: { getSessionId: () => "compacted-session", getLeafId: () => "leaf" } };

	registerSessionLifecycleHooks(pi, {
		cleanupSessionState: () => {},
		resetConversationForSession: (sessionId) => reset.push(sessionId),
	});

	const handler = handlers.get("session_compact");
	assert.ok(handler, "session_compact must be subscribed, or compaction never reaches the bridge");
	handler({ type: "session_compact" }, ctx);

	assert.deepEqual(reset, ["compacted-session"]);
});

test("session cleanup still tears the session down and never resets it as a compaction", () => {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const cleaned: string[] = [];
	const reset: string[] = [];
	const pi = {
		on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
	} as never;
	const ctx = { sessionManager: { getSessionId: () => "gone", getLeafId: () => "leaf" } };

	registerSessionLifecycleHooks(pi, {
		cleanupSessionState: (sessionId) => cleaned.push(sessionId),
		resetConversationForSession: (sessionId) => reset.push(sessionId),
	});
	handlers.get("session_before_switch")?.({}, ctx);

	assert.deepEqual(cleaned, ["gone"]);
	assert.deepEqual(reset, [], "a switched-away session is cleaned, not recycled");
});

test("session shutdown only cleans session state; the process-scoped proxy survives /new", () => {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const cleaned: string[] = [];
	const pi = {
		on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
	} as never;
	const ctx = { sessionManager: { getSessionId: () => "old-session" } };

	registerSessionLifecycleHooks(pi, {
		cleanupSessionState: (sessionId) => cleaned.push(sessionId),
	});
	handlers.get("session_shutdown")?.({}, ctx);

	assert.deepEqual(cleaned, ["old-session"]);
});

test("a compaction that lost its history keeps the previous summary instead of 'No prior history.'", () => {
	// Verbatim shape of the 2 032-char summary Pi wrote at 16:18:32.
	const damaged =
		"No prior history.\n\n---\n\n**Turn Context (split turn):**\n\n## Original Request\nПродовжити імпорт.";
	const previous = "## Goal\n- Поставити на карту 5 530 проспектів\n\n## Next Steps\n1. Залити піни у хмару";

	const repaired = restorePreviousSummary(damaged, previous);

	assert.ok(
		repaired.startsWith(previous),
		"the accumulated summary must survive a compaction that had nothing new to summarize",
	);
	assert.ok(
		repaired.includes("**Turn Context (split turn):**"),
		"the turn-prefix context Pi did produce must be kept",
	);
	assert.ok(!repaired.includes("No prior history."), "the placeholder must be gone");
});

test("restorePreviousSummary leaves healthy summaries and empty inputs alone", () => {
	const healthy = "## Goal\n- ship it";
	assert.equal(restorePreviousSummary(healthy, "previous"), healthy);
	assert.equal(restorePreviousSummary("No prior history.\n\n---\n\nx", undefined), "No prior history.\n\n---\n\nx");
	assert.equal(restorePreviousSummary("No prior history.\n\n---\n\nx", "   "), "No prior history.\n\n---\n\nx");
});

test("a checkpoint that missed turns taken on another provider is not resumed", () => {
	// Rotation ran the session on Anthropic for three turns; Cursor saw none of them.
	const stored = {
		conversationId: "c", checkpoint: new Uint8Array([1]), sessionScoped: true,
		blobStore: new Map(), lastAccessMs: 0, turnsCovered: 4,
	};
	assert.equal(isStaleForTranscript(stored, 7), true, "resuming here hands the model a past with a hole in it");
});

test("normal progress — one completed turn at a time — keeps the conversation", () => {
	const stored = {
		conversationId: "c", checkpoint: new Uint8Array([1]), sessionScoped: true,
		blobStore: new Map(), lastAccessMs: 0, turnsCovered: 4,
	};
	assert.equal(isStaleForTranscript(stored, 4), false, "a tool continuation completes no turn");
	assert.equal(isStaleForTranscript(stored, 5), false, "one finished turn is the normal step");
});

test("same-turn foreign-provider work and equal-count replacement invalidate a Cursor checkpoint", () => {
	const stored = seedConversation("transcript-coverage");
	const before = [{ role: "system", content: "PROJECT_A" }, { role: "user", content: "TASK_A" }];
	coverTranscript(stored, before);
	const response = { role: "assistant", content: "DONE_1; NEXT_2" };
	recordAssistantResponse(stored, response);
	assert.equal(isStaleForTranscript(stored, [...before, response, { role: "user", content: "continue NEXT_2" }]), false);
	assert.equal(isStaleForTranscript(stored, [...before, response, { role: "assistant", content: "foreign-provider DONE_2" }]), true);
	assert.equal(isStaleForTranscript(stored, [{ role: "system", content: "PROJECT_B" }, before[1]]), true);
	assert.equal(isStaleForTranscript(stored, [...before, { ...response, content: "replacement task" }]), true);
	assert.equal(isStaleForTranscript(stored, before.slice(0, 1)), true);
});

test("known Cursor tool results retain coverage without duplicating or accepting foreign steps", () => {
	const stored = seedConversation("transcript-tool-coverage");
	const before = [{ role: "user", content: "TASK_A" }];
	coverTranscript(stored, before);
	const response = { role: "assistant", content: null, tool_calls: [{ id: "read-1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }] };
	recordAssistantResponse(stored, response);
	const result = { role: "tool", tool_call_id: "read-1", content: "DONE_1" };
	assert.equal(isStaleForTranscript(stored, [...before, response, result]), false);
	assert.equal(isStaleForTranscript(stored, [...before, response, { ...result, tool_call_id: "foreign-1" }]), true);
	assert.equal(isStaleForTranscript(stored, [...before, response, result, result]), true);
	assert.equal(isStaleForTranscript(stored, [...before, response, result, { role: "assistant", content: "foreign NEXT_2" }]), true);
});

test("with no checkpoint there is nothing to go stale", () => {
	const stored = {
		conversationId: "c", checkpoint: null, sessionScoped: true,
		blobStore: new Map(), lastAccessMs: 0, turnsCovered: 0,
	};
	assert.equal(isStaleForTranscript(stored, 99), false);
});
