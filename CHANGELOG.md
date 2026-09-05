# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Successful completion cancels pending automatic retries.** A timeout from an earlier turn no longer injects a continuation after the task has finished. Completion also invalidates retry callbacks already waiting for Pi to become idle or a model switch to finish.
- **A Cursor Grok child no longer fails before its first tool runs.** Cursor's OpenAI-compatible adapter composes tool-call identity as `${call_id}\n${item_id}`, joined by one LF rather than the `|` that OpenAI Responses uses. The native controller boundary accepted only the `|` form, so a healthy provider frame was terminated as `malformed_provider_frame (unsupported_tools)` on every attempt and no failover could recover it. Tool-call ids now accept exactly one optional `|`- or LF-joined pair, each half constrained as before and the whole still bounded to 128 characters; tool names, namespaces and route identifiers keep the stricter pattern.
- **A reasoning-capable Codex child no longer fails on its own reasoning block.** OpenAI Responses streams one reasoning representation and may replace it with a summarized form at `output_item.done`, so requiring the final `thinking_end` content to equal the concatenated deltas rejected a well-formed stream. Reasoning still never crosses the controller boundary and remains bounded by the output cap, but its final value is no longer required to be byte-identical to the streamed deltas.
- **Malformed-frame terminals now say which frame was rejected.** Block start/delta/end, unsupported stream events and truncated blocks carry distinct fixed reasons instead of one undifferentiated `malformed_provider_frame`, so a live failure names its own cause.

## [1.21.2] - 2026-09-04

### Fixed

- **A second concurrent Pi session no longer hangs before it can submit prompts.** When another process owns the canonical child-proxy port, the fallback listener now retries on an ephemeral port on the next event-loop turn and resolves from a standalone `listening` handler. This avoids leaving `session_start` pending forever under Pi's compiled Bun runtime after `EADDRINUSE`.
- **Slot provisioning no longer deletes user-authored model metadata.** Existing `modelOverrides` entries — including per-model `contextWindow` and `maxTokens` — now survive startup publication, `/multi-account rediscover`, catalog replacement, and loopback shutdown cleanup. Generated proxy routes are still removed when their owner exits, so preserving the override layer cannot leave a dead port or credential behind.

## [1.21.1] - 2026-09-03

### Fixed

- **Rotation now preserves the user's model class as well as reasoning effort.** Exact-model siblings remain first, while cross-provider fallback uses explicit quality bands: frontier (Sol, Opus and provider flagships), balanced (Terra, Sonnet), and fast (Luna, Haiku). Manual `next`, automatic failover, pending resume, startup preflight, and `best` share the rule, so a Sol task can no longer silently land on Terra because that happened to be the next account's flagship.
- **Manual control now invalidates the complete previous failover chain.** A user prompt, Pi model selection, `next`, `best`, or `switch` advances the chain epoch and clears pending wakes, watchdogs, injected-continuation state, and recovery counters. A timer armed by an earlier failure can no longer restart its old rotation underneath the account the user selected.
- **Fresh user messages are no longer swallowed into an extension-private cooldown queue.** When no account is ready the message remains in Pi's visible transcript and Pi owns delivery/retry; the extension only uses Pi's native follow-up queue when an automatic agent turn is genuinely active.
- **Automatic routing no longer wastes turns on accounts whose fresh usage verdict already says 100% / blocked.** Background usage refresh makes an account eligible as soon as the provider reports recovery; manual `next` remains the explicit one-attempt override for stale telemetry.
- **Repeated same-model 500 retries are bounded by the recovery breaker.** The extension stops after three failed automatic recoveries instead of multiplying its eight-hop budget by the provider's own HTTP retries, and the continuation text says `retrying` when no account/model switch occurred.
- **Pending work is session-local.** Parallel Pi windows may still publish a diagnostic marker to the shared state file, but no window reads another window's marker as executable work. Switch, error, resume, continuation, and session-start log events now include a session id so overlapping workdays can be reconstructed reliably.
- **Explicit CLI model and thinking selections remain authoritative.** A launch with `--model`, `--provider`, `--thinking`, or a model thinking suffix no longer gets overwritten by remembered interactive state and no longer writes the one-shot launch choice back as the global preference. Pi's own CLI resolver supplies the parsing semantics, native model clamps are distinguished from genuine user thinking changes, and later manual `next`, `best`, `switch`, model, or thinking choices correctly take ownership. Integrated from PR #39 by Gabriel Vinhaes.

### Tests

- Added regression replays for the observed 2026-09-03 workday failures: Sol-to-Terra downgrade, manual `next` followed by stale automatic rotation, invisible cooldown input, fresh-100%-account selection, repeated Kimi 500 continuation loops, and cross-window pending-state contamination.

## [1.21.0] - 2026-09-03

### Added

- **A `pi-subagents` child now keeps the exact model its parent runner launched.** Native children carry `PI_SUBAGENT_CHILD=1`; inside that boundary this extension remains available for provider/account registration, OAuth request shaping, and catalogs, but becomes passive as a router. It no longer restores the interactive process's remembered model during `session_start`, persists a child model as the user's preference, intercepts provider errors, switches models, queues inputs, routes compaction, or auto-continues. The provider error reaches `pi-subagents` unchanged, so its verified `fallbackModels` chain remains the single routing authority. This fixes children launched as `qoder/qfmodel:high` being changed milliseconds later to the parent process's `qoder/qmodel_38max:medium` or even an unrelated `openai-codex` model, then rejected by `model_verification_failed` after completing the work.

- **A queued owner prompt no longer collides with an automatic resume.** The `input` hook rechecks readiness after awaited preflight work and routes an ordinary prompt arriving during an active automatic turn through Pi's explicit `followUp` queue; held-message flushes also always provide `deliverAs: "followUp"`, which is harmless while idle and closes the check→send race.

- **The parent now exposes a credentialless native-provider boundary for the delegation controller.** After the multi-account catalog and Cursor bridge are ready, `ctx.controllerProvider = { providerTransport, routePreflight, routeResolver }` binds each controller lease to the exact provider/model and current parent-resolved credential, preflights exact route readiness before lease admission, then streams through Pi's native provider implementation with retries pinned to zero. The route pool is therefore the complete current subscription-native catalog rather than a Cursor-only canary; OAuth tokens and API keys stay in the parent, including hidden `only-active` slots. Direct child auth remains only as the compatibility fallback when an older host cannot expose the native provider boundary.

- **An extension-free child now runs on the account the rotation chose, instead of silently rerouting to another vendor.** Pi keeps `settings.json` pointed at the active model, so anything spawned without this extension loaded reads those two keys and tries to run on the active rotation slot. Publishing that slot's *name* into `models.json` was never enough: measured 2026-08-24, a published slot carrying an OAuth credential fails with `No API key found`, because Pi honours an OAuth credential only for a provider definition that declares the flow and a `models.json` entry declares none. The child does not stop there — Pi falls through to its own first-available provider, and the first configured entry after two unconfigured ones is `anthropic`. That is the whole chain behind a memory extension's consolidation subprocess getting `Third-party apps now draw from your extra usage, not your plan limits` from Anthropic while the rotation was sitting on Codex, with nothing in this extension's black box recording it, because the failure happened inside a `--no-extensions` child it cannot see. The Cursor slots already solved this shape — publish the slot against a route the parent serves on `127.0.0.1`, with a deliberately non-secret placeholder as its `apiKey` — and that pattern now covers the Anthropic and Codex families too. Pi admits the provider because it sees a credential; the child authenticates to this machine with a string worth nothing; the parent swaps in the real token, adds `anthropic-beta: oauth-2025-04-20` or the Codex account header, and forwards. The credential never enters a file a child reads. Verified against a real `pi -p --no-extensions` child with an **empty** `auth.json`: both families resolve the slot, get past authentication, and reach the loopback route; the shaped upstream requests were then confirmed against the real backends (Codex answered HTTP 200 with a live stream, Anthropic authenticated and returned its own rate-limit verdict rather than an auth error). Two measurements shaped the implementation. Pi's Codex API refuses to send anything until it can base64-decode an account id out of the key — `Failed to extract accountId from token` — so that family's placeholder is JWT-shaped: algorithm `none`, no signature, and the placeholder string where the account id would be, with the proxy substituting the real account on the way out so the user's own id stays out of the published file too. And Pi's Codex API tries a WebSocket before falling back to SSE, so the proxy refuses the upgrade immediately rather than spending an upstream round trip on a request that could never have worked. Two gates guard the port, because a loopback port is reachable by every process on the machine and what sits behind it is the user's subscription: only slots we published are served, and only a caller presenting the published placeholder is served — a refusal never echoes what was presented, since that may be someone else's real credential. Paths containing `..` are refused rather than normalised, and the published route is asserted to point at this machine. `childProxy: false` turns the whole thing off, which returns the previous behaviour: those slots become unusable to children again, and `/multi-account status` says so.

- **`status` now says which rotation slots an extension-free child can actually authenticate to, and warns when the active one is not among them.** Anything spawned without this extension loaded — a memory extension consolidating its own notes, an external CLI, a bare `pi -p --no-extensions` call — reads `settings.json` to find the active account, and Pi keeps those keys pointed at whatever the rotation last chose. Publishing a slot's *name* into `models.json` is not the same as publishing a usable route, and the difference is invisible from here: measured 2026-08-24, a numbered slot carrying an OAuth credential resolves by name and then dies with `No API key found`, because Pi honours an OAuth credential only for a provider definition that declares the flow and a `models.json` entry declares none. A child in that position does not fail loudly — Pi falls through to its own first-available provider, which is a different account and usually a different vendor. That is exactly how a consolidation child ended up on Anthropic, and billing-refused, while the rotation was sitting on Codex. `status` now reports the count of rotation slots a bare child can use, names the ones it cannot, and prints a warning when the account it would pick up is one of those. The judgement is made from the files a child actually reads rather than from this extension's own registry: a built-in provider is usable whatever we do, because Pi owns its auth flow; an API key resolves through Pi's credential store; a published placeholder pointing at a parent-owned loopback route is usable, which is what the Cursor slots already do; and an OAuth credential on a slot with neither is not. A placeholder key pointing anywhere other than this machine is reported as a misconfiguration rather than a route, since a placeholder means nothing to an upstream that did not issue it.

- **The assumptions this extension makes about Pi are now written down, and checked.** Two Pi changes have already broken it and neither announced itself: `AuthStorage` dropped `set()` on 0.84.x, which is how a refreshed Anthropic token was persisted — the file format was unchanged, the write path was not, and the symptom was a fresh `/login anthropic` roughly once a day; and slot catalogues written into `models.json` as bare id strings where Pi requires objects made Pi reject the **entire file**, so every custom provider the user had disappeared at once. Neither `auth.json` nor `models.json` carries a schema version (only `settings.json` records a version, and that is the app's, not the format's), so a format change cannot be detected by comparing anything — the only available detection is to look. Three rules are now enforced in one place. Read only what Pi publishes: `auth.json`, `models.json`, `settings.json`, which is exactly what a bare `pi -p --no-extensions` child reads and nothing deeper. Never write those files directly — writing goes through Pi, which owns locking and migrations. And check the shape on the way in, at session start, before discovery has rewritten anything, so what is judged is the file as Pi left it: an unfamiliar credential kind, a `providers` map that is not a map, a bare model-id string, a file that exists but will not parse. Alongside them a ledger names every load-bearing fact this extension depends on, where Pi promises it, what breaks when it stops being true, and — the part that matters after an upgrade — whether Pi promised it at all. Two rows are marked `observed` rather than `documented`, meaning nothing in Pi commits to them: that Pi rewrites `defaultProvider`/`defaultModel` on every model switch, and that Pi honours an OAuth credential only for a provider definition declaring the flow. The first of those is now checked directly rather than assumed. On the turn after any model switch — ours or the user's — `settings.json` is compared against the model actually running, because those two keys are the only way anything spawned without this extension finds the active account: when they disagree, a child does not fail, it quietly runs on another vendor's account, which is precisely the failure that produced a billing refusal from Anthropic while the rotation was sitting on Codex. Before the first switch of a session the file legitimately still names the previous session's choice, so it is not judged then. Drift is stated once per session, never per turn, and re-stated if it clears and comes back; `status` carries a line for it; logged as `pi_contract_checked`, which also names the unpromised assumptions to re-verify by hand.

- **A failover priority ladder, and `/multi-account priority` to set it.** Rotation's first step already worked: of 602 automatic failovers in this machine's black box, 588 stayed inside the same provider family — same subscription, same model, another account. The other 14 are what this fixes. They are the hops taken once every account of the family was spent, and they had no policy behind them: kimi-coding → openai-codex (3), openai-codex → anthropic (3), kimi-coding → anthropic (2), kimi-coding → cursor (2), ollama → kimi-coding (2), cursor → openai-codex (1), anthropic → cursor (1). The comparator ordered cross-family candidates by liveness telemetry and only fell through to the configured family order as its very last tiebreak, by which point it almost never spoke — so "the whole family is spent, where now?" was answered by whatever the telemetry happened to say that second. The second half of the same gap: `providerOrder` was typed to the six specially-managed families, so accounts outside them — openrouter, zai, minimax, opencode-go-api, openai — could not be placed in the order at all and sat last by construction. In 602 automatic failovers not one ever reached them; right as a default, since they bill per token while the managed families are flat-rate, but an accident of the type system rather than a policy anyone chose. `providerPriority` is now an ordered list of provider **groups** (numbered slots of one account collapse to their group, and nicknames like `claude`, `codex`, `kimi` are understood), consulted when the family runs out. Three bounds keep it narrow: it never overrides same-family failover, which is what preserves the model you picked; it never overrides availability, so a cooling account is still not chosen over a free one; and a group nobody ranked sorts after every group somebody did, because silence is not a preference. It deliberately sits *below* the per-account liveness signals — an earlier draft placed it above them and two existing tests caught it, since evidence about one specific account has to beat a preference about its whole category. What is left for the ladder is exactly the case the telemetry cannot separate. Default ships as the managed families in order with per-token providers left off the end. `/multi-account priority` reports the ladder and which rungs you are logged in to, `/multi-account priority cursor claude kimi` sets it, `none` clears it, `reset` restores the default; `status` states it in one line. Logged as `priority_set`.

