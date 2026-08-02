// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The #1891 volume gate: what the mesher proved about an entity's surface
//! topology, and the single narrow condition under which that licenses a
//! divergence-theorem volume.
//!
//! Split out of the parent `geom_hash` module (whose child it is, so it reaches
//! [`GeometryHasher`]'s private accumulators directly) because it is a separate
//! subject with a long justification: the fingerprint answers "is this the same
//! shape", this answers "may I state its volume out loud". Most of the file is
//! the reasoning behind the second question's four-clause NO.

use super::GeometryHasher;
use crate::mesh_orient::OrientVerdict;

/// What an ENTITY's produced geometry looked like topologically, folded over
/// every segment the hasher was fed (#1891).
///
/// Four independent yes/no axes rather than one "is it good" bit, because a
/// consumer that gets no volume deserves to know why: an open `SurfaceModel`
/// sheet, a non-orientable shell, a two-piece body, and a many-item assembly
/// are four different modelling situations with four different fixes, and
/// collapsing them loses the diagnosis. They ride the wasm boundary as one
/// packed [`Self::bits`] byte per entity.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GeometryClosure {
    /// Every segment's every component was closed (no boundary, no non-manifold
    /// edge).
    pub all_closed: bool,
    /// Every segment's every component was orientable.
    pub all_orientable: bool,
    /// Every segment was a SINGLE connected component.
    pub all_single_component: bool,
    /// Segments (`add_mesh*` calls contributing at least one in-range triangle).
    pub segments: u32,
}

impl GeometryClosure {
    /// Nothing seen yet. The `all_*` conjunctions start true and are only
    /// meaningful once `segments > 0`, which every consumer checks first.
    pub const EMPTY: Self = Self {
        all_closed: true,
        all_orientable: true,
        all_single_component: true,
        segments: 0,
    };

    /// Fold one segment's [`OrientVerdict`] in. `pub(super)` — only the parent
    /// accumulator may advance a verdict; a consumer reads, never writes.
    pub(super) fn fold_segment(&mut self, v: &OrientVerdict) {
        self.segments += 1;
        self.all_closed &= v.all_closed;
        self.all_orientable &= v.all_orientable;
        self.all_single_component &= v.components == 1;
    }

    /// Pack into one byte for the FFI boundary: bit 0 closed, bit 1 orientable,
    /// bit 2 single-component, bit 3 exactly-one-segment. `0x0F` is the only
    /// value that carries a volume, so a consumer can both read the volume's
    /// presence and, when it is absent, name the reason.
    pub fn bits(&self) -> u8 {
        (self.all_closed as u8)
            | ((self.all_orientable as u8) << 1)
            | ((self.all_single_component as u8) << 2)
            | (((self.segments == 1) as u8) << 3)
    }

    /// Whether a divergence-theorem volume over this entity's geometry is
    /// trustworthy. See [`GeometryHasher::volume`] for the reasoning behind
    /// each clause — every one of them is load-bearing.
    pub fn is_trustworthy_solid(&self) -> bool {
        self.segments == 1 && self.all_closed && self.all_orientable && self.all_single_component
    }
}

impl GeometryHasher {
    /// The entity's folded per-segment topology. See [`GeometryClosure`].
    pub fn closure(&self) -> GeometryClosure {
        self.closure
    }

