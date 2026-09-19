use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;

use super::protocol::VerifyOwnerResult;

#[derive(Clone, Default)]
pub struct OwnerAuthCache {
    inner: Arc<RwLock<HashMap<String, VerifyOwnerResult>>>,
}

impl OwnerAuthCache {
    pub async fn get(&self, owner_user_id: &str) -> Option<VerifyOwnerResult> {
        let owner_user_id = owner_user_id.trim();
        if owner_user_id.is_empty() {
            return None;
        }
        self.inner.read().await.get(owner_user_id).cloned()
    }

    pub async fn remember(&self, owner_user_id: String, result: VerifyOwnerResult) {
        let owner_user_id = owner_user_id.trim().to_string();
        if owner_user_id.is_empty() {
            return;
        }
        let mut inner = self.inner.write().await;
        if result.valid {
            inner.insert(owner_user_id, result);
        } else {
            inner.remove(&owner_user_id);
        }
    }

    pub async fn invalidate(&self, owner_user_id: &str) {
        let owner_user_id = owner_user_id.trim();
        let mut inner = self.inner.write().await;
        if owner_user_id.is_empty() {
            inner.clear();
            return;
        }
        inner.remove(owner_user_id);
    }
}
