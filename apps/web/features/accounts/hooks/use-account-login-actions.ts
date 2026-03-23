"use client";

import type { LocaleKey } from "@/locales";
import type {
  AccountItem,
  SavedAccountSummary,
  SubmitMode,
  WorkspaceChoice,
} from "@/lib/features/accounts/types/account-types";
import {
  completeAccountWorkspaceSelection,
  startAccountLogin,
  verifyAccountOtp,
} from "@/lib/features/accounts/api/account-api";
import { emptyForm } from "@/lib/features/accounts/utils/account-utils";

export function useAccountLoginActions(props: {
  t: (key: LocaleKey) => string;
  toast: {
    success: (message: string) => void;
    error: (message: string) => void;
    info: (message: string) => void;
  };
  refresh: () => void;
  submitMode: SubmitMode;
  form: {
    email: string;
    password: string;
    otpCode: string;
  };
  loginSessionId: string | null;
  selectedWorkspaceId: string;
  setActingEmail: React.Dispatch<React.SetStateAction<string | null>>;
  setSubmitOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSubmitting: React.Dispatch<React.SetStateAction<boolean>>;
  setSubmitMode: React.Dispatch<React.SetStateAction<SubmitMode>>;
  setForm: React.Dispatch<
    React.SetStateAction<{
      email: string;
      password: string;
      otpCode: string;
    }>
  >;
  setLoginSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setRequiresManualOtp: React.Dispatch<React.SetStateAction<boolean>>;
  setWorkspaceChoices: React.Dispatch<React.SetStateAction<WorkspaceChoice[]>>;
  setSelectedWorkspaceId: React.Dispatch<React.SetStateAction<string>>;
  onAccountSaved: (
    account: SavedAccountSummary | null,
    mode: SubmitMode,
  ) => Promise<void> | void;
}) {
  const {
    t,
    toast,
    refresh,
    submitMode,
    form,
    loginSessionId,
    selectedWorkspaceId,
    setActingEmail,
    setSubmitOpen,
    setSubmitting,
    setSubmitMode,
    setForm,
    setLoginSessionId,
    setRequiresManualOtp,
    setWorkspaceChoices,
    setSelectedWorkspaceId,
    onAccountSaved,
  } = props;

  const clearInteractiveState = () => {
    setLoginSessionId(null);
    setRequiresManualOtp(false);
    setWorkspaceChoices([]);
    setSelectedWorkspaceId("");
  };

  const finishLogin = async (
    savedAccount: SavedAccountSummary | null,
    mode: SubmitMode,
    successEmail: string,
  ) => {
    toast.success(
      mode === "relogin"
        ? t("team.reloginSuccess").replace("{email}", successEmail)
        : t("accounts.created"),
    );
    clearInteractiveState();
    setSubmitOpen(false);
    setForm(emptyForm());
    refresh();
    await onAccountSaved(savedAccount, mode);
  };

  const startLogin = async (options?: {
    openDialogOnInteraction?: boolean;
    emailOverride?: string;
    modeOverride?: SubmitMode;
    actionEmail?: string;
    systemCreatedHint?: boolean;
  }) => {
    const mode = options?.modeOverride ?? submitMode;
    const email = (options?.emailOverride ?? form.email).trim().toLowerCase();
    if (!email) {
      toast.error(t("accounts.emailRequired"));
      return;
    }
    setSubmitting(true);
    try {
      clearInteractiveState();
      const data = await startAccountLogin({
        email,
        ...(mode === "relogin"
          ? {
              relogin: true,
              ...(options?.systemCreatedHint === true ? { systemCreated: true } : {}),
            }
          : { password: form.password.trim() }),
      });
      if (data?.requiresOtp && data.sessionId) {
        setLoginSessionId(data.sessionId);
        setRequiresManualOtp(true);
        if (options?.openDialogOnInteraction) {
          setSubmitOpen(true);
        }
        toast.info(t("accounts.otpRequired"));
        return;
      }
      if (data?.requiresWorkspace && data.sessionId) {
        setLoginSessionId(data.sessionId);
        setWorkspaceChoices(Array.isArray(data.workspaces) ? data.workspaces : []);
        if (options?.openDialogOnInteraction) {
          setSubmitOpen(true);
        }
        toast.info(t("accounts.workspaceRequired"));
        return;
      }
      await finishLogin(data?.account ?? null, mode, email);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("accounts.submitFailed"));
    } finally {
      setSubmitting(false);
      if (options?.actionEmail) {
        setActingEmail((current) => (current === options.actionEmail ? null : current));
      }
    }
  };

  const verifyOtpAndContinue = async () => {
    if (!loginSessionId) return;
    const code = form.otpCode.trim();
    if (!code) {
      toast.error(t("accounts.otpRequired"));
      return;
    }
    setSubmitting(true);
    try {
      const data = await verifyAccountOtp({ sessionId: loginSessionId, code });
      if (data?.requiresWorkspace && data.sessionId) {
        setLoginSessionId(data.sessionId);
        setRequiresManualOtp(false);
        setWorkspaceChoices(Array.isArray(data.workspaces) ? data.workspaces : []);
        setSelectedWorkspaceId("");
        toast.info(t("accounts.workspaceRequired"));
        return;
      }
      await finishLogin(data?.account ?? null, submitMode, form.email.trim().toLowerCase());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("accounts.submitFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  const completeWorkspaceAndContinue = async () => {
    if (!loginSessionId) return;
    const workspaceId = selectedWorkspaceId.trim();
    if (!workspaceId) {
      toast.error(t("accounts.workspaceRequired"));
      return;
    }
    setSubmitting(true);
    try {
      const data = await completeAccountWorkspaceSelection({
        sessionId: loginSessionId,
        workspaceId,
      });
      await finishLogin(data?.account ?? null, submitMode, form.email.trim().toLowerCase());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("accounts.submitFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  const openReloginDialog = (item: AccountItem) => {
    setActingEmail(item.email);
    setSubmitMode("relogin");
    setSubmitOpen(true);
    clearInteractiveState();
    setForm({
      email: item.email,
      password: "",
      otpCode: "",
    });
    void startLogin({
      openDialogOnInteraction: true,
      emailOverride: item.email,
      modeOverride: "relogin",
      actionEmail: item.email,
      systemCreatedHint: item.systemCreated,
    });
  };

  return {
    startLogin,
    verifyOtpAndContinue,
    completeWorkspaceAndContinue,
    openReloginDialog,
  };
}
