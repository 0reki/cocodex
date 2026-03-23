import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import {
  createPortalInboxMessages,
  ensureDatabaseSchema,
  getSystemSettings,
  listOpenAIAccountsForModelCache,
  listPortalUsersByIds,
} from "@workspace/database"
import {
  isAiTranslatedResult,
  translateMessagesInParallel,
} from "@workspace/inbox-translation"
import { resolvePortalSessionFromCookieStore } from "@/lib/auth/admin-auth"
import { getLocaleFromCountry } from "@/lib/i18n/locale-map"
import type { AppLocale } from "@/locales"

const DEFAULT_OPENAI_API_USER_AGENT = "node/22.14.0"
const DEFAULT_OPENAI_API_CLIENT_VERSION =
  process.env.CODEX_CLIENT_VERSION?.trim() || "0.98.0"

async function requireAdminForApi() {
  const cookieStore = await cookies()
  const resolved = await resolvePortalSessionFromCookieStore(cookieStore)
  const payload = resolved?.session ?? null
  return payload?.role === "admin" ? payload : null
}

export async function POST(req: Request) {
  const session = await requireAdminForApi()
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  const recipientUserIds = Array.isArray(input.recipientUserIds)
    ? input.recipientUserIds.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    )
    : []
  const title = typeof input.title === "string" ? input.title.trim() : ""
  const bodyText = typeof input.body === "string" ? input.body.trim() : ""

  if (recipientUserIds.length === 0) {
    return NextResponse.json({ error: "recipientUserIds is required" }, { status: 400 })
  }
  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 })
  }
  if (!bodyText) {
    return NextResponse.json({ error: "body is required" }, { status: 400 })
  }
  if (title.length > 120) {
    return NextResponse.json(
      { error: "title must be <= 120 characters" },
      { status: 400 },
    )
  }
  if (bodyText.length > 5000) {
    return NextResponse.json(
      { error: "body must be <= 5000 characters" },
      { status: 400 },
    )
  }

  try {
    await ensureDatabaseSchema()
    const recipients = await listPortalUsersByIds(recipientUserIds)
    const localeGroups = new Map<AppLocale, string[]>()
    for (const recipient of recipients) {
      const locale = getLocaleFromCountry(recipient.country)
      const current = localeGroups.get(locale) ?? []
      current.push(recipient.id)
      localeGroups.set(locale, current)
    }

    console.log(
      `[inbox-send] recipients=${recipientUserIds.length} validRecipients=${recipients.length} locales=${JSON.stringify([...localeGroups.keys()])}`,
    )

    if (localeGroups.size === 0) {
      return NextResponse.json({ error: "No valid recipients found" }, { status: 400 })
    }

    const settings = await getSystemSettings()
    const translationModel = settings?.inboxTranslationModel?.trim() ?? ""
    if (!translationModel) {
      return NextResponse.json(
        { error: "Inbox translation model is not configured" },
        { status: 400 },
      )
    }
    console.log(
      `[inbox-send] translationModel=${translationModel} localeCount=${localeGroups.size}`,
    )
    const accounts = (await listOpenAIAccountsForModelCache(8))
      .filter(
        (item) =>
          typeof item.id === "string" &&
          typeof item.accessToken === "string" &&
          item.accessToken.trim().length > 0,
      )
      .map((item) => ({
        id: item.id,
        accessToken: (item.accessToken as string).trim(),
      }))
    if (accounts.length === 0) {
      return NextResponse.json(
        { error: "No OpenAI account access token available for inbox translation" },
        { status: 400 },
      )
    }
    const translations = await translateMessagesInParallel({
      title,
      body: bodyText,
      locales: [...localeGroups.keys()],
      model: translationModel,
      userAgent:
        settings?.openaiApiUserAgent?.trim() || DEFAULT_OPENAI_API_USER_AGENT,
      clientVersion:
        settings?.openaiClientVersion?.trim() ||
        DEFAULT_OPENAI_API_CLIENT_VERSION,
      accounts,
    })

    let created = 0
    for (const [locale, userIds] of localeGroups) {
      const localized = translations[locale]
      const localizedTitle = localized?.title?.trim() || title
      const localizedBody = localized?.body?.trim() || bodyText
      const aiTranslated = isAiTranslatedResult({
        locale,
        sourceTitle: title,
        sourceBody: bodyText,
        translatedTitle: localizedTitle,
        translatedBody: localizedBody,
      })
      console.log(
        `[inbox-send] locale=${locale} recipients=${userIds.length} translated=${aiTranslated} title=${JSON.stringify(localizedTitle).slice(0, 120)} body=${JSON.stringify(localizedBody).slice(0, 160)}`,
      )
      created += await createPortalInboxMessages({
        recipientUserIds: userIds,
        senderUserId: session.sub,
        title: localizedTitle,
        body: localizedBody,
        aiTranslated,
      })
    }

    if (created === 0) {
      return NextResponse.json({ error: "No valid recipients found" }, { status: 400 })
    }

    return NextResponse.json({ ok: true, created })
  } catch (error) {
    console.error("[inbox-send] failed:", error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to send inbox message",
      },
      { status: 500 },
    )
  }
}
