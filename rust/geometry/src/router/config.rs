// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The router's value-type configuration: everything a caller decides before
//! any geometry is produced (C2-4, #7781). [`GeometryRouter::from_config`]
//! builds a router from one; [`GeometryRouter::config`] reads the effective one
//! back. The `with_*` constructors and `set_*` methods stay as thin delegates.
//!
//! Configuration changes advance the router's execution generation, so a
//! change made while a product holds the router's execution lease refuses
//! that product's publication (`ExecutionLeaseError::ConfigurationChanged`).
//! Build the router with `from_config`, inject the shared caches, and only then
//! lease it for the first product.

use crate::tessellation::TessellationQuality;
use crate::GeometryRouter;

/// How a [`GeometryRouter`] meshes. Plain data: `Clone`, comparable, built once
/// per load and handed to every per-element or per-batch router. Resource
/// budgets, deadlines and live cache accounts belong to the execution domain
/// and are not copied or reset by this configuration.
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
    /// occurrence, so every occurrence resolves against ONE model-wide template
    /// across the rayon pool. `true` (the WASM per-BATCH path): the router
    /// meshes one batch serially and the FIRST occurrence of each source it
    /// sees is the template, so each per-batch shard is self-contained. Both
    /// emit geometrically identical world triangles.
    pub instancing_batch_local: bool,
}

impl Default for RouterConfig {
    fn default() -> Self {
        Self {
            unit_scale: 1.0, // base metres
            rtc_offset: (0.0, 0.0, 0.0),
            tessellation_quality: TessellationQuality::Medium,
            local_frame: None,
            skip_small_cuts: false,
            instancing_batch_local: false, // native global-template mode
        }
    }
}

impl GeometryRouter {
    /// A router with `config` applied. Like [`GeometryRouter::new`] it arms no
    /// caches: inject the shared ones (`enable_content_dedup_shared`,
    /// `enable_shared_mapped_item_cache`, ...) afterwards, before the first
    /// product leases the router.
    // Let constructor delegates initialize their destination in place instead
    // of copying the full router through a second configuration return slot.
    #[inline(always)]
    pub fn from_config(config: RouterConfig) -> Self {
        // Destructured so a new field cannot be added without being applied.
        let RouterConfig {
            unit_scale,
            rtc_offset,
            tessellation_quality,
            local_frame,
            skip_small_cuts,
            instancing_batch_local,
        } = config;
        let mut router = Self::new();
        router.set_unit_scale(unit_scale);
        router.set_rtc_offset(rtc_offset);
        router.set_tessellation_quality(tessellation_quality);
        router.config.local_frame = local_frame;
        router.set_skip_small_cuts(skip_small_cuts);
        router.set_instancing_batch_local(instancing_batch_local);
        router
    }

    /// The effective configuration, including later `set_*` changes. This is
    /// not a full router snapshot: length-unit refusal is deliberately not
    /// serialized, and a refused unit reads back as `unit_scale == 1.0`.
    /// Rebuilding with `from_config(router.config().clone())` does not preserve
    /// refusal. Callers must pass the raw invalid scale or call
    /// [`Self::refuse_length_unit`] on each rebuilt router before meshing.
    #[inline]
    pub fn config(&self) -> &RouterConfig {
        &self.config
    }
}

#[cfg(test)]
#[path = "config_tests.rs"]
mod config_tests;
