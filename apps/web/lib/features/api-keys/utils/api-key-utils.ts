export function formatMoney(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "-";
  const truncated = Math.trunc(value * 1000) / 1000;
  return truncated.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });
}

export function getUsagePercent(used: number, quota: number | null) {
  if (quota == null || quota <= 0) return 0;
  return Math.max(0, Math.min(100, (used / quota) * 100));
}
