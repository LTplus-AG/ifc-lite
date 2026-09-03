// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for `cache.rs`, split into this ratchet-exempt sibling file to
//! keep the production module under the module-size budget (same pattern as
//! `parquet_optimized_tests.rs`). As a child `#[cfg(test)] mod cache_tests`
//! it retains `use super::*` access to the parent's private items, so the
//! tests moved here verbatim.

    use super::*;

    /// Build a fresh, uniquely-named cache directory for a test.
    async fn fresh_cache(label: &str) -> (DiskCache, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "ifc-lite-server-cache-test-{}-{}",
            std::process::id(),
            label
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let cache = DiskCache::new(dir.to_str().unwrap()).await;
        (cache, dir)
    }

    /// Corrupt the underlying content-addressed blob for `key` (index entry
    /// stays intact) so a subsequent read fails with something other than
    /// `EntryNotFound` — e.g. an integrity/IO error.
    async fn corrupt_stored_content(dir: &std::path::Path, key: &str) {
        let entry = cacache::index::find_async(dir, key)
            .await
            .unwrap()
            .expect("index entry must exist before corrupting content");
        // Mirror cacache's own content-addressed layout (private `content`
        // module, so we can't call into it directly): `content-v2/<algo>/<hex[0..2]>/<hex[2..4]>/<rest>`.
        let (algo, hex) = entry.integrity.to_hex();
        let mut content_path = dir.to_path_buf();
        content_path.push("content-v2");
        content_path.push(algo.to_string());
        content_path.push(&hex[0..2]);
        content_path.push(&hex[2..4]);
        content_path.push(&hex[4..]);
        tokio::fs::remove_file(&content_path)
            .await
            .expect("content blob should exist to be removed");
    }

    /// A missing entry is reported as `Ok(None)`, not an error.
    #[tokio::test]
    async fn get_bytes_reports_a_missing_key_as_none_not_error() {
        let (cache, _dir) = fresh_cache("get-bytes-missing").await;
        let result = cache.get_bytes("does-not-exist").await;
        assert!(matches!(result, Ok(None)), "expected Ok(None), got {result:?}");
    }

    /// Once the index says an entry exists but the backing content blob is
    /// gone/corrupt, that is a real cache failure and must propagate as an
    /// error — it must NOT be swallowed into a cache-miss `Ok(None)`, which
    /// would silently mask disk corruption as "never cached".
    #[tokio::test]
    async fn get_bytes_propagates_non_missing_errors_instead_of_reporting_none() {
        let (cache, dir) = fresh_cache("get-bytes-corrupt").await;
        let key = "corrupt-key";
        cache.set_bytes(key, b"hello world").await.unwrap();
        corrupt_stored_content(&dir, key).await;

        let result = cache.get_bytes(key).await;
        assert!(
            matches!(result, Err(ApiError::Cache(_))),
            "expected a propagated Cache error for a corrupted entry, got {result:?}"
        );
    }

    /// Same asymmetry as `get_bytes`, pinned for the typed `get::<T>` path.
    #[tokio::test]
    async fn get_propagates_non_missing_errors_instead_of_reporting_none() {
        let (cache, dir) = fresh_cache("get-typed-corrupt").await;
        let key = "corrupt-typed-key";
        cache.set(key, &"hello".to_string()).await.unwrap();
        corrupt_stored_content(&dir, key).await;

        let result: Result<Option<String>, ApiError> = cache.get(key).await;
        assert!(
            matches!(result, Err(ApiError::Cache(_))),
            "expected a propagated Cache error for a corrupted entry, got {result:?}"
        );
    }

    #[tokio::test]
    async fn get_reports_a_missing_key_as_none_not_error() {
        let (cache, _dir) = fresh_cache("get-typed-missing").await;
        let result: Result<Option<String>, ApiError> = cache.get("does-not-exist").await;
        assert!(matches!(result, Ok(None)), "expected Ok(None), got {result:?}");
    }

    /// The cache is content-addressable: different content MUST map to
    /// different keys, or unrelated files would collide and one would
    /// silently serve another's cached data.
    #[test]
    fn generate_key_differs_for_different_content() {
        let a = DiskCache::generate_key(b"hello world");
        let b = DiskCache::generate_key(b"goodbye world");
        assert_ne!(a, b);
    }

    /// Deterministic: hashing the same bytes twice must produce the same key.
    #[test]
    fn generate_key_is_deterministic_for_the_same_content() {
        let a = DiskCache::generate_key(b"same content");
        let b = DiskCache::generate_key(b"same content");
        assert_eq!(a, b);
    }

    /// Pins the concrete algorithm (SHA256, hex-encoded) since callers
    /// (e.g. `routes/parse/cache_keys.rs`) rely on the exact digest shape.
    #[test]
    fn generate_key_matches_the_sha256_hex_digest() {
        let key = DiskCache::generate_key(b"hello world");
        assert_eq!(
            key,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    /// `DELETE /api/v1/cache/{hash}` (issue #3636) must remove every entry
    /// fanned out under one hash -- the bare request key plus the `-json-v2`,
    /// `-parquet-v5`, `-symbolic-v1`-shaped suffixes a real parse writes --
    /// while a DIFFERENT hash's entries (the control) survive untouched.
    #[tokio::test]
    async fn remove_by_key_prefix_deletes_every_suffixed_entry_for_one_hash_only() {
        let (cache, _dir) = fresh_cache("prefix-removal").await;
        let hash = "abc123";
        let other_hash = "def456";

        cache.set_bytes(hash, b"request-key-entry").await.unwrap();
        cache.set_bytes(&format!("{hash}-default"), b"filtered-entry").await.unwrap();
        cache
            .set_bytes(&format!("{hash}-default-json-v2"), b"json-entry")
            .await
            .unwrap();
        cache
            .set_bytes(&format!("{hash}-default-parquet-v5"), b"parquet-entry")
            .await
            .unwrap();
        cache
            .set_bytes(&format!("{hash}-default-symbolic-v1"), b"symbolic-entry")
            .await
            .unwrap();
        // Control: a different file's entry, which must survive.
        cache
            .set_bytes(&format!("{other_hash}-default"), b"unrelated-entry")
            .await
            .unwrap();

        let deleted = cache.remove_by_key_prefix(hash).await.unwrap();
        assert_eq!(deleted, 5, "expected all 5 entries under {hash} to be removed");

        assert!(cache.get_bytes(hash).await.unwrap().is_none());
        assert!(cache.get_bytes(&format!("{hash}-default")).await.unwrap().is_none());
        assert!(cache
            .get_bytes(&format!("{hash}-default-json-v2"))
            .await
            .unwrap()
            .is_none());
        assert!(cache
            .get_bytes(&format!("{hash}-default-parquet-v5"))
            .await
            .unwrap()
            .is_none());
        assert!(cache
            .get_bytes(&format!("{hash}-default-symbolic-v1"))
            .await
            .unwrap()
            .is_none());

        // Control survives.
        assert_eq!(
            cache.get_bytes(&format!("{other_hash}-default")).await.unwrap(),
            Some(b"unrelated-entry".to_vec())
        );
    }

    /// The `-` separator in `remove_by_key_prefix` exists specifically to
    /// reject a TRUNCATED prefix: `"abc"` must not match `"abc123-..."`
    /// entries just because it is a string prefix of the key. A client
    /// sending `DELETE /api/v1/cache/abc` (a truncated or mistyped hash)
    /// must not be able to reach a hash it never had -- it should delete
    /// nothing, and the real entry must stay readable.
    #[tokio::test]
    async fn remove_by_key_prefix_does_not_match_a_truncated_prefix() {
        let (cache, _dir) = fresh_cache("prefix-removal-truncated").await;
        let hash = "abc123";
        cache
            .set_bytes(&format!("{hash}-default"), b"filtered-entry")
            .await
            .unwrap();

        let deleted = cache.remove_by_key_prefix("abc").await.unwrap();
        assert_eq!(
            deleted, 0,
            "a truncated prefix must match nothing, not every key it happens \
             to be a string-prefix of"
        );
        assert_eq!(
            cache.get_bytes(&format!("{hash}-default")).await.unwrap(),
            Some(b"filtered-entry".to_vec()),
            "the real entry must survive a delete on its truncated prefix"
        );
    }

    /// Deleting a hash nothing was ever cached under is a no-op, not an
    /// error -- a client that just tells the server "drop this model, if
    /// anything is cached for it" must be able to call it unconditionally
    /// and retry safely.
    #[tokio::test]
    async fn remove_by_key_prefix_on_an_absent_hash_is_a_no_op() {
        let (cache, _dir) = fresh_cache("prefix-removal-absent").await;
        let deleted = cache.remove_by_key_prefix("never-cached-hash").await.unwrap();
        assert_eq!(deleted, 0);
    }

    /// Two different source files can produce byte-identical cached output
    /// (the issue's example: two IFCs that both emit an empty symbolic-data
    /// payload) and then share one content-addressed blob. Deleting one
    /// file's entries must NOT take the shared blob out from under the
    /// other's surviving entry.
    #[tokio::test]
    async fn remove_by_key_prefix_leaves_a_blob_shared_with_a_surviving_entry_intact() {
        let (cache, _dir) = fresh_cache("prefix-removal-shared-blob").await;
        let shared_payload = b"{}";
        cache.set_bytes("model-a-symbolic-v1", shared_payload).await.unwrap();
        cache.set_bytes("model-b-symbolic-v1", shared_payload).await.unwrap();

        let deleted = cache.remove_by_key_prefix("model-a").await.unwrap();
        assert_eq!(deleted, 1);

        assert!(cache.get_bytes("model-a-symbolic-v1").await.unwrap().is_none());
        // The other file's entry must still read back the shared blob.
        assert_eq!(
            cache.get_bytes("model-b-symbolic-v1").await.unwrap(),
            Some(shared_payload.to_vec())
        );
    }

    /// Once nothing references a blob any more, the GC pass reclaims it --
    /// not just the index entry.
    #[tokio::test]
    async fn remove_by_key_prefix_reclaims_a_blob_nothing_references_any_more() {
        let (cache, dir) = fresh_cache("prefix-removal-gc").await;
        let key = "solo-model-symbolic-v1";
        cache.set_bytes(key, b"unique payload, not shared").await.unwrap();
        let entry = cacache::index::find_async(&dir, key)
            .await
            .unwrap()
            .expect("index entry must exist before deletion");
        assert!(cacache::exists(&dir, &entry.integrity).await, "blob should exist before delete");

        let deleted = cache.remove_by_key_prefix("solo-model").await.unwrap();
        assert_eq!(deleted, 1);

        assert!(
            !cacache::exists(&dir, &entry.integrity).await,
            "blob should be reclaimed once nothing references it"
        );
    }

    #[tokio::test]
    async fn stats_reports_zero_for_an_empty_cache() {
        let (cache, _dir) = fresh_cache("stats-empty").await;
        let stats = cache.stats().await.unwrap();
        assert_eq!(stats.entries, 0);
        assert_eq!(stats.bytes, 0);
    }

    #[tokio::test]
    async fn stats_counts_entries_and_sums_their_sizes() {
        let (cache, _dir) = fresh_cache("stats-populated").await;
        cache.set_bytes("key-a", b"12345").await.unwrap(); // 5 bytes
        cache.set_bytes("key-b", b"1234567890").await.unwrap(); // 10 bytes

        let stats = cache.stats().await.unwrap();
        assert_eq!(stats.entries, 2);
        assert_eq!(stats.bytes, 15);
    }

    /// A cancelled `DELETE` must not hand the cache back to writers while
    /// its blob-reclaim pass is still running.
    ///
    /// `remove_by_key_prefix` does its blob reclaim on a blocking task, and
    /// Tokio DETACHES a started `spawn_blocking` task when its `JoinHandle`
    /// is dropped -- dropping the handle neither aborts nor waits for it. So
    /// when the request future is cancelled (a `TimeoutLayer` firing, a
    /// client disconnecting), an exclusion guard held by the async fn would
    /// be released right then, while the detached task is still unlinking
    /// blobs: precisely the window `write_gc_lock` exists to close, in which
    /// a concurrent `set`/`set_bytes` can have its content blob unlinked
    /// between cacache's blob-commit and index-insert halves.
    ///
    /// Pin that the guard travels WITH the blocking work: cancelling the
    /// request once the reclaim pass holds the lock does not release it, and
    /// it is released only when that pass has actually finished (at which
    /// point the entries really are gone).
    #[tokio::test]
    async fn a_cancelled_remove_by_key_prefix_holds_the_gc_lock_until_the_pass_ends() {
        let (cache, _dir) = fresh_cache("prefix-removal-cancelled").await;
        // Each entry gets unique content, so the reclaim pass has one blob
        // per entry to unlink and is comfortably still running when the
        // assertions below sample it.
        const ENTRIES: usize = 400;
        for i in 0..ENTRIES {
            cache
                .set_bytes(&format!("cancelme-v{i}"), format!("payload {i}").as_bytes())
                .await
                .unwrap();
        }

        let delete = tokio::spawn({
            let cache = cache.clone();
            async move { cache.remove_by_key_prefix("cancelme").await }
        });

        // Wait for the reclaim phase to actually take the lock. The
        // index-removal phase before it runs unlocked by design, so "the
        // lock is held" is the observable that says we are inside the window
        // this test is about.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while cache.write_gc_lock.try_read().is_ok() {
            assert!(
                std::time::Instant::now() < deadline,
                "never observed the blob-reclaim pass holding the exclusion lock"
            );
            tokio::task::yield_now().await;
        }

        // Cancel the request the way `TimeoutLayer` does, and await the
        // handle so the future is definitively dropped before we sample.
        delete.abort();
        assert!(delete.await.unwrap_err().is_cancelled(), "the request should have been cancelled");

        assert!(
            cache.write_gc_lock.try_read().is_err(),
            "the exclusion lock must still be held by the detached blocking pass; \
             a writer let in here can lose its content blob to the in-flight GC"
        );

        // ...and it is a real hand-off, not a leak: the pass finishes,
        // releases the guard, and the entries are actually gone.
        let released = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            Arc::clone(&cache.write_gc_lock).write_owned(),
        )
        .await
        .expect("the detached reclaim pass should finish and release the lock");
        drop(released);
        assert_eq!(cache.stats().await.unwrap().entries, 0, "every matching entry should be gone");
    }

    /// The benign case above (`stats_reports_zero_for_an_empty_cache`) and
    /// this one are the pair that matters: cacache reports a never-written
    /// cache as a `NotFound` walk error, so a blanket "treat a walk error as
    /// empty" would make a cache whose directory has gone away (an unmounted
    /// volume) report `entries=0 bytes=0` and scrape as perfectly healthy.
    /// An unreadable store must look DIFFERENT from an empty one.
    #[tokio::test]
    async fn stats_reports_a_vanished_cache_dir_as_an_error_not_an_empty_cache() {
        let (cache, dir) = fresh_cache("stats-vanished").await;
        cache.set_bytes("key-a", b"12345").await.unwrap();
        assert_eq!(cache.stats().await.unwrap().entries, 1, "sanity: the entry is counted");

        tokio::fs::remove_dir_all(&dir).await.unwrap();

        let result = cache.stats().await;
        assert!(
            matches!(result, Err(ApiError::Cache(_))),
            "a vanished cache dir must surface as an error, got {result:?}"
        );
    }

    /// Same asymmetry on the deletion path: a walk it cannot complete must
    /// not be reported as `{"deleted": 0}`, which a caller reads as "there
    /// was nothing to remove".
    #[tokio::test]
    async fn remove_by_key_prefix_reports_a_vanished_cache_dir_as_an_error() {
        let (cache, dir) = fresh_cache("prefix-removal-vanished").await;
        cache.set_bytes("gone-symbolic-v1", b"payload").await.unwrap();

        tokio::fs::remove_dir_all(&dir).await.unwrap();

        let result = cache.remove_by_key_prefix("gone").await;
        assert!(
            matches!(result, Err(ApiError::Cache(_))),
            "a vanished cache dir must surface as an error, got {result:?}"
        );
    }

    /// `index_root` mirrors a path cacache does not expose. If a cacache bump
    /// moves `INDEX_VERSION`, the mirror goes stale silently -- every walk
    /// error would then look benign ("no index root") and an unreadable cache
    /// would read as an empty one again. Pin both directions: absent before
    /// the first write, present after it.
    #[tokio::test]
    async fn index_root_matches_the_cacache_layout() {
        let (cache, dir) = fresh_cache("index-root-layout").await;
        assert!(
            !index_root(&dir).exists(),
            "a never-written cache should have no index root at {}",
            index_root(&dir).display()
        );

        cache.set_bytes("layout-probe", b"v").await.unwrap();

        assert!(
            index_root(&dir).is_dir(),
            "index_root() must name the directory cacache actually writes; \
             a cacache bump may have moved INDEX_VERSION"
        );
    }

