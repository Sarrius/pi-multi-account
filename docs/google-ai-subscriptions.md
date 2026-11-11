# Google AI subscriptions in Pi

Evidence checked 2026-11-11. This distinguishes product entitlements from callable transports; it does not infer remaining account quota or authorize paid fallback.

## Gemini 4 Carbon

Google documents `gemini-4-carbon` as a stable reasoning model with function calling, low/medium/high thinking, a unified 1,048,576-token context and 65,536 default synchronous output. Long decode is a separate API feature, not an Antigravity output allowance.

Antigravity uses the account-returned catalog, not a hard-coded model allowlist. Carbon IDs beginning `gemini-` are already admitted when Google actually returns them, with that route's own context/output limits and capabilities. Run `/antigravity refresh`, then select the exact Carbon entry in Pi's model picker. Do not fabricate `-high` or other suffixes: only select IDs returned for your account. The footer now distinguishes Carbon from Argon instead of labelling every Gemini 4 model Argon.

Synthetic tests cover Carbon discovery-backed streaming, signed tool/result/final replay, no credit-overage flags and distinct quota display. These are adapter tests, not proof that a particular account currently has Carbon or a successful live Carbon inference.

## Which benefits can be used here?

| Benefit | Evidence and feasibility | Current recommendation |
| --- | --- | --- |
| Antigravity | Existing account-scoped OAuth transport/catalog in this extension. Model availability is account evidence, not inferred from Ultra membership. | Existing unofficial integration only, with its explicit third-party-access/account-suspension warning and consent. It is not Google-approved. Preserve per-model observations and do not silently enable credit overages. |
| AI Studio Playground / Build subscription quota | Google explicitly limits these Pro/Ultra benefits to the AI Studio web UI. API keys and external applications have separate billing. | No supported direct reuse of these browser quotas in Pi was found. Do not label an API-key route as consuming Ultra's Studio allowance. |
| Gemini API paid usage covered by promotional Cloud credits | Google AI plans documentation says eligible Developer Program Cloud credits can apply to Gemini API. The program page lists $40/month for Ultra 20TB and $100/month for Ultra 30TB at review time. Eligibility, redemption, expiry and billing attachment must be checked for the actual account. Prepay requires a positive paid balance to activate promotional credits. | This is the practical documented route for additional Pi API usage, via Pi's Google API-key provider. It is credit-backed paid API usage, not free browser-quota reuse. No billing account, purchase, key or overage setting was changed in this work. |
| Gemini CLI / Code Assist | Official CLI docs list Ultra at up to 2,000 model requests/user/day, subject to service availability; agent mode and CLI quotas are combined, not independent buckets. One prompt can cause multiple model requests. | Technically a separate integration candidate, not currently restored: this repository removed its experimental Code Assist provider. A future bridge needs fresh authentication/terms/host compatibility and tool-loop qualification; do not import Antigravity credentials or count CLI and IDE as additive capacity. |
| Gemini app, Search, Flow, Notebook and Colab | Product-specific benefits exist, but those entitlements do not establish a general Pi inference API. Colab compute units are compute, not Gemini API tokens. | Keep outside the inference rotation without a documented compatible transport and entitlement. Google One AI credits are also separate from Cloud credits. |

## Why not automate the browser as an API?

A browser relay could theoretically drive a logged-in UI, but that is not a supported subscription API. It would need separate consent, secure session handling, changing UI/protocol support and proof of cancellation, tool calls, quota accounting and non-duplication. This investigation did not extract cookies, reverse-engineer private account traffic or test a browser relay. Technical possibility and permission/reliability remain unestablished; it should not become an automatic fallback in a credential-handling extension.

## Integration design

One Pi interface is feasible; one interchangeable quota pool is not. Keep separate route identities for Antigravity, any qualified CLI bridge, and Gemini API. Each route needs its own authentication, model catalog, quota evidence and billing policy. Explicitly distinguish subscription quota, promotional credit, paid balance and unknown usage. Never switch from subscription to paid API merely because a browser or OAuth allowance is exhausted.

## Primary sources and claim scope

- [Antigravity integration risk and consent](antigravity.md): existing repository warning about prohibited third-party access and potential account suspension; not a new assurance of official support.
- [Carbon model specification](https://ai.google.dev/gemini-api/docs/models/gemini-4-carbon): API model identity, limits and capabilities; not Antigravity account entitlement.
- [AI Studio Google AI plans](https://aistudio.google.com/docs/google-ai-plans.md), especially **Limitations and compatibility** and **Gemini API usage**: UI-only subscription benefits, separately billed API, promotional credits and positive prepay-balance requirement.
- [Google AI plans](https://one.google.com/about/google-ai-plans/): Ultra product benefits; localized sections can lag one another, so use the product-specific documentation for API billing claims.
- [Developer Program plans](https://developers.google.com/program/plans-and-pricing): advertised monthly Cloud credit amounts, not proof of account redemption.
- [Gemini API billing](https://ai.google.dev/gemini-api/docs/billing#is-AI-Studio-free): linking a paid API key can incur charges even inside AI Studio.
- [Gemini CLI quota documentation](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/quota-and-pricing.md): auth-specific advertised request allowances, not measured remaining capacity.
- [Code Assist quotas](https://developers.google.com/gemini-code-assist/resources/quotas#quotas-for-agent-mode-gemini-cli): CLI/agent-mode sharing and multiple requests per prompt.

Outcome: supported within the public-documentation scope. No live entitlement/billing verification or proof of browser-relay feasibility is claimed.
