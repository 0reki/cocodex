use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::db::users::PortalUser;

/// Portal users known to be enabled and under quota. Node broadcasts
/// `auth.invalidate` when an admin change or a settlement affects a user.
#[derive(Clone, Default)]
pub struct OwnerAuthCache {
    inner: Arc<RwLock<HashMap<String, PortalUser>>>,
}

impl OwnerAuthCache {
    pub async fn get(&self, owner_user_id: &str) -> Option<PortalUser> {
        let owner_user_id = owner_user_id.trim();
        if owner_user_id.is_empty() {
            return None;
        }
        self.inner.read().await.get(owner_user_id).cloned()
    }

    pub async fn remember(&self, user: PortalUser) {
        self.inner.write().await.insert(user.id.clone(), user);
    }

    /// Drops one user, or every user when `owner_user_id` is empty.
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
