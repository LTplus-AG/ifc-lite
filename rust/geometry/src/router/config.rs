// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The router's value-type configuration: everything a caller decides before
//! any geometry is produced (C2-4). [`GeometryRouter::from_config`] builds a
//! router from one; [`GeometryRouter::config`] reads the effective one back.
//! The `with_*` constructors and `set_*` methods stay as thin delegates.

use crate::tessellation::TessellationQuality;
use crate::GeometryRouter;

/// How a [`GeometryRouter`] meshes. Plain data: `Clone`, comparable, built once
/// per load and handed to every per-element or per-batch router.
#[derive(Clone, Debug, PartialEq)]
pub struct RouterConfig {
    /// Unit scale factor (e.g. 0.001 for millimetres to metres), applied to all
    /// mesh positions after processing. A non-finite or non-positive scale
    /// refuses the router (see [`GeometryRouter::length_unit_refused`]) and the
    /// effective scale reads back as 1.0.
    pub unit_scale: f64,
    /// RTC (Relative-to-Center) offset, subtracted from world positions in f64
    /// before converting to f32 to preserve precision (e.g. Swiss UTM).
    pub rtc_offset: (f64, f64, f64),
    /// Tessellation detail level, passed to every processor's `process`.
    pub tessellation_quality: TessellationQuality,
    /// Per-router local-frame choice. `None` retains the target/env default;
    /// appearance authoring sets this explicitly so its canonical surface
    /// identity cannot vary between native and wasm builds (#4550). Mesh caches
    /// are frame-dependent, so it is fixed before any geometry is produced.
    pub local_frame: Option<bool>,
    /// Per-build small-cut skip (#1286): a solid-solid DIFFERENCE with a tiny
    /// cutter is dropped without forcing a preview tessellation tier. Scoped to
    /// the router, so concurrent native builds never bleed the flag into one
    /// another. `false` keeps every cut.
    pub skip_small_cuts: bool,
    /// #1623 Phase 3 template-selection mode for the don't-bake path. `false`
    /// (NATIVE): the deterministic global template is the plan's min-id
    /// occurrence. `true` (the WASM per-BATCH path): the FIRST occurrence of
    /// each source this router sees is the template, so each per-batch shard is
    /// self-contained. Both emit geometrically identical world triangles.
    pub instancing_batch_local: bool,
}

impl Default for RouterConfig {
    fn default() -> Self {
        Self {
            unit_scale: 1.0, // base meters
            rtc_offset: (0.0, 0.0, 0.0),
            tessellation_quality: TessellationQuality::Medium,
            local_frame: None,
            skip_small_cuts: false,
            instancing_batch_local: false,
        }
    }
}

impl GeometryRouter {
    /// A router with `config` applied. Like [`GeometryRouter::new`] it arms no
    /// caches: inject the shared ones (`enable_content_dedup_shared`,
    /// `enable_shared_mapped_item_cache`, ...) afterwards.
    pub fn from_config(config: RouterConfig) -> Self {
        let mut router = Self::new();
        router.set_unit_scale(config.unit_scale);
        router.config.rtc_offset = config.rtc_offset;
        router.config.tessellation_quality = config.tessellation_quality;
        router.config.local_frame = config.local_frame;
        router.config.instancing_batch_local = config.instancing_batch_local;
        router.set_skip_small_cuts(config.skip_small_cuts);
        router
    }

    /// The effective configuration, including later `set_*` changes.
    pub fn config(&self) -> &RouterConfig {
        &self.config
    }
}

#[cfg(test)]
#[path = "config_tests.rs"]
mod config_tests;
