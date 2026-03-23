export type CookieJarLike = {
  getCookieString: (url: string) => Promise<string>
  setCookie: (cookie: string, url: string) => Promise<unknown>
}

export type PkceAuthRequest = {
  authorizationUrl: string
  codeVerifier: string
  codeChallenge: string
  state: string
}

export type BuildAuthorizeUrlOptions = {
  clientId?: string
  redirectUri?: string
  scope?: string
  state: string
  codeChallenge: string
  codeChallengeMethod?: "S256"
  idTokenAddOrganizations?: boolean
  codexCliSimplifiedFlow?: boolean
  originator?: string
  responseType?: "code"
}

export type CreatePkceAuthRequestOptions = {
  clientId?: string
  redirectUri?: string
  scope?: string
  codeVerifier?: string
  state?: string
  originator?: string
  idTokenAddOrganizations?: boolean
  codexCliSimplifiedFlow?: boolean
}

export type ContinuePagePayload = {
  type?: string
  backstack_behavior?: string
  payload?: Record<string, unknown>
}

export type ContinueResponse = {
  continue_url?: string
  method?: string
  page?: ContinuePagePayload
  [key: string]: unknown
}

export type OAuthTokenResponse = {
  access_token: string
  expires_in: number
  id_token?: string
  refresh_token?: string
  scope?: string
  token_type?: string
  [key: string]: unknown
}

export type RefreshTokenRequest = {
  refreshToken: string
  clientId?: string
  scope?: string
}

export type CallbackResult = {
  callbackUrl: string
  code: string
  scope: string | null
  state: string | null
}

export type CodexAuthClientOptions = {
  baseUrl?: string
  userAgent?: string
  acceptLanguage?: string
  jar?: CookieJarLike
  debug?: boolean
}

export type SentinelReqResult = {
  status: number
  body: string
}

export type SentinelFlowPayload = {
  p: string
  id: string
  flow: string
}

export type SentinelTokenResult = {
  token: string
  p: string | null
}

export type Workspace = {
  id?: string
  name?: string | null
  kind?: string
  profile_picture_alt_text?: string
  [key: string]: unknown
}

export type AccountsCheckWorkspace = {
  workspaceId: string
  workspaceName: string | null
  planType: string | null
  expiresAt: string | null
}

export type PersistedTokens = {
  accessToken: string
  refreshToken: string | null
  expiresIn: number | null
  scope: string | null
  tokenType: string | null
  capturedAt: string
}

export type AccountsCheckNode = {
  account?: {
    account_id?: string | null
    plan_type?: string | null
    name?: string | null
    [key: string]: unknown
  }
  entitlement?: {
    expires_at?: string | null
    [key: string]: unknown
  }
  [key: string]: unknown
}

export type AccountsCheckResponse = {
  accounts?: Record<string, AccountsCheckNode>
  account_ordering?: string[]
  [key: string]: unknown
}
