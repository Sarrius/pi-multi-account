# Recovering a large context on a smaller model

`recoverLargeContext` defaults to `true` on hosts exposing canonical session projection (Pi 1.1+). This is separate from the optional `contextGuard`; it does not enable proactive tool-result elision or impose a permanent small window on ordinary work.

## What happens

When Multi Account switches to a smaller managed model, its provider wrapper checks the serialized outgoing payload **after caller replacements and owned provider shaping**. An oversized payload is rejected before dispatch with a context-overflow error. Pi's existing automatic-compaction lifecycle owns the recovery and retry; there is no second continuation scheduler.

The extension reads the current canonical public context in chronological, bounded pieces. An available native model builds a handoff containing the current task, decisions, constraints, completed and uncertain actions, dependencies, source references and next step. Preparation cannot run tools or commit partial summaries. The active session's reasoning setting is retained; preparing a large history can require several model requests and may be slow at high effort.

Only complete, nonblank, bounded output can become a native checkpoint. Its retained boundary is a metadata-only anchor, so an oversized recent message is not accidentally kept in full beside the summary. Original public source records remain reachable through a reference in the native session journal. The original task is resumed through Pi's own overflow retry, not re-created as a new task.

The transition-specific payload guard ends after a successful assistant response on the destination. Ordinary threshold compaction remains Pi's responsibility.

## Reading original evidence

Recovery activates three read-only tools:

- `ma_history_archives`: page through archive references on the active branch.
- `ma_history_search`: search the latest or selected archive with up to 16 keywords. Matching more distinct terms ranks first; ties favor later records. This is not an exact-phrase query.
- `ma_history_read`: read an entry by its cited ID, following `nextOffset` until complete. Without an explicit archive, it can locate citations from earlier recovery checkpoints.

Search snippets can be partial. Ranking is not approval, current truth, or a completeness guarantee. An attempted action with no result must be reconciled, not repeated because its receipt was absent from a summary. Tool/custom/assistant text is not owner authorization.

The archive preserves **the public canonical context available when recovery began**. That includes existing summaries as summaries; it does not claim to reconstruct originals already absent from that projection. Private thinking, signatures and private tool details are not exported. Context edits are honored. Later edits to a captured view's ancestry invalidate that view rather than resurrecting removed text; omitting a newer failed attempt does not revoke unrelated earlier evidence.

Reopening the same saved session restores references without copying transcripts into a second database and without resuming unfinished automatic work. Branch departure, another session/file, changed source projection or unavailable host support fail closed. Do not delete the native session journal if its archives are still needed.

## Bounds and failure behavior

- Captured source: at most 32 MiB of public record data. At most two committed views plus the in-flight source are cached; older references reconstruct from the native journal.
- Preparation: at most 64 generator invocations within `compactionWatchdogMs` overall; native transport retries are not claimed to be separate helper invocations.
- Application input budget: `min(262144, floor(contextWindow * 0.7))` UTF-8 bytes, with transport headroom reserved during preparation.
- Summary: at most `min(16384, floor(inputBudget / 8))` bytes, reduced further when protected prompt/tool declarations need space.
- Retrieval: paginated 2048-byte source replies, with a 4096-byte tool-text ceiling.

These are conservative byte policies, **not an exact tokenizer or a guarantee about opaque provider-side state**. The final managed-payload check is distinct from preparation's application-JSON bound.

Cancellation, a new owner input, stale session/branch, deadline, invalid summary or insufficient protected-context space stops preparation without committing a partial checkpoint. Original context remains. No summary can be generated without available compute. The preparer is text-only: native image blocks stop recovery before inference rather than being misrepresented as understood base64 fragments; unknown public block types also fail closed. Recovery does not guarantee that a model understood every dependency correctly.

Automatic compaction must be enabled in Pi for the native overflow recovery path. `continueAfterCompaction` still controls the extension's extra automatic-compaction wake; Pi's own overflow retry remains native. `routeCompactionToHealthyAccount: false` prevents choosing another summarizing account when the current one is unavailable.

Cursor is not used to generate recovery summaries. Opaque or unmanaged destinations without an owned admission wrapper, unknown windows, and windows below 8192 tokens are not silently certified: automatic smaller-window switches to those destinations are skipped. Coverage checks the effective registered stream and model API, not just a provider name; replacing that stream during activation stops the automatic chain. Explicit user model selection remains available. Older hosts without public canonical projection retain their existing behavior, without attempting raw-journal recovery.

Set `"recoverLargeContext": false` in `provider-failover.json` to disable this feature. Invalid explicitly provided values also disable it; an omitted value enables it on supported hosts. This setting does not change account credentials or ordinary context-guard configuration.

## Diagnostics and evidence limits

`source_recovery_prepared` records pass/piece counts and the archive reference, not source text. `source_recovery_blocked` reports why preparation stopped. `source_recovery_route_unsupported` identifies a destination that lacks supported admission.

Native lifecycle tests cover oversized-request rejection, immediate/preflight/delayed-quota fallback, the base provider, multi-pass preparation, one checkpoint, retrieval, one file read, invalid-summary refusal and restoration from the saved journal. They also change input, edit context and abort in a later compaction handler, proving the final result-accessor fence runs after all handlers and before native journal append on the qualified Pi 1.1 and 1.3 hosts. Keep these ordering tests when qualifying a host upgrade. They use synthetic transports to make lifecycle assertions deterministic. Separate live synthetic qualification, when reported, is a capability check—not a reliability rate, a lossless-understanding guarantee or proof for every 600k-to-200k transition.
