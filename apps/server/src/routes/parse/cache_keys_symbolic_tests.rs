// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Symbolic-cache round-trip tests for `cache_keys.rs`.
//!
//! Split out of `cache_keys.rs`'s inline `mod tests` to keep that module under
//! the 400-line ratchet (`rust/processing/tests/module_size_ratchet.rs`).
//!
//! The subject is the NaN "unresolved" sentinel. `world_y` is `f32::NAN` when
//! the placement chain resolved no elevation, and `hatch_angle_secondary` is
//! `f32::NAN` when a fill carries no cross-hatch — the sentinel exists so that
//! "unresolved" cannot be mistaken for `0.0`, which is a real elevation at
//! datum. JSON has no NaN: `serde_json` writes a non-finite float as `null`,
//! and the derived `Deserialize` could not read `null` back into an `f32`, so
//! `load_cached_symbolic` fell into its
//! `unwrap_or_else(|_| SymbolicData::default())` arm. ONE unresolved scalar
//! anywhere in the model therefore made the ENTIRE cached blob unreadable, and
//! every replayed request silently served no symbolic data at all.

use super::cache_keys::{cache_symbolic_data, load_cached_symbolic};
use crate::services::cache::DiskCache;
use ifc_lite_processing::{SymbolicCircle, SymbolicData};

/// Fresh on-disk cache in a uniquely-named temp directory.
async fn cache_for(label: &str) -> DiskCache {
    let dir = std::env::temp_dir().join(format!(
        "ifc-lite-server-symbolic-cache-{}-{label}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    DiskCache::new(dir.to_str().unwrap()).await
}

/// One circle whose elevation is `world_y`.
fn one_circle(world_y: f32) -> SymbolicData {
    let mut data = SymbolicData::default();
    data.circles.push(SymbolicCircle::full(
        42,
        "IFCANNOTATION".to_string(),
        1.5,
        2.5,
        3.0,
        world_y,
        "Annotation".to_string(),
    ));
    data
}

/// RED before the `nan_as_null` serde adapter: `load_cached_symbolic` failed
/// to parse the blob it had just written and returned `SymbolicData::default()`
/// — the model's whole 2D symbol set, silently gone.
///
/// Asserted with `is_nan()`, not `!is_finite()` — `Infinity` is also
/// non-finite and is not the sentinel.
#[tokio::test]
async fn unresolved_world_y_survives_the_symbolic_cache_round_trip() {
    let cache = cache_for("unresolved").await;
    let data = one_circle(f32::NAN);

    cache_symbolic_data(&cache, "unresolved-key", &data).await;
    let loaded = load_cached_symbolic(&cache, "unresolved-key").await;

    assert!(
        !loaded.is_empty(),
        "one unresolved world_y must not wipe the whole cached blob"
    );
    assert!(
        loaded.circles[0].world_y.is_nan(),
        "unresolved world_y must come back unresolved, got {}",
        loaded.circles[0].world_y
    );
}

/// BOUNDING CONTROL — passes before AND after the fix. A genuine `0.0`
/// elevation must still come back as exactly `0.0` and must never read as
/// unresolved. If these two ever converge, the sentinel has stopped meaning
/// anything and the fix is worse than the bug.
#[tokio::test]
async fn a_genuine_zero_elevation_survives_the_cache_and_is_not_unresolved() {
    let cache = cache_for("zero-elevation").await;

    cache_symbolic_data(&cache, "zero-key", &one_circle(0.0)).await;
    let loaded = load_cached_symbolic(&cache, "zero-key").await;

    assert!(!loaded.is_empty());
    assert_eq!(loaded.circles[0].world_y, 0.0);
    assert!(
        !loaded.circles[0].world_y.is_nan(),
        "a real 0.0 elevation must never read as unresolved"
    );
}

/// The two must remain distinguishable AFTER the cache hop, not merely
/// individually correct.
#[tokio::test]
async fn zero_and_unresolved_stay_distinct_through_the_cache() {
    let cache = cache_for("distinct").await;

    cache_symbolic_data(&cache, "zero", &one_circle(0.0)).await;
    cache_symbolic_data(&cache, "nan", &one_circle(f32::NAN)).await;

    let zero = load_cached_symbolic(&cache, "zero").await.circles[0].world_y;
    let unresolved = load_cached_symbolic(&cache, "nan").await.circles[0].world_y;

    assert!(!zero.is_nan() && zero == 0.0);
    assert!(unresolved.is_nan());
}
