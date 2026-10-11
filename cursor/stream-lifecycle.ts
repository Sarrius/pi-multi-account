/**
 * Cursor's gRPC agent is not an OpenAI chat completion. This module is the
 * contract that makes one Cursor Run look like one Pi provider turn:
 *
 * - a turn ends when Cursor says so (`turnEnded`), not when the TCP stream happens
 *   to close;
 * - only user-visible tokens (text, thinking, token deltas) and Pi-bound tool
 *   calls count as forward progress for the stall watchdog;
 * - heartbeats, checkpoints, blob fetches, rejected native tools and mid-turn
 *   questions do not keep the spinner alive.
 */

export const NATIVE_TOOL_UNAVAILABLE =
	"Tool not available in this environment. Use the MCP tools provided instead.";

/**
 * Cursor often emits sibling `read`/`shell` execs as separate gRPC frames a few
 * milliseconds apart. Closing the OpenAI stream on the first one leaves the rest
 * unanswered and Pi stuck on Working. Wait this long after the last Pi-bound exec
 * so they share one `tool_calls` pause.
 */
export const TOOL_CALL_COALESCE_MS = 75;

/** `PI_CURSOR_TOOL_COALESCE_MS` overrides the window; non-positive or garbage falls back. */
export function resolveToolCallCoalesceMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PI_CURSOR_TOOL_COALESCE_MS?.trim();
	if (raw === undefined || raw === "") return TOOL_CALL_COALESCE_MS;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) return TOOL_CALL_COALESCE_MS;
	return parsed;
}

export type CursorFrameKind =
	| "heartbeat"
	| "visible"
	| "housekeeping"
	| "turnEnded"
	| "mcpExec"
	| "nativeExec"
	| "interactionQuery"
	| "execControl"
	| "unknown";

export type CursorFrameClass = {
	kind: CursorFrameKind;
	/** Reset the stall watchdog. Housekeeping must never do this. */
	countsAsProgress: boolean;
	/** Finish the OpenAI stream with stop, matching every other provider. */
	completesTurn: boolean;
};

const VISIBLE_UPDATES = new Set(["textDelta", "thinkingDelta", "tokenDelta"]);

export function classifyCursorFrame(input: {
	messageCase?: string;
	updateCase?: string;
	execCase?: string;
}): CursorFrameClass {
	const messageCase = input.messageCase;
	if (!messageCase) return { kind: "unknown", countsAsProgress: false, completesTurn: false };

	if (messageCase === "interactionUpdate") {
		const updateCase = input.updateCase;
		if (!updateCase || updateCase === "heartbeat") {
			return { kind: "heartbeat", countsAsProgress: false, completesTurn: false };
		}
		if (updateCase === "turnEnded") {
			return { kind: "turnEnded", countsAsProgress: false, completesTurn: true };
		}
		if (VISIBLE_UPDATES.has(updateCase)) {
			return { kind: "visible", countsAsProgress: true, completesTurn: false };
		}
		return { kind: "housekeeping", countsAsProgress: false, completesTurn: false };
	}

	if (messageCase === "execServerMessage") {
		if (input.execCase === "mcpArgs") {
			return { kind: "mcpExec", countsAsProgress: true, completesTurn: false };
		}
		if (input.execCase === "requestContextArgs" || input.execCase === "diagnosticsArgs") {
			return { kind: "housekeeping", countsAsProgress: false, completesTurn: false };
		}
		return { kind: "nativeExec", countsAsProgress: false, completesTurn: false };
	}

	if (messageCase === "kvServerMessage" || messageCase === "conversationCheckpointUpdate") {
		return { kind: "housekeeping", countsAsProgress: false, completesTurn: false };
	}
	if (messageCase === "interactionQuery") {
		return { kind: "interactionQuery", countsAsProgress: false, completesTurn: false };
	}
	if (messageCase === "execServerControlMessage") {
		return { kind: "execControl", countsAsProgress: false, completesTurn: false };
	}
	return { kind: "unknown", countsAsProgress: false, completesTurn: false };
}

export type NativeExecForward = {
	toolName: string;
	args: Record<string, unknown>;
	resultCase: string;
};

function quote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : String(value ?? "");
}

/**
 * Cursor's own read/shell/write tools are not a Pi sandbox. Map them onto the
 * MCP tools Pi already exposed for this turn so the model gets real results
 * instead of an infinite reject loop.
 */
export function mapNativeExecToPiTool(
	execCase: string,
	args: Record<string, unknown>,
	availableTools: Iterable<string>,
): NativeExecForward | undefined {
	const tools = availableTools instanceof Set ? availableTools : new Set(availableTools);
	const has = (name: string) => tools.has(name);
	const bash = (command: string, resultCase: string): NativeExecForward | undefined =>
		has("bash") ? { toolName: "bash", args: { command }, resultCase } : undefined;

	switch (execCase) {
		case "readArgs":
			if (has("read")) return { toolName: "read", args: { path: asString(args.path) }, resultCase: "readResult" };
			return bash(`cat -- ${quote(asString(args.path))}`, "readResult");
		case "writeArgs":
			if (has("write")) {
				return {
					toolName: "write",
					args: { path: asString(args.path), content: asString(args.fileText ?? args.content) },
					resultCase: "writeResult",
				};
			}
			return undefined;
		case "grepArgs":
			if (has("grep")) {
				const forwarded: Record<string, unknown> = { pattern: asString(args.pattern) };
				if (args.path) forwarded.path = args.path;
				if (args.glob) forwarded.glob = args.glob;
				return { toolName: "grep", args: forwarded, resultCase: "grepResult" };
			}
			return bash(
				`rg --line-number --color never ${quote(asString(args.pattern))}${args.path ? ` -- ${quote(asString(args.path))}` : ""}`,
				"grepResult",
			);
		case "lsArgs":
			if (has("ls")) return { toolName: "ls", args: { path: asString(args.path) }, resultCase: "lsResult" };
			return bash(`ls -la -- ${quote(asString(args.path))}`, "lsResult");
		case "deleteArgs":
			return bash(`rm -f -- ${quote(asString(args.path))}`, "deleteResult");
		case "shellArgs":
		case "shellStreamArgs":
			if (has("bash")) {
				return {
					toolName: "bash",
					args: {
						// Pi bash has no cwd argument. Scope the entire script so a failed
						// directory change cannot execute a later semicolon-separated write.
						command: args.workingDirectory
							? `cd -- ${quote(asString(args.workingDirectory))} && {\n${asString(args.command) || ":"}\n}`
							: asString(args.command),
					},
					resultCase: execCase === "shellStreamArgs" ? "shellStream" : "shellResult",
				};
			}
			return undefined;
		default:
			return undefined;
	}
}

export function interactionQueryResultCase(queryCase: string | undefined): string | undefined {
	switch (queryCase) {
		case "webSearchRequestQuery":
			return "webSearchRequestResponse";
		case "askQuestionInteractionQuery":
			return "askQuestionInteractionResponse";
		case "switchModeRequestQuery":
			return "switchModeRequestResponse";
		case "exaSearchRequestQuery":
			return "exaSearchRequestResponse";
		case "exaFetchRequestQuery":
			return "exaFetchRequestResponse";
		case "createPlanRequestQuery":
			return "createPlanRequestResponse";
		case "setupVmEnvironmentArgs":
			return "setupVmEnvironmentResult";
		default:
			return undefined;
	}
}
