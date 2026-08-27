// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Which end caps of an opening cutter may be pushed through the host.
//!
//! `extend_opening_mesh_through_host` grows a cutter so a cap that sits flush
//! against a host surface becomes a clean transversal crossing instead of a
//! coplanar graze. Growing the WRONG cap removes host material no authored
//! opening ever occupied, so the decision is isolated here, behind one call.

use super::super::geom::{mesh_point, mesh_signed_volume, project_aabb_in_frame};
use super::super::{OpeningFrame, NORMALIZE_EPSILON};
use crate::{Mesh, Point3, Vector3};

/// A facet counts as parallel to a cap at |n·d| ≥ this. 0.985 ≈ 10°: absorbs
/// the ~0.1° facet scatter and a tilted roof's wobble without admitting a
/// perpendicular wall.
const CAP_PARALLEL_COS: f64 = 0.985;

/// Coincidence and footprint-overlap tolerances, as a fraction of the extent
/// they are measured against, so a large opening gets proportionally more
/// slack than a small one. Note the `.max(1.0)` floors below: BELOW one unit
/// of extent the tolerance stops scaling and is a flat 1e-3, so the same
/// geometry authored in metres and in millimetres does NOT get the same
/// relative slack.
const BAND_FRACTION: f64 = 1.0e-3;

/// A cutter's extents in the frame of its penetration axis: `lo`/`hi` hold
/// `(u, v, d)` minima and maxima, so `.z` bounds the cutter along the axis
/// (its two caps) and `.x`/`.y` are its cross-section footprint.
pub(super) struct CutterFrame {
    frame: OpeningFrame,
    lo: Point3<f64>,
    hi: Point3<f64>,
}

impl CutterFrame {
    /// `None` when the axis will not normalize or the mesh projects to a
    /// non-finite box (`project_aabb_in_frame` validates both ends: a `+inf`
    /// coordinate lands only in `hi`, so checking `lo` alone would let a
    /// non-finite box through, #1259).
    pub fn new(mesh: &Mesh, d: Vector3<f64>) -> Option<Self> {
        let frame = OpeningFrame::from_depth(d)?;
        let (lo, hi) = project_aabb_in_frame(
            mesh,
            &[frame.cross_a, frame.cross_b, frame.depth],
            Vector3::zeros(),
        )?;
        Some(Self { frame, lo, hi })
    }

    /// Unit penetration axis.
    pub fn depth(&self) -> Vector3<f64> {
        self.frame.depth
    }

    /// Cutter offsets along the axis at the min and max cap.
    pub fn caps(&self) -> (f64, f64) {
        (self.lo.z, self.hi.z)
    }

    /// Cutter depth along the axis.
    pub fn span(&self) -> f64 {
        self.hi.z - self.lo.z
    }

    /// Tolerance for "this facet lies ON a cap plane", measured along the axis.
    fn cap_band(&self) -> f64 {
        self.span().max(1.0) * BAND_FRACTION
    }

    /// Tolerance for "this facet lies UNDER the footprint", measured ACROSS the
    /// axis. Kept separate from [`Self::cap_band`]: a depth-derived slack doing
    /// duty as a lateral one is a different quantity wearing the same name, and
    /// on these cutters the two differ by an order of magnitude (a 44 m deep,
    /// 3.4 m tall window opening).
    fn footprint_band(&self) -> f64 {
        (self.hi.x - self.lo.x)
            .max(self.hi.y - self.lo.y)
            .max(1.0)
            * BAND_FRACTION
    }

    /// Whether a facet's cross-section overlaps the cutter's. Touching counts
    /// as overlapping, the conservative direction: before footprint locality
    /// existed every coincident facet voted, so admitting a flush-against-the-
    /// edge facet preserves that behaviour.
    fn footprint_overlaps(&self, tri: &[Point3<f64>; 3]) -> bool {
        let band = self.footprint_band();
        let spans = |ax: &Vector3<f64>, lo: f64, hi: f64| {
            let (a, b, c) = (
                tri[0].coords.dot(ax),
                tri[1].coords.dot(ax),
                tri[2].coords.dot(ax),
            );
            a.min(b).min(c) <= hi + band && a.max(b).max(c) >= lo - band
        };
        spans(&self.frame.cross_a, self.lo.x, self.hi.x)
            && spans(&self.frame.cross_b, self.lo.y, self.hi.y)
    }
}

