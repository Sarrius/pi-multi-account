/**
 * Pi died with ERR_STREAM_WRITE_AFTER_END on 2026-08-23, minutes after compaction started
 * closing the Cursor conversation:
 *
 *   at Object.write (cursor/proxy.ts:378)          <- the bridge handle
 *   at sendKvResponse (cursor/proxy.ts:1218)       <- answering Cursor's blob request
 *   at processServerMessage (cursor/proxy.ts:1191) <- data still arriving on a closed bridge
 *
 * The write site was already wrapped in try/catch, and that is the whole trap: a write into an
 * ended pipe does not throw there. Node raises it on a later tick as an `error` event on the
 * stream, and a stream with no error listener turns that into an uncaughtException — fatal for
 * the host, from inside a provider bridge that has no business ever killing it.
 *
 * These tests lock the class, not just the one path: nothing the bridge does may reach the
 * host as an uncaught exception, and a pipe we closed ourselves must read as closed.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createBridgeHandle, lpEncode, type BridgeStreams } from "../cursor/bridge-handle.ts";

class FakeProc extends EventEmitter {
	stdin = new PassThrough();
	stdout = new PassThrough();
	killed = false;
	kill() {
		this.killed = true;
	}
}

function makeBridge() {
	const proc = new FakeProc();
	const written: Buffer[] = [];
	proc.stdin.on("data", (chunk: Buffer) => written.push(chunk));
	const debug: string[] = [];
	const handle = createBridgeHandle(proc as unknown as BridgeStreams, {
		debug: (event) => debug.push(event),
	});
	return { proc, handle, written, debug };
}

/** Let Node deliver the stream error it queues for a later tick. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 5));
}

test("a write after the bridge was ended is dropped instead of killing the host", async () => {
	const { handle, written, debug } = makeBridge();
	handle.write(new TextEncoder().encode("first"));
	handle.end();
	const afterEnd = written.length;

	// This is the crash: compaction ended the bridge, Cursor asked for one more blob, and the
	// reply went into the closed pipe.
	handle.write(new TextEncoder().encode("kv reply"));
	await settle();

	assert.equal(written.length, afterEnd, "nothing may be pushed into a closed pipe");
	assert.ok(debug.includes("bridge.write_after_end"), "the dropped write must be traceable");
});

test("an ended bridge reports itself as dead, so callers do not try to resume it", () => {
	const { handle } = makeBridge();
	assert.equal(handle.alive, true);
	handle.end();
	assert.equal(handle.alive, false, "a pipe we closed ourselves is not a pipe to resume on");
});

test("ending twice is harmless", () => {
	const { handle } = makeBridge();
	handle.end();
	handle.end();
	assert.equal(handle.alive, false);
});

test("destroying a cancelled bridge terminates its HTTP/2 subprocess", () => {
	const { proc, handle } = makeBridge();
	handle.destroy();
	assert.equal(handle.alive, false);
	assert.equal(proc.killed, true, "closing stdin alone leaves a streaming Cursor bridge alive");
});

test("a late write that slips past the guard still cannot become an uncaught exception", async () => {
	const { proc } = makeBridge();
	// Bypass the handle entirely and write straight into the ended pipe — the failure mode the
	// error listener exists for. Without that listener this line takes the whole process down,
	// and the test run with it.
	proc.stdin.end();
	proc.stdin.write(lpEncode(new TextEncoder().encode("late")));
	await settle();

	assert.ok(proc.stdin.listenerCount("error") > 0, "every stream we own carries an error listener");
});

test("a bridge process that fails to spawn is logged, not thrown", async () => {
	const { proc, debug } = makeBridge();
	proc.emit("error", new Error("spawn node ENOENT"));
	await settle();
	assert.ok(debug.includes("bridge.process_error"));
});

test("the bridge still delivers length-prefixed frames and its exit code", async () => {
	const { proc, handle } = makeBridge();
	const frames: string[] = [];
	handle.onData((chunk) => frames.push(chunk.toString("utf8")));
	const closed: number[] = [];
	handle.onClose((code) => closed.push(code));

	// Two frames in one chunk, plus a third split across chunk boundaries.
	const whole = Buffer.concat([
		lpEncode(new TextEncoder().encode("alpha")),
		lpEncode(new TextEncoder().encode("beta")),
	]);
	proc.stdout.write(whole);
	const split = lpEncode(new TextEncoder().encode("gamma"));
	proc.stdout.write(split.subarray(0, 3));
	proc.stdout.write(split.subarray(3));
	await settle();

	proc.emit("exit", 0);
	assert.deepEqual(closed, [], "exit must not discard stdout which can still be draining");
	proc.emit("close", 0);
	await settle();

	assert.deepEqual(frames, ["alpha", "beta", "gamma"]);
	assert.deepEqual(closed, [0]);
});

test("spawn failure without exit settles pending and late close listeners exactly once", async () => {
	const { proc, handle, written } = makeBridge();
	const closed: number[] = [];
	handle.onClose(code => closed.push(code));
	proc.emit("error", new Error("spawn node ENOENT"));
	assert.equal(handle.alive, false);
	handle.write(new Uint8Array([1]));
	assert.equal(written.length, 0);
	proc.emit("close", null);
	proc.emit("exit", 1);
	await settle();
	assert.deepEqual(closed, [1]);
	const late: number[] = [];
	handle.onClose(code => late.push(code));
	await settle();assert.deepEqual(late, [1]);
});

test("a bridge whose process already exited is dead and swallows further writes", async () => {
	const { proc, handle, written } = makeBridge();
	proc.emit("exit", 1);
	await settle();
	assert.equal(handle.alive, false);
	handle.write(new TextEncoder().encode("too late"));
	assert.equal(written.length, 0);
});
