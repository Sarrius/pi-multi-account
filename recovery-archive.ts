import { createHash } from "node:crypto";
import { captureRecoverySource, type RecoveryProjectionSession } from "./recovery-session.ts";

export type RecoveryArchive = ReturnType<typeof captureRecoverySource>;
export interface RecoveryArchiveDescriptor {
	version: 1;
	archiveId: string;
	sessionId: string;
	fileHash: string;
	leafId: string;
	sourceHash: string;
}
export const RECOVERY_DETAIL = "multiAccountRecovery";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fileHash = (session: RecoveryProjectionSession) => hash(session.getSessionFile?.() ?? null);
function metadata(source: RecoveryArchive) {
	const items: ReturnType<RecoveryArchive["list"]>["items"] = [];
	let cursor: number | null = 0;
	do { const page = source.list(cursor); items.push(...page.items); cursor = page.nextCursor; } while (cursor !== null);
	return items;
}
function valid(value: unknown): value is RecoveryArchiveDescriptor {
	if (!value || typeof value !== "object") return false;
	const d = value as RecoveryArchiveDescriptor;
	return d.version === 1 && typeof d.sessionId === "string" && typeof d.leafId === "string" &&
		[d.archiveId, d.fileHash, d.sourceHash].every(x => typeof x === "string" && /^[a-f0-9]{64}$/.test(x)) &&
		d.archiveId === hash({ version: d.version, sessionId: d.sessionId, fileHash: d.fileHash, leafId: d.leafId, sourceHash: d.sourceHash });
}
/** Native journal references, not a duplicate transcript database. A descriptor
 * is only discoverable after a compaction referencing it is on the active branch.
 * Restoring never resumes work and never reads another branch or raw private data.
 */
export function createRecoveryArchives(getSession: () => RecoveryProjectionSession) {
	const cache = new Map<string, RecoveryArchive>();
	const provisional = new Set<string>();
	const trimCache = () => {
		// Keep only two reconstructable committed views, plus the in-flight source.
		while ([...cache.keys()].filter(id => !provisional.has(id)).length > 2) {
			const id = [...cache.keys()].find(id => !provisional.has(id))!;
			cache.get(id)?.close(); cache.delete(id);
		}
	};
	const limits = { maxSourceBytes: 32 * 1024 * 1024, maxReplyBytes: 2048 };
	const descriptors = () => {
		const session = getSession(), branch = session.getBranch();
		const found: RecoveryArchiveDescriptor[] = [];
		for (const entry of branch) {
			if (entry.type !== "compaction") continue;
			const d = (entry as unknown as { details?: Record<string, unknown> }).details?.[RECOVERY_DETAIL];
			if (valid(d) && d.sessionId === session.getSessionId() && d.fileHash === fileHash(session) &&
				branch.slice(0, branch.indexOf(entry)).some(e => e.id === d.leafId) && !found.some(x => x.archiveId === d.archiveId)) found.push(d);
		}
		return found.reverse();
	};
	const open = (id?: string) => {
		const d = descriptors().find(d => id === undefined || d.archiveId === id);
		if (!d) throw new Error("recovery_archive:unavailable");
		let source = cache.get(d.archiveId);
		if (!source) {
			source = captureRecoverySource(getSession, { ...limits, atLeafId: d.leafId });
			if (hash(metadata(source)) !== d.sourceHash) { source.close(); throw new Error("recovery_archive:projection_changed"); }
			cache.set(d.archiveId, source);
		}
		provisional.delete(d.archiveId);
		cache.delete(d.archiveId); cache.set(d.archiveId, source); trimCache();
		source.list(0); // A cache hit is not permission to read a stale/closed view.
		return { source, descriptor: d };
	};
	return {
		capture() {
			const session = getSession(), leafId = session.getLeafId();
			if (!leafId) throw new Error("recovery_archive:empty_branch");
			const source = captureRecoverySource(getSession, limits);
			const base = { version: 1 as const, sessionId: session.getSessionId(), fileHash: fileHash(session), leafId, sourceHash: hash(metadata(source)) };
			const descriptor = { ...base, archiveId: hash(base) };
			// Provisional views are not exposed by open(): only committed descriptors are.
			cache.get(descriptor.archiveId)?.close();
			provisional.add(descriptor.archiveId);
			cache.set(descriptor.archiveId, source); trimCache();
			return { source, descriptor };
		},
		list(cursor = 0) {
			const all = descriptors();
			if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > all.length) throw new Error("recovery_archive:invalid_cursor");
			const items = all.slice(cursor, cursor + 8).map(d => ({ archiveId: d.archiveId }));
			return { items, nextCursor: cursor + items.length < all.length ? cursor + items.length : null };
		},
		query(query: string, cursor = 0, archiveId?: string) {
			const { source, descriptor } = open(archiveId);
			return { archiveId: descriptor.archiveId, ...source.query(query, cursor) };
		},
		read(id: string, offset = 0, archiveId?: string) {
			if (typeof id !== "string" || !id || id.length > 256) throw new Error("recovery_archive:invalid_id");
			// Citations can refer to an earlier checkpoint's archive. Do not replace an
			// unavailable archive with raw journal access or silently hide the failure.
			const available = descriptors().filter(d => archiveId === undefined || d.archiveId === archiveId);
			let unavailable = false;
			for (const d of available) {
				let source: RecoveryArchive;
				try { source = open(d.archiveId).source; } catch { unavailable = true; continue; }
				const item = metadata(source).find(item => item.id === id);
				if (item) return { archiveId: d.archiveId, ...source.read(item.handle, offset) };
			}
			throw new Error(unavailable ? "recovery_archive:source_unavailable" : "recovery_archive:unknown_id");
		},
		committed(archiveId: string) { provisional.delete(archiveId); trimCache(); },
		discard(archiveId: string) { cache.get(archiveId)?.close(); cache.delete(archiveId); provisional.delete(archiveId); },
		close() { for (const source of cache.values()) source.close(); cache.clear(); provisional.clear(); },
	};
}
