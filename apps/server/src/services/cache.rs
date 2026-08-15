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
}

#[cfg(test)]
mod cache_tests {
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
}
