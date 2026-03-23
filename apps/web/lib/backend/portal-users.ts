import {
  countPortalUsers,
  createPortalUser,
  ensureDatabaseSchema,
  getPortalUserByUsername,
} from "@workspace/database"
import {
  getAdminJwtSecret,
  getAdminPassword,
  getAdminUsername,
  hashPassword,
} from "@/lib/auth/admin-auth"

export async function ensureBootstrapAdminUser() {
  await ensureDatabaseSchema()
  const userCount = await countPortalUsers()
  if (userCount > 0) return

  const username = getAdminUsername()
  const password = getAdminPassword()
  const secret = getAdminJwtSecret()
  if (!username || !password || !secret) {
    throw new Error(
      "No users exist. Configure ADMIN_USERNAME/ADMIN_PASSWORD/ADMIN_JWT_SECRET for bootstrap login.",
    )
  }

  const existing = await getPortalUserByUsername(username)
  if (existing) return

  await createPortalUser({
    username,
    passwordHash: hashPassword(password),
    role: "admin",
    enabled: true,
  })
}
