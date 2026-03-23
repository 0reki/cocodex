import {
  AUTH_URL,
  CHATGPT_URL,
  fetchWithTimeout,
  getActiveDispatcher,
  getSetCookies,
  withActiveRunPrefix,
} from "../shared/runtime.ts";
import type { OAuthBootstrap } from "../shared/types.ts";

const NAVIGATE_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7";

export async function completeRegistration(args: {
  email: string;
  bootstrap: OAuthBootstrap;
  state: string | null;
  deviceId: string;
  getHeaders: (
    extra?: Record<string, string>,
    url?: string,
  ) => Promise<Record<string, string>>;
  updateCookies: (setCookie: string[] | string | null, currentUrl: string) => Promise<void>;
  saveFinalSessionCookies: (email: string, setCookies: string[]) => Promise<void>;
}): Promise<void> {
  const finishWithFinalUrl = async (url: string) => {
    console.log(withActiveRunPrefix("[Step 13] final..."));
    const finalHeaders = await args.getHeaders(
      {
        Accept: NAVIGATE_ACCEPT,
        Referer: "https://auth.openai.com/",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "cross-site",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
      },
      CHATGPT_URL,
    );
    const finalRes = await fetchWithTimeout(url, {
      method: "GET",
      headers: finalHeaders,
      dispatcher: getActiveDispatcher(),
      redirect: "manual",
    });
    const finalSetCookies = getSetCookies(finalRes.headers);
    await args.updateCookies(finalSetCookies, CHATGPT_URL);
    await args.saveFinalSessionCookies(args.email, finalSetCookies);
  };

  const commonAuthParams = new URLSearchParams({
    audience: "https://api.openai.com/v1",
    client_id: "app_X8zY6vW2pQ9tR3dE7nK1jL5gH",
    device_id: args.deviceId,
    "ext-oai-did": args.deviceId,
    login_hint: args.email,
    prompt: "login",
    redirect_uri: "https://chatgpt.com/api/auth/callback/openai",
    response_type: "code",
    scope:
      "openid email profile offline_access model.request model.read organization.read organization.write",
    screen_hint: "login_or_signup",
  });
  if (args.state) commonAuthParams.set("state", args.state);
  if (args.bootstrap.authSessionLoggingId) {
    commonAuthParams.set(
      "auth_session_logging_id",
      args.bootstrap.authSessionLoggingId,
    );
  }

  console.log(withActiveRunPrefix("[Step 10] firstauth..."));
  const firstAuthParams = new URLSearchParams(commonAuthParams);
  if (args.bootstrap.loginVerifier) {
    firstAuthParams.set("login_verifier", args.bootstrap.loginVerifier);
  } else {
    console.warn(withActiveRunPrefix("[Step 10] login_verifier missing, fallback to continue_url."));
  }

  const authHeaders = {
    Accept: NAVIGATE_ACCEPT,
    Referer: "https://auth.openai.com/about-you",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "same-origin",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
  };

  const firstAuthUrl = `${AUTH_URL}/api/oauth/oauth2/auth?${firstAuthParams.toString()}`;
  const firstAuthRes = await fetchWithTimeout(firstAuthUrl, {
    method: "GET",
    headers: await args.getHeaders(authHeaders, AUTH_URL),
    dispatcher: getActiveDispatcher(),
    redirect: "manual",
  });
  await args.updateCookies(getSetCookies(firstAuthRes.headers), AUTH_URL);
  const consentUrl = firstAuthRes.headers.get("location");
  if (!consentUrl) {
    if (args.bootstrap.continueUrl) {
      console.warn(
        withActiveRunPrefix("[Step 10] firstauth missing redirect location, fallback to continue_url."),
      );
      await finishWithFinalUrl(args.bootstrap.continueUrl);
      return;
    }
    throw new Error("firstauth missing redirect location");
  }

  console.log(withActiveRunPrefix("[Step 11] consent..."));
  const consentRes = await fetchWithTimeout(consentUrl, {
    method: "GET",
    headers: await args.getHeaders(authHeaders, AUTH_URL),
    dispatcher: getActiveDispatcher(),
    redirect: "manual",
  });
  await args.updateCookies(getSetCookies(consentRes.headers), AUTH_URL);
  const secondAuthUrl = consentRes.headers.get("location");
  if (!secondAuthUrl) {
    if (args.bootstrap.continueUrl) {
      console.warn(
        withActiveRunPrefix("[Step 11] consent missing redirect location, fallback to continue_url."),
      );
      await finishWithFinalUrl(args.bootstrap.continueUrl);
      return;
    }
    throw new Error("consent missing redirect location");
  }

  console.log(withActiveRunPrefix("[Step 12] secondauth..."));
  const secondAuthRes = await fetchWithTimeout(secondAuthUrl, {
    method: "GET",
    headers: await args.getHeaders(authHeaders, AUTH_URL),
    dispatcher: getActiveDispatcher(),
    redirect: "manual",
  });
  await args.updateCookies(getSetCookies(secondAuthRes.headers), AUTH_URL);
  const finalUrl = secondAuthRes.headers.get("location");
  if (!finalUrl) {
    if (args.bootstrap.continueUrl) {
      console.warn(
        withActiveRunPrefix("[Step 12] secondauth missing redirect location, fallback to continue_url."),
      );
      await finishWithFinalUrl(args.bootstrap.continueUrl);
      return;
    }
    throw new Error("secondauth missing redirect location");
  }

  await finishWithFinalUrl(finalUrl);
}
