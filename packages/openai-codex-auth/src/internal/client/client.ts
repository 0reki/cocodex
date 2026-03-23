import { setupSentinelEnv } from "@workspace/openai-signup/env"
import { fetchSentinelSdkDynamic } from "@workspace/openai-signup/sdk"
import { fetchWithTimeout as signupFetchWithTimeout } from "@workspace/openai-signup/internal/shared/runtime"
import {
  Agent,
  AUTH_BASE_URL,
  CHATGPT_BASE_URL,
  CookieJar,
  DEFAULT_USER_AGENT,
  SENTINEL_BASE_URL,
  describeFetchError,
  getSetCookies,
  headersInitToRecord,
  randomHex,
  randomUuid,
} from "../shared/runtime.ts"
import {
  authorizeContinue,
  exchangeToken,
  getAccountsCheckV4Raw,
  getAccountsCheckV4RawText,
  getChatgptSession,
  getMeRaw,
  getSubscriptionRaw,
  initializeAuthorizeSession,
  refreshAccessToken,
  resolveCallbackFromExternalUrl,
  selectWorkspace,
  sendPasswordlessOtp,
  validateEmailOtp,
  verifyPassword,
  visitPage,
} from "./http.ts"
import {
  extractWorkspacesFromAuthSessionCookieValue,
  getCookieValue,
  listCookieNames,
  mapAccountsCheckPayloadToWorkspaces,
  seedCookiesFromHeader,
  selectPreferredWorkspaceId,
  updateCookies,
} from "./helpers.ts"
import type {
  AccountsCheckResponse,
  AccountsCheckWorkspace,
  CallbackResult,
  CodexAuthClientOptions,
  ContinueResponse,
  CookieJarLike,
  OAuthTokenResponse,
  RefreshTokenRequest,
  SentinelFlowPayload,
  SentinelReqResult,
  SentinelTokenResult,
  Workspace,
} from "../shared/types.ts"

export class CodexAuthClient {
  private readonly baseUrl: string
  private readonly userAgent: string
  private readonly acceptLanguage: string
  private readonly jar: CookieJarLike
  private readonly debug: boolean
  private stableSentinelP: string | null = null

  constructor(options: CodexAuthClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? AUTH_BASE_URL
    this.userAgent =
      options.userAgent ??
      process.env.CODEX_AUTH_USER_AGENT?.trim() ??
      DEFAULT_USER_AGENT
    this.acceptLanguage = options.acceptLanguage ?? "zh-CN,zh;q=0.9"
    this.jar = options.jar ?? new CookieJar()
    this.debug = options.debug ?? process.env.CODEX_AUTH_DEBUG === "1"
  }

  private getFetchContext() {
    return {
      baseUrl: this.baseUrl,
      userAgent: this.userAgent,
      acceptLanguage: this.acceptLanguage,
      debug: this.debug,
      getCookieString: (url: string) => this.jar.getCookieString(url),
      updateCookies: (setCookie: string[] | string | null, currentUrl: string) =>
        this.updateCookies(setCookie, currentUrl),
    }
  }

  getCookieJar(): CookieJarLike {
    return this.jar
  }

  async debugCookieNames(): Promise<string[]> {
    const cookieString = await this.jar.getCookieString(this.baseUrl)
    return listCookieNames(cookieString)
  }

  async seedCookiesFromHeader(cookieHeader: string, url = this.baseUrl): Promise<void> {
    await seedCookiesFromHeader(this.jar, cookieHeader, url)
  }

  private async syncDidCookies(deviceId: string): Promise<void> {
    const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toUTCString()
    await this.jar.setCookie(
      `oai-did=${deviceId}; Domain=.chatgpt.com; Path=/; Expires=${expires}; Secure; HttpOnly`,
      CHATGPT_BASE_URL,
    )
    await this.jar.setCookie(
      `oai-did=${deviceId}; Domain=.openai.com; Path=/; Expires=${expires}; Secure; HttpOnly`,
      AUTH_BASE_URL,
    )
    await this.jar.setCookie(
      `oai-did=${deviceId}; Domain=.openai.com; Path=/; Expires=${expires}; Secure; HttpOnly`,
      SENTINEL_BASE_URL,
    )
  }

  private async getCookieValue(url: string, name: string): Promise<string | null> {
    return getCookieValue(this.jar, url, name)
  }

