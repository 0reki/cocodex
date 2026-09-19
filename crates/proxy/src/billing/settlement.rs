//! Durable, batched settlement of finished requests.
//!
//! Every settlement is appended (and fsynced) to a write-ahead log before it
//! is queued, written to Postgres in batches, then acknowledged in the log.
//! The log format is the one the Node backend used, so records it left
//! behind are replayed on the first start.

use std::collections::{HashSet, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Utc;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tokio::sync::{Mutex, Notify};
use tracing::{error, warn};

use crate::auth::owner_cache::OwnerAuthCache;
use crate::db;
use crate::db::settlements::Settlement;

fn env_usize(name: &str, fallback: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| value.floor() as usize)
        .unwrap_or(fallback)
}

#[derive(Debug, Clone)]
pub struct SettlementConfig {
    pub wal_path: PathBuf,
    pub batch_size: usize,
    pub flush_interval: Duration,
    pub retry_max: Duration,
    pub queue_max: usize,
    pub compact_after_records: usize,
    pub settled_id_cache: usize,
}

impl SettlementConfig {
    /// Same variables and defaults as the Node backend.
    pub fn from_env(data_dir: &Path) -> Self {
        let batch_size = env_usize("RESPONSE_SETTLEMENT_BATCH_SIZE", 200);
        let wal_path = std::env::var("RESPONSE_SETTLEMENT_WAL_PATH")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| data_dir.join("response-settlements.wal"));
        Self {
            wal_path,
            batch_size,
            flush_interval: Duration::from_millis(env_usize(
                "RESPONSE_SETTLEMENT_FLUSH_INTERVAL_MS",
                1_000,
            ) as u64),
            retry_max: Duration::from_millis(
                env_usize("RESPONSE_SETTLEMENT_RETRY_MAX_MS", 5_000) as u64
            ),
            queue_max: env_usize("RESPONSE_SETTLEMENT_QUEUE_MAX", 20_000).max(batch_size),
            compact_after_records: env_usize(
                "RESPONSE_SETTLEMENT_WAL_COMPACT_AFTER_RECORDS",
                10_000,
            ),
            settled_id_cache: env_usize("RESPONSE_SETTLEMENT_ID_CACHE_SIZE", 10_000),
        }
    }
}

fn encode_record(payload: &Value) -> String {
    let serialized = payload.to_string();
    let checksum = hex::encode(Sha256::digest(serialized.as_bytes()));
    format!("{}\n", json!({ "checksum": checksum, "payload": payload }))
}

enum WalRecord {
    Put(Box<Settlement>),
    Ack(Vec<String>),
}

fn decode_record(line: &str) -> Result<WalRecord, String> {
    let envelope: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
    let payload = envelope.get("payload").ok_or("missing payload")?;
    let checksum = hex::encode(Sha256::digest(payload.to_string().as_bytes()));
    if envelope.get("checksum").and_then(Value::as_str) != Some(checksum.as_str()) {
        return Err("checksum mismatch".into());
    }
    if payload.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("unsupported version".into());
    }
    match payload.get("operation").and_then(Value::as_str) {
        Some("put") => {
            serde_json::from_value(payload.get("settlement").cloned().unwrap_or_default())
                .map(|settlement| WalRecord::Put(Box::new(settlement)))
                .map_err(|e| e.to_string())
        }
        Some("ack") => {
            serde_json::from_value(payload.get("settlementIds").cloned().unwrap_or_default())
                .map(WalRecord::Ack)
                .map_err(|e| e.to_string())
        }
        _ => Err("unknown operation".into()),
    }
}

struct Wal {
    path: PathBuf,
    file: Option<File>,
    records: usize,
}

impl Wal {
    /// Loads live (unacknowledged) settlements, in log order.
    fn open(path: &Path) -> std::io::Result<(Wal, Vec<Settlement>)> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut live: Vec<Settlement> = Vec::new();
        let mut records = 0;
        if let Ok(file) = File::open(path) {
            for (index, line) in BufReader::new(file).lines().enumerate() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                match decode_record(&line) {
                    Ok(WalRecord::Put(settlement)) => {
                        live.retain(|item| item.settlement_id != settlement.settlement_id);
                        live.push(*settlement);
                    }
                    Ok(WalRecord::Ack(ids)) => {
                        let ids: HashSet<String> = ids.into_iter().collect();
                        live.retain(|item| !ids.contains(&item.settlement_id));
                    }
                    Err(reason) => {
                        error!(line = index + 1, %reason, "skipping unreadable settlement WAL record");
                    }
                }
                records += 1;
            }
        }
        let mut wal = Wal {
            path: path.to_path_buf(),
            file: None,
            records,
        };
        // Rewrite from the live set; this also drops a torn final line.
        wal.compact(&live)?;
        Ok((wal, live))
    }

    fn append(&mut self, payload: &Value) -> std::io::Result<()> {
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| std::io::Error::other("settlement WAL is closed"))?;
        file.write_all(encode_record(payload).as_bytes())?;
        file.sync_data()?;
        self.records += 1;
        Ok(())
    }

    fn compact(&mut self, live: &[Settlement]) -> std::io::Result<()> {
        let temporary = self
            .path
            .with_extension(format!("wal.compact.{}", std::process::id()));
        {
            let mut file = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&temporary)?;
            for settlement in live {
                file.write_all(encode_record(&put_payload(settlement)).as_bytes())?;
            }
            file.sync_all()?;
        }
        self.file = None;
        std::fs::rename(&temporary, &self.path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600));
        }
        self.file = Some(OpenOptions::new().append(true).open(&self.path)?);
        self.records = live.len();
        Ok(())
    }
}

