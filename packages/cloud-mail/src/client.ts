import {
  getCloudMailDefaultAuthorization,
  getCloudMailDefaultBaseUrl,
} from "./config.ts"
import type {
  CloudMailClientOptions,
  CloudMailCreateAccountResponse,
  CloudMailEmail,
  CloudMailListResponse,
  ListEmailsOptions,
  WaitForOtpOptions,
} from "./types.ts"

export class CloudMailClient {
  private readonly baseUrl: string
  private readonly authorization: string
  private readonly debug: boolean

  constructor(options: CloudMailClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? getCloudMailDefaultBaseUrl()
    this.authorization =
      options.authorization ?? getCloudMailDefaultAuthorization()
    this.debug = process.env.CLOUD_MAIL_DEBUG === "1"
  }

  private parseOtpFromText(input?: string | null): string | null {
    if (!input) return null
    const explicitPatterns = [
      /chatgpt code is[\s:：]*([0-9]{6})/i,
      /temporary verification code to continue[\s:：]*([0-9]{6})/i,
      /输入此临时验证码以继续[\s:：]*([0-9]{6})/i,
      /你的\s*chatgpt\s*代码为[\s:：]*([0-9]{6})/i,
      /enter this code[\s:：]*([0-9]{6})/i,
    ]
    for (const pattern of explicitPatterns) {
      const matched = input.match(pattern)
      if (matched?.[1]) return matched[1]
    }
    const match = input.match(/\b(\d{6})\b/)
    return match?.[1] ?? null
  }

  private extractOtp(email: CloudMailEmail): string | null {
    return (
      this.parseOtpFromText(email.subject) ??
      this.parseOtpFromText(email.text) ??
      this.parseOtpFromText(email.content)
    )
  }

  private extractRecipientAddresses(email: CloudMailEmail): string[] {
    const direct = (email.toEmail ?? "").trim().toLowerCase()
    const set = new Set<string>()
    if (direct) set.add(direct)

    const raw = email.recipient
    if (!raw) return [...set]
    try {
      const parsed = JSON.parse(raw) as Array<{ address?: string }>
      for (const item of parsed) {
        const addr = (item?.address ?? "").trim().toLowerCase()
        if (addr) set.add(addr)
      }
    } catch {
      // ignore invalid recipient payload
    }

    return [...set]
  }

  private isRetryableNetworkError(error: unknown): boolean {
    const text =
      error instanceof Error
        ? `${error.message} ${(error as { code?: string }).code ?? ""}`.toLowerCase()
        : String(error).toLowerCase()
    return (
      text.includes("econnreset") ||
      text.includes("etimedout") ||
      text.includes("timeout") ||
      text.includes("socket connection was closed unexpectedly") ||
      text.includes("fetch failed") ||
      text.includes("und_err_")
    )
  }

