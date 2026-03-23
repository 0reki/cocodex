# @workspace/openai-signup

Signup flow SDK copied from `creation/` and adapted for package usage.

## Usage

```ts
import { runSignupFlow } from "@workspace/openai-signup"

const result = await runSignupFlow()
if (result.ok) {
  console.log(result.email)
  console.log(result.sessionResult?.session_cookies)
  console.log(result.account?.accessToken)
}
```

## Output behavior

- No `results/*.json` file is required.
- After signup completes, SDK automatically:
1. gets `accessToken` from `/api/auth/session` first
2. updates latest `sessionToken` from response cookies
3. fetches workspace info (`accounts/check/v4-2023-04-27`)
4. fetches user profile (`/backend-api/me`)
- `refreshToken` is always `null` (not used).
