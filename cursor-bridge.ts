import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const VENDORED_CURSOR_ROOT = join(dirname(fileURLToPath(import.meta.url)), "cursor");

export const CURSOR_BASE = "cursor";

/**
 * The one bearer value the vendored proxy treats as "no usable token on this request",
 * falling back to the base slot's stored credential (see `bearerFromRequest` in
 * cursor/cursor-shared.ts). It is a marker, not a secret: the proxy listens on
 * 127.0.0.1 only and supplies the real Cursor token itself.
 *
 * It exists so a slot published into pi's static models.json is USABLE by a bare
 * `pi -p` child, which cannot read the OAuth token this extension holds. Locked to the
 * vendored provider by a test — if the provider ever stops recognising this exact
 * string, publishing it would silently send a bogus token instead.
 */
export const CURSOR_PROXY_PLACEHOLDER_KEY = "cursor-proxy";

export function isCursorProviderId(id: string): boolean {
	return id === CURSOR_BASE || /^cursor-account-\d+$/.test(id);
}

/**
 * Where Cursor implementation is loaded from.
 *
 * Production always uses the copy vendored next to this file (`./cursor`).
 * `PI_CURSOR_PROVIDER_ROOT` is a test seam only: the suite points it at a stub
 * or an empty directory so it can exercise load failures without starting the
 * real proxy.
 */
export function getCursorProviderRoot(): string {
	return process.env.PI_CURSOR_PROVIDER_ROOT || VENDORED_CURSOR_ROOT;
}

export function isCursorProviderInstalled(): boolean {
	return existsSync(join(getCursorProviderRoot(), "cursor-shared.ts"));
}

type CursorShared = {
	ensureCursorProxy: (
		resolve: (providerId: string) => Promise<string>,
	) => Promise<number>;
	registerCursorProvider: (...args: any[]) => void;
	FALLBACK_MODELS: unknown[];
	discoverCursorModels?: (accessToken: string) => Promise<unknown[]>;
};
type CursorIndex = {
	registerSessionLifecycleCleanup?: (pi: ExtensionAPI) => void;
	cleanupControllerSession?: (sessionId: string) => void;
};

let sharedModPromise: Promise<CursorShared | undefined> | undefined;
let indexMod: CursorIndex | undefined;
let proxyPort: number | undefined;
let loadAttempt = 0;

function loadSpecifier(entry: string): string {
	return loadAttempt === 0
		? entry
		: `${pathToFileURL(entry).href}?pi-multi-account-retry=${loadAttempt}`;
}

/**
 * Cache the in-flight PROMISE, not the settled module.
 *
 * Discovery fires this without awaiting while `session_start` awaits its own call, so both
 * used to reach the import at once. A second concurrent import of the same module observes it
 * mid-initialization: hoisted functions are already callable while its `let` state is still in
 * the temporal dead zone, which surfaced as "Cannot access 'tokenResolver' before
 * initialization" and cost the session every Cursor account. One shared promise means the
 * module is imported exactly once, no matter how many callers race.
 */
async function loadCursorModules(): Promise<CursorShared | undefined> {
	sharedModPromise ??= (async () => {
		const entry = join(getCursorProviderRoot(), "cursor-shared.ts");
		if (!existsSync(entry)) return undefined;
		try {
			const shared = (await import(
				/* @vite-ignore */ loadSpecifier(entry)
			)) as CursorShared;
			const indexEntry = join(getCursorProviderRoot(), "index.ts");
			if (existsSync(indexEntry)) {
				indexMod = (await import(
					/* @vite-ignore */ loadSpecifier(indexEntry)
				)) as CursorIndex;
			}
			return shared;
		} catch (error) {
			sharedModPromise = undefined;
			loadAttempt++;
			throw error;
		}
	})();
	return sharedModPromise;
}

type AuthEntry = {
	type?: string;
	access?: string;
	refresh?: string;
	expires?: number;
	key?: string;
	accountId?: string;
};

