// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Disk-based cache service using cacache.

use crate::error::ApiError;
use serde::{de::DeserializeOwned, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

/// Content-addressable disk cache.
#[derive(Debug, Clone)]
pub struct DiskCache {
    cache_dir: PathBuf,
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

        Self { cache_dir: path }
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
        let cache_dir = self.cache_dir.clone();
        let prefix = format!("{key_prefix}-");
        let exact = key_prefix.to_string();

        // `cacache` only exposes a synchronous index iterator (it walks the
        // index directory on disk); run the scan + index-entry removal on a
        // blocking thread so it doesn't stall the async runtime. Integrities
        // are tracked by their string form (`Integrity` itself carries no
        // `Hash`/`Eq` impl) and re-parsed just before the hash-addressed
        // removal call, which is the only place that needs the typed value.
        let removed_integrities: Vec<String> = tokio::task::spawn_blocking(move || {
            let mut removed = Vec::new();
            for entry in cacache::list_sync(&cache_dir) {
                let Ok(meta) = entry else { continue };
                if meta.key == exact || meta.key.starts_with(&prefix) {
                    // Index-only removal: the content blob is left in place
                    // until the GC pass below confirms nothing else needs it.
                    if cacache::remove_sync(&cache_dir, &meta.key).is_ok() {
                        removed.push(meta.integrity.to_string());
                    }
                }
            }
            removed
        })
        .await?;

        if removed_integrities.is_empty() {
            return Ok(0);
        }

        let cache_dir = self.cache_dir.clone();
        tokio::task::spawn_blocking(move || {
            // Re-scan: whatever is still in the index after the removals
            // above is still live and its content must be kept, no matter
            // which key it is filed under.
            let mut still_referenced = std::collections::HashSet::new();
            for meta in cacache::list_sync(&cache_dir).flatten() {
                still_referenced.insert(meta.integrity.to_string());
            }
            for integrity_str in &removed_integrities {
                if !still_referenced.contains(integrity_str) {
                    // Best-effort: an orphaned blob left behind on a rare
                    // removal failure just wastes disk space, it never makes
                    // a surviving entry read as corrupt.
                    if let Ok(integrity) = integrity_str.parse::<cacache::Integrity>() {
                        let _ = cacache::remove_hash_sync(&cache_dir, &integrity);
                    }
                }
            }
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
