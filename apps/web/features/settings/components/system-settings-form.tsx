"use client";

import { SettingsFieldRow } from "./settings-field-row";
import type { LocaleKey } from "@/locales";

export function SystemSettingsForm(props: {
  loading: boolean;
  saving: boolean;
  t: (key: LocaleKey) => string;
  onSave: () => void;
  openaiApiUserAgent: string;
  openaiClientVersion: string;
  inboxTranslationModel: string;
  cloudMailDomainsText: string;
  accountSubmissionAddonDailyQuota: string;
  accountSubmissionAddonWeeklyCap: string;
  accountSubmissionAddonMonthlyCap: string;
  accountCacheSize: string;
  accountCacheRefreshSeconds: string;
  maxAttemptCount: string;
  userRpmLimit: string;
  userMaxInFlight: string;
  onOpenaiApiUserAgentChange: (value: string) => void;
  onOpenaiClientVersionChange: (value: string) => void;
  onInboxTranslationModelChange: (value: string) => void;
  onCloudMailDomainsTextChange: (value: string) => void;
  onAccountSubmissionAddonDailyQuotaChange: (value: string) => void;
  onAccountSubmissionAddonWeeklyCapChange: (value: string) => void;
  onAccountSubmissionAddonMonthlyCapChange: (value: string) => void;
  onAccountCacheSizeChange: (value: string) => void;
  onAccountCacheRefreshSecondsChange: (value: string) => void;
  onMaxAttemptCountChange: (value: string) => void;
  onUserRpmLimitChange: (value: string) => void;
  onUserMaxInFlightChange: (value: string) => void;
}) {
  const {
    loading,
    saving,
    t,
    onSave,
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
    onOpenaiApiUserAgentChange,
    onOpenaiClientVersionChange,
    onInboxTranslationModelChange,
    onCloudMailDomainsTextChange,
    onAccountSubmissionAddonDailyQuotaChange,
    onAccountSubmissionAddonWeeklyCapChange,
    onAccountSubmissionAddonMonthlyCapChange,
    onAccountCacheSizeChange,
    onAccountCacheRefreshSecondsChange,
    onMaxAttemptCountChange,
    onUserRpmLimitChange,
    onUserMaxInFlightChange,
  } = props;

  return (
    <>
      <SettingsFieldRow label={t("settings.userAgent")} saving={saving} loading={loading} t={t} onSave={onSave}>
        <input
          value={openaiApiUserAgent}
          onChange={(event) => onOpenaiApiUserAgentChange(event.target.value)}
          placeholder="node/22.14.0"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm font-normal"
        />
      </SettingsFieldRow>

      <SettingsFieldRow label={t("settings.clientVersion")} saving={saving} loading={loading} t={t} onSave={onSave}>
        <input
          value={openaiClientVersion}
          onChange={(event) => onOpenaiClientVersionChange(event.target.value)}
          placeholder="0.98.0"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm font-normal"
        />
      </SettingsFieldRow>

      <SettingsFieldRow label={t("settings.inboxTranslationModel")} saving={saving} loading={loading} t={t} onSave={onSave}>
        <input
          value={inboxTranslationModel}
          onChange={(event) => onInboxTranslationModelChange(event.target.value)}
          placeholder="gpt-5.1-codex-mini"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm font-normal"
        />
      </SettingsFieldRow>

      <SettingsFieldRow
        label={t("settings.cloudMailDomains")}
        saving={saving}
        loading={loading}
        t={t}
        onSave={onSave}
        multiline
      >
        <textarea
          value={cloudMailDomainsText}
          onChange={(event) => onCloudMailDomainsTextChange(event.target.value)}
          placeholder={"example.com\nmail.example.net"}
          rows={4}
          className="min-h-28 w-full rounded-md border bg-background px-3 py-2 text-sm font-normal"
        />
      </SettingsFieldRow>

      <SettingsFieldRow
        label={t("settings.accountSubmissionAddonReward")}
        saving={saving}
        loading={loading}
        t={t}
        onSave={onSave}
      >
        <input
          type="number"
          min={0}
          step="0.001"
          value={accountSubmissionAddonDailyQuota}
          onChange={(event) => onAccountSubmissionAddonDailyQuotaChange(event.target.value)}
          placeholder="0"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm font-normal"
          aria-label={t("settings.accountSubmissionAddonDailyQuota")}
        />
        <input
          type="number"
          min={0}
          step="0.001"
          value={accountSubmissionAddonWeeklyCap}
          onChange={(event) => onAccountSubmissionAddonWeeklyCapChange(event.target.value)}
          placeholder="0"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm font-normal"
          aria-label={t("settings.accountSubmissionAddonWeeklyCap")}
        />
        <input
          type="number"
          min={0}
          step="0.001"
          value={accountSubmissionAddonMonthlyCap}
          onChange={(event) => onAccountSubmissionAddonMonthlyCapChange(event.target.value)}
          placeholder="0"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm font-normal"
          aria-label={t("settings.accountSubmissionAddonMonthlyCap")}
        />
      </SettingsFieldRow>

      <SettingsFieldRow label={t("settings.accountCacheSize")} saving={saving} loading={loading} t={t} onSave={onSave}>
        <input
          type="number"
          min={1}
          max={500}
          value={accountCacheSize}
          onChange={(event) => onAccountCacheSizeChange(event.target.value)}
          placeholder="50"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm font-normal"
        />
      </SettingsFieldRow>

      <SettingsFieldRow
        label={t("settings.accountCacheRefreshSeconds")}
        saving={saving}
        loading={loading}
        t={t}
        onSave={onSave}
      >
        <input
          type="number"
          min={5}
          max={3600}
          value={accountCacheRefreshSeconds}
          onChange={(event) => onAccountCacheRefreshSecondsChange(event.target.value)}
          placeholder="60"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm font-normal"
        />
      </SettingsFieldRow>

      <SettingsFieldRow label={t("settings.maxAttemptCount")} saving={saving} loading={loading} t={t} onSave={onSave}>
        <input
          type="number"
          min={1}
          max={10}
          value={maxAttemptCount}
          onChange={(event) => onMaxAttemptCountChange(event.target.value)}
          placeholder="1"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm font-normal"
        />
      </SettingsFieldRow>

      <SettingsFieldRow label={t("settings.userRpmLimit")} saving={saving} loading={loading} t={t} onSave={onSave}>
        <input
          type="number"
          min={0}
          max={100000}
          value={userRpmLimit}
          onChange={(event) => onUserRpmLimitChange(event.target.value)}
          placeholder="0"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm font-normal"
        />
      </SettingsFieldRow>

      <SettingsFieldRow label={t("settings.userMaxInFlight")} saving={saving} loading={loading} t={t} onSave={onSave}>
        <input
          type="number"
          min={0}
          max={1000}
          value={userMaxInFlight}
          onChange={(event) => onUserMaxInFlightChange(event.target.value)}
          placeholder="0"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm font-normal"
        />
      </SettingsFieldRow>
    </>
  );
}
