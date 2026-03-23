import { writeFile } from "node:fs/promises"
import type { OAuthTokenResponse, PersistedTokens } from "../shared/types.ts"

export function toPersistedTokens(tokens: OAuthTokenResponse): PersistedTokens {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    expiresIn: Number.isFinite(tokens.expires_in) ? tokens.expires_in : null,
    scope: tokens.scope ?? null,
    tokenType: tokens.token_type ?? null,
    capturedAt: new Date().toISOString(),
  }
}

export async function saveTokensToFile(
  tokens: OAuthTokenResponse,
  filePath: string,
): Promise<void> {
  const output = toPersistedTokens(tokens)
  await writeFile(filePath, `${JSON.stringify(output, null, 2)}\n`, "utf8")
}
