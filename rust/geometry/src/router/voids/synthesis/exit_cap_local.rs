// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Finite contact needed before pulling a coincident jamb cap into a void.

use super::super::super::flush::flush_band_at;
use super::{CutterFrame, Point3, BAND_FRACTION};

/// How a host facet in a cap's band meets the cap, weakest first.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum Contact {
    /// Not over the cutter's footprint.
    Clear,
    /// Over the footprint, within the cap band (a millimetre or more) of its plane.
    Band,
    /// Over the footprint and within the flush band: the cap rests on it.
    On,
}

/// The flush band where this cutter sits. One value per cutter, so the skin
/// sample and the facet test draw the same line.
pub(super) fn flush_band(f: &CutterFrame) -> f64 {
    flush_band_at([f.lo, f.hi].iter().map(|p| f.point_at(p.x, p.y, p.z).coords.amax()).fold(0.0, f64::max))
}

/// The contact of a host facet with the cap at `cap` along the axis. A facet
/// may tilt up to ten degrees off the cap, so its distance is read where it
/// matters: the nearest its plane comes to the cap over the cutter's
/// footprint. A vertex beside the footprint, or the one listed first, decides
/// nothing. A facet too steep to carry a depth keeps the pull-in.
pub(super) fn contact(f: &CutterFrame, triangle: [Point3<f64>; 3], cap: f64) -> Contact {
    if !overlaps(f, triangle) {
        return Contact::Clear;
    }
    let axes = [f.frame.cross_a, f.frame.cross_b, f.depth()];
    let [p, q, r] = triangle.map(|v| axes.map(|axis| v.coords.dot(&axis)));
    let (e, g) = ([0, 1, 2].map(|k| q[k] - p[k]), [0, 1, 2].map(|k| r[k] - p[k]));
    let n = [e[1] * g[2] - e[2] * g[1], e[2] * g[0] - e[0] * g[2], e[0] * g[1] - e[1] * g[0]];
    // Offset from the cap of the facet's plane above footprint point `(u, v)`.
    let off = |u: f64, v: f64| p[2] - (n[0] * (u - p[0]) + n[1] * (v - p[1])) / n[2] - cap;
    let corners = [off(f.lo.x, f.lo.y), off(f.hi.x, f.lo.y), off(f.hi.x, f.hi.y), off(f.lo.x, f.hi.y)];
    let (lo, hi) = corners.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), &c| (lo.min(c), hi.max(c)));
    // Not `lo > band`: a plane with no finite depth compares false and stays `On`.
    if lo > flush_band(f) || hi < -flush_band(f) {
        Contact::Band
    } else {
        Contact::On
    }
}

/// Conservative triangle/footprint intersection by the separating-axis test.
/// The frame box contains the whole cutter profile; admitting extra contact
/// preserves the established pull-in. Reuse its existing footprint band and
/// retain that pull-in when arithmetic cannot establish finite separation.
fn overlaps(f: &CutterFrame, triangle: [Point3<f64>; 3]) -> bool {
    let projected = triangle.map(|p| {
        [
            p.coords.dot(&f.frame.cross_a),
            p.coords.dot(&f.frame.cross_b),
        ]
    });
    let lo = [f.lo.x, f.lo.y];
    let hi = [f.hi.x, f.hi.y];
    let pad = std::array::from_fn::<_, 2, _>(|k| (hi[k] - lo[k]).max(1.0) * BAND_FRACTION);
    let rectangle = [
        [lo[0] - pad[0], lo[1] - pad[1]],
        [hi[0] + pad[0], lo[1] - pad[1]],
        [hi[0] + pad[0], hi[1] + pad[1]],
        [lo[0] - pad[0], hi[1] + pad[1]],
    ];
    if projected
        .iter()
        .chain(&rectangle)
        .flatten()
        .any(|x| !x.is_finite())
    {
        return true;
    }
    let axes = std::array::from_fn::<_, 5, _>(|i| match i {
        0 => [1.0, 0.0],
        1 => [0.0, 1.0],
        _ => {
            let a = projected[i - 2];
            let b = projected[(i - 1) % 3];
            [a[1] - b[1], b[0] - a[0]]
        }
    });
    for axis in axes {
        let a = projected.map(|p| p[0] * axis[0] + p[1] * axis[1]);
        let b = rectangle.map(|p| p[0] * axis[0] + p[1] * axis[1]);
        if a.iter().chain(&b).any(|x| !x.is_finite()) {
            return true;
        }
        let min = |v: &[f64]| v.iter().copied().fold(f64::INFINITY, f64::min);
        let max = |v: &[f64]| v.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        if min(&a) > max(&b) || min(&b) > max(&a) {
            return false;
        }
    }
    true
}

#[cfg(test)]
#[path = "exit_cap_local_tests.rs"]
mod tests;
