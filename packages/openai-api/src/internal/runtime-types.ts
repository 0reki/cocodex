import type { WsSocket } from "./runtime-platform.ts";

export type ChatgptSessionResponse = {
  user?: {
    id?: string;
    email?: string;
    idp?: string;
    iat?: number;
    mfa?: boolean;
  };
  expires?: string;
  account?: {
    id?: string;
    planType?: string;
    structure?: string;
    isFedrampCompliantWorkspace?: boolean;
    isConversationClassifierEnabledForWorkspace?: boolean;
    isDelinquent?: boolean;
    residencyRegion?: string;
    computeResidency?: string;
  };
  accessToken?: string;
  authProvider?: string;
  rumViewTags?: Record<string, unknown>;
};

export type GetChatgptSessionOptions = {
  sessionToken?: string;
  sessionTokenChunks?: string[];
  cookieHeader?: string;
  proxyUrl?: string;
  userAgent?: string;
  signal?: AbortSignal;
};

export type GetAccountsCheckV4Options = {
  accessToken: string;
  timezoneOffsetMin?: number;
  proxyUrl?: string;
  userAgent?: string;
  signal?: AbortSignal;
};

export type GetMeOptions = {
  accessToken: string;
  accountId: string;
  proxyUrl?: string;
  userAgent?: string;
  signal?: AbortSignal;
};

export type GetSubscriptionOptions = {
  accessToken: string;
  accountId: string;
  proxyUrl?: string;
  userAgent?: string;
  signal?: AbortSignal;
};

export type ListAccountUsersOptions = {
  accessToken: string;
  accountId: string;
  offset?: number;
  limit?: number;
  query?: string;
  proxyUrl?: string;
  userAgent?: string;
  signal?: AbortSignal;
};

export type DeleteAccountUserOptions = {
  accessToken: string;
  accountId: string;
  userId: string;
  proxyUrl?: string;
  userAgent?: string;
  signal?: AbortSignal;
};

export type ListAccountInvitesOptions = {
  accessToken: string;
  accountId: string;
  proxyUrl?: string;
  userAgent?: string;
  signal?: AbortSignal;
};

export type CreateAccountInvitesOptions = {
  accessToken: string;
  accountId: string;
  emailAddresses: string[];
  role?: string;
  resendEmail?: boolean;
  proxyUrl?: string;
  userAgent?: string;
  signal?: AbortSignal;
};

export type DeleteAccountInviteOptions = {
  accessToken: string;
  accountId: string;
  emailAddress: string;
  proxyUrl?: string;
  userAgent?: string;
  signal?: AbortSignal;
};

export type GetCodexModelsOptions = {
  accessToken: string;
  clientVersion: string;
  proxyUrl?: string;
  userAgent?: string;
  signal?: AbortSignal;
};

export type GetWhamUsageOptions = {
  accessToken: string;
  accountId: string;
  proxyUrl?: string;
  userAgent?: string;
  signal?: AbortSignal;
};

export type PostCodexResponsesOptions = {
  accessToken: string;
  accountId?: string;
  version: string;
  sessionId: string;
  payload?: ResponsesCreatePayload | null;
  debugLabel?: string;
  proxyUrl?: string;
  userAgent?: string;
  originator?: string;
  webSearchEligible?: boolean;
  signal?: AbortSignal;
};

export type PostCodexResponsesCompactOptions = {
  accessToken: string;
  accountId?: string;
  version: string;
  sessionId: string;
  payload?: ResponsesCreatePayload | null;
  debugLabel?: string;
  proxyUrl?: string;
  userAgent?: string;
  originator?: string;
  signal?: AbortSignal;
};

export type ConnectCodexResponsesWebSocketOptions = {
  accessToken: string;
  accountId?: string;
  version: string;
  sessionId?: string;
  serviceTier?: "priority";
  proxyUrl?: string;
  userAgent?: string;
  originator?: string;
  signal?: AbortSignal;
};

export type PostAudioTranscriptionOptions = {
  accessToken: string;
  accountId: string;
  contentType: string;
  body: BodyInit;
  proxyUrl?: string;
  userAgent?: string;
  signal?: AbortSignal;
};

export type ResponsesCreatePayload = {
  background?: boolean;
  context_management?: Array<{
    type: string;
    compact_threshold?: number;
    [key: string]: unknown;
  }>;
  conversation?: string | { id: string; [key: string]: unknown };
  include?: string[];
  input?: string | unknown[];
  instructions?: string | unknown[];
  max_output_tokens?: number;
  max_tool_calls?: number;
  metadata?: Record<string, string>;
  model?: string;
  parallel_tool_calls?: boolean;
  previous_response_id?: string;
  prompt?: {
    id: string;
    version?: string;
    variables?: Record<string, unknown>;
    [key: string]: unknown;
  };
  prompt_cache_key?: string;
  prompt_cache_retention?: "in-memory" | "24h";
  reasoning?: {
    effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
    generate_summary?: "auto" | "concise" | "detailed";
    summary?: "auto" | "concise" | "detailed";
    [key: string]: unknown;
  };
  safety_identifier?: string;
  service_tier?: "auto" | "default" | "flex" | "scale" | "priority";
  store?: boolean;
  stream?: boolean;
  stream_options?: {
    include_obfuscation?: boolean;
    [key: string]: unknown;
  };
  temperature?: number;
  text?: {
    format?: Record<string, unknown>;
    verbosity?: "low" | "medium" | "high";
    [key: string]: unknown;
  };
  tool_choice?: unknown;
  tools?: unknown[];
  top_logprobs?: number;
  top_p?: number;
  truncation?: "auto" | "disabled";
  user?: string;
  [key: string]: unknown;
};

