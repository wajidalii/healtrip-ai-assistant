import { connection } from "next/server";
import { getConfig } from "@/server/config";
import { routeErrorResponse } from "@/app/api/_lib/route-error";
import { getRepositories } from "@/server/repositories";
import { version } from "../../../../package.json";

/** Liveness probe: which repository and model this process would use (docs/API.md). */
export async function GET(): Promise<Response> {
  try {
    // Under Cache Components a GET handler that touches no request data would be
    // prerendered at build time; a liveness check must run on every request.
    await connection();
    return Response.json({
      ok: true,
      repository: getRepositories().kind,
      model: getConfig().claudeModel,
      version,
    });
  } catch (err) {
    return routeErrorResponse(err);
  }
}
