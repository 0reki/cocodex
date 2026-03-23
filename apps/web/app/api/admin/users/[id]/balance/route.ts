import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  adjustPortalUserBalance,
  ensureDatabaseSchema,
  getOrCreatePortalUserBillingProfile,
  getPortalUserById,
} from "@workspace/database";
import { resolvePortalSessionFromCookieStore } from "@/lib/auth/admin-auth";

async function requireAdminForApi() {
  const cookieStore = await cookies();
  const resolved = await resolvePortalSessionFromCookieStore(cookieStore);
  const payload = resolved?.session ?? null;
  return payload?.role === "admin" ? payload : null;
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await requireAdminForApi();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const amount = Number(input.amount);
  const mode = input.mode === "adjust" ? "adjust" : "set";
  if (!Number.isFinite(amount)) {
    return NextResponse.json({ error: "amount must be a number" }, { status: 400 });
  }

  await ensureDatabaseSchema();
  const existing = await getPortalUserById(id);
  if (!existing) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const profile = await getOrCreatePortalUserBillingProfile(id);
  const target = Math.max(0, amount);
  const delta = mode === "adjust" ? amount : target - profile.balance;
  const updated = await adjustPortalUserBalance(id, delta);

  return NextResponse.json({
    profile: {
      userId: updated.userId,
      balance: updated.balance,
      currency: updated.currency,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    },
  });
}
