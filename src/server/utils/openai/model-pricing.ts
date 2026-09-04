export type ModelPricingRecord = Record<string, unknown> & {
  slug: string;
};

export const DEFAULT_MODEL_PRICING_USD: ModelPricingRecord[] = [
  {
    slug: "gpt-6-astra",
    input_price_per_million: "10",
    cached_input_price_per_million: "1",
    output_price_per_million: "50",
  },
  {
    slug: "gpt-5.6-sol",
    input_price_per_million: "4",
    cached_input_price_per_million: "0.4",
    output_price_per_million: "20",
  },
  {
    slug: "daybreak_blue",
    input_price_per_million: "4",
    cached_input_price_per_million: "0.4",
    output_price_per_million: "20",
  },
  {
    slug: "daybreak_red",
    input_price_per_million: "12.5",
    cached_input_price_per_million: "1.25",
    output_price_per_million: "75",
  },
  {
    slug: "gpt-5.6-terra",
    input_price_per_million: "2",
    cached_input_price_per_million: "0.2",
    output_price_per_million: "12",
  },
  {
    slug: "gpt-5.6-luna",
    input_price_per_million: "0.2",
    cached_input_price_per_million: "0.02",
    output_price_per_million: "1.2",
  },
  {
    slug: "gpt-5.5",
    input_price_per_million: "5",
    cached_input_price_per_million: "0.5",
    output_price_per_million: "30",
  },
  {
    slug: "gpt-5.4",
    input_price_per_million: "2.5",
    cached_input_price_per_million: "0.25",
    output_price_per_million: "15",
  },
  {
    slug: "gpt-5.4-mini",
    input_price_per_million: "0.75",
    cached_input_price_per_million: "0.075",
    output_price_per_million: "4.52",
  },
  {
    slug: "gpt-image-2",
    text_input_price_per_million: "5",
    cached_text_input_price_per_million: "1.25",
    text_output_price_per_million: "10",
    image_input_price_per_million: "8",
    cached_image_input_price_per_million: "2",
    image_output_price_per_million: "30",
  },
];

export function loadModelPricingFromEnv(): ModelPricingRecord[] {
  const raw = process.env.OPENAI_MODEL_PRICING_JSON?.trim();
  if (!raw) return DEFAULT_MODEL_PRICING_USD.map((item) => ({ ...item }));

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("OPENAI_MODEL_PRICING_JSON must be a JSON array");
  }
  const overrides = parsed.map((item, index): ModelPricingRecord => {
    const record =
      typeof item === "object" && item !== null
        ? (item as Record<string, unknown>)
        : null;
    const slugValue = record?.slug;
    const slug = typeof slugValue === "string" ? slugValue.trim() : "";
    if (!record || !slug) {
      throw new Error(
        `OPENAI_MODEL_PRICING_JSON[${index}].slug must be a non-empty string`,
      );
    }
    return { ...record, slug };
  });
  const merged = new Map<string, ModelPricingRecord>(
    DEFAULT_MODEL_PRICING_USD.map(
      (item): [string, ModelPricingRecord] => [item.slug, { ...item }],
    ),
  );
  for (const override of overrides) {
    const { slug } = override;
    merged.set(slug, {
      ...merged.get(slug),
      ...override,
      slug,
    });
  }
  return [...merged.values()];
}
