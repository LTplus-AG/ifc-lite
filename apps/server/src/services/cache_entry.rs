// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! THE policy for a cache entry a route acts on (#7676: SERVER-6, SERVER-12).
//!
//! Every route reads through here, so there is one answer to each question:
//!
//! - **Is it there?** [`DiskCache::lookup`]: the index row plus a stat of its
//!   content blob. It never reads the content, so an existence check costs
//!   the same for a 3 KB sidecar and a 60 MB data model, and a route can ask
//!   it before taking an admission slot. The entry it returns carries the
//!   stored size, which is what a read is admitted for.
//! - **Read it.** [`DiskCache::read_entry`] / [`DiskCache::read_usable`]:
//!   the whole content, integrity-checked by cacache.
//! - **What if the entry is unusable?** A blob that is gone, fails its
//!   integrity check, or does not decode as what the reader expects is a
//!   MISS, and the index row is removed, but only while it still names the
//!   integrity that failed (a writer may have replaced the entry since the
//!   reader's lookup). A route holding the upload
//!   re-parses and overwrites it; a read-only route answers its miss status.
//!   Removing the row is what keeps the existence checks honest: without it
//!   `GET /cache/check` would keep sending a client to an entry every reader
//!   refuses. Answering 500 instead is what used to break a file on a route
//!   forever, because the parse that repairs the entry is what the error
//!   skipped.
//! - **What if the store itself fails?** An index that cannot be read is
//!   `Err(ApiError::Cache)`, a `500 CACHE_ERROR` (#5750): that is an operator
//!   problem a re-parse cannot fix, and reporting it as "absent" would hide
//!   it.

use super::cache::DiskCache;
use crate::error::ApiError;
use serde::de::DeserializeOwned;

/// An index entry whose content blob is on disk, found without reading it.
#[derive(Debug, Clone)]
pub struct CacheEntry {
    integrity: cacache::Integrity,
    size: u64,
}

impl CacheEntry {
    /// The stored size in bytes, as the index recorded it at write time.
    pub fn size(&self) -> u64 {
        self.size
    }
}

impl DiskCache {
    /// Whether `key` names an entry with content on disk, and its size.
    /// Reads the index and stats the blob; never reads the content.
    ///
    /// `Ok(None)` for no row, and for a row whose blob is gone (an
    /// interrupted write or a partial GC), which is also evicted.
    pub async fn lookup(&self, key: &str) -> Result<Option<CacheEntry>, ApiError> {
        let Some(meta) = cacache::metadata(&self.cache_dir, key).await? else {
            return Ok(None);
        };
        if !cacache::exists(&self.cache_dir, &meta.integrity).await {
            self.evict_unusable(key, &meta.integrity, "its content blob is missing").await;
            return Ok(None);
        }
        Ok(Some(CacheEntry {
            integrity: meta.integrity,
            size: meta.size as u64,
        }))
    }

    /// The content of an entry [`Self::lookup`] found, or `None` (and the
    /// row evicted) when it is unusable. Infallible by design: whatever fails
    /// here is the entry, not the store.
    pub async fn read_entry(&self, key: &str, entry: &CacheEntry) -> Option<Vec<u8>> {
        #[cfg(test)]
        self.content_reads.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        match cacache::read_hash(&self.cache_dir, &entry.integrity).await {
            Ok(bytes) => Some(bytes),
            Err(e) => {
                self.evict_entry(key, entry, e).await;
                None
            }
        }
    }

    /// [`Self::lookup`] then [`Self::read_entry`]: the content of `key`, or
    /// `None` when it is absent or unusable.
    pub async fn read_usable(&self, key: &str) -> Result<Option<Vec<u8>>, ApiError> {
        Ok(self.read_usable_entry(key).await?.map(|(bytes, _)| bytes))
    }

    /// [`Self::read_usable`], also returning the entry that was read, for a
    /// caller that decodes the bytes and must hand a decode failure to
    /// [`Self::evict_entry`].
    pub async fn read_usable_entry(&self, key: &str) -> Result<Option<(Vec<u8>, CacheEntry)>, ApiError> {
        let Some(entry) = self.lookup(key).await? else {
            return Ok(None);
        };
        Ok(self.read_entry(key, &entry).await.map(|bytes| (bytes, entry)))
    }

    /// [`Self::read_usable`] for a UTF-8 entry (a stored response header).
    /// Bytes that are not UTF-8 make the entry unusable.
    pub async fn read_usable_utf8(&self, key: &str) -> Result<Option<String>, ApiError> {
        let Some((bytes, entry)) = self.read_usable_entry(key).await? else {
            return Ok(None);
        };
        Ok(self.usable(key, &entry, String::from_utf8(bytes)).await)
    }

    /// [`Self::read_usable`] for a JSON entry. An entry that does not decode
    /// as `T` is unusable. For a model-sized entry, read the bytes and decode
    /// them on the blocking pool instead, then hand the result to
    /// [`Self::usable`].
    pub async fn read_usable_json<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>, ApiError> {
        let Some((bytes, entry)) = self.read_usable_entry(key).await? else {
            return Ok(None);
        };
        Ok(self.usable(key, &entry, serde_json::from_slice(&bytes)).await)
    }

    /// The decoded value, or `None` with the entry evicted when it did not
    /// decode: the one place a reader's decode failure becomes a miss.
    pub async fn usable<T, E: std::fmt::Display>(
        &self,
        key: &str,
        entry: &CacheEntry,
        decoded: Result<T, E>,
    ) -> Option<T> {
        match decoded {
            Ok(value) => Some(value),
            Err(e) => {
                self.evict_entry(key, entry, format!("it does not decode: {e}")).await;
                None
            }
        }
    }

    /// Evict `entry`, the one a reader looked up and found unusable, unless
    /// `key` names something else by now.
    pub async fn evict_entry(&self, key: &str, entry: &CacheEntry, why: impl std::fmt::Display) {
        self.evict_unusable(key, &entry.integrity, why).await;
    }

    /// Drop the index row of `key` if it still names `failed`, the integrity
    /// a reader could not use, so every route agrees it is a miss. Content
    /// blobs are left to `remove_by_key_prefix`'s GC: another entry may share
    /// one.
    ///
    /// A reader's lookup and its failed read are separated by an admission
    /// wait of up to `queue_timeout`, long enough for another request to
    /// re-parse and rewrite the entry. Removing by key name would then drop
    /// that good entry (and a data-model sidecar has no re-parse behind it:
    /// its route answers a final 404). So the row is re-read under
    /// `write_gc_lock.write()`, which excludes a writer between its blob and
    /// its index insert, and removed only when it still names `failed`.
    async fn evict_unusable(&self, key: &str, failed: &cacache::Integrity, why: impl std::fmt::Display) {
        tracing::warn!(cache_key = %key, reason = %why, "Unusable cache entry; treating it as a miss");
        let _exclusive = self.write_gc_lock.write().await;
        match cacache::metadata(&self.cache_dir, key).await {
            Ok(Some(row)) if row.integrity == *failed => {
                if let Err(e) = cacache::remove(&self.cache_dir, key).await {
                    tracing::warn!(cache_key = %key, error = %e, "Failed to evict an unusable cache entry");
                }
            }
            Ok(_) => {
                tracing::debug!(cache_key = %key, "Cache entry was replaced since the failed read; keeping it");
            }
            Err(e) => {
                tracing::warn!(cache_key = %key, error = %e, "Failed to re-read the index before evicting");
            }
        }
    }
}

#[cfg(test)]
#[path = "cache_entry_tests.rs"]
mod cache_entry_tests;
