/**
 * Server-Sent Events encoding for `AgentEvent`s (docs/API.md, ARCHITECTURE.md
 * "Streaming event contract").
 *
 * Invariants the UI relies on (docs/SECURITY.md "Error handling model"):
 *  - every stream ends with exactly one terminal event (`done` or `error`);
 *  - a heartbeat comment is sent while the agent is silent so proxies and
 *    load balancers do not drop the idle connection during a long tool call
 *    (transport-level only: the browser parser discards comment frames, so
 *    heartbeats do not reset the UI's inactivity timeout);
 *  - `onFinish` runs exactly once, whether the stream completed, failed or the
 *    client disconnected (the turn lock is released there).
 */
import type { AgentEvent } from "@/shared/contracts";
import { AppError } from "@/server/http/errors";

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

const DEFAULT_HEARTBEAT_MS = 15_000;
const HEARTBEAT_LINE = ": heartbeat\n\n";

export function encodeEvent(event: AgentEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === "done" || event.type === "error";
}

export type SseOptions = {
  /** Aborts when the client goes away (`request.signal`). */
  signal?: AbortSignal;
  heartbeatMs?: number;
  /** Runs in `finally`; errors are logged, never propagated. */
  onFinish?: () => Promise<void> | void;
};

/**
 * Converts a thrown value into the terminal error event. AppError messages are
 * safe to show but describe a precondition (e.g. missing API key) that a retry
 * will not fix; unknown failures are masked and may be transient.
 */
function toErrorEvent(err: unknown): AgentEvent {
  if (err instanceof AppError) {
    return {
      type: "error",
      code: err.code === "upstream_error" ? "upstream_error" : "internal_error",
      message: err.message,
      retryable: false,
    };
  }
  console.error("[sse] agent stream failed", err);
  return { type: "error", code: "internal_error", message: "The assistant failed unexpectedly.", retryable: true };
}

export function createSseResponse(events: AsyncIterable<AgentEvent>, opts: SseOptions = {}): Response {
  const encoder = new TextEncoder();
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const iterator = events[Symbol.asyncIterator]();

  let closed = false;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;

  const stopIterator = (): void => {
    // For async generators this queues a `return` behind any pending `next`,
    // which runs the generator's `finally` blocks (agent cleanup) without throwing here.
    void iterator.return?.().catch(() => undefined);
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: string): void => {
        if (closed) return;
        controller.enqueue(encoder.encode(chunk));
      };
      const scheduleHeartbeat = (): void => {
        clearTimeout(heartbeat);
        heartbeat = setTimeout(() => {
          write(HEARTBEAT_LINE);
          scheduleHeartbeat();
        }, heartbeatMs);
      };
      const onAbort = (): void => {
        closed = true;
        stopIterator();
      };

      if (opts.signal?.aborted) onAbort();
      else opts.signal?.addEventListener("abort", onAbort, { once: true });

      let sawTerminal = false;
      try {
        scheduleHeartbeat();
        while (!closed) {
          const { value, done } = await iterator.next();
          if (done) break;
          write(encodeEvent(value));
          scheduleHeartbeat();
          if (isTerminalEvent(value)) {
            sawTerminal = true;
            break;
          }
        }
        // We stopped consuming at the terminal event; let the generator run its cleanup.
        if (sawTerminal) await iterator.return?.();
        if (!sawTerminal && !closed) {
          write(
            encodeEvent({
              type: "error",
              code: "internal_error",
              message: "The assistant stopped without finishing.",
              retryable: true,
            }),
          );
        }
      } catch (err) {
        if (!closed) write(encodeEvent(toErrorEvent(err)));
      } finally {
        clearTimeout(heartbeat);
        opts.signal?.removeEventListener("abort", onAbort);
        try {
          await opts.onFinish?.();
        } catch (err) {
          console.error("[sse] onFinish failed", err);
        }
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
    cancel() {
      // The consumer (client) went away: stop writing and let the agent wind down.
      closed = true;
      clearTimeout(heartbeat);
      stopIterator();
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
