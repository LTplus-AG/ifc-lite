// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Degenerate-input tests for the exact BigRational tier. Split into a `_tests.rs`
//! file so `rational.rs` stays under the module-size ratchet.

use super::*;
use num_traits::ToPrimitive;

// Line pq lies in plane rst (d == 0): the exact λ/d is undefined. Pre-fix the
// BigRational division panicked ("denominator == 0"); it must now return the
// finite segment midpoint.
#[test]
fn lpi_point_parallel_line_plane_is_finite_not_panic() {
    let l = Lpi {
        p: [0.0, 0.0, 0.0],
        q: [1.0, 0.0, 0.0],
        r: [0.0, 0.0, 0.0],
        s: [1.0, 0.0, 0.0],
        t: [0.0, 1.0, 0.0],
    };
    let pt = lpi_point(&l);
    assert_eq!(pt[0], BigRational::from_float(0.5).unwrap());
    assert!(pt.iter().all(|c| c.to_f64().unwrap().is_finite()));
}

// Three parallel planes never meet at a point (d == 0): must fall back to a
// finite centroid, not divide by zero.
#[test]
fn tpi_point_parallel_planes_is_finite_not_panic() {
    let plane_at = |z: f64| [[0.0, 0.0, z], [1.0, 0.0, z], [0.0, 1.0, z]];
    let t = Tpi {
        planes: [plane_at(0.0), plane_at(1.0), plane_at(2.0)],
    };
    let pt = tpi_point(&t);
    assert!(pt.iter().all(|c| c.to_f64().unwrap().is_finite()));
}
