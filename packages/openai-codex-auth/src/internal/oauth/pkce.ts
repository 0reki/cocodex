import {
  AUTH_BASE_URL,
  DEFAULT_CLIENT_ID,
  DEFAULT_ORIGINATOR,
  DEFAULT_REDIRECT_URI,
  DEFAULT_SCOPE,
  randomBuffer,
  sha256,
  toBase64Url,
} from "../shared/runtime.ts"
import type {
  BuildAuthorizeUrlOptions,
  CreatePkceAuthRequestOptions,
  PkceAuthRequest,
} from "../shared/types.ts"

export function generateCodeVerifier(bytes = 64): string {
  if (!Number.isInteger(bytes) || bytes < 32 || bytes > 96) {
    throw new Error("bytes must be an integer between 32 and 96")
  }
  const verifier = toBase64Url(randomBuffer(bytes))
  if (verifier.length < 43 || verifier.length > 128) {
    throw new Error("Generated code_verifier is out of RFC7636 bounds")
  }
  return verifier
}

export function generateCodeChallenge(codeVerifier: string): string {
  if (!codeVerifier || codeVerifier.length < 43 || codeVerifier.length > 128) {
    throw new Error("Invalid code_verifier length (expected 43-128)")
  }
  return toBase64Url(sha256(codeVerifier))
}

export function generateState(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 64) {
    throw new Error("state bytes must be an integer between 16 and 64")
  }
  return toBase64Url(randomBuffer(bytes))
}

export function buildAuthorizeUrl(options: BuildAuthorizeUrlOptions): string {
  const url = new URL("/oauth/authorize", AUTH_BASE_URL)
  url.searchParams.set("response_type", options.responseType ?? "code")
  url.searchParams.set("client_id", options.clientId ?? DEFAULT_CLIENT_ID)
  url.searchParams.set("redirect_uri", options.redirectUri ?? DEFAULT_REDIRECT_URI)
  url.searchParams.set("scope", options.scope ?? DEFAULT_SCOPE)
  url.searchParams.set("code_challenge", options.codeChallenge)
  url.searchParams.set(
    "code_challenge_method",
    options.codeChallengeMethod ?? "S256",
  )
  url.searchParams.set(
    "id_token_add_organizations",
    String(options.idTokenAddOrganizations ?? true),
  )
  url.searchParams.set(
    "codex_cli_simplified_flow",
    String(options.codexCliSimplifiedFlow ?? true),
  )
  url.searchParams.set("state", options.state)
  url.searchParams.set("originator", options.originator ?? DEFAULT_ORIGINATOR)
  return url.toString()
}

export function createPkceAuthRequest(
  options: CreatePkceAuthRequestOptions = {},
): PkceAuthRequest {
  const codeVerifier = options.codeVerifier ?? generateCodeVerifier()
  const state = options.state ?? generateState()
  const codeChallenge = generateCodeChallenge(codeVerifier)
  const authorizationUrl = buildAuthorizeUrl({
    clientId: options.clientId,
    redirectUri: options.redirectUri,
    scope: options.scope,
    state,
    codeChallenge,
    codeChallengeMethod: "S256",
    idTokenAddOrganizations: options.idTokenAddOrganizations,
    codexCliSimplifiedFlow: options.codexCliSimplifiedFlow,
    originator: options.originator,
  })

  return {
    authorizationUrl,
    codeVerifier,
    codeChallenge,
    state,
  }
}
