import { unstable_rethrow } from "next/navigation";
import { toErrorResponse } from "@/server/http/errors";

/**
 * Catch-all for route handlers. Next.js steers prerendering and dynamic
 * bail-outs by throwing internal errors (e.g. `connection()` or `request.url`
 * under Cache Components); those must reach the framework, not become a 500.
 * Lives in the app layer because `src/server` is framework-free.
 */
export function routeErrorResponse(err: unknown): Response {
  unstable_rethrow(err);
  return toErrorResponse(err);
}
