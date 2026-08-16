/**
 * Regression tests for interrupted-turn preservation (the `context` hook).
 *
 * The defect these lock down: on a quota failover the turn that TRIGGERED the switch is
 * exactly the turn pi-ai refuses to replay. `transform-messages` skips every assistant
 * message with stopReason "error"/"aborted", and degrades thinking blocks to plain text
 * whenever the next request runs on a different model. The account we switch TO therefore
 * received a continuation prompt saying "do not repeat completed work" with the record of
 * that work already deleted, plus tool results left with no originating call.
 *
 * The first test proves the loss against the REAL pi-ai transform rather than a mock,
 * because an in-process mock is exactly what would not have caught this.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const { preserveInterruptedTurns, renderHandoffRecord } = (await import(
	"../index.ts"
)) as {
	preserveInterruptedTurns: (messages: any[]) => any[];
	renderHandoffRecord: (
		message: any,
		results: Map<string, any>,
	) => string | undefined;
};

/**
 * pi-ai does not re-export `transformMessages` from its package entry, so this loads the
 * module by path. Missing or moved ⇒ the integration assertion is skipped rather than
 * failing CI on an unrelated pi-ai layout change; the unit tests below still hold.
 */
async function loadPiAiTransform(): Promise<
	((messages: any[], model: any, normalize?: any) => any[]) | undefined
> {
	for (const root of [
		join(REPO_ROOT, "node_modules"),
		join(REPO_ROOT, "..", "..", "..", "..", "..", "node_modules"),
	]) {
		const file = join(
			root,
			"@earendil-works",
			"pi-ai",
			"dist",
			"api",
			"transform-messages.js",
		);
		if (!existsSync(file)) continue;
		try {
			const mod = await import(`file://${file}`);
			if (typeof mod.transformMessages === "function")
				return mod.transformMessages;
		} catch {
			// fall through to the next candidate root
		}
	}
	return undefined;
}

const DEAD_MODEL = {
	provider: "openai-codex",
	api: "openai-responses",
	id: "gpt-5.6-terra",
	input: ["text"],
};
/** The account failover moves us to: a DIFFERENT provider and model family. */
const LIVE_MODEL = {
	provider: "ollama",
	api: "openai-completions",
	id: "glm-5.2:cloud",
	input: ["text"],
};

const SECRET_REASONING =
	"The migration script must run before the seed, otherwise the seed inserts against the old schema.";
const SECRET_OUTPUT =
	"Applied migration 0042_add_orders_table; seeding is the remaining step.";

/** A transcript whose last assistant turn died on a quota error mid-tool-batch. */
function interruptedTranscript() {
	return [
		{
			role: "user",
			content: [{ type: "text", text: "Migrate the database and seed it." }],
			timestamp: 1,
		},
		{
			role: "assistant",
			provider: DEAD_MODEL.provider,
			api: DEAD_MODEL.api,
			model: DEAD_MODEL.id,
			stopReason: "error",
			errorMessage: "Codex error: The usage limit has been reached",
			usage: {},
			timestamp: 2,
			content: [
				{ type: "thinking", thinking: SECRET_REASONING },
				{ type: "text", text: SECRET_OUTPUT },
				{
					type: "toolCall",
					id: "call_migrate",
					name: "bash",
					arguments: { command: "npm run db:migrate" },
				},
				{
					type: "toolCall",
					id: "call_seed",
					name: "bash",
					arguments: { command: "npm run db:seed" },
				},
			],
		},
		{
			role: "toolResult",
			toolCallId: "call_migrate",
			toolName: "bash",
			content: [{ type: "text", text: "migration 0042 applied" }],
			timestamp: 3,
		},
	];
}

test("REAL pi-ai transform erases the interrupted turn; preservation carries it across a provider switch", async (t) => {
	const transformMessages = await loadPiAiTransform();
	if (!transformMessages) {
		t.skip("pi-ai transform-messages.js not resolvable in this install layout");
		return;
	}

	// 1. Baseline — what the next account sees today, without preservation.
	const bare = transformMessages(interruptedTranscript(), LIVE_MODEL, undefined);
	const bareText = JSON.stringify(bare);
	assert.equal(
		bare.some((m: any) => m.role === "assistant"),
		false,
		"pi-ai must be dropping the interrupted assistant message (that IS the bug)",
	);
	assert.equal(
		bareText.includes(SECRET_REASONING),
		false,
		"baseline: the reasoning of the interrupted turn is lost",
	);
	assert.equal(
		bareText.includes(SECRET_OUTPUT),
		false,
		"baseline: the output written before the interruption is lost",
	);
	assert.equal(
		bareText.includes("npm run db:seed"),
		false,
		"baseline: the tool call that never returned is lost",
	);

	// 2. With preservation, the same transform on the SWITCHED-TO model keeps everything.
	const preserved = transformMessages(
		preserveInterruptedTurns(interruptedTranscript()),
		LIVE_MODEL,
		undefined,
	);
	const preservedText = JSON.stringify(preserved);
	assert.ok(
		preservedText.includes(SECRET_REASONING),
		"reasoning of the interrupted turn must survive the switch verbatim",
	);
	assert.ok(
		preservedText.includes(SECRET_OUTPUT),
		"output written before the interruption must survive the switch verbatim",
	);
	assert.ok(
		preservedText.includes("npm run db:migrate") &&
			preservedText.includes("npm run db:seed"),
		"both tool calls, including the one that never returned, must survive",
	);
	assert.ok(
		preservedText.includes("migration 0042 applied"),
		"the tool result of the interrupted turn must survive folded into the record",
	);
	assert.equal(
		preserved.some((m: any) => m.role === "toolResult"),
		false,
		"no tool result may remain orphaned once its originating call was folded in",
	);
});

