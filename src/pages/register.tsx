import { LoaderCircle } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";

import {
  AUTH_INPUT_CLASS_NAME,
  AuthPage,
  AuthSubmitButton,
} from "@/components/auth-page";
import { InlineNotice } from "@/components/ui";
import { fetchJson } from "@/lib/api";
import {
  PORTAL_PASSWORD_MAX_LENGTH,
  PORTAL_PASSWORD_MIN_LENGTH,
  useAuth,
} from "@/lib/auth";

type InvitationStatus = { ok: true; expiresAt: string };
type InvitationValidation = {
  token: string;
  valid: boolean;
  error: string | null;
};

export function RegisterPage() {
  const { ready, user, register } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const inviteToken = searchParams.get("invite")?.trim() ?? "";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [invitationValidation, setInvitationValidation] =
    useState<InvitationValidation | null>(null);
  const [formError, setFormError] = useState<{
    token: string;
    message: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    if (!inviteToken) {
      return () => controller.abort();
    }
    void fetchJson<InvitationStatus>(
      `/api/auth/invitations/${encodeURIComponent(inviteToken)}`,
      { signal: controller.signal },
    )
      .then(() => {
        setInvitationValidation({
          token: inviteToken,
          valid: true,
          error: null,
        });
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setInvitationValidation({
            token: inviteToken,
            valid: false,
            error: cause instanceof Error ? cause.message : "注册链接无效",
          });
        }
      });
    return () => controller.abort();
  }, [inviteToken]);

  const currentValidation =
    invitationValidation?.token === inviteToken ? invitationValidation : null;
  const validating = Boolean(inviteToken) && currentValidation === null;
  const valid = currentValidation?.valid === true;
  const invitationError = inviteToken
    ? currentValidation?.error
    : "注册链接缺少邀请凭证";
  const error = formError?.token === inviteToken ? formError.message : null;

  if (ready && user) return <Navigate to="/dashboard" replace />;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirmPassword) {
      setFormError({ token: inviteToken, message: "两次输入的密码不一致" });
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      await register(inviteToken, username.trim(), password);
      navigate("/dashboard", { replace: true });
    } catch (cause) {
      setFormError({
        token: inviteToken,
        message: cause instanceof Error ? cause.message : "注册失败",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthPage heading="创建账号">
      {validating ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          正在校验注册链接
        </div>
      ) : null}

      {!validating && !valid ? (
        <div className="grid w-full gap-4">
          <InlineNotice tone="error">
            {invitationError ?? "注册链接无效或已失效"}
          </InlineNotice>
          <Link
            className="text-sm font-medium underline underline-offset-4"
            to="/login"
          >
            返回登录
          </Link>
        </div>
      ) : null}

      {valid ? (
        <form
          className="mt-2 w-full space-y-3"
          onSubmit={(event) => void submit(event)}
        >
          {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
          <label className="block text-sm font-medium" htmlFor="username">
            用户名
          </label>
          <input
            id="username"
            className={AUTH_INPUT_CLASS_NAME}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
          <label className="block text-sm font-medium" htmlFor="password">
            密码
          </label>
          <input
            id="password"
            className={AUTH_INPUT_CLASS_NAME}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            minLength={PORTAL_PASSWORD_MIN_LENGTH}
            maxLength={PORTAL_PASSWORD_MAX_LENGTH}
            required
          />
          <label
            className="block text-sm font-medium"
            htmlFor="confirm-password"
          >
            确认密码
          </label>
          <input
            id="confirm-password"
            className={AUTH_INPUT_CLASS_NAME}
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            autoComplete="new-password"
            minLength={PORTAL_PASSWORD_MIN_LENGTH}
            maxLength={PORTAL_PASSWORD_MAX_LENGTH}
            required
          />
          <AuthSubmitButton
            submitting={submitting}
            idleLabel="完成注册"
            submittingLabel="正在注册"
          />
        </form>
      ) : null}
    </AuthPage>
  );
}
