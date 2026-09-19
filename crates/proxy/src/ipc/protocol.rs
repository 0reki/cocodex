use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub id: Option<String>,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub id: Option<String>,
    #[serde(default)]
    pub result: Option<serde_json::Value>,
    #[serde(default)]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    #[serde(default)]
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKeyRecord {
    pub id: String,
    pub owner_user_id: Option<String>,
    pub name: String,
    pub api_key: String,
    pub quota: Option<String>,
    pub used: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifyApiKeyResult {
    pub valid: bool,
    #[serde(default)]
    pub api_key: Option<ApiKeyRecord>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortalUserRecord {
    pub id: String,
    pub username: String,
    pub role: String,
    pub enabled: bool,
    #[serde(default)]
    pub quota: Option<String>,
    #[serde(default)]
    pub used: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifyPortalTokenResult {
    pub valid: bool,
    #[serde(default)]
    pub user: Option<PortalUserRecord>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifyOwnerResult {
    pub valid: bool,
    #[serde(default)]
    pub user: Option<PortalUserRecord>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolveUpstreamAccountResult {
    pub account_id: String,
    pub access_token: String,
    pub platform: String,
    pub user_agent: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredRefreshToken {
    pub email: String,
    pub owner_user_id: String,
    #[serde(default)]
    pub found: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ReportUsageParams {
    pub api_key_id: Option<String>,
    pub owner_user_id: Option<String>,
    pub model: String,
    pub total_tokens: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttfb_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settlement_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_code: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens_info: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub billable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_final: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_end_reason: Option<String>,
}

