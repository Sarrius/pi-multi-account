/**
 * Can an extension-free Pi child actually use this rotation slot?
 *
 * ## Why this exists
 *
 * Pi keeps an optional saved global default in `settings.json`. On Pi <=0.84.2 every model
 * switch rewrites it; since Pi 0.84.3 ordinary model selection is session-scoped and only an
 * explicit persistent choice rewrites it. Anything that later spawns a bare
 * `pi -p --no-extensions` child without `--model` inherits that saved default — which may
 * intentionally differ from whichever rotation slot is active in this session. Brokered and
 * subagent children pass an explicit provider/model and do not use this fallback.
 *
 * A child launched that way does not load this extension, so a slot named `openai-codex-account-4`
 * exists for it only if we published it into Pi's own `models.json`. Publishing the *name*,
 * however, is not the same as publishing a usable route, and the difference is invisible until
 * something fails far away from here.
 *
 * ## What was measured (2026-08-24), not assumed
 *
 * In an isolated agent directory containing one `models.json` provider entry mirroring the
 * built-in Codex definition plus the matching **OAuth** credential under the same key:
 *
 *     pi -p --no-extensions --no-session --model openai-codex-account-4/gpt-5.6-sol …
 *     → exit 1: "No API key found for openai-codex-account-4."
 *
 * The same child, pointed at the **built-in** `openai-codex` provider with its OAuth credential,
 * got past authentication (it reached the network instead of refusing).
 *
 * The reason is in Pi: `checkProviderAuth` honours an OAuth credential only when the *provider
 * definition* declares an OAuth flow. A `models.json` entry declares none, so an OAuth token
 * sitting in `auth.json` under exactly that key is never consulted. An API key is different —
 * it resolves through the credential store and works.
 *
 * ## What was measured again (2026-08-30), and what it corrected
 *
 * The row below claiming a built-in provider is usable whatever its credential turned out to be
 * true of authentication and false of the request. On the account the parent session was itself
 * using successfully at that moment:
 *
 *     pi -p --no-extensions --no-session --model anthropic/claude-opus-5 …
 *     → 400 invalid_request_error: "Third-party apps now draw from your extra usage, not your
 *       plan limits."
 *
 * Pi resolved the built-in provider and its OAuth credential correctly; Anthropic then refused,
 * because a subscription token is only honoured for a request carrying the client identity the
 * parent adds and a bare child does not. So for that family being built-in is not sufficient,
 * and the same parent-owned loopback route the alias slots use is what makes it usable. Codex
 * is unaffected — the 2026-08-24 measurement of a bare child on built-in `openai-codex` reached
 * the network and was served.
 *
 * | slot shape | child outcome |
 * |---|---|
 * | built-in provider, credential the vendor serves any client (API key, Codex OAuth) | usable — Pi owns the auth flow |
 * | **built-in Anthropic on a subscription OAuth token** | **authenticates, then refused as a third-party app** |
 * | alias slot published with a real or placeholder `apiKey` | usable — Pi sees a credential |
 * | **alias slot with an OAuth credential and no `apiKey`** | **resolves by name, then fails at auth** |
 *
 * The third row is what we do today for Kimi slots, under a comment promising that
 * "extension-free children resolve it". True of the name; false of the credential. The Cursor
 * slots avoid it by publishing a non-secret placeholder that points at a parent-owned local
 * proxy, so the child authenticates to `127.0.0.1` while the real token stays in the parent.
 *
 * This module is deliberately pure: it decides and explains, and it touches no file, no socket
 * and no credential. Wiring and the proxy itself are separate, reviewable pieces — this one can
 * be tested exhaustively without any of them.
 */

/** How a slot's credential is stored, as far as `auth.json` is concerned. */
export type SlotCredentialKind = "oauth" | "api_key" | "none";

export interface SlotChildFacts {
  /** Rotation slot id, e.g. `openai-codex-account-4` or a base provider name. */
  slotId: string;
  /** Credential kind held for this exact slot id. */
  credential: SlotCredentialKind;
  /** True when Pi itself defines this provider (it then owns the OAuth flow). */
  builtin: boolean;
  /** `apiKey` published for this slot in `models.json`, when we published one. */
  publishedApiKey?: string;
  /** `baseUrl` published for this slot in `models.json`, when we published one. */
  publishedBaseUrl?: string;
}

export type ChildUsability =
  /** A bare child can authenticate and run on this slot. */
  | { usable: true; slotId: string; via: "builtin" | "api-key" | "parent-proxy"; note: string }
  /** A bare child cannot use it; `remedy` says what would change that. */
  | { usable: false; slotId: string; reason: string; remedy: string };

/**
 * Families whose subscription refuses a request that does not carry the parent's client
 * identity, even when Pi resolved the credential. Being built-in does not help here: the
 * failure is the vendor's answer, not Pi's auth lookup.
 */
function vendorRefusesBareChild(
  slotId: string,
  credential: SlotCredentialKind,
  builtin: boolean,
): boolean {
  // Numbered alias slots never get this far: Pi does not consult their OAuth blob at all.
  // The 400 is specific to a built-in Anthropic provider, which does resolve the credential.
  return builtin && credential === "oauth" && /^anthropic(?:-account-\d+)?$/.test(slotId);
}

