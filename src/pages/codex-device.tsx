import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";

import {
  AUTH_INPUT_CLASS_NAME,
  AuthPage,
  AuthSubmitButton,
} from "@/components/auth-page";
import { InlineNotice } from "@/components/ui";
import { jsonBody } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button } from "@/ui/components/button";

// The Codex CLI device-code login shows a user code; the user signs in to the
// console and enters that code here to bind the CLI session to their account.
export function CodexDevicePage() {
  const { api, user } = useAuth();
  const [params] = useSearchParams();
  const [userCode, setUserCode] = useState(params.get("user_code") ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [approved, setApproved] = useState(false);

  async function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api("/api/codex-client/device/approve", {
        method: "POST",
        ...jsonBody({ userCode: userCode.trim() }),
      });
      setApproved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "授权失败");
    } finally {
      setSubmitting(false);
    }
  }

  if (approved) {
    return (
      <AuthPage heading="Codex 客户端已授权">
        <p className="mt-2 text-center text-sm text-muted-foreground">
          可以回到 Codex 客户端继续使用，这个页面可以关闭了。
        </p>
      </AuthPage>
    );
  }

  return (
    <AuthPage heading="授权 Codex 客户端登录">
      <form
        onSubmit={(event) => void approve(event)}
        className="mt-2 w-full space-y-4"
      >
        <p className="text-center text-sm text-muted-foreground">
          将以账号
          <span className="font-medium text-foreground"> {user?.username} </span>
          授权本机 Codex 客户端。请确认下方设备码与客户端显示的一致。
        </p>
        {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
        <input
          value={userCode}
          onChange={(event) => setUserCode(event.target.value)}
          placeholder="设备码，例如 ABCD-1234"
          aria-label="设备码"
          autoFocus
          className={`${AUTH_INPUT_CLASS_NAME} text-center font-mono tracking-widest uppercase`}
        />
        <AuthSubmitButton
          submitting={submitting}
          disabled={!userCode.trim()}
          idleLabel="确认授权"
          submittingLabel="授权中"
        />
        <Button
          variant="ghost"
          type="button"
          onClick={() => window.close()}
          className="w-full"
        >
          取消
        </Button>
      </form>
    </AuthPage>
  );
}
