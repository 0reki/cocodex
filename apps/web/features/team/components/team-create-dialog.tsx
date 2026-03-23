"use client";

import { Button } from "@workspace/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog";
import { Spinner } from "@workspace/ui/components/spinner";
import type { LocaleKey } from "@/locales";

export function TeamCreateDialog(props: {
  open: boolean;
  creating: boolean;
  count: number;
  concurrency: number;
  availableDomains: string[];
  tab: "owner" | "member";
  t: (key: LocaleKey) => string;
  onOpenChange: (open: boolean) => void;
  onCountChange: (value: number) => void;
  onConcurrencyChange: (value: number) => void;
  onCreate: () => void;
}) {
  const {
    open,
    creating,
    count,
    concurrency,
    availableDomains,
    tab,
    t,
    onOpenChange,
    onCountChange,
    onConcurrencyChange,
    onCreate,
  } = props;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={!creating}>
        <DialogHeader>
          <DialogTitle>{t("team.addAccounts")}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t("signup.count")}</span>
            <input
              type="number"
              min={1}
              value={count}
              onChange={(e) => onCountChange(Number(e.target.value))}
              className="rounded-md border bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t("signup.concurrency")}</span>
            <input
              type="number"
              min={1}
              value={concurrency}
              onChange={(e) => onConcurrencyChange(Number(e.target.value))}
              className="rounded-md border bg-background px-3 py-2 text-sm"
            />
          </label>
          <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
            <div className="font-medium">{t("team.availableDomains")}</div>
            <div className="mt-1 text-muted-foreground">
              {availableDomains.length > 0
                ? availableDomains.join(", ")
                : tab === "owner"
                  ? t("team.noOwnerMailDomains")
                  : t("team.noCloudMailDomains")}
            </div>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={creating}>
            {t("common.cancel")}
          </Button>
          <Button onClick={onCreate} disabled={creating || availableDomains.length === 0}>
            {creating ? <Spinner /> : t("common.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
