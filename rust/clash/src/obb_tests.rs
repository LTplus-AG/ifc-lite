// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Axis-conditioning tests for `obb_penetration_depth` — mirrors the
//! `axis conditioning` describe block in
//! `packages/clash/src/engine-ts/obb.test.ts` (review: #2536). Same fixtures,
//! same tolerances, so the two kernels are pinned to the same behaviour.

use super::{obb_penetration_depth, Obb};
use crate::vec3::{cross, dot, Vec3};

/// Rodrigues rotation of `v` by `angle` radians about the unit axis `w`.
fn rotated(w: Vec3, angle: f64, v: Vec3) -> Vec3 {
    let c = angle.cos();
    let s = angle.sin();
    let wxv = cross(w, v);
    let wdv = dot(w, v);
    [
        v[0] * c + wxv[0] * s + w[0] * wdv * (1.0 - c),
        v[1] * c + wxv[1] * s + w[1] * wdv * (1.0 - c),
        v[2] * c + wxv[2] * s + w[2] * wdv * (1.0 - c),
    ]
}

fn unitized(v: Vec3) -> Vec3 {
    let len = dot(v, v).sqrt();
    [v[0] / len, v[1] / len, v[2] / len]
}

/// sin(tilt) ~ 8e-7: within f64 resolution, far below any absolute 1e-6 guard.
const BEAM_TILT: f64 = 8e-7;

/// Two 2000 km long, 1 m thick beams, nearly parallel (relative tilt
/// `BEAM_TILT` about an axis perpendicular to the beam direction, generic in
/// the cross-section plane), meeting edge-to-edge along their common normal:
/// `separation < 0` embeds them by that depth, `> 0` leaves a gap. The scene
/// is world-rotated so the float cross products involve real cancellation.
/// See the TS `skewBeams` doc comment for why this shape puts the true
/// minimum-translation axis on the NEAR-DEGENERATE cross-product candidate
/// (independently confirmed by exact rational arithmetic: at
/// `separation = -0.02` the common normal reads 0.02, the runner-up 0.445).
fn skew_beams(separation: f64) -> (Obb, Obb) {
    let l = 1.0e6;
    let w = 0.5;
    let beta = 0.7f64; // tilt-axis direction in the cross-section plane: generic
    let e: [Vec3; 3] = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let w_rel = unitized([0.0, beta.cos(), beta.sin()]);
    let b_axes: [Vec3; 3] = [
        unitized(rotated(w_rel, BEAM_TILT, e[0])),
        unitized(rotated(w_rel, BEAM_TILT, e[1])),
        unitized(rotated(w_rel, BEAM_TILT, e[2])),
    ];
    let u0 = unitized(cross(e[0], b_axes[0])); // common normal of the beam directions
    let half = [l, w, w];
    let mut r_a = 0.0;
    let mut r_b = 0.0;
    for i in 0..3 {
        r_a += half[i] * dot(e[i], u0).abs();
        r_b += half[i] * dot(b_axes[i], u0).abs();
    }
    let off = r_a + r_b + separation;
    let t: Vec3 = [off * u0[0], off * u0[1], off * u0[2]];
    // Generic world rotation, so no coordinate stays exactly zero.
    let w_world = unitized([1.0, 2.0, 3.0]);
    let w_angle = 0.6;
    let place = |center: Vec3, axes: [Vec3; 3]| -> Obb {
        Obb {
            center: rotated(w_world, w_angle, center),
            axes: [
                unitized(rotated(w_world, w_angle, axes[0])),
                unitized(rotated(w_world, w_angle, axes[1])),
                unitized(rotated(w_world, w_angle, axes[2])),
            ],
            half,
        }
    };
    (place([0.0, 0.0, 0.0], e), place(t, b_axes))
}

#[test]
fn measures_the_true_depth_of_skew_near_parallel_beams_on_their_common_normal() {
    let (a, b) = skew_beams(-0.02);
    let d = obb_penetration_depth(&a, &b).expect("intersecting pair must report a depth");
    // True MTD = 0.02; tolerance is the documented projection noise bound for
    // this axis (~4.5e-3 here: extent_sum * 8 * EPS / len).
    assert!(
        (d - 0.02).abs() < 5e-3,
        "expected the common-normal depth 0.02 +/- 5e-3, got {d}",
    );
}

#[test]
fn still_separates_the_same_beams_when_they_are_genuinely_apart() {
    // 0.5 m gap along the common normal — the ONLY separating axis of the 15.
    let (a, b) = skew_beams(0.5);
    assert_eq!(
        obb_penetration_depth(&a, &b),
        None,
        "a disjoint pair must not report a penetration depth",
    );
}

#[test]
fn skips_an_exactly_parallel_cross_axis_without_dividing_by_zero() {
    // Axis-aligned boxes constructed directly, so all nine cross-product
    // candidates are exactly [0, 0, 0]. The depth must be the exact
    // face-axis overlap 0.5 — finite, not NaN from a 0/0 normalisation.
    let axes: [Vec3; 3] = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let a = Obb {
        center: [0.0, 0.0, 0.0],
        axes,
        half: [1.0, 2.0, 3.0],
    };
    let b = Obb {
        center: [1.5, 0.0, 0.0],
        axes,
        half: [1.0, 2.0, 3.0],
    };
    assert_eq!(obb_penetration_depth(&a, &b), Some(0.5));
}
