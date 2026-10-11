# Native OpenAI ChatGPT accounts (issue #92)

Status: **implemented in the unreleased 1.25.0 source**. The running Pi host must expose the new native OAuth contract; it is present in the tested **0.99.2, 1.0.0 and 1.1.0** host releases. The older **0.85.1, 0.86.1 and 0.87.1** hosts remain loadable but do not offer functional `openai-account-N` login. This feature neither upgrades Pi nor migrates legacy Codex credentials.

## Two separate integrations

| Provider | Authentication | Native API / destination |
| --- | --- | --- |
| `openai` | New Sign in with ChatGPT **or separately metered API keys** | `openai-responses`, `https://api.openai.com/v1` |
| `openai-account-N` | New ChatGPT subscription only | Same native Responses contract, optionally through its parent-owned loopback route |
| `openai-codex`, `openai-codex-account-N` | Legacy ChatGPT Plus/Pro | `openai-codex-responses`, `https://chatgpt.com/backend-api` |

The implementation clones the host's public native Provider, rather than adapting its login to legacy OAuth callbacks. Native `AuthInteraction`, `LoginOptions`, the host-owned stable installation UUID, cancellation and stream implementations are preserved. The issued `clientId` and `scopes`, including `chatgpt.tokens.use.direct`, survive login, refresh and private proxy recovery. They are not invented from a legacy token.

Sources: `@earendil-works/pi-ai` 1.1.0 public Provider/auth contracts, `dist/providers/openai.js`, `dist/providers/openai-codex.js`, and `dist/auth/oauth/openai-chatgpt.js`.

## Add an account

On a supporting host:

```text
/multi-account add openai
/login
Sign in with an account / Sign in with ChatGPT
OpenAI (ChatGPT subscription · openai-account-2)
/multi-account rediscover
/multi-account switch openai-account-2/gpt-6.1-sol
```

Use the model IDs actually offered by your host. `/multi-account add codex` still selects the **legacy** family; `openai` is no longer shorthand for Codex. Login picker wording varies between host releases. New aliases reject API-key login; use base `openai` for intentionally metered access.

Authenticated native base `openai` OAuth and numbered aliases join their own account group. The host's Responses chat catalog and model metadata are mirrored without fetching a legacy Codex catalog. Exact sibling/model failover, quality bands, thinking effort, pins, exclusions and refusal cooldowns retain their existing semantics. Classifier, dedicated image-generation and virtual models are not subscription chat fallbacks; **image input to chat remains supported**.

## Billing and identity boundaries

- Base `openai` API-key access remains native, separately metered and unmanaged by subscription discovery. Existing keys are not rewritten.
- A missing, logged-out or invalid subscription alias cannot inherit an ambient `OPENAI_API_KEY` or a stored paid key. Its only API-key resolution is the non-secret placeholder on that exact parent-owned loopback route. Auth derivation also binds the destination and rejects incompatible models.json/effective host API or URL overrides before granting a direct bearer; base `openai` remains the place for custom/metered APIs.
- Automatic fallback from a new subscription to base OpenAI metered access requires an **explicit `fallbacks` target**. Generic discovery, provider priority and model pins are not this billing consent. An explicit manual switch remains an owner action.
- New subscription identity is namespaced separately from legacy Codex. Provably identical credentials can deduplicate; an issued client ID is not a user identity. Opaque independent logins without stable identity evidence are not asserted to represent the same account.

## Extension-free children

With `childProxy: true`, the owning root publishes a separate Responses-only route and a non-secret placeholder. The real direct grant stays in the private recovery sidecar. The proxy sends it only to native `https://api.openai.com/v1/responses` routes; it does not decode it into Codex auth, add legacy `chatgpt-account-id`/`originator` headers, or use `/codex`, `/wham/usage`, classifier or image-generation endpoints.

Native extension-free children use ordinary Responses image/tool serialization, streamed output and tool-result replay. Alias dispatch and the final proxy boundary omit the fields native Sign in with ChatGPT rejects (`max_output_tokens`, `temperature`, `prompt_cache_retention`, `prompt_cache_options`), including fields reintroduced by caller hooks or legacy child transports. Caller termination closes the original upstream request; shutdown restores the exact issued grant and legacy credentials while preserving user model overrides. Independent roots use the existing joined proxy/publication ownership protocol. Without a live parent-owned route, a numbered OAuth alias is not independently authenticated in an extension-free child.

## Quota is unknown

No new direct-grant quota endpoint is verified. Usage therefore remains **unknown/unverified**, not zero used or available. New aliases do not call legacy Codex usage/catalog endpoints, probe metered keys for headroom, or claim a working quota window. Actual inference refusals still produce bounded failover/backoff; retry eligibility is not restored availability.

## Verification and limits

`test/openai-chatgpt.test.ts`, `test/openai-chatgpt-native.test.ts`, `test/openai-chatgpt-request-boundary.test.ts` and the issue92 cases in `test/failover.test.ts` cover capability gating, native authorization/device/client/scopes, cancellation/listener cleanup, discovery, switching, effort/pins/exclusions, guarded refresh, billing isolation and old/new coexistence. A fresh native host plus a real `pi --no-extensions` child completes an image and native `read` tool roundtrip against a strict local fake upstream, then proves no cancellation replay and exact teardown restoration. External provider traffic is blocked by the fixture.

These are deterministic control-plane/transport tests, **not live ChatGPT login or provider-availability evidence**. A separately authorized live check can establish usability of a particular real grant later; it cannot guarantee future quota. Source merge, npm publication, installed-host capability and adoption by an already-running process are separate events.
