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
import type { UserEditStatus, UserItem } from "@/lib/features/users/types/user-types";
import { selectContentProps } from "@/lib/features/users/utils/user-utils";

export function UserEditDialog(props: {
  open: boolean;
  saving: boolean;
  user: UserItem | null;
  role: "admin" | "user";
  enabled: UserEditStatus;
  password: string;
  userRpmLimit: string;
  userMaxInFlight: string;
  t: (key: LocaleKey) => string;
  onOpenChange: (open: boolean) => void;
  onRoleChange: (value: "admin" | "user") => void;
  onEnabledChange: (value: UserEditStatus) => void;
  onPasswordChange: (value: string) => void;
  onUserRpmLimitChange: (value: string) => void;
  onUserMaxInFlightChange: (value: string) => void;
  onSave: () => void;
}) {
  const {
    open,
    saving,
    user,
    role,
    enabled,
    password,
    userRpmLimit,
    userMaxInFlight,
    t,
    onOpenChange,
    onRoleChange,
    onEnabledChange,
    onPasswordChange,
    onUserRpmLimitChange,
    onUserMaxInFlightChange,
    onSave,
  } = props;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("common.edit")}</DialogTitle>
          {user ? <DialogDescription>{user.username}</DialogDescription> : null}
        </DialogHeader>
        <div className="grid gap-3">
          <Select value={role} onValueChange={(value) => onRoleChange(value as "admin" | "user")}>
            <SelectTrigger aria-label={t("users.role")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent {...selectContentProps()}>
              <SelectItem value="user">{t("users.user")}</SelectItem>
              <SelectItem value="admin">{t("users.admin")}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={enabled} onValueChange={(value) => onEnabledChange(value as UserEditStatus)}>
            <SelectTrigger aria-label={t("common.status")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent {...selectContentProps()}>
              <SelectItem value="enabled">{t("status.enabled")}</SelectItem>
              <SelectItem value="disabled">{t("status.disabled")}</SelectItem>
            </SelectContent>
          </Select>
          <Input
            type="password"
            placeholder={t("users.newPasswordPlaceholder")}
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
          />
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">{t("settings.userRpmLimit")}</span>
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              placeholder={t("common.unlimited")}
              value={userRpmLimit}
              onChange={(event) => onUserRpmLimitChange(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">{t("settings.userMaxInFlight")}</span>
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              placeholder={t("common.unlimited")}
              value={userMaxInFlight}
              onChange={(event) => onUserMaxInFlightChange(event.target.value)}
            />
          </div>
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
