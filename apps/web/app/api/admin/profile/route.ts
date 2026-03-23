import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  ensureDatabaseSchema,
  getPortalUserById,
  updatePortalUserById,
} from "@workspace/database";
import {
  createSessionTokens,
  hashPassword,
  resolvePortalSessionFromCookieStore,
  setAdminSessionCookies,
  verifyPassword,
} from "@/lib/auth/admin-auth";

async function requireSessionForApi() {
  const cookieStore = await cookies();
  const resolved = await resolvePortalSessionFromCookieStore(cookieStore);
  return resolved?.session ?? null;
}

export async function GET() {
  const session = await requireSessionForApi();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureDatabaseSchema();
  const user = await getPortalUserById(session.sub);
  if (!user || !user.enabled) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    profile: {
      id: user.id,
      username: user.username,
      email: user.email,
      avatarUrl: user.avatarUrl,
      role: user.role,
      country: user.country,
      mustSetup: user.mustSetup,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
  });
}

export async function PATCH(req: Request) {
  const session = await requireSessionForApi();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input: Record<string, unknown> =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};

  const currentPassword =
    typeof input.currentPassword === "string" ? input.currentPassword : "";
  const newPassword =
    typeof input.newPassword === "string" ? input.newPassword : "";
  const country =
    typeof input.country === "string" ? input.country.slice(0, 64) : undefined;

  await ensureDatabaseSchema();
  const existing = await getPortalUserById(session.sub);
  if (!existing || !existing.enabled) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (newPassword) {
    if (newPassword.length < 8) {
      return NextResponse.json(
        { error: "New password must be at least 8 characters" },
        { status: 400 },
      );
    }
    const requiresCurrentPassword = !existing.mustSetup;
    if (
      requiresCurrentPassword &&
      (!currentPassword || !verifyPassword(currentPassword, existing.passwordHash))
    ) {
      return NextResponse.json(
        { error: "Current password is incorrect" },
        { status: 400 },
      );
    }
  }

  if (existing.mustSetup) {
    if (!country) {
      return NextResponse.json(
        { error: "Country is required to complete setup" },
        { status: 400 },
      );
    }
    if (!newPassword) {
      return NextResponse.json(
        { error: "New password is required to complete setup" },
        { status: 400 },
      );
    }
  }

  const updated = await updatePortalUserById(existing.id, {
    passwordHash: newPassword ? hashPassword(newPassword) : undefined,
    country,
    mustSetup:
      existing.mustSetup && country && newPassword ? false : undefined,
  });

  if (!updated) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const tokens = await createSessionTokens({
    userId: updated.id,
    username: updated.username,
    role: updated.role,
    mustSetup: updated.mustSetup,
  });

  const res = NextResponse.json({
    profile: {
      id: updated.id,
      username: updated.username,
      email: updated.email,
      avatarUrl: updated.avatarUrl,
      role: updated.role,
      country: updated.country,
      mustSetup: updated.mustSetup,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    },
  });
  setAdminSessionCookies(res.cookies, {
    accessToken: tokens.accessToken.token,
    refreshToken: tokens.refreshToken.token,
  });

  return res;
}
