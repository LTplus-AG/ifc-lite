// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The cache-entry policy (#7676): what each kind of unusable entry and a
//! broken store mean, at the one place every route reads through.

use super::*;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

async fn fresh(label: &str) -> (DiskCache, PathBuf) {
    let dir = std::env::temp_dir().join(format!("ifc-lite-server-cache-entry-{}-{label}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    (DiskCache::new(dir.to_str().unwrap()).await, dir)
}

/// cacache's content path for `key` (its `content` module is private; the
/// layout is mirrored the way `cache_tests::corrupt_stored_content` does).
async fn blob_path(dir: &Path, key: &str) -> PathBuf {
    let entry = cacache::index::find_async(dir, key).await.unwrap().unwrap();
    let (algo, hex) = entry.integrity.to_hex();
    dir.join("content-v2").join(algo.to_string()).join(&hex[0..2]).join(&hex[2..4]).join(&hex[4..])
}

async fn index_row(dir: &Path, key: &str) -> bool {
    cacache::metadata(dir, key).await.unwrap().is_some()
}

#[tokio::test]
async fn a_present_entry_is_found_by_size_without_reading_it() {
    let (cache, _dir) = fresh("present").await;
    cache.set_bytes("k", &[7u8; 12_345]).await.unwrap();

    let entry = cache.lookup("k").await.unwrap().expect("the entry is there");
    assert_eq!(entry.size(), 12_345);
    assert_eq!(cache.content_reads.load(Ordering::SeqCst), 0, "lookup read the content");

    assert_eq!(cache.read_entry("k", &entry).await.unwrap(), vec![7u8; 12_345]);
    assert_eq!(cache.content_reads.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn an_absent_key_is_a_miss() {
    let (cache, _dir) = fresh("absent").await;
    assert!(cache.lookup("nope").await.unwrap().is_none());
    assert!(cache.read_usable("nope").await.unwrap().is_none());
}

/// An index row whose blob is gone (interrupted write, partial GC) is a miss
/// at the existence check already, and the row is dropped.
#[tokio::test]
async fn a_row_without_content_is_a_miss_and_is_evicted() {
    let (cache, dir) = fresh("orphan").await;
    cache.set_bytes("k", b"hello").await.unwrap();
    std::fs::remove_file(blob_path(&dir, "k").await).unwrap();

    assert!(cache.lookup("k").await.unwrap().is_none());
    assert!(!index_row(&dir, "k").await, "the orphaned row was left in the index");
}

/// A blob that fails its integrity check passes the existence check (which
/// does not read it) but is a miss for every reader, and is evicted so the
/// existence check agrees from then on.
#[tokio::test]
async fn damaged_content_is_a_miss_for_readers_and_is_evicted() {
    let (cache, dir) = fresh("damaged").await;
    cache.set_bytes("k", b"hello world").await.unwrap();
    let path = blob_path(&dir, "k").await;
    let _ = std::fs::remove_file(&path);
    std::fs::write(&path, b"HELLO WORLD").unwrap();

    let entry = cache.lookup("k").await.unwrap().expect("a stat cannot see the damage");
    assert!(cache.read_entry("k", &entry).await.is_none());
    assert!(cache.lookup("k").await.unwrap().is_none(), "the damaged row survived its failed read");
}

/// A value that does not decode as what the reader expects is unusable too.
#[tokio::test]
async fn content_that_does_not_decode_is_a_miss_and_is_evicted() {
    let (cache, dir) = fresh("undecodable").await;
    cache.set_bytes("json", b"{not json").await.unwrap();
    cache.set_bytes("utf8", &[0xff, 0xfe]).await.unwrap();

    assert!(cache.read_usable_json::<serde_json::Value>("json").await.unwrap().is_none());
    assert!(cache.read_usable_utf8("utf8").await.unwrap().is_none());
    assert!(!index_row(&dir, "json").await && !index_row(&dir, "utf8").await);

    cache.set_bytes("good", br#"{"a":1}"#).await.unwrap();
    let value: serde_json::Value = cache.read_usable_json("good").await.unwrap().unwrap();
    assert_eq!(value["a"], 1);
}

/// A store that cannot be read is an error, never "absent": `CACHE_DIR`
/// replaced by a plain file fails every index lookup (#5750).
#[tokio::test]
async fn a_broken_store_is_an_error_not_a_miss() {
    let (cache, dir) = fresh("broken").await;
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::write(&dir, b"not a cache directory").unwrap();

    let lookup = cache.lookup("k").await;
    let read = cache.read_usable("k").await;
    let _ = std::fs::remove_file(&dir);
    assert!(matches!(lookup, Err(ApiError::Cache(_))), "{lookup:?}");
    assert!(matches!(read, Err(ApiError::Cache(_))), "{read:?}");
}