/// The host surface offset along the axis at each cap the opening EXITS
/// through. `None` means the opening does not exit there, so that cap must not
/// move. Encoding it this way makes "not an exit cap, but here is its offset"
/// unrepresentable.
pub(super) struct ExitCaps {
    pub min: Option<f64>,
    pub max: Option<f64>,
}

impl ExitCaps {
    /// How far to push the min cap back, given the caller's clearance `pad`.
    pub fn push_back(&self, omn: f64, pad: f64) -> f64 {
        self.min.map_or(0.0, |h| (omn - h).max(0.0) + pad)
    }

    /// How far to push the max cap forward, given the caller's clearance `pad`.
    pub fn push_fwd(&self, omx: f64, pad: f64) -> f64 {
        self.max.map_or(0.0, |h| (h - omx).max(0.0) + pad)
    }
}

/// Decide each cap against the host SURFACE (not its AABB). A cap qualifies
/// only when a host facet is ~parallel to it, sits ON its plane, lies UNDER
/// the cutter's footprint, and faces the way an exit faces. All four matter.
///
/// Parallel-and-coincident alone tells a #1112 roof-opening cap (flush with a
/// roof facet INTERIOR to the host's projected extent) apart from a wall
/// #552611 horizontal slot whose caps float inside the wall with no host facet
/// there — extending the latter along its authored +Z extrusion would halve
/// the wall.
///
/// Footprint locality keeps a multi-body host honest. A large coplanar facet
/// off to one side (a plate beside the slab being pierced) would otherwise
/// outvote the genuine cap by area and suppress a push #1007 needs.
///
/// Orientation is the #3219 case. When the authoring tool already cut the hole
/// into the host — an Archicad wall exploded into layer parts, each Brep
/// carrying its own window — the cutter's side planes coincide with the hole's
/// JAMBS. Coincidence alone reads those as caps, and the push then drives each
/// one into the pier beside it, widening every window by 30% of its own width
/// per side. With outward winding an exit facet faces AWAY from the material,
/// so `-d` at the min cap and `+d` at the max cap; a jamb faces INTO the hole,
/// the opposite sign on both, because the host continues past it. The facing is
/// area-weighted rather than boolean so facet scatter and stray slivers cannot
/// outvote the real surface.
pub(super) fn detect(host: &Mesh, f: &CutterFrame) -> ExitCaps {
    let (omn, omx) = f.caps();
    let (d, band) = (f.depth(), f.cap_band());
    // "Faces away from the material" is only "-d/+d" when the host is wound
    // OUTWARD, and IFC winding is not reliably outward: a CW profile extruded
    // along +Z, or a faceted brep with inconsistent face loops, yields an
    // INWARD-wound closed solid (`kernel/mesh_bridge.rs`). The host is not
    // oriented until AFTER the cut (`processing/src/element.rs` runs
    // `orient_mesh_outward_verdict` on the result), so read the host's own
    // convention from the sign of its signed volume instead of assuming one.
    // Without this an inward-wound host loses the #1007 clearance push AND
    // gets the #3219 pier-eating back, both silently.
    let orient = if mesh_signed_volume(host) < 0.0 { -1.0 } else { 1.0 };
    let (mut min_facing, mut max_facing) = (0.0f64, 0.0f64);
    let (mut host_at_min, mut host_at_max) = (omn, omx);
    for t in host.indices.chunks_exact(3) {
        let (Some(a), Some(b), Some(c)) = (
            mesh_point(host, t[0]),
            mesh_point(host, t[1]),
            mesh_point(host, t[2]),
        ) else {
            continue;
        };
        // Unnormalized normal: its length is 2·area, so `n · d` IS the
        // area-weighted facing with no second normalize.
        let n = (b - a).cross(&(c - a));
        let nl = n.norm();
        if nl < NORMALIZE_EPSILON {
            continue;
        }
        let facing = n.dot(&d);
        if (facing / nl).abs() < CAP_PARALLEL_COS {
            continue;
        }
        if !f.footprint_overlaps(&[a, b, c]) {
            continue;
        }
        // the facet's offset along d (any vertex; it's ~constant on the facet)
        let s = a.coords.dot(&d);
        if (s - omn).abs() <= band {
            min_facing += facing;
            host_at_min = host_at_min.min(s);
        }
        if (s - omx).abs() <= band {
            max_facing += facing;
            host_at_max = host_at_max.max(s);
        }
    }
    ExitCaps {
        min: (min_facing * orient < 0.0).then_some(host_at_min),
        max: (max_facing * orient > 0.0).then_some(host_at_max),
    }
}
