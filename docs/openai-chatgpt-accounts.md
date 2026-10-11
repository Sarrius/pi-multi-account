# New OpenAI ChatGPT accounts (issue #92)

Status: **accepted, separate feature; not implemented by 1.25.0**. General host compatibility with Pi 1.x is not multi-account support for its new OpenAI OAuth flow. Existing `openai-codex` accounts continue to work; no credentials or aliases are migrated.

## Verified host contract

The published Pi AI 1.1.0 provider definitions distinguish two integrations:

| Provider | OAuth | Native API / destination |
| --- | --- | --- |
| `openai` | New Sign in with ChatGPT, alongside separately metered API keys | `openai-responses`, `https://api.openai.com/v1` |
| `openai-codex` | Legacy ChatGPT Plus/Pro | `openai-codex-responses`, `https://chatgpt.com/backend-api` |

Sources: `@earendil-works/pi-ai` 1.1.0, `dist/providers/openai.js`, `dist/providers/openai-codex.js`, `dist/auth/oauth/openai-chatgpt.js`, and public `LoginOptions` in `dist/auth/types.d.ts`.

The new public-client login needs the host's stable installation device UUID, dynamically issued `clientId`, and the direct-token scope. Its credentials retain `clientId` and `scopes`; its refresh protocol is not the legacy Codex protocol. Native OAuth model filtering excludes classifier models. A provider rename, legacy-token copy, or reuse of Codex transport/catalog endpoints is therefore not a compatible implementation.

## Separate implementation slice

1. Add a distinct host-supported OpenAI subscription family and `openai-account-N` aliases without rewriting legacy `openai-codex` credentials, pins or numbered slots.
2. Clone the host's public native provider/auth/stream contract; forward `LoginOptions` and per-prompt cancellation so the installation UUID and issued client ID remain host-owned. Old hosts lacking this OAuth contract must not advertise a functional new login.
3. Keep OAuth subscription and API-key/metered discovery, billing consent and catalogs distinct. An ambient `OPENAI_API_KEY` is not consent to spend on a missing subscription alias.
4. Preserve exact identity, deduplication, cooldown/refusal evidence, model-quality floor, thinking effort, pins, exclusions and concurrent-root ownership. Exclude host-owned classifier/image/virtual models from chat fallback candidates.
5. Provide a separate parent-owned child route to the native Responses API, with non-secret placeholders and no Codex-specific JWT/account-header/path rewriting. Verify extension-free child round trips against a deterministic local upstream.
6. Derive quota/usage only from a verified contract for the new direct-token grant. Until such evidence exists, display unknown quota instead of calling legacy `/wham/usage`, inventing headroom, or probing paid API-key routes. Actual inference refusals still drive bounded failover.
7. Test fresh login/discovery, switching, quality/effort-preserving failover, auth refresh/cancellation/lease loss, API-key isolation, old/new credentials together, child delivery and root teardown on supported legacy hosts and Pi 1.1.0. No live user credentials are required for these control-plane tests.

A separately authorized bounded live check can establish provider usability later; offline contract tests do not establish quota, token-family revocation or availability. Keep #92 open until its feature acceptance is met.
