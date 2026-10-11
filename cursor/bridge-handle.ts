/**
 * The handle around one bridge child process.
 *
 * Cursor talks over a long-lived HTTP/2 stream, and the conversation is genuinely
 * bidirectional: while the model streams its answer, Cursor keeps asking us for blobs and we
 * keep answering on the same pipe. So the pipe can be closed from our side — a cancelled turn,
 * a session teardown, a compaction that starts a new conversation — while replies to Cursor's
 * requests are still in flight.
 *
 * A write into a closed pipe does not fail where it is written. Node reports
 * ERR_STREAM_WRITE_AFTER_END on a later tick, as an `error` event on the stream, which walks
 * straight past the try/catch at the call site and, with no listener, becomes an
 * uncaughtException that takes Pi down with it. That is exactly what happened after a
 * compaction closed the bridge and Cursor asked for one more blob.
 *
 * Hence two rules, both enforced here rather than at each of the dozen call sites:
 *   - once ended, the handle is not alive and silently drops writes;
 *   - every stream we own carries an error listener, so nothing the bridge does can ever
 *     surface as an uncaught exception in the host process.
 */

import { STATUS_PREFIX, safeTransportStatus } from "./transport-status.mjs";
export interface BridgeTransportStatus { httpStatus?: number; code?: string; retryAfterMs?: number; }

export interface BridgeStreams {
  stdin: {
    write(chunk: Uint8Array): unknown;
    end(): unknown;
    on(event: "error", listener: (error: Error) => void): unknown;
    readonly writableEnded?: boolean;
    readonly destroyed?: boolean;
  } | null;
  stdout: {
    on(event: "data" | "error", listener: (payload: never) => void): unknown;
  } | null;
  stderr?: { on(event: "data" | "error", listener: (payload: never) => void): unknown } | null;
  on(event: "exit" | "close" | "error", listener: (payload: never) => void): unknown;
  kill(signal?: NodeJS.Signals | number): unknown;
}

export interface BridgeHandle {
  proc: { kill(signal?: NodeJS.Signals | number): unknown };
  readonly alive: boolean;
  write(data: Uint8Array): void;
  end(): void;
  destroy(): void;
  onData(cb: (chunk: Buffer) => void): void;
  onClose(cb: (code: number) => void): void;
  onStatus?(cb: (status: BridgeTransportStatus) => void): void;
}

/** Length-prefix a frame the way the bridge process expects it. */
export function lpEncode(data: Uint8Array): Buffer {
  const buf = Buffer.alloc(4 + data.length);
  buf.writeUInt32BE(data.length, 0);
  buf.set(data, 4);
  return buf;
}

export function createBridgeHandle(
  proc: BridgeStreams,
  hooks: { debug?: (event: string, data: Record<string, unknown>) => void } = {},
): BridgeHandle {
  const debug = hooks.debug ?? (() => {});
  const cbs = {
    data: null as ((chunk: Buffer) => void) | null,
    close: null as ((code: number) => void) | null,
    status: null as ((status: BridgeTransportStatus) => void) | null,
  };

  let exited = false;
  let ended = false;
  let closed = false;
  let exitCode = 1;
  let lastStatus: BridgeTransportStatus | undefined;
  const closeOnce=(code:number|null)=>{
    if(closed)return;
    closed=true;exitCode=code??exitCode;
    const callback=cbs.close;cbs.close=null;callback?.(exitCode);
  };

  // The safety net. A late write, a broken pipe, a bridge that could not be spawned at all —
  // none of them may reach the host's uncaughtException handler.
  proc.stdin?.on("error", (error: Error) => {
    debug("bridge.stdin_error", { error: String(error) });
  });
  proc.stdout?.on("error", ((error: Error) => {
    debug("bridge.stdout_error", { error: String(error) });
  }) as never);
  proc.on("error", ((error: Error) => {
    debug("bridge.process_error", { error: String(error) });
    if(!closed){closeOnce(1);try{proc.kill();}catch{/* failed spawn has no child */}}
  }) as never);

  // A stderr metadata channel leaves stdout's old protobuf framing compatible.
  let statusBuffer="";
  proc.stderr?.on("error", ((error:Error)=>debug("bridge.stderr_error",{error:String(error)})) as never);
  proc.stderr?.on("data", ((chunk:Buffer)=>{
    statusBuffer+=chunk.toString("utf8");
    if(statusBuffer.length>16_384){statusBuffer="";return;}
    const lines=statusBuffer.split("\n");statusBuffer=lines.pop()??"";
    for(const line of lines){
      if(!line.startsWith(STATUS_PREFIX))continue;
      try{
        const status=safeTransportStatus(JSON.parse(line.slice(STATUS_PREFIX.length)));
        if(Object.keys(status).length){lastStatus=status;cbs.status?.(status);}
      }catch{/* malformed metadata never reaches consumers */}
    }
  }) as never);

  let pending = Buffer.alloc(0);
  proc.stdout?.on("data", ((chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const len = pending.readUInt32BE(0);
      if (pending.length < 4 + len) break;
      const payload = pending.subarray(4, 4 + len);
      pending = pending.subarray(4 + len);
      cbs.data?.(Buffer.from(payload));
    }
  }) as never);

  proc.on("exit", ((code: number | null) => {
    exited = true;
    if(!closed)exitCode = code ?? 1;
    debug("bridge.exit", { exitCode:code??1, terminalCode:exitCode });
    // stdout can still contain terminal frames; consume through process close.
  }) as never);
  proc.on("close", ((code:number|null)=>{exited=true;closeOnce(code);}) as never);

  const writable = (): boolean => {
    if (closed || exited || ended) return false;
    const stdin = proc.stdin;
    if (!stdin) return false;
    return !stdin.writableEnded && !stdin.destroyed;
  };

  const end = (): void => {
    if (ended) return;
    if (writable()) {
      try {
        proc.stdin!.write(lpEncode(new Uint8Array(0)));
        proc.stdin!.end();
      } catch (error) {
        debug("bridge.end_failed", { error: String(error) });
      }
    }
    ended = true;
  };

  return {
    proc,
    // Ended counts as dead: a caller that asks `alive` is deciding whether to keep talking on
    // this pipe, and the answer for a pipe we closed ourselves is no.
    get alive() { return !closed && !exited && !ended; },
    write(data: Uint8Array) {
      if (!writable()) {
        debug("bridge.write_after_end", { bytes: data.length, exited, ended });
        return;
      }
      try {
        proc.stdin!.write(lpEncode(data));
      } catch (error) {
        debug("bridge.write_failed", { error: String(error) });
      }
    },
    end,
    destroy() {
      end();
      if (exited) return;
      try {
        proc.kill();
      } catch (error) {
        debug("bridge.kill_failed", { error: String(error) });
      }
      closeOnce(1); // disposal settles even if a failed kill never emits exit/close
    },
    onData(cb: (chunk: Buffer) => void) { cbs.data = cb; },
    onClose(cb: (code: number) => void) {
      if (closed) {
        queueMicrotask(() => cb(exitCode));
      } else {
        cbs.close = cb;
      }
    },
    onStatus(cb) { cbs.status=cb;const snapshot=lastStatus;if(snapshot)queueMicrotask(()=>cb(snapshot)); },
  };
}
