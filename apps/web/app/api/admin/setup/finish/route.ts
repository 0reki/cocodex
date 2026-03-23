import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { ensureDatabaseSchema, getPortalUserById } from "@workspace/database";
import {
  createSessionTokens,
  resolvePortalSessionFromCookieStore,
  setAdminSessionCookies,
} from "@/lib/auth/admin-auth";
import { resolveExternalOrigin } from "@/lib/http/request-utils";

export async function GET(req: Request) {
  const cookieStore = await cookies();
  const resolved = await resolvePortalSessionFromCookieStore(cookieStore);
  const payload = resolved?.session ?? null;
  const origin = resolveExternalOrigin(req);
  if (!payload?.sub) {
    return NextResponse.redirect(new URL("/login", origin), { status: 303 });
  }

  await ensureDatabaseSchema();
  const user = await getPortalUserById(payload.sub);
  if (!user || !user.enabled) {
    return NextResponse.redirect(new URL("/login", origin), { status: 303 });
  }

  const tokens = await createSessionTokens({
    userId: user.id,
    username: user.username,
    role: user.role,
    mustSetup: user.mustSetup,
  });

  const target = user.mustSetup ? "/setup" : "/dashboard";
  const res = NextResponse.redirect(new URL(target, origin), { status: 303 });
  setAdminSessionCookies(res.cookies, {
    accessToken: tokens.accessToken.token,
    refreshToken: tokens.refreshToken.token,
  });
  return res;
}