  async listEmails(options: ListEmailsOptions): Promise<CloudMailEmail[]> {
    const params = new URLSearchParams({
      emailId: String(options.emailId ?? 0),
      timeSort: String(options.timeSort ?? 0),
      size: String(options.size ?? 30),
      type: String(options.type ?? "all"),
      accountEmail: options.accountEmail,
      searchType: options.searchType ?? "account",
    })

    const url = `${this.baseUrl}/api/allEmail/list?${params.toString()}`
    const maxAttempts = 5
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const res = await fetch(url, {
          method: "GET",
          headers: {
            Accept: "application/json, text/plain, */*",
            Authorization: this.authorization,
            "Accept-Language": "en",
          },
        })

        const text = await res.text()
        if (this.debug) {
          let ids: number[] = []
          try {
            const parsed = JSON.parse(text) as CloudMailListResponse
            ids = Array.isArray(parsed.data?.list)
              ? parsed.data.list
                .map((item) => item.emailId)
                .filter((id): id is number => typeof id === "number")
              : []
          } catch {
            ids = []
          }
          console.log(`[cloud-mail] emailIds=[${ids.join(",")}]`)
        }

        if (res.status >= 500 && attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, attempt * 400))
          continue
        }
        if (!res.ok) {
          throw new Error(`Cloud mail HTTP ${res.status}: ${text.slice(0, 500)}`)
        }

        let payload: CloudMailListResponse
        try {
          payload = JSON.parse(text) as CloudMailListResponse
        } catch {
          throw new Error(`Cloud mail JSON parse failed: ${text.slice(0, 500)}`)
        }

        if (payload.code !== 200) {
          throw new Error(`Cloud mail API error ${payload.code}: ${payload.message ?? "unknown"}`)
        }

        return Array.isArray(payload.data?.list) ? payload.data.list : []
      } catch (error) {
        if (attempt < maxAttempts && this.isRetryableNetworkError(error)) {
          await new Promise((r) => setTimeout(r, attempt * 400))
          continue
        }
        throw error
      }
    }

    return []
  }

  async createAccount(email: string, token = ""): Promise<void> {
    const normalized = email.trim().toLowerCase()
    if (!normalized) {
      throw new Error("Cloud mail createAccount requires email")
    }

    const url = `${this.baseUrl}/api/account/add`
    const maxAttempts = 5
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            Accept: "application/json, text/plain, */*",
            Authorization: this.authorization,
            "Accept-Language": "en",
            "Content-Type": "application/json",
            Origin: this.baseUrl,
            Referer: `${this.baseUrl}/inbox`,
          },
          body: JSON.stringify({
            email: normalized,
            token,
          }),
        })

        const text = await res.text()
        if (res.status >= 500 && attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, attempt * 400))
          continue
        }
        if (!res.ok) {
          throw new Error(`Cloud mail create account HTTP ${res.status}: ${text.slice(0, 500)}`)
        }

        let payload: CloudMailCreateAccountResponse
        try {
          payload = JSON.parse(text) as CloudMailCreateAccountResponse
        } catch {
          throw new Error(`Cloud mail create account JSON parse failed: ${text.slice(0, 500)}`)
        }

        if (payload.code === 200) return

        const msg = (payload.message ?? "").toLowerCase()
        if (msg.includes("exist") || msg.includes("exists") || msg.includes("已存在")) {
          return
        }

        throw new Error(
          `Cloud mail create account API error ${payload.code}: ${payload.message ?? "unknown"}`,
        )
      } catch (error) {
        if (attempt < maxAttempts && this.isRetryableNetworkError(error)) {
          await new Promise((r) => setTimeout(r, attempt * 400))
          continue
        }
        throw error
      }
    }
  }

  async getLatestOpenAiOtp(
    options: WaitForOtpOptions,
  ): Promise<{ otp: string; email: CloudMailEmail } | null> {
    const targetTo = options.toEmail?.toLowerCase()
    const senderContains = options.senderContains?.trim().toLowerCase()
    const senderExact = options.senderExact?.trim().toLowerCase()
    const subjectIncludes = Array.isArray(options.subjectIncludes)
      ? options.subjectIncludes
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
      : []
    const list = await this.listEmails({
      accountEmail: options.accountEmail,
      emailId: 0,
      timeSort: 0,
      size: 30,
      type: "all",
      searchType: "account",
    })

    for (const email of list) {
      if (typeof options.minEmailId === "number" && email.emailId <= options.minEmailId) {
        continue
      }

      if (targetTo) {
        const recipients = this.extractRecipientAddresses(email)
        if (!recipients.includes(targetTo)) continue
      }

      const sender = (email.sendEmail ?? "").trim().toLowerCase()
      if (senderExact && sender !== senderExact) {
        continue
      }
      if (senderContains && !sender.includes(senderContains)) {
        continue
      }

      if (subjectIncludes.length > 0) {
        const subject = (email.subject ?? "").trim().toLowerCase()
        if (!subjectIncludes.some((item) => subject.includes(item))) {
          continue
        }
      }

      if (
        typeof options.minEmailId !== "number" &&
        typeof options.createdAfterMs === "number"
      ) {
        const createdAtMs = email.createTime ? Date.parse(email.createTime.replace(" ", "T")) : NaN
        if (Number.isFinite(createdAtMs) && createdAtMs < options.createdAfterMs) {
          continue
        }
      }

      const otp = this.extractOtp(email)
      if (otp) {
        return { otp, email }
      }
    }

    return null
  }

  async waitForOpenAiOtp(options: WaitForOtpOptions): Promise<string> {
    const timeoutMs = options.timeoutMs ?? 1200_000
    const pollIntervalMs = options.pollIntervalMs ?? 2_500
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const found = await this.getLatestOpenAiOtp(options)
      if (found) return found.otp
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }

    throw new Error(`Timed out waiting for OTP after ${Math.floor(timeoutMs / 1000)} seconds`)
  }

  async getMaxEmailId(accountEmail: string): Promise<number> {
    const list = await this.listEmails({
      accountEmail,
      emailId: 0,
      timeSort: 0,
      size: 30,
      type: "all",
      searchType: "account",
    })
    let max = 0
    for (const email of list) {
      if (typeof email.emailId === "number" && email.emailId > max) {
        max = email.emailId
      }
    }
    return max
  }
}
