"use client";

import { Spinner } from "@workspace/ui/components/spinner";
import type { ReactNode } from "react";
import type { LocaleKey } from "@/locales";

export function SettingsFieldRow(props: {
  label: string;
  saving: boolean;
  loading: boolean;
  t: (key: LocaleKey) => string;
  onSave: () => void;
  children: ReactNode;
  multiline?: boolean;
}) {
  const { label, saving, loading, t, onSave, children, multiline = false } = props;

  return (
    <div className="py-4">
      <label className="block text-base font-semibold">
        <span className="mb-2 block">{label}</span>
        <div
          className={`flex flex-col gap-2 sm:flex-row sm:gap-3 ${
            multiline ? "sm:items-start" : "sm:items-center"
          }`}
        >
          {children}
          <button
            type="button"
            onClick={onSave}
            disabled={saving || loading}
            className="h-10 w-full shrink-0 whitespace-nowrap rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-60 sm:w-auto sm:min-w-22"
          >
            {saving ? (
              <span className="flex w-full justify-center">
                <Spinner />
              </span>
            ) : (
              t("common.save")
            )}
          </button>
        </div>
      </label>
    </div>
  );
}
