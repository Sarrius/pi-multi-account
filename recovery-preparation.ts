import { withCompactionSignal } from "./compaction-summary.ts";

export interface RecoverySourcePiece {
  id: string;
  role: string;
  kind: string;
  /** UTF-16 indices in the original public frame; text is never sliced here. */
  offset: number;
  text: string;
  nextOffset: number | null;
}

type MaybePromise<T> = T | PromiseLike<T>;
export interface RecoveryPreparationSource {
  list(cursor?: number): MaybePromise<{
    items: readonly { id: string; handle: string; role: string; kind: string }[];
    nextCursor: number | null;
  }>;
  read(handle: string, offset?: number): MaybePromise<RecoverySourcePiece>;
}

export interface RecoveryPreparationOptions<TRequest> {
  source: RecoveryPreparationSource;
  isCurrent: () => boolean;
  signal?: AbortSignal;
  timeoutMs: number;
  maxPasses: number;
  maxRequestBytes: number;
  maxSummaryBytes: number;
  buildRequest: (previousSummary: string, pieces: readonly RecoverySourcePiece[]) => TRequest;
  generate: (request: TRequest, signal: AbortSignal) => Promise<{
    text: string; stopReason: string; hasToolCalls: boolean;
  }>;
  validateFinal: (summary: string) => boolean;
}

/** limits: invalid numeric configuration; source: malformed/failed/empty source;
 * request_budget: builder/JSON failure or a page that cannot fit;
 * response: invalid completion; generation: generator failure.
 * All other codes name their fence/budget/validation directly. */
export type RecoveryPreparationReason = "cancelled" | "stale" | "deadline" | "limits" |
  "source" | "request_budget" | "pass_budget" | "response" | "final_validation" | "generation";
export type RecoveryPreparationResult =
  | { status: "prepared"; summary: string; passes: number; acceptedPieces: number; sourceIds: string[] }
  | { status: "blocked"; reason: RecoveryPreparationReason; passes: number; acceptedPieces: number; error?: unknown };

class Blocked extends Error {
  readonly reason: RecoveryPreparationReason;
  readonly detail?: unknown;
  constructor(reason: RecoveryPreparationReason, detail?: unknown) {
    super(reason);
    this.reason = reason;
    this.detail = detail;
  }
}
const positiveInteger = (n: number) => Number.isSafeInteger(n) && n > 0;
const index = (n: number) => Number.isSafeInteger(n) && n >= 0;
const nonempty = (s: unknown): s is string => typeof s === "string" && s.length > 0;

/** Read-only rolling preparation, NOT compaction or continuation.
 *
 * Source must be finite, immutable, authorized, and chronological. Its owner supplies
 * source/page bounds and retains ownership (including close). Memory is one list
 * page, one candidate batch, and identities for duplicate detection/coverage.
 * A greedy prefix stops at the first non-fitting candidate: no binary search or
 * monotonicity assumption, and no claim of optimal packing for arbitrary builders.
 * Entire source pages, metadata and UTF-16 offsets are passed through unchanged.
 *
 * Builders/adapters are trusted, deterministic, non-mutating serializers. Bounds
 * are UTF-8 JSON application bytes, NOT provider wire bytes or token guarantees.
 * passes counts callback invocations, not hidden retries/billing. Local settlement
 * on abort/deadline does not mean remote work was cancelled or joined. isCurrent
 * is sampled at boundaries, not polled while awaiting an uncooperative callback.
 * Synchronous callbacks cannot be preempted; their elapsed time is checked on return.
 */
