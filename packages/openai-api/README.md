# @workspace/openai-api

Utilities for calling OpenAI web session endpoints.

## Get access token from next-auth session cookie

```ts
import { getAccessToken } from "@workspace/openai-api";

const { accessToken, session, setCookies, sessionTokenCookies } =
  await getAccessToken({
    sessionToken: "<__Secure-next-auth.session-token>",
    userAgent: "node-ua",
  });
```

If response headers return updated next-auth cookies, they are included in:

- `setCookies`
- `sessionTokenCookies` (only `__Secure-next-auth.session-token*`)

You can also pass chunked cookies:

```ts
await getAccessToken({
  sessionTokenChunks: ["chunk0", "chunk1"],
});
```

Or provide full cookie header directly:

```ts
await getAccessToken({
  cookieHeader: "__Secure-next-auth.session-token=...",
});
```

## Accounts check (Bearer access token)

```ts
import {
  extractPrimaryAccountInfo,
  getAccountsCheckV4,
} from "@workspace/openai-api";

const data = await getAccountsCheckV4({
  accessToken: "<accessToken>",
  timezoneOffsetMin: -480,
  userAgent: "node-ua",
});

const primary = extractPrimaryAccountInfo(data);
```

## Get user profile (`/backend-api/me`)

```ts
import { getMe } from "@workspace/openai-api";

const me = await getMe({
  accessToken: "<accessToken>",
  accountId: "<chatgpt-account-id>",
  userAgent: "node-ua",
});
```

## Get Codex models (`/backend-api/codex/models`)

```ts
import { getCodexModels } from "@workspace/openai-api";

const models = await getCodexModels({
  accessToken: "<accessToken>",
  clientVersion: "0.98.0",
  userAgent: "node-ua",
});
```

## Get usage (`/backend-api/wham/usage`)

```ts
import { getWhamUsage } from "@workspace/openai-api";

const usage = await getWhamUsage({
  accessToken: "<accessToken>",
  accountId: "<chatgpt-account-id>",
  userAgent: "node-ua",
});
```

## Create Codex response stream (`/backend-api/codex/responses`)

```ts
import { parseSseEvents, postCodexResponses } from "@workspace/openai-api";

const response = await postCodexResponses({
  accessToken: "<accessToken>",
  version: "0.98.0",
  sessionId: crypto.randomUUID(),
  userAgent: "node-ua",
  payload: {
    model: "gpt-5.3-codex",
    instructions: "",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "What model are you?" }],
      },
    ],
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: false,
    reasoning: { effort: "medium", summary: "auto" },
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: crypto.randomUUID(),
  },
});

for await (const event of parseSseEvents(response)) {
  console.log(event.event, event.data);
}
```

`payload` will be sent as-is without package-side mutation.
