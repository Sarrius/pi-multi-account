# Google Antigravity subscription (unofficial browser login)

This is distinct from the `google` API-key provider. The experimental `google-code-assist` integration has been removed, including its login, configuration flag and Broker admission. Existing credentials are not deleted or migrated. Shared callback/HTTP/SSE/replay utilities live in `google-transport/`; the Antigravity stream lives in `antigravity/stream.ts`.

Google explicitly prohibits third-party access and warns of suspension/termination: https://antigravity.google/docs/faq/ . Login asks for explicit risk acceptance. This adapter is not Google-approved. Successful offline checks do not establish real account compatibility.

## Install and sign in

On Pi 1.1+, install/update `pi-multi-account`, reload Pi, run `/login` and select Google Antigravity, or run `/login google-antigravity` directly. Follow the browser authorization and return to Pi. The login provider is registered by default on compatible hosts, even before an account exists. No Google Cloud project creation, client registration, manual JSON configuration, token import or separate application credential file is required. An explicit `antigravitySubscription: false` remains an opt-out; older hosts keep existing providers but do not advertise unsupported Antigravity transcript APIs. The menu name is **Google Antigravity (unofficial subscription)**. Browser callback: localhost:51121/oauth-callback. On a remote terminal, paste the full callback URL; bare codes are rejected.

The flow validates OAuth state/PKCE, resolves a stable Google account identity, obtains an Antigravity project, and fetches the account's actual available-model catalog. First-use setup has separate consent. It never invents a project, repeats an uncertain onboarding POST or substitutes Gemini CLI/API-key credentials. Pending onboarding is polled only if Google supplies a validated operation name. If not, it stops with an explicit pending-state error rather than guessing or retrying the mutation.

Credentials and a whitelisted model/quota snapshot are persisted by native Pi credential storage, not by this extension writing auth.json. Numbered aliases use `google-antigravity-account-N`; duplicate Google account IDs are rejected. Do not import tokens from the official application.

## Models and quotas

- No static Google API catalog is used. Only supported chat model IDs from the account response are exposed: Gemini, Claude and GPT-OSS; disabled/image-only/unsupported entries are omitted. Missing context metadata does not produce fabricated models.
- Server context/output metadata is retained. When output metadata is absent, the local output cap is conservatively 8,192 (or context size if smaller), not a claim about the service's true maximum. Thinking requiring more output than this is refused rather than silently lowered.
- `/antigravity` displays cached per-model quota observations and their timestamps. In this service's quotaInfo, a valid reset with an omitted numeric remainingFraction represents protobuf-default zero (confirmed on an exhausted Argon account). Missing quotaInfo or malformed values stay unknown.
- `/antigravity refresh` requests new account catalog/quota evidence through the native model runtime. It does not run inference. A failed refresh retains prior data and reports that it may be stale.
- Do not interpret equal percentages/reset times as proof of a shared quota bucket. Argon and other model observations are not collapsed into guessed family pools.
- Before inference the exact account/model is checked against recent discovery. Known zero quota prevents dispatch; model-level quota refusals do not bench unrelated models in Multi Account. Expired snapshots are refreshed before dispatch.
- The request does not enable AI credit types (`enabled_credit_types: []`) and never falls back to a billed Google API. No automatic retries. This is a request-level boundary, not independent verification of Google account billing/settings or server behavior; keep official-app AI Credit Overages set to Never.
- API, destination, header and static-model overrides for this provider in models.json are rejected.

## Transport and Broker

Gemini-native message conversion handles Google-hosted Gemini/Claude/GPT-OSS; Claude uses the native helper's parameters schema and signature-aware tool/result representation. Signed tool calls are withheld until stream framing and terminal completion validate. Parent-only canonical replay receipts remain bounded and route/account/model/session bound. Live support for every advertised model is not established by catalog visibility or synthetic replay.

Broker classifies Antigravity as a mixed included subscription, not an API-key or pay-as-you-go route. Hosted Claude/GPT retain their actual developer provenance while becoming eligible as included subscription models; current-generation evidence, quality, actual qualification and leases remain mandatory. Gemini Argon, Pro, Flash and Flash-Lite are separate product families for generation comparisons. A newer Argon does not retire Flash.

Concurrency remains shared per account: model quota scope does not manufacture additional slots. A model's 429 cools only that resource, while authentication failures remain account-scoped. On startup, an old account-wide Antigravity quota cooldown is reattributed only when exact durable cooldown events identify the affected resources; their cooldowns and dispatch-failure evidence are preserved. Missing/inconsistent migration evidence leaves the old breaker intact.

## Evidence and remaining acceptance

Synthetic tests exercise full OAuth/project/catalog paths, protocol separation, no-project setup, exact account binding, native Gemini/Claude signed tool replay, zero-quota refusal, stale refresh, refresh races, no credit opt-in and no credential migration. The real installed Pi CLI lists the synthetic account catalog under network-denied isolated startup. These are offline results.

Owner browser login and live account catalog/quotas are verified. Fresh installed Pi 1.3 processes passed real isolated Broker read/tool/result/final canaries for `gemini-3.8-flash-low`, `claude-sonnet-5-5-low` and `gpt-oss-120b-medium`. Argon was not invoked after its exhaustion was confirmed. This establishes these concrete protocol paths, not universal model/effort compatibility, quota headroom or a reliability rate. Each process/route/effort still requires current Broker qualification. Existing Pi processes must be restarted or reloaded to adopt changed code; no new Google login is needed. An error must be investigated from bounded stage/shape evidence, not followed by another guessed provider/tier substitution.

## Public application identity versus private account tokens

The adapter carries the reference application's shared **installed-client protocol identity** in `antigravity/oauth-client.ts`. Its `client_secret` is statically distributed to every installation, not an individual user's password or account token. [RFC8252 section8.5](https://www.rfc-editor.org/rfc/rfc8252#section-8.5) explains why such native-app shared values are not confidential credentials. This classification does not mean Google approves this third-party adapter or guarantees access.

The profile is plaintext and source-attributed, never obfuscated or downloaded from a hidden endpoint. The privacy gate permits only its exact reviewed fingerprints in that single module; other application secrets and private files remain rejected. Browser login still uses PKCE/state and fixed callback/token destinations. Account access/refresh tokens are issued separately, stored through native Pi AuthStorage and never bundled, logged or published. Do not share auth.json or diagnostic dumps containing account data.

The earlier local client-configuration file/environment variable is no longer read or required. Existing account tokens use the same application identity; no token migration or renewed login is forced merely by this change. Private files are not deleted by the extension.

## Source

Protocol reference (MIT): https://github.com/NoeFabris/opencode-antigravity-auth/tree/f212f7eb01aa904b5985895cf93f6d3074c5bc6d . License retained in `antigravity/LICENSE.reference`. The reference's shared installed-client identity and pinned 2.24.0 wire-compatibility metadata are used; this is not a claim an official client is running. Its hardcoded fallback project, repeated onboarding POST loop, inferred family quota aggregation and injected system prompt are **not** adopted. Message/tool conversion and auth persistence are native Pi facilities.