export async function prepareRecoveryCheckpoint<TRequest>(
  options: RecoveryPreparationOptions<TRequest>,
): Promise<RecoveryPreparationResult> {
  const started = performance.now();
  let passes = 0, acceptedPieces = 0;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expires = Infinity;
  const cancel = () => controller.abort(options.signal?.reason);
  const fence = () => {
    if (options.signal?.aborted) throw new Blocked("cancelled");
    if (performance.now() >= expires || controller.signal.aborted) throw new Blocked("deadline");
    try {
      if (options.isCurrent() !== true) throw new Blocked("stale");
    } catch (error) {
      if (error instanceof Blocked) throw error;
      throw new Blocked("stale", error);
    }
    // isCurrent itself is a caller callback and can consume the remaining deadline.
    if (options.signal?.aborted) throw new Blocked("cancelled");
    if (performance.now() >= expires) throw new Blocked("deadline");
  };
  const invoke = <T>(reason: RecoveryPreparationReason, callback: () => T): T => {
    fence();
    try { const value = callback(); fence(); return value; }
    catch (error) { fence(); throw error instanceof Blocked ? error : new Blocked(reason, error); }
  };
  const awaitCall = async <T>(reason: RecoveryPreparationReason, callback: () => MaybePromise<T>): Promise<T> => {
    fence();
    try {
      // Attach rejection observation BEFORE checking post-callback fences. Even a
      // synchronous scope change must not strand an already-started promise.
      const pending = withCompactionSignal(Promise.resolve(callback()), controller.signal);
      void pending.catch(() => {});
      fence();
      const value = await pending;
      fence();
      return value;
    } catch (error) {
      fence();
      throw error instanceof Blocked ? error : new Blocked(reason, error);
    }
  };
  const requestBytes = (request: TRequest) => invoke("request_budget", () => {
    const json = JSON.stringify(request);
    if (typeof json !== "string") throw new Error("Request is not JSON serializable");
    return Buffer.byteLength(json, "utf8");
  });

  try {
    if (options.signal?.aborted) throw new Blocked("cancelled");
    if (![options.timeoutMs, options.maxPasses, options.maxRequestBytes, options.maxSummaryBytes].every(positiveInteger) ||
        options.timeoutMs > 2_147_483_647) throw new Blocked("limits");
    expires = started + options.timeoutMs;
    fence();
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    timer = setTimeout(() => controller.abort(), Math.max(1, expires - performance.now()));
    fence();

    type Item = { id: string; handle: string; role: string; kind: string };
    let items: readonly Item[] = [], position = 0, cursor = 0, listed = false, listDone = false;
    let active: Item | undefined, offset = 0;
    const ids = new Set<string>(), handles = new Set<string>();
    const sourceIds: string[] = [];
    const nextPiece = async (): Promise<RecoverySourcePiece | undefined> => {
      fence();
      while (!active) {
        if (position < items.length) { active = items[position++]; offset = 0; break; }
        if (listed && listDone) return undefined;
        const page = await awaitCall("source", () => options.source.list(cursor));
        invoke("source", () => {
          if (!page || !Array.isArray(page.items) ||
              (page.nextCursor !== null && (!index(page.nextCursor) || page.nextCursor <= cursor || !page.items.length))) {
            throw new Error("Malformed/non-progressing list page");
          }
          items = page.items.map(item => {
            if (!item || !nonempty(item.id) || !nonempty(item.handle) || typeof item.role !== "string" ||
                typeof item.kind !== "string" || ids.has(item.id) || handles.has(item.handle)) {
              throw new Error("Malformed/duplicate source record");
            }
            ids.add(item.id); handles.add(item.handle); sourceIds.push(item.id);
            return { id: item.id, handle: item.handle, role: item.role, kind: item.kind };
          });
          position = 0; listed = true; listDone = page.nextCursor === null;
          if (page.nextCursor !== null) cursor = page.nextCursor;
        });
      }
      const item = active;
      const page = await awaitCall("source", () => options.source.read(item.handle, offset));
      return invoke("source", () => {
        if (!page || page.id !== item.id || page.role !== item.role || page.kind !== item.kind ||
            page.offset !== offset || typeof page.text !== "string" ||
            !Number.isSafeInteger(offset + page.text.length) ||
            (page.nextOffset !== null && (!index(page.nextOffset) || page.nextOffset !== offset + page.text.length || page.nextOffset <= offset)) ||
            (!page.text.length && offset !== 0)) {
          throw new Error("Inconsistent/non-progressing source read");
        }
        const piece = Object.freeze({ id: page.id, role: page.role, kind: page.kind,
          offset: page.offset, text: page.text, nextOffset: page.nextOffset });
        if (piece.nextOffset === null) active = undefined;
        else offset = piece.nextOffset;
        return piece;
      });
    };

    let summary = "", pending: RecoverySourcePiece | undefined, exhausted = false;
    for (;;) {
      fence();
      if (passes >= options.maxPasses) throw new Blocked("pass_budget");
      const batch: RecoverySourcePiece[] = [];
      let request: TRequest | undefined;
      for (;;) {
        fence();
        const piece = pending ?? await nextPiece();
        fence();
        if (!piece) { exhausted = true; break; }
        const candidate = Object.freeze([...batch, piece]);
        const built = invoke("request_budget", () => options.buildRequest(summary, candidate));
        if (requestBytes(built) > options.maxRequestBytes) {
          pending = piece;
          if (!batch.length) throw new Blocked("request_budget");
          break;
        }
        batch.push(piece); request = built; pending = undefined;
      }
      if (!batch.length) throw new Blocked("source", new Error("Empty source"));
      // Recheck the exact selected request immediately before dispatch. No request
      // inferred from another candidate's size is ever sent.
      if (requestBytes(request as TRequest) > options.maxRequestBytes) throw new Blocked("request_budget");
      const response = await awaitCall("generation", () => {
        passes++;
        return options.generate(request as TRequest, controller.signal);
      });
      invoke("response", () => {
        if (!response || response.stopReason !== "stop" || response.hasToolCalls !== false ||
            typeof response.text !== "string" || !response.text.trim() ||
            Buffer.byteLength(response.text, "utf8") > options.maxSummaryBytes) {
          throw new Error("Invalid checkpoint response");
        }
      });
      fence();
      summary = response.text;
      acceptedPieces += batch.length;
      if (exhausted) {
        if (invoke("final_validation", () => options.validateFinal(summary)) !== true) throw new Blocked("final_validation");
        fence();
        return { status: "prepared", summary, passes, acceptedPieces, sourceIds };
      }
    }
  } catch (error) {
    const failure = error instanceof Blocked ? error : new Blocked("source", error);
    return { status: "blocked", reason: failure.reason, passes, acceptedPieces,
      ...(failure.detail === undefined ? {} : { error: failure.detail }) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    // Release our local wrappers if a post-callback fence exited before awaiting.
    // This is NOT a close/join of the caller's source or provider runtime.
    controller.abort();
  }
}
