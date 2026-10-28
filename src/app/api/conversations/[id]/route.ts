import { notFound } from "@/server/http/errors";
import { routeErrorResponse } from "@/app/api/_lib/route-error";
import { toConversationView } from "@/server/http/projection";
import { parseConversationId } from "@/server/http/request";
import { getRepositories } from "@/server/repositories";

type Context = { params: Promise<{ id: string }> };

/** UI projection of a stored conversation (tool plumbing hidden). */
export async function GET(_request: Request, { params }: Context): Promise<Response> {
  try {
    const id = parseConversationId((await params).id);
    const { conversations } = getRepositories();
    const conversation = await conversations.get(id);
    if (!conversation) throw notFound("Conversation not found");

    const [messages, toolCalls, recommendations] = await Promise.all([
      conversations.listMessages(id),
      conversations.listToolCalls(id),
      conversations.listRecommendations(id),
    ]);
    return Response.json(toConversationView(conversation, messages, toolCalls, recommendations));
  } catch (err) {
    return routeErrorResponse(err);
  }
}
