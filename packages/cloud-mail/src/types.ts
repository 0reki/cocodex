export type CloudMailEmail = {
  emailId: number
  sendEmail?: string
  name?: string
  accountId?: number
  userId?: number
  subject?: string
  text?: string | null
  content?: string | null
  toEmail?: string
  recipient?: string
  unread?: number
  createTime?: string
  [key: string]: unknown
}

export type CloudMailListResponse = {
  code: number
  message?: string
  data?: {
    list?: CloudMailEmail[]
    total?: number
    latestEmail?: CloudMailEmail
    [key: string]: unknown
  }
}

export type CloudMailCreateAccountResponse = {
  code: number
  message?: string
  data?: Record<string, unknown>
}

export type CloudMailClientOptions = {
  baseUrl?: string
  authorization?: string
}

export type ListEmailsOptions = {
  accountEmail: string
  emailId?: number
  timeSort?: 0 | 1
  size?: number
  type?: "all" | "receive" | "send"
  searchType?: "account"
}

export type WaitForOtpOptions = {
  accountEmail: string
  toEmail?: string
  timeoutMs?: number
  pollIntervalMs?: number
  senderContains?: string
  senderExact?: string
  subjectIncludes?: string[]
  minEmailId?: number
  createdAfterMs?: number
}
