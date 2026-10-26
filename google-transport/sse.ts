import { cancellable } from "./http.ts";

/** Strict SSE framing, bounded per frame and per response; UTF-8 is incremental/fatal. */
export async function* events(body: ReadableStream<Uint8Array>, signal: AbortSignal,
  maxEventBytes = 262144, maxStreamBytes = 33554432): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", data: string[] = [], frameBytes = 0, total = 0, ended = false, complete = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  function line(value: string): { event: unknown } | undefined {
    frameBytes += Buffer.byteLength(value, "utf8") + 1;
    if (frameBytes > maxEventBytes) throw new Error("Google SSE event exceeds limit");
    if (value === "") {
      frameBytes = 0;
      if (!data.length) return;
      const text = data.join("\n");
      data = [];
      if (text === "[DONE]") {
        if (ended) throw new Error("Duplicate Google SSE terminator");
        ended = true;
        return;
      }
      if (ended) throw new Error("Google SSE data after terminator");
      try { return { event: JSON.parse(text) as unknown }; }
      catch { throw new Error("Malformed Google SSE JSON"); }
    }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? "" : value.slice(colon + 1);
    if (content.startsWith(" ")) content = content.slice(1);
    if (field === "data") data.push(content);
    else if (!["id", "event", "retry"].includes(field)) throw new Error("Malformed Google SSE field");
  }
  try {
    while (true) {
      const chunk = await cancellable(reader.read(), signal);
      signal.throwIfAborted();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxStreamBytes) throw new Error("Google SSE response exceeds limit");
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const value = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        const parsed = line(value);
        if (parsed) yield parsed.event;
      }
      if (Buffer.byteLength(buffer, "utf8") + frameBytes > maxEventBytes) throw new Error("Google SSE event exceeds limit");
    }
    buffer += decoder.decode();
    if (buffer.length || data.length) throw new Error("Truncated Google SSE frame");
    signal.throwIfAborted();
    complete = true;
  } finally {
    signal.removeEventListener("abort", abort);
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