test("the handoff record marks which tool calls never returned", () => {
	const [record] = preserveInterruptedTurns(interruptedTranscript()).filter(
		(m: any) => m.role === "user" && String(m.content?.[0]?.text).includes("[handoff:"),
	);
	const text = String(record.content[0].text);
	assert.ok(
		/db:migrate[\s\S]*result: migration 0042 applied/.test(text),
		"a completed call must carry its result",
	);
	assert.ok(
		/db:seed[\s\S]*result: NONE/.test(text),
		"a call that never returned must be flagged as unknown, not silently dropped",
	);
});

test("preservation is byte-identical on replay so it never invalidates the prompt cache", () => {
	// The hook runs before EVERY request. A record that re-renders differently each time
	// would move the cache breakpoint and force a full re-read of the transcript.
	const first = JSON.stringify(preserveInterruptedTurns(interruptedTranscript()));
	const second = JSON.stringify(preserveInterruptedTurns(interruptedTranscript()));
	assert.equal(first, second);
});

test("a transcript with no interrupted turn is returned untouched", () => {
	const clean = [
		{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
		{
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "hello" }],
			timestamp: 2,
		},
	];
	assert.equal(
		preserveInterruptedTurns(clean),
		clean,
		"identity must be preserved so the hook can skip returning a result at all",
	);
});

test("an interrupted turn with nothing to preserve is left to pi's normal drop path", () => {
	// User pressed Esc before the model emitted anything: there is no work to describe,
	// and injecting an empty record would only add noise to every later request.
	const empty = [
		{ role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 },
		{ role: "assistant", stopReason: "aborted", content: [], timestamp: 2 },
	];
	assert.equal(preserveInterruptedTurns(empty), empty);
});

test("redacted thinking is not resurrected as plain text", () => {
	// Redacted blocks are opaque provider-encrypted payloads with no readable content;
	// emitting them would leak an unusable blob into every subsequent request.
	const record = renderHandoffRecord(
		{
			role: "assistant",
			stopReason: "error",
			provider: "anthropic",
			model: "claude-opus-4-8",
			content: [
				{ type: "thinking", thinking: "encrypted-blob", redacted: true },
				{ type: "text", text: "visible answer" },
			],
		},
		new Map(),
	);
	assert.ok(record && record.includes("visible answer"));
	assert.equal(record?.includes("encrypted-blob"), false);
});

test("oversized turns are clipped head+tail so failover can never blow the context window", () => {
	const huge = "A".repeat(50_000) + "TAIL_MARKER";
	const record = renderHandoffRecord(
		{
			role: "assistant",
			stopReason: "error",
			provider: "anthropic",
			model: "claude-opus-4-8",
			content: [{ type: "text", text: huge }],
		},
		new Map(),
	);
	assert.ok(record);
	assert.ok(record.length < 12_000, `record must stay bounded, got ${record.length}`);
	assert.ok(
		record.includes("TAIL_MARKER"),
		"the tail matters most: it is where the turn actually stopped",
	);
	assert.ok(record.includes("characters omitted"));
});

test("every interrupted turn in a long session is preserved, not just the last one", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "task" }], timestamp: 1 },
		{
			role: "assistant",
			stopReason: "error",
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			content: [{ type: "text", text: "FIRST_ATTEMPT" }],
			timestamp: 2,
		},
		{
			role: "assistant",
			stopReason: "error",
			provider: "anthropic",
			model: "claude-opus-4-8",
			content: [{ type: "text", text: "SECOND_ATTEMPT" }],
			timestamp: 3,
		},
	];
	const records = preserveInterruptedTurns(messages).filter(
		(m: any) =>
			m.role === "user" &&
			String(m.content?.[0]?.text ?? "").includes("[handoff:interrupted-turn]"),
	);
	assert.equal(records.length, 2, "each interrupted turn needs its own record");
	const text = JSON.stringify(records);
	assert.ok(text.includes("FIRST_ATTEMPT") && text.includes("SECOND_ATTEMPT"));
	assert.equal(
		preserveInterruptedTurns(messages).some((m: any) => m.role === "assistant"),
		false,
		"no interrupted assistant may be left for pi-ai to drop",
	);
});
