import { createHash } from "node:crypto";

/** Bounded, read-only view of an already-authorized branch projection.
 * This module never reads files or decides which journal entries are authorized.
 */
export interface RecoverySourceRecord {
	id: string;
	role: string;
	kind: "original" | "prior_summary" | "context_edit";
	text: string;
}
export interface RecoverySourceOptions {
	scopeId: string;
	records: readonly RecoverySourceRecord[];
	isCurrent: () => boolean;
	maxSourceBytes: number;
	maxReplyBytes: number;
}
export interface RecoverySourceItem {
	handle: string;
	id: string;
	role: string;
	kind: RecoverySourceRecord["kind"];
	bytes: number;
}
export interface RecoverySourceMatch extends RecoverySourceItem {
	ordinal: number;
	matchedTerms: string[];
	excerpt: { offset: number; text: string; nextOffset: number | null; complete: boolean };
}
const words = /[\p{L}\p{M}\p{N}_]+(?:-[\p{L}\p{M}\p{N}_]+)*/gu;
const normalizedWord = (text: string) => text.normalize("NFC").toLowerCase();
const unicodeBoundary = (text: string, position: number) => position > 0 && position < text.length &&
	/[\uD800-\uDBFF]/.test(text[position - 1]) && /[\uDC00-\uDFFF]/.test(text[position]) ? position - 1 : position;