/** Loopback-only, so a published route can never send a child off this machine. */
function isLoopback(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  try {
    // `URL` reports an IPv6 host bracketed (`[::1]`), so compare against the unwrapped form.
    const hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

/**
 * Decide, for one slot, whether an extension-free child can run on it.
 *
 * Order matters: Pi's resolver keys off the stored credential *type* before it ever looks at a
 * models.json apiKey. An OAuth blob under the same key as a published placeholder is therefore
 * not a usable child route — measured against Pi's own `resolveProviderAuth`: stored OAuth plus a
 * provider that has no OAuth method returns undefined (\"No API key found\"), and stored OAuth
 * plus a built-in OAuth method ignores the placeholder entirely.
 */
export function classifyChildUsability(facts: SlotChildFacts): ChildUsability {
  const { slotId, credential, builtin, publishedApiKey, publishedBaseUrl } = facts;

  const vendorRefuses = vendorRefusesBareChild(slotId, credential, builtin);

  // A built-in provider is resolved by Pi without us — but resolution is not service. When the
  // vendor refuses a bare client, a loopback baseUrl is what actually redirects the request;
  // the published apiKey is not what Pi sends, because the stored credential is still OAuth.
  if (builtin && !vendorRefuses) {
    return {
      usable: true,
      slotId,
      via: "builtin",
      note: "Pi defines this provider itself and owns its auth flow, so a bare child resolves it without this extension.",
    };
  }

  if (vendorRefuses && isLoopback(publishedBaseUrl)) {
    return {
      usable: true,
      slotId,
      via: "parent-proxy",
      note: "The child still presents the subscription token; the published loopback is what makes the parent shape that request instead of the vendor refusing it as a third-party app.",
    };
  }

  if (vendorRefuses) {
    return {
      usable: false,
      slotId,
      reason:
        "The credential is a subscription OAuth token. Pi resolves it, but the vendor then refuses the call as a third-party app (\"Third-party apps now draw from your extra usage, not your plan limits\"), because a bare child does not send the client identity the parent adds.",
      remedy:
        "Publish this account against a parent-owned loopback proxy so the child's request is shaped by the parent that holds the subscription.",
    };
  }

  if (credential === "api_key") {
    if (publishedApiKey && isLoopback(publishedBaseUrl)) {
      return {
        usable: true,
        slotId,
        via: "parent-proxy",
        note: "The child authenticates to a parent-owned loopback route with a non-secret placeholder; the real credential never leaves the parent.",
      };
    }
    return {
      usable: true,
      slotId,
      via: "api-key",
      note: "The credential is an API key, which Pi resolves through its own credential store for a published provider.",
    };
  }

  if (credential === "oauth") {
    return {
      usable: false,
      slotId,
      reason:
        "The credential is OAuth, and Pi honours OAuth only for a provider definition that declares the flow. A models.json entry declares none, so the token under this key is never consulted — even a published placeholder is ignored, and the slot then fails with \"No API key found\".",
      remedy:
        "While the parent proxy is listening, present this slot to a child as a non-secret api_key placeholder and keep the OAuth blob where only the parent reads it.",
    };
  }

  return {
    usable: false,
    slotId,
    reason: "No credential is held for this slot.",
    remedy: "Log in to this account, or drop the slot from the published registry.",
  };
}

/**
 * The slot a bare unpinned child would actually be sent to, given Pi's saved global default.
 * Returns `undefined` when that saved route is usable.
 *
 * This is the check that turns a silent, far-away failure into something sayable here: when the
 * active rotation slot is not child-usable, every child spawned without an explicit `--model`
 * falls through Pi's own "first available provider" list instead — which is a different account,
 * often a different vendor, and never the one the rotation chose.
 */
export function defaultRouteWarning(
  savedDefaultSlotId: string | undefined,
  classify: (slotId: string) => ChildUsability | undefined,
): string | undefined {
  if (!savedDefaultSlotId) return undefined;
  const verdict = classify(savedDefaultSlotId);
  if (!verdict || verdict.usable) return undefined;
  return (
    `Pi's saved global default is ${savedDefaultSlotId}, but a bare extension-free child launched ` +
    `without --model cannot use it: ${verdict.reason} Such an unpinned child falls back to Pi's ` +
    `own first-available provider. The live multi-account session and explicitly pinned ` +
    `broker/subagent children are unaffected. ${verdict.remedy}`
  );
}

/** One line per slot, for `/multi-account status`. Stable order: unusable first, then by id. */
export function describeChildUsability(verdicts: readonly ChildUsability[]): string[] {
  const ordered = [...verdicts].sort(
    (a, b) => Number(a.usable) - Number(b.usable) || a.slotId.localeCompare(b.slotId),
  );
  return ordered.map((verdict) =>
    verdict.usable
      ? `  ${verdict.slotId} — usable by a bare child (${verdict.via})`
      : `  ${verdict.slotId} — NOT usable by a bare child: ${verdict.reason}`,
  );
}
