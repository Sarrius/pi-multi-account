import assert from "node:assert/strict";
import test from "node:test";
import { createPayloadStream, PAYLOAD_ADMISSION } from "../provider-payload-stream.ts";
import { recoveryProviderAPI, hasRecoveryAdmission, type RecoveryProviderCoverage } from "../recovery-provider.ts";

const model = { provider: "owned", api: "owned-api", id: "small" };
function fixture() {
	const configs = new Map<string, any>(), native = new Map<string, any>();
	const coverage = new Map<string, RecoveryProviderCoverage>();
	const pi: any = { registerProvider(id: any, config: any) { if (typeof id === "object") native.set(id.id, id); else configs.set(id, config); } };
	const registry = { getRegisteredProviderConfig: (id: string) => configs.get(id), getRegisteredNativeProvider: (id: string) => native.get(id) };
	return { configs, native, coverage, pi, registry };
}

test("owned final admission follows async replacement AND provider shaping; rejected bodies never dispatch", async () => {
	const f = fixture(); let dispatched = 0;
	const transport = { streamSimple: (_m: any, _c: any, options: any) => ({ async result() {
		const body = await options.onPayload({ seed: true }, model); dispatched++; return body;
	} }) };
	const shaped = createPayloadStream(payload => ({ ...payload, providerAdded: "x".repeat(200) }), () => transport);
	const pi = recoveryProviderAPI(f.pi, payload => { if (Buffer.byteLength(JSON.stringify(payload)) > 150) throw new Error("admission"); }, f.coverage);
	pi.registerProvider("owned", { api: "owned-api", streamSimple: shaped } as any);
	assert.equal(hasRecoveryAdmission(f.registry, model, f.coverage), true);
	await assert.rejects(f.configs.get("owned").streamSimple(model, {}, { onPayload: async () => ({ replaced: true }) }).result(), /admission/);
	assert.equal(dispatched, 0);
});

test("request-local preparation admission is composed, not overwritten by the foreground guard", async () => {
	const f = fixture(); let sent = 0, local = 0;
	const stream = createPayloadStream(payload => ({ ...payload, shaped: true }), () => ({ streamSimple: (_m, _c, options) => ({ async result() { await options.onPayload({}, model); sent++; } }) }));
	const pi = recoveryProviderAPI(f.pi, () => {}, f.coverage);
	pi.registerProvider("owned", { api: "owned-api", streamSimple: stream } as any);
	await assert.rejects(f.configs.get("owned").streamSimple(model, {}, { [PAYLOAD_ADMISSION]: (payload: any) => { assert.equal(payload.shaped, true); local++; throw new Error("local budget"); } }).result(), /local budget/);
	assert.equal(local, 1); assert.equal(sent, 0);
});

test("catalog updates preserve shaping/API, but foreign API or stream replacements lose coverage", () => {
	const f = fixture(), pi = recoveryProviderAPI(f.pi, () => {}, f.coverage);
	pi.registerProvider("unknown", { name: "catalog only" } as any);
	assert.equal(f.coverage.has("unknown"), false);
	pi.registerProvider("owned", { api: "owned-api", streamSimple: createPayloadStream(payload => payload, () => ({ streamSimple: () => ({}) })) } as any);
	pi.registerProvider("owned", { models: [] } as any);
	assert.equal(f.configs.get("owned").api, "owned-api");
	assert.equal(hasRecoveryAdmission(f.registry, model, f.coverage), true);
	assert.equal(hasRecoveryAdmission(f.registry, { ...model, api: "foreign-api" }, f.coverage), false);
	f.configs.get("owned").streamSimple = () => ({});
	assert.equal(hasRecoveryAdmission(f.registry, model, f.coverage), false);
});

test("unowned custom adapters are preserved but never advertised as admitted", () => {
	const f = fixture(), pi = recoveryProviderAPI(f.pi, () => {}, f.coverage);
	const opaque = () => ({});
	pi.registerProvider("owned", { api: "owned-api", streamSimple: opaque } as any);
	assert.equal(f.configs.get("owned").streamSimple, opaque);
	assert.equal(hasRecoveryAdmission(f.registry, model, f.coverage), false);
});

test("native object registration preserves auth and guards both stream methods", async () => {
	const f = fixture(); let sent = 0;
	const native = { id: "owned", auth: { oauth: { sentinel: true } }, getModels: () => [model],
		stream: (_m: any, _c: any, options: any) => ({ async result() { await options.onPayload({ size: 1 }, model); sent++; } }),
		streamSimple: (_m: any, _c: any, options: any) => ({ async result() { await options.onPayload({ size: 1 }, model); sent++; } }) };
	const pi = recoveryProviderAPI(f.pi, () => { throw new Error("guarded"); }, f.coverage);
	(pi.registerProvider as any)(native);
	assert.equal(f.native.get("owned").auth, native.auth);
	assert.equal(hasRecoveryAdmission(f.registry, model, f.coverage), true);
	for (const method of ["stream", "streamSimple"]) await assert.rejects(f.native.get("owned")[method](model, {}, {}).result(), /guarded/);
	assert.equal(sent, 0);
	f.native.get("owned").streamSimple = () => ({});
	assert.equal(hasRecoveryAdmission(f.registry, model, f.coverage), false);
});