  private async getOrCreateDeviceId(): Promise<string> {
    const existing =
      (await this.getCookieValue(AUTH_BASE_URL, "oai-did")) ??
      (await this.getCookieValue(SENTINEL_BASE_URL, "oai-did")) ??
      (await this.getCookieValue(CHATGPT_BASE_URL, "oai-did"))
    const did = existing ?? randomUuid()
    await this.syncDidCookies(did)
    return did
  }

  private getBuildId(): string {
    return randomHex(6)
  }

  private async updateCookies(setCookie: string[] | string | null, currentUrl: string) {
    await updateCookies(this.jar, setCookie, currentUrl)
  }

  private async getHeaders(
    extra: Record<string, string> = {},
    url: string = AUTH_BASE_URL,
  ): Promise<Record<string, string>> {
    const cookie = await this.jar.getCookieString(url)
    const target = new URL(url)
    const domain = target.hostname
    return {
      Host: domain,
      Connection: "keep-alive",
      "User-Agent": this.userAgent,
      Accept: "*/*",
      "Accept-Language": this.acceptLanguage,
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "sec-ch-ua": '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": domain === "chatgpt.com" ? "same-origin" : "cross-site",
      Origin: target.origin,
      Referer: `${AUTH_BASE_URL}/`,
      Cookie: cookie,
      ...extra,
    }
  }

  private normalizeSentinelTokenWithStableP(token: string): SentinelTokenResult {
    try {
      const parsed = JSON.parse(token)
      const currentP = typeof parsed?.p === "string" ? parsed.p : null
      if (!currentP) return { token, p: null }

      if (!this.stableSentinelP) {
        this.stableSentinelP = currentP
        return { token, p: currentP }
      }

      if (this.stableSentinelP === currentP) {
        return { token, p: currentP }
      }

      parsed.p = this.stableSentinelP
      return { token: JSON.stringify(parsed), p: this.stableSentinelP }
    } catch {
      return { token, p: null }
    }
  }

  private withSentinelEnv<T>(setup: () => void, run: () => Promise<T>): Promise<T> {
    const globalAny = globalThis as Record<string, unknown>
    const keys = [
      "window",
      "self",
      "top",
      "parent",
      "document",
      "location",
      "navigator",
      "performance",
      "screen",
      "history",
      "localStorage",
      "sessionStorage",
      "crypto",
      "TextEncoder",
      "TextDecoder",
      "btoa",
      "atob",
      "fetch",
      "XMLHttpRequest",
      "Headers",
      "Request",
      "Response",
      "URL",
      "URLSearchParams",
      "requestIdleCallback",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "HTMLElement",
      "HTMLIFrameElement",
      "HTMLScriptElement",
      "HTMLCanvasElement",
      "Element",
      "Node",
      "NodeList",
      "Event",
      "CustomEvent",
      "MessageEvent",
      "ErrorEvent",
      "MutationObserver",
      "IntersectionObserver",
      "ResizeObserver",
      "FormData",
      "Blob",
      "File",
      "FileReader",
      "AbortController",
      "AbortSignal",
      "DOMParser",
      "getComputedStyle",
      "PerformanceEntry",
      "WritableStreamDefaultController",
      "chrome",
      "addEventListener",
      "removeEventListener",
      "dispatchEvent",
      "postMessage",
      "__msgListeners",
    ] as const

    const saved = new Map<string, PropertyDescriptor | null>()
    for (const key of keys) {
      saved.set(key, Object.getOwnPropertyDescriptor(globalAny, key) ?? null)
    }
    const originalStringSearch = String.prototype.search

    const restore = () => {
      String.prototype.search = originalStringSearch
      for (const [key, desc] of saved.entries()) {
        if (desc) {
          Object.defineProperty(globalAny, key, desc)
        } else {
          delete globalAny[key]
        }
      }
    }

    setup()
    return run().finally(restore)
  }

