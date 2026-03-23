"use client";

import { useCallback, useEffect, useState } from "react";
import type { LocaleKey } from "@/locales";
import type {
  OpenAIModel,
  OpenAIModelPriceKey,
  SystemSettingsResponse,
} from "@/lib/features/settings/types/settings-types";
import { formatLineList, parseDomainList } from "@/lib/features/settings/utils/settings-utils";

export function useSystemSettings(props: {
  t: (key: LocaleKey) => string;
  toast: {
    success: (message: string) => void;
    error: (message: string) => void;
  };
}) {
  const { t, toast } = props;
  const [openaiApiUserAgent, setOpenaiApiUserAgent] = useState("");
  const [openaiClientVersion, setOpenaiClientVersion] = useState("");
  const [inboxTranslationModel, setInboxTranslationModel] = useState("");
  const [cloudMailDomainsText, setCloudMailDomainsText] = useState("");
  const [accountSubmissionAddonDailyQuota, setAccountSubmissionAddonDailyQuota] = useState("0");
  const [accountSubmissionAddonWeeklyCap, setAccountSubmissionAddonWeeklyCap] = useState("0");
  const [accountSubmissionAddonMonthlyCap, setAccountSubmissionAddonMonthlyCap] = useState("0");
  const [accountCacheSize, setAccountCacheSize] = useState("50");
  const [accountCacheRefreshSeconds, setAccountCacheRefreshSeconds] = useState("60");
  const [maxAttemptCount, setMaxAttemptCount] = useState("1");
  const [userRpmLimit, setUserRpmLimit] = useState("0");
  const [userMaxInFlight, setUserMaxInFlight] = useState("0");
  const [openaiModels, setOpenaiModels] = useState<OpenAIModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingModelKey, setEditingModelKey] = useState<string | null>(null);
  const [savingModelKey, setSavingModelKey] = useState<string | null>(null);
  const [refreshingModels, setRefreshingModels] = useState(false);

  const applySettings = (data: SystemSettingsResponse) => {
    setOpenaiApiUserAgent(data.openaiApiUserAgent ?? "");
    setOpenaiClientVersion(data.openaiClientVersion ?? "");
    setInboxTranslationModel(data.inboxTranslationModel ?? "");
    setCloudMailDomainsText(formatLineList(data.cloudMailDomains));
    setAccountSubmissionAddonDailyQuota(String(data.accountSubmissionAddonDailyQuota ?? 0));
    setAccountSubmissionAddonWeeklyCap(String(data.accountSubmissionAddonWeeklyCap ?? 0));
    setAccountSubmissionAddonMonthlyCap(String(data.accountSubmissionAddonMonthlyCap ?? 0));
    setAccountCacheSize(String(data.accountCacheSize ?? 50));
    setAccountCacheRefreshSeconds(String(data.accountCacheRefreshSeconds ?? 60));
    setMaxAttemptCount(String(data.maxAttemptCount ?? 1));
    setUserRpmLimit(String(data.userRpmLimit ?? 0));
    setUserMaxInFlight(String(data.userMaxInFlight ?? 0));
    setOpenaiModels(Array.isArray(data.openaiModels) ? data.openaiModels : []);
  };

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/system-settings", { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`${t("common.load")} settings failed: HTTP ${res.status}`);
      }
      const data = (await res.json()) as SystemSettingsResponse;
      applySettings(data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [t, toast]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const saveSettings = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/system-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          openaiApiUserAgent,
          openaiClientVersion,
          inboxTranslationModel,
          cloudMailDomains: parseDomainList(cloudMailDomainsText),
          accountSubmissionAddonDailyQuota: Number(accountSubmissionAddonDailyQuota),
          accountSubmissionAddonWeeklyCap: Number(accountSubmissionAddonWeeklyCap),
          accountSubmissionAddonMonthlyCap: Number(accountSubmissionAddonMonthlyCap),
          accountCacheSize: Number(accountCacheSize),
          accountCacheRefreshSeconds: Number(accountCacheRefreshSeconds),
          maxAttemptCount: Number(maxAttemptCount),
          userRpmLimit: Number(userRpmLimit),
          userMaxInFlight: Number(userMaxInFlight),
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Save settings failed: ${text}`);
      }
      const data = (await res.json()) as SystemSettingsResponse;
      applySettings(data);
      toast.success(t("settings.savedSettings"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const refreshModels = async () => {
    setRefreshingModels(true);
    try {
      const res = await fetch("/api/system-settings/openai-models/refresh", {
        method: "POST",
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Refresh models failed: ${text}`);
      }
      const data = (await res.json()) as {
        modelCount?: number;
        openaiModels?: OpenAIModel[];
      };
      setOpenaiModels(Array.isArray(data.openaiModels) ? data.openaiModels : []);
      setEditingModelKey(null);
      toast.success(
        t("settings.modelsRefreshed").replace("{count}", String(data.modelCount ?? 0)),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshingModels(false);
    }
  };

  const updateModelPrice = (index: number, key: OpenAIModelPriceKey, value: string) => {
    setOpenaiModels((prev) =>
      prev.map((model, idx) => {
        if (idx !== index) return model;
        const trimmed = value.trim();
        const parsed = Number(trimmed);
        return {
          ...model,
          [key]: trimmed.length === 0 || !Number.isFinite(parsed) ? null : parsed,
        };
      }),
    );
  };

  const updateModelEnabled = (index: number, checked: boolean) => {
    setOpenaiModels((prev) =>
      prev.map((model, idx) => (idx === index ? { ...model, enabled: checked } : model)),
    );
  };

  const saveModelRow = async (targetModelKey: string) => {
    setSavingModelKey(targetModelKey);
    try {
      const res = await fetch("/api/system-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          openaiModels,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Save model prices failed: ${text}`);
      }
      const data = (await res.json()) as SystemSettingsResponse;
      setOpenaiModels(Array.isArray(data.openaiModels) ? data.openaiModels : []);
      setEditingModelKey(null);
      toast.success(t("settings.savedModelPrices"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingModelKey(null);
    }
  };

  return {
    openaiApiUserAgent,
    openaiClientVersion,
    inboxTranslationModel,
    cloudMailDomainsText,
    accountSubmissionAddonDailyQuota,
    accountSubmissionAddonWeeklyCap,
    accountSubmissionAddonMonthlyCap,
    accountCacheSize,
    accountCacheRefreshSeconds,
    maxAttemptCount,
    userRpmLimit,
    userMaxInFlight,
    openaiModels,
    loading,
    saving,
    editingModelKey,
    savingModelKey,
    refreshingModels,
    setOpenaiApiUserAgent,
    setOpenaiClientVersion,
    setInboxTranslationModel,
    setCloudMailDomainsText,
    setAccountSubmissionAddonDailyQuota,
    setAccountSubmissionAddonWeeklyCap,
    setAccountSubmissionAddonMonthlyCap,
    setAccountCacheSize,
    setAccountCacheRefreshSeconds,
    setMaxAttemptCount,
    setUserRpmLimit,
    setUserMaxInFlight,
    setEditingModelKey,
    saveSettings,
    refreshModels,
    updateModelPrice,
    updateModelEnabled,
    saveModelRow,
  };
}
