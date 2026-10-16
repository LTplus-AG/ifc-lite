// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Disk-based cache service using cacache.

use super::cache_remove::classify_index_walk_error;
use crate::error::ApiError;
#[cfg(test)]
use serde::de::DeserializeOwned;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{RwLock, Semaphore};

/// Content-addressable disk cache.
#[derive(Debug, Clone)]
pub struct DiskCache {
    pub(super) cache_dir: PathBuf,
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
    // the BLOB-RECLAIM half of `remove_by_key_prefix` takes `write()`, so it
    // runs with no write in flight and no write can start until it finishes.
    // Its index-entry removals need no exclusion at all -- removing an index
    // entry can only orphan a blob, never unlink one out from under a
    // writer -- and are deliberately left outside the lock.
    pub(super) write_gc_lock: Arc<RwLock<()>>,
    /// One `remove_by_key_prefix` at a time, process-wide.
    ///
    /// The removal walks the whole index twice, and the second walk holds
    /// `write_gc_lock.write_owned()` for its duration. tokio's `RwLock` is
    /// write-preferring, so overlapping removals starve every cache write in
    /// the process, and a walk costs exactly the same for a key nothing was
    /// ever stored under. Lives on the cache, not on `Admission`, so every
    /// caller gets the bound without learning it exists, and the permit is
    /// carried INTO both blocking closures the same way the GC guard is: a
    /// permit held by the async fn would be released when a client drops the
    /// request mid-walk, while the walk itself runs on.
    pub(crate) index_walk: Arc<Semaphore>,
    /// The last index time [`Self::set_bytes`] stamped, so every write of a
    /// key gets a time of its own (see `cache_entry`'s eviction rule).
    write_clock: Arc<std::sync::atomic::AtomicU64>,
    /// Test seam (#7676, SERVER-6): how many entry CONTENTS this cache has
    /// read, so a test can tell an existence check from a whole-blob read.
    #[cfg(test)]
    pub(crate) content_reads: Arc<std::sync::atomic::AtomicUsize>,
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
            index_walk: Arc::new(Semaphore::new(1)),
            write_clock: Arc::default(),
            #[cfg(test)]
            content_reads: Arc::default(),
        }
    }

    /// Test seam (#7676): the directory this cache stores its entries in, so
    /// a test can damage one entry's content the way a partial write would.
    #[cfg(test)]
    pub(crate) fn dir_for_tests(&self) -> &std::path::Path {
        &self.cache_dir
    }

    /// Generate a cache key from file content (SHA256 hash).
    pub fn generate_key(data: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data);
        hex::encode(hasher.finalize())
    }

    /// Get a cached value by key. Test-only, like [`Self::get_bytes`]: a
    /// route reads through `cache_entry`'s policy (#7676).
    #[cfg(test)]
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
    ///
    /// Serializes and then delegates to [`Self::set_bytes`], so there is
    /// exactly one body that takes the `write_gc_lock` read guard around a
    /// `cacache::write` -- the invariant cannot drift between the two entry
    /// points.
    pub async fn set<T: Serialize>(&self, key: &str, value: &T) -> Result<(), ApiError> {
        let data = serde_json::to_vec(value)?;
        self.set_bytes(key, &data).await
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

    /// Raw read, reporting exactly what cacache reports. Test-only: a route
    /// reads through `cache_entry`'s policy instead (#7676), so there is one
    /// answer to "what does an unusable entry mean", and this is how a test
    /// inspects what the routes left on disk.
    #[cfg(test)]
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
        // The index row is stamped with a time no earlier write of this
        // process shares: parse output is deterministic, so a re-parse that
        // repairs an entry writes the SAME content hash, and the row's time
        // is what tells that write from the one a reader saw fail
        // (`cache_entry::evict_unusable`). A wall-clock millisecond alone
        // would not: two writes can land in one.
        use futures::io::AsyncWriteExt;
        let mut writer = cacache::WriteOpts::new()
            .size(data.len())
            .time(self.next_write_time())
            .open(&self.cache_dir, key)
            .await?;
        writer.write_all(data).await.map_err(|e| cacache::Error::IoError(e, "writing cache entry".into()))?;
        writer.commit().await?;
        tracing::debug!(key = %key, size = data.len(), "Cached raw bytes");
        Ok(())
    }

    /// Unix milliseconds, bumped past the previous call's value when the
    /// clock has not moved (or has gone back).
    fn next_write_time(&self) -> u128 {
        use std::sync::atomic::Ordering;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        let stamped = self
            .write_clock
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |last| Some(now.max(last.saturating_add(1))))
            .map_or(now, |last| now.max(last.saturating_add(1)));
        u128::from(stamped)
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
            for entry in cacache::list_sync(&cache_dir) {
                // Never `flatten()` here: a walk that cannot complete (an
                // unmounted or permission-denied `CACHE_DIR`) would then be
                // indistinguishable from an empty cache, and the gauges would
                // report `entries=0 bytes=0` as if the cache were healthy.
                let meta = match entry {
                    Ok(meta) => meta,
                    Err(e) => match classify_index_walk_error(&cache_dir, e) {
                        Some(err) => return Err(err),
                        None => break,
                    },
                };
                stats.entries += 1;
                stats.bytes += meta.size as u64;
            }
            Ok::<_, ApiError>(stats)
        })
        .await?
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
