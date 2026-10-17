import { requireRole } from "@/lib/server/auth";
import { loadOwnSession, sessionView } from "@/lib/server/audit";
import { json, route } from "@/lib/server/errors";
import { parseUuid } from "@/lib/server/http";

/** GET /api/audit/sessions/:id: the caller's session with its sample, findings so far and challenges. */
export const GET = route(async (request, { params }: { params: Promise<{ id: string }> }) => {
  const auth = await requireRole(request, "auditor");
  const session = await loadOwnSession(auth, parseUuid((await params).id));
  return json({ session: await sessionView(session) });
});
