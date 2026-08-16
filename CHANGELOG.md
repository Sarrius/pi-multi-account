# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
