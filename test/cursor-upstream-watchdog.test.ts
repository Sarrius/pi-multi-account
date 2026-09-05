import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  UPSTREAM_STALL_TIMEOUT_MS,
  formatStallDuration,
  resolveUpstreamStallTimeoutMs,
  startUpstreamWatchdog,
} from "../cursor/upstream-watchdog.ts";

/**
 * With SSE keepalives holding the client connection open, the only thing that can end a turn
 * Cursor has silently abandoned is our own view of upstream progress. These tests pin that
 * watchdog: it fires once after a quiet period, observed progress pushes it back, and closing
 * the response retires it.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("fires once after upstream goes quiet, reporting how long it was silent", async () => {
  const fired: number[] = [];
  startUpstreamWatchdog((silentForMs) => fired.push(silentForMs), 40);
  await sleep(150);
  assert.equal(fired.length, 1, "stall callback must fire exactly once");
  assert.ok(fired[0] >= 40, `reported silence ${fired[0]}ms should be at least the timeout`);
});

test("observed progress pushes the deadline back", async () => {
  let fired = 0;
  const watchdog = startUpstreamWatchdog(() => { fired += 1; }, 60);
  for (let i = 0; i < 5; i += 1) {
    await sleep(25);
    watchdog.touch();
  }
  assert.equal(fired, 0, "a stream that keeps producing frames is not stalled");
  await sleep(120);
  assert.equal(fired, 1, "once frames stop, the stall is still detected");
  watchdog.stop();
});

test("stop() retires the watchdog and later touches are inert", async () => {
  let fired = 0;
  const watchdog = startUpstreamWatchdog(() => { fired += 1; }, 30);
  watchdog.stop();
  watchdog.touch();
  await sleep(100);
  assert.equal(fired, 0);
});

test("a non-positive timeout disables the watchdog", async () => {
  let fired = 0;
  const watchdog = startUpstreamWatchdog(() => { fired += 1; }, 0);
  await sleep(50);
  assert.equal(fired, 0);
  watchdog.stop();
});

test("default timeout is five minutes and the env override is honoured", () => {
  assert.equal(UPSTREAM_STALL_TIMEOUT_MS, 5 * 60_000);
  assert.equal(resolveUpstreamStallTimeoutMs({}), UPSTREAM_STALL_TIMEOUT_MS);
  assert.equal(resolveUpstreamStallTimeoutMs({ PI_CURSOR_UPSTREAM_STALL_MS: "120000" }), 120_000);
  assert.equal(resolveUpstreamStallTimeoutMs({ PI_CURSOR_UPSTREAM_STALL_MS: "0" }), 0, "0 disables");
  assert.equal(resolveUpstreamStallTimeoutMs({ PI_CURSOR_UPSTREAM_STALL_MS: "soon" }), UPSTREAM_STALL_TIMEOUT_MS, "garbage falls back");
  assert.equal(resolveUpstreamStallTimeoutMs({ PI_CURSOR_UPSTREAM_STALL_MS: "-5" }), UPSTREAM_STALL_TIMEOUT_MS, "negative falls back");
  assert.equal(resolveUpstreamStallTimeoutMs({ PI_CURSOR_UPSTREAM_STALL_MS: "0.5" }), UPSTREAM_STALL_TIMEOUT_MS, "fractions must not disable the watchdog");
  assert.equal(resolveUpstreamStallTimeoutMs({ PI_CURSOR_UPSTREAM_STALL_MS: "1.5" }), UPSTREAM_STALL_TIMEOUT_MS, "fractional milliseconds fall back");
  assert.equal(resolveUpstreamStallTimeoutMs({ PI_CURSOR_UPSTREAM_STALL_MS: "2147483647" }), 2_147_483_647, "largest supported timer delay is valid");
  assert.equal(resolveUpstreamStallTimeoutMs({ PI_CURSOR_UPSTREAM_STALL_MS: "2147483648" }), UPSTREAM_STALL_TIMEOUT_MS, "overflow must not become a one-millisecond timeout");
});

test("stall durations read naturally in the error surfaced to the user", () => {
  assert.equal(formatStallDuration(300_000), "5m");
  assert.equal(formatStallDuration(90_000), "1m 30s");
  assert.equal(formatStallDuration(45_000), "45s");
  assert.equal(formatStallDuration(301_400), "5m 1s");
});

// Generated protobuf enums need Node's transform mode; keep it local to the proxy test.
test("the proxy measures decoded progress rather than heartbeat or partial-frame traffic", () => {
  execFileSync(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { EventEmitter } from "node:events";
    import { mock } from "node:test";
    import { create, toBinary } from "@bufbuild/protobuf";
    import { AgentServerMessageSchema } from "./cursor/proto/agent_pb.ts";
    import { writeSSEStreamForTests } from "./cursor/proxy.ts";

    process.env.PI_CURSOR_UPSTREAM_STALL_MS = "200";
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    function frame(message) {
      const payload = toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, { message }));
      const bytes = Buffer.alloc(5 + payload.length);
      bytes.writeUInt32BE(payload.length, 1);
      bytes.set(payload, 5);
      return bytes;
    }
    function stream() {
      let receive;
      let output = "";
      let cancelled = false;
      const req = new EventEmitter();
      const res = Object.assign(new EventEmitter(), {
        writableEnded: false, destroyed: false,
        writeHead() {}, flushHeaders() {},
        write(data) { output += data; },
        end() { this.writableEnded = true; },
      });
      const bridge = {
        alive: true, proc: { kill() {} }, write() {},
        end() { cancelled = true; },
        onData(callback) { receive = callback; }, onClose() {},
      };
      writeSSEStreamForTests({
        bridge, heartbeatTimer: setInterval(() => {}, 5000),
        modelId: "fixture", bridgeKey: "fixture", convKey: "fixture",
        completedTurns: [], currentTurn: { user: [], steps: [] }, req, res,
      });
      return { res, req, receive: (bytes) => receive(bytes), output: () => output, cancelled: () => cancelled };
    }
    const heartbeat = frame({ case: "interactionUpdate", value: { message: { case: "heartbeat", value: {} } } });
    const thinking = frame({ case: "interactionUpdate", value: { message: { case: "thinkingDelta", value: { text: "thinking" } } } });
    try {
      const stalled = stream();
      for (let i = 0; i < 10; i++) {
        stalled.receive(heartbeat);
        mock.timers.tick(50);
      }
      assert.equal(stalled.res.writableEnded, true, "heartbeat-only traffic must time out");
      assert.equal(stalled.cancelled(), true, "the stalled bridge must be cancelled");
      assert.match(stalled.output(), /stream timed out/);
      assert.equal((stalled.output().match(/stream timed out/g) ?? []).length, 1);

      const partial = stream();
      partial.receive(thinking.subarray(0, 5));
      for (let i = 5; i < 10; i++) {
        mock.timers.tick(50);
        partial.receive(thinking.subarray(i, i + 1));
      }
      assert.equal(partial.res.writableEnded, true, "incomplete frames must not count as progress");

      const active = stream();
      for (let i = 0; i < 10; i++) {
        mock.timers.tick(50);
        active.receive(thinking);
      }
      assert.equal(active.res.writableEnded, false, "thinking must extend the deadline");
      mock.timers.tick(150);
      active.receive(frame({ case: "conversationCheckpointUpdate", value: {} }));
      mock.timers.tick(150);
      assert.equal(active.res.writableEnded, false, "checkpoints must extend the deadline");
      active.receive(frame({ case: "kvServerMessage", value: { message: { case: "getBlobArgs", value: { blobId: new Uint8Array() } } } }));
      mock.timers.tick(150);
      assert.equal(active.res.writableEnded, false, "blob requests must extend the deadline");
      active.req.emit("close");
      const closedOutput = active.output();
      mock.timers.tick(500);
      assert.equal(active.output(), closedOutput, "closing must retire the watchdog");
    } finally {
      mock.timers.reset();
    }
  `], { cwd: new URL("../", import.meta.url), stdio: "pipe" });
});
