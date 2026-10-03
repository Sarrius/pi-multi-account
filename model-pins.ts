/** Explicit routing preferences; never foreground selections or authorization for a cheaper tier. */
import { mutateConfigFile } from "./config-file-transaction.ts";

export function validModelPinScope(scope: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(scope);
}

export function normalizeModelPins(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(Object.entries(value).filter(([scope, model]) =>
		validModelPinScope(scope) && typeof model === "string" && model.trim().length > 0 &&
		!/[\s\x00-\x1f]/.test(model.trim()),
	).map(([scope, model]) => [scope, (model as string).trim()]));
}

/** Change only one group's pin through the shared extension configuration transaction. */
export function persistModelPin(
	path: string,
	scope: string,
	model: string | undefined,
	canCommit: () => boolean = () => true,
): Record<string, string> {
	if (!validModelPinScope(scope) || (model !== undefined && normalizeModelPins({ [scope]: model })[scope] !== model)) {
		throw new Error("invalid model pin");
	}
	const next = mutateConfigFile(path, disk => {
		if (disk.pinnedModels !== undefined && (!disk.pinnedModels || typeof disk.pinnedModels !== "object" || Array.isArray(disk.pinnedModels))) {
			throw new Error("pinnedModels must be an object");
		}
		const pins = { ...disk.pinnedModels };
		if (model === undefined) delete pins[scope];
		else pins[scope] = model;
		return { pinnedModels: pins };
	}, canCommit);
	return normalizeModelPins(next.pinnedModels);
}
