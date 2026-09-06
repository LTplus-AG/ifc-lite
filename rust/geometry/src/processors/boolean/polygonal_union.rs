// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Original cutter union for the bounded roof-chain subtraction (#3925).

use super::BooleanClippingProcessor;
use crate::{ClippingProcessor, Mesh};

impl BooleanClippingProcessor {
    /// Union the chained-clip cutter prisms into ONE watertight solid.
    ///
    /// The segmented-roof cutters are prisms that ABUT along shared, exactly-
    /// coplanar faces (adjacent roof facets meeting at a hip/ridge/valley).
    /// Unioning them into a single watertight cutter is what lets the chain be
    /// subtracted ONCE (no seam fins, no deep-chain depth drops — issue #960).
    ///
    /// Returns `None` when no available kernel can produce a watertight union;
    /// the caller then defers to the sequential per-cutter path. We never feed a
    /// non-manifold mesh-merge into the subtract: the CSG kernel cannot classify
    /// a non-watertight cutter and silently returns the host UNCHANGED, leaving
    /// the gable-end wall at full extrusion height.
    pub(super) fn build_cutter_union(&self, clipper: &ClippingProcessor, prisms: &[Mesh]) -> Option<Mesh> {
        if prisms.is_empty() {
            return None;
        }
        if prisms.len() == 1 {
            return Some(prisms[0].clone());
        }

        // Primary path: the pure-Rust kernel's N-ary union — ONE conforming
        // arrangement of all cutter prisms over a shared interner, so coplanar
        // seams shared by 3+ roof segments (and exactly-duplicated cutter prisms)
        // dissolve without the tearing that left-deep pairwise accumulation
        // produces. This makes the segmented-roof clip (#960) watertight on EVERY
        // build. Exact + platform-deterministic.
        {
            let refs: Vec<&Mesh> = prisms.iter().collect();
            let u = ClippingProcessor::consolidate_coplanar(
                crate::kernel::mesh_bridge::union_many_preserving_coordinates(&refs),
            );
            if !u.is_empty() {
                return Some(u);
            }
        }

        // Fallback: the kernel's sequential multi-mesh union. Returns
        // `None` on empty/error so the caller defers to the per-cutter path.
        match clipper.union_meshes(prisms) {
            Ok(m) if !m.is_empty() => Some(m),
            _ => None,
        }
    }

}