export function createRecoverySource(options: RecoverySourceOptions) {
	const { scopeId, isCurrent, maxSourceBytes, maxReplyBytes } = options;
	let closed = false;
	const current = () => { if (closed || !isCurrent()) throw new Error("recovery_source:stale_scope"); };
	current();
	if (typeof scopeId !== "string" || !scopeId || scopeId.length > 256 || !Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 1 || !Number.isSafeInteger(maxReplyBytes) || maxReplyBytes < 256) throw new Error("recovery_source:invalid_limits");
	let sourceBytes = 0;
	const seen = new Set<string>();
	const records = options.records.map(({ id, role, kind, text }) => {
		if (typeof id !== "string" || !id || id.length > 256 || seen.has(id) || typeof role !== "string" || role.length > 64 || !["original", "prior_summary", "context_edit"].includes(kind) || typeof text !== "string") throw new Error("recovery_source:invalid_record");
		seen.add(id);
		const record = { id, role, kind, text };
		sourceBytes += Buffer.byteLength(JSON.stringify(record));
		if (sourceBytes > maxSourceBytes) throw new Error("recovery_source:source_budget");
		return record;
	});
	const items: RecoverySourceItem[] = records.map(record => ({
		handle: createHash("sha256").update(JSON.stringify([scopeId, record])).digest("hex"),
		id: record.id, role: record.role, kind: record.kind, bytes: Buffer.byteLength(record.text),
	}));
	const fits = (value: unknown) => Buffer.byteLength(JSON.stringify(value)) <= maxReplyBytes;
	const pageItems = (cursor = 0, matches = (_index: number) => true): { items: RecoverySourceItem[]; nextCursor: number | null } => {
		current();
		if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > items.length) throw new Error("recovery_source:invalid_cursor");
		const page: RecoverySourceItem[] = [];
		let index = cursor;
		for (; index < items.length; index++) {
			if (!matches(index)) continue;
			// Trailing nonmatches may widen the eventual cursor or turn it into null.
			const nextCursor = Math.max(1000, items.length);
			if (!fits({ items: [...page, items[index]], nextCursor })) break;
			page.push({ ...items[index] });
		}
		if (!page.length && index < items.length) throw new Error("recovery_source:reply_budget");
		return { items: page, nextCursor: index < items.length ? index : null };
	};
	return {
		close() { closed = true; records.length = 0; items.length = 0; },
		list: (cursor = 0) => pageItems(cursor),
		search(query: string, cursor = 0) {
			current();
			if (typeof query !== "string" || !query.trim() || query.length > 256) throw new Error("recovery_source:invalid_query");
			const needle = query.toLowerCase();
			return pageItems(cursor, index => records[index].text.toLowerCase().includes(needle));
		},
		/** Keyword OR retrieval, unlike literal search(). More distinct matching terms
		 * rank first, then later projection entries. Ranking is NOT approval, temporal
		 * truth or completeness. Snippets are exact, explicitly partial source slices.
		 */
		query(query: string, cursor = 0): { items: RecoverySourceMatch[]; nextCursor: number | null; totalMatches: number } {
			current();
			if (typeof query !== "string" || query.length > 256) throw new Error("recovery_source:invalid_query");
			const terms = [...new Set([...query.matchAll(words)].map(match => normalizedWord(match[0])))];
			if (!terms.length || terms.length > 16) throw new Error("recovery_source:invalid_query");
			const wanted = new Set(terms);
			const ranked: { index: number; matchedTerms: string[]; first: number }[] = [];
			for (let index = 0; index < records.length; index++) {
				const found = new Set<string>(); let first = -1;
				// Match original text: lowercasing the whole source can change UTF-16 offsets.
				for (const match of records[index].text.matchAll(words)) {
					const term = normalizedWord(match[0]);
					if (wanted.has(term)) { found.add(term); if (first < 0) first = match.index; }
				}
				if (found.size) ranked.push({ index, matchedTerms: terms.filter(term => found.has(term)), first });
			}
			ranked.sort((a, b) => b.matchedTerms.length - a.matchedTerms.length || b.index - a.index);
			if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > ranked.length) throw new Error("recovery_source:invalid_cursor");
			const page: RecoverySourceMatch[] = []; let position = cursor;
			for (; position < ranked.length; position++) {
				const hit = ranked[position], text = records[hit.index].text;
				const offset = text.length <= 384 ? 0 : unicodeBoundary(text, Math.max(0, hit.first - 96));
				const maximum = unicodeBoundary(text, Math.min(text.length, offset + 384));
				const entry = (end: number, reserve = false): RecoverySourceMatch => ({ ...items[hit.index], ordinal: hit.index, matchedTerms: hit.matchedTerms,
					excerpt: { offset, text: text.slice(offset, end), nextOffset: reserve ? Math.max(1000, text.length) : end < text.length ? end : null, complete: !reserve && offset === 0 && end === text.length },
				});
				const fitsEntry = (end: number) => fits({ items: [...page, entry(end, true)], nextCursor: Math.max(1000, ranked.length), totalMatches: ranked.length });
				let end = maximum;
				if (!fitsEntry(end)) {
					if (page.length) break;
					if (!fitsEntry(offset)) throw new Error("recovery_source:reply_budget");
					let low = offset, high = maximum; end = offset;
					while (low <= high) {
						const middle = Math.floor((low + high) / 2), boundary = unicodeBoundary(text, middle);
						if (fitsEntry(boundary)) { end = boundary; low = middle + 1; } else high = middle - 1;
					}
					if (end === offset) throw new Error("recovery_source:reply_budget");
				}
				page.push(entry(end));
			}
			current();
			return { items: page, nextCursor: position < ranked.length ? position : null, totalMatches: ranked.length };
		},
		/** Offsets are UTF-16 indices, always on Unicode code-point boundaries. */
		read(handle: string, offset = 0) {
			current();
			const index = items.findIndex(item => item.handle === handle);
			if (index < 0) throw new Error("recovery_source:unknown_handle");
			const text = records[index].text;
			const boundary = (position: number) => unicodeBoundary(text, position);
			if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length || boundary(offset) !== offset) throw new Error("recovery_source:invalid_offset");
			let low = offset, high = text.length, end = offset;
			// Reserve maximum cursor width, keeping the byte-fit predicate monotone.
			const envelope = (until: number) => ({ ...items[index], offset, text: text.slice(offset, until), nextOffset: Math.max(1000, text.length) });
			if (!fits(envelope(offset))) throw new Error("recovery_source:reply_budget");
			while (low <= high) {
				const middle = Math.floor((low + high) / 2), until = boundary(middle);
				if (fits(envelope(until))) { end = until; low = middle + 1; }
				else high = middle - 1;
			}
			if (end === offset && offset < text.length) throw new Error("recovery_source:reply_budget");
			return { ...items[index], offset, text: text.slice(offset, end), nextOffset: end < text.length ? end : null };
		},
	};
}
