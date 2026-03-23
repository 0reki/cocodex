"use client";

import { Button } from "@workspace/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog";
import { Spinner } from "@workspace/ui/components/spinner";
import type { LocaleKey } from "@/locales";
import type { ConfirmDialogState } from "@/lib/features/accounts/types/account-types";

export function ConfirmActionDialog(props: {
  dialog: ConfirmDialogState;
  confirming: boolean;
  t: (key: LocaleKey) => string;
  onOpenChange: (open: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { dialog, confirming, t, onOpenChange, onCancel, onConfirm } = props;

  return (
    <Dialog open={dialog.open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{dialog.title}</DialogTitle>
          <DialogDescription>{dialog.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={confirming} onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button
            variant={dialog.confirmVariant ?? "destructive"}
            disabled={confirming}
            onClick={onConfirm}
          >
            {confirming ? <Spinner className="size-4" /> : dialog.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
