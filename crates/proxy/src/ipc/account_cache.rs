use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;

use super::protocol::ResolveUpstreamAccountResult;

#[derive(Clone, Default)]
pub struct UpstreamAccountCache {
    inner: Arc<RwLock<HashMap<String, ResolveUpstreamAccountResult>>>,
}

impl UpstreamAccountCache {
    pub async fn get(&self, platform: &str) -> Option<ResolveUpstreamAccountResult> {
        let platform = platform.trim();
        if platform.is_empty() {
            return None;
        }
        self.inner.read().await.get(platform).cloned()
    }

    pub async fn remember(&self, platform: String, account: ResolveUpstreamAccountResult) {
        let platform = platform.trim().to_string();
        if platform.is_empty() {
            return;
        }
        self.inner.write().await.insert(platform, account);
    }

    pub async fn invalidate(&self, platform: &str) {
        let platform = platform.trim();
        let mut inner = self.inner.write().await;
        if platform.is_empty() {
            inner.clear();
            return;
        }
        inner.remove(platform);
    }
}
