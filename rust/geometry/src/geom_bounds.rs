// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The #1891 follow-on world AABB: the unquantized `f64` box the fingerprinting
//! pass accumulates alongside the hash, and the well-formedness rule that
//! decides when it may be published.
//!
//! Split out of the parent `geom_hash` module (whose child it is, so it reaches
//! [`GeometryHasher`]'s private `min`/`max` accumulators directly) because
//! bounds are a separate subject from the fingerprint: the hash answers "is
//! this the same shape", the box answers "where is it and how big". The box
//! also carries a long well-formedness rationale — the case where a NaN
//! coordinate leaves ONE axis at its sentinel while its neighbours hold real
//! bounds — which is about malformed position buffers, not about hashing, and
//! reads as noise in the hashing file.

use super::GeometryHasher;

impl GeometryHasher {
    /// Grow the world AABB by one reconstructed corner.
    ///
    /// `f64::min`/`f64::max` return the non-NaN operand, so a NaN coordinate
    /// (a malformed position buffer) is skipped rather than poisoning the box.
    ///
    /// `pub(super)` — the parent's `add_oriented_mesh` is the only caller; the
    /// accumulators are not open for writing from outside this pair of modules.
    #[inline]
    pub(super) fn extend_bounds(&mut self, world: &[f64; 3]) {
        for k in 0..3 {
            self.min[k] = self.min[k].min(world[k]);
            self.max[k] = self.max[k].max(world[k]);
        }
    }

    /// The entity's world-space AABB as `[minx, miny, minz, maxx, maxy, maxz]`,
    /// or `None` if the box is not well-formed on all three axes — which
    /// covers both "no in-range triangle corner was ever seen" and the
    /// partial-accumulation case below.
    ///
    /// ### Why all three axes are tested, not just one
    ///
    /// The axes look like they must accumulate together — `extend_bounds` runs
    /// the same loop over all three for every corner — but they do not, because
    /// that loop is `f64::min`/`f64::max`, which DROP a NaN operand. A position
    /// buffer carrying NaN on one axis and finite values on the others leaves
    /// that axis at its `INFINITY..NEG_INFINITY` sentinel while its neighbours
    /// hold real bounds. Testing only axis 0 then returns
    /// `Some([x0, inf, z0, x1, -inf, z1])` — an inverted, infinite axis
    /// presented as a measured box, which downstream differences to NaN.
    /// Requiring every axis to be finite and ordered turns that into `None`,
    /// which the wire format already reserves NaN slots for
    /// (`MeshCollection::push_geometry_hash`).
    ///
    /// The hash makes no such promise: NaN quantizes to 0, so a NaN-carrying
    /// entity still produces a fingerprint. `Some(hash)` with `None` box is
    /// therefore a REACHABLE pair, not a structural impossibility, and
    /// `produce_element_meshes` keeps the hash when it happens rather than
    /// discarding both. The fingerprint is the diff engine's primary signal and
    /// is well-defined here; dropping it would remove the element from the
    /// comparison in exchange for nothing, and it cannot desynchronize the
    /// parallel FFI arrays because `push_geometry_hash` writes six NaNs for a
    /// missing box instead of shortening the array (pinned by
    /// `a_missing_box_reserves_its_slots_instead_of_shifting_the_array`).
    ///
    /// The converse stays impossible: a `Some` box needs an accumulated corner,
    /// which needs a triangle, which `is_empty()` already gates on.
    ///
    /// UNQUANTIZED `f64` world coordinates, not grid indices: the box is meant
    /// to be read as a length, so snapping it to the hash tolerance would put a
    /// millimetre of noise on every face for no benefit. It is RTC-invariant
    /// for the same reason the hash is — both are built from the reconstructed
    /// world coordinate.
    ///
    /// This is the diff engine's "did it MOVE?" signal. The hash answers only
    /// "is it different"; comparing two boxes separates a translation (same
    /// extent, shifted centre) from a reshape (different extent) from pure
    /// re-tessellation (identical box, different hash).
    ///
    /// The companion [`Self::volume`] exists but is far narrower — it is
    /// `None` for a large minority of entities, by design.
    pub fn world_aabb(&self) -> Option<[f64; 6]> {
        let well_formed = (0..3).all(|k| {
            self.min[k].is_finite() && self.max[k].is_finite() && self.min[k] <= self.max[k]
        });
        if !well_formed {
            return None;
        }
        Some([
            self.min[0], self.min[1], self.min[2], self.max[0], self.max[1], self.max[2],
        ])
    }
}
