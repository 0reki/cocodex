import type { OpenAIModel } from "../types/settings-types";

export function formatLineList(items: string[] | null | undefined) {
  return Array.isArray(items) ? items.join("\n") : "";
}

export function parseDomainList(value: string) {
  const seen = new Set<string>();
  for (const part of value.split(/[\n,\s]+/)) {
    const normalized = part.trim().toLowerCase().replace(/^@+/, "");
    if (!normalized) continue;
    seen.add(normalized);
  }
  return [...seen];
}

export function getModelKey(
  model: {
    slug?: OpenAIModel["slug"];
    display_name?: OpenAIModel["display_name"];
  },
  index: number,
) {
  return `${model.slug ?? model.display_name ?? "model"}-${index}`;
}

export function formatUsd(value: number | null | undefined) {
  if (value == null) return "-";
  return `$${value}`;
}
