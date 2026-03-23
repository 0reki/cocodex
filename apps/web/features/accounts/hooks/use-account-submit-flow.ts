"use client";

import { useState } from "react";
import type { LocaleKey } from "@/locales";
import type { SavedAccountSummary, SubmitMode, WorkspaceChoice } from "@/lib/features/accounts/types/account-types";
import { emptyForm, resetLoginState } from "@/lib/features/accounts/utils/account-utils";
import { useAccountLoginActions } from "./use-account-login-actions";

export function useAccountSubmitFlow(props: {
  t: (key: LocaleKey) => string;
  toast: {
    success: (message: string) => void;
    error: (message: string) => void;
    info: (message: string) => void;
  };
  refresh: () => void;
  setActingEmail: React.Dispatch<React.SetStateAction<string | null>>;
  onAccountSaved: (
    account: SavedAccountSummary | null,
    mode: SubmitMode,
  ) => Promise<void> | void;
}) {
  const { t, toast, refresh, setActingEmail, onAccountSaved } = props;
  const [submitOpen, setSubmitOpen] = useState(false);
  const [submitMode, setSubmitMode] = useState<SubmitMode>("create");
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [loginSessionId, setLoginSessionId] = useState<string | null>(null);
  const [requiresManualOtp, setRequiresManualOtp] = useState(false);
  const [workspaceChoices, setWorkspaceChoices] = useState<WorkspaceChoice[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");

  const closeSubmitDialog = () => {
    const next = resetLoginState();
    setSubmitOpen(false);
    setSubmitMode("create");
    setForm(next.form);
    setLoginSessionId(next.loginSessionId);
    setRequiresManualOtp(next.requiresManualOtp);
    setWorkspaceChoices(next.workspaceChoices);
    setSelectedWorkspaceId(next.selectedWorkspaceId);
  };

  const {
    startLogin,
    verifyOtpAndContinue,
    completeWorkspaceAndContinue,
    openReloginDialog,
  } = useAccountLoginActions({
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
  });

  return {
    submitOpen,
    submitMode,
    submitting,
    form,
    loginSessionId,
    requiresManualOtp,
    workspaceChoices,
    selectedWorkspaceId,
    setSubmitOpen,
    setSubmitMode,
    setSelectedWorkspaceId,
    setForm,
    closeSubmitDialog,
    submitAccount: () => startLogin(),
    verifyOtp: verifyOtpAndContinue,
    completeWorkspaceSelection: completeWorkspaceAndContinue,
    openReloginDialog,
  };
}
