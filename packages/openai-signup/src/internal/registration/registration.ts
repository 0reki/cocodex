import { CookieJar } from "tough-cookie";
import crypto from "crypto";
import {
  AUTH_URL,
  CHATGPT_URL,
  DEFAULT_BUILD_NUMBER,
  DEFAULT_CLIENT_VERSION,
  USER_AGENT,
  fetchWithTimeout,
  getActiveDispatcher,
  getSetCookies,
  withActiveRunPrefix,
} from "../shared/runtime.ts";
import type { OAuthBootstrap, SignupSessionResult } from "../shared/types.ts";
import { completeRegistration } from "./finalize.ts";
import {
  extractOAuthBootstrap,
  getNextAuthCsrfToken,
  saveFinalSessionCookies,
  updateClientBuildFromHtml,
} from "./helpers.ts";
import { getSentinelTokenViaSdk } from "./sentinel.ts";

export class OpenAIRegistration {
  private jar: CookieJar;
  private state: string | null = null;
  private deviceId: string;
  private stableP: string | null = null;
  private authSessionLoggingId: string | null = null;
  private authorizeUrlFromStep0: string | null = null;
  private clientVersion: string = DEFAULT_CLIENT_VERSION;
  private buildNumber: string = DEFAULT_BUILD_NUMBER;
  private finalSessionResult: SignupSessionResult | null = null;

  constructor() {
    this.jar = new CookieJar();
    this.deviceId = crypto.randomUUID();
  }

  getFinalSessionResult() {
    return this.finalSessionResult;
  }

  private async getCookieValue(
    url: string,
    name: string,
  ): Promise<string | null> {
    const cookies = await this.jar.getCookies(url);
    const target = cookies.find((c: { key: string }) => c.key === name);
    return target?.value ?? null;
  }

  private async getNextAuthCsrfToken(): Promise<string | null> {
    return getNextAuthCsrfToken({
      getCookieValue: this.getCookieValue.bind(this),
    });
  }

  private async extractOAuthBootstrap(
    createAccountResponseText: string,
  ): Promise<OAuthBootstrap> {
    return extractOAuthBootstrap({
      createAccountResponseText,
      getCookieValue: this.getCookieValue.bind(this),
    });
  }

  private async saveFinalSessionCookies(
    email: string,
    setCookies: string[],
  ): Promise<SignupSessionResult> {
    const result = saveFinalSessionCookies(email, setCookies);
    this.finalSessionResult = result;
    return result;
  }

  private async syncDidCookies() {
    const expires = new Date(
      Date.now() + 365 * 24 * 60 * 60 * 1000,
    ).toUTCString();
    await this.jar.setCookie(
      `oai-did=${this.deviceId}; Domain=.chatgpt.com; Path=/; Expires=${expires}; Secure; HttpOnly`,
      "https://chatgpt.com",
    );
    await this.jar.setCookie(
      `oai-did=${this.deviceId}; Domain=.openai.com; Path=/; Expires=${expires}; Secure; HttpOnly`,
      "https://auth.openai.com",
    );
    await this.jar.setCookie(
      `oai-did=${this.deviceId}; Domain=.openai.com; Path=/; Expires=${expires}; Secure; HttpOnly`,
      "https://sentinel.openai.com",
    );
  }

  private updateClientBuildFromHtml(html: string) {
    const next = updateClientBuildFromHtml({
      html,
      currentClientVersion: this.clientVersion,
      currentBuildNumber: this.buildNumber,
    });
    this.clientVersion = next.clientVersion;
    this.buildNumber = next.buildNumber;
  }

  private async getSentinelTokenViaSdk(flow: string): Promise<{
    token: string;
    p: string | null;
  }> {
    const result = await getSentinelTokenViaSdk({
      flow,
      deviceId: this.deviceId,
      stableP: this.stableP,
      clientVersion: this.clientVersion,
      getHeaders: this.getHeaders.bind(this),
      updateCookies: this.updateCookies.bind(this),
      syncDidCookies: this.syncDidCookies.bind(this),
    });
    this.stableP = result.stableP;
    return { token: result.token, p: result.p };
  }

