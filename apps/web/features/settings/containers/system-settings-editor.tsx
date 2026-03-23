"use client";

import { useToast } from "@/components/providers/toast-provider";
import { useLocale } from "@/components/providers/locale-provider";
import { OpenAIModelsTable } from "../components/openai-models-table";
import { SystemSettingsForm } from "../components/system-settings-form";
import { useSystemSettings } from "../hooks/use-system-settings";

export function SystemSettingsEditor() {
  const { t } = useLocale();
  const toast = useToast();
  const {
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
  } = useSystemSettings({
    t,
    toast,
  });

  return (
    <section className="bg-background">
      <div>
        <SystemSettingsForm
          loading={loading}
          saving={saving}
          t={t}
          onSave={saveSettings}
          openaiApiUserAgent={openaiApiUserAgent}
          openaiClientVersion={openaiClientVersion}
          inboxTranslationModel={inboxTranslationModel}
          cloudMailDomainsText={cloudMailDomainsText}
          accountSubmissionAddonDailyQuota={accountSubmissionAddonDailyQuota}
          accountSubmissionAddonWeeklyCap={accountSubmissionAddonWeeklyCap}
          accountSubmissionAddonMonthlyCap={accountSubmissionAddonMonthlyCap}
          accountCacheSize={accountCacheSize}
          accountCacheRefreshSeconds={accountCacheRefreshSeconds}
          maxAttemptCount={maxAttemptCount}
          userRpmLimit={userRpmLimit}
          userMaxInFlight={userMaxInFlight}
          onOpenaiApiUserAgentChange={setOpenaiApiUserAgent}
          onOpenaiClientVersionChange={setOpenaiClientVersion}
          onInboxTranslationModelChange={setInboxTranslationModel}
          onCloudMailDomainsTextChange={setCloudMailDomainsText}
          onAccountSubmissionAddonDailyQuotaChange={setAccountSubmissionAddonDailyQuota}
          onAccountSubmissionAddonWeeklyCapChange={setAccountSubmissionAddonWeeklyCap}
          onAccountSubmissionAddonMonthlyCapChange={setAccountSubmissionAddonMonthlyCap}
          onAccountCacheSizeChange={setAccountCacheSize}
          onAccountCacheRefreshSecondsChange={setAccountCacheRefreshSeconds}
          onMaxAttemptCountChange={setMaxAttemptCount}
          onUserRpmLimitChange={setUserRpmLimit}
          onUserMaxInFlightChange={setUserMaxInFlight}
        />

        <OpenAIModelsTable
          models={openaiModels}
          loading={loading}
          refreshing={refreshingModels}
          editingModelKey={editingModelKey}
          savingModelKey={savingModelKey}
          t={t}
          onRefresh={refreshModels}
          onEditStart={setEditingModelKey}
          onSaveModel={(modelKey) => {
            void saveModelRow(modelKey);
          }}
          onPriceChange={updateModelPrice}
          onEnabledChange={updateModelEnabled}
        />
      </div>
    </section>
  );
}
