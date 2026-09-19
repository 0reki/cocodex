import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";

import { AuthPage, AuthSubmitButton } from "@/components/auth-page";
import { InlineNotice } from "@/components/ui";
import { jsonBody } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button } from "@/ui/components/button";

type AuthorizeResponse = { redirectTo: string };

// The Codex CLI opens the gateway's `/oauth/authorize`, which sends the
// browser here (after login) with the original PKCE query. The user consents,
// the console mints an authorization code bound to their account, and the
// browser is handed back to the CLI's local callback.
export function CodexAuthorizePage() {
  const { api, user } = useAuth();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const redirectUri = params.get("redirect_uri") ?? "";
  const codeChallenge = params.get("code_challenge") ?? "";
  const state = params.get("state") ?? "";
  const missing = !redirectUri || !codeChallenge;

  async function authorize(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await api<AuthorizeResponse>(
        "/api/codex-client/authorize",
        {
          method: "POST",
          ...jsonBody({ redirectUri, codeChallenge, state }),
        },
      );
      // Hand control back to the Codex CLI's loopback callback.
      window.location.replace(response.redirectTo);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "授权失败");
      setSubmitting(false);
    }
  }

  return (
    <AuthPage heading="授权 Codex 客户端登录">
      <form
        onSubmit={(event) => void authorize(event)}
        className="mt-2 w-full space-y-4"
      >
        {missing ? (
          <InlineNotice tone="error">
            授权链接缺少必要参数，请在 Codex 客户端重新发起登录。
          </InlineNotice>
        ) : (
          <p className="text-center text-sm text-muted-foreground">
            将以账号
            <span className="font-medium text-foreground">
              {" "}
              {user?.username}{" "}
            </span>
            授权本机 Codex 客户端接入网关。请确认此登录由你本人发起。
          </p>
        )}
        {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
        <AuthSubmitButton
          submitting={submitting}
          disabled={missing}
          idleLabel="允许登录"
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
