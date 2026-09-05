/**
 * SSE keepalives preserve the client connection even when Cursor stops making progress.
 * The proxy resets this timer for decoded non-heartbeat messages, including thinking,
 * blob requests, and checkpoints. Heartbeats and incomplete frames do not reset it.
 */

/** Fail after five minutes without observed progress; this is a configurable timeout policy. */
export const UPSTREAM_STALL_TIMEOUT_MS = 5 * 60_000;

/** `PI_CURSOR_UPSTREAM_STALL_MS` overrides the window; `0` disables the watchdog. */
export function resolveUpstreamStallTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PI_CURSOR_UPSTREAM_STALL_MS?.trim();
  if (raw === undefined || raw === "") return UPSTREAM_STALL_TIMEOUT_MS;
  const parsed = Number(raw);
  // Node reduces delays above its signed 32-bit limit to one millisecond.
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) return UPSTREAM_STALL_TIMEOUT_MS;
  return parsed;
}

export function formatStallDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

export interface UpstreamWatchdog {
  /** Record decoded upstream progress; the stall deadline moves forward. */
  touch(): void;
  /** Retire the watchdog. Idempotent; later touches are ignored. */
  stop(): void;
}

/**
 * Arm a stall watchdog. `onStall` runs at most once, with how long upstream had been silent.
 * A non-positive `timeoutMs` produces an inert watchdog.
 */
export function startUpstreamWatchdog(onStall: (silentForMs: number) => void, timeoutMs: number): UpstreamWatchdog {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = timeoutMs <= 0;
  let lastProgressAt = performance.now();

  const arm = (delayMs = timeoutMs) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (stopped) return;
      const silentForMs = performance.now() - lastProgressAt;
      // Timers may wake early. Recheck a monotonic deadline before ending the stream.
      if (silentForMs < timeoutMs) { arm(Math.ceil(timeoutMs - silentForMs)); return; }
      stopped = true;
      timer = undefined;
      onStall(silentForMs);
    }, delayMs);
    timer.unref?.();
  };

  arm();

  return {
    touch() {
      if (stopped) return;
      lastProgressAt = performance.now();
      arm();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
