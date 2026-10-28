import { routeErrorResponse } from "@/app/api/_lib/route-error";
import { parseProviderSearchQuery } from "@/server/http/request";
import { getRepositories } from "@/server/repositories";

/** Provider search with the same filters as the agent's `search_providers` tool. */
export async function GET(request: Request): Promise<Response> {
  try {
    const query = parseProviderSearchQuery(new URL(request.url).searchParams);
    const { results, total } = await getRepositories().providers.search(query);
    return Response.json({ results, total });
  } catch (err) {
    return routeErrorResponse(err);
  }
}
