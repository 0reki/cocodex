import crypto from "node:crypto";

export function shuffleInPlace<T>(items: T[]) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
}

export function createModelRefreshServices(deps: {
  listTeamOwnerAccountsPage: (
    page: number,
    pageSize: number,
  ) => Promise<{ items: Array<Record<string, any>> }>;
  listOpenAIAccountsForModelCache: (forceRefresh?: number) => Promise<Array<Record<string, any>>>;
}) {
  function mergeModelPricesBySlug(
    currentModels: Array<Record<string, unknown>>,
    refreshedModels: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    const pricingBySlug = new Map<string, Record<string, unknown>>();
    for (const model of currentModels) {
      const slug = typeof model.slug === "string" ? model.slug.trim() : "";
      if (!slug) continue;
      pricingBySlug.set(slug, {
        input_price_per_million: model.input_price_per_million,
        cached_input_price_per_million: model.cached_input_price_per_million,
        output_price_per_million: model.output_price_per_million,
        input_price_per_million_after_400k_tokens:
          model.input_price_per_million_after_400k_tokens,
        cached_input_price_per_million_after_400k_tokens:
          model.cached_input_price_per_million_after_400k_tokens,
        output_price_per_million_after_400k_tokens:
          model.output_price_per_million_after_400k_tokens,
        double_price_after_400k_tokens: model.double_price_after_400k_tokens,
        enabled: model.enabled,
      });
    }
    const merged = refreshedModels.map((model) => {
      const slug = typeof model.slug === "string" ? model.slug.trim() : "";
      const pricing = slug ? pricingBySlug.get(slug) : undefined;
      return pricing ? { ...model, ...pricing } : model;
    });
    const seen = new Set(
      merged
        .map((model) => (typeof model.slug === "string" ? model.slug.trim() : ""))
        .filter(Boolean),
    );
    for (const model of currentModels) {
      const slug = typeof model.slug === "string" ? model.slug.trim() : "";
      if (!slug || seen.has(slug)) continue;
      merged.push(model);
      seen.add(slug);
    }
    return merged;
  }

  function createRandomDomainPicker(domains: string[]) {
    const availableDomains = domains
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (availableDomains.length === 0) {
      throw new Error("No available domains configured");
    }
    let shuffled = [...availableDomains];
    shuffleInPlace(shuffled);
    let cursor = 0;
    return () => {
      if (cursor >= shuffled.length) {
        shuffled = [...availableDomains];
        shuffleInPlace(shuffled);
        cursor = 0;
      }
      const domain = shuffled[cursor];
      if (!domain) throw new Error("No available domains configured");
      cursor += 1;
      return domain;
    };
  }

  async function getRandomTeamOwnerModelRefreshAccount() {
    const data = await deps.listTeamOwnerAccountsPage(1, 500);
    const available = data.items.filter(
      (item) =>
        item.planType === "team" &&
        !item.workspaceIsDeactivated &&
        typeof item.accessToken === "string" &&
        item.accessToken.trim().length > 0,
    );
    if (available.length === 0) return null;
    const picked = available[Math.floor(Math.random() * available.length)]!;
    return {
      id: picked.id,
      email: picked.email,
      accessToken: picked.accessToken!.trim(),
      workspaceName: picked.workspaceName ?? null,
      planType: picked.planType ?? null,
    };
  }

  async function getRandomOpenAIModelRefreshAccount() {
    const available = await deps.listOpenAIAccountsForModelCache(1);
    const picked = available[0] ?? null;
    if (!picked?.accessToken) return null;
    return {
      id: picked.id,
      email: picked.email,
      accessToken: picked.accessToken.trim(),
      randomNonce: crypto.randomUUID(),
    };
  }

  return {
    mergeModelPricesBySlug,
    createRandomDomainPicker,
    getRandomTeamOwnerModelRefreshAccount,
    getRandomOpenAIModelRefreshAccount,
  };
}
