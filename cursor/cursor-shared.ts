/**
 * Multi-account surface for the Cursor provider.
 *
 * The single-account extension (`index.ts`) keeps ONE module-level access token and
 * registers ONE provider called `cursor`. Rotation needs N providers — `cursor`,
 * `cursor-account-2`, ... — that share one local proxy while each authenticates as its
 * own Cursor subscription.
 *
 * The account is carried by the request itself: every slot's `getApiKey` returns THAT
 * slot's access token, Pi puts it in the `Authorization` header of the call to the local
 * proxy, and the proxy hands the very same token to Cursor. Nothing is cached between
 * requests, so a failover mid-session takes effect on the next call instead of silently
 * re-using the spent account's token.
 *
 * Consumed by pi-multi-account's `cursor-bridge.ts`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cursorPayloadStream } from "../provider-payload-stream.ts";
import {
  generateCursorAuthParams,
  getTokenExpiry,
  pollCursorAuth,
  refreshCursorToken,
} from "./auth.ts";
import { FALLBACK_MODELS, modelConfig, processModels } from "./index.ts";
import { getCursorModels, startProxy, type CursorModel } from "./proxy.ts";

export const CURSOR_BASE = "cursor";

/** Resolves the stored access token for a provider id (reads the host's auth.json). */
type TokenResolver = (providerId: string) => Promise<string>;

type AuthEntryLike = {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
};

type RegisterOptions = {
  /**
   * Host guard that refuses a login when the SAME real Cursor account is already stored
   * in another slot. Throwing here is correct: two slots on one account is not a rotation,
   * it is one account that would be benched twice.
   */
  rejectDuplicateLogin?: (slot: string, credentials: AuthEntryLike) => AuthEntryLike;
  /** Called with the real catalog once a token can read it, so the host can re-register. */
  onModelsDiscovered?: (models: CursorModel[]) => void;
};

// `var`, deliberately: these are hoisted, so even a caller that reaches this module while it
// is still initializing (a concurrent import) sees `undefined` instead of a temporal-dead-zone
// crash. The module is shared by every account slot and must never be the reason a session
// loses Cursor.
// eslint-disable-next-line no-var
var proxyPromise: Promise<number> | undefined;
// eslint-disable-next-line no-var
var tokenResolver: TokenResolver | undefined;

/**
 * The bearer token Pi attached to this proxy call, i.e. the identity of the slot that
 * made it. `cursor-proxy` is the single-account extension's placeholder and carries no
 * identity, so it is treated as absent.
 */
function bearerFromRequest(req?: {
  headers?: Record<string, string | string[] | undefined>;
}): string | undefined {
  const raw = req?.headers?.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  if (!token || token === "cursor-proxy") return undefined;
  return token;
}

/**
 * Start (once) the shared local proxy. Idempotent: later calls only refresh the fallback
 * resolver and return the port already bound, so every slot registers against one port.
 */
export async function ensureCursorProxy(resolve: TokenResolver): Promise<number> {
  tokenResolver = resolve;
  proxyPromise ??= startProxy(async (req) => {
    const fromRequest = bearerFromRequest(req);
    if (fromRequest) return fromRequest;
    // No usable token on the request (a legacy placeholder, or a caller that sends none):
    // fall back to the base slot's stored credential rather than failing the call.
    const fallback = (await tokenResolver?.(CURSOR_BASE)) ?? "";
    if (!fallback) {
      throw new Error(
        "No Cursor account is logged in for this request. Run /login and pick a cursor slot.",
      );
    }
    return fallback;
  });
  return proxyPromise;
}

function displayName(id: string): string {
  return id === CURSOR_BASE ? "Cursor" : `Cursor (${id})`;
}

async function discoverModels(
  accessToken: string,
  onModelsDiscovered?: (models: CursorModel[]) => void,
): Promise<void> {
  if (!onModelsDiscovered) return;
  try {
    const discovered = await getCursorModels(accessToken);
    if (discovered.length > 0) onModelsDiscovered(discovered);
  } catch {
    // Catalog discovery is an enhancement over FALLBACK_MODELS. A login must never fail
    // because Cursor's model list could not be read.
  }
}

/**
 * Register one Cursor account slot as its own Pi provider.
 *
 * Safe to call repeatedly for the same id — that is how a freshly discovered catalog
 * replaces the fallback list.
 */
export function registerCursorProvider(
  pi: ExtensionAPI,
  id: string,
  proxyPort: number,
  rawModels: CursorModel[] = FALLBACK_MODELS,
  options: RegisterOptions = {},
): void {
  const name = displayName(id);
  const models = processModels(rawModels).map(modelConfig);

  (pi as any).registerProvider(id, {
    name,
    baseUrl: `http://127.0.0.1:${proxyPort}/v1`,
    api: "openai-completions",
    streamSimple: cursorPayloadStream,
    models,
    oauth: {
      name,
      isSubscription: true,

      async login(callbacks: any): Promise<AuthEntryLike> {
        const { verifier, uuid, loginUrl } = await generateCursorAuthParams();
        callbacks.onAuth({ url: loginUrl });
        const { accessToken, refreshToken } = await pollCursorAuth(uuid, verifier);
        const credentials: AuthEntryLike = {
          type: "oauth",
          access: accessToken,
          refresh: refreshToken,
          expires: getTokenExpiry(accessToken),
        };
        // Reject BEFORE the catalog call: a duplicate must cost nothing and change nothing.
        const verified = options.rejectDuplicateLogin
          ? options.rejectDuplicateLogin(id, credentials)
          : credentials;
        await discoverModels(accessToken, options.onModelsDiscovered);
        return verified;
      },

      async refreshToken(credentials: AuthEntryLike): Promise<AuthEntryLike> {
        const refreshed = await refreshCursorToken(credentials.refresh as string);
        await discoverModels(refreshed.access, options.onModelsDiscovered);
        return { type: "oauth", ...refreshed };
      },

      /**
       * THIS slot's token, not a shared placeholder — it is what tells the proxy which
       * Cursor account the request belongs to.
       */
      getApiKey(credentials: AuthEntryLike): string {
        return credentials.access ?? "";
      },
    },
  });
}

export { FALLBACK_MODELS };

/**
 * Read the account's real model catalog.
 *
 * THROWS the underlying error: callers (login, refresh, startup discovery) each decide
 * whether a failed catalog read is fatal — swallowing it here left every layer above
 * guessing why the fallback list was still in effect.
 */
export async function discoverCursorModels(
  accessToken: string,
): Promise<CursorModel[]> {
  return getCursorModels(accessToken);
}
