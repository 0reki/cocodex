import crypto from "node:crypto"
import zlib from "node:zlib"

export type MessageTranslationMap<Locale extends string = string> = Partial<
  Record<
    Locale,
    {
      title?: string
      body?: string
    }
  >
>

export type TranslationAccount = {
  id: string
  accessToken: string
}

const DEFAULT_CODEX_ORIGINATOR = "codex_cli_rs"
const DEFAULT_CODEX_SANDBOX = "windows_elevated"
const CHATGPT_CODEX_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses"

function describeLocale(locale: string): string {
  switch (locale) {
    case "zh-CN":
      return "Simplified Chinese"
    case "zh-HK":
      return "Traditional Chinese (Hong Kong)"
    case "zh-MO":
      return "Traditional Chinese (Macau)"
    case "zh-TW":
      return "Traditional Chinese (Taiwan)"
    case "ja-JP":
      return "Japanese"
    case "ko-KR":
      return "Korean"
    case "fr-FR":
      return "French"
    case "de-DE":
      return "German"
    case "es-ES":
      return "Spanish"
    case "it-IT":
      return "Italian"
    case "pt-BR":
      return "Portuguese (Brazil)"
    case "ru-RU":
      return "Russian"
    case "tr-TR":
      return "Turkish"
    default:
      return "English"
  }
}

function hasTargetScriptText(locale: string, text: string): boolean {
  switch (locale) {
    case "zh-CN":
    case "zh-HK":
    case "zh-MO":
    case "zh-TW":
      return /[\u3400-\u9fff\uf900-\ufaff]/.test(text)
    case "ja-JP":
      return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/.test(text)
    case "ko-KR":
      return /[\uac00-\ud7af]/.test(text)
    case "ru-RU":
      return /[\u0400-\u04ff]/.test(text)
    default:
      return true
  }
}

function looksObviouslyUntranslated(args: {
  locale: string
  sourceTitle: string
  sourceBody: string
  translatedTitle?: string
  translatedBody?: string
}) {
  if (args.locale === "en-US") return false
  const sourceCombined = `${args.sourceTitle}\n${args.sourceBody}`.trim()
  const translatedCombined =
    `${args.translatedTitle ?? ""}\n${args.translatedBody ?? ""}`.trim()
  if (!sourceCombined || !translatedCombined) return false
  const sourceHasAsciiWords = /[A-Za-z]{3,}/.test(sourceCombined)
  const sourceHasNoCjk = !/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/.test(
    sourceCombined,
  )
  const translatedHasAsciiWords = /[A-Za-z]{3,}/.test(translatedCombined)
  const translatedHasTargetScript = hasTargetScriptText(
    args.locale,
    translatedCombined,
  )
  if (
    sourceHasAsciiWords &&
    sourceHasNoCjk &&
    translatedHasAsciiWords &&
    !translatedHasTargetScript
  ) {
    return true
  }
  return (
    sourceHasAsciiWords &&
    sourceHasNoCjk &&
    sourceCombined === translatedCombined
  )
}

export function isAiTranslatedResult(args: {
  locale: string
  sourceTitle: string
  sourceBody: string
  translatedTitle: string
  translatedBody: string
}) {
  if (args.locale === "en-US") {
    return false
  }
  return !looksObviouslyUntranslated({
    locale: args.locale,
    sourceTitle: args.sourceTitle,
    sourceBody: args.sourceBody,
    translatedTitle: args.translatedTitle,
    translatedBody: args.translatedBody,
  })
}

function normalizeCodexVersion(version: string): string {
  const trimmed = version.trim()
  if (!trimmed) return trimmed
  if (/-((alpha|beta|rc)([.-]|$))/i.test(trimmed)) {
    return trimmed
  }
  return `${trimmed}-alpha.10`
}

function buildCodexTurnMetadataHeader(sandbox = DEFAULT_CODEX_SANDBOX): string {
  return JSON.stringify({
    turn_id: crypto.randomUUID(),
    sandbox,
  })
}

function zstdCompressBuffer(buffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zlib.zstdCompress(buffer, (error, result) => {
      if (error) {
        reject(error)
        return
      }
      resolve(Buffer.isBuffer(result) ? result : Buffer.from(result))
    })
  })
}

