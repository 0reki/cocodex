"use client";

import { Spinner } from "@workspace/ui/components/spinner";
import { Switch } from "@workspace/ui/components/switch";
import type { LocaleKey } from "@/locales";
import type { OpenAIModel, OpenAIModelPriceKey } from "@/lib/features/settings/types/settings-types";
import { formatUsd, getModelKey } from "@/lib/features/settings/utils/settings-utils";

export function OpenAIModelsTable(props: {
  models: OpenAIModel[];
  loading: boolean;
  refreshing: boolean;
  editingModelKey: string | null;
  savingModelKey: string | null;
  t: (key: LocaleKey) => string;
  onRefresh: () => void;
  onEditStart: (modelKey: string) => void;
  onSaveModel: (modelKey: string) => void;
  onPriceChange: (index: number, key: OpenAIModelPriceKey, value: string) => void;
  onEnabledChange: (index: number, checked: boolean) => void;
}) {
  const {
    models,
    loading,
    refreshing,
    editingModelKey,
    savingModelKey,
    t,
    onRefresh,
    onEditStart,
    onSaveModel,
    onPriceChange,
    onEnabledChange,
  } = props;

  const renderPriceCell = (
    model: OpenAIModel,
    index: number,
    key: OpenAIModelPriceKey,
    isEditing: boolean,
    isSaving: boolean,
  ) => {
    if (!isEditing) {
      return <span>{formatUsd(model[key])}</span>;
    }

    return (
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">$</span>
        <input
          type="number"
          step="0.0001"
          value={model[key] ?? ""}
          onChange={(event) => onPriceChange(index, key, event.target.value)}
          disabled={isSaving}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
        />
      </div>
    );
  };

  return (
    <div className="py-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-lg font-semibold">{t("settings.models")}</div>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing || loading || Boolean(savingModelKey)}
          className="whitespace-nowrap rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-60"
        >
          {refreshing ? (
            <span className="flex w-full justify-center">
              <Spinner />
            </span>
          ) : (
            t("settings.refreshModels")
          )}
        </button>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-300 border-collapse">
          <thead>
            <tr className="bg-muted/30 text-left">
              <th className="px-3 py-2.5 text-sm font-medium">{t("settings.display")}</th>
              <th className="px-3 py-2.5 text-sm font-medium">{t("settings.inputPricePerM")}</th>
              <th className="px-3 py-2.5 text-sm font-medium">{t("settings.cachedInputPricePerM")}</th>
              <th className="px-3 py-2.5 text-sm font-medium">{t("settings.outputPricePerM")}</th>
              <th className="px-3 py-2.5 text-sm font-medium">{t("settings.inputPricePerMAfter400k")}</th>
              <th className="px-3 py-2.5 text-sm font-medium">{t("settings.cachedInputPricePerMAfter400k")}</th>
              <th className="px-3 py-2.5 text-sm font-medium">{t("settings.outputPricePerMAfter400k")}</th>
              <th className="px-3 py-2.5 text-sm font-medium">{t("settings.enabled")}</th>
              <th className="px-3 py-2.5 text-right text-sm font-medium">{t("common.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {models.length === 0 ? (
              <tr>
                <td className="px-3 py-3 text-sm text-muted-foreground" colSpan={9}>
                  {loading ? t("common.loading") : t("settings.noModelsCached")}
                </td>
              </tr>
            ) : (
              models.map((model, index) => {
                const modelKey = getModelKey(model, index);
                const isEditing = editingModelKey === modelKey;
                const isSaving = savingModelKey === modelKey;

                return (
                  <tr key={modelKey} className="border-t">
                    <td className="px-3 py-2.5 text-sm">{model.display_name ?? model.slug ?? "-"}</td>
                    <td className="px-3 py-2.5 text-sm">
                      {renderPriceCell(model, index, "input_price_per_million", isEditing, isSaving)}
                    </td>
                    <td className="px-3 py-2.5 text-sm">
                      {renderPriceCell(model, index, "cached_input_price_per_million", isEditing, isSaving)}
                    </td>
                    <td className="px-3 py-2.5 text-sm">
                      {renderPriceCell(model, index, "output_price_per_million", isEditing, isSaving)}
                    </td>
                    <td className="px-3 py-2.5 text-sm">
                      {renderPriceCell(
                        model,
                        index,
                        "input_price_per_million_after_400k_tokens",
                        isEditing,
                        isSaving,
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-sm">
                      {renderPriceCell(
                        model,
                        index,
                        "cached_input_price_per_million_after_400k_tokens",
                        isEditing,
                        isSaving,
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-sm">
                      {renderPriceCell(
                        model,
                        index,
                        "output_price_per_million_after_400k_tokens",
                        isEditing,
                        isSaving,
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-sm">
                      <div className="flex items-center">
                        <Switch
                          checked={model.enabled !== false}
                          onCheckedChange={(checked) => onEnabledChange(index, checked)}
                          disabled={!isEditing || isSaving}
                        />
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <button
                        type="button"
                        disabled={refreshing || loading || (Boolean(savingModelKey) && !isSaving)}
                        onClick={() => {
                          if (isEditing) {
                            onSaveModel(modelKey);
                            return;
                          }
                          onEditStart(modelKey);
                        }}
                        className="h-10 min-w-18 whitespace-nowrap rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-60"
                      >
                        {isSaving ? (
                          <span className="flex w-full justify-center">
                            <Spinner />
                          </span>
                        ) : isEditing ? (
                          t("common.save")
                        ) : (
                          t("common.edit")
                        )}
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
