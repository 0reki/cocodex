import { useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";

import {
  AUTH_INPUT_CLASS_NAME,
  AuthPage,
  AuthSubmitButton,
} from "@/components/auth-page";
import { InlineNotice } from "@/components/ui";
import { useAuth } from "@/lib/auth";

function safeNextPath(value: string | null) {
  return value?.startsWith("/") && !value.startsWith("//")
    ? value
    : "/dashboard";
}

export function LoginPage() {
  const { ready, user, login } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (ready && user) {
    return <Navigate to={safeNextPath(searchParams.get("next"))} replace />;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(username, password);
      navigate(safeNextPath(searchParams.get("next")), { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登录失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthPage heading="登录以继续使用 CoCodex">
      <form
        onSubmit={(event) => void submit(event)}
        className="mt-2 w-full space-y-3"
      >
        {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
        <label className="block text-sm font-medium" htmlFor="username">
          用户名
        </label>
        <input
          id="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          type="text"
          autoComplete="username"
          autoFocus
          required
          className={AUTH_INPUT_CLASS_NAME}
        />
        <label className="block text-sm font-medium" htmlFor="password">
          密码
        </label>
        <input
          id="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          type="password"
          autoComplete="current-password"
          required
          className={AUTH_INPUT_CLASS_NAME}
        />
        <AuthSubmitButton
          submitting={submitting}
          disabled={!ready}
          idleLabel="登录"
          submittingLabel="正在登录"
        />
      </form>
    </AuthPage>
  );
}
