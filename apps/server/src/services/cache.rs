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
    // the BLOB-RECLAIM half of `remove_by_key_prefix` takes `write()`, so it
    // runs with no write in flight and no write can start until it finishes.
    // Its index-entry removals need no exclusion at all -- removing an index
    // entry can only orphan a blob, never unlink one out from under a
    // writer -- and are deliberately left outside the lock.
    write_gc_lock: Arc<RwLock<()>>,
}

/// cacache's on-disk index root inside a cache directory.
///
/// `cacache::list_sync` reports a cache nothing has ever been written to as a
/// `NotFound` walk error rather than as an empty iterator (its own
/// `list_sync` test asserts exactly that), so telling "empty" apart from
/// "unreadable" means knowing whether this directory exists. cacache does not
/// expose the path, so the layout is mirrored here -- `INDEX_VERSION` is `5`
/// in cacache 13.1.0, the same way `cache_tests::corrupt_stored_content`
/// mirrors the content layout. `index_root_matches_the_cacache_layout` fails
/// if a cacache bump moves it.
fn index_root(cache_dir: &std::path::Path) -> PathBuf {
    cache_dir.join("index-v5")
}

/// Classify an error yielded by `cacache::list_sync` on a walk that may be
/// starting from a cache that was never written to.
///
/// The ONE benign case takes BOTH halves of a conjunction, and each half
/// closes a different way of reading a broken cache as an empty one:
///
///  - the index root must be ABSENT, so the walk demonstrably never started.
///    A `NotFound` raised part-way through a walk (a bucket or subdirectory
///    disappearing under it) is a real failure; treating it as "the cache is
///    empty" is how a truncated walk gets to unlink live content.
///  - the cache directory itself must still be PRESENT. If it is gone too --
///    an unmounted volume, a wiped `CACHE_DIR` -- the same `NotFound` means
///    the store is unreadable, and answering "0 entries" would make a broken
///    cache indistinguishable from a healthy empty one.
///
/// Note what cacache does NOT report: `bucket_entries` drops unreadable and
/// unparseable index LINES silently (`map_while(Result::ok)` then a
/// `filter_map` that yields `None` for a bad line), and turns a `NotFound`
/// on opening a bucket into an empty vec. Only a failure to open a bucket
/// for some other reason (a permission error, say) and the directory walk
/// itself can produce the errors classified here.
///
/// `Some(err)` means "propagate this"; `None` means "the cache is empty, stop
/// walking".
fn classify_index_walk_error(cache_dir: &std::path::Path, err: cacache::Error) -> Option<ApiError> {
    if let cacache::Error::IoError(ref io, _) = err {
        // Both stat calls answer false on a permission error, and both land
        // on the safe side for that: an index root we cannot stat reads as
        // PRESENT (so a mid-walk error propagates) and a cache dir we cannot
        // stat reads as ABSENT (so an unreadable store propagates).
        if io.kind() == std::io::ErrorKind::NotFound
            && cache_dir.is_dir()
            && !index_root(cache_dir).exists()
        {
            return None;
        }
    }
    Some(ApiError::Cache(err.to_string()))
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
    ///
    /// Serializes and then delegates to [`Self::set_bytes`], so there is
    /// exactly one body that takes the `write_gc_lock` read guard around a
    /// `cacache::write` -- the invariant cannot drift between the two entry
    /// points.
    pub async fn set<T: Serialize>(&self, key: &str, value: &T) -> Result<(), ApiError> {
        let data = serde_json::to_vec(value)?;
        self.set_bytes(key, &data).await
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
        let cache_dir = self.cache_dir.clone();
        let prefix = format!("{key_prefix}-");
        let exact = key_prefix.to_string();
        let (prefix_phase2, exact_phase2) = (prefix.clone(), exact.clone());

        // PHASE 1 -- index-entry removals, deliberately OUTSIDE the exclusion
        // lock. Removing an index entry can only orphan a blob (wasted disk,
        // never a corrupt read); it cannot unlink content a concurrent writer
        // is committing. Only phase 2 below races `cacache::write`'s two-step
        // commit, so only phase 2 excludes writers.
        //
        // `cacache` only exposes a synchronous index iterator (it walks the
        // index directory on disk), so this runs on a blocking thread rather
        // than stalling the async runtime. Integrities are tracked by their
        // string form (`Integrity` itself carries no `Hash`/`Eq` impl) and
        // re-parsed just before the hash-addressed removal call, which is the
        // only place that needs the typed value.
        let removed_integrities: Vec<String> = tokio::task::spawn_blocking(move || {
            let mut removed = Vec::new();
            for entry in cacache::list_sync(&cache_dir) {
                // A walk that cannot complete is a real failure, not an
                // empty cache: swallowing it here would under-count
                // `deleted` and report a partial invalidation as a complete
                // `200`. (An individual index LINE that fails to read or
                // parse never reaches us -- cacache drops those silently --
                // so this catches walk failures and non-`NotFound` bucket
                // open failures, not corruption within a bucket.)
                let meta = match entry {
                    Ok(meta) => meta,
                    Err(e) => match classify_index_walk_error(&cache_dir, e) {
                        Some(err) => return Err(err),
                        None => break,
                    },
                };
                if (meta.key == exact || meta.key.starts_with(&prefix))
                    && cacache::remove_sync(&cache_dir, &meta.key).is_ok()
                {
                    removed.push(meta.integrity.to_string());
                }
            }
            Ok::<_, ApiError>(removed)
        })
        .await??;

        // PHASE 2 -- blob reclaim, under exclusion. The guard is OWNED and
        // moved into the blocking closure rather than held by this async fn:
        // a request future can be dropped mid-flight (`TimeoutLayer` firing,
        // a client disconnecting) and Tokio DETACHES a started
        // `spawn_blocking` task when its `JoinHandle` is dropped -- it
        // neither aborts nor waits. A guard held here would be released by
        // that drop while the blocking pass was still unlinking blobs, which
        // is exactly the window `write_gc_lock` exists to close. Owned by the
        // closure, it is released only when the blocking work itself ends.
        let guard = Arc::clone(&self.write_gc_lock).write_owned().await;
        let cache_dir = self.cache_dir.clone();
        let mut removed_integrities = removed_integrities;
        tokio::task::spawn_blocking(move || {
            let _guard = guard;

            // A SECOND walk, not the one phase 1 made. Phase 1 ran before the
            // lock was taken, so this walk does two jobs the first cannot:
            //
            //  - it sweeps up any MATCHING entry that a writer committed
            //    while phase 1 was scanning past it. Without this, narrowing
            //    the lock would let a concurrent cache fill survive the
            //    `DELETE` that was supposed to remove it; with it, every
            //    entry committed before the lock was acquired is removed,
            //    which is the guarantee holding the lock over both phases
            //    used to give.
            //  - it rebuilds "what is still referenced" under exclusion. Its
            //    phase-1 equivalent would be stale: an entry committed
            //    between that walk and this acquisition would be missing from
            //    the set, and its blob unlinked out from under a live entry.
            let mut still_referenced = std::collections::HashSet::new();
            // Deliberately NOT `classify_index_walk_error`: this walk decides
            // which blobs nothing references any more, so a walk that stops
            // early reads as "nothing references these" and licenses an
            // unlink that corrupts a surviving entry. Every error here
            // propagates, and the only "empty" this accepts is an index root
            // that does not exist at all -- checked once, before walking,
            // rather than inferred from an error mid-walk.
            if index_root(&cache_dir).exists() {
                for entry in cacache::list_sync(&cache_dir) {
                    let meta = entry.map_err(|e| ApiError::Cache(e.to_string()))?;
                    if (meta.key == exact_phase2 || meta.key.starts_with(&prefix_phase2))
                        && cacache::remove_sync(&cache_dir, &meta.key).is_ok()
                    {
                        // Removed just now, so it must NOT count as a live
                        // reference; its blob is a reclaim candidate like the
                        // rest. A failed removal falls through instead, which
                        // keeps the entry AND its content.
                        removed_integrities.push(meta.integrity.to_string());
                        continue;
                    }
                    still_referenced.insert(meta.integrity.to_string());
                }
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
            Ok::<usize, ApiError>(removed_integrities.len())
        })
        .await?
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
