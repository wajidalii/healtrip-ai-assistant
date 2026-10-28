import { connection } from "next/server";
import { routeErrorResponse } from "@/app/api/_lib/route-error";
import { getProviderProfile } from "@/server/http/request";
import { getRepositories } from "@/server/repositories";
import { version } from "../../../../package.json";

/**
 * Liveness probe: which repository, credential mode and effective model this
 * process would use (docs/API.md). The profile carries no credential, so
 * nothing here can leak a key or an OIDC token.
 */
export async function GET(): Promise<Response> {
  try {
    // Under Cache Components a GET handler that touches no request data would be
    // prerendered at build time; a liveness check must run on every request.
    await connection();
    const provider = getProviderProfile();
    return Response.json({
      ok: true,
      repository: getRepositories().kind,
      mode: provider.mode,
      model: provider.model,
      version,
    });
  } catch (err) {
    return routeErrorResponse(err);
  }
}
