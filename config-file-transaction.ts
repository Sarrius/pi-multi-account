/** Shared read-latest/field-scoped transaction for every extension config writer. */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const pause = new Int32Array(new SharedArrayBuffer(4));

export function mutateConfigFile(
	path: string,
	patch: (disk: Record<string, any>) => Record<string, unknown>,
	canCommit: () => boolean = () => true,
): Record<string, any> {
	// Preserve config symlinks and make aliases coordinate on the same target lock.
	const target = realpathSync(path);
	const lockfile = require("proper-lockfile") as { lockSync(path: string, options: object): () => void };
	let release: (() => void) | undefined;
	const deadline = Date.now() + 250;
	while (!release) {
		if (!canCommit()) throw new Error("session changed before config persistence");
		try { release = lockfile.lockSync(target, { realpath: false }); }
		catch (error: any) {
			if (error?.code !== "ELOCKED" || Date.now() >= deadline) throw error;
			Atomics.wait(pause, 0, 0, 5);
		}
	}
	const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
	try {
		const disk = JSON.parse(readFileSync(target, "utf8"));
		if (!disk || typeof disk !== "object" || Array.isArray(disk)) throw new Error("config must be an object");
		const delta = patch(disk);
		if (!delta || typeof delta !== "object" || Array.isArray(delta)) throw new Error("config patch must be an object");
		const next = { ...disk, ...delta };
		if (!canCommit()) throw new Error("session changed before config persistence");
		writeFileSync(temp, `${JSON.stringify(next, null, "\t")}\n`, { mode: 0o600, flag: "wx" });
		if (!canCommit()) throw new Error("session changed before config persistence");
		renameSync(temp, target);
		return next;
	} finally {
		try { rmSync(temp, { force: true }); } finally { release(); }
	}
}
