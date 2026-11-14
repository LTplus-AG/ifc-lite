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
    None,
    /// Over the footprint, within the cap band (a millimetre) of its plane.
    Band,
    /// Over the footprint and within the flush band: the cap rests on it.
    On,
}

/// The contact of a host facet `off` along the axis from a cap. An offset that
/// is not a number reads as `On`, which keeps the pull-in.
pub(super) fn contact(f: &CutterFrame, triangle: [Point3<f64>; 3], off: f64) -> Contact {
    let mag = triangle.iter().map(|p| p.coords.amax()).fold(0.0, f64::max);
    match (overlaps(f, triangle), off.abs() > flush_band_at(mag)) {
        (false, _) => Contact::None,
        (true, true) => Contact::Band,
        (true, false) => Contact::On,
    }
}

/// Conservative triangle/footprint intersection by the separating-axis test.
/// The frame box contains the whole cutter profile; admitting extra contact
/// preserves the established pull-in. Reuse its existing footprint band and
/// retain that pull-in when arithmetic cannot establish finite separation.
pub(super) fn overlaps(f: &CutterFrame, triangle: [Point3<f64>; 3]) -> bool {
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
