import type {
  PortalUserBillingUsage,
  PortalUserSpendAllowance,
} from "../types.ts"
import { getOrCreatePortalUserBillingProfile } from "../billing-profile.ts"
import {
  computeAddonRemaining,
  consumePortalUserAddonQuota,
  getPortalUserAddonAllowance,
} from "./addons.ts"

export async function getPortalUserBillingUsage(
  userId: string,
): Promise<PortalUserBillingUsage> {
  const normalizedUserId = userId.trim()
  if (!normalizedUserId) return { dailyCost: 0, weeklyCost: 0, monthlyCost: 0 }
  const allowance = await getPortalUserAddonAllowance(normalizedUserId)
  return {
    dailyCost: allowance.dailyUsed,
    weeklyCost: allowance.weeklyUsed,
    monthlyCost: allowance.monthlyUsed,
  }
}

export async function consumePortalUserAllowanceQuota(
  userId: string,
  amount: number,
): Promise<void> {
  const normalizedUserId = userId.trim()
  const safeAmount = Number.isFinite(amount) ? amount : NaN
  if (!normalizedUserId || !Number.isFinite(safeAmount) || safeAmount <= 0) {
    return
  }
  const addonAllowance = await getPortalUserAddonAllowance(normalizedUserId)
  const addonRemaining = computeAddonRemaining(addonAllowance)
  const consumedFromAddons = Math.max(0, Math.min(safeAmount, addonRemaining))
  if (consumedFromAddons > 0) {
    await consumePortalUserAddonQuota(normalizedUserId, consumedFromAddons)
  }
  const remainingAmount = Math.max(0, safeAmount - consumedFromAddons)
  if (remainingAmount <= 0) {
    return
  }
}

export async function getPortalUserSpendAllowance(
  userId: string,
): Promise<PortalUserSpendAllowance> {
  const [profile, addonAllowance] = await Promise.all([
    getOrCreatePortalUserBillingProfile(userId),
    getPortalUserAddonAllowance(userId),
  ])
  const addonRemaining = computeAddonRemaining(addonAllowance)
  const allowanceRemaining = addonRemaining
  const balance = Math.max(0, profile.balance)
  return {
    allowanceRemaining,
    addonRemaining,
    balance,
    totalAvailable: allowanceRemaining + balance,
  }
}