- **The task now carries on after an automatic compaction, instead of stopping until the user types "continue".** Pi ends the run whenever a threshold compaction fires, and half of this machine's compactions were followed by the user typing a short "продовжуй" to get the work moving again (59 compactions in the logs: 49 % a short continue, and most of the remainder the user pasting the summary back in by hand or the failover's own continuation prompt — only a handful a genuinely new task). The route out is Pi's own and was simply unused: `_runAutoCompaction` ends with `return this.agent.hasQueuedMessages()`, and `_runAgentPrompt` turns a `true` there into `await this.agent.continue()`, which drains the follow-up queue and resumes the run. Pi relies on exactly that for overflow recovery, but queues nothing itself after a threshold compaction, so the queue is empty and the run ends. One follow-up is now queued while the compaction is still in flight — synchronously, so it is there by the time Pi reads `hasQueuedMessages()` a few lines later. Nothing else about the mechanism is touched. It stays silent for a manual `/compact` (a deliberate pause), when Pi is already retrying the turn itself (`willRetry`), when the session is idle (nothing would drain the queue, and the same call would append a stray message instead), when something is already queued, and after the user pressed Esc. It shares the `maxAutoContinuesPerPrompt` budget with failover, so the two together still cannot keep a task alive forever without the user saying anything. On the judgement call: `stopReason` does not separate unfinished work from finished — after a clean `stop` the corpus splits 17 continues to 15 new tasks — and no cheap textual signal does either (not one assistant message in the corpus even ends in a question mark). Rather than guess from the outside, the queued message says plainly that finishing is an allowed answer, so a task that really was complete is reported in one line instead of padded with invented work. Logged as `compaction_continue` and `compaction_continue_skipped`; `continueAfterCompaction: false` turns it off.

- **A context guard that keeps a request inside the model's window while the agent is still working.** Pi measures the context in exactly two places: after a whole agent run has ended, and just before a new user prompt. Inside a run — which is where an autonomous session spends almost all of its time — nothing measures anything, and a retryable provider error makes it worse by taking the retry branch of `_handlePostAgentRun()` and returning *before* the compaction check, so the one checkpoint that exists is routinely spent on a retry. Measured across 18 real coding sessions (~96 MB of transcripts): one agent run between two user messages — 78 minutes, 222 assistant turns, 360 tool results — grew from 85 663 to 542 529 reported tokens against a 272 000 window with no check at all, and a Codex 500 partway through was retried so the run simply carried on. On the main working model 48 % of all requests went out above 80 % of the window and 30 % above 100 %; auto-compaction, when it fired, fired at 94 %–199 % of the window (measured: 107, 121, 122, 125, 132, 134, 136, 137, 141, 145, 153, 199 %). Pi's own headroom is `contextWindow - 16384`, while the growth between two consecutive replies is p99 = 18 950 and p99.9 = 46 731 tokens — the margin is smaller than a normal step. The guard now measures every outgoing request from Pi's own message list plus the system prompt, and above 75 % of the usable window elides the oldest large tool results out of *that request only*; the session transcript is never modified and the most recent 40 000 tokens are never touched. 86.5 % of the weight in that runaway run was tool results, which is why they are what gets given up. Above 70 % a real summary is requested — but only once the agent has settled, because `ctx.compact()` begins with an `abort()` and mid-run would throw away the work in progress. Two details it has to get right and does: once a message is given up it stays given up, so the request prefix does not churn and the provider's prompt cache re-warms once instead of every turn; and the guard keeps its own accounting rather than the provider's, because trimming lowers what the provider reports and would otherwise hide the growth from Pi's threshold entirely. It never learns from an implausible reported size either — Cursor answers from its own checkpointed conversation and openai-codex continues one server-side through WebSocket deltas and `previous_response_id`, so both report their bookkeeping rather than the request we built. Advertised windows are capped at 400 000 by default: `claude-opus-5` and `kimi k3` declare 1 000 000+, which puts Pi's threshold at ~1 032 192 where it can never fire, and those sessions reached 717 813 and 547 203 tokens untouched. Logged as `context_guard_trimmed` and `context_guard_compaction_requested`; `contextGuard: false` turns it off.

- **The context guard notices when it has stopped working and says so.** Nothing in it lives inside Pi, so a host update cannot delete it — but a host update *can* quietly stop calling it, and because every handler here is crash-isolated a removed or renamed hook does not fail loudly: the guard simply never runs again and the session goes back to overflowing with nobody watching. That silent inertness is the failure worth reporting. After five real LLM responses with no pre-request hook ever firing, the guard says out loud that it is not running and that long runs are unprotected; if the hook is alive but Pi does not know the active model's context window — the guard's one honest reason to stand down, since it will not guess a limit — it names the model and says how to switch it back on. A host that no longer exposes compaction to extensions is reported separately, because the guard can still trim requests but can no longer ask for a summary. Each warning is said once per session, never per turn. Logged as `context_guard_inert`.

### Added

- **One account table replaces the switch-and-check ritual.** `/multi-account accounts` lists every configured slot with its provider-reported email and alias, plan, primary/secondary quota, and actual routing state (`ready`, cooldown, unavailable, or duplicate). It uses cached snapshots by default; `/multi-account accounts refresh` explicitly refreshes every supported account even when the footer is disabled. Identity comes only from provider response metadata — token claims, API keys and raw credentials are never rendered or logged.

