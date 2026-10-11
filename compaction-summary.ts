/**
 * Guard against Pi throwing away an accumulated compaction summary.
 *
 * Pi's `compact()` has a branch for "the cut fell inside a turn": it summarizes the history
 * range, summarizes the turn prefix, and glues them together. When the history range is empty —
 * which is exactly what happens when a second compaction fires minutes after the first — that
 * branch substitutes the literal string "No prior history." and never passes `previousSummary`
 * to the model at all. The new compaction entry then replaces the accumulated summary with a
 * note about one truncated turn, and everything the session had learned is gone.
 *
 * Seen in a real session: an 11 130-char summary became 2 032 chars beginning "No prior history."
 * and describing work from a different day.
 *
 * We intercept compaction anyway (to route it to a healthy account), so the repair goes here:
 * put the previous summary back where the placeholder is, keeping the turn-prefix context Pi
 * did manage to produce.
 */

/** Access verification and content-policy refusals must not cause automatic account hopping.
 * A verification outage is not proof of expired OAuth or permanent missing entitlement.
 */
export function compactionAccessFailure(error: unknown): "policy" | "access_verification" | undefined {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/this content was flagged for possible cybersecurity risk/i.test(text)) return "policy";
  if (/unable to verify daybreak(?: blue)? access/i.test(text)) return "access_verification";
  return undefined;
}

export const COMPACTION_ACCESS_RETRY_DELAYS_MS = [2000, 4000] as const;

/** Stop awaiting a cancelled read-only summary/auth lookup, even if it ignores
 * its signal. Observe late rejection; settlement is not proof of remote cleanup. */
export function withCompactionSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason ?? new DOMException("Compaction aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(value => {
      if (settled) return;
      settled = true; cleanup(); resolve(value);
    }, error => {
      if (settled) return;
      settled = true; cleanup(); reject(error);
    });
    if (signal.aborted) onAbort();
  });
}

/** Routed helpers do not inherit the host's native retry policy. Retry only this
 * known temporary verification failure, on the identical captured model/auth/input.
 * The caller's existing timeout is the whole budget; policy refusals are terminal.
 */
export async function retryCompactionAccessVerification<T>(
  produce: () => Promise<T>,
  options: {signal?: AbortSignal; delaysMs?: readonly number[]; onRetry?: (attempt:number,delayMs:number,error:unknown)=>void} = {},
): Promise<T> {
  const delays=(options.delaysMs??COMPACTION_ACCESS_RETRY_DELAYS_MS).slice(0,2);
  for(let attempt=0;;attempt++) {
    if(options.signal?.aborted)throw new DOMException("Compaction aborted","AbortError");
    try{return await produce();}catch(error){
      if(compactionAccessFailure(error)!=="access_verification"||attempt>=delays.length)throw error;
      const delayMs=Math.min(30_000,Math.max(0,delays[attempt]));
      options.onRetry?.(attempt+1,delayMs,error);
      await new Promise<void>((resolve,reject)=>{
        const signal=options.signal;
        const finish=(aborted:boolean)=>{clearTimeout(timer);signal?.removeEventListener("abort",onAbort);aborted?reject(new DOMException("Compaction aborted","AbortError")):resolve();};
        const onAbort=()=>finish(true);
        const timer=setTimeout(()=>finish(false),delayMs);
        signal?.addEventListener("abort",onAbort,{once:true});
        if(signal?.aborted)onAbort();
      });
    }
  }
}

/** The exact placeholder Pi writes when it has no history left to summarize. */
const NO_HISTORY_PLACEHOLDER = "No prior history.";

export function restorePreviousSummary(summary: string, previousSummary?: string): string {
  if (!summary.startsWith(NO_HISTORY_PLACEHOLDER)) return summary;
  const previous = previousSummary?.trim();
  if (!previous) return summary;
  return `${previous}${summary.slice(NO_HISTORY_PLACEHOLDER.length)}`;
}

/** True when Pi produced a summary that dropped an existing accumulated summary. */
export function droppedPreviousSummary(summary: string, previousSummary?: string): boolean {
  return summary.startsWith(NO_HISTORY_PLACEHOLDER) && !!previousSummary?.trim();
}
