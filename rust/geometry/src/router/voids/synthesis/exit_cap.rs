// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Which end caps of an opening cutter may be pushed through the host.
//!
//! A guard here is only as safe as the DIRECTION it fails in. Suppressing the
//! veto degrades to the pre-fix behaviour, which the corpus is blessed against,
//! so a wrong suppression costs nothing that was not already accepted. The same
//! guard on qualification would be unsound: declining to qualify cannot restore
//! a push, it can only withhold one, and a withheld push leaves a coplanar
//! graze that tears. Same threshold, opposite safety, decided entirely by which
//! way it fails.
//!
//! `extend_opening_mesh_through_host` grows a cutter so a cap that sits flush
//! against a host surface becomes a clean transversal crossing instead of a
//! coplanar graze. Growing the WRONG cap removes host material no authored
//! opening ever occupied, so the decision is isolated here, behind one call.

use super::super::geom::{mesh_point, point_inside_mesh_agreed, project_aabb_in_frame};
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

    /// How far to pull a jamb cap off the plane it is coincident with: one
    /// coincidence band, so the cap stops satisfying the very test that found
    /// it, and no further.
    ///
    /// Measured, not assumed: flooring this at the local f32 spacing changes
    /// nothing on the corpus, byte for byte. The cap offsets here are frame
    /// projections and stay small even on hosts whose world coordinates are at
    /// 8e6, so the pull-in is representable where it is applied. Recorded
    /// because the opposite was plausible enough that I implemented it.
    pub fn shrink(&self) -> f64 {
        self.cap_band()
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

    /// A point in world space from frame coordinates. The frame is orthonormal
    /// and projected about the origin, so this inverts `project_aabb_in_frame`
    /// exactly.
    fn point_at(&self, u: f64, v: f64, s: f64) -> Point3<f64> {
        Point3::from(
            self.frame.cross_a * u + self.frame.cross_b * v + self.frame.depth * s,
        )
    }

    /// Where to sample across the axis: the HOST's cross-section centre, pulled
    /// into the cutter's footprint. Not the cutter's own centre - these cutters
    /// routinely run tens of metres through a 0.2 m layer, so their footprint
    /// centre sits in mid-air far from the host and every probe there reads
    /// empty. Clamping the host's centre into the footprint puts the sample
    /// where the two actually meet.
    fn probe_uv(&self, host: &Mesh) -> Option<(f64, f64)> {
        let (hlo, hhi) = project_aabb_in_frame(
            host,
            &[self.frame.cross_a, self.frame.cross_b, self.frame.depth],
            Vector3::zeros(),
        )?;
        let clamp = |c: f64, lo: f64, hi: f64| c.max(lo).min(hi);
        Some((
            clamp((hlo.x + hhi.x) * 0.5, self.lo.x, self.hi.x),
            clamp((hlo.y + hhi.y) * 0.5, self.lo.y, self.hi.y),
        ))
    }

    /// How far past a cap to sample for host material. Small on purpose: it has
    /// to clear the coincident surface without leaving a thin pier behind the
    /// cap, and the pier is what the probe exists to find.
    fn probe_offset(&self) -> f64 {
        self.cap_band() * 4.0
    }

}

/// The host surface offset along the axis at each cap the opening EXITS
/// through. `None` means the opening does not exit there, so that cap must not
/// move. Encoding it this way makes "not an exit cap, but here is its offset"
/// unrepresentable.
pub(super) enum Cap {
    /// No host facet coincident with this cap: a floating slot end. Leave it
    /// exactly where the author put it.
    Free,
    /// A genuine exit. Push it clear of the host surface at this offset so the
    /// interface becomes a transversal crossing (#1007).
    Exit(f64),
    /// Coincident, but the host continues past it: a jamb of a hole the host
    /// already carries. Pushing it eats the pier (#3219); leaving it coplanar
    /// grazes and tears. Pull it just inside the existing void instead.
    Jamb,
}

pub(super) struct ExitCaps {
    pub min: Cap,
    pub max: Cap,
}

impl ExitCaps {
    /// Signed move for the min cap along `-d`. Positive pushes it clear of the
    /// host; NEGATIVE pulls it into the void the host already carries.
    pub fn push_back(&self, omn: f64, pad: f64, shrink: f64) -> f64 {
        match self.min {
            Cap::Free => 0.0,
            Cap::Exit(h) => (omn - h).max(0.0) + pad,
            Cap::Jamb => -shrink,
        }
    }

    /// Signed move for the max cap along `+d`, same convention.
    pub fn push_fwd(&self, omx: f64, pad: f64, shrink: f64) -> f64 {
        match self.max {
            Cap::Free => 0.0,
            Cap::Exit(h) => (h - omx).max(0.0) + pad,
            Cap::Jamb => -shrink,
        }
    }

    /// Whether either cap moves at all. `Free` on both means the authored
    /// cutter already crosses cleanly and must not be touched.
    pub fn any_moves(&self) -> bool {
        !matches!((&self.min, &self.max), (Cap::Free, Cap::Free))
    }

    pub fn min_moves(&self) -> bool {
        !matches!(self.min, Cap::Free)
    }

    pub fn max_moves(&self) -> bool {
        !matches!(self.max, Cap::Free)
    }
}

