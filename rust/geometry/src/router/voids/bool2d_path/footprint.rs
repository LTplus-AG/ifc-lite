// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Projection and eligibility of planar through-opening footprints.

use super::super::probe::ExtrudedSolidInfo as ExtrudedSolidLike;
use crate::bool2d::compute_signed_area;
use crate::profile::Profile2D;
use nalgebra::{Matrix4, Point2, Point3, Vector3};

/// Shoelace area magnitude of a 2D contour.
#[inline]
fn area_abs(poly: &[Point2<f64>]) -> f64 {
    compute_signed_area(poly).abs()
}

/// True iff `fp` lies strictly interior to `profile`: every vertex is inside the
/// outer boundary and outside every existing hole. A conservative interiority
/// test — a footprint that touches or crosses a boundary edge (a boundary notch)
/// fails and is routed to the exact kernel rather than approximated. This gate
/// says nothing about overlap between footprints; both routes remove their union.
pub(super) fn footprint_interior(fp: &[Point2<f64>], profile: &Profile2D) -> bool {
    fp.iter().all(|v| {
        crate::bool2d::point_in_contour(v, &profile.outer)
            && profile
                .holes
                .iter()
                .all(|h| !crate::bool2d::point_in_contour(v, h))
    })
}

/// Project one opening solid's outer profile into the host profile plane, and
/// keep it only if the solid sweeps PARALLEL to the host axis and penetrates the
/// full host depth [`hz_min`, `hz_max`]. `None` (ineligible → exact kernel) for a
/// perpendicular sweep, a partial-depth (recess) opening, an annular opening
/// (its own profile holes), or a degenerate footprint.
pub(super) fn opening_solid_footprint(
    op: &ExtrudedSolidLike,
    hm_inv: &Matrix4<f64>,
    host_axis: &Vector3<f64>,
    hz_min: f64,
    hz_max: f64,
    z_tol: f64,
) -> Option<Vec<Point2<f64>>> {
    if !op.profile.holes.is_empty() {
        return None;
    }
    let op_rot = op.m.fixed_view::<3, 3>(0, 0).into_owned();
    let op_axis = (op_rot * Vector3::new(0.0, 0.0, op.dir_sign)).try_normalize(1e-9)?;
    if host_axis.dot(&op_axis).abs() < 1.0 - 1.0e-6 {
        return None; // near-exact host-parallelism only (~0.08°); a tilt skews the cut
    }
    let to_host = hm_inv * op.m;
    let mut fp: Vec<Point2<f64>> = Vec::with_capacity(op.profile.outer.len());
    let mut zmin = f64::INFINITY;
    let mut zmax = f64::NEG_INFINITY;
    // Zero lateral sweep: base/far images must share host-XY (no oblique drift).
    let lat_tol = 1.0e-4 * (hz_max - hz_min).abs() + 1.0e-6;
    for p in &op.profile.outer {
        let base = to_host.transform_point(&Point3::new(p.x, p.y, 0.0));
        let far = to_host.transform_point(&Point3::new(p.x, p.y, op.dir_sign * op.depth));
        if (far.x - base.x).abs() > lat_tol || (far.y - base.y).abs() > lat_tol {
            return None;
        }
        fp.push(Point2::new(base.x, base.y));
        zmin = zmin.min(base.z.min(far.z));
        zmax = zmax.max(base.z.max(far.z));
    }
    // Through-cut: the opening must span the ENTIRE host depth. A partial-depth
    // void (recess / blind pocket) would leave material the flat re-extrude can't
    // represent — defer it to the exact kernel.
    if zmin > hz_min + z_tol || zmax < hz_max - z_tol {
        return None;
    }
    if area_abs(&fp) <= 0.0 {
        return None;
    }
    Some(fp)
}
