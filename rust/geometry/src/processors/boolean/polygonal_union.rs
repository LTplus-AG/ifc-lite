// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Original cutter union for the bounded roof-chain subtraction (#3925).

use super::BooleanClippingProcessor;
use crate::{ClippingProcessor, Mesh};

impl BooleanClippingProcessor {
    /// Union the chained-clip cutter prisms into ONE solid.
    ///
    /// The segmented-roof cutters are prisms that ABUT along shared, exactly-
    /// coplanar faces (adjacent roof facets meeting at a hip/ridge/valley).
    /// Unioning them into a single cutter is what lets the chain be subtracted
    /// ONCE (no seam fins, no deep-chain depth drops — issue #960).
    ///
    /// **Measured contract, not an enforced one (issue #3980):** despite the
    /// "watertight" language this comment used to carry, neither the primary
    /// path (`union_many_preserving_coordinates` + `consolidate_coplanar`) nor
    /// the `union_meshes` fallback is checked for closure here — only for
    /// nonemptiness. `None` is returned solely when BOTH come back empty; the
    /// caller then defers to the sequential per-cutter path. An exact
    /// bit-identical directed-edge closure check against the real #960
    /// fixture (five walls, `960_house_segmented_roof_clip.ifc`) found this
    /// union closed on only 1 of 5 real chains — the rest had open boundary
    /// edges, and some had degenerate (zero-length) edges — yet all were
    /// accepted, because nothing here rejects them. What actually stands
    /// between a non-closed union and a wrong subtraction is downstream, in
    /// the caller (`try_union_polygonal_chain` in `super::mod`): its
    /// intersected-bounds check and the `#3919` accept-gate on the actual
    /// subtract. On the #960 fixture's walls #2152 and #5904 those
    /// downstream checks were sufficient — every wall's Z bounds still
    /// matched IfcOpenShell — but that is evidence for those walls, not a
    /// closure guarantee this function provides.
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
        // produces. Accepted whenever nonempty (see the measured-contract note
        // above); exact + platform-deterministic.
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
