import { authenticate } from "@/lib/server/auth";
import { json, route } from "@/lib/server/errors";
import { profileView } from "@/lib/server/profiles";

/** GET /api/me: the caller's profile, wallet and role. Creates the profile on first sign-in. */
export const GET = route(async (request) => {
  const { profile, wallet } = await authenticate(request);
  return json({ profile: profileView(profile), wallet, role: profile.role });
});