export type SseEvent = {
  event: string;
  data: string;
};

export type AccountsCheckAccountCore = {
  account_user_role?: string;
  account_user_id?: string;
  account_owner_id?: string;
  account_id?: string;
  name?: string | null;
  profile_picture_url?: string | null;
  structure?: string | null;
  plan_type?: string | null;
  is_deactivated?: boolean;
};

export type AccountsCheckAccountNode = {
  account?: AccountsCheckAccountCore;
  features?: string[];
  entitlement?: {
    has_active_subscription?: boolean;
    subscription_plan?: string | null;
    expires_at?: string | null;
    renews_at?: string | null;
    cancels_at?: string | null;
    is_delinquent?: boolean;
  };
  can_access_with_session?: boolean;
};

export type AccountsCheckV4Response = {
  accounts?: Record<string, AccountsCheckAccountNode>;
  account_ordering?: string[];
};

export type PrimaryAccountInfo = {
  accountKey: string;
  accountId: string | null;
  accountUserRole: string | null;
  accountUserId: string | null;
  accountOwnerId: string | null;
  name: string | null;
  picture: string | null;
  planType: string | null;
  structure: string | null;
  workspaceIsDeactivated: boolean;
  canAccessWithSession: boolean;
  isDelinquent: boolean | null;
  subscriptionPlan: string | null;
  expiresAt: string | null;
  renewsAt: string | null;
  cancelsAt: string | null;
};

export type ChatgptOrganization = {
  object?: "organization";
  id?: string;
  created?: number;
  title?: string;
  name?: string;
  description?: string;
  personal?: boolean;
  role?: string;
  is_default?: boolean;
};

export type ChatgptAccountUser = {
  id?: string;
  account_user_id?: string;
  email?: string;
  verified_email?: string | null;
  role?: string | null;
  seat_type?: string | null;
  name?: string | null;
  created_time?: string | null;
  is_scim_managed?: boolean;
  deactivated_time?: string | null;
};

export type ChatgptAccountUsersResponse = {
  items?: ChatgptAccountUser[];
  total?: number;
  limit?: number;
  offset?: number;
};

export type ChatgptAccountInvite = {
  id?: string;
  email?: string;
  email_address?: string;
  recipient_email?: string;
  invited_email?: string;
  role?: string | null;
  status?: string | null;
  created_time?: string | null;
  expires_at?: string | null;
  [key: string]: unknown;
};

export type ChatgptAccountInvitesResponse = {
  items?: ChatgptAccountInvite[];
  total?: number;
  [key: string]: unknown;
};

export type ChatgptMeResponse = {
  object?: "user";
  id?: string;
  email?: string;
  name?: string;
  picture?: string | null;
  created?: number;
  phone_number?: string | null;
  mfa_flag_enabled?: boolean;
  has_payg_project_spend_limit?: boolean;
  email_domain_type?: string;
  orgs?: {
    object?: "list";
    data?: ChatgptOrganization[];
  };
  client_id?: string;
  is_test_user?: boolean | null;
  country?: string;
  region?: string;
  region_code?: string;
  first_name?: string | null;
};

export type ChatgptSubscriptionResponse = {
  id?: string;
  plan_type?: string | null;
  seats_in_use?: number | null;
  seats_entitled?: number | null;
  active_start?: string | null;
  active_until?: string | null;
  billing_period?: string | null;
  will_renew?: boolean | null;
  billing_currency?: string | null;
  is_delinquent?: boolean | null;
  became_delinquent_timestamp?: string | null;
  grace_period_end_timestamp?: string | null;
  from_webview?: boolean | null;
  [key: string]: unknown;
};

export type CodexReasoningLevel = {
  effort?: string;
  description?: string;
};

export type CodexModel = {
  slug?: string;
  display_name?: string;
  description?: string;
  visibility?: string;
  minimal_client_version?: string;
  supported_in_api?: boolean;
  priority?: number;
  prefer_websockets?: boolean;
  supports_parallel_tool_calls?: boolean;
  support_verbosity?: boolean;
  default_verbosity?: string | null;
  supports_reasoning_summaries?: boolean;
  default_reasoning_level?: string;
  supported_reasoning_levels?: CodexReasoningLevel[];
  shell_type?: string;
  context_window?: number;
  input_modalities?: string[];
  base_instructions?: string;
  [key: string]: unknown;
};

export type CodexModelsResponse = {
  models?: CodexModel[];
};

export type WhamUsageWindow = {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number;
};

export type WhamUsageLimit = {
  allowed?: boolean;
  limit_reached?: boolean;
  primary_window?: WhamUsageWindow | null;
  secondary_window?: WhamUsageWindow | null;
};

export type WhamUsageResponse = {
  user_id?: string;
  account_id?: string;
  email?: string;
  plan_type?: string;
  rate_limit?: WhamUsageLimit;
  code_review_rate_limit?: WhamUsageLimit;
  additional_rate_limits?: Record<string, unknown> | null;
  credits?: Record<string, unknown> | null;
  promo?: {
    campaign_id?: string;
    message?: string;
  } | null;
};

export type SessionTokenCookieMap = {
  "__Secure-next-auth.session-token"?: string;
  "__Secure-next-auth.session-token.0"?: string;
  "__Secure-next-auth.session-token.1"?: string;
  [key: `__Secure-next-auth.session-token.${number}`]: string | undefined;
};

export type ChatgptSessionWithCookies = {
  session: ChatgptSessionResponse;
  setCookies: string[];
  sessionTokenCookies: SessionTokenCookieMap;
};

export type ConnectCodexWebSocketResult = {
  socket: WsSocket;
  sessionId: string;
};
