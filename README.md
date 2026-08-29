# pi-multi-account

Automatic multi-account failover & rotation for [Pi Agent](https://pi.dev/), across **Anthropic (Claude)**, **OpenAI / ChatGPT Codex**, **Kimi For Coding**, **Cursor**, **Qwen / Alibaba**, and **Ollama**.

When the account you are using hits a quota or rate limit, `pi-multi-account` transparently switches to the next authenticated account/model and (optionally) resumes the interrupted task — so a long agent run does not die just because one account ran out of budget.

## What it does

- **Auto-discovers** every authenticated account from `~/.pi/agent/auth.json` (Anthropic Claude Pro/Max, OpenAI/ChatGPT Codex, Kimi For Coding, Cursor, Qwen/Alibaba, and Ollama) and builds the failover rotation dynamically — no manual config editing.
- **Grows the rotation on login.** Run `/login`, choose **Use a subscription**, then select a numbered slot such as `anthropic-account-3` or `openai-codex-account-5`. The next discovery sweep adds it to the rotation automatically.
- **Auto-discovers new Codex models per account.** At session start (and on `reload` / `rediscover`) it reads OpenAI's authenticated model catalog, mirrors each account's actually available models onto its Pi alias, and follows OpenAI's server priority. A new flagship can therefore win immediately without an extension release or a hard-coded model id.
- **Handles auth failures without poisoning healthy OAuth accounts.** A generic final 401 briefly cools down a refreshable account and moves the current task forward. Explicit provider verdicts such as `authentication token has been invalidated` force an early refresh; if the refresh token is dead too, the slot is removed and Pi prints the interactive `/login` recovery steps.
- **Fails over on quota / rate-limit** (429 / 402 / 403 and friends): the exhausted account goes on cooldown (parsed from the provider's own reset metadata when available) and Pi first tries another account of the same family that still has the exact model and thinking level. A 100% usage forecast is not a skip: that sibling is asked unless it already refused this session. Another family is used only when no sibling can take the model.
- **Optional auto-continue**: queues a safe continuation prompt after a switch so the agent keeps going from the last safe point.
- **Session-bound overnight resume**: if every account is cooling down, the live Pi session waits for the earliest recovery and continues automatically. A new user message, `/multi-account stop`, session exit, or Esc during a running turn cancels the chain.
- **Deduplicates provably identical accounts** so duplicate Codex workspace memberships and identical credentials do not consume multiple rotation slots or get separate cooldowns. Different users in one Team/Business workspace remain distinct. New provable duplicate logins are rejected before the redundant slot is saved.
- **Keeps YOUR reasoning level across switches.** Whatever the session runs at — your Pi default, `/thinking`, or a per-agent `--thinking low` — is preserved and restored after every account/model switch, so it never drifts downward when a weaker fallback model clamps it. The extension does not override your level (set `reasoningLevel` if you *want* a forced one), and extreme levels such as `xhigh` / Max / Ultra are never forced.
- **Shows live limits for the active account** in Pi's footer: remaining 5-hour and 7-day allowance plus reset countdowns for Codex and Anthropic OAuth accounts.

## Install

```bash
pi install npm:pi-multi-account
```

Restart Pi or run `/reload` after installation.

Requires Node 22+ and `@earendil-works/pi-ai` 0.78 or newer — it is installed automatically as a
dependency. Both the pre-0.80 OAuth API and the 0.80+ provider-factory API are supported, so the
extension keeps working across pi-ai upgrades. If a pi-ai it cannot adapt is ever encountered, the
extension still loads and API-key accounts keep rotating; only subscription login is unavailable,
and it says so at session start.

> **Anthropic (Claude Pro/Max) works out of the box.** OAuth login and request
> shaping for the base `anthropic` provider and every `anthropic-account-*` alias
> are built in — no separate `pi-anthropic-auth` install is required. If you
> already have `pi-anthropic-auth`, the two coexist safely (the shaping is
> idempotent). OpenAI Codex / ChatGPT and Qwen accounts work as well.

### Recommended setting

Set Pi provider-level retries to zero so the SDK does not keep retrying an exhausted account before failover kicks in. In `~/.pi/agent/settings.json`:

```json
{ "retry": { "provider": { "maxRetries": 0 } } }
```

## Usage

Add accounts by opening the login picker:

```text
/login
Use a subscription
ChatGPT Plus/Pro (Codex openai-codex-account-2)
/multi-account rediscover
```

Pi 0.79.3 does not accept a provider argument after `/login`; select the account
slot from the interactive provider picker instead.

Check what's in the rotation at any time:

```text
/multi-account status
```

Force-refresh and display detailed limits for the active account:

```text
/multi-account limits refresh
```

Example status output:

```text
pi-multi-account: enabled · auto-discover ON
Current: anthropic/claude-opus-4-8
Current limits: Claude | 5h 0% left/2h14m | 7d 92% left/1d18h
Rotation (3): anthropic → openai-codex → openai-codex-account-2
Registered login slots: anthropic-account-2, openai-codex-account-2
Cooldowns: none
Invalidated (need re-login): none
Pending auto-resume: none
```

### Commands

All three names are aliases for the same command: `/multi-account`, `/provider-failover`, `/failover`.

| Subcommand | Description |
|---|---|
| `status` (default) | Show enabled state, current model, rotation, login slots, cooldowns, invalidations, pending resume. |
| `limits [refresh]` | Show active-account 5h/7d limits; `refresh` bypasses the cache. Aliases: `usage`, `quota`. |
| `rediscover` | Force a re-scan of `auth.json`, rebuild the rotation, and refresh Codex model catalogs now. |
| `add [anthropic\|codex\|kimi\|cursor\|ollama\|qwen]` | Print the next free account slot to select from the interactive `/login` picker. Subscription families (Anthropic, Codex, Kimi, Cursor) are logged in through `/login`; API-key families are filled in `auth.json`. |
| `remove [anthropic\|codex\|kimi\|cursor\|ollama\|qwen\|<provider-id>]` | Remove an account from `auth.json` and rotation. Family name drops the highest numbered alias slot; a full provider id removes that exact slot. Aliases: `rm`, `delete`. |
| `next` | Manually switch to the next fallback, deliberately overriding recorded cooldowns. |
| `only-active [on\|off]` | Narrow `/model` to the active rotation account: every other provider's models are hidden (its auth is preserved) and restored on switch or `off`. Alias: `focus`. |
| `stop` | Abort and cancel automatic failover/resume for the current task. |
| `reset` | Clear all cooldowns, invalidations and any pending auto-resume. |
| `reload` | Reload config from disk and re-discover accounts. |
| `enable` / `disable` | Turn failover on/off for the current Pi process. |

## How rotation membership works

- **Joins the rotation** when an account has a present, non-expired credential in `auth.json` (after `/login`).
- **Leaves the rotation** when the credential is logged out / removed, its access token is expired with no refresh token, an API key is rejected, or a refreshable OAuth credential produces three distinct final auth failures without a success in between.
- **Quota / rate-limit** does not invalidate an account — it puts it on a temporary cooldown and the account returns once the cooldown expires.
- **Duplicate identities** share one rotation position and one cooldown, and status/startup identifies the redundant slot. Codex/ChatGPT is matched by the JWT's stable `chatgpt_account_user_id` workspace-membership claim, with stored `accountId` as a fallback for older tokens; identical API keys or literal identical tokens are also matched. Separate Anthropic OAuth logins cannot be proven identical because Anthropic's stored credential exposes no stable account identifier.

Rotation refresh is triggered by changes to `auth.json` (detected on session/turn start) or on demand with `/multi-account rediscover`.

After re-authenticating an invalidated slot, restart any older Pi processes that
were already running. Pi keeps a still-unexpired access token in each process's
memory, so an old process can continue using the invalidated token even after a
new `/login` updates `auth.json`.

## Configuration

A default config is created at `~/.pi/agent/provider-failover.json` on first run. Useful keys:

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Master switch. |
| `autoContinue` | `true` | Queue a continuation prompt after a switch. |
| `autoDiscover` | `true` | Auto-discover accounts from `auth.json`. |
| `autoDiscoverModels` | `true` | Fetch OpenAI's authenticated model catalog for every Codex account and register new models on that account's alias automatically. |
| `includeQwen` | `true` | Include Qwen / Alibaba accounts. |
| `includeOllama` | `true` | Include Ollama (local) accounts. |
| `neverFailoverProviders` | `[]` | Provider ids to never fail away from, e.g. `["my-provider"]`. For **unmanaged** providers that run their own retry logic (typically a companion extension owning retries for that provider) — switching accounts underneath it would fight those retries. Managed accounts still cool and rotate normally. |
| `includeCursor` | `true` | Include Cursor subscription accounts. The Cursor provider is a separate, optional repo — until it is cloned this setting does nothing at all: no cursor login slot is offered and no warning is printed. Run `/multi-account add cursor` to get the install instructions. |
| `childProxy` | `true` | Serve OAuth rotation slots to processes that do not load this extension (a memory extension consolidating its notes, an external CLI, any `pi -p --no-extensions` call) through a loopback route this process owns. Without it such a child resolves the active slot by name, fails at authentication, and silently reroutes to whichever provider Pi finds first — a different account, usually a different vendor. The published route carries a non-secret placeholder; the real credential never leaves the parent. |
| `providerOrder` | `["anthropic","openai-codex","qwen","ollama"]` | Preferred family order in the rotation. |
| `cooldownMs` | 6 h | Default cooldown when no reset metadata is provided. |
| `showUsage` | `true` | Show active Codex/Claude limits in Pi's footer. |
| `usageRefreshMs` | 5 min | Per-account usage cache TTL; every authenticated rotation account is refreshed independently, and Anthropic is clamped to at least 10 min to avoid endpoint throttling. |
| `usageStatusRefreshMs` | 1 min | Re-render the footer and sweep idle sessions for stale usage/model catalogs; network refreshes remain limited by their five-minute (Anthropic: ten-minute) TTLs. |
| `maxAutoContinuesPerPrompt` | `8` | Cap on auto-resume hops per task. |
| `continuationPrompt` | (built-in) | Template; supports `{from}`, `{to}`, `{reason}`. |
| `maxRecheckIntervalMs` | `600000` (10 min) | Ceiling on how long any *prediction* may stop an account from being tried again — a recorded cooldown, a usage window, a provider's reset timestamp. Providers refresh quota windows early and unannounced and resize the windows themselves, so those numbers order the rotation but never veto a retry. A refused request costs no tokens; only the account's own answer proves availability. Raise it to probe less often, never to "trust" a provider's estimate. |
| `preserveInterruptedContext` | `true` | Rewrite the turn that triggered the failover into a verbatim `[handoff:interrupted-turn]` record so the account taking over still sees the reasoning, output and tool calls of the turn pi-ai would otherwise drop as unreplayable — including which calls never returned. Deterministic (never moves the prompt-cache breakpoint) and hard-capped. Set to `false` for the previous drop-everything behaviour. |
| `continueAfterCompaction` | `true` | After an **automatic** compaction, carry the task on instead of ending the run and waiting for the user to type "continue". This is Pi's own route, not a workaround: `_runAutoCompaction` ends with `return this.agent.hasQueuedMessages()` and the run loop turns that into `agent.continue()`, which drains the follow-up queue — Pi uses it for overflow recovery but queues nothing on the threshold path, so a threshold compaction always ends the run. Measured across 59 compactions in real logs: 49 % were followed by the user typing a short "continue", and most of the rest were the user pasting the summary back in by hand. One follow-up is queued, it shares the `maxAutoContinuesPerPrompt` budget with failover, and it is skipped for a manual `/compact`, when Pi is already retrying, when the session is idle, and after the user pressed Esc. The message tells the model that finishing is a valid answer, so a task that really was done is reported in one line rather than padded with invented work. `false` disables it. |
| `providerPriority` | managed families, per-token providers last | Where work goes once **every** account of the current provider is spent. An ordered list of provider groups — a managed family, or the base id of anything else you are logged in to (`openrouter`, `zai`, `minimax`…), which `providerOrder` could never name. Three bounds: same-provider failover always runs first and is untouched (588 of 602 automatic failovers in a real black box stayed inside the family — that step already worked); an account on a real cooldown is never chosen over a free one; and a group nobody ranked sorts after every group somebody did. Inside those bounds it settles the hop that used to be arbitrary — the other 14 of those 602 scattered across five destinations with no policy behind them. It sits below the per-account liveness signals on purpose: evidence about one account beats a preference about its category. Set with `/multi-account priority ...`. |
| `contextGuard` | `true` | Keep every request inside the model's context window **while the agent is working**. Pi only measures the context after a whole agent run has ended and before a new user prompt, so a long autonomous run is never checked: one run measured here grew from 85 663 to 542 529 tokens against a 272 000 window without a single check, and 30 % of all requests in that corpus went out above 100 % of the advertised window. Above 75 % of the usable window the oldest large tool results are left out of the outgoing request (the transcript is never touched); above 70 % a real summary is requested at the next settled boundary. The size is measured locally rather than taken from the provider, because Cursor and openai-codex both report the size of their own server-side copy of the conversation. Pass an object to override `softPercent`, `targetPercent`, `compactPercent`, `keepVerbatimTokens`, `minElideTokens`, `maxWindowTokens` (default `400000`: a ceiling on advertised windows, since a model claiming 1 000 000 puts Pi's own threshold out of reach entirely). `false` disables it. |
| `routeCompactionToHealthyAccount` | `true` | When the active account is rate-limited/invalid and Pi needs to compact, generate the summary on a healthy fallback account. If every live attempt fails, cancel — never hand the job to Pi's default on the spent account (that is the infinite "Compacting context…" spinner). |
| `compactionWatchdogMs` | 8 min | Upper bound for one routed compaction attempt. A timed-out attempt is aborted and the next live account is tried. |
| `resumeIdleTimeoutMs` | 90 s | Max time to wait for the previous turn to go idle before a resume gives up and retries later (never an unbounded loop). |
| `stuckWatchdogMs` | 180 s | A resumed turn silent for this long (with no tool running) is treated as wedged. |
| `autoRecoverStuck` | `true` | When a resume wedges, auto-cancel it and auto-resume when an account frees, instead of only notifying. Set `false` for notify-only. |
| `debugLog` | `true` | Write a structured "black box" decision log to `provider-failover-debug.log` (no credentials — only provider/model ids and truncated reasons). View with `/multi-account log`. |
| `preferLatestModel` | `true` | Rank the strongest/current model ahead of older siblings during automatic failover. |
| `reasoningLevel` | `"auto"` | `"auto"` follows the level the session actually runs at (your Pi default, `/thinking`, per-agent `--thinking`) and only restores it after switches. Set an explicit level (`"off"`…`"xhigh"`) to **force** it on every turn regardless of the session — `"xhigh"` only if you really want the extreme level. |
| `preferredModels` | `{}` | Optional manual strongest-first override per family; when present it wins over live catalog priority. |

State (cooldowns, invalidations, recent switches, credential-free Codex model catalogs, and an in-session pending resume marker) is persisted to `~/.pi/agent/provider-failover-state.json`. Pending work is deliberately discarded when the session closes or a different session starts.

## Staying unstuck (resilience)

A failover is only useful if the agent actually keeps working afterward. These guarantees keep a switch from silently freezing the session:

- **Compaction survives account limits — and never leaves the spinner running.** When your context fills up and the active account is rate-limited, the summary is generated on a *healthy* account. If that attempt times out it is aborted (not leaked) and the next live account is tried. If none can finish, compaction is cancelled so "Compacting context…" stops; Pi's default is never given a spent account.
- **Resumes only happen when there is something to resume.** The extension continues a turn only when it actually ended in an error it can pick up from — it never tries to "continue" a finished reply (the cause of the cryptic `Cannot continue from message role: assistant` error).
- **A forward-progress watchdog that acts.** If a resumed turn goes completely silent (no streaming, no tool activity, no provider response) and no tool is running, the extension auto-cancels the wedged turn and resumes the work itself when an account frees up — you do not have to press Esc or re-type the prompt. A long, silent build/test command is never mistaken for a wedge.
- **A circuit breaker as the floor.** If automatic recovery keeps failing, the extension drops to *advisory mode*: it still flags limits and switches you to a fresh account, but stops the auto-continue that was failing, so a bad state can never spiral into repeated hangs. It re-enables itself on the next success, a new prompt, or `/multi-account reset`.
- **A black box for diagnosis.** Every decision (switch, error and how it was classified, watchdog action, breaker trip, compaction routing) is appended to `~/.pi/agent/provider-failover-debug.log`. If anything misbehaves, run `/multi-account log` — the exact sequence is there, so a bug can be reproduced and fixed instead of guessed at. The file is bounded in size, contains no credentials, and is safe to share.

## Privacy & security

`pi-multi-account` **reads** `auth.json` but never writes credentials itself and never stores credentials in its state. Account/token values are reduced to a short irreversible SHA-256 fingerprint for re-login detection and deduplication. OAuth access tokens are sent only to their own provider: the usage endpoint (`chatgpt.com/backend-api/wham/usage` or `api.anthropic.com/api/oauth/usage`) and, for Codex, OpenAI's authenticated `chatgpt.com/backend-api/codex/models` catalog. Cached state contains percentages, reset times, plan/credit metadata, model metadata, and the fingerprint, never the token. Config, state, and the debug log are written with `0600` permissions. The debug log records only provider/model ids, decisions, and truncated reasons — token-shaped material is redacted defensively — so it is safe to share when reporting an issue. Disable it with `"debugLog": false` or `/multi-account log off`.

## License

[MIT](./LICENSE)
