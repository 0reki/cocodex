"use client";

import { Button } from "@workspace/ui/components/button";
import { Calendar } from "@workspace/ui/components/calendar";
import { Checkbox } from "@workspace/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog";
import { Input } from "@workspace/ui/components/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover";
import { Spinner } from "@workspace/ui/components/spinner";
import type { LocaleKey } from "@/locales";

export function ApiKeyDialog(props: {
  open: boolean;
  title: string;
  name: string;
  quota: string;
  expiresAt: Date | undefined;
  unlimitedQuota: boolean;
  noExpiry: boolean;
  busy: boolean;
  locale: string;
  t: (key: LocaleKey) => string;
  submitLabel: string;
  clearExpiry?: boolean;
  onOpenChange: (open: boolean) => void;
  onNameChange: (value: string) => void;
  onQuotaChange: (value: string) => void;
  onExpiresAtChange: (value: Date | undefined) => void;
  onUnlimitedQuotaChange: (value: boolean) => void;
  onNoExpiryChange: (value: boolean) => void;
  onSubmit: () => void;
}) {
  const {
    open,
    title,
    name,
    quota,
    expiresAt,
    unlimitedQuota,
    noExpiry,
    busy,
    locale,
    t,
    submitLabel,
    clearExpiry = false,
    onOpenChange,
    onNameChange,
    onQuotaChange,
    onExpiresAtChange,
    onUnlimitedQuotaChange,
    onNoExpiryChange,
    onSubmit,
  } = props;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-3">
          <label className="text-sm font-medium">{t("common.name")}</label>
          <Input value={name} onChange={(e) => onNameChange(e.target.value)} disabled={busy} />
          <label className="text-sm font-medium">{t("apiKeys.quota")}</label>
          <div className="flex items-center gap-2">
            <Checkbox
              checked={unlimitedQuota}
              onCheckedChange={(checked) => onUnlimitedQuotaChange(checked === true)}
              disabled={busy}
            />
            <label className="text-sm text-muted-foreground">
              {t("common.unlimited")} {t("apiKeys.quota")}
            </label>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">$</span>
            <Input
              type="number"
              min={0}
              step="0.001"
              value={quota}
              onChange={(e) => onQuotaChange(e.target.value)}
              placeholder={t("apiKeys.quotaPlaceholder")}
              disabled={busy || unlimitedQuota}
            />
          </div>
          <label className="text-sm font-medium">{t("apiKeys.expiresAt")}</label>
          <div className="flex items-center gap-2">
            <Checkbox
              checked={noExpiry}
              onCheckedChange={(checked) => onNoExpiryChange(checked === true)}
              disabled={busy}
            />
            <label className="text-sm text-muted-foreground">{t("apiKeys.noExpiry")}</label>
          </div>
          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" variant="outline" className="justify-start font-normal" disabled={busy || noExpiry}>
                {noExpiry ? (
                  <span>{t("apiKeys.noExpiry")}</span>
                ) : expiresAt ? (
                  expiresAt.toLocaleDateString(locale)
                ) : (
                  <span>{t("apiKeys.pickDate")}</span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={expiresAt}
                onSelect={onExpiresAtChange}
                defaultMonth={expiresAt}
              />
              {clearExpiry ? (
                <div className="border-t p-2">
                  <Button variant="outline" size="sm" onClick={() => onExpiresAtChange(undefined)}>
                    {t("apiKeys.clearExpiry")}
                  </Button>
                </div>
              ) : null}
            </PopoverContent>
          </Popover>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={onSubmit}
            disabled={
              busy ||
              !name.trim() ||
              (!unlimitedQuota && (!quota.trim() || !Number.isFinite(Number(quota)) || Number(quota) < 0)) ||
              (!noExpiry && !expiresAt)
            }
          >
            {busy ? (
              <span className="flex w-full justify-center">
                <Spinner />
              </span>
            ) : (
              submitLabel
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