    /// The entity's enclosed volume in cubic metres — `Some` ONLY when the
    /// geometry that produced it is provably a single closed orientable solid,
    /// `None` otherwise. THE RULE IS DELIBERATELY NARROW. Each clause of
    /// [`GeometryClosure::is_trustworthy_solid`] rejects a specific way the
    /// number would otherwise be silently wrong.
    ///
    /// It is narrow, not useless: measured over the ara3d fixture corpus
    /// (33,701 elements that produced geometry, across 68 files) the gate admits
    /// 24,073 of them — 71.4% — and not one of those reports a volume exceeding
    /// its own bounding box.
    ///
    /// ### `all_closed`
    ///
    /// Over an open surface the divergence sum is not approximate, it is
    /// arbitrary: the boundary-loop flux scales with the distance to the
    /// reference point, so the "volume" of a sheet is whatever you referenced
    /// it to. Material-layer wall slices are open bands by construction since
    /// #1311 (`router/layers.rs` refuses to cap them, because capping made every
    /// shared interface a doubled coincident sheet), and `IfcTriangulatedFaceSet`
    /// TINs / `SurfaceModel`s are open by definition. Measured over the ara3d
    /// fixture corpus at exactly this granularity — 73,626 segments across
    /// 33,701 elements — 16.2% of segments are not a single closed orientable
    /// component, and 15.3% of elements have at least one such segment.
    ///
    /// ### `all_orientable`
    ///
    /// A non-orientable component has no consistent inside, so the sign of each
    /// triangle's contribution is arbitrary. `orient_mesh_outward` already
    /// refuses to re-wind these for the same reason.
    ///
    /// ### `all_single_component`
    ///
    /// `orient_mesh_outward` flips each CLOSED component so its own signed
    /// volume is POSITIVE. For two disjoint solids that is right. For a solid
    /// whose cavity is a second, inner shell it is catastrophic: the sum reports
    /// `outer + cavity` where the truth is `outer − cavity`. Distinguishing the
    /// two needs a containment test, and the orientation already applied has
    /// destroyed the sign that encoded the difference.
    ///
    /// ### `segments == 1` — the multi-segment decision
    ///
    /// A segment is one sub-mesh, which is one representation ITEM (or one
    /// material-layer band). IFC treats an item list as an implicit UNION, and
    /// exporters routinely emit items that overlap: a window frame and its sash
    /// meeting at the rebate, lapped steel plates, a `Clearance` representation
    /// whose `RepresentationType` is `SweptSolid` (which passes the body filter
    /// in `router/rep_filter.rs` — nothing filters on the representation
    /// IDENTIFIER), or two `Body` representations in different subcontexts.
    /// A sum over overlapping items double-counts the intersection, and each
    /// item on its own is a perfectly ordinary closed solid, so nothing about
    /// the individual verdicts reveals it.
    ///
    /// Measured, this is not a corner case. Of the 4,472 all-closed
    /// multi-segment elements in the corpus, 2,971 (66%) have a pair of segments
    /// whose world boxes overlap by more than 1% of the smaller box, and the
    /// most common failure is total containment (overlap fraction 1.000 — one
    /// item's box entirely inside another's), on doors, windows and furnishing
    /// assemblies. Summing them produces a volume larger than the element's OWN
    /// bounding box — a geometric impossibility — on 987 of them (22%), with a
    /// p90 of 2.99× and a maximum of 3.00× the box. Restricting to a single
    /// segment leaves 0 such elements, with a p50 fill of 0.96 and a maximum of
    /// exactly 1.00.
    ///
    /// AABB-disjointness was considered as a weaker gate and rejected: it is
    /// unsound in both directions (two interlocking L-members have overlapping
    /// boxes and disjoint solids; two overlapping solids can share one box), and
    /// a real disjointness test is a CSG intersection per pair.
    ///
    /// There is also a consistency argument that needs no measurement. When the
    /// sub-mesh path fails, `produce_element_meshes` falls back to
    /// `process_element`, which merges every item into ONE mesh. That merged
    /// mesh has two components, so `all_single_component` already rejects it.
    /// Accepting the sum on the sub-mesh path would mean the same element
    /// reports a volume or not depending on which router entry point happened to
    /// succeed. `segments == 1` makes the two paths agree.
    ///
    /// ### What this canNOT certify
    ///
    /// Closedness is a property of the SURFACE, not evidence that the surface is
    /// the RIGHT one. When the #1109 CSG budget trips, `apply_void_context`
    /// returns the UNCUT host (`router/voids/mod.rs`), which is still a flawless
    /// closed solid — it just still contains its openings. That over-reports and
    /// this verdict cannot see it. A consumer that cares must also read
    /// `ProducedElementMeshes::csg_failures`, which is where that degradation is
    /// reported.
    pub fn volume(&self) -> Option<f64> {
        if !self.closure.is_trustworthy_solid() {
            return None;
        }
        // MAGNITUDE, not the raw signed sum. For a closed orientable surface the
        // magnitude IS the enclosed volume; the sign only records which side the
        // winding calls outside, and `orient_mesh_outward` normally normalizes it
        // to positive. Normally: that pass decides the flip from a sum taken
        // about the mesh's LOCAL FRAME ORIGIN, and when the local frame sits far
        // from the geometry that is a cancellation of large terms whose SIGN can
        // come out wrong — the same reference-point sensitivity documented on
        // `kernel::signed_volume::signed_volume6`. One element in the 24,073 that
        // pass this gate across the fixture corpus arrives inward-wound for that
        // reason. This accumulator references a point ON the surface, so its
        // magnitude is sound either way; taking it keeps that pre-existing
        // orientation defect (a normals/lighting bug, out of scope here) from
        // turning into a negative volume.
        Some((self.volume6 / 6.0).abs())
    }
}
