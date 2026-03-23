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
import { Input } from "@workspace/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import { Spinner } from "@workspace/ui/components/spinner";
import type { LocaleKey } from "@/locales";
import type { BalanceMode, UserItem } from "@/lib/features/users/types/user-types";
import { selectContentProps } from "@/lib/features/users/utils/user-utils";

export function UserBalanceDialog(props: {
  open: boolean;
  saving: boolean;
  user: UserItem | null;
  mode: BalanceMode;
  amount: string;
  t: (key: LocaleKey) => string;
  onOpenChange: (open: boolean) => void;
  onModeChange: (value: BalanceMode) => void;
  onAmountChange: (value: string) => void;
  onSave: () => void;
}) {
  const {
    open,
    saving,
    user,
    mode,
    amount,
    t,
    onOpenChange,
    onModeChange,
    onAmountChange,
    onSave,
  } = props;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("users.editBalance")}</DialogTitle>
          {user ? <DialogDescription>{user.username}</DialogDescription> : null}
        </DialogHeader>
        <div className="grid gap-3">
          <Select value={mode} onValueChange={(value) => onModeChange(value as BalanceMode)}>
            <SelectTrigger aria-label={t("users.balanceMode")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent {...selectContentProps()}>
              <SelectItem value="set">{t("users.balanceModeSet")}</SelectItem>
              <SelectItem value="adjust">{t("users.balanceModeAdjust")}</SelectItem>
            </SelectContent>
          </Select>
          <Input
            type="number"
            inputMode="decimal"
            placeholder="0"
            value={amount}
            onChange={(event) => onAmountChange(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button type="button" onClick={onSave} disabled={saving || !user}>
            {saving ? <Spinner className="size-4" /> : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
