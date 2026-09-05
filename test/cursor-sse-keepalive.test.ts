import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { startSSEResponse } from "../cursor/sse-keepalive.ts";

// Every server below opens the stream and then writes nothing on its own: upstream is silent,
// as it is during a long think. The proxy's transport contract is that the client still sees
// headers immediately and a steady trickle of bytes until the turn ends.

const INTERVAL_MS = 40;

async function withSilentServer(
  run: (harness: { port: number; response: () => ServerResponse; stop: () => void; writes: () => number }) => Promise<void>,
  keepaliveIntervalMs = INTERVAL_MS,
): Promise<void> {
  let response: ServerResponse | undefined;
  let stop = () => {};
  let writes = 0;
  const server = createServer((_req, res) => {
    response = res;
    const write = res.write.bind(res);
    res.write = ((chunk: any, ...rest: any[]) => (writes += 1, (write as any)(chunk, ...rest))) as typeof res.write;
    stop = startSSEResponse(res, keepaliveIntervalMs);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    await run({
      port,
      response: () => response!,
      stop: () => stop(),
      writes: () => writes,
    });
  } finally {
    stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** POST and resolve on response headers; reject if they never arrive. */
function post(port: number): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method: "POST", path: "/v1/chat/completions" }, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("response headers never arrived while upstream was silent"));
    }, 1_000);
    req.on("error", reject);
    req.end("{}");
  });
}

function readFor(res: IncomingMessage, ms: number): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => { text += chunk; });
    setTimeout(() => resolve(text), ms);
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("headers reach the client before upstream emits its first byte", async () => {
  await withSilentServer(async ({ port }) => {
    const res = await post(port);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "text/event-stream");
    res.destroy();
  }, 2_000);
});

test("keepalive comments flow during silence", async () => {
  await withSilentServer(async ({ port }) => {
    const res = await post(port);
    const frames = (await readFor(res, INTERVAL_MS * 6)).split("\n\n").filter(Boolean);
    assert.ok(frames.length >= 3, `expected several keepalives, got ${JSON.stringify(frames)}`);
    assert.ok(frames.every((frame) => frame.startsWith(":")), `keepalives must be SSE comments, got ${JSON.stringify(frames)}`);
    res.destroy();
  });
});

test("stopping the keepalive and ending the response leaves no timer writing", async () => {
  await withSilentServer(async ({ port, response, stop, writes }) => {
    const res = await post(port);
    await readFor(res, INTERVAL_MS * 3);

    stop();
    response().write("data: [DONE]\n\n");
    response().end();
    const rest = await new Promise<string>((resolve) => {
      let text = "";
      res.on("data", (chunk: string) => { text += chunk; });
      res.on("end", () => resolve(text));
    });
    assert.ok(rest.includes("data: [DONE]"), `stream must still terminate normally, got ${JSON.stringify(rest)}`);

    const settled = writes();
    await sleep(INTERVAL_MS * 4);
    assert.equal(writes(), settled);
  });
});

test("keepalive retires itself after the client disconnects", async () => {
  await withSilentServer(async ({ port, writes }) => {
    const res = await post(port);
    await readFor(res, INTERVAL_MS * 3);
    res.destroy();
    await sleep(INTERVAL_MS * 3);

    const settled = writes();
    await sleep(INTERVAL_MS * 4);
    assert.equal(writes(), settled);
  });
});
