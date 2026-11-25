/**
 * Every automatic action must go through the governor.
 *
 * This is the only test in the suite that reads the source instead of running it, and the reason
 * is in the changelog. Eight separate entries fix the same shape — an automatic mechanism that ran
 * without progress and could not be stopped — and each was fixed inside its own path: the failover
 * chain, the resume timer, the API-key retry, the session-limit retry, the compaction router, the
 * unclassified-refusal path, the stuck-turn watchdog, the rotation ping-pong. Every one of those
 * fixes was correct. None of them prevented the next one, because a new path that drives the
 * session is unbounded by default and only becomes safe if whoever adds it remembers to bound it.
 *
 * So the rule is enforced rather than remembered: there is a fixed, named set of places allowed to
 * drive the session, each one of them asks the governor first (or is listed here with the reason it
 * does not need to), and anything new fails this test until it does the same. A failure here is not
 * a broken test — it is a new way for the session to spin that has not been thought through yet.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts");

/** The calls that make something happen in the user's session. */
const ACTIONS =
	/\b(pi\.setModel|pi\.sendUserMessage|pi\.sendMessage|continueAgent|ctx\.compact)\s*\(/;

const FUNCTION = /^\t*(?:export\s+)?(?:async\s+)?function\s+(\w+)/;
const HOOK = /^\tsafeOn\(\s*"([^"]+)"/;

/**
 * Where an action is allowed to be made, and what stops it running away.
 *
 * Adding a name here is a deliberate act: it says either "this asks `allowAction` first" or
 * "this cannot loop, and here is why".
 */
const ALLOWED: Record<string, string> = {
	// Asks allowAction() itself.
	resumeWithExistingContext: "gated by allowAction('resume the interrupted turn')",
	attemptQueuedInputResume: "gated by allowAction('send a held message')",
	"on:session_compact": "gated by allowAction('carry on after compaction')",
	"on:agent_settled": "gated by allowAction('ask for a summary')",
	// User-owned input arriving during a competing automatic turn is serialized as a follow-up;
	// it is not an automatic action and must not be blocked by the governor.
	"on:input": "preserves newer owner intent by queueing it as followUp",
	// Reached only from a gated caller.
	dispatchContextGuardContinuation:
		"gated by allowAction after the context-guard compaction completion callback",
	setModelEnsuringVisible: "automatic failover and deferred unmanaged restoration are gated at their callers",
	injectContinuationPrompt:
		"only called from resumeWithExistingContext, which is gated — the fallback half of one gated action",
	// Explicitly exempt, with the reason.
	attemptPendingResume:
		"restores the SAME account so the gated resume below it can run; not a rotation, and cannot loop without that gated resume",
};

/**
 * Functions and hooks that must ASK the governor before they act.
 *
 * Separate from ALLOWED because the two say different things: ALLOWED is "a raw call may appear
 * here", this is "permission must be requested here". `activateFallback` is on this list and not
 * that one — it drives the session through a helper rather than calling the host API itself, and
 * dropping the gate there would put the rotation back exactly where it was.
 */
const GATED = [
	"activateFallback",
	"retryDeferredUnmanagedModel",
	"resumeWithExistingContext",
	"attemptQueuedInputResume",
	"on:session_compact",
	"on:agent_settled",
];

/** Source text of each named function/hook, from its declaration to the next one. */
function scopeBodies(): Map<string, string> {
	const lines = readFileSync(SOURCE, "utf8").split("\n");
	const bodies = new Map<string, string[]>();
	let scope: string | undefined;
	for (const line of lines) {
		const fn = FUNCTION.exec(line);
		const hook = HOOK.exec(line);
		if (fn) scope = fn[1];
		else if (hook) scope = `on:${hook[1]}`;
		if (!scope) continue;
		const body = bodies.get(scope) ?? [];
		body.push(line);
		bodies.set(scope, body);
	}
	return new Map([...bodies].map(([name, body]) => [name, body.join("\n")]));
}

function scan() {
	const lines = readFileSync(SOURCE, "utf8").split("\n");
	const sites: Array<{ line: number; scope: string; call: string; text: string }> = [];
	let scope = "<module>";
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const fn = FUNCTION.exec(line);
		if (fn) scope = fn[1];
		const hook = HOOK.exec(line);
		if (hook) scope = `on:${hook[1]}`;
		const trimmed = line.trim();
		// Prose, not code: comments and the capability notices that quote these API names.
		if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("`"))
			continue;
		const call = ACTIONS.exec(line);
		if (call) sites.push({ line: i + 1, scope, call: call[1], text: trimmed.slice(0, 80) });
	}
	return sites;
}

test("nothing drives the session from outside the governed set", () => {
	const rogue = scan().filter((site) => !(site.scope in ALLOWED));
	assert.deepEqual(
		rogue.map((site) => `${site.call} at index.ts:${site.line} in ${site.scope}`),
		[],
		"a new place is driving the session. Route it through allowAction(), or add it to ALLOWED " +
			"in this file with the reason it cannot loop. Do not delete this assertion.",
	);
});

test("every allowed site still exists, so the list cannot rot into a rubber stamp", () => {
	const scopes = new Set(scan().map((site) => site.scope));
	const stale = Object.keys(ALLOWED).filter((name) => !scopes.has(name));
	assert.deepEqual(
		stale,
		[],
		"these names no longer drive the session; drop them from ALLOWED so the list keeps meaning something",
	);
});

test("every path that drives the session still asks the governor first", () => {
	const bodies = scopeBodies();
	const ungoverned = GATED.filter((name) => !(bodies.get(name) ?? "").includes("allowAction("));
	assert.deepEqual(
		ungoverned,
		[],
		"these no longer ask permission before acting, so nothing bounds them any more",
	);
});

test("the governor's own gate is still wired to every gated site", () => {
	const source = readFileSync(SOURCE, "utf8");
	// The gate has to exist and has to be the thing that returns false when the session has
	// stopped; a governor that always says yes would pass every other test in this suite.
	assert.match(
		source,
		/function allowAction\([^)]*\)[^{]*\{\s*\n\s*if \(governorStopped\(\)\) return false;/,
		"allowAction must refuse once the governor has stopped the session",
	);
	const gated = source.match(/allowAction\(\s*"/g) ?? [];
	assert.ok(
		gated.length >= 5,
		`expected every driving path to ask the governor; found ${gated.length} call sites`,
	);
});