async function assembleResponseFromEventStream(
  response: Response,
): Promise<Record<string, unknown>> {
  if (!response.body) {
    throw new Error("Upstream responses stream body is empty")
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let currentEvent: string | null = null
  let currentDataLines: string[] = []
  let completedResponse: Record<string, unknown> | null = null
  let latestResponse: Record<string, unknown> | null = null
  let streamError: Record<string, unknown> | null = null

  const flushFrame = () => {
    if (currentEvent == null && currentDataLines.length === 0) return
    const eventName = currentEvent ?? "message"
    const data = currentDataLines.join("\n").trim()
    currentEvent = null
    currentDataLines = []
    if (!data || data === "[DONE]") return

    let parsed: Record<string, unknown> | null = null
    try {
      parsed = JSON.parse(data) as Record<string, unknown>
    } catch {
      return
    }
    if (!parsed) return

    if (parsed.object === "response") {
      latestResponse = parsed
    }
    if (parsed.response && typeof parsed.response === "object") {
      latestResponse = parsed.response as Record<string, unknown>
    }

    const type =
      typeof parsed.type === "string" ? parsed.type : eventName
    if (
      type === "response.completed" &&
      parsed.response &&
      typeof parsed.response === "object"
    ) {
      completedResponse = parsed.response as Record<string, unknown>
      return
    }
    if (
      type === "error" ||
      type === "response.error" ||
      type === "response.failed"
    ) {
      streamError = parsed
    } else if (parsed.error && typeof parsed.error === "object") {
      streamError = parsed.error as Record<string, unknown>
    }
  }

  while (completedResponse == null) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    while (true) {
      const lineBreakIndex = buffer.indexOf("\n")
      if (lineBreakIndex === -1) break
      const rawLine = buffer.slice(0, lineBreakIndex)
      buffer = buffer.slice(lineBreakIndex + 1)
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine

      if (line.startsWith("event:")) {
        currentEvent = line.slice("event:".length).trim()
        continue
      }
      if (line.startsWith("data:")) {
        currentDataLines.push(line.slice("data:".length).trim())
        continue
      }
      if (line.trim() === "") {
        flushFrame()
        if (completedResponse) break
      }
    }
  }

  if (buffer.trim()) {
    const trailing = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer
    if (trailing.startsWith("event:")) {
      currentEvent = trailing.slice("event:".length).trim()
    } else if (trailing.startsWith("data:")) {
      currentDataLines.push(trailing.slice("data:".length).trim())
    }
  }
  flushFrame()
  reader.releaseLock()

  if (completedResponse) return completedResponse
  if (latestResponse) return latestResponse
  if (streamError) {
    throw new Error(JSON.stringify(streamError))
  }
  throw new Error("Failed to assemble response from upstream stream")
}

async function postCodexResponsesDirect(args: {
  accessToken: string
  version: string
  userAgent: string
  sessionId: string
  payload: Record<string, unknown>
}): Promise<Record<string, unknown>> {
  const basePayload = args.payload
  const payload: Record<string, unknown> = {
    ...basePayload,
    stream: true,
    store: false,
    instructions:
      basePayload.instructions === undefined || basePayload.instructions === null
        ? ""
        : basePayload.instructions,
  }
  if (typeof payload.input === "string") {
    payload.input = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: payload.input }],
      },
    ]
  }
  const compressedBody = await zstdCompressBuffer(
    Buffer.from(JSON.stringify(payload), "utf8"),
  )
  const compressedArrayBuffer = Uint8Array.from(compressedBody).buffer

  const res = await fetch(CHATGPT_CODEX_RESPONSES_URL, {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "Content-Encoding": "zstd",
      Authorization: `Bearer ${args.accessToken.trim()}`,
      originator: DEFAULT_CODEX_ORIGINATOR,
      session_id: args.sessionId.trim(),
      version: normalizeCodexVersion(args.version),
      "x-codex-turn-metadata": buildCodexTurnMetadataHeader(),
      "x-oai-web-search-eligible": "true",
      "User-Agent": args.userAgent,
    },
    body: compressedArrayBuffer,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(
      `/backend-api/codex/responses HTTP ${res.status}: ${text.slice(0, 500)}`,
    )
  }
  return assembleResponseFromEventStream(res)
}

function extractResponseOutputText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return ""
  const response = payload as Record<string, unknown>
  const output = Array.isArray(response.output) ? response.output : []
  let text = ""
  for (const item of output) {
    if (!item || typeof item !== "object") continue
    const content = Array.isArray((item as Record<string, unknown>).content)
      ? ((item as Record<string, unknown>).content as unknown[])
      : []
    for (const part of content) {
      if (!part || typeof part !== "object") continue
      const partRecord = part as Record<string, unknown>
      if (
        partRecord.type === "output_text" &&
        typeof partRecord.text === "string"
      ) {
        text += partRecord.text
      }
    }
  }
  return text.trim()
}

