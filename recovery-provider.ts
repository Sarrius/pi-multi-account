import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPayloadStream, PAYLOAD_ADMISSION, OWNED_PAYLOAD_STREAM } from "./provider-payload-stream.ts";

export interface RecoveryProviderCoverage {
	apis: Set<string>;
	streamSimple: unknown;
	native: boolean;
}
export function hasRecoveryAdmission(registry: any, model: any, coverage: Map<string, RecoveryProviderCoverage>): boolean {
	const proof = coverage.get(model?.provider);
	if (!proof?.apis.has(model?.api) || typeof proof.streamSimple !== "function") return false;
	const extension = registry?.getRegisteredProviderConfig?.(model.provider);
	if (extension?.streamSimple && extension.api === model.api) return extension.streamSimple === proof.streamSimple;
	return proof.native && registry?.getRegisteredNativeProvider?.(model.provider)?.streamSimple === proof.streamSimple;
}

/** Per-extension registration facade, not a global provider/API monkey patch.
 * Legacy shaping streams consume the symbol AFTER their own transformation;
 * native object providers also get their public final onPayload boundary.
 */
export function recoveryProviderAPI(pi: ExtensionAPI, admit: (payload: unknown, model: any, options: any) => void, registered: Map<string, RecoveryProviderCoverage>): ExtensionAPI {
	const defaultStream = createPayloadStream(payload => payload);
	const prior = new Map<string, any>();
	const priorApi = new Map<string, string>();
	const wrapOptions = (options: any = {}, direct: boolean) => ({ ...options,
		[PAYLOAD_ADMISSION]: async (payload: unknown, model: any) => {
			await options[PAYLOAD_ADMISSION]?.(payload, model);
			admit(payload, model, options);
		},
		...(direct ? { onPayload: async (payload: unknown, model: any) => {
			const proposed = await options.onPayload?.(payload, model);
			const final = proposed === undefined ? payload : proposed;
			await options[PAYLOAD_ADMISSION]?.(final, model);
			admit(final, model, options);
			return final;
		} } : {}),
	});
	return new Proxy(pi, { get(target, property, receiver) {
		if (property !== "registerProvider") return Reflect.get(target, property, receiver);
		return (id: any, config?: any) => {
			if (typeof id === "object" && id !== null) {
				const provider = id, wrapped = { ...provider };
				for (const method of ["stream", "streamSimple"] as const) if (typeof provider[method] === "function")
					wrapped[method] = (model: any, context: any, options: any) => provider[method](model, context, wrapOptions(options, true));
				if (typeof wrapped.streamSimple === "function") Object.assign(wrapped.streamSimple, { [OWNED_PAYLOAD_STREAM]: true });
				prior.set(provider.id, wrapped.streamSimple);
				const api = provider.getModels?.().find((model: any) => !model.type || model.type === "chat")?.api;
				if (api) priorApi.set(provider.id, api);
				const result = (target.registerProvider as any)(wrapped);
				registered.set(provider.id, { apis: new Set((provider.getModels?.() ?? []).filter((model: any) => !model.type || model.type === "chat").map((model: any) => String(model.api))), streamSimple: wrapped.streamSimple, native: true });
				return result;
			}
			const api = config?.api ?? priorApi.get(id);
			if (!api) return target.registerProvider(id, config); // Do not invent an API for an unmanaged/catalog-only provider.
			const stream = config?.streamSimple ?? prior.get(id) ?? defaultStream;
			if (stream[OWNED_PAYLOAD_STREAM] !== true) {
				// A custom adapter need not consume our post-shaping admission symbol.
				// Preserve it, but never mistake registration for demonstrated coverage.
				const result = target.registerProvider(id, { ...config, api, streamSimple: stream });
				prior.set(id, stream); priorApi.set(id, api); registered.delete(id);
				return result;
			}
			const streamSimple = Object.assign((model: any, context: any, options: any) => stream(model, context, wrapOptions(options, false)), { [OWNED_PAYLOAD_STREAM]: true });
			const result = target.registerProvider(id, { ...config, api, streamSimple });
			prior.set(id, stream); priorApi.set(id, api);
			registered.set(id, { apis: new Set([api]), streamSimple, native: false });
			return result;
		};
	} });
}