  async getSentinelToken(flow: string): Promise<SentinelTokenResult> {
    const did = await this.getOrCreateDeviceId()
    const dispatcher = new Agent()
    const nativeFetch = globalThis.fetch.bind(globalThis)
    const sentinelTimeoutMs = Number(
      process.env.CODEX_AUTH_SENTINEL_TIMEOUT_MS ??
        process.env.CODEX_AUTH_REQUEST_TIMEOUT_MS ??
        20_000,
    )
    const withTimeout = async <T>(label: string, run: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | null = null
      try {
        return await Promise.race([
          run,
          new Promise<T>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`Sentinel ${label} timed out after ${sentinelTimeoutMs}ms`))
            }, sentinelTimeoutMs)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    const customFetch = async (url: string, init?: RequestInit) => {
      const target = typeof url === "string" ? url : String(url)
      const baseHeaders = await this.getHeaders({}, target)
      const mergedHeaders: Record<string, string> = {
        ...baseHeaders,
        ...headersInitToRecord(init?.headers),
      }
      if (target.startsWith("https://sentinel.openai.com/")) {
        mergedHeaders["accept-encoding"] = "identity"
      }
      const useNativeBunFetch =
        typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" &&
        target.startsWith("https://sentinel.openai.com/")
      let res: Awaited<ReturnType<typeof signupFetchWithTimeout>> | Response
      try {
        if (useNativeBunFetch) {
          res = await Promise.race([
            nativeFetch(target, {
              ...(init as any),
              headers: mergedHeaders,
            } as any),
            new Promise<Response>((_, reject) => {
              setTimeout(() => {
                reject(new Error(`Bun sentinel fetch timed out after ${sentinelTimeoutMs}ms`))
              }, sentinelTimeoutMs)
            }),
          ])
        } else {
          res = await signupFetchWithTimeout(
            target,
            {
              ...(init as any),
              headers: mergedHeaders,
              dispatcher,
            } as any,
            sentinelTimeoutMs,
          )
        }
      } catch (error) {
        throw describeFetchError(error, target)
      }
      await this.updateCookies(getSetCookies(res.headers), target)
      return res
    }

    const { sdkJs } = await withTimeout(
      "sdk bootstrap",
      fetchSentinelSdkDynamic({
        sentinelUrl: SENTINEL_BASE_URL,
        authUrl: AUTH_BASE_URL,
        getHeaders: this.getHeaders.bind(this),
        updateCookies: this.updateCookies.bind(this),
        dispatcher,
      }),
    )

    const closeDispatcherIfNeeded = async () => {
      const maybe = dispatcher as unknown as { close?: () => Promise<void> | void }
      if (typeof maybe.close === "function") {
        await maybe.close()
      }
    }

    try {
      return await this.withSentinelEnv(
        () =>
          setupSentinelEnv({
            userAgent: this.userAgent,
            buildId: this.getBuildId(),
            oaiDid: did,
            origin: CHATGPT_BASE_URL,
            customFetch,
        }),
        async () => {
          const runSdk = new Function(`${sdkJs}; return SentinelSDK;`)
          const SentinelSDK = runSdk()
          await withTimeout("sdk init", SentinelSDK.init(flow))
          const rawToken = await withTimeout("sdk token", SentinelSDK.token(flow))
          if (typeof rawToken !== "string") {
            throw new Error("Sentinel returned non-string token")
          }
          return this.normalizeSentinelTokenWithStableP(rawToken)
        },
      )
    } finally {
      await closeDispatcherIfNeeded()
    }
  }

  async sendSentinelReq(payload: string): Promise<SentinelReqResult> {
    const url = "https://sentinel.openai.com/backend-api/sentinel/req"
    const headers = new Headers({
      Accept: "*/*",
      "Content-Type": "text/plain;charset=UTF-8",
      "Accept-Language": this.acceptLanguage,
      Origin: new URL(url).origin,
      Referer: `${AUTH_BASE_URL}/`,
      "User-Agent": this.userAgent,
    })

    const cookie = await this.jar.getCookieString(url)
    if (cookie) headers.set("Cookie", cookie)

    if (this.debug) {
      console.log(`[codex-auth] POST ${url}`)
      console.log(`[codex-auth] request_body=${payload}`)
    }

    const requestHeaders = headersInitToRecord(headers)
    let res: Response
    try {
      res = await fetch(url, {
        method: "POST",
        headers: requestHeaders,
        body: payload,
        redirect: "manual",
      })
    } catch (error) {
      throw describeFetchError(error, url)
    }

    const setCookies = getSetCookies(res.headers)
    for (const setCookie of setCookies) {
      await this.jar.setCookie(setCookie, url)
    }

    const text = await res.text()
    if (this.debug) {
      console.log(`[codex-auth] response_status=${res.status}`)
    }

    return {
      status: res.status,
      body: text,
    }
  }

  async sendSentinelFlowReq(payload: SentinelFlowPayload): Promise<SentinelReqResult> {
    return this.sendSentinelReq(JSON.stringify(payload))
  }

  async initializeAuthorizeSession(
    authorizationUrl: string,
    options: { maxRedirects?: number } = {},
  ): Promise<string> {
    return initializeAuthorizeSession(this.getFetchContext(), authorizationUrl, options)
  }