  private async getHeaders(
    extra: Record<string, string> = {},
    url: string = AUTH_URL,
  ) {
    const cookies = await this.jar.getCookieString(url);
    const domain = new URL(url).hostname;

    const headers: Record<string, string> = {
      Host: domain,
      Connection: "keep-alive",
      "User-Agent": USER_AGENT,
      Accept: "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "sec-ch-ua":
        '"Google Chrome";v="143", "Chromium";v="143", "Not?A_Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": domain === "chatgpt.com" ? "same-origin" : "cross-site",
      "oai-client-version": this.clientVersion,
      "oai-client-build-number": this.buildNumber,
      "oai-device-id": this.deviceId,
      "oai-language": "zh-CN",
      Origin:
        domain === "chatgpt.com"
          ? "https://chatgpt.com"
          : "https://auth.openai.com",
      Referer:
        domain === "chatgpt.com"
          ? "https://chatgpt.com/"
          : `https://${domain}/`,
      Priority: "u=1, i",
      Cookie: cookies,
      ...extra,
    };

    return headers;
  }

  private async updateCookies(
    setCookie: string[] | string | null,
    currentUrl: string,
  ) {
    if (!setCookie) return;
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];

    for (const cookieStr of cookies) {
      try {
        await this.jar.setCookie(cookieStr, currentUrl);
      } catch {
        try {
          const urlObj = new URL(currentUrl);
          if (
            !cookieStr.toLowerCase().includes("domain=") &&
            !cookieStr.startsWith("__Host-")
          ) {
            await this.jar.setCookie(
              `${cookieStr}; Domain=${urlObj.hostname}`,
              currentUrl,
            );
          }
        } catch {}
      }
    }
  }

  async stage1_Initialize() {
    console.log(withActiveRunPrefix("[Step 0] Syncing Device ID to Cookies..."));
    await this.syncDidCookies();

    console.log(withActiveRunPrefix("[Step 1] Initializing Authorize..."));
    if (!this.authorizeUrlFromStep0) {
      throw new Error("Step -0 did not provide authorize url");
    }
    const url = new URL(this.authorizeUrlFromStep0);
    this.state = url.searchParams.get("state");

    const res = await fetchWithTimeout(url.toString(), {
      method: "GET",
      headers: await this.getHeaders(
        {
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        },
        AUTH_URL,
      ),
      dispatcher: getActiveDispatcher(),
      redirect: "manual",
    });

    await this.updateCookies(getSetCookies(res.headers), AUTH_URL);

    const cookiesAfterInit = await this.jar.getCookieString(AUTH_URL);
    if (cookiesAfterInit.includes("auth_provider")) {
      console.log(
        withActiveRunPrefix("\x1b[32m[Step 1] auth_provider acquired successfully.\x1b[0m"),
      );
    } else {
      console.warn(withActiveRunPrefix("\x1b[31m[Step 1] FAILED to acquire auth_provider.\x1b[0m"));
    }

    const location = res.headers.get("location");
    if (location) {
      const finalUrl = new URL(location, AUTH_URL);
      this.state = finalUrl.searchParams.get("state") || this.state;
    }

    console.log(withActiveRunPrefix("[Step 1] Initialized."));

    console.log(withActiveRunPrefix("[Step 2] Refreshing Session..."));
    const passwordUrl = new URL(`${AUTH_URL}/create-account/password`);
    if (this.state) passwordUrl.searchParams.set("state", this.state);

    const res2 = await fetchWithTimeout(passwordUrl.toString(), {
      method: "GET",
      headers: await this.getHeaders(
        {
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        },
        AUTH_URL,
      ),
      dispatcher: getActiveDispatcher(),
    });
    await this.updateCookies(getSetCookies(res2.headers), AUTH_URL);
    console.log(withActiveRunPrefix("[Step 2] Session Ready."));
  }

  async stage0_InitializeNextAuth(email: string) {
    console.log(withActiveRunPrefix("[Step -1] Initializing ChatGPT session..."));
    const homeRes = await fetchWithTimeout(`${CHATGPT_URL}/`, {
      method: "GET",
      headers: await this.getHeaders(
        {
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
          Referer: `${CHATGPT_URL}/`,
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "none",
          "sec-fetch-user": "?1",
          "upgrade-insecure-requests": "1",
        },
        CHATGPT_URL,
      ),
      dispatcher: getActiveDispatcher(),
      redirect: "manual",
    });
    await this.updateCookies(getSetCookies(homeRes.headers), CHATGPT_URL);
    const homeHtml = await homeRes.text();
    this.updateClientBuildFromHtml(homeHtml);

    const csrfToken = await this.getNextAuthCsrfToken();
    if (!csrfToken) {
      throw new Error(
        "Failed to acquire __Host-next-auth.csrf-token from chatgpt.com",
      );
    }

    if (!this.authSessionLoggingId) {
      this.authSessionLoggingId = crypto.randomUUID();
    }

    await this.jar.setCookie(
      `oai-asli=${this.authSessionLoggingId}; Domain=.chatgpt.com; Path=/; Max-Age=7776000; Secure; SameSite=Lax`,
      CHATGPT_URL,
    );

    console.log(withActiveRunPrefix("[Step -0] Initializing next-auth state..."));
    const signinUrl = new URL(`${CHATGPT_URL}/api/auth/signin/openai`);
    signinUrl.searchParams.set("prompt", "login");
    signinUrl.searchParams.set("ext-oai-did", this.deviceId);
    signinUrl.searchParams.set(
      "auth_session_logging_id",
      this.authSessionLoggingId!,
    );
    signinUrl.searchParams.set("screen_hint", "login_or_signup");
    signinUrl.searchParams.set("login_hint", email);

    const body = new URLSearchParams({
      callbackUrl: `${CHATGPT_URL}/`,
      csrfToken,
      json: "true",
    }).toString();

    const signinHeaders = await this.getHeaders(
      {
        Accept: "*/*",
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `${CHATGPT_URL}/`,
        Origin: CHATGPT_URL,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
      CHATGPT_URL,
    );
    const signinRes = await fetchWithTimeout(signinUrl.toString(), {
      method: "POST",
      headers: signinHeaders,
      body,
      dispatcher: getActiveDispatcher(),
      redirect: "manual",
    });
    const signinText = await signinRes.text();
    await this.updateCookies(getSetCookies(signinRes.headers), CHATGPT_URL);

    let signinJson: any = null;
    try {
      signinJson = JSON.parse(signinText);
    } catch {
      signinJson = null;
    }
    const authorizeUrl =
      typeof signinJson?.url === "string" ? signinJson.url : null;
    if (!authorizeUrl) {
      throw new Error("Step -0 response did not contain authorize url");
    }
    this.authorizeUrlFromStep0 = authorizeUrl;
    try {
      const parsedAuthorizeUrl = new URL(authorizeUrl);
      this.state = parsedAuthorizeUrl.searchParams.get("state");
    } catch {
      this.state = null;
    }

    const nextAuthState = await this.getCookieValue(
      CHATGPT_URL,
      "__Secure-next-auth.state",
    );
    if (!nextAuthState) {
      throw new Error(
        "Failed to acquire __Secure-next-auth.state from /api/auth/signin/openai",
      );
    }
    console.log(withActiveRunPrefix("[Step -0] next-auth state cookie acquired."));
  }

  async stage2_Sentinel(flow: string = "oauth_create_account"): Promise<{
    token: string;
    p: string | null;
  }> {
    console.log(withActiveRunPrefix(`[Step 3/4/5] Sentinel token via SDK (flow: ${flow})...`));
    return this.getSentinelTokenViaSdk(flow);
  }

  async stage3_Verify(email: string, sentinelToken: string) {
    console.log(withActiveRunPrefix("[Step 6] Authorize Continue..."));
    const continueUrl = new URL(`${AUTH_URL}/api/accounts/authorize/continue`);
    if (this.state) continueUrl.searchParams.set("state", this.state);

    const res = await fetchWithTimeout(continueUrl.toString(), {
      method: "POST",
      headers: await this.getHeaders({
        "Content-Type": "application/json",
        "openai-sentinel-token": sentinelToken,
        Referer: "https://auth.openai.com/create-account/password",
      }),
      body: JSON.stringify({
        username: { value: email, kind: "email" },
        screen_hint: "signup",
      }),
      dispatcher: getActiveDispatcher(),
    });
    await this.updateCookies(getSetCookies(res.headers), AUTH_URL);
    console.log(withActiveRunPrefix("[Step 6] Identity Locked."));
  }

  async stage3_SetPassword(
    email: string,
    password: string,
    sentinelToken: string,
  ) {
    console.log(withActiveRunPrefix("[Step 6.5] Registering Password..."));

    const registerUrl = `${AUTH_URL}/api/accounts/user/register`;

    const headers = await this.getHeaders({
      "Content-Type": "application/json",
      "openai-sentinel-token": sentinelToken,
      Referer: "https://auth.openai.com/create-account/password",
    });

    const res = await fetchWithTimeout(registerUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ password, username: email }),
      dispatcher: getActiveDispatcher(),
    });

    const text = await res.text();
    await this.updateCookies(getSetCookies(res.headers), AUTH_URL);

    if (res.ok) {
      console.log(withActiveRunPrefix("[Step 6.5] Password Set Successfully."));
    } else {
      console.error(withActiveRunPrefix(`[Step 6.5] Failed to set password: ${res.status} ${text}`));
      throw new Error("Password registration failed");
    }
  }

  async stage3_TriggerOTPSend() {
    console.log(withActiveRunPrefix("[Step 7] Triggering OTP Send..."));
    const url = new URL(`${AUTH_URL}/api/accounts/email-otp/send`);
    if (this.state) url.searchParams.set("state", this.state);

    const res = await fetchWithTimeout(url.toString(), {
      method: "GET",
      headers: await this.getHeaders(
        {
          Referer: "https://auth.openai.com/create-account/password",
        },
        AUTH_URL,
      ),
      dispatcher: getActiveDispatcher(),
      redirect: "manual",
    });

    await this.updateCookies(getSetCookies(res.headers), AUTH_URL);
  }

  async stage3_ValidateOTP(otp: string) {
    console.log(withActiveRunPrefix("[Step 8] Validating OTP..."));
    const res = await fetchWithTimeout(
      `${AUTH_URL}/api/accounts/email-otp/validate`,
      {
        method: "POST",
        headers: await this.getHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ code: otp }),
        dispatcher: getActiveDispatcher(),
      },
    );

    const text = await res.text();
    await this.updateCookies(getSetCookies(res.headers), AUTH_URL);

    if (res.ok) {
      console.log(withActiveRunPrefix("[Step 8] OTP Validated."));
    } else {
      console.error(withActiveRunPrefix(`[Step 8] OTP Validation Failed: ${res.status} ${text}`));
      throw new Error("OTP Validation failed");
    }
  }

  async stage4_CreateAccount(
    name: string,
    birthdate: string,
    email: string,
    sentinelToken: string,
  ) {
    console.log(withActiveRunPrefix("[Step 9] Creating Account..."));
    const createUrl = new URL(`${AUTH_URL}/api/accounts/create_account`);
    if (this.state) createUrl.searchParams.set("state", this.state);

    const res = await fetchWithTimeout(createUrl.toString(), {
      method: "POST",
      headers: await this.getHeaders({
        "Content-Type": "application/json",
        Referer: "https://auth.openai.com/email-verification",
        "openai-sentinel-token": sentinelToken,
      }),
      body: JSON.stringify({ name, birthdate }),
      dispatcher: getActiveDispatcher(),
    });

    const resText = await res.text();

    await this.updateCookies(getSetCookies(res.headers), AUTH_URL);
    if (res.ok) {
      console.log(withActiveRunPrefix("[Step 9] SUCCESS: Account Created."));
      const bootstrap = await this.extractOAuthBootstrap(resText);
      await this.stage5_CompleteRegistration(email, bootstrap);
    } else {
      console.error(withActiveRunPrefix(`[Step 9] FAILED: ${res.status} - ${resText}`));
      throw new Error(`Create account failed: ${res.status} ${resText}`);
    }
  }

  async stage5_CompleteRegistration(email: string, bootstrap: OAuthBootstrap) {
    await completeRegistration({
      email,
      bootstrap,
      state: this.state,
      deviceId: this.deviceId,
      getHeaders: this.getHeaders.bind(this),
      updateCookies: this.updateCookies.bind(this),
      saveFinalSessionCookies: async (targetEmail, cookies) => {
        await this.saveFinalSessionCookies(targetEmail, cookies);
      },
    });
  }
}
