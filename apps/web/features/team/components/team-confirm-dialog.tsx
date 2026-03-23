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
import type { ConfirmDialogState } from "@/lib/features/team/types/team-types";

export function TeamConfirmDialog(props: {
  dialog: ConfirmDialogState;
  busy: boolean;
  t: (key: LocaleKey) => string;
  onOpenChange: (open: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { dialog, busy, t, onOpenChange, onCancel, onConfirm } = props;

  return (
    <Dialog open={dialog.open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{dialog.title}</DialogTitle>
          <DialogDescription>{dialog.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant={dialog.confirmVariant ?? "destructive"} onClick={onConfirm} disabled={busy}>
            {busy ? <Spinner /> : dialog.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