fn put_payload(settlement: &Settlement) -> Value {
    json!({ "version": 1, "operation": "put", "settlement": settlement })
}

struct State {
    pending: VecDeque<Settlement>,
    queued: HashSet<String>,
    recently_settled: VecDeque<String>,
    recently_settled_set: HashSet<String>,
    wal: Wal,
    wal_error: Option<String>,
    stopped: bool,
    consecutive_failures: u32,
    next_attempt: Option<Instant>,
    last_success: Option<chrono::DateTime<Utc>>,
    last_failure: Option<chrono::DateTime<Utc>>,
}

pub struct SettlementQueue {
    pool: PgPool,
    owners: OwnerAuthCache,
    config: SettlementConfig,
    state: Mutex<State>,
    flush_lock: Mutex<()>,
    wake: Notify,
}

impl SettlementQueue {
    pub async fn start(
        pool: PgPool,
        owners: OwnerAuthCache,
        config: SettlementConfig,
    ) -> std::io::Result<Arc<SettlementQueue>> {
        let path = config.wal_path.clone();
        let (wal, live) = tokio::task::spawn_blocking(move || Wal::open(&path))
            .await
            .map_err(std::io::Error::other)??;
        let queued = live.iter().map(|item| item.settlement_id.clone()).collect();
        let queue = Arc::new(SettlementQueue {
            pool,
            owners,
            state: Mutex::new(State {
                pending: live.into(),
                queued,
                recently_settled: VecDeque::new(),
                recently_settled_set: HashSet::new(),
                wal,
                wal_error: None,
                stopped: false,
                consecutive_failures: 0,
                next_attempt: None,
                last_success: None,
                last_failure: None,
            }),
            flush_lock: Mutex::new(()),
            wake: Notify::new(),
            config,
        });
        let worker = Arc::downgrade(&queue);
        tokio::spawn(async move {
            loop {
                let Some(queue) = worker.upgrade() else {
                    return;
                };
                let interval = queue.config.flush_interval;
                tokio::select! {
                    _ = queue.wake.notified() => {}
                    _ = tokio::time::sleep(interval) => {}
                }
                if queue.state.lock().await.stopped {
                    return;
                }
                queue.flush_due().await;
            }
        });
        Ok(queue)
    }

    /// Durably queues a settlement. Duplicates are ignored.
    pub async fn enqueue(&self, settlement: Settlement) -> Result<(), String> {
        let mut state = self.state.lock().await;
        if state.stopped {
            return Err("settlement queue is stopped".into());
        }
        let id = settlement.settlement_id.clone();
        if state.queued.contains(&id) || state.recently_settled_set.contains(&id) {
            return Ok(());
        }
        if state.pending.len() >= self.config.queue_max {
            return Err("response settlement queue is full".into());
        }
        if let Err(error) = state.wal.append(&put_payload(&settlement)) {
            state.wal_error = Some(error.to_string());
            return Err(format!("settlement WAL write failed: {error}"));
        }
        state.wal_error = None;
        state.queued.insert(id);
        state.pending.push_back(settlement);
        if state.pending.len() >= self.config.batch_size {
            self.wake.notify_one();
        }
        Ok(())
    }

    async fn flush_due(&self) {
        let due = {
            let state = self.state.lock().await;
            !state.pending.is_empty() && state.next_attempt.is_none_or(|at| Instant::now() >= at)
        };
        if due && let Err(error) = self.flush_now().await {
            warn!(%error, "settlement flush failed");
        }
    }

    /// Writes batches until fewer than a full batch remains.
    pub async fn flush_now(&self) -> Result<(), sqlx::Error> {
        let _guard = self.flush_lock.lock().await;
        loop {
            let batch: Vec<Settlement> = {
                let state = self.state.lock().await;
                state
                    .pending
                    .iter()
                    .take(self.config.batch_size)
                    .cloned()
                    .collect()
            };
            if batch.is_empty() {
                return Ok(());
            }
            match db::settlements::flush(&self.pool, &batch).await {
                Ok(result) => {
                    for owner in &result.owners_over_quota {
                        self.owners.invalidate(owner).await;
                    }
                    self.acknowledge(&batch).await;
                }
                Err(error) => {
                    let mut state = self.state.lock().await;
                    state.consecutive_failures += 1;
                    state.last_failure = Some(Utc::now());
                    let backoff = self.config.flush_interval
                        * 2u32.saturating_pow(state.consecutive_failures - 1);
                    state.next_attempt = Some(Instant::now() + backoff.min(self.config.retry_max));
                    return Err(error);
                }
            }
            if self.state.lock().await.pending.len() < self.config.batch_size {
                return Ok(());
            }
        }
    }

