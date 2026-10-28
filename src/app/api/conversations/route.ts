import { createConversationSchema } from "@/shared/contracts";
import { routeErrorResponse } from "@/app/api/_lib/route-error";
import { parseWith, readJson } from "@/server/http/request";
import { getRepositories } from "@/server/repositories";

export async function POST(request: Request): Promise<Response> {
  try {
    const body = parseWith(createConversationSchema, await readJson(request));
    const conversation = await getRepositories().conversations.create(body.locale);
    return Response.json({ id: conversation.id, locale: conversation.locale }, { status: 201 });
  } catch (err) {
    return routeErrorResponse(err);
  }
}
