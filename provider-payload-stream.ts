import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

type Shape = (payload: any, model: any, options: any) => any;
type Api = { streamSimple: (model: any, context: any, options: any) => any };
const requireLocal = createRequire(import.meta.url);
let registry: { getApiProvider: (api: string) => Api | undefined } | undefined;

function nativeApi(api: string): Api {
	if (!registry) {
		// Pi >= 0.80 moved the API registry to /compat. Resolve lazily so merely
		// listing OAuth providers does not require loading a transport.
		for (const entry of ["@earendil-works/pi-ai/compat", "@earendil-works/pi-ai"]) {
			try {
				const candidate = requireLocal(fileURLToPath(import.meta.resolve(entry)));
				if (typeof candidate.getApiProvider === "function") { registry = candidate; break; }
			} catch { /* Try the older public entry point. */ }
		}
	}
	const provider = registry?.getApiProvider(api);
	if (!provider) throw new Error(`Pi native API is unavailable: ${api}`);
	return provider;
}

/** Provider-level shaping applies to every public Pi client, including calls
 * outside the interactive agent's before_provider_request event lifecycle. */
export function createPayloadStream(shape: Shape, resolveApi = nativeApi) {
	return (model: any, context: any, options: any = {}) => resolveApi(model.api).streamSimple(model, context, {
		...options,
		onPayload: async (payload: any, actualModel: any) => {
			const replacement = await options.onPayload?.(payload, actualModel);
			const current = replacement === undefined ? payload : replacement;
			const shaped = await shape(current, actualModel, options);
			return shaped === undefined ? current : shaped;
		},
	});
}

export const cursorPayloadStream = createPayloadStream((payload, _model, options) => {
	if (payload && typeof payload === "object" && typeof options.sessionId === "string" && options.sessionId.trim()) {
		payload.pi_session_id = options.sessionId;
	}
	return payload;
});
