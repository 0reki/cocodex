import { createCodexClientSessionStore } from "../src/server/services/auth/codex-client-session.ts";

function decodeJwt(token) {
  const [header, payload, signature] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString()),
    payload: JSON.parse(Buffer.from(payload, "base64url").toString()),
    signature,
  };
}

const sessions = createCodexClientSessionStore({});
const tokens = await sessions.issueTokens(
  "663079f5-960c-4e61-b649-4a5b39bcf830",
  "kk@openai.com",
);
const authJson = {
  auth_mode: "chatgpt",
  tokens: {
    id_token: tokens.id_token,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    account_id: tokens.account_id,
  },
  last_refresh: new Date().toISOString(),
};

console.log("=== /oauth/token 响应 ===");
console.log(JSON.stringify(tokens, null, 2));
console.log("\n=== Codex 落盘的 auth.json ===");
console.log(JSON.stringify(authJson, null, 2));
console.log("\n=== id_token ===");
console.log(JSON.stringify(decodeJwt(tokens.id_token), null, 2));
console.log("\n=== access_token ===");
console.log(JSON.stringify(decodeJwt(tokens.access_token), null, 2));
