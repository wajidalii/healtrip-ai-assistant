/**
 * Typed HTTP errors and the single place where anything thrown inside a route
 * handler is translated into the shared `{ error: { code, message, details } }`
 * body (docs/API.md, docs/SECURITY.md). Unknown errors are logged and masked.
 */
import { z, ZodError } from "zod";
import type { ApiErrorBody, ApiErrorCode } from "@/shared/contracts";

export class AppError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
    message: string,
    readonly details?: unknown,
    /** Extra response headers, e.g. `Retry-After` for 429. */
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError("validation_error", 400, message, details);

export const notFound = (message = "Not found"): AppError => new AppError("not_found", 404, message);

export const rateLimited = (retryAfterSeconds: number): AppError =>
  new AppError(
    "rate_limited",
    429,
    "Too many messages; please wait a moment before trying again.",
    { retryAfterSeconds },
    { "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))) },
  );

export const payloadTooLarge = (maxBytes: number): AppError =>
  new AppError("payload_too_large", 413, `Request body must not exceed ${maxBytes} bytes.`, { maxBytes });

/** Another turn is already running for this conversation (docs/API.md "Concurrency"). */
export const conflict = (message = "A response is already being generated for this conversation."): AppError =>
  new AppError("turn_in_progress", 409, message);

export const upstream = (message: string): AppError => new AppError("upstream_error", 502, message);

export const internal = (message = "Internal server error"): AppError =>
  new AppError("internal_error", 500, message);

function jsonResponse(body: ApiErrorBody, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

/**
 * Maps any thrown value to an HTTP response. Only `AppError` and `ZodError`
 * messages reach the client; everything else becomes a generic 500 so stack
 * traces, SQL or SDK internals never leak.
 */
export function toErrorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    const details = err.details === undefined ? {} : { details: err.details };
    return jsonResponse({ error: { code: err.code, message: err.message, ...details } }, err.status, err.headers);
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const where = first && first.path.length > 0 ? `${first.path.join(".")}: ` : "";
    return jsonResponse(
      {
        error: {
          code: "validation_error",
          message: first ? `${where}${first.message}` : "Invalid request",
          details: z.flattenError(err),
        },
      },
      400,
    );
  }
  console.error("[http] unhandled error", err);
  return jsonResponse({ error: { code: "internal_error", message: "Internal server error" } }, 500);
}