/// Classify each cap of the cutter against the host.
///
/// QUALIFICATION is the pre-#3219 test, unchanged: a cap qualifies when some
/// host facet is ~parallel to it and lies on its plane. Parallel-and-coincident
/// alone tells a #1112 roof-opening cap (flush with a roof facet interior to
/// the host's projected extent) apart from a #552611 horizontal wall slot whose
/// caps float inside the wall with no host facet there; extending the latter
/// along its authored +Z extrusion would halve the wall.
///
/// The DECISION is then a veto and nothing else. A qualified cap is pushed
/// unless the host demonstrably continues through the interval the push would
/// sweep, which is the one thing separating a jamb (#3219) from an end (#1007).
/// Everything that fails to produce evidence resolves to the pre-fix behaviour,
/// which the corpus is blessed against, so every divergence from it is a
/// positive verdict rather than a side effect.
///
/// Occupancy is read by ray parity, not by facet winding. IFC winding is not
/// reliably outward and the host is not oriented until AFTER the cut, so a
/// signed-normal test mis-reads real bodies: an area-weighted facing vote was
/// measured cancelling to exactly 0.0000 on the doubled skin an exploded-layer
/// host produces, which is contradictory evidence being read as "not an exit".
/// Parity counts crossings and does not care how the exporter wound its faces.
pub(super) fn detect(host: &Mesh, f: &CutterFrame, pad: f64) -> ExitCaps {
    let (omn, omx) = f.caps();
    let (d, band) = (f.depth(), f.cap_band());
    let (mut min_has_surface, mut max_has_surface) = (false, false);
    let (mut host_at_min, mut host_at_max) = (omn, omx);
    // QUALIFICATION is main's test, unchanged and unfiltered: a cap qualifies
    // when some host facet is ~parallel to it and lies on its plane. No
    // footprint filter here, and none on `host_at_*` either. Filtering
    // qualification was measured to decline pushes main made, on hosts whose
    // only coincident facets sit outside the cutter's own cross-section, and a
    // declined push is a coplanar graze. Locality is the probe's job below,
    // which samples where the host and cutter actually meet.
    for t in host.indices.chunks_exact(3) {
        let (Some(a), Some(b), Some(c)) = (
            mesh_point(host, t[0]),
            mesh_point(host, t[1]),
            mesh_point(host, t[2]),
        ) else {
            continue;
        };
        let n = (b - a).cross(&(c - a));
        let nl = n.norm();
        if nl < NORMALIZE_EPSILON {
            continue;
        }
        if (n.dot(&d) / nl).abs() < CAP_PARALLEL_COS {
            continue;
        }
        // the facet's offset along d (any vertex; it's ~constant on the facet)
        let s = a.coords.dot(&d);
        if (s - omn).abs() <= band {
            min_has_surface = true;
            host_at_min = host_at_min.min(s);
        }
        if (s - omx).abs() <= band {
            max_has_surface = true;
            host_at_max = host_at_max.max(s);
        }
    }

    // The VETO. A qualified cap is pushed unless the host demonstrably
    // continues through the interval the push would sweep, which is the one
    // thing that distinguishes a jamb (#3219) from an end (#1007).
    //
    // Every way of having no usable evidence resolves to NO VETO, i.e. to
    // main's behaviour:
    //
    //   - no probe point (the host does not project into the frame),
    //   - a host whose parity cannot be trusted, because ray parity on a torn
    //     shell is a coin flip and a coin flip must not remove a push,
    //   - a probe that reads empty at every depth.
    //
    // That asymmetry is the whole design. A wrong veto silently removes a
    // clearance push and tears the host; a missing veto reproduces exactly what
    // main already does, which the corpus is blessed against.
    // No veto where the mesh cannot express the geometry the probe is asking
    // about. `Mesh` stores f32, so at georeferenced magnitudes the gap between
    // representable positions is metres-scale (0.5 m at 8.2e6), and ray parity
    // there is answering about a shape quantized past recognition. Two ray
    // directions can then AGREE and both be wrong, so self-agreement is not
    // enough on its own.
    //
    // Suppressing the veto is the safe direction, and this is the one place a
    // magnitude guard belongs: it can only fall back to main's behaviour, which
    // the corpus is blessed against. Gating QUALIFICATION on magnitude was tried
    // and is unsound, because declining to qualify cannot restore a push main
    // made; it only withholds one.
    let far_field = {
        let m = host
            .positions
            .iter()
            .fold(0.0f64, |acc, &v| acc.max((v as f64).abs()));
        m >= crate::LARGE_COORD_THRESHOLD_METERS
    };
    let probe = f.probe_uv(host).filter(|_| !far_field);
    let occupied_along = |from: f64, dir: f64| -> bool {
        let Some((cu, cv)) = probe else {
            return false;
        };
        // Sample ACROSS the swept interval, not at one offset. A pier thinner
        // than a single probe offset reads empty at that one depth and then
        // takes the full 30%-of-span push straight through it.
        //
        // A depth whose parity does not AGREE between two ray directions is not
        // evidence and is skipped rather than counted either way: the surface
        // there is not closed to a ray, and a coin flip must not remove a push.
        [f.probe_offset(), pad * 0.5, pad]
            .into_iter()
            .any(|t| {
                point_inside_mesh_agreed(host, f.point_at(cu, cv, from + dir * t))
                    .unwrap_or(false)
            })
    };
    let classify = |has_surface: bool, occupied: bool, host_at: f64| {
        match (has_surface, occupied) {
            (false, _) => Cap::Free,
            (true, true) => Cap::Jamb,
            (true, false) => Cap::Exit(host_at),
        }
    };
    ExitCaps {
        min: classify(min_has_surface, occupied_along(omn, -1.0), host_at_min),
        max: classify(max_has_surface, occupied_along(omx, 1.0), host_at_max),
    }
}
