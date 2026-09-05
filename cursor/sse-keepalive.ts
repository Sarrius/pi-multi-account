import type { ServerResponse } from "node:http";

/** Flush headers before the first model token, then send SSE comments during pauses. */
export const SSE_KEEPALIVE_INTERVAL_MS = 15_000;

/** Open a streaming SSE response and keep it warm. Returns the function that stops the keepalive. */
export function startSSEResponse(res: ServerResponse, keepaliveIntervalMs = SSE_KEEPALIVE_INTERVAL_MS): () => void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  res.flushHeaders();

  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(timer);
      return;
    }
    res.write(": keepalive\n\n");
  }, keepaliveIntervalMs);

  return () => clearInterval(timer);
}