export async function setupCursorSubscription(
	pi: ExtensionAPI,
	options: {
		readAuth: () => Record<string, AuthEntry>;
		rejectDuplicateLogin?: (slot: string, creds: AuthEntry) => AuthEntry;
		slotIds: string[];
		notify?: (message: string, level: "info" | "warning") => void;
		log?: (kind: string, data: Record<string, unknown>) => void;
		/**
		 * Host hook: provision each Cursor slot into Pi's static models.json so a
		 * bare `pi -p` child (no extensions) resolves cursor/* through the running
		 * proxy. Called after the proxy is up and again when the real catalog lands.
		 * Pass model objects (or ids); the host writes Pi-schema objects, never strings.
		 */
		onProvision?: (slotIds: string[], port: number, models: unknown[]) => void;
		/** Only the cold factory waits: Pi resolves a resumed model after it returns. */
		waitForCatalogMs?: number;
	},
): Promise<number | undefined> {
	const mod = await loadCursorModules();
	if (!mod) {
		options.notify?.(
			`pi-multi-account: Cursor support is missing from this install (expected ${getCursorProviderRoot()}). Everything else keeps working; set "includeCursor": false in the config to silence this.`,
			"warning",
		);
		return undefined;
	}
	if (indexMod?.registerSessionLifecycleCleanup) {
		indexMod.registerSessionLifecycleCleanup(pi);
	}
	const resolveAccessToken = async (providerId: string) => {
		const entry = options.readAuth()[providerId];
		if (!entry || entry.type !== "oauth") return "";
		return typeof entry.access === "string" ? entry.access : "";
	};
	proxyPort = await mod.ensureCursorProxy(resolveAccessToken);
	const ids = [...new Set([CURSOR_BASE, ...options.slotIds])];
	options.onProvision?.(ids, proxyPort, mod.FALLBACK_MODELS as unknown[]);
	for (const id of ids) {
		mod.registerCursorProvider(pi, id, proxyPort, mod.FALLBACK_MODELS, {
			rejectDuplicateLogin: options.rejectDuplicateLogin,
			onModelsDiscovered: (models: unknown[]) => {
				mod.registerCursorProvider(pi, id, proxyPort!, models as any[], {
					rejectDuplicateLogin: options.rejectDuplicateLogin,
				});
				options.onProvision?.(ids, proxyPort!, models);
			},
		});
	}
	const discovery = (async () => {
		if (typeof mod.discoverCursorModels !== "function") {
			options.log?.("cursor_catalog", { outcome: "unsupported" });
			return;
		}
		for (const id of ids) {
			const entry = options.readAuth()[id];
			if (!entry || entry.type !== "oauth" || !entry.access) continue;
			try {
				const models = await mod.discoverCursorModels(entry.access);
				if (!models?.length) {
					options.log?.("cursor_catalog", { outcome: "empty", provider: id });
					continue;
				}
				for (const slot of ids) {
					mod.registerCursorProvider(pi, slot, proxyPort!, models as any[], {
						rejectDuplicateLogin: options.rejectDuplicateLogin,
					});
				}
				options.onProvision?.(ids, proxyPort!, models as unknown[]);
				options.log?.("cursor_catalog", {
					outcome: "discovered",
					provider: id,
					models: models.length,
				});
				return;
			} catch (error) {
				options.log?.("cursor_catalog", {
					outcome: "error",
					provider: id,
					reason: error instanceof Error ? error.message : String(error),
				});
			}
		}
		options.log?.("cursor_catalog", {
			outcome: "unavailable",
			reason: "no slot could read the catalog",
		});
	})().catch((error) => {
		options.log?.("cursor_catalog", {
			outcome: "crashed",
			reason: error instanceof Error ? error.message : String(error),
		});
	});
	// Fallback registration is immediate, but the requested saved model may exist only
	// in Cursor's discovered catalog (e.g. grok-4.7). Give the factory a bounded chance
	// to publish it before Pi performs its one-shot model restore. Keep discovery alive
	// after timeout for ordinary dynamic registration; never hang an offline startup.
	if (options.waitForCatalogMs && options.waitForCatalogMs > 0) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				discovery,
				new Promise<void>((resolve) => { timer = setTimeout(resolve, options.waitForCatalogMs); }),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	return proxyPort;
}

/**
 * Refresh a Cursor OAuth credential through the VENDORED provider.
 *
 * This used to `import()` `~/.pi/agent/git/github.com/ndraiman/pi-cursor-provider/auth.ts`
 * — a path that no longer exists for anyone (the provider is vendored into this
 * extension, and upstream's repo never contained the file layout we expected).
 * Every forced Cursor refresh therefore threw before it could refresh anything.
 * Resolving through {@link getCursorProviderRoot} keeps the `PI_CURSOR_PROVIDER_ROOT`
 * test seam working.
 */
/**
 * Controller tasks are not Pi sessions, so the normal session_shutdown hook cannot clean their
 * Cursor conversation state. The native controller provider calls this after each task request;
 * the callback is deliberately a no-op when the optional Cursor provider is absent.
 */
export function cleanupCursorControllerSession(sessionId: string): void {
	try {
		indexMod?.cleanupControllerSession?.(sessionId);
	} catch {
		// Cleanup is best effort; it must not turn a settled provider result into a host error.
	}
}

export async function refreshCursorCredentials(
	refreshToken: string,
	signal?: AbortSignal,
): Promise<{ access: string; refresh: string; expires: number }> {
	const entry = join(getCursorProviderRoot(), "auth.ts");
	if (!existsSync(entry)) {
		throw new Error(`Cursor support is missing from this install (${entry})`);
	}
	const mod = (await import(/* @vite-ignore */ loadSpecifier(entry))) as {
		refreshCursorToken: (
			token: string,
			signal?: AbortSignal,
		) => Promise<{ access: string; refresh: string; expires: number }>;
	};
	return mod.refreshCursorToken(refreshToken, signal);
}