- **A governor: one place that can stop everything, instead of a dozen places that each stop themselves.** This changelog contains eight fixes for the same shape — "Runaway failover loop that could freeze the machine", "Escape did not stop the loop", "API-key providers no longer loop forever on a dead key", "a session/rate limit is no longer hot-retried every second", "Compaction no longer leaves 'Compacting context…' spinning forever", "a refusal that cannot be classified no longer strands the session forever", "the stuck-resume watchdog now ACTS instead of only warning", and the 275-switch rotation below. Every one of those was correct, and none of them prevented the next, because they were fixes to *paths*. The extension drives the session from about a dozen places — a failed turn, a resume timer, a queued-input timer, a stuck-turn watchdog, a compaction boundary, two preflights — and each decided for itself when to give up, using one of six unrelated counters (`autoContinuesThisPrompt`, the pending-resume hops, the stuck reminders, the recovery breaker, the guard's compaction cooldown, the queue length). Not one could see the others, and none could see the session. A new path, or a new interaction between two old ones, was therefore an unbounded loop by default, and only became safe if whoever wrote it remembered to bound it. The default is now inverted. Every automatic action asks one gate first, and the question it answers is not "have I done this too often" but "has this session gone anywhere", measured at the provider rather than in our own bookkeeping — the whole failure mode being that our bookkeeping believed it was making progress. Two invariants: no request reached a provider at all across twelve consecutive actions, which is a spin with certainty (the 275 switches made none); and no *successful* response across forty, which is what a hot retry against a limit our meters cannot see looks like, set loose enough that walking an entire seventeen-account fleet — a switch and a real request each — finishes normally, because every one of those requests clears the first invariant. Each invariant arms itself only after it has seen its own signal work once in this session, so a host that reports neither leaves the governor dormant rather than stopping sessions that were fine. Tripping is not a pause: every timer is cleared, every armed continuation dropped, the reason is stated in one sentence, and any text the user had typed and had held for them is handed back in that same sentence rather than discarded with the machinery. It stays stopped until the user sends a message or runs `/multi-account reset`. `status` carries a line saying whether it is running and how close it is; logged as `governor_stopped`. And because a rule that is remembered is a rule that lapses, `test/governed-actions.test.ts` reads the source and fails if any new place drives the session without asking — the enforcement the previous eight fixes each lacked.

### Fixed

- **Ollama Cloud now shows its real session and weekly quota instead of claiming that no API exists.** The extension still reads plan and suspension metadata from `/api/me`, then best-effort fetches the live fractional windows from `GET /api/usage`. Because that endpoint and its fixed reset epochs are not yet a stable documented contract, any failure falls back to the plan-only status and inferred reset times remain forecasts subject to the normal recheck ceiling; they never turn a stale estimate into a permanent routing veto.

- **Different Codex users in one Team/Business workspace can occupy separate rotation slots.** Pi stores `chatgpt_account_id`, which identifies the selected workspace rather than the user membership inside it. Deduplicating on that value rejected the second login as the same “real account” and also shared cooldowns between distinct users. Codex identity now prefers the JWT's stable `chatgpt_account_user_id` claim; tokens without it use the documented `chatgpt_user_id` plus workspace id before falling back to the legacy stored `accountId`. Re-login detection uses the same identity, so a refreshed token keeps its cooldown while replacing a slot with another user in the same workspace clears the previous user's state.

- **The Anthropic OAuth billing header now identifies Claude Code `2.1.259`.** This replaces the stale `2.1.241` client version reported in #29.

- **Numbered OAuth accounts no longer degrade into an invalid API-key request after catalog refresh.** Child-facing aliases intentionally publish a non-secret placeholder through the local loopback proxy, but Codex and Anthropic catalog re-registration replaced that loopback URL with the public upstream. Pi then sent the placeholder directly to the provider and every account failed with `Could not parse your authentication token`. Catalog refresh now preserves the account-specific loopback route, and that provider error is classified as authentication failure rather than an unrelated request error.

- **A message held for quota recovery is sent immediately after a successful manual account switch.** `/multi-account switch`, `next`, `best`, and ordinary model selection now wake the held-input queue instead of leaving it asleep behind the previous account's cooldown timer. Items leave the queue only after Pi accepts them, and session-owned pending markers prevent another live Pi window's stale timer from clearing or resurrecting newer work.

- **Only the process that owns the loopback port may rewrite the files every child reads.** The port was treated as a convenience — if it was taken, the extension quietly listened on a random one instead and republished the whole rotation against itself, on the reasoning that both processes hold the same credentials so either can serve. That is true of serving and false of ownership. A second session, or a `pi-subagents` child (which is just another process on this machine), would repoint every slot in `models.json` at a socket that dies when it exits, and then on its own shutdown restore the credentials and unpublish the routes that belonged to the process still running. The listening half is unchanged — an ephemeral port still serves that process's own callers and costs nothing — but publishing, credential shadowing, restoring and unpublishing are now reserved for the process holding the canonical port. Everything else leaves the shared files exactly as it found them. The canonical port is overridable through `PI_MULTI_ACCOUNT_SLOT_PROXY_PORT`, because a fixed port can collide with unrelated software. Covered by a regression test that runs two real extension instances against one port and asserts the second one changes nothing.

- **A memory review or consolidation child no longer dies with "No API key found" or Anthropic's third-party extra-usage refusal while this session is on the active rotation account.** Pi keeps `settings.json` pointed at whichever account rotation chose, so a `pi -p --no-extensions` child — exactly how those background jobs start — tries to run there. Two measurements, not guesses, were the whole failure. A numbered slot (`anthropic-account-2`, `openai-codex-account-4`, …) published into `models.json` with a loopback placeholder still failed at auth, because Pi's resolver keys off the stored credential *type* first: an OAuth blob under the same key and a models.json-only provider (no OAuth method) returns undefined, and the placeholder is never consulted. That is `"No API key found for openai-codex-account-4"`. The empty-`auth.json` canary hid it. Base `anthropic` is different: Pi does resolve the subscription token, then Anthropic refuses the call as a third-party app because the child does not send the client identity the parent adds — measured on this session as `400 invalid_request_error` against `anthropic/claude-opus-5` while the parent on the same account answered. The loopback proxy already existed; it was aimed at the empty-auth case and never published the base account. Numbered OAuth blobs are now held in a parent-only sidecar while the proxy is listening, and `auth.json` shows the child a non-secret `api_key` placeholder so Pi actually sends to the loopback; on stop the blob is written back. Base `anthropic` stays OAuth in `auth.json`, is published against the live loopback, and the proxy admits that access token as well as the placeholder so the parent can add `anthropic-beta: oauth-2025-04-20`. The parent's own `registerProvider("anthropic")` now sets the real Anthropic base URL explicitly, so a published loopback cannot hijack the parent session. On stop, or if the listener never comes up, every own loopback is removed from `models.json` — numbered slots included — so a dead `127.0.0.1:41977` cannot remain as the child's route. A last-resort credential persist writes the child-facing `auth.json` from the file as stored, not from the parent merge, so a refresh cannot dump sidecar OAuth back onto sibling slots. Covered by child-usability, slot-proxy admission, sidecar shadow/restore, and loopback-unpublish tests. After a restart the live `anthropic/claude-opus-5 --no-extensions` child returned OK through the loopback (no third-party 400); the same child on the then-active `cursor/cursor-grok-4.6` died with `No API key found for cursor` because Cursor OAuth was still in `auth.json` while only `models.json` carried `cursor-proxy` — the empty-auth canary hid that too. Cursor and `cursor-account-N` are now shadowed the same way as numbered Anthropic/Codex slots, without routing them through the Anthropic/Codex loopback.

- **A delegated child on a Codex account no longer dies before its first tool call.** OpenAI's Responses API does not identify a tool call with one id: it composes `${call_id}|${item.id}`, so a real Codex tool call arrives as `call_Akvop7d1WDfLFTzvStUPaZe3|fc_06d3b3…`. The controller boundary validated that field with an identifier pattern that allowed letters, digits, `.`, `_`, `:` and `-` and nothing else, so the pipe made the frame unparseable and the stream was terminated as `malformed_provider_frame` before the child could read a single file. Nothing downstream was wrong and nothing retried its way out of it, because the shape was rejected identically on every attempt — the delegation simply reported that the provider had produced an unsupported frame. Tool-call identity now accepts exactly one optional `|`-joined pair, each half still constrained as before and the whole still bounded to 128 characters; every other identifier class (namespaces, tool names, block ids) keeps the stricter pattern, so this widens the one field the provider actually composes rather than loosening validation generally. Covered by an adapter test that streams a compound-id tool call through `openai-codex-responses`.

- **Compaction failure no longer re-enters immediately, and a guard summary no longer strands the task.** A cancelled or callback-less guard compaction now clears its pending demand and backs off before another settled boundary can ask again. Healthy active models stay on Pi's native compaction path, routed providers receive the full configured per-attempt watchdog, and post-compaction continuation is enabled by default with an explicit opt-out for another extension's continuation owner. A context-guard compaction starts the next turn only from Pi's completion callback; its idle-time `session_compact` hook cannot merely append an undelivered follow-up.

- **A held message no longer keeps a session polling every five seconds for six hours.** The queued-input timer had the same shape as the rotation loop and none of its bounds: every wake ran the full account preflight, which could switch account, and rescheduled itself unconditionally — for as long as the message waited, which for a real quota window is hours. Nothing counted those switches and nothing slowed the polling. The switches now go through the governor like every other action, and the poll starts fast — picking up a `/login` from another process within seconds is worth it for the first minute — then relaxes toward the ordinary poll interval instead of holding that rate all day.

- **`/multi-account stop` no longer discards what you typed.** A message held during a cooldown was dropped in silence when the wait was cancelled, which from the outside is indistinguishable from the tool eating what you wrote. Every path that abandons the queue now hands the text back in the same sentence that explains the stop, and records it as `held_messages_returned`.

- **Two spent accounts can no longer rotate onto each other for ever while a live account waits.** Recorded on this machine: 275 automatic switches in four minutes, alternating between `openai-codex-account-2` and `openai-codex-account-3` about every 1.24 seconds, with **not one request leaving the machine** — the debug log for that window contains 275 `switch` entries and zero `assistant_error` entries — while `anthropic-account-2` sat at 0 % used and `blocked: false`, and the priority ladder ranks it first. Esc did nothing, because there was no run to cancel; the rotation lived entirely in a timer. The cause was a reprieve with no way to spend it. Candidate selection deliberately admits a same-family sibling whose meter reads 100 %, on the grounds that a used-percentage is a forecast about a quota window that cannot see a session or plan limit, and skipping straight to another vendor on a forecast is what once sent a Codex turn to Claude with three Codex slots still untried. That reprieve was written as *has not refused this session* — and the pending-resume path rotates onto an account **without sending it a request**, so it never refuses, so the reprieve never expires. Two such siblings then re-admit each other indefinitely, and same-model ranks them above the free account on every pass. The reprieve is now spent by **selection**: one rotation onto a forecast-spent account is the single attempt its stale forecast has earned, handed back the moment the account answers a real request or the user sends a new prompt. Same-family failover is unchanged for accounts the meter has not written off, which is the 588-of-602 case that already worked.

- **The pending-resume wait is now bounded, and backs off when it is achieving nothing.** Two separate holes let that loop run without limit. `maxAutoContinuesPerPrompt` counts turns actually started, so a rotation that starts no turn cost nothing and the budget never moved — rotations that dispatch nothing are now counted against the same ceiling, and when it is reached the session says how many switches it made, that nothing was sent, and where to look. And the wake interval is the minimum recovery time across *every* rotation account, so one free account elsewhere pinned it at its one-second floor: the session re-checked at 1 Hz for as long as the state lasted, which is what wrote four megabytes of debug log in a few minutes. A wake that changes nothing now doubles the wait up to the ordinary poll interval, and anything that counts as progress puts it back on the floor.

- **One `/multi-account stop` is enough.** It reliably took two or three. Every automatic path is asynchronous, so a wake already past its guards kept running while the user typed and re-armed the wait a moment after `stop` had cleared it — the command was correct each time and the loop simply outlived it. `stop`, `reset`, `clear` and Esc now bump a chain epoch that every timer and every in-flight continuation captures and re-checks after each await, so a chain started under the old epoch abandons itself instead of re-arming.

- **A routed compaction no longer offers the summary to the entire fleet, one full hang-bound at a time.** Also recorded here: 98 consecutive `compaction_failed` entries — `insufficient balance`, `no resource package`, `this model requires a subscription`, `no endpoints found`, `does not exist or you do not have access`, `exceeds the context window` — because the candidate list is the whole rotation, which on a fully populated machine is nine accounts across seven vendors, including the per-token ones that are in the list precisely because nothing measures them. Each got the full 8-minute hang bound of its own, so the worst case was over an hour of "Compacting context…" for a summary that was never going to land. Two bounds now apply, and none of them is silent. At most three accounts are asked, because if three in a row cannot summarize the tenth will not either; the log records which candidates went unasked. `compactionWatchdogMs` is the bound for each attempted provider, not a third of that bound — the previous division aborted ordinary slow summaries at 160 seconds. A timed-out attempt is aborted and the next live account is tried. And a refusal that needs a human before it can change — an empty wallet, a plan that does not include the model, a model that is gone — benches that account for compaction for half an hour, so the next compaction does not rediscover the same wall of refusals.

- **A compaction that answers through neither callback no longer switches the context guard off for the rest of the session.** `ctx.compact()` reports back through `onComplete` or `onError`, and an in-flight flag is the only thing standing between the guard and a second request. A host that answers through neither — a cancellation reported only through `compaction_end`, a build that drops the handler — therefore did not merely lose one summary: the guard stopped asking for ever, while the context kept growing, which from the outside is a session that first cannot compact and then cannot send anything at all. The wait is now time-bounded and written off as `context_guard_compaction_unanswered`, and `compaction_end` releases the flag too, since `session_compact` only fires when a compaction actually landed — never on the cancelled and failed paths, which are the ones that matter.

- **A held user message no longer blocks compaction indefinitely.** When every account is cooling, a typed message is held in memory and compaction was cancelled to let it flush first. That is right when the message is about to go out and a deadlock when it is not: the context never shrinks, so every request overflows, so compaction fires again, and the held message is no closer to being sent. Compaction is now deferred for the queue only when an account is free within ten seconds; otherwise it proceeds, and the decision is logged as `compaction_allowed_over_queue`.
- **A Cursor conversation is no longer resumed across a gap it did not see.** Cursor answers from its own copy of the history, and rotation moves a session between providers mid-conversation — so a stretch of turns taken on Anthropic or Codex is simply invisible to it. Nothing invalidated its checkpoint on a provider switch: coming back to Cursor resumed a past with a hole in it exactly the length of the excursion, and the model carried on as if those turns had never happened. Each conversation now records how many completed turns of Pi's transcript it has actually seen; between two consecutive requests that count can grow by at most one, so a bigger jump means turns were completed somewhere else and the checkpoint is dropped in favour of a rebuild. The doubt is resolved toward rebuilding on purpose — a needless rebuild costs tokens, while resuming a stale checkpoint costs correctness and says nothing. Logged as `conversation.stale_checkpoint`. Nothing here touches other providers: they receive Pi's transcript directly and were never affected.

- **The restored context now reaches the model instead of sitting where it cannot be read.** There are two ways to put words in front of Cursor and they are not equally reliable: the request's own user message travels inline and always arrives — it is how the first turn of every conversation works — while history turns travel as sha256 blob IDs whose contents stay on our side until Cursor comes back over the KV channel and asks for them. If it never asks, or asks for a blob we do not hold, the answer is an empty result and no error at all. Replaying a restored session as history therefore put the compaction summary somewhere the model could not see it: present in Pi's chat, invisible to the agent, which then acted as if the session had just begun. The rebuild no longer uses history — the summary, the earlier exchanges, the tool calls and their outputs are rendered into the message the model is answering, through the one channel that cannot silently drop them, followed by an explicit instruction to continue rather than start over. A brand new conversation is unchanged: with nothing to restore, the question is sent exactly as typed. On the checkpoint path Cursor still holds its own history, so only the undelivered tool results travel in the request. A missing blob is now logged as `kv.blob_miss` rather than passing for a healthy conversation.

- **The Cursor bridge can no longer take Pi down with it.** Pi exited with an uncaught `ERR_STREAM_WRITE_AFTER_END` raised while answering one of Cursor's blob requests: the bridge pipe had just been closed (a compaction starting a new conversation, a cancelled turn, a session teardown) and Cursor, which talks on that pipe in both directions, asked for one more thing. The write site was already inside a try/catch and that is the trap — a write into an ended pipe does not fail there; Node raises it a tick later as an `error` event on the stream, and a stream with no error listener turns that into an uncaughtException. The bridge handle moves to `cursor/bridge-handle.ts` and now enforces both halves: once ended it reports itself dead and silently drops writes, and every stream it owns carries an error listener, so a broken pipe, a late frame, or a bridge that could not be spawned at all is a debug-log line instead of a dead editor. The same rule is applied to the proxy's own HTTP sockets, and an error raised after streaming has begun no longer tries to rewrite the response headers from inside the catch.

- **Compaction on Cursor stopped being a treadmill that ate its own summary.** Cursor is stateful: once the bridge holds a checkpoint it replays *that* on every request and ignores the message list Pi sent. So a compaction changed nothing on Cursor's side — the model kept answering from the full pre-compaction history, and `conversationCheckpointUpdate.tokenDetails.usedTokens` kept reporting that history's size. The bridge handed the number straight to Pi as `prompt_tokens`, Pi compared it against a 200k window and compacted again on the very next turn, forever. Measured in a real session: a compaction left a genuine ~22k-token context and an 11 130-char summary; the next reply reported 208 080 prompt tokens; auto-compaction fired again three minutes later. Three fixes, one per link in that chain — Pi's `session_compact` now closes the Cursor-side conversation and mints a new conversation id, so the next request is rebuilt from the compacted turns; the bridge reports the size of the request it actually sent instead of Cursor's private counter (that counter is now only a fallback for when nothing could be measured); and the in-flight bridge is torn down with the conversation, so a pending tool result cannot resume the very conversation being left behind.
- **A compaction with nothing left to summarize no longer destroys the accumulated summary.** Pi's `compact()` glues a history summary to a turn-prefix summary when the cut lands mid-turn — and when the history range is empty, which is exactly what a rapid second compaction produces, it substitutes the literal string `No prior history.` and never passes `previousSummary` to the model at all. The session's entire accumulated memory is replaced by a note about one truncated turn: in that same session, 11 130 chars became 2 032 describing work from a different day. Compaction is already intercepted here to route it to a healthy account, so the previous summary is now put back over that placeholder before the entry is saved, keeping the turn-prefix context Pi did produce.

- **Narrowing `/model` no longer deletes models from Pi's registry.** `only-active` re-registered *every* non-active provider with `models: []`, including providers this extension never created — Pi's own built-ins, `models.json` entries, another extension's registration. That registry is the single place anything asks "does this model exist?", so emptying a provider did not hide a model, it removed it: a pinned `zai/glm-5.1` stopped resolving for everyone, and any caller that falls back to "then just use the session model" silently began running on whichever account rotation happened to be on — a different one every few turns, invisible from here and undebuggable from there. The filter now narrows only the rotation slots this extension invented (`*-account-N`, names Pi cannot know without us); every model Pi knows on its own stays resolvable by reference while `/model` is narrowed. `/model` consequently lists each family's base provider again — that is the part that was never ours to take away.
- **A slot published into `models.json` is now usable there, not merely resolvable.** The Cursor slots were written into Pi's static registry so an extension-free `pi -p` child could resolve them, but with no key — and Pi refuses a provider it has no credential for, so every child call died at `credentials_not_configured` after the model resolved. Cursor's real credential is an OAuth token this extension holds and a child cannot read, so the published entry now carries the local proxy's own placeholder, which the proxy already treats as "no token on this request" and answers by supplying the real token itself. Verified end to end: a bare `pi -p --no-extensions` child with no `auth.json` at all completes a Cursor request through the proxy.

## [1.20.0] - 2026-08-23

### Added

- **Ollama Cloud's live catalog is discovered, so `kimi-k3` (and every new Cloud model) appears in `/model` without editing `models.json`.** The picker used to show a frozen snapshot of legacy `:cloud` tags — `glm-5.2:cloud`, `kimi-k2.6:cloud`, etc. — because nothing ever asked Ollama Cloud what it actually serves. `/multi-account` now fetches `https://ollama.com/v1/models` at startup and on each idle sweep, merges the canonical bare ids (`kimi-k3`, `glm-5.2`, `kimi-k2.7-code`…) with the built-in and configured lists, and re-registers the base `ollama` provider and every cloned slot with the full set. Ollama Cloud accepts both the bare and the `:cloud`-suffixed form, so existing configured ids keep working; the suffix is display-only now. A failed fetch leaves the previous list intact, and `autoDiscoverModels: false` turns it off.
- **Kimi For Coding accounts rotate like every other family.** `add kimi` was accepted by the argument parser and then dead-ended: it told the user to hand-write an `api_key` entry, and no code path ever registered a Kimi slot as a provider — so the slot never appeared in `/login`, and a second Kimi subscription was unreachable no matter what was put in `auth.json`. Kimi has had a device-code OAuth flow in pi-ai all along. Numbered Kimi slots are now registered providers with that flow, carry Kimi's own catalog, and `add kimi` points at `/login` like Anthropic and Codex do.
- **Cursor slots register even when two callers race the provider load.** The optional Cursor provider was imported by discovery and by `session_start` at the same time, and the second caller reached the module while it was still initializing — its hoisted functions were callable, its state was not — which killed every Cursor account for the session with `Cannot access 'tokenResolver' before initialization`. The in-flight load is now shared, so the module is imported exactly once however many callers race.
- **A Cursor account's real catalog is discovered at startup, not only on login.** Slots were registered with the bundled fallback list and only a login or token refresh replaced it with the account's actual catalog — so after every restart the picker showed the stale short list until the next refresh. Startup now reads the catalog from the first slot whose stored token answers and re-registers every slot with it, logging the outcome to the debug log.
- **`/multi-account only-active [on|off]` — narrow `/model` to the account you are actually on.** With a dozen rotation accounts the picker lists every model of every one of them, and the interesting list is almost always "what can the account I'm on right now do". With the flag on, every other provider is re-registered with an empty model list — Pi merges re-registrations, so its auth and OAuth configuration survive — and restored when the flag goes off. The filter follows every switch: the failover target's models are restored before the switch and the account just left is hidden after it, and catalog re-discoveries are re-narrowed at the start of each turn.
- **Rotation slots now live in Pi's own static registry, so extension-free processes resolve them.** A bare `pi -p` child (any tool that spawns one — memory review, consolidation, external CLIs) used to die with "model not found" on `kimi-coding-account-2/k3` or `cursor/cursor-grok-4.6`, because those providers existed only in the extension's in-memory registration. At slot login/discovery the slot is now provisioned into Pi's native `models.json` (Kimi slots against the Kimi endpoint, Cursor slots against the running local proxy). Nothing is written on failover, rotation, or limit events — that state stays in this extension's own state file, and `settings.json` is never rewritten by this extension at all.
- **Providers outside the five specially-managed families now take part in rotation.** Membership required a provider to be recognised as `anthropic`, `openai-codex`, `qwen`, `ollama` or `cursor` by name; everything else was dropped by a single `continue`, silently, with no mention anywhere in `status`. On a real machine that meant six of fourteen logged-in accounts — `openrouter`, `openai`, `zai`, `opencode-go-api`, `kimi-coding`, `minimax`, some 405 models — sat unused while the managed accounts burned out one by one. Any account with a usable key that Pi already knows how to call now joins, without being named in this file, so a provider added tomorrow works with no release. They sort last, after every managed family: a managed account has quota telemetry, OAuth refresh and a live catalogue, while an unmanaged one is a blind spend, so it is the account of last resort rather than a peer. They get rotation membership, failover, cooldowns and direct `switch`; they do not get quota display or OAuth refresh, and `status` says so. `includeOtherProviders: false` turns the behaviour off for anyone who does not want background failover spending a per-token key.
- **`/multi-account status` shows how to reach a specific account.** The direct switch existed all along, buried mid-way through a single pipe-separated line of eighteen commands, so pressing `next` until the wanted account came round was the only discoverable route. Switching now has its own line with a real account name filled in.
- **`next` and `switch` say where they landed and what is believed about it.** Landing silently on a cooled account and being silently moved off it a second later produced two switch notices and a session on an account the user never chose; it now reads as one sentence that names the account and admits it is believed spent.
- **A recovery horizon stated in prose is parsed.** Codex free-plan refusals state the most direct fact available about when an account returns — `Try again in ~41615 min` — in the message text rather than in a header or JSON field, and it was being discarded in favour of a quota percentage that cannot see that limit. Structured fields still win; the prose horizon is used only when the provider gave nothing machine-readable, and it is capped by the existing recheck ceiling like every other forecast, so a month-long reset still cannot park an account for more than six hours.

### Fixed

- **A forced OAuth refresh no longer destroys the account it was meant to save.** Anthropic rotates the refresh token on every refresh call and revokes the old one immediately, so a refresh that cannot be *persisted* does not fail — it burns the credential and throws the replacement away. On pi 0.84.x `AuthStorage` dropped the `set()` method this extension persisted with, so the post-refresh guard tripped every single time: `invalid_grant`, "Refresh token not found or invalid", and a manual `/login anthropic` roughly once a day. Persistence now goes through pi's supported locked `modify()`, falls back to `set()` on older hosts and to writing `auth.json` directly, and — crucially — the ability to store the result is checked *before* the network refresh, so a host that cannot persist never rotates a token it would lose. Reported in #22.
- **A forced Cursor refresh actually refreshes.** It still imported `~/.pi/agent/git/github.com/ndraiman/pi-cursor-provider/auth.ts` — a path that stopped existing for everyone when the Cursor provider was vendored into this extension — so every forced Cursor refresh threw before it could refresh anything. It now loads the vendored provider. Follow-up to #20.
- **`CLAUDE_CODE_VERSION` bumped to `2.1.241`** (Anthropic OAuth billing header). Reported in #21.
- **`only-active` no longer restores a stale `/model` list after a catalog sync.** Live discovery (Ollama Cloud, Codex, Cursor) updated the live registration, then a manual switch before the next message restored the hidden copy taken *before* the sync — so `/model` still showed the old six (`glm-5.2:cloud` …) even though `kimi-k3` had already been fetched. The filter is re-applied in the same tick as each catalog sync, so the stored copy is the fresh one.
- **Cursor `resource_exhausted` is treated as a quota limit, so failover moves off the spent account.** gRPC-fronted OpenAI-compatible backends (Cursor among them) surface a per-account quota wall as `resource_exhausted`, not a `429`. Unrecognised, the error was unclassified → no failover → every turn died on the dead account with `Provider finish_reason: error`. It now cools the account down and rotation moves on like any other limit.
- **Cursor tool-call turns no longer report `usage: 0`.** The proxy omitted usage on the tool-call pause and, when Cursor skipped `tokenDetails`, computed prompt tokens as zero. Pi then thought the session was tiny, skipped auto-compact, and `/compact` could say "session too small" while the footer showed 115% of a 200k window. Tool-call responses now include usage, and prompt size falls back to an estimate from the request.
- **Anthropic's third-party extra-usage 400 is treated as a quota limit.** `"Third-party apps now draw from your extra usage, not your plan limits"` used to look like a request bug, so consolidation/review child processes retried it forever. It now fails over like any other exhausted account.
- **A Codex usage-limit no longer jumps to Claude while another Codex account has not been asked.** Every Codex slot sitting at 100% was dropped from the candidate list, so plus-plan `gpt-5.6-sol` failed over to Opus. Automatic failover now tries a same-family sibling first — the exact model if that account has it, otherwise its flagship — at the session thinking level. A 100% forecast is not a refusal; only an actual limit error this session skips that sibling. The hop is pinned through both preflights of the continuation so the next check cannot bounce it to another family before it is tried.
- **Compaction no longer leaves "Compacting context…" spinning forever.** A spent Codex account was rerouted to Claude, the summary timed out, and the job was handed to Pi's default on the *spent* account with no timeout — spinner forever. A timed-out attempt is now aborted (not leaked) and the next live account is tried, including when the *current* account itself wedges. If none can finish, compaction is **cancelled**. The spinner stops. Pi's untimed default is never given a spent account, and a healthy current account stays on Pi's native compaction path.
- **Provisioning a rotation slot no longer invalidates `models.json`.** Slot catalogs were written as string ids (`"k3"`, `"cursor-grok-4.6"`), but Pi's schema requires each model to be an object (`{"id":"k3",...}`). The host then rejected the *entire* file, so every custom provider disappeared. Slots are now written as model objects.
- **Failover tries a sibling account with the same model first.** Exhausting one Kimi slot used to jump to Claude Opus (or Cursor's alphabetically-first catalog id, `claude-4-sonnet`) because confirmation and `preferLatestModel` ranked across families. Automatic failover now tries another account of the same family that still has the exact model — including effort-folded Cursor ids such as `cursor-grok-4.6-high` ≈ `cursor-grok-4.6` — and restores the session thinking level. Only when no such sibling is free does it move to another family. `/multi-account best` is unchanged: confirmation still outranks an unmeasurable guess. Same-family `preferLatestModel` upgrades (gpt-5.4 → gpt-5.5 on a healthy Codex sibling) still happen.
- **Restart restores the thinking level, not just the model.** Pi's `createAgentSession` clamps the saved level to the *fallback* model's caps while extensions are still registering, so a session that ran `max` on Grok came back at the wrong level even when the model itself restored. The last live level is now persisted alongside `lastUserModel` and re-asserted after the model is back — and when Pi already restored the right model, the level is still re-applied because the clamp still happened.
- **A cancelled compaction no longer strands failover-queued messages.** Pi runs its default compaction on the active account with no request timeout, and a stalled provider call left the session "Working…" forever; messages typed meanwhile sat in the multi-account cooldown queue which nothing re-visited. The extension now cancels the default compaction when it is holding queued user input, and flushes that queue on `compaction_end` instead of leaving it to die.
- **Cursor model names no longer bake thinking effort into the picker.** The catalog lists `Grok 4.6 Medium` / `Grok 4.6 High` as separate ids; after folding them into one model the representative kept the Medium label, so the powerline read "Cursor Grok 4.6 Medium" even while `/thinking` was `high`. The folded name is now `Grok 4.6`, and the model advertises `thinkingLevelMap` so Pi's session thinking level (settings / `/thinking`) is what selects the effort, same as every other provider.
- **A Pi restart no longer dumps the session onto `anthropic/claude-opus-4-8` or `kimi-coding/k3`.** The earlier "restore after catalog load" fix was too late: Pi's `createAgentSession` calls `getModel(cursor, cursor-grok-4.6)` *before* `session_start`, the baked-in Cursor fallback list did not contain Grok 4.6, and startup preflight then treated Pi's accidental kimi/anthropic pick as the user's choice and failed over away from it. Three changes close the hole: `cursor-grok-4.6` is in the bundled fallback so `getModel` succeeds; the factory returns the Cursor setup promise so Pi waits for registration; if Pi still parks on the wrong model, restore runs *before* startup preflight, and a state-version migration keeps `lastUserModel`.
- **Cursor subscription support is part of this extension.** It is no longer loaded from a separate clone. OAuth, the local proxy, and catalog discovery live under `cursor/` inside pi-multi-account. `/next` into Cursor prefers the last chosen model in that family instead of the bundled `composer-2.5` fallback.
- **A Cursor provider fixed mid-session is picked up without restarting Pi.** A module that throws while loading stays cached as failed under its own URL, so every later discovery pass replayed the first error — cloning or repairing the provider only took effect on the next launch. Retries now load a fresh instance, and only after the previous one proved unusable.
- **`switch` accepts the name a person would type.** The slot ids are internal — `kimi-coding`, `openai-codex-account-6` — and `switch` demanded one exactly, so `switch kimi` answered `unknown provider "kimi"` and left `next`, walking through every spent account in turn, as the only way to reach it. An exact id still wins; a short name resolves when it is unambiguous, and an ambiguous one lists the candidates instead of guessing, because guessing between two Codex slots would silently spend the wrong account's quota.
- **`/multi-account best` — one command that lands on an account which can work now.** Reaching a working account meant pressing `next` repeatedly, landing on and being bounced off each spent account on the way, or typing an exact slot name into `switch`. With a dozen accounts, most of them spent, neither is a usable answer to "just put me somewhere that works". `best` picks the top-ranked account that is available right now and switches once; when nothing is available it says so and states when the first one returns, rather than doing nothing.
- **The footer identifies the account, its plan, and whether there is anywhere to go.** It read `Codex A5 | 5h 12% left/3h` — a slot number, which says nothing about whose quota is burning when seven Codex slots are logged in. It now reads `Codex A5 · alice | free | 5h 12% left/3h | +2 ready`: the real account (from the email the provider already reports), the plan the percentage is a percentage of, and how many other accounts could take over. The last part answers the question that actually follows "this one is nearly out".
- **A quota window is labelled by its real length, and the account's own verdict is shown.** The label was positional — whatever sat in the "primary" slot was called `5h` — but a Codex free plan meters a **thirty-day** window there, so a number resetting next month read as one resetting this afternoon. Worse, an account answering `allowed: true` was displayed as `0% left`, because only the percentage was shown: a working account that looked dead. The footer now reads e.g. `Codex A6 · bob | free | ok | 30d 0% left/28d1h | +2 ready`, and `limits` states the verdict in words.
- **Kimi For Coding is reported honestly instead of erroring.** Promoting `kimi-coding` to a managed family left the usage layer unaware of it, so every probe fell through to the OAuth branch and threw `has no OAuth access token` for a healthy API key — blanking the footer and filling the log with failures for an account that was working. Kimi publishes no quota endpoint at all (`/usage`, `/quota`, `/me`, `/subscription` and the Moonshot balance path all 404 against `api.kimi.com/coding`), so it reports its plan and says the quota is not exposed.
- **`best` no longer prefers an unmeasurable account over a confirmed one.** It promised "an account that can work right now" and landed on an out-of-quota Kimi slot, because ranking treated "the provider answered `allowed: true`" and "we know nothing about this account" as equivalent — both merely lack a cooldown. Confirmation is evidence; absence of evidence is not. A confirmed account now outranks an unknown one, and when nothing confirms availability the switch says plainly that it is an unverified guess rather than presenting it as a considered choice.
- **An account with no usage endpoint is no longer re-tried every ten minutes.** The recheck ceiling rests on "asking again is nearly free", which holds for accounts we can poll in the background — Codex, Anthropic, Ollama, Cursor. Kimi publishes no such endpoint (every documented path 404s) and Qwen none at all, so their only "probe" is a real request: the user's message lands on the spent account, is refused, and is bounced onward. Doing that every ten minutes to an account that has just said its quota returns *in the next billing cycle* is the exact thrashing the ceiling exists to prevent. The ceiling now applies where re-probing is cheap, and the recorded cooldown stands where it is not.
- **A managed family missing from a saved `providerOrder` no longer drops out of the rotation.** `/multi-account` writes the whole config to disk, `providerOrder` included, so every installed config pins the family list as it stood that day. When a provider is promoted to a managed family in a later release — as `kimi-coding` just was — an existing config lists neither it (the order predates it) nor admits it as an "other" provider (it is managed now), and a working account silently vanishes from the ring. `rediscover` could not bring it back, because from discovery's point of view nothing was broken. The saved order is a preference about sequence, not a whitelist: families the user never ranked are appended after the ones they did.
- **Losing a race for an OAuth refresh is no longer reported as a dead account.** Anthropic rotates the refresh token on every use and kills the old one immediately, so any second holder of that credential — another Pi window, a usage probe that read the file a second earlier — presents a token that was valid when read and dead on arrival. The server answers `invalid_grant`, indistinguishable from a genuine revocation, and the slot was dropped with a demand to re-login that fixed nothing: the working token was already on disk, written by whoever won the race. That case is now retried once with the stored token. If disk holds the same token that just failed there is nothing new to send and it fails immediately, and any other error (a timeout, a 5xx) is never retried, since burning the disk token on a network blip would turn an outage into a lost account.
- **A revoked Claude login now says what revoked it.** "Authorization is invalid, run /login" sends people round a loop they have often already been round: log in, work for a few hours, get kicked out, log in again. The cause is not in the error text and cannot be guessed from it — every CLI signing into Claude Pro/Max uses the same client id, and Anthropic keeps one live refresh token per account for that client, so signing the same account into another tool, another machine, or a second slot here revokes this one hours later. The message now names that, because it is the only thing that ends the loop.
- **The provider's own "you can use this account right now" answer is finally read.** The Codex usage response states the verdict outright — `rate_limit.allowed` / `rate_limit.limit_reached` — and that field was parsed away entirely, leaving every availability decision to arithmetic on `used_percent`. On a real machine two accounts had recovered and were answering `allowed: true, limit_reached: false` while their monthly meter still read 98%; the extension went on skipping both for hours, because a percentage near the cap plus a bench recorded from an earlier refusal is all it ever consulted. It looked exactly like an extension that cannot see accounts that freed up — which was, functionally, what it was. The verdict is now carried on the snapshot and outranks every derived number in both directions: `usable` retires the bench *and* the meter-distrust flag recorded when the account refused (that distrust was about the meter, and the account has now spoken for itself), while `blocked` keeps an account out of rotation even when its window still shows headroom. Only honoured while the snapshot is fresh, since a verdict describes the moment it was taken; a response that states no verdict falls back to the forecast as before.
- **A refusal that cannot be classified no longer strands the session forever.** An account out of credits refuses with a 402 whose wording — `Prompt tokens limit exceeded: 38075 > 16958 … upgrade to a paid account` — matched nothing in the error vocabulary, so it classified as `unhandled`: no cooldown, no failover, no message. Every subsequent user message produced the identical refusal, indefinitely, while live accounts sat unused a few positions down the rotation. Payment/credit exhaustion is now recognised (matched on wording, never on the bare `402`, which also occurs inside token counts), and an unmanaged account that hits a quota or authorization refusal is benched at the account level for the normal cooldown rather than for one minute at the model level — a minute was short enough for the very next switch to land back on it and close the loop.
- **The error vocabulary is merged with the built-in one instead of replaced by it.** `/multi-account` writes the whole config to disk, defaults included, so nearly every installed config froze a snapshot of the vocabulary as it stood that day. Under replace-semantics a newly recognised refusal reached fresh installs only and was invisible on every machine that had ever run the command — that is, on the machines actually in use. User-added patterns still apply; they simply no longer silently exclude terms added later.
- **A manual choice survives the whole message, not just the first question about it.** Pi runs its readiness preflight twice for one user message (`input`, then `before_agent_start`). The one-attempt reprieve granted by `next` / `switch` was spent by the first, so the second found none and moved the user off the account they had just picked — surfacing as `last-moment preflight: selected account unavailable` one moment before the account would have been tried. The reprieve now covers the attempt and retires on the following message, so it cannot outlive its message even on a host that never reaches `before_agent_start`.
- **"No usable authenticated account exists" is only said when that is true.** Any empty selection produced that sentence, including the common case where several accounts were logged in with quota to spare and had simply lost their authorization. Being told there are no accounts, while `status` lists two with quota, reads as the extension failing to see them and buries the one action that fixes it. The message now names the accounts and states which need re-login and which have no model configured.
- **A quota forecast is no longer announced as a verdict.** `switched to … — believed spent (cooling down, ~672h left)` quoted the raw forecast while the extension's own rule re-probes any account within `maxRecheckIntervalMs` regardless. Reading that an account is locked for four weeks, when it is really re-asked within hours, is a large part of why a user concludes that freed-up accounts are never picked up again. The notice now states the forecast and the guarantee that bounds it.
- **A spent account is no longer re-selected seconds after it refused.** With seven Codex accounts — six reading 100% and one reading 98% — the 98% account was picked, greeted the user, then refused the first real request with `You have hit your ChatGPT usage limit (free plan). Try again in ~41615 min.` It was benched, but the next usage reconciliation saw 98% (below the cap), concluded the account was free, wiped the cooldown, and rotation walked straight back onto it. The loop only broke on the *second* refusal, and every new session reset that counter — so it recurred all day. A stated recovery horizon that contradicts a usage reading claiming headroom now distrusts that reading on the **first** refusal, because the refusal was measured while the percentage is a forecast about a quota window that cannot see a session or plan limit. Deliberately narrow: a bare throttle with no stated horizon (`429 rate limit`) still defers to the meter, so an account whose short window genuinely freed is not benched. A real success restores trust.
- **The distrust survives a restart.** The proof that an account's usage reading does not reflect its real limit lived only in memory, so every new Pi session started believing the meter again and re-selected the spent account once per session. It is now persisted alongside the recorded cooldowns and cleared by a successful response.
- **A manually chosen account is no longer overridden before it gets used.** `/multi-account next` and `/multi-account switch` deliberately ignore the cooldown bookkeeping, because that bookkeeping is a forecast and actually asking the account is the only way to prove it stale. But the preflight running on the user's next message re-applied the same forecast and moved them off — so the override held only until it was used, which is the one moment it had to hold. A manual choice now survives one attempt; normal routing resumes after that, so nobody can strand themselves on a genuinely dead account.
- **Registering the Ollama/Qwen base provider no longer narrows the user's own model list.** That registration exists because a placeholder `apiKey` in `models.json` can stop Pi exposing the provider at all — but it called `registerProvider` with only the one built-in tag, replacing a `models.json` that configured six. A user running six Ollama cloud models could reach exactly the one written into this extension. Configured models are now carried alongside the built-in list, which still leads so the known flagship stays the account's representative. Cloned `-account-N` slots inherit the same set, and are re-registered once the host registry becomes reachable instead of keeping the single tag they were created with. The `qwen` arm of that registration also read `OLLAMA_BASE` as its base id, so its "this is the base provider" guard could never fire.

## [1.17.0] - 2026-08-16

### Added

- **`max` thinking is available on models that advertise it.** Pi understands `max` — it is in `ThinkingLevel` and `--thinking max` works — but the extension's known-levels list stopped at `xhigh`, so the strongest level of a model offering it was filtered out. GPT-5.6 Sol/Terra/Luna all advertise `max` in the live Codex catalog. Reported by @devtm1123 in #15.
- **`reasoningLevel: "max"` is accepted in config.** Adding `max` to the catalog alone was not enough: the config parser enumerated the accepted levels and stopped at `xhigh`, so an explicit `max` fell through to `"auto"` — never forced, with nothing said about why. `max` also joins the weakest→strongest ordering, so guarantee #22 (a weaker fallback model's clamp is restored, never adopted) covers it like every other level.

### Notes

- The known-levels list is a **filter, not a grant**: a model's own advertised efforts are intersected with it, so a level named there only ever reaches a model that asked for it. Provider gradations differ wildly and do not nest — Claude Opus 4.6 advertises `max` alone, glm-5.2 has `max` but no `xhigh`, GPT-5.6 has `max`/`xhigh`/`minimal` but no `medium` — which is why the per-model intersection, not the list, decides what any given model gets. Locked by test.
- The fallback definition for an **unknown** Codex model is deliberately left at `xhigh`. That path is a guess about a model we have no catalog for, and guessing `max` would hand a level to a model that never claimed it.

### Tests

- Guarantee #27: a model that advertises `max` gets it, one that does not is left untouched (including not acquiring a `medium` it never claimed), `reasoningLevel: "max"` is honoured, and `max` is restored after a switch through a weaker model. Verified red→green.

## [1.16.0] - 2026-08-16

### Changed

- **Availability is now verified, not predicted.** Every number a provider gives us about the future is a forecast: reset timestamps move when a quota window is refreshed early and unannounced, and a used-percentage is a fraction whose denominator the provider can resize at will. Treating those as ground truth meant a single reading of "used 100%, resets in 29 days" could bench an account for weeks — the work simply waited while the account may have been live within the hour. A forecast may now only *order* the queue; it can no longer stop us from asking. `maxRecheckIntervalMs` (default 10 minutes) caps how long any prediction — a recorded cooldown, a usage window, a reset timestamp — may keep an account from being tried again. A refused request costs no tokens, so re-asking is close to free, and only the account's own answer proves anything.
- **Ranking keeps the old protection.** An account nothing predicts as spent is always tried before one that is only back in the pool because its forecast went stale, and among equals the account that refused longest ago wins. This is what stops the ceiling from turning into a loop between two spent accounts: without it, rotation order alone sent us straight back to the account that had just answered "usage limit reached" while a never-tried account sat further down the ring.

### Fixed

- **Failover no longer bounces back onto an account that refused moments ago.** The existing 60-second anti-ping-pong guard only remembers the single account we left last, so with three or more accounts the rotation could return to a spent one minutes later and loop.

### Tests

- Guarantee #26, with coverage for a month-long forecast no longer parking an account past the ceiling, and for an untried account outranking a freshly-refused one once the ceiling elapses. Verified red→green in isolation: disabling the ceiling fails the first, disabling the ranking fails the second **and** the pre-existing stale-snapshot guarantee — the two halves are load-bearing together.

## [1.15.1] - 2026-08-16

### Fixed

- **A same-account resume now auto-continues on every host without `pi.continueAgent`.** `currentPromptSwitch` is set only when accounts actually rotate, but the pending-resume path deliberately returns to the SAME account — a transient overload, or a cooldown that expired where it started — so it never has a switch record. The injection fallback required one, so on every build since pi-coding-agent 0.80.3 (where seamless resume was removed) that combination silently refused to continue and the session stalled until the user re-sent the prompt by hand. The resume context is now passed explicitly.
- **The stall no longer blames the Pi build.** The warning claimed "switched account, but this Pi build cannot auto-resume" even when no switch had happened and the real cause was elsewhere — a spent auto-continue budget, `autoContinue: false`, or a failed dispatch. A missing `pi.continueAgent` is only why the fallback path is taken, never why the fallback itself declined. The message now states what it knows and points at the recorded reason.
- **Every refused or failed continuation is recorded.** Refusals were entirely silent and the dispatch `catch` swallowed its error, so a session that stopped continuing by itself left nothing in the debug log to explain why. `continuation_injection_blocked` now names the specific reason and `continuation_injection_failed` carries the error.
- **A rejected dispatch can no longer be reported as success.** `pi.sendUserMessage` is async on the host, so a rejected promise escaped the synchronous `try`/`catch` as an unhandled rejection while the injection still returned `true`. The promise is now attached.

### Tests

- Live-harness coverage for a transient overload resuming on a host without `pi.continueAgent` (asserting the continuation is injected as `followUp`, not stalled), and for a blocked continuation naming its real reason. Verified red→green: both fail against the previous behaviour.

## [1.15.0] - 2026-08-16

### Added

- **The interrupted turn now survives the switch.** On a quota failover the turn that triggered the switch is exactly the turn pi-ai refuses to replay: `transform-messages` skips every assistant message with stopReason `error`/`aborted`, and degrades thinking blocks to plain text whenever the next request runs on a different model. The account taking over was therefore told "do not repeat completed work" with the record of that work already deleted, and its tool results left with no originating call. A new `context` hook rewrites each interrupted turn into a verbatim `user` handoff record — the one role `transform-messages` passes through unchanged on every provider — folding in the tool results that belonged to it and flagging every call that never returned. Rendering is deterministic (no timestamps, no rng) so replaying the hook on each request never moves the prompt-cache breakpoint, and every section is hard-capped so rescuing context cannot blow the context window of the account just switched to. Opt out with `preserveInterruptedContext: false`.
- **`continuationPrompt` no longer claims context that was deleted.** The default prompt told the next account the full conversation was still in the session while the interrupted turn had just been dropped. It now points at the `[handoff:interrupted-turn]` record and asks the model to verify state before redoing work.

### Fixed

- **`VERSION` in `index.ts` matched `package.json` again.** It had been left at `1.14.3` through the 1.14.4 and 1.14.5 releases, so `host_capabilities` debug entries and the startup notices reported a stale version.

### Tests

- Added `test/interrupted-context.test.ts`, including an integration assertion that runs the REAL pi-ai `transformMessages` over an interrupted transcript: it asserts the loss first (baseline) and then that reasoning, output, tool calls and folded results all survive a cross-provider switch. Added live-harness coverage in `test/failover.test.ts` for the full path (limit error → account switch → context handoff) and for the `preserveInterruptedContext: false` opt-out.

## [1.14.5] - 2026-08-15

### Fixed

- **Saved scoped models for numbered Codex accounts now survive restart.** Persisted, credential-free model catalogs seed each numbered alias synchronously before Pi resolves saved model scopes. Empty caches and disabled discovery retain the static/host fallback. Contributed by @carlosorch in PR #8; fixes #7.
- **Anthropic and Codex OAuth refresh always receive an `AbortSignal`.** Both legacy and provider-factory pi-ai bridges now forward the host signal, with a bounded fallback for internal refreshes, preventing `AbortSignal.any()` from rejecting `undefined`. Fixes #9.

### Tests

- Added startup-catalog regression coverage and made both legacy and modern OAuth bridge fixtures reject refresh calls that omit an `AbortSignal`.

## [1.14.4] - 2026-08-15

### Security

- Updated the Pi development/runtime dependency graph and pinned transitive `protobufjs` to a patched release; production `npm audit` now reports zero vulnerabilities.

### Changed

- Added a release gate that runs type checks, the hermetic test suite, and a package allowlist/secret-marker check before publication.

## [1.14.3] - 2026-08-02

### Fixed

- **Anthropic OAuth requests carry an up-to-date Claude Code version again.** `CLAUDE_CODE_VERSION`,
  which is baked into the `x-anthropic-billing-header` on every OAuth-marked Anthropic request, had
  been stuck at `2.1.172` while Claude Code shipped `2.1.220` — 48 releases of drift on a value
  Anthropic reads to accept and count those requests. It is now `2.1.220`. This is the only change
  that reaches the published package; everything below is repository plumbing that keeps it from
  happening again.

- **The weekly version check no longer fails silently.** The workflow that exists to prevent exactly
  this drift had failed every Monday since mid-June: it pushed a `chore/claude-code-version-*`
  branch and then died on `gh pr create`, because this repository does not permit GitHub Actions to
  open pull requests. No PR ever appeared, so nobody noticed — three orphan branches accumulated
  instead, and the constant kept drifting.

  It no longer asks for a permission it does not have. It type-checks and tests the bump itself,
  pushes it straight to `main`, opens an **issue** if that push is ever refused, and sweeps up any
  leftover `chore/claude-code-version-*` branch on the way. A renamed or reformatted constant now
  fails CI instead of quietly turning the weekly job into a no-op (guarantee #23).

- **An automated bump can no longer arrive red.** The billing-header test asserted the literal
  `2.1.172`, so the very bump this automation exists to make would have broken CI on arrival. It
  reads the constant from `index.ts` now.

## [1.14.2] - 2026-07-30

### Fixed

- **A per-agent thinking level is no longer clobbered.** `captureDesiredThinking()` ran on every
  `agent_start` and applied the *global* `config.reasoningLevel` (which defaulted to `high` and,
  because the parser fell back to `high` for anything unset or invalid, could not be turned off).
  A delegated agent configured `--thinking low` was therefore flipped to `high` on its very first
  turn — the session recorded `thinking_level_change: low -> high` before the first user message —
  and, because Pi's `setThinkingLevel()` also persists to settings, the override leaked into the
  default level too. Reported and diagnosed in
  [#6](https://github.com/Sarrius/pi-multi-account/pull/6) (thanks @fwhskr, confirmed by
  @julius-retzer).

  The intent is now read from the session itself (`pi.getThinkingLevel()`), so your Pi default,
  `/thinking`, and per-agent `--thinking` all win. The original protection is kept and made
  sharper: a level the *host* clamped down to (because a weaker fallback model caps out lower) is
  recorded as a clamp, never adopted as intent, so it is restored the moment a capable model is
  back — a naive "just read the session level" fix would let a single failover ratchet thinking
  down for the rest of the session. An explicit `/thinking` change between turns is still honoured.

### Changed

- **`reasoningLevel` now defaults to `"auto"`** — follow the session, only restore after switches.
  Setting an explicit level (`"off"`…`"xhigh"`) keeps the old behaviour and *forces* that level on
  every turn, for anyone who wants a hard floor regardless of the session.
- New black-box log kinds `thinking_intent` and `thinking_clamped` make level changes traceable in
  `/multi-account log`.

## [1.14.1] - 2026-07-27

### Fixed

- **A Cursor provider that fails to load can no longer damage the session.** Cursor lives in a
  separate repo, on whatever Node the user runs; a clone that is incompatible with the running
  Node (for example a JSON import newer Node rejects) threw during setup. That rejection escaped
  the fire-and-forget discovery call as an **unhandled rejection** — which Node can turn into a
  process exit — and aborted `session_start` partway, skipping the reset that clears a previous
  session's pending auto-resume. A stale resume surviving into a new session means silently
  restarting work the user never asked to restart. The failure is now contained, logged, and
  reported once; everything else continues.

- **A newly released Claude flagship no longer needs a release of this extension.** The Anthropic
  model list was hard-coded, so when `claude-opus-5` shipped in Pi's registry the extension still
  ranked `claude-opus-4-8` highest and failover stayed on the older model — silently breaking the
  project's hard rule of always using a provider's top model. Claude models known to the host are
  now merged and ranked (tier first, then generation) exactly as Codex models already were, and
  re-registered onto numbered account aliases so they are selectable there too. `claude-opus-5`
  added to the built-in ordering as well.

### Changed

- The invented `gpt-5.6` / `gpt-5.6-mini` entries added in 1.14.0 were removed: OpenAI's real 5.6
  family ships as `gpt-5.6-sol` / `-terra` / `-luna`, and those come from the host registry and the
  live per-account catalog with correct metadata. Guessed ids risk offering a model a plan cannot
  serve and re-introduce the release-per-generation treadmill the 1.14.0 fix removed.

## [1.14.0] - 2026-07-27

### Fixed

- **The extension no longer fails to load** with `undefined is not an object (evaluating
  '_oauth.openaiCodexOAuthProvider.usesCallbackServer')` (issue #3). Two independent causes, both
  closed:
  - `@earendil-works/pi-ai` was only ever probed inside the extension's *own* `node_modules`, so
    every hoisted `npm install` / `pi install` layout — where pi-ai sits next to the package —
    found nothing. Resolution now walks ancestor `node_modules` the way Node does and falls back
    to `require.resolve`.
  - pi-ai 0.80 **removed** the runtime OAuth surface: `dist/oauth.js` is now types-only, `getModel`
    moved to `dist/compat.js`, and the implementations live behind provider factories with a new
    `login(interaction)` / `refresh(credential)` API. Both eras are now normalized behind one
    internal bridge, including an adapter from Pi's legacy OAuth callbacks to pi-ai's
    `AuthInteraction` (this fixes `interaction.notify is not a function` during browser login).
    Diagnosis and the 0.80+ approach contributed by **@lfoscari** (PR #4).

  Loading is now non-fatal in every case: a pi-ai that cannot be adapted degrades to "subscription
  login unavailable" with an actionable message at session start, and API-key accounts keep
  rotating instead of the whole extension dying at startup.

- **A brand-new OpenAI generation no longer needs a release of this extension** (issue #2). The
  built-in model list was consulted *before* the host model registry, so a Pi that already shipped
  `gpt-5.6` still failed over to `gpt-5.5`. Models the host knows about are now merged and ranked
  by version, and re-registered onto numbered account aliases so they are selectable there too.
  The live per-account catalog still outranks everything. `gpt-5.6` / `gpt-5.6-mini` metadata added.

- **Cursor no longer appears in sessions that never asked for it** (issue #5). With
  `includeCursor` on by default but the (separately cloned) Cursor provider absent, the extension
  registered a phantom `cursor-account-2` login slot backed by nothing and printed a `git clone`
  warning at every start. Cursor slots are now created only once the provider is actually on disk,
  and the install instructions appear only on the explicit `/multi-account add cursor` path.
  Cloning the provider is picked up on the next discovery pass — no restart needed.

### Added

- `claude-sonnet-4-6` to the default Anthropic model list — contributed by **@RuslanAsadov** (PR #1).

## [1.13.16] - 2026-07-15

### Added

- **New OpenAI Codex models are discovered automatically per account.** The extension now calls
  OpenAI's authenticated `/backend-api/codex/models` catalog at session start and on explicit
  reload/rediscovery, mirrors each account's selectable models onto its numbered Pi alias, and
  follows the catalog's server-defined priority. The credential-free catalog is cached for five
  minutes and persisted, so transient network failures do not erase a known model. Pi's own model
  registry and the static list remain offline fallbacks. Manual `preferredModels` overrides still
  win when the user deliberately pins an order.
- **High reasoning is now the default contract.** `reasoningLevel` defaults to `"high"`, is applied
  at the start of every turn, and is restored after every account/model switch. Extreme levels
  such as `xhigh` / Max / Ultra are never selected automatically; `xhigh` is available only through
  an explicit config override. Hosts/models with smaller capability clamp safely.

## [1.13.15] - 2026-07-15

### Fixed

- **Plan upgrades, purchased credits, and early provider resets now revive benched accounts.**
  Usage is refreshed independently for every authenticated rotation account at startup and on the
  existing status interval (with the existing per-family TTL and in-flight deduplication). A fresh
  usage response with headroom clears the older cooldown, even when its previous `resetAt` is still
  in the future. This closes the stale `100% Free` trap where an account upgraded to Plus/Pro stayed
  excluded until the old plan's projected reset date because only the currently selected account
  was ever polled.
- **`/multi-account next` is now a true manual override.** It walks the complete account ring in
  rotation order without moving cached-cooling accounts behind every nominally-free provider.
  Automatic failover still avoids known-spent accounts; only the explicit user command ignores
  potentially stale quota metadata. The black-box log now records credential-free `usage_refresh`
  decisions so future stale-limit reports show exactly which account was rechecked and why it stayed
  blocked or became available.

## [1.13.14] - 2026-07-07

### Fixed

- **The quota footer no longer blanks out for the current account.** Two causes: (1) the OAuth
  access token rotates, so the stored usage snapshot's credential hash stopped matching and the
  footer was rejected as stale → for DISPLAY it now falls back to the last stored snapshot (a
  slightly stale "% left" beats an empty footer); (2) a `theme.fg` exception (host theme API drift)
  was silently swallowed by the render guard, wiping the footer → the colouring is now wrapped so
  it always falls back to plain text and still renders. If the footer is still empty after this,
  the info is always available via `/multi-account status` and `/multi-account limits`.

## [1.13.13] - 2026-07-07

### Added

- **Qwen/Alibaba now shows a live status instead of "no usage endpoint".** Alibaba publishes no
  usage/quota API (verified: every usage/billing path 404s and no rate-limit headers come back),
  so a real "% left" is impossible. Instead the footer and `/multi-account status` now show the
  account's real operational state from our own tracking: `available`, `rate-limited · retry in
  <time>` (from a caught 429), or `needs re-login` — colour-coded green/yellow/red.
- **Ollama status now includes the plan tier, renewal date, and suspended flag.** `/api/me`
  carries `Plan`, `SubscriptionPeriodEnd`, and `SuspendedAt`; these are surfaced (e.g. `Ollama |
  pro · renews 2026-07-16`). Ollama still exposes no session/weekly token counters, so those
  remain unavailable — that limit is Ollama's, not ours.

## [1.13.12] - 2026-07-07

### Fixed

- **Qwen/Alibaba turns no longer fail with `400: developer is not one of [...]`.** Pi sends the
  system instructions using the OpenAI-only `developer` role (the o1+/Codex convention), but
  Qwen's OpenAI-compatible endpoint only accepts `system`, `assistant`, `user`, `tool`,
  `function`. A `before_provider_request` shaper now rewrites `developer` → `system` for
  qwen-family providers only (Codex/OpenAI, which DO support `developer`, are left untouched).
  With a valid Model Studio (International/Singapore) key, Qwen now completes turns normally.

## [1.13.11] - 2026-07-07

### Fixed

- **A session/rate limit the usage-% window can't see is no longer hot-retried every second.**
  The usage endpoint reports an account's QUOTA window; it does not reflect session or rate
  limits. So a session-limited account kept returning 429 "usage limit has been reached" while
  usage still showed headroom. Because v1.13.7 made usage "ground truth", the account was
  reported *free now* — the pending resume scheduled a ~1s retry, got 429 again, and looped,
  while the displayed cooldown said hours (`retry automatically in ~1s` next to `Cooldowns:
  openai-codex: 2h 3m`). Now a **repeat** limit error (two in a row, no success between) marks
  that account's usage reading as untrusted for a while, so its real recorded cooldown sticks
  instead of being cleared — the session waits for the true recovery and polls, rather than
  hammering a maxed account. The genuine "over-estimated cooldown, usage shows the window really
  reset" fast-path is preserved (it only takes effect on the FIRST error).
- **`/multi-account switch <provider>` now revives a stuck invalidation instead of refusing.**
  An account could stay invalidated long after its cause was gone — e.g. it was killed by the
  wrong Qwen endpoint (fixed in 1.13.10), and because `markInvalid` records the key's hash, the
  hash-based auto-revive never fires while the key is unchanged. `switch alibaba` then answered
  "no usable model … make sure it is logged in" for a perfectly good key. A manual switch is an
  explicit user override: it now clears any stale invalidation and cooldown for the target,
  reloads auth, forces re-discovery, and selects the account — with a clearer message that
  distinguishes "logged in but the host exposes no model yet" from "no credentials in auth.json".

## [1.13.10] - 2026-07-07

### Fixed

- **Auto-continue after a switch no longer silently dies with "Agent is already processing".** The
  continuation-prompt injection called `pi.sendUserMessage(prompt)` with no delivery option, so when
  it fired while the previous turn was still streaming — exactly the race right after a failover
  switch — the host rejected it with *"Agent is already processing. Specify streamingBehavior
  ('steer' or 'followUp')"* and the continuation was lost. It now passes `{ deliverAs: "followUp" }`
  (the extension-facing option the host maps to `streamingBehavior`), so the continuation is QUEUED
  to run after the current turn settles. Locked with a test asserting the option is present.
- **A genuinely-spent account is benched from its usage endpoint even if it never threw an error.**
  Selection used to treat an account with no *recorded* cooldown as available, so right after one
  account hit its limit, failover would hop to the next Codex slot that was *also* maxed (its 100%
  state known only from usage, not from a cooldown) and burn a request there instead of jumping
  straight to a live account. Two changes: `providerRecoveryAt` now trusts a hard block (a usage
  window ≥100% with a future reset) as authoritative *regardless of snapshot age* — a maxed 30-day
  window cannot recover in the minutes since the last probe — and `storeUsage` records the cooldown
  proactively the moment any probe reports the block. "Available now" is still only trusted while the
  snapshot is fresh, so a stale pre-limit reading can never clear a real cooldown early.
- **A valid Qwen/Alibaba key is no longer misread as invalid (false 401 → wrongful eviction).** The
  default Qwen endpoint was `token-plan.ap-southeast-1.maas.aliyuncs.com`, a promo "token plan"
  endpoint that accepts the key on `/models` but returns `401 invalid_api_key` on `/chat/completions`
  once the plan lapses — so a perfectly good key looked invalid and the account was dropped from
  rotation ("worked yesterday, fails today"). Switched the default to the standard International
  endpoint `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`, verified with a live request
  returning 200 for the same key.

## [1.13.9] - 2026-07-07

### Fixed

- **Failover now actually resumes on hosts without `pi.continueAgent()` — no more dead-end
  "Update @earendil-works/pi-coding-agent" error.** The seamless in-place resume relies on
  `pi.continueAgent()`, but the shipped runtime (`@earendil-works/pi-coding-agent` 0.80.3) does
  not expose it to extensions. The old code detected the missing method and gave up with a red
  error, so after every provider switch the turn stalled and the user had to reload by hand — the
  switch happened but the work never continued. It now degrades gracefully: when `continueAgent`
  is unavailable it injects the continuation prompt as a fresh user turn (the same fallback already
  used when the transcript tail is a completed assistant message), so the session keeps moving by
  itself on the account it just switched to. Factored the injection into one `injectContinuationPrompt`
  helper shared by both paths.
- **Genuinely spent monthly Codex accounts are benched for their REAL reset, so rotation advances
  to Qwen/Ollama instead of ping-ponging between exhausted Codex slots.** `providerRecoveryAt` now
  treats fresh usage-endpoint data as authoritative ground truth in BOTH directions: a maxed
  long/rolling window (e.g. a free-tier Codex monthly limit at 100%) reports a real far-out reset,
  and we trust it rather than letting the 6h re-probe cap keep un-benching the account every 6h.
  That cap kept exhausted accounts looking "available soon", so auto-failover cycled
  `account-3 ↔ account-4` forever and never reached a healthy Alibaba/Ollama account. The 6h clamp
  still guards *error-text* estimates (`markExhausted` / `pruneCooldowns`); only the recovery time
  computed for selection from live usage is affected.
- **Startup host-capability preflight — the recurring "pi changed its API from under us" class is
  now caught loudly at load instead of weeks later under fire.** Every session start probes the REAL
  `pi` object for the methods failover depends on (`setModel`, `sendUserMessage`, `continueAgent`,
  `registerProvider`, …), records them in the debug log (`host_capabilities`, dated, with the running
  version), and — once per process — tells the user in plain terms if switching is impossible
  (`setModel` gone → error), if auto-continue is impossible (neither resume method → warning), or if
  only the seamless path is missing (continueAgent gone → info: failover still works via injection).
  Unit tests mock `pi` and always implement every method, so they can NEVER catch this drift; the
  preflight is what turns a silent boundary regression into an immediate, self-diagnosing message.
- Regression tests added (fail on the old code, pass on the new): a host with no `pi.continueAgent`
  still auto-continues via prompt injection; a session whose two Codex accounts are both at 100%
  monthly fails over to the healthy Qwen account instead of ping-ponging; and the preflight flags a
  continueAgent-less host as an expected fallback, warns when no resume path exists, and stays silent
  on a fully-capable host.

## [1.13.8] - 2026-07-06

### Fixed

- **Failover never silently downgrades the model, and `/multi-account next` cycles
  through every account.** Two related bugs made the rotation misbehave:
  - **Model flap / silent downgrade.** Each account was expanded into *one candidate per
    model* it exposes (`gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, …). So a failover could drop
    to a weaker model of the *same* account, and repeated `/multi-account next` ping-ponged
    e.g. `gpt-5.4 ↔ gpt-5.4-mini`. Now each account contributes exactly **one candidate —
    its newest/flagship model**. The model is only ever demoted when the flagship is
    *individually* unavailable (a genuine "model unavailable" error), never to dodge a
    provider-level usage limit and never to fill the rotation. The most powerful model of
    every provider is always the one offered. A single-account session whose flagship is
    unavailable now holds its model and reports "nothing better to move to" instead of
    flapping down to a mini model.
  - **Rotation collapsed onto one provider.** Manual `/multi-account next` recorded a
    **5-minute cooldown on the account it left**. After one lap every account was "cooling"
    and the round-robin collapsed onto whatever remained (typically the one openai slot).
    Manual rotation is a user override, not a rate-limit event, so it no longer records any
    cooldown — every account stays selectable and repeated `next` truly cycles through all
    of them.
  - As a consequence of one-candidate-per-account, the "same account just recovered → resume
    on it" path now also covers the empty-candidate case, so a single-account session still
    resumes immediately when fresh usage shows its cooldown was over-estimated (it no longer
    depended on a weaker sibling model being in the queue).

## [1.13.7] - 2026-07-04

### Fixed

- **Bogus weeks-long cooldowns no longer evict a live account from rotation.** When a
  Codex account maxed a long *rolling* limit window (weekly/monthly), the reset time
  of that window (or a mis-parsed `resets_at`) was recorded literally as the account's
  cooldown — e.g. `openai-codex-account-2` was locked until **2026-08-03 (30 days)** and
  `openai-codex-account-3` until 2026-07-21. Because cooling-down accounts are never
  re-probed, the estimate was a dead end: a perfectly healthy account (its short/primary
  window already free) sat out of rotation for weeks, producing "no immediately available
  fallback" even though fallbacks existed. Three-layer fix:
  - `resolveLimitCooldownMs` now treats **fresh usage as ground truth**: if the usage probe
    says the primary window has headroom (`usageMs === 0`), the account is available *now* and
    the pessimistic error-text estimate is discarded (previously the `> 0` filter dropped the
    `0` and a stale 30-day `resets_at` won the `Math.max`).
  - New `MAX_LIVE_COOLDOWN_MS` (6h) caps **any** live-parsed cooldown at record time
    (`markExhausted`) — no single estimate can lock an account longer than one re-probe cycle.
  - Persisted far-future cooldowns are **clamped on load and in `pruneCooldowns`**, so an
    already-poisoned state file self-heals on the next restart without `/multi-account reset`.
- **`VERSION` constant was stuck at `1.13.5`.** It was never bumped for the 1.13.6 release, so
  every on-screen `[v1.13.5]` failover tag under-reported the actually-running code — defeating
  the version stamp whose entire purpose is to tell a live window from a stale one. Now `1.13.7`.

## [1.13.6] - 2026-07-04

### Fixed

- **API-key providers no longer loop forever on a dead key.** A bare `401
  Unauthorized` from a non-refreshable provider (Ollama Cloud, Alibaba, OpenRouter)
  was treated as transient: the same key kept getting 1-minute cooldowns but the
  consecutive-failure counter never advanced (same-hash repeats were deliberately
  ignored to avoid false kills on OAuth refresh faults). This created an infinite
  loop — the account was never invalidated, never told the user to re-login, and
  consumed the entire fallback rotation one retry at a time. Now, for
  non-refreshable (API-key) providers, repeated same-key 401s advance a separate
  `MAX_SAME_KEY_AUTH_FAILURES` (3) counter and invalidate the slot after 3
  consecutive failures. OAuth providers are unaffected — same-hash 401s on a
  refreshable account still only re-arm the transient cooldown (refresh-fault
  tolerance preserved). Regression test locks both paths.

- **Re-login now clears stale 401-streak tracking for transient-cooldown accounts.**
  Previously, `clearReauthedInvalidations()` only cleared `authFailures` for
  accounts in `invalidatedByProvider`. An account on transient cooldown (not
  invalidated) kept its stale `authFailures` entry after the user re-logged in with
  new credentials, so the next 401 inherited the old failure count and could
  invalidate prematurely or loop. Now `refreshDiscovery()` clears `authFailures`
  when: (a) the stable account fingerprint changes (different real account —
  re-login to a new slot), and (b) the credential hash changes for a
  non-refreshable (API-key) provider (user manually replaced the key). OAuth
  token rotations (routine Pi refresh) do NOT clear the streak — the 401 counter
  must survive so rotated-token failures can still accumulate toward the kill
  threshold. Regression test locks the re-login fresh-start path.

## [1.13.5] - 2026-07-01

### Fixed

- **A "still busy" auto-retry no longer downgrades the model.** When a resumed turn had
  not gone idle in time, the auto-retry treated the current model as failed and rotated to
  an older sibling on the SAME account — the reported `openai-codex-account-4/gpt-5.5 →
  openai-codex-account-4/gpt-5.4 (previous turn was still busy; auto-retry)`. But a
  "still busy" state is a timing issue, not a model failure, and a same-account switch
  shares the same quota pool, so the downgrade escaped nothing and only lost quality. The
  busy auto-retry now resumes the **same** model (waiting for it if the account is briefly
  cooling), exactly like a transient-server-error retry. Regression test locks it
  (proved red→green: without the fix the resume produced `gpt-5.5 → gpt-5.4`).

## [1.13.4] - 2026-07-01

### Fixed

- **Never silently downgrade the model during a rotation.** When failover switched
  accounts, the newest model (e.g. `gpt-5.5`) could be dropped in favour of an older one
  (`gpt-5.4`) on a nearer account. Root cause: fallback candidates were ranked only by
  account rotation index and cooldown — model recency was not part of the ranking at all,
  so an older model on a lower-index account beat the newest model on a healthy account.
  Now, when `preferLatestModel` is on (the default), model recency is the **primary**
  tiebreak: the latest available model wins across accounts, and rotation order only
  breaks ties between equally-new models. Regression test locks the behaviour
  (proved red→green).

## [1.13.3] - 2026-06-30

### Fixed

- **Fail over when your ACTIVE model is on an unmanaged provider** (e.g. a plain
  `openai` API key that returns "You exceeded your current quota / insufficient_quota").
  Previously the extension only reacted to errors from providers it manages
  (`anthropic`, `openai-codex`, `qwen`, `ollama`, `cursor`), so a quota error on a plain
  `openai` model was ignored and no rotation happened. Now, if the model you are
  currently using hits a limit/auth/quota error — even on an unmanaged provider — the
  task is rescued by switching to a managed account (short model-scoped cooldown; the
  unmanaged provider's lifecycle is left untouched). Background errors from unrelated
  providers you are NOT on are still ignored, so nothing gets hijacked.

## [1.13.2] - 2026-06-29

### Fixed

- **Always use the newest model; never stay downgraded.** Once a turn dropped to an
  older model (e.g. `gpt-5.4` after a momentary limit or model-cooldown on `gpt-5.5`),
  the "keep the current model across same-family switches" logic carried the old model
  forward forever. Failover now tries the newest preferred model **first**, so it
  upgrades back to the latest the moment it is available again. New config
  `preferLatestModel` (default `true`); set `false` for the old keep-current behavior.

### Added

- **`preferredModels` config** — pin the newest model per provider without a code
  change, e.g. `"preferredModels": { "openai-codex": ["gpt-5.6","gpt-5.5"] }`. Keys:
  `anthropic`, `openai-codex`, `cursor`, `qwen`, `ollama`. Newest first.
- **`/multi-account models`** — shows, per account, the model order the extension would
  use (★ = selected), so you can see at a glance whether the latest model is available
  and chosen everywhere.

## [1.13.1] - 2026-06-29

### Changed

- **Failover messages now carry the running version**, e.g.
  `Provider failover [v1.13.1]: openai-codex → openai-codex-account-2 (...)`.
  A running Pi keeps the extension code it started with, so restarting one window
  does not update others — and an old window silently shows old behavior. Now the
  version is printed in the exact messages you read when something goes wrong: if a
  failover message has **no** `[v…]` tag (or an older number), that window is running
  stale code and must be restarted. This is the single biggest source of "I fixed it
  but it still breaks" confusion. Stamped on the switch, stuck-recovery, bounded-wait,
  and breaker messages.

## [1.13.0] - 2026-06-29

Reliability floor: turn "it just sits there spinning" and "I have to re-type the
prompt" into automatic recovery, and guarantee the extension can never be *worse*
than switching accounts by hand.

### Changed

- **The stuck-resume watchdog now ACTS instead of only warning.** When a resumed
  turn goes silent past `stuckWatchdogMs` (and no tool is running), it auto-cancels
  the wedged turn and arms auto-resume, which continues the work the moment any
  account frees up. You no longer have to press Esc and re-type the prompt. Opt out
  with `autoRecoverStuck: false` (reverts to notify-only).
- **A running build/test is never mistaken for a wedge.** Tool start/stop is tracked,
  so a long silent `xcodebuild`/test command is left alone.
- **The bounded idle-wait now schedules the retry it promised** instead of just
  saying it would.
- **Un-continuable resumes self-heal.** If the transcript tail can't be continued
  (e.g. after a recovery abort), the extension injects the continuation prompt as a
  message so work proceeds — bounded by `maxAutoContinuesPerPrompt`, never a loop.

### Added

- **Circuit breaker (the reliability floor).** If automatic recovery fails
  `BREAKER_FAILURE_THRESHOLD` (3) times in a row, the extension drops to *advisory
  mode* for 10 min: it still flags rate limits and switches you to a fresh account,
  but stops attempting the auto-continue that was failing — so a bad state can never
  spiral into repeated hangs. It closes again on the first successful response, a new
  user prompt, or `/multi-account reset`. Visible in `/multi-account status`.
- **Black box decision log.** Every meaningful decision (assistant error + how it was
  classified, account switch, no-fallback, resume start/ok/stuck, watchdog action,
  breaker open/close, compaction routing, internal errors) is appended to
  `~/.pi/agent/provider-failover-debug.log`. This turns "it broke again" into a
  precise, reproducible trail — the basis for fixing real-world bugs that unit tests
  can't reach. Bounded size (one rotation at 4 MB), credential-free with defensive
  token redaction. View with `/multi-account log [N]`; toggle with `log on|off`.
- New config keys `autoRecoverStuck` (default `true`) and `debugLog` (default `true`).

> Fully restart Pi (not `/reload`); confirm `/multi-account status` shows **v1.13.0**.

## [1.12.0] - 2026-06-29

Robustness pass: the two ways a failover could silently freeze the session are
now fixed at the root, plus a generic watchdog so any *future* stall surfaces as
an actionable message instead of an endless "Working…" spinner.

### Fixed

- **No more `Cannot continue from message role: assistant`.** After a switch, the
  pending `currentPromptSwitch` was never cleared on a *successful* turn, so a
  later `agent_end` re-dispatched a resume when there was nothing to continue —
  `pi.continueAgent()` then threw that cryptic red error into the transcript. The
  extension now only resumes when the turn actually ended in an **error** it can
  continue from; a non-error end clears the switch. (This was the unexplained
  first error users saw above a stuck spinner.)
- **Compaction survives account exhaustion.** New `session_before_compact` handler:
  when the active account is rate-limited/invalidated and Pi needs to summarize
  (context overflow or threshold), the summary is generated on a **healthy
  fallback account** instead of dying on the dead one. This was the "rotated and
  then it just hangs at high context" freeze. Strictly fail-safe — falls back to
  Pi's default compaction whenever it cannot positively do better.
- **No unbounded waits.** `resumeWithExistingContext()` replaced its infinite
  `while (!isIdle)` busy-loop with a bounded wait (`resumeIdleTimeoutMs`, default
  90s) that retries later instead of wedging, and the routed compaction call is
  bounded by a 150s timeout.
- **Never resume onto a still-cooling account.** Before continuing, the extension
  reconciles live usage; if the just-switched-to account is itself spent (its 5h
  limit only became visible after a usage refresh), it pauses for the first
  account that *actually* recovers instead of burning a request / wedging.

### Added

- **Forward-progress watchdog.** A resumed turn that shows no activity (no stream
  token, tool event, or provider response) for `stuckWatchdogMs` (default 180s)
  raises a clear, actionable notice — *press Esc, then `/multi-account next` or
  `/compact`* — and re-checks periodically, so a silent wedge can never again look
  like normal "working".
- **`/multi-account status`** now shows the resume-watchdog state, compaction
  routing mode, and the last context-overflow time.
- New config keys: `routeCompactionToHealthyAccount` (default `true`),
  `resumeIdleTimeoutMs`, `stuckWatchdogMs`.

### Hardened (systemic — covers whole classes of failure, not just the bugs above)

Rather than patch individual crashes, the entire surface is now fail-safe by
construction:

- **Every one of the ~12 Pi event handlers is crash-isolated** (`safeOn`). A throw
  or async rejection anywhere — a host payload-shape change, a formatter edge case,
  a null deref we never imagined — is reported once and swallowed, the failover step
  is skipped, and Pi keeps running. Node aborts the whole process on an unhandled
  rejection; this removes that entire class of "the extension took Pi down with it".
- **Every background timer/async task is wrapped** (`runBackground`): the usage
  footer interval, the pending-resume wake, the queued-input wake, and every
  fire-and-forget `refreshUsage` can no longer leak an unhandled rejection.
- **Error reports are deduped** (same fault ≤ once / 30 s) so a repeating internal
  fault can never become a notification storm, and the dedupe map is capped.
- **All persistence is best-effort.** `saveState` and the footer renderer can no
  longer throw out of the code path they run in (locked/*read-only*/full disk, a
  theme-shape change) — in-memory state stays correct and failover continues.
- **Timers are `unref`'d** so a pending wake can never keep the process alive after
  the session ends.

> After updating you **must fully restart Pi** (not `/reload`) for the new code to
> load; confirm `/multi-account status` shows **v1.12.0**.

## [1.11.0] - 2026-06-28

### Added

- **`/multi-account remove`** — symmetric counterpart to `add`. Pass a family
  (`anthropic`, `codex`, `cursor`, `ollama`, `qwen`) to drop the highest numbered
  authed alias slot, or pass a full provider id (e.g. `openai-codex-account-3`)
  to remove that exact account from `auth.json`, clear its failover state, and
  refresh rotation. Aliases: `rm`, `delete`.

## [1.10.2] - 2026-06-26

### Fixed

- **Cross-provider failover no longer reuses the source model id on the target
  provider.** Switching from Anthropic/Cursor/Ollama to Codex (or any other family)
  now picks that family's default model (e.g. `gpt-5.5`) instead of trying
  `claude-opus-4-8` on Codex, which caused confusing resumes and activation
  failures.
- **Account selection now honours live usage when deciding if a slot is available.**
  `findFallbackModels()` and `isCurrentModelReady()` use `providerRecoveryAt()`
  (recorded cooldown reconciled against fresh usage) instead of blindly trusting
  stale `exhaustedUntilByProvider` timestamps. Accounts with valid tokens whose
  usage endpoint says they are free are selectable again.
- **Failover continuation is queued immediately after a successful switch in
  `message_end`,** not only from `agent_end`. This removes a race where Pi could
  end the turn before `currentPromptSwitch` was armed, leaving the next account
  idle or starting from the wrong place.
- **`before_agent_start` no longer runs `ensureReadyModel()` for extension-owned
  continuation prompts,** so the failover target is not re-switched away before
  the resumed turn starts.
- **Continuation prompts now restate the original user task** captured at the
  start of the interrupted turn, so the replacement provider knows what to
  continue instead of guessing from a generic "keep going" message.

## [1.9.3] - 2026-06-21

### Fixed

- **`/multi-account clear` now removes alias slots from auth.json.** Previously
  `clear` only wiped the fallbacks config and state, but left
  `anthropic-account-2`, `openai-codex-account-N`, etc. in `auth.json` — so
  `/multi-account add` offered account-3 instead of starting fresh at
  account-2. `clear` now deletes every `-account-N` entry from `auth.json`,
  resets `registeredSlots`, and reloads host auth so the next `add` starts
  clean.

## [1.9.2] - 2026-06-21

### Added

- **`/multi-account clear`** — wipe all fallbacks, cooldowns, invalidations,
  usage snapshots, pending work and rotation state so the user can rebuild
  the fallback list from scratch. The `fallbacks` array in
  `provider-failover.json` is reset to `[]` on disk; re-add accounts to
  `auth.json` and run `/multi-account rediscover` to repopulate.

## [1.9.1] - 2026-06-21

### Fixed

- **Ollama/Alibaba not picked up by Pi.** The extension expected Pi to register
  the base `ollama`/`alibaba` providers natively from `models.json`, but if the
  `apiKey` field there was a placeholder (e.g. `"ollama"`), Pi never exposed the
  provider to `modelRegistry` — so `resolveTargets()` returned `[]` and the
  family never failovered. The extension now registers the base API-key
  provider itself (with the real key from `auth.json`) via
  `ensureApiKeyBaseProvider()`, making Ollama and Alibaba/Qwen first-class
  rotation members.
- **`pi.registerProvider` error for spare API-key slots.** API-key families
  (ollama, qwen) no longer auto-register a spare slot — there is no
  interactive `/login` for them, so an empty spare triggered Pi's
  `"apiKey or oauth is required when defining models"` error.
- **Test flake: api_key transient cooldown assertion.** Relaxed the sub-minute
  bound to sub-2min to accommodate `markExhausted`'s 1-second floor.

## [1.9.0] - 2026-06-21

### Fixed

- **False permanent invalidation of live OAuth accounts.** A single transient
  401 burst from OpenAI Codex (one physical event surfaced as three error hooks)
  hit `MAX_CONSECUTIVE_AUTH_FAILURES = 3` instantly and permanently killed a
  live account for a year, even while a parallel Pi session was successfully
  using the same token. The threshold is raised to 8 and the dedup logic now
  ignores same-hash repeat failures (refresh didn't reach the wire), so only
  genuinely distinct refreshed-token failures advance the kill counter.
- **`refresh_token_invalidated` / `session has ended` no longer treated as
  terminal.** OpenAI Codex returns these transiently under load. They are now
  classified as transient — the account gets a short cooldown and the next
  attempt can still refresh. Only `invalid_grant` and `revoked` remain terminal.
- **365-day "cooldown" entries removed.** `markInvalid` no longer writes a
  year-long entry into `exhaustedUntilByProvider` — that polluted cooldown
  displays ("Cooldowns: account-2: 8696h") and confused users into thinking
  dead accounts were rate-limited. Invalidated providers are reported
  separately. `switchToFallback` no longer applies `invalidCooldownMs` to a
  killed account (it's already in `invalidatedByProvider`).
- **API-key providers (Ollama, Alibaba) survive a bare 401.** Previously a
  single 401 on an api_key provider immediately invalidated it for a year.
  Now only explicit terminal patterns (`invalid api key`, `incorrect api key`,
  `revoked`) kill the slot; a bare 401 gets a transient cooldown and the same
  consecutive-failure accounting as OAuth.
- **Warning messages separate invalidated from cooldowns.** The "no
  immediately available fallback" warning no longer lists dead accounts with
  8696h timers — they're shown as `Invalidated (need re-login)`.

### Added

- **Multi-account support for Ollama and Alibaba/Qwen.** API-key providers
  now support numbered alias slots (`ollama-account-2`, `alibaba-account-3`,
  …) exactly like OAuth providers. Each slot is a separate API key in
  `auth.json` and joins the rotation automatically. `/multi-account add
  ollama|qwen` registers the next free slot.
- **`/multi-account revive <provider|all>`** — clear a false invalidation
  and return an account to rotation without wiping all state (unlike `reset`).
- **Ollama (GLM-5.2) and Alibaba (Qwen3.7-Max) in the default rotation.**
  `classifyProvider` recognizes `ollama-account-N` and `alibaba-account-N`;
  `resolveTargets` knows the preferred models for each family.

### Changed

- `DEFAULT_QWEN_MODELS = ["qwen3.7-max", "qwen-max", "qwen-plus"]`.
- `slotId` and `syncRegisteredSlots` generalized to all four provider
  families. API-key families skip the "spare slot" auto-registration (no
  interactive login) to avoid Pi's "apiKey or oauth required" error.

## [1.8.0] - 2026-06-20

### Fixed

- **Failover no longer triggers for unmanaged providers.** Previously, a
  rate-limit (429) or quota error on *any* provider — including ones this
  extension does not manage (Ollama, OpenRouter, DeepSeek, etc.) — triggered
  the failover logic and switched the user to an unrelated managed account.
  The `message_end` and `after_provider_response` handlers now check
  `classifyProvider()` before reacting, so only errors from anthropic,
  openai-codex, qwen, or ollama providers activate failover.
- **No more false “all limits exhausted” from setModel failures.** When
  `activateFallback` tried to switch to a fallback account and the
  `pi.setModel()` call failed (for any reason — model not found, SDK error,
  etc.), it called `markExhausted()` on that account. If several candidates
  failed in a row, *all* managed accounts appeared exhausted in the status
  even though none had actually hit a limit. setModel failures now simply skip
  the candidate for the current attempt without persisting a cooldown.

### Added

- **Ollama provider support.** Ollama is now a first-class provider family in
  the rotation, alongside Anthropic, OpenAI Codex, and Qwen. The default
  model is `glm-5.2:cloud`. Enable/disable with the `includeOllama` config
  option (default `true`).

## [1.7.0] - 2026-06-13

### Fixed

- **Cooldowns no longer reset on routine OAuth token refresh.** A rate-limit
  cooldown was keyed to the credential blob, so the periodic access-token refresh
  that Pi performs looked like a re-login and wiped the cooldown — the still-limited
  account was then re-selected and instantly hit the same 429. Cooldowns now clear
  only when the slot is genuinely re-logged into a *different* real account (stable
  account fingerprint changes); a token rotation keeps the recovery time intact.
- **`/multi-account next` now cycles through every account.** It walked to the
  account with the shortest remaining cooldown, which made repeated presses bounce
  between just the two soonest-to-recover accounts and never reach the rest of the
  rotation. It now round-robins forward from the current account (offering any
  account that is free *right now* first), so each press advances through all slots.
- **Paused sessions resume on the first account that *actually* recovers.** While
  every account is cooling down the session now re-checks availability on a short
  poll instead of sleeping on a single multi-hour estimate, and it reconciles each
  cooling account against its live usage endpoint. An account whose real limit reset
  earlier than the recorded estimate (or that a parallel `/login` freed) now picks
  the work back up promptly instead of waiting out a stale countdown.
- Wait-time messages show an honest duration (e.g. `2h 20m`) instead of rounding
  up to a misleading whole hour (`~3h`).

### Added

- `pendingPollMs` config option (default 60s): how often a paused session re-checks
  account availability while waiting for a cooldown to clear.

## [1.6.0] - 2026-06-13

### Added

- Persistent Pi footer status for the active Codex or Anthropic OAuth account,
  showing remaining 5-hour and 7-day allowance with reset countdowns.
- `/multi-account limits [refresh]` (also `usage` and `quota`) for detailed
  active-account percentages, reset timestamps, plan, and Codex credits.
- Provider usage caching keyed by credential fingerprint. Codex response
  headers refresh the cache without another request; direct usage calls are
  deduplicated and Anthropic polling is limited to at most once per 10 minutes.

## [1.5.0] - 2026-06-11

### Fixed

- Failover decisions now happen only on the final assistant error. Intermediate
  provider HTTP retries can contribute reset metadata but can no longer switch
  the active model or falsely blame the next account.
- A physical 401 is counted once instead of once in each response, message, and
  agent hook. Version-3 one-year invalidations created by that bug are removed
  during state migration.
- Continuations queued from `agent_end` now use Pi's required `followUp`
  delivery mode while the agent is still active.
- Manual model selection no longer permanently disables failover when that
  selected model later returns a real final limit.
- Explicit fallback lists and auto-discovery now share real-account
  deduplication. Codex slots use the stable `accountId` stored by Pi.
- New logins that provably duplicate an existing real account are rejected, and
  already-present duplicate slots are reported and omitted from rotation.
- A fallback whose `setModel()` has no usable authorization is invalidated and
  skipped without preventing the next candidate from being tried.
- Anthropic OAuth request shaping now identifies as the locally installed
  Claude Code `2.1.172` instead of the stale `2.1.150` billing-header version.
- Explicit provider verdicts such as `authentication token has been
  invalidated` now force-refresh the access token even before its local expiry.
  A permanently invalid refresh token removes the account and prints the
  interactive `/login` recovery steps.
- Slash commands and shell shortcuts bypass the all-accounts-cooling input
  queue, so `/login` and other recovery commands remain usable.
- Consecutive account failures in one continuation chain are handled
  independently; a previous switch no longer hides the next account's error.
- Manual `/multi-account next` can deliberately probe the next account even
  when every fallback has a recorded cooldown, without arming an automatic
  continuation.

### Added

- Session-bound delayed resume: when every account is cooling down, an open Pi
  session retries at the earliest known recovery and continues the task.
- `/multi-account stop` to abort and cancel the current failover/resume chain.
- State-machine tests covering retry ordering, final-error deduplication,
  authoritative message providers, duplicate accounts, failed model selection,
  continuation caps, cancellation, migration, and delayed resume.

## [1.4.0] - 2026-06-10

### Fixed

- **A single 401 no longer drops an account that still has valid tokens.** A 401 on
  an OAuth account usually just means the access token needs a refresh (Pi refreshes
  on the next call). Previously the first 401 permanently invalidated the account
  (≈1-year cooldown until re-login) and yanked you onto another — often broken —
  account. Now a refreshable account is given a brief cooldown and retried; it is
  only marked dead after 3 consecutive 401s with no success in between. A
  non-refreshable (API-key) 401 is still treated as immediately fatal.
- Any successful response clears that account's 401 streak.

### Added

- Tests for transient-401 tolerance, the consecutive-401 kill threshold, and
  success-resets-streak (suite now 17 tests).

## [1.3.0] - 2026-06-10

### Fixed

- **Manual model/account selection is now respected.** Picking a model (e.g. Opus
  on another account) no longer gets auto-yanked onto a different provider on the
  next rate limit — the failover stays put and tells you, until you switch with
  `/model` or `/multi-account next`. The pin auto-releases after a successful
  response on that provider.
- **No more self-resurrecting work.** All background resume timers were removed:
  continuation now happens only synchronously inside an active turn, so Esc and
  quitting always stop it. When every account is rate-limited the failover STOPS
  and asks you to retry, instead of churning between exhausted accounts.
- **No more "Agent is already processing" / "Cannot continue from message role:
  assistant".** Continuations are sent only when the agent is idle and not aborting.

### Added

- Test suite (`npm test`) covering the failover edge cases: limit/401 failover,
  all-accounts-exhausted stop, Esc/abort, manual-selection pinning, idle gating,
  Anthropic OAuth shaping idempotency, and session shutdown. Wired into CI.

## [1.2.0] - 2026-06-10

### Added

- **Anthropic (Claude Pro/Max) OAuth now works out of the box.** OAuth login is
  enabled on the base `anthropic` provider and on every `anthropic-account-*`
  alias, and outgoing Anthropic OAuth requests are shaped (billing header +
  system-prompt normalization) directly by this package. A separate
  `pi-anthropic-auth` install is no longer required.

### Changed

- Request shaping is idempotent and only touches OAuth-marked Anthropic requests,
  so it coexists safely with `pi-anthropic-auth` if both are installed, and leaves
  API-key Anthropic and OpenAI Codex / Qwen requests untouched.

### Credits

- Anthropic OAuth request-shaping logic vendored from
  [`gotgenes/pi-anthropic-auth`](https://github.com/gotgenes/pi-anthropic-auth) (MIT).

## [1.1.0] - 2026-06-10

### Fixed

- **Runaway failover loop that could freeze the machine.** When every account was
  rate-limited the rotation ping-ponged between accounts every 1–9s indefinitely,
  growing session history until the system swapped itself to death. The
  auto-continue counter was reset on every agent start, so `maxAutoContinuesPerPrompt`
  never actually bounded the loop. The counter is now reset only by a genuine new
  user prompt, making the cap a real per-task limit.
- **Escape did not stop the loop.** Auto-continuation ran from background event
  hooks and a timer, so cancelling the agent was immediately undone. User aborts
  (`stopReason: "aborted"` / `ctx.signal`) now stop the chain and cancel all timers.

### Added

- Anti-ping-pong guard: immediate failover only switches to an account usable right
  now and never bounces straight back to the account it just left within 60s.
- Minimum 15s spacing between auto-continuations (no tight CPU/network loop, and a
  real window for Esc to take effect).
- In-session auto-resume: when the whole fallback circle is exhausted, the extension
  waits and continues the agent's work as soon as any account recovers — for as long
  as the session stays open.

### Changed

- **Tight session binding.** Background activity is now scoped to the live session:
  ending or replacing a session (quit, reload, new, resume, fork) cancels all timers
  and drops any pending resume. A new session starts clean and never inherits a
  previous session's paused work; nothing survives once Pi exits.

## [1.0.0] - 2026-06-09

### Added

- Initial public release.
- Automatic multi-account failover & rotation across Anthropic (Claude),
  OpenAI / ChatGPT Codex, and Qwen / Alibaba.
- Auto-discovery of authenticated accounts from `~/.pi/agent/auth.json`; the
  rotation grows on login and drops accounts on logout, token expiry, or
  authorization errors.
- Quota / rate-limit failover with provider-reset-aware cooldowns and circular
  fallback ordering.
- Optional auto-continue of the interrupted task after a switch.
- Thinking-level preservation across model switches.
- Commands `/multi-account`, `/provider-failover`, `/failover` with
  `status | rediscover | add | next | reset | reload | enable | disable`.
- Plaintext-free credential handling (SHA-256 fingerprints only); `0600`
  config/state files.

[1.6.0]: https://github.com/Sarrius/pi-multi-account/releases/tag/v1.6.0
[1.5.0]: https://github.com/Sarrius/pi-multi-account/releases/tag/v1.5.0
[1.4.0]: https://github.com/Sarrius/pi-multi-account/releases/tag/v1.4.0
[1.3.0]: https://github.com/Sarrius/pi-multi-account/releases/tag/v1.3.0
[1.2.0]: https://github.com/Sarrius/pi-multi-account/releases/tag/v1.2.0
[1.1.0]: https://github.com/Sarrius/pi-multi-account/releases/tag/v1.1.0
[1.0.0]: https://github.com/Sarrius/pi-multi-account/releases/tag/v1.0.0