  async authorizeContinue(params: {
    email: string
    sentinelToken?: string
  }): Promise<ContinueResponse> {
    return authorizeContinue(this.getFetchContext(), params)
  }

  async verifyPassword(
    password: string,
    options: { referer?: string; sentinelToken?: string } = {},
  ): Promise<ContinueResponse> {
    return verifyPassword(this.getFetchContext(), password, options)
  }

  async visitPage(urlOrPath: string): Promise<void> {
    return visitPage(this.getFetchContext(), urlOrPath)
  }

  async sendPasswordlessOtp(options: { referer?: string } = {}): Promise<ContinueResponse> {
    return sendPasswordlessOtp(this.getFetchContext(), options)
  }

  async validateEmailOtp(
    code: string,
    options: { referer?: string } = {},
  ): Promise<ContinueResponse> {
    return validateEmailOtp(this.getFetchContext(), code, options)
  }

  async selectWorkspace(workspaceId: string): Promise<ContinueResponse> {
    return selectWorkspace(this.getFetchContext(), workspaceId)
  }

  async resolveCallbackFromExternalUrl(
    externalUrl: string,
    options: { expectedState?: string; maxRedirects?: number } = {},
  ): Promise<CallbackResult> {
    return resolveCallbackFromExternalUrl(this.getFetchContext(), externalUrl, options)
  }

  async exchangeToken(params: {
    code: string
    codeVerifier: string
    clientId?: string
    redirectUri?: string
  }): Promise<OAuthTokenResponse> {
    return exchangeToken(this.getFetchContext(), params)
  }

  async refreshAccessToken(params: RefreshTokenRequest): Promise<OAuthTokenResponse> {
    return refreshAccessToken(this.getFetchContext(), params)
  }

  async getChatgptSession(): Promise<Record<string, unknown>> {
    return getChatgptSession(this.getFetchContext())
  }

  async getChatgptAccessToken(): Promise<string> {
    const session = await this.getChatgptSession()
    const value = session.accessToken
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("Missing accessToken from chatgpt session")
    }
    return value.trim()
  }

  async getAccountsCheckWorkspaces(
    options: { accessToken?: string; timezoneOffsetMin?: number } = {},
  ): Promise<AccountsCheckWorkspace[]> {
    const payload = await this.getAccountsCheckV4Raw(options)
    return mapAccountsCheckPayloadToWorkspaces(payload)
  }

  getAccountsCheckWorkspacesFromRaw(
    payload: AccountsCheckResponse,
  ): AccountsCheckWorkspace[] {
    return mapAccountsCheckPayloadToWorkspaces(payload)
  }

  async getAccountsCheckV4Raw(
    options: { accessToken?: string; timezoneOffsetMin?: number } = {},
  ): Promise<AccountsCheckResponse> {
    return getAccountsCheckV4Raw(
      this.getFetchContext(),
      () => this.getChatgptAccessToken(),
      options,
    )
  }

  async getAccountsCheckV4RawText(
    options: { accessToken?: string; timezoneOffsetMin?: number } = {},
  ): Promise<{ status: number; body: string }> {
    return getAccountsCheckV4RawText(
      this.getFetchContext(),
      () => this.getChatgptAccessToken(),
      options,
    )
  }

  async getMeRaw(options: {
    accessToken: string
    accountId: string
  }): Promise<Record<string, unknown>> {
    return getMeRaw(this.getFetchContext(), options)
  }

  async getSubscriptionRaw(options: {
    accessToken: string
    accountId: string
  }): Promise<Record<string, unknown>> {
    return getSubscriptionRaw(this.getFetchContext(), options)
  }

  selectPreferredWorkspaceId(workspaces: AccountsCheckWorkspace[]): string | null {
    return selectPreferredWorkspaceId(workspaces)
  }

  async resolvePreferredWorkspaceIdBeforeConsent(
    options: { accessToken?: string; timezoneOffsetMin?: number } = {},
  ): Promise<string> {
    const workspaces = await this.getAccountsCheckWorkspaces(options)
    const preferred = this.selectPreferredWorkspaceId(workspaces)
    if (!preferred) {
      throw new Error("No workspace found from accounts/check")
    }
    return preferred
  }

  async extractWorkspacesFromAuthSessionCookie(): Promise<Workspace[]> {
    const cookieString = await this.jar.getCookieString(this.baseUrl)
    return extractWorkspacesFromAuthSessionCookieValue(cookieString)
  }
}
