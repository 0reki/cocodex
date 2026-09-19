use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::auth::jwt::now_secs;

/// Client sessions known to still hold an unexpired refresh token, keyed by
/// the access token's `session_id`, valued by that refresh token's expiry.
/// Only live sessions are cached; revocation evicts them.
#[derive(Clone, Default)]
pub struct SessionCache {
    inner: Arc<RwLock<HashMap<String, u64>>>,
}

impl SessionCache {
    pub async fn is_live(&self, session_id: &str) -> bool {
        let session_id = session_id.trim();
        if session_id.is_empty() {
            return false;
        }
        self.inner
            .read()
            .await
            .get(session_id)
            .is_some_and(|expires_at| *expires_at > now_secs())
    }

    pub async fn remember(&self, session_id: String, expires_at_secs: u64) {
        let session_id = session_id.trim().to_string();
        if session_id.is_empty() || expires_at_secs <= now_secs() {
            return;
        }
        self.inner.write().await.insert(session_id, expires_at_secs);
    }

    pub async fn invalidate_many(&self, session_ids: &[String]) {
        let mut inner = self.inner.write().await;
        for session_id in session_ids {
            inner.remove(session_id.trim());
        }
    }
}
