// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `DiskCache::remove_by_key_prefix` and the index-walk helpers it alone
//! uses. A sibling of `cache.rs` because the removal is the one operation
//! that walks the whole cacache index, twice, under two gates, and its
//! argument is long enough that `cache.rs` crossed the module-size ratchet
//! carrying it.

use super::cache::DiskCache;
use crate::error::ApiError;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::OwnedSemaphorePermit;

/// `Retry-After` handed to a caller whose removal was shed because another
/// walk was in flight. Removal is idempotent and retry-safe, so shedding
/// costs a legitimate client one retry, where queueing would let a caller
/// park unbounded requests on work that starves cache writes.
const INDEX_WALK_RETRY_AFTER_SECS: u64 = 5;

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
pub(super) fn index_root(cache_dir: &std::path::Path) -> PathBuf {
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
pub(super) fn classify_index_walk_error(cache_dir: &std::path::Path, err: cacache::Error) -> Option<ApiError> {
    if let cacache::Error::IoError(ref io, _) = err {
        if io.kind() != std::io::ErrorKind::NotFound {
            return Some(ApiError::Cache(err.to_string()));
        }
        // `Path::exists`/`is_dir` answer FALSE for a stat that failed, which
        // is the wrong answer in the direction that matters: a permission
        // error on the index root would read as "absent" and license the
        // benign verdict. `try_exists` separates "it is not there" from "I
        // could not tell", and only the former may be called empty.
        let index_root_absent = match index_root(cache_dir).try_exists() {
            Ok(present) => !present,
            // Could not tell. Never benign -- report the walk error, and say
            // why the classification could not be made.
            Err(stat_err) => {
                return Some(ApiError::Cache(format!(
                    "{err} (could not stat the cache index root: {stat_err})"
                )))
            }
        };
        // Same rule for the cache directory: a stat that fails is not
        // evidence that it is there, and only a directory we positively
        // found may be called a healthy empty cache.
        let cache_dir_present = match cache_dir.try_exists() {
            Ok(present) => present,
            Err(stat_err) => {
                return Some(ApiError::Cache(format!(
                    "{err} (could not stat the cache directory: {stat_err})"
                )))
            }
        };
        if cache_dir_present && index_root_absent {
            return None;
        }
    }
    Some(ApiError::Cache(err.to_string()))
}

impl DiskCache {
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
        // Deliberately non-blocking (see `index_walk`): a concurrent removal
        // is shed, never queued.
        let walk_permit = Arc::clone(&self.index_walk).try_acquire_owned().map_err(|_| {
            tracing::warn!("Cache index walk already in flight; shedding this one");
            ApiError::Overloaded { retry_after_secs: INDEX_WALK_RETRY_AFTER_SECS }
        })?;
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
        // The walk permit rides in the closure and comes back out with the
        // result, so it covers exactly the blocking work: dropped request
        // future or not, phase 1 holds it until phase 1 ends, and a dropped
        // `JoinHandle` between the phases releases it without starting phase 2.
        let (removed_integrities, walk_permit): (Vec<String>, OwnedSemaphorePermit) =
            tokio::task::spawn_blocking(move || {
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
            Ok::<_, ApiError>((removed, walk_permit))
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
            let _walk_permit = walk_permit;

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
            // `try_exists`, never `exists`: the latter answers false for a
            // stat that FAILED, so a permission error on the index root
            // would skip this walk, leave `still_referenced` empty, and send
            // every integrity in `removed_integrities` to the unlink loop
            // below with no reference check at all. "I could not tell" must
            // abort the pass, not silently authorise it.
            if index_root(&cache_dir)
                .try_exists()
                .map_err(|e| ApiError::Cache(format!("could not stat the cache index root: {e}")))?
            {
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
}
