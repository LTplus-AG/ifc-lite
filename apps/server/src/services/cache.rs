// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Disk-based cache service using cacache.

use crate::error::ApiError;
use serde::{de::DeserializeOwned, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Content-addressable disk cache.
#[derive(Debug, Clone)]
pub struct DiskCache {
    cache_dir: PathBuf,
    // Excludes a `set`/`set_bytes` write from `remove_by_key_prefix`'s GC
    // pass, and nothing else. `cacache::write` commits in two steps -- the
    // content blob is finalized first, the index entry inserted second
    // (`Writer::commit` in the vendored cacache) -- so a write and a GC pass
    // CAN interleave: the GC pass's "list index, drop blobs nothing
    // references" scan can run between those two halves of a concurrent
    // write, see the blob but no index entry pointing at it yet, and unlink
    // it out from under the writer that is about to insert that very entry.
    // The blob is content-addressed, so this only bites when the concurrent
    // write's bytes hash to a blob the GC pass just unreferenced -- exactly
    // the case `remove_by_key_prefix`'s own docstring calls out (two source
    // files sharing one output blob) -- but when it does, the surviving
    // entry then reads as corrupt on every later `get`/`get_bytes`, which is
    // the one failure mode that method's ordering was written to prevent.
    // `read()` here is shared among concurrent writers (they may still race
    // each other inside `cacache::write`, which is safe on its own); only
    // the GC pass takes `write()`, so it runs with no write in flight and no
    // write can start until it finishes.
    write_gc_lock: Arc<RwLock<()>>,
}

impl DiskCache {
    /// Create a new cache in the specified directory.
    pub async fn new(cache_dir: &str) -> Self {
        let path = PathBuf::from(cache_dir);

        // Create cache directory if it doesn't exist
        if let Err(e) = tokio::fs::create_dir_all(&path).await {
            tracing::warn!(
                error = %e,
                path = %path.display(),
                "Failed to create cache directory"
            );
        }

        Self {
            cache_dir: path,
            write_gc_lock: Arc::new(RwLock::new(())),
        }
    }

    /// Generate a cache key from file content (SHA256 hash).
    pub fn generate_key(data: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data);
        hex::encode(hasher.finalize())
    }

    /// Get a cached value by key.
    pub async fn get<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>, ApiError> {
        match cacache::read(&self.cache_dir, key).await {
            Ok(data) => {
                let value: T = serde_json::from_slice(&data)?;
                Ok(Some(value))
            }
            Err(cacache::Error::EntryNotFound(_, _)) => Ok(None),
            Err(e) => Err(ApiError::Cache(e.to_string())),
        }
    }

    /// Set a cached value.
    pub async fn set<T: Serialize>(&self, key: &str, value: &T) -> Result<(), ApiError> {
        let data = serde_json::to_vec(value)?;
        // Excludes `remove_by_key_prefix`'s GC pass, not other concurrent
        // writers -- see `write_gc_lock`'s docstring.
        let _guard = self.write_gc_lock.read().await;
        cacache::write(&self.cache_dir, key, &data).await?;
        tracing::debug!(key = %key, size = data.len(), "Cached result");
        Ok(())
    }

    /// Check if a key exists in the cache.
    pub async fn has(&self, key: &str) -> bool {
        cacache::metadata(&self.cache_dir, key).await.is_ok()
    }

    /// Remove a cached entry.
    #[allow(dead_code)]
    pub async fn remove(&self, key: &str) -> Result<(), ApiError> {
        cacache::remove(&self.cache_dir, key).await?;
        Ok(())
    }

    /// Clear all cached entries.
    #[allow(dead_code)]
    pub async fn clear(&self) -> Result<(), ApiError> {
        cacache::clear(&self.cache_dir).await?;
        Ok(())
    }

    /// Get raw bytes from cache (for Parquet responses).
    pub async fn get_bytes(&self, key: &str) -> Result<Option<Vec<u8>>, ApiError> {
        match cacache::read(&self.cache_dir, key).await {
            Ok(data) => Ok(Some(data)),
            Err(cacache::Error::EntryNotFound(_, _)) => Ok(None),
            Err(e) => Err(ApiError::Cache(e.to_string())),
        }
    }

    /// Set raw bytes in cache.
    pub async fn set_bytes(&self, key: &str, data: &[u8]) -> Result<(), ApiError> {
        // Excludes `remove_by_key_prefix`'s GC pass, not other concurrent
        // writers -- see `write_gc_lock`'s docstring.
        let _guard = self.write_gc_lock.read().await;
        cacache::write(&self.cache_dir, key, data).await?;
        tracing::debug!(key = %key, size = data.len(), "Cached raw bytes");
        Ok(())
    }

    /// Remove every index entry whose key is `key_prefix` itself or starts with
    /// `"{key_prefix}-"` (issue #3636). One source file fans out into several
    /// entries under the same hash prefix -- the plain request key, the
    /// `-json-v2`, `-parquet-vN`, `-parquet-metadata-v4` and `-symbolic-v1`
    /// variants, each combination of opening-filter and quality suffix -- and
    /// `DELETE /api/v1/cache/{sha256}` is meant to drop all of them for that
    /// file in one call.
    ///
    /// The underlying store is content-addressable: two different source
    /// files can produce byte-identical output (the issue's example is two
    /// different IFCs that both emit an empty symbolic-data payload) and then
    /// share one content blob across two index entries. So this removes
    /// INDEX ENTRIES first -- an index-only removal (`cacache::remove`) is
    /// exactly the operation the issue's own hand-pruning experiment found
    /// safe: leaving a blob temporarily orphaned makes it unreachable but
    /// never makes a *surviving* entry read as corrupt, whereas removing a
    /// blob a live index entry still points at does (their write-up
    /// reproduced the resulting 500s). Only once every matching index entry
    /// is gone does this walk the remaining index and drop content blobs
    /// that nothing references any more; a blob still referenced by an
    /// unrelated entry is left alone.
    ///
    /// Returns the number of index entries removed. Zero is a normal,
    /// successful result for a prefix nothing was ever cached under, or that
    /// already had its entries removed -- deleting an absent entry is a
    /// no-op, not an error, so a retried or duplicate `DELETE` stays safe.
    pub async fn remove_by_key_prefix(&self, key_prefix: &str) -> Result<usize, ApiError> {
        // Owned, so it can be MOVED INTO the blocking closure below rather
        // than held by this async fn: a request future can be dropped
        // mid-flight (a `TimeoutLayer` firing, a client disconnecting), and
        // `spawn_blocking` work that has already started keeps running when
        // its `JoinHandle` is dropped. A guard held here would be released
        // by that drop while the GC pass is still walking the index, letting
        // a `set`/`set_bytes` write interleave with blob removal -- the
        // exact race `write_gc_lock` exists to close. Owned by the closure,
        // the guard is released only when the blocking work itself ends.
        let guard = Arc::clone(&self.write_gc_lock).write_owned().await;

        let cache_dir = self.cache_dir.clone();
        let prefix = format!("{key_prefix}-");
        let exact = key_prefix.to_string();

        // `cacache` only exposes a synchronous index iterator (it walks the
        // index directory on disk); run the scan, the index-entry removals
        // and the blob GC on one blocking thread so they don't stall the
        // async runtime and cannot be split apart by a cancellation.
        // Integrities are tracked by their string form (`Integrity` itself
        // carries no `Hash`/`Eq` impl) and re-parsed just before the
        // hash-addressed removal call, which is the only place that needs
        // the typed value.
        tokio::task::spawn_blocking(move || {
            let mut removed_integrities: Vec<String> = Vec::new();
            for entry in cacache::list_sync(&cache_dir) {
                let Ok(meta) = entry else { continue };
                if meta.key == exact || meta.key.starts_with(&prefix) {
                    // Index-only removal: the content blob is left in place
                    // until the GC pass below confirms nothing else needs it.
                    if cacache::remove_sync(&cache_dir, &meta.key).is_ok() {
                        removed_integrities.push(meta.integrity.to_string());
                    }
                }
            }

            if !removed_integrities.is_empty() {
                // Re-scan: whatever is still in the index after the removals
                // above is still live and its content must be kept, no
                // matter which key it is filed under.
                let mut still_referenced = std::collections::HashSet::new();
                for meta in cacache::list_sync(&cache_dir).flatten() {
                    still_referenced.insert(meta.integrity.to_string());
                }
                for integrity_str in &removed_integrities {
                    if !still_referenced.contains(integrity_str) {
                        // Best-effort: an orphaned blob left behind on a rare
                        // removal failure just wastes disk space, it never
                        // makes a surviving entry read as corrupt.
                        if let Ok(integrity) = integrity_str.parse::<cacache::Integrity>() {
                            let _ = cacache::remove_hash_sync(&cache_dir, &integrity);
                        }
                    }
                }
            }

            // Explicit: the exclusion window ends here, with the blocking
            // work, not at the (possibly cancelled) await above.
            drop(guard);
            removed_integrities.len()
        })
        .await
        .map_err(ApiError::from)
    }

    /// Cache-wide entry count and total content size in bytes, for the
    /// `/api/v1/metrics` gauges (issue #3636). Sums `Metadata::size` across
    /// every index entry; entries sharing a deduplicated content blob are
    /// each counted once (as stored), matching what `remove_by_key_prefix`
    /// treats as "still referenced".
    pub async fn stats(&self) -> Result<CacheStats, ApiError> {
        let cache_dir = self.cache_dir.clone();
        tokio::task::spawn_blocking(move || {
            let mut stats = CacheStats::default();
            for meta in cacache::list_sync(&cache_dir).flatten() {
                stats.entries += 1;
                stats.bytes += meta.size as u64;
            }
            stats
        })
        .await
        .map_err(ApiError::from)
    }
}

/// Cache-wide totals reported by [`DiskCache::stats`].
#[derive(Debug, Clone, Copy, Default)]
pub struct CacheStats {
    pub entries: u64,
    pub bytes: u64,
}

#[cfg(test)]
#[path = "cache_tests.rs"]
mod cache_tests;
