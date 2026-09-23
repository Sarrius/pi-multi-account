type Shape = (payload: any, model: any, options: any) => any;
type Api = { streamSimple: (model: any, context: any, options: any) => any };
let registry: Promise<typeof import("@earendil-works/pi-ai/compat")> | undefined;

async function nativeApi(api: string): Promise<Api> {
	// A bare import is essential: Pi binds it to the running host's module (including
	// bundled/virtual hosts). createRequire/import.meta.resolve bypass that binding and
	// can pair a new transcript with an old, extension-local transport (#65/#66).
	// Lazy loading preserves account discovery when the optional transport is unavailable.
	registry ??= import("@earendil-works/pi-ai/compat").catch((error) => {
		registry = undefined;
		throw error;
	});
	const native = await registry;
	const provider = native.getApiProvider?.(api as any);
	if (!provider) throw new Error(`Pi host API is unavailable: ${api}`);
	return provider;
}

/** Provider-level shaping applies to every public Pi client, including calls
 * outside the interactive agent's before_provider_request event lifecycle. */
export function createPayloadStream(shape: Shape, resolveApi: (api: string) => Api | Promise<Api> = nativeApi) {
	return (model: any, context: any, options: any = {}) => {
		const start = (api: Api) => api.streamSimple(model, context, {
			...options,
			onPayload: async (payload: any, actualModel: any) => {
				const replacement = await options.onPayload?.(payload, actualModel);
				const current = replacement === undefined ? payload : replacement;
				const shaped = await shape(current, actualModel, options);
				return shaped === undefined ? current : shaped;
			},
		});
		const api = resolveApi(model.api);
		if (!(api instanceof Promise)) return start(api);
		const stream = api.then(start);
		// Stream functions must return synchronously. Both consumers await the SAME native
		// stream; no reserialization, context conversion or second request is introduced.
		// Observe setup rejection even if a caller discards the returned stream.
		void stream.catch(() => {});
		return {
			async *[Symbol.asyncIterator]() { yield* await stream; },
			async result() { return (await stream).result(); },
		};
	};
}

export const cursorPayloadStream = createPayloadStream((payload, _model, options) => {
	if (payload && typeof payload === "object" && typeof options.sessionId === "string" && options.sessionId.trim()) {
		payload.pi_session_id = options.sessionId;
	}
	return payload;
});