function parseTranslationJson<Locale extends string>(
  text: string,
): MessageTranslationMap<Locale> {
  const normalized = text.trim()
  if (!normalized) {
    throw new Error("Translation model returned empty response")
  }
  const fenced = normalized.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1]?.trim() || normalized
  const parsed = JSON.parse(candidate) as Record<string, unknown>
  const translations =
    parsed.translations && typeof parsed.translations === "object"
      ? (parsed.translations as Record<string, unknown>)
      : parsed
  const result: MessageTranslationMap<Locale> = {}
  for (const [locale, value] of Object.entries(translations)) {
    if (!value || typeof value !== "object") continue
    const record = value as Record<string, unknown>
    result[locale as Locale] = {
      title:
        typeof record.title === "string" && record.title.trim()
          ? record.title.trim()
          : undefined,
      body:
        typeof record.body === "string" && record.body.trim()
          ? record.body.trim()
          : undefined,
    }
  }
  return result
}

async function translateMessageByLocale<Locale extends string>(args: {
  title: string
  body: string
  locale: Locale
  model: string
  accessToken: string
  userAgent: string
  clientVersion: string
}): Promise<MessageTranslationMap<Locale>> {
  const prompt = [
    "Translate the following inbox message into the requested locale.",
    "Detect the source language automatically from the message content.",
    `Target locale: ${args.locale}`,
    `Target language: ${describeLocale(args.locale)}`,
    "Translate all user-visible text into the target language.",
    "Do not leave the original English unchanged unless the text is a proper noun, product name, code snippet, or URL.",
    "Return valid JSON only.",
    'Format: {"translations":{"<locale>":{"title":"...","body":"..."}}}',
    "The target locale key must appear exactly once in translations.",
    "Keep the meaning, tone, and formatting faithful to the original.",
    "Do not add explanations, markdown, comments, or code fences.",
    "",
    `Locales: ${args.locale}`,
    "",
    "Original title:",
    args.title,
    "",
    "Original body:",
    args.body,
  ].join("\n")

  const payload = await postCodexResponsesDirect({
    accessToken: args.accessToken,
    version: args.clientVersion,
    sessionId: crypto.randomUUID(),
    userAgent: args.userAgent,
    payload: {
      model: args.model,
      input: prompt,
      reasoning: { effort: "low" },
      store: false,
    },
  })
  const outputText = extractResponseOutputText(payload)
  return parseTranslationJson<Locale>(outputText)
}

async function translateMessageForLocaleWithRetry<Locale extends string>(args: {
  title: string
  body: string
  locale: Locale
  model: string
  userAgent: string
  clientVersion: string
  accounts: TranslationAccount[]
  startOffset?: number
}): Promise<{
  locale: Locale
  title?: string
  body?: string
}> {
  if (args.accounts.length === 0) {
    throw new Error("No OpenAI account access token available for inbox translation")
  }
  const baseOffset =
    typeof args.startOffset === "number" && Number.isFinite(args.startOffset)
      ? Math.max(0, Math.floor(args.startOffset))
      : 0
  let lastError: unknown = null
  for (let index = 0; index < args.accounts.length; index += 1) {
    const account = args.accounts[(baseOffset + index) % args.accounts.length] ?? null
    if (!account) continue
    try {
      const translations = await translateMessageByLocale({
        title: args.title,
        body: args.body,
        locale: args.locale,
        model: args.model,
        userAgent: args.userAgent,
        clientVersion: args.clientVersion,
        accessToken: account.accessToken.trim(),
      })
      const translated = {
        locale: args.locale,
        title: translations[args.locale]?.title,
        body: translations[args.locale]?.body,
      }
      if (
        looksObviouslyUntranslated({
          locale: args.locale,
          sourceTitle: args.title,
          sourceBody: args.body,
          translatedTitle: translated.title,
          translatedBody: translated.body,
        })
      ) {
        throw new Error(
          `Translation for ${args.locale} appears to be unchanged from source`,
        )
      }
      return translated
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Inbox translation failed on all available accounts")
}

export async function translateMessagesInParallel<Locale extends string>(args: {
  title: string
  body: string
  locales: Locale[]
  model: string
  userAgent: string
  clientVersion: string
  accounts: TranslationAccount[]
}): Promise<MessageTranslationMap<Locale>> {
  if (args.locales.length === 0) return {}
  const translations = await Promise.all(
    args.locales.map((locale, index) =>
      translateMessageForLocaleWithRetry({
        title: args.title,
        body: args.body,
        locale,
        model: args.model,
        userAgent: args.userAgent,
        clientVersion: args.clientVersion,
        accounts: args.accounts,
        startOffset: index,
      }),
    ),
  )

  const result: MessageTranslationMap<Locale> = {}
  for (const item of translations) {
    result[item.locale] = {
      title: item.title,
      body: item.body,
    }
  }
  return result
}
