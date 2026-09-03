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
import { useAuth } from "@/lib/auth";

type InvitationStatus = { ok: true; expiresAt: string };

export function RegisterPage() {
  const { ready, user, register } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const inviteToken = searchParams.get("invite")?.trim() ?? "";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [validating, setValidating] = useState(true);
  const [valid, setValid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setValidating(true);
    setValid(false);
    setError(null);
    if (!inviteToken) {
      setError("注册链接缺少邀请凭证");
      setValidating(false);
      return () => controller.abort();
    }
    void fetchJson<InvitationStatus>(
      `/api/auth/invitations/${encodeURIComponent(inviteToken)}`,
      { signal: controller.signal },
    )
      .then(() => setValid(true))
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "注册链接无效");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setValidating(false);
      });
    return () => controller.abort();
  }, [inviteToken]);

  if (ready && user) return <Navigate to="/dashboard" replace />;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await register(inviteToken, username.trim(), password);
      navigate("/dashboard", { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "注册失败");
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
            {error ?? "注册链接无效或已失效"}
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
            minLength={8}
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
            minLength={8}
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
