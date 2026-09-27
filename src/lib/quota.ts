import type { QuotaLimits } from "@/types/api";

export const QUOTA_FIELDS: {
  key: keyof QuotaLimits;
  label: string;
  hint: string;
}[] = [
  {
    key: "weeklySharePercent",
    label: "周额度占比",
    hint: "最多使用上游账号周额度的百分比",
  },
  {
    key: "deepResearchLimit",
    label: "Deep Research",
    hint: "每 30 天可用次数，留空为不限（仍受上游账号剩余次数约束）",
  },
  {
    key: "imageGenLimit",
    label: "图片生成",
    hint: "每 24 小时可用次数，留空为不限（仍受上游账号剩余次数约束）",
  },
  {
    key: "proMessageLimit",
    label: "Pro 消息",
    hint: "每 7 天可向 Pro 模型（gpt-*-pro）发送的消息数，留空为不限（上游账号每周共 200 条）",
  },
];

export function formatQuotaValue(
  key: keyof QuotaLimits,
  value: number | null | undefined,
) {
  if (key === "weeklySharePercent") return `${value ?? 0}%`;
  return value == null ? "不限" : `${value} 次`;
}

/** The input text for a quota value; an empty box is "no limit". */
export function quotaInputText(value: number | null | undefined) {
  return value == null ? "" : String(value);
}

/**
 * Parses an input box: the share is 0–100, a limit a whole number ≥ 0 or
 * empty for none. Returns an error message when the text is not valid.
 */
export function parseQuotaInput(
  key: keyof QuotaLimits,
  text: string,
): { value: number | null } | { error: string } {
  const trimmed = text.trim();
  if (key === "weeklySharePercent") {
    const percent = Number(trimmed);
    if (!trimmed || !Number.isFinite(percent) || percent < 0 || percent > 100) {
      return { error: "周额度占比需为 0 到 100 之间的数字" };
    }
    return { value: percent };
  }
  if (!trimmed) return { value: null };
  const count = Number(trimmed);
  if (!Number.isInteger(count) || count < 0) {
    return { error: "次数需为不小于 0 的整数，留空为不限" };
  }
  return { value: count };
}
