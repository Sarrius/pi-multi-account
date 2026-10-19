export const PAYLOAD_ADMISSION = Symbol("multi-account-payload-admission");
export const OWNED_PAYLOAD_STREAM = Symbol("multi-account-owned-payload-stream");
export async function admitProviderPayload(payload: unknown, model: any, options: any) {
	await options?.[PAYLOAD_ADMISSION]?.(payload, model);
}

type Shape = (payload: any, model: any, options: any, context: any) => any;
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
	const stream = (model: any, context: any, options: any = {}) => {
		const start = (api: Api) => api.streamSimple(model, context, {
			...options,
			onPayload: async (payload: any, actualModel: any) => {
				const replacement = await options.onPayload?.(payload, actualModel);
				const current = replacement === undefined ? payload : replacement;
				const shaped = await shape(current, actualModel, options, context);
				const final = shaped === undefined ? current : shaped;
				await admitProviderPayload(final, actualModel, options);
				return final;
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
	return Object.assign(stream, { [OWNED_PAYLOAD_STREAM]: true });
}

// Native Pi keeps item-level uniqueness when converting Responses pipe ids to
// Chat Completions ids. Support that exact spelling and older call-id-only hosts;
// collisions are never allowed to borrow another execution's error outcome.
function cursorToolIdAliases(id:string):string[] {
	const pipe=id.indexOf("|");if(pipe<0)return [id];
	const call=id.slice(0,pipe).replace(/[^a-zA-Z0-9_-]/g,"_");
	const item=id.slice(pipe+1).replace(/[^a-zA-Z0-9_-]/g,"_");
	let native=item?`${call}_${item}`:call;
	if(native.length>40){
		let h1=0xdeadbeef,h2=0x41c6ce57;
		for(let i=0;i<id.length;i++){const ch=id.charCodeAt(i);h1=Math.imul(h1^ch,2654435761);h2=Math.imul(h2^ch,1597334677);}
		h1=Math.imul(h1^(h1>>>16),2246822507)^Math.imul(h2^(h2>>>13),3266489909);
		h2=Math.imul(h2^(h2>>>16),2246822507)^Math.imul(h1^(h1>>>13),3266489909);
		const hash=((h2>>>0).toString(36)+(h1>>>0).toString(36)).slice(0,8);
		native=`${call.slice(0,Math.max(1,40-hash.length-1))}_${hash}`;
	}
	return [...new Set([id,native,call.slice(0,40)])];
}

export function shapeCursorPayload(payload: any, options: any, context?: any) {
	if (payload && typeof payload === "object" && typeof options.sessionId === "string" && options.sessionId.trim()) {
		payload.pi_session_id = options.sessionId;
	}
	if (payload && typeof payload === "object" && typeof options.cwd === "string" && options.cwd.trim()) {
		payload.pi_cwd = options.cwd;
	}
	// The native OpenAI serializer drops ToolResultMessage.isError. Carry only
	// the boolean across this local proxy boundary; never infer errors from prose.
	if (Array.isArray(payload?.messages) && Array.isArray(context?.messages)) {
		const errors = new Map<string, boolean>();
		const ambiguous = new Set<string>();
		for (const result of context.messages) {
			if (result.role !== "toolResult" || typeof result.toolCallId !== "string") continue;
			const id = result.toolCallId;
			const aliases = cursorToolIdAliases(id);
			for (const alias of aliases) {
				if (errors.has(alias)) ambiguous.add(alias);
				errors.set(alias, result.isError === true);
			}
		}
		for (const message of payload.messages) {
			if (message.role === "tool" && errors.has(message.tool_call_id) && !ambiguous.has(message.tool_call_id))
				message.pi_tool_error = errors.get(message.tool_call_id);
		}
	}
	return payload;
}
export const cursorPayloadStream = createPayloadStream((payload, _model, options, context) => shapeCursorPayload(payload, options, context));
