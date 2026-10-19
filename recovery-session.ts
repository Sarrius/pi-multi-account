import * as host from "@earendil-works/pi-coding-agent";
import { convertToLlm, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRecoverySource, type RecoverySourceRecord } from "./recovery-source.ts";

export const recoveryProjectionSupported = typeof (host as unknown as { buildSessionProjection?: unknown }).buildSessionProjection === "function";

type ProjectionMessages = Parameters<typeof convertToLlm>[0];
/** Optional capability: older hosts must not fall back to unedited raw journal data. */
export interface RecoveryProjectionSession extends Pick<ExtensionContext["sessionManager"], "getSessionId" | "getLeafId" | "getBranch"> {
	getSessionFile?: () => string | undefined;
	buildSessionProjection?: () => { entries: readonly { sourceEntry: { id: string; type: string }; messages: ProjectionMessages }[] };
}

/** Capture public message contributions BEFORE compaction, without the truncation
 * in serializeConversation(). Runtime-only details/usage/nested calls are excluded.
 * Private thinking is explicitly marked as omitted; this is not a lossless model
 * state export. Source roles, tool call/result IDs and error flags are retained.
 * getSession must resolve the CURRENT owner, not a captured obsolete context.
 * Returned archives can survive ordinary descendant messages/compaction, but not
 * branch departure, session replacement or later edits to captured ancestry. Close explicitly
 * when no checkpoint references them. This does not itself commit or resume work.
 */
export function captureRecoverySource(
	getSession: () => RecoveryProjectionSession,
	limits: { maxSourceBytes: number; maxReplyBytes: number; atLeafId?: string },
) {
	const session = getSession();
	if (typeof session.buildSessionProjection !== "function") throw new Error("recovery_source:projection_unsupported");
	const sessionId = session.getSessionId(), currentLeaf = session.getLeafId(), leafId = limits.atLeafId ?? currentLeaf;
	const sessionFile = session.getSessionFile?.();
	if (!leafId) throw new Error("recovery_source:empty_branch");
	const activeBranch = session.getBranch();
	const position = activeBranch.findIndex(entry => entry.id === leafId);
	if (position < 0) throw new Error("recovery_source:stale_scope");
	const branch = activeBranch.slice(0, position + 1);
	const ancestry = new Set(branch.map(entry => entry.id));
	const editsCapturedAncestry = (entry: any) => entry.type === "context_edit" && (typeof entry.targetId !== "string" || ancestry.has(entry.targetId));
	if (activeBranch.slice(position + 1).some(editsCapturedAncestry)) throw new Error("recovery_source:stale_scope");
	const projector = (host as unknown as { buildSessionProjection?: (entries: typeof branch) => ReturnType<NonNullable<RecoveryProjectionSession["buildSessionProjection"]>> }).buildSessionProjection;
	if (limits.atLeafId && typeof projector !== "function") throw new Error("recovery_source:projection_unsupported");
	const projection = limits.atLeafId ? projector!(branch) : session.buildSessionProjection();
	const edits = branch.filter(entry => (entry.type as string) === "context_edit");
	const editIds = new Set(edits.map(entry => entry.id));
	const editedTargets = new Set(edits.map(entry => (entry as unknown as { targetId: string }).targetId));
	const records: RecoverySourceRecord[] = [];
	let hasImages = false;
	for (const contribution of projection.entries) {
		const messages = contribution.messages.flatMap(original => convertToLlm([original]).map(message => ({ original, message })));
		if (!messages.length) continue;
		const { id, type } = contribution.sourceEntry;
		const derived = type === "compaction" || type === "branch_summary";
		records.push({ id, role: derived ? "summary" : messages.length === 1 ? messages[0].original.role : "mixed",
			kind: derived ? "prior_summary" : editedTargets.has(id) ? "context_edit" : "original",
			text: JSON.stringify(messages.map(({ message, original }) => {
				const content = typeof message.content === "string" ? message.content : message.content.filter(block => block.type !== "thinking").map(block => {
					if (block.type === "text") return { type: block.type, text: block.text };
					if (block.type === "toolCall") {
						const publicEvidence = block as typeof block & { namespace?: string; argumentsError?: string };
						return { type: block.type, id: block.id, name: block.name, namespace: publicEvidence.namespace, arguments: block.arguments, argumentsError: publicEvidence.argumentsError };
					}
					if (block.type === "image") { hasImages = true; return { type: block.type, mimeType: block.mimeType, data: block.data }; }
					throw new Error("recovery_source:content_unsupported");
				});
				const omittedPrivateThinking = Array.isArray(message.content) ? message.content.filter(block => block.type === "thinking").length : 0;
				const system = (message.role as string) === "system" ? message as unknown as { sections?: unknown; toolsAdded?: { name: string; description: string; parameters: unknown }[]; toolsRemoved?: unknown } : undefined;
				return { role: original.role, sourceEntryType: type, content, timestamp: message.timestamp,
					...(original.role !== message.role ? { modelRole: message.role } : {}),
					...(original.role === "custom" ? { customType: original.customType } : {}),
					...(original.role === "bashExecution" ? { command: original.command, exitCode: original.exitCode, cancelled: original.cancelled, truncated: original.truncated, fullOutputPath: original.fullOutputPath } : {}),
					...(system ? { sections: system.sections, toolsAdded: system.toolsAdded?.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })), toolsRemoved: system.toolsRemoved } : {}),
					...(omittedPrivateThinking ? { omittedPrivateThinking } : {}),
					...(message.role === "toolResult" ? { toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError } : {}),
					...(message.role === "assistant" ? { stopReason: message.stopReason, errorMessage: message.errorMessage } : {}),
				};
			})),
		});
	}
	if (session.getLeafId() !== currentLeaf || getSession().getSessionId() !== sessionId || getSession().getSessionFile?.() !== sessionFile) throw new Error("recovery_source:stale_scope");
	return Object.assign(createRecoverySource({ ...limits, scopeId: `${sessionId}:${leafId}`, records,
		isCurrent() {
			const current = getSession();
			if (current.getSessionId() !== sessionId || current.getSessionFile?.() !== sessionFile) return false;
			const active = current.getBranch();
			return active.some(entry => entry.id === leafId) &&
				!active.some(entry => editsCapturedAncestry(entry) && !editIds.has(entry.id));
		},
	}), { hasImages });
}
