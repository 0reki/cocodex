import { ApiKeysEditor } from "@/features/api-keys/containers/api-keys-editor";
import { CopyButton } from "@/components/common/copy-button";
import { getServerTranslator } from "@/lib/i18n/i18n";
import { requireAuth } from "@/lib/auth/require-admin";
import { CodeTabs } from "@workspace/ui/components/animate-ui/components/animate/code-tabs";

function getApiBaseUrlFromEnv() {
  const candidates = [
    process.env.API_BASE_URL,
    process.env.NEXT_PUBLIC_API_BASE_URL,
    process.env.APP_BASE_URL,
    process.env.NEXT_PUBLIC_APP_URL,
  ];
  for (const value of candidates) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed.replace(/\/+$/, "");
  }
  return "";
}

export default async function ApiKeysPage() {
  await requireAuth("/keys");
  const { t } = await getServerTranslator();
  const baseUrl = getApiBaseUrlFromEnv();
  const displayBase = baseUrl || t("apiDocs.baseUrlMissing");
  const endpoint = baseUrl || "<API_ENDPOINT>";
  const responsesCurl = `curl ${baseUrl || "<BASE_URL>"}/v1/responses \\
  -H "Authorization: Bearer <YOUR_API_KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.2",
    "input": [
      {
        "type": "message",
        "role": "user",
        "content": [
          { "type": "input_text", "text": "Hello!" }
        ]
      }
    ],
    "store": false,
    "stream": true
  }'`;
  const responsesCompactCurl = `curl ${baseUrl || "<BASE_URL>"}/v1/responses/compact \\
  -H "Authorization: Bearer <YOUR_API_KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.2",
    "previous_response_id": "resp_123"
  }'`;
  const chatCurl = `curl ${baseUrl || "<BASE_URL>"}/v1/chat/completions \\
  -H "Authorization: Bearer <YOUR_API_KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.1",
    "messages": [
      { "role": "user", "content": "Hello!" }
    ],
    "stream": true
  }'`;
  const modelsCurl = `curl ${endpoint}/v1/models \\
  -H "Authorization: Bearer <YOUR_API_KEY>"`;
  const transcriptionsCurl = `curl ${endpoint}/v1/audio/transcriptions \\
  -H "Authorization: Bearer <YOUR_API_KEY>" \\
  -F "file=@./audio.m4a"`;
  const responsesTs = `const res = await fetch("${endpoint}/v1/responses", {
  method: "POST",
  headers: {
    "Authorization": "Bearer <YOUR_API_KEY>",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "gpt-5.2",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Hello!" }],
      },
    ],
    store: false,
    stream: true,
  }),
});

if (!res.ok) {
  throw new Error(\`HTTP \${res.status}\`);
}
`;
  const responsesCompactTs = `const res = await fetch("${endpoint}/v1/responses/compact", {
  method: "POST",
  headers: {
    "Authorization": "Bearer <YOUR_API_KEY>",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "gpt-5.2",
    previous_response_id: "resp_123",
  }),
});

if (!res.ok) {
  throw new Error(\`HTTP \${res.status}\`);
}

const data = await res.json();
console.log(data);`;
  const chatTs = `const res = await fetch("${endpoint}/v1/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": "Bearer <YOUR_API_KEY>",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "gpt-5.1",
    messages: [{ role: "user", content: "Hello!" }],
    stream: true,
  }),
});

if (!res.ok) {
  throw new Error(\`HTTP \${res.status}\`);
}
`;
  const modelsTs = `const res = await fetch("${endpoint}/v1/models", {
  headers: {
    "Authorization": "Bearer <YOUR_API_KEY>",
  },
});

if (!res.ok) {
  throw new Error(\`HTTP \${res.status}\`);
}

const data = await res.json();
console.log(data);`;
  const transcriptionsTs = `const form = new FormData();
form.append("file", new Blob([audioBytes], { type: "audio/m4a" }), "audio.m4a");

const res = await fetch("${endpoint}/v1/audio/transcriptions", {
  method: "POST",
  headers: {
    "Authorization": "Bearer <YOUR_API_KEY>",
  },
  body: form,
});

if (!res.ok) {
  throw new Error(\`HTTP \${res.status}\`);
}

const data = await res.json();
console.log(data.text);`;
  const codexConfigToml = `model = "gpt-5.4" # Your OWN MODEL CONFIG
model_reasoning_effort = "medium" # Your OWN MODEL CONFIG

model_provider = "cocodex"
preferred_auth_method = "apikey"

personality = "pragmatic" # Your OWN PERSONALITY CONFIG

[features]
fast_mode = true
responses_websockets_v2 = true

[model_providers.cocodex]
name = "OpenAI"
base_url = "https://api.cocodex.app/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = true

suppress_unstable_features_warning = true`;
  const codexAuthJson = `{
  "OPENAI_API_KEY": "<YOUR_API_KEY>"
}`;

  return (
    <main className="flex w-full flex-col gap-6 px-3 py-3 sm:px-4 sm:py-4 lg:px-5">
      <section>
        <h1 className="text-2xl font-bold">{t("page.apiKeys")}</h1>
      </section>
      <ApiKeysEditor />
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t("apiDocs.title")}</h2>
        <div className="flex items-center gap-1.5 text-sm">
          <span className="font-medium">{t("apiDocs.apiEndpoint")}: </span>
          <code className="rounded bg-muted px-1.5 py-0.5">{displayBase}</code>
          <CopyButton text={baseUrl || ""} label={t("common.copy")} />
        </div>
        <div className="space-y-2">
          <div className="text-sm font-medium">
            {t("apiDocs.codexConfigTitle")}
          </div>
          <CodeTabs
            codes={{
              "config.toml": codexConfigToml,
              "auth.json": codexAuthJson,
            }}
            langs={{
              "config.toml": "toml",
              "auth.json": "json",
            }}
          />
        </div>
        <div className="space-y-2">
          <div className="text-sm font-medium">
            {t("apiDocs.responsesExample")}
          </div>
          <CodeTabs
            codes={{
              HTTP: responsesCurl,
              TypeScript: responsesTs,
            }}
            lang="bash"
          />
        </div>
        <div className="space-y-2">
          <div className="text-sm font-medium">
            {t("apiDocs.responsesCompactExample")}
          </div>
          <CodeTabs
            codes={{
              HTTP: responsesCompactCurl,
              TypeScript: responsesCompactTs,
            }}
            lang="bash"
          />
        </div>
        <div className="space-y-2">
          <div className="text-sm font-medium">{t("apiDocs.chatExample")}</div>
          <CodeTabs
            codes={{
              HTTP: chatCurl,
              TypeScript: chatTs,
            }}
            lang="bash"
          />
        </div>
        <div className="space-y-2">
          <div className="text-sm font-medium">
            {t("apiDocs.modelsExample")}
          </div>
          <CodeTabs
            codes={{
              HTTP: modelsCurl,
              TypeScript: modelsTs,
            }}
            lang="bash"
          />
        </div>
        <div className="space-y-2">
          <div className="text-sm font-medium">
            {t("apiDocs.audioTranscriptionsExample")}
          </div>
          <CodeTabs
            codes={{
              HTTP: transcriptionsCurl,
              TypeScript: transcriptionsTs,
            }}
            lang="bash"
          />
        </div>
      </section>
    </main>
  );
}
