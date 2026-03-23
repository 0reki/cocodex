# @workspace/openai-codex-auth

Codex OAuth passwordless flow helpers.

## Features

- Generate PKCE params (`code_verifier`, `code_challenge`, `state`)
- Build authorize URL
- Call OpenAI auth endpoints with cookie continuity:
  - `/api/accounts/authorize/continue`
  - `/api/accounts/passwordless/send-otp`
  - `/api/accounts/email-otp/validate`
  - `/api/accounts/workspace/select`
  - redirect chain to `http://localhost:1455/auth/callback`
  - `/oauth/token`
- Save `access_token` and `refresh_token` locally

## Usage

```ts
import {
  CodexAuthClient,
  createPkceAuthRequest,
  saveTokensToFile,
} from "@workspace/openai-codex-auth";

const pkce = createPkceAuthRequest({
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  redirectUri: "http://localhost:1455/auth/callback",
  originator: "codex_cli_rs",
});

console.log("Open URL:", pkce.authorizationUrl);

const client = new CodexAuthClient();

await client.authorizeContinue({
  email: "your@email.com",
});

await client.sendPasswordlessOtp();
await client.validateEmailOtp("123456");

const workspaces = await client.extractWorkspacesFromAuthSessionCookie();
const workspaceId = workspaces[0]?.id;
if (!workspaceId) throw new Error("No workspace found");

const workspaceStep = await client.selectWorkspace(workspaceId);
const externalUrl = String(workspaceStep.continue_url ?? "");
if (!externalUrl) throw new Error("Missing continue_url");

const callback = await client.resolveCallbackFromExternalUrl(externalUrl, {
  expectedState: pkce.state,
});

const tokens = await client.exchangeToken({
  code: callback.code,
  codeVerifier: pkce.codeVerifier,
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  redirectUri: "http://localhost:1455/auth/callback",
});

await saveTokensToFile(tokens, "./codex-oauth-tokens.json");
```

## Notes

- `state` and `code_verifier` must be kept and reused in the same login session.
- `resolveCallbackFromExternalUrl()` expects redirect to `http://localhost:1455/auth/callback`.
- Do not commit token files or raw cookies to source control.
