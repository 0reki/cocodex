"use client";

import { Button } from "@workspace/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { selectContentProps } from "@/lib/features/users/utils/user-utils";

export function UserCreateDialog(props: {
  open: boolean;
  creating: boolean;
  username: string;
  password: string;
  role: "admin" | "user";
  t: (key: LocaleKey) => string;
  onOpenChange: (open: boolean) => void;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onRoleChange: (value: "admin" | "user") => void;
  onCreate: () => void;
}) {
  const {
    open,
    creating,
    username,
    password,
    role,
    t,
    onOpenChange,
    onUsernameChange,
    onPasswordChange,
    onRoleChange,
    onCreate,
  } = props;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button type="button">{t("common.add")}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("users.createUser")}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <Input
            placeholder={t("users.usernamePlaceholder")}
            value={username}
            onChange={(event) => onUsernameChange(event.target.value)}
          />
          <Input
            placeholder={t("users.passwordPlaceholder")}
            type="password"
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
          />
          <Select value={role} onValueChange={(value) => onRoleChange(value as "admin" | "user")}>
            <SelectTrigger aria-label={t("users.role")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent {...selectContentProps()}>
              <SelectItem value="user">{t("users.user")}</SelectItem>
              <SelectItem value="admin">{t("users.admin")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={creating}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            onClick={onCreate}
            disabled={creating || username.trim().length < 3 || password.length < 8}
          >
            {creating ? <Spinner className="size-4" /> : t("common.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
