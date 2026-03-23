export function selectContentProps() {
  return {
    position: "popper" as const,
    align: "start" as const,
    sideOffset: 4,
    className: "w-(--radix-select-trigger-width)",
  };
}

export function parseJsonObjectSafe(text: string) {
  const normalized = text.trim();
  if (!normalized) return null;
  try {
    const parsed = JSON.parse(normalized) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
