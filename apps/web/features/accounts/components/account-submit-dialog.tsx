"use client";

import { Button } from "@workspace/ui/components/button";
import {
  Dialog,
  DialogContent,
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
import type { SubmitMode, WorkspaceChoice } from "@/lib/features/accounts/types/account-types";
import { selectContentProps } from "@/lib/features/accounts/utils/account-utils";

export function AccountSubmitDialog(props: {
  open: boolean;
  submitMode: SubmitMode;
  submitting: boolean;
  loginSessionId: string | null;
  requiresManualOtp: boolean;
  workspaceChoices: WorkspaceChoice[];
  selectedWorkspaceId: string;
  form: {
    email: string;
    password: string;
    otpCode: string;
  };
  t: (key: LocaleKey) => string;
  onOpenChange: (open: boolean) => void;
  onFormChange: (field: "email" | "password" | "otpCode", value: string) => void;
  onSelectedWorkspaceIdChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const {
    open,
    submitMode,
    submitting,
    loginSessionId,
    requiresManualOtp,
    workspaceChoices,
    selectedWorkspaceId,
    form,
    t,
    onOpenChange,
    onFormChange,
    onSelectedWorkspaceIdChange,
    onClose,
    onSubmit,
  } = props;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {submitMode === "relogin" ? t("team.relogin") : t("accounts.submit")}
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="space-y-2">
            <label className="mb-1 block text-sm font-medium">{t("accounts.email")}</label>
            <Input
              value={form.email}
              onChange={(event) => onFormChange("email", event.target.value)}
              className="h-10"
              disabled={submitMode === "relogin" || Boolean(loginSessionId)}
            />
          </div>
          {submitMode === "create" ? (
            <div className="space-y-2">
              <label className="mb-1 block text-sm font-medium">{t("accounts.password")}</label>
              <Input
                type="password"
                value={form.password}
                onChange={(event) => onFormChange("password", event.target.value)}
                className="h-10"
                disabled={Boolean(loginSessionId)}
              />
            </div>
          ) : null}
          {workspaceChoices.length > 0 ? (
            <div className="space-y-2">
              <label className="mb-1 block text-sm font-medium">{t("accounts.workspace")}</label>
              <Select value={selectedWorkspaceId} onValueChange={onSelectedWorkspaceIdChange}>
                <SelectTrigger className="h-10 w-full">
                  <SelectValue placeholder={t("accounts.selectWorkspace")} />
                </SelectTrigger>
                <SelectContent {...selectContentProps()}>
                  {workspaceChoices.map((workspace) => (
                    <SelectItem key={workspace.id} value={workspace.id}>
                      {workspace.name?.trim() || workspace.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : requiresManualOtp && loginSessionId ? (
            <div className="space-y-2">
              <label className="mb-1 block text-sm font-medium">{t("accounts.otpCode")}</label>
              <Input
                value={form.otpCode}
                onChange={(event) => onFormChange("otpCode", event.target.value)}
                className="h-10"
                inputMode="numeric"
              />
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={onSubmit}
            disabled={
              submitting ||
              !form.email.trim() ||
              (submitMode === "create" && !form.password.trim()) ||
              (workspaceChoices.length > 0
                ? !selectedWorkspaceId.trim()
                : requiresManualOtp && loginSessionId
                  ? !form.otpCode.trim()
                  : false)
            }
          >
            {submitting ? (
              <Spinner className="size-4" />
            ) : workspaceChoices.length > 0 ? (
              t("accounts.completeLogin")
            ) : requiresManualOtp && loginSessionId ? (
              t("accounts.verifyOtp")
            ) : (
              t("accounts.completeLogin")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