    async fn acknowledge(&self, batch: &[Settlement]) {
        let ids: Vec<String> = batch
            .iter()
            .map(|item| item.settlement_id.clone())
            .collect();
        let mut state = self.state.lock().await;
        let done: HashSet<&String> = ids.iter().collect();
        state
            .pending
            .retain(|item| !done.contains(&item.settlement_id));
        for id in &ids {
            state.queued.remove(id);
            if state.recently_settled_set.insert(id.clone()) {
                state.recently_settled.push_back(id.clone());
            }
        }
        while state.recently_settled.len() > self.config.settled_id_cache {
            if let Some(old) = state.recently_settled.pop_front() {
                state.recently_settled_set.remove(&old);
            }
        }
        state.consecutive_failures = 0;
        state.next_attempt = None;
        state.last_success = Some(Utc::now());
        let ack = json!({ "version": 1, "operation": "ack", "settlementIds": ids });
        if let Err(error) = state.wal.append(&ack) {
            state.wal_error = Some(error.to_string());
            warn!(%error, "failed to acknowledge settlements in WAL");
        }
        if state.wal.records >= self.config.compact_after_records {
            let live: Vec<Settlement> = state.pending.iter().cloned().collect();
            if let Err(error) = state.wal.compact(&live) {
                state.wal_error = Some(error.to_string());
                warn!(%error, "settlement WAL compaction failed");
            }
        }
    }

    /// Flushes everything (retrying briefly) and compacts the log.
    pub async fn shutdown(&self) {
        for attempt in 0..20 {
            match self.flush_now().await {
                Ok(()) if self.state.lock().await.pending.is_empty() => break,
                Ok(()) => continue,
                Err(error) => {
                    warn!(%error, attempt, "settlement flush during shutdown failed");
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
            }
        }
        let mut state = self.state.lock().await;
        state.stopped = true;
        let live: Vec<Settlement> = state.pending.iter().cloned().collect();
        if let Err(error) = state.wal.compact(&live) {
            warn!(%error, "settlement WAL compaction on shutdown failed");
        }
        state.wal.file = None;
    }

    pub async fn health(&self) -> Value {
        let state = self.state.lock().await;
        let healthy = state.wal_error.is_none() && !state.stopped;
        json!({
            "acceptingRequests": healthy && state.pending.len() < self.config.queue_max,
            "queued": state.queued.len(),
            "walPending": 0,
            "reserved": 0,
            "capacity": self.config.queue_max,
            "walHealthy": healthy,
            "walError": state.wal_error,
            "consecutiveFlushFailures": state.consecutive_failures,
            "lastFlushSucceededAt": state.last_success.map(db::iso),
            "lastFlushFailedAt": state.last_failure.map(db::iso),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_records_written_by_node() {
        // Produced by the Node backend's encodeWalPayload(), including
        // characters whose escaping could differ between serializers.
        let line = "{\"checksum\":\"65c90c81cd52b95fa59445751d5bf36f77d85f6c3c05181a737d6e112fb50e89\",\"payload\":{\"version\":1,\"operation\":\"put\",\"settlement\":{\"settlementId\":\"s-1\",\"intentId\":null,\"ownerUserId\":\"11111111-1111-4111-8111-111111111111\",\"apiKeyId\":null,\"charge\":\"12345\",\"isFinal\":true,\"streamEndReason\":\"stop\",\"path\":\"/backend-api/codex/responses\",\"modelId\":\"gpt-5.4\",\"serviceTier\":null,\"statusCode\":200,\"ttfbMs\":12,\"latencyMs\":40,\"tokensInfo\":{\"input_tokens\":10,\"output_tokens\":2,\"total_tokens\":12},\"totalTokens\":12,\"cost\":\"12345\",\"errorCode\":null,\"errorMessage\":\"引擎 \\\"x\\\"\\n\u{2028}\",\"requestTime\":\"2026-09-19T08:00:00.000Z\"}}}";
        let WalRecord::Put(settlement) = decode_record(line).unwrap() else {
            panic!("expected put");
        };
        assert_eq!(settlement.settlement_id, "s-1");
        assert_eq!(settlement.charge.to_string(), "0.00012345");
        // Re-encoding yields the exact same line.
        assert_eq!(
            encode_record(&put_payload(&settlement)),
            format!("{line}\n")
        );

        let tampered = line.replace("\"s-1\"", "\"s-2\"");
        assert!(decode_record(&tampered).is_err());
    }
}
