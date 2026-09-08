// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! [`ItemDedupCache`] and its backing [`ItemDedupCacheState`].
//!
//! Split out of `router/mod.rs` (module-size ratchet) when #4083's
//! `diagnostic_claimed` companion set gave the type its own doc-worthy shape.

use crate::Mesh;
use rustc_hash::{FxHashMap, FxHashSet};
use std::sync::{Arc, Mutex};

/// Shared content-dedup cache: maps a 128-bit structural item hash to the
/// LOCAL (pre-placement, void-free, colour-free) item mesh PLUS its precomputed
/// instancing `rep_identity` (`Some` when instancing tagged it, else `None`).
/// Storing the rep beside the mesh lets a cache hit stamp it without re-running
/// the O(verts) `compute_mesh_hash_full` per occurrence. Build ONE per loaded
/// model with [`crate::GeometryRouter::new_dedup_cache`] and inject it into
/// every per-element / per-batch router via
/// [`crate::GeometryRouter::enable_content_dedup_shared`] so byte-identical
/// geometry is meshed once regardless of how the work is partitioned across
/// threads/batches.
///
/// Also carries `diagnostic_claimed` (#4083, double-count half only — see
/// [`ItemDedupCacheState::claim_diagnostic`]): a SEPARATE small key set, not a
/// diagnostic payload attached to `meshes`. It never changes what a mesh-cache
/// HIT returns (still no diagnostic — that omission half of #4083 is
/// untouched) and never gates mesh computation; it only lets two racing
/// routers that both MISS the (structurally identical) mesh cache agree on
/// which ONE of them keeps the CSG diagnostic it independently recorded for
/// that miss, so one logical operation is not counted twice.
pub type ItemDedupCache = Arc<ItemDedupCacheState>;

/// Backing state behind [`ItemDedupCache`]. Opaque outside this crate: every
/// field is private, and the only way to obtain or share one is
/// [`crate::GeometryRouter::new_dedup_cache`] /
/// [`crate::GeometryRouter::enable_content_dedup_shared`], so widening this
/// struct is not a public-API break for callers that follow that contract
/// (the only ones the type alias itself does not already lock into a
/// concrete map/lock shape).
#[derive(Default)]
pub struct ItemDedupCacheState {
    pub(super) meshes: Mutex<FxHashMap<u128, Arc<(Mesh, Option<u128>)>>>,
    /// item_dedup_keys for which some router sharing this cache has already
    /// recorded a CSG diagnostic this pass. See [`Self::claim_diagnostic`].
    diagnostic_claimed: Mutex<FxHashSet<u128>>,
}

impl ItemDedupCacheState {
    /// First caller for a given `key` wins (returns `true`, meaning: keep the
    /// diagnostic you just recorded); every later caller for the SAME key
    /// loses (returns `false`, meaning: discard it — another racing router
    /// already owns this logical operation's diagnostic). Never unclaims, so
    /// this is a per-pass, per-key latch, not a ref count.
    pub(super) fn claim_diagnostic(&self, key: u128) -> bool {
        self.diagnostic_claimed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key)
    }
}
