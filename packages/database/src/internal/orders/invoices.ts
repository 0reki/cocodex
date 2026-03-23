import type { PortalUserBillingSnapshot } from "../types.ts"
import { getOrCreatePortalUserBillingProfile } from "../billing-profile.ts"
import {
  computeAddonRemaining,
  getPortalUserAddonAllowance,
  listPortalUserAddonItems,
} from "./addons.ts"
import { getPortalUserBillingUsage } from "./usage.ts"

export async function getPortalUserBillingSnapshot(
  userId: string,
): Promise<PortalUserBillingSnapshot> {
  const [profile, usage, addOns, addOnItems] = await Promise.all([
    getOrCreatePortalUserBillingProfile(userId),
    getPortalUserBillingUsage(userId),
    getPortalUserAddonAllowance(userId),
    listPortalUserAddonItems(userId),
  ])
  const addonRemaining = computeAddonRemaining(addOns)
  const allowanceRemaining = addonRemaining
  const balance = Math.max(0, profile.balance)
  return {
    profile,
    usage,
    addOns,
    addOnItems,
    allowance: {
      allowanceRemaining,
      addonRemaining,
      balance,
      totalAvailable: allowanceRemaining + balance,
    },
  }
}
