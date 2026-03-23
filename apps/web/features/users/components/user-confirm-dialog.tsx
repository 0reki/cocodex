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

export function UserConfirmDialog(props: {
  open: boolean;
  mutating: boolean;
  title: string;
  description: string;
  variant: "default" | "destructive";
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  cancelLabel: string;
}) {
  const { open, mutating, title, description, variant, onOpenChange, onConfirm, cancelLabel } = props;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutating}>
            {cancelLabel}
          </Button>
          <Button type="button" variant={variant} onClick={onConfirm} disabled={mutating}>
            {mutating ? <Spinner className="size-4" /> : title}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
