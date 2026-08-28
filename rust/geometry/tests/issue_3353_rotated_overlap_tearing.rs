// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #3353: a family of boolean tears survives the #3341 parity fix on
//! OVERLAPPING and ROTATED operand pairs (#3341 fixed the disjoint/touching
//! family only).
//!
//! Both pinned cases below are real failures found by a randomized sweep of
//! 60000 axis-aligned-host / rotated-cutter box pairs across Difference,
//! Union and Intersection, watertightness checked by welding the OUTPUT at
//! 0.1 mm and counting DIRECTED half-edges that do not pair 1-forward/
//! 1-reverse (a net-signed tally can cancel a real non-manifold seam to zero,
//! the same finding this repo already records for
//! `processors/boolean/chain_cycle_tests.rs`).
//!
//! `proptest_shrunk`: raw kernel output is already watertight; the tear is
//! introduced by `consolidate_coplanar`'s per-bucket independent
//! re-triangulation emitting the same boundary vertex twice, a few hundred
//! micrometres apart, on an axis-aligned host bucket whose boundary within
//! that bucket is skewed by the rotated cutter.
//!
//! `sweep_261`: a larger, multi-bucket case with the same signature.
//!
//! This does NOT close the whole family #3353 reports (rotated + overlapping
//! tear at 0.08-0.38% pre-fix; the sweep in this file's history still finds a
//! residual, smaller-magnitude rate after `close_micro_gaps` — see
//! `.changeset/close-micro-gaps-issue-3353.md`). The two cases pinned here are
//! cases the fix in `csg/consolidate.rs::close_micro_gaps` closes completely.

use ifc_lite_geometry::{ClippingProcessor, Mesh};
use nalgebra::{Point3, Rotation3, Unit, Vector3};
use std::collections::HashMap;

/// Outward-wound axis-aligned box. Diagonal-split tessellation, matching
/// `touching_operand.rs`'s `boxed` helper — NOT the kernel's own `box_mesh`
/// tessellation, which splits the two quads the other way and would move
/// every face centroid enough that these pinned cases stop reproducing.
fn boxed(min: [f64; 3], size: [f64; 3], rot: Option<(Vector3<f64>, f64, [f64; 3])>) -> Mesh {
    let mx = [min[0] + size[0], min[1] + size[1], min[2] + size[2]];
    let c = |i: usize| -> [f64; 2] { [min[i], mx[i]] };
    let mut corners: Vec<Point3<f64>> = [
        (0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0),
        (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1),
    ]
    .iter()
    .map(|&(i, j, k)| Point3::new(c(0)[i], c(1)[j], c(2)[k]))
    .collect();
    if let Some((axis, angle, about)) = rot {
        let r = Rotation3::from_axis_angle(&Unit::new_normalize(axis), angle);
        let o = Point3::new(about[0], about[1], about[2]);
        for p in corners.iter_mut() {
            *p = o + r * (*p - o);
        }
    }
    let faces: [[usize; 4]; 6] = [
        [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
        [2, 3, 7, 6], [0, 4, 7, 3], [1, 2, 6, 5],
    ];
    let mut m = Mesh::with_capacity(24, 36);
    for f in &faces {
        let e1 = corners[f[1]] - corners[f[0]];
        let e2 = corners[f[2]] - corners[f[0]];
        let n = e1.cross(&e2).try_normalize(1e-12).unwrap_or(Vector3::z());
        let b = m.vertex_count() as u32;
        for &i in f {
            m.add_vertex(corners[i], n);
        }
        m.add_triangle(b, b + 1, b + 2);
        m.add_triangle(b, b + 2, b + 3);
    }
    m
}

/// Watertightness, counting the two directions SEPARATELY after welding by
/// position at 0.1 mm. See the module doc for why a net-signed tally is not
/// enough.
fn open_edges(m: &Mesh) -> Result<usize, String> {
    if m.is_empty() {
        return Err("host was deleted entirely".to_string());
    }
    let welded = m.welded_by_position(1e-4);
    let mut edges: HashMap<(u32, u32), (u32, u32)> = HashMap::new();
    for tri in welded.indices.chunks_exact(3) {
        for k in 0..3 {
            let (a, b) = (tri[k], tri[(k + 1) % 3]);
            if a == b {
                return Err(format!("degenerate edge: triangle repeats welded vertex {a}"));
            }
            let e = edges.entry((a.min(b), a.max(b))).or_insert((0, 0));
            if a < b {
                e.0 += 1;
            } else {
                e.1 += 1;
            }
        }
    }
    Ok(edges.values().filter(|&&(f, r)| f != 1 || r != 1).count())
}

struct Case {
    name: &'static str,
    a_min: [f64; 3],
    a_size: [f64; 3],
    b_min: [f64; 3],
    b_size: [f64; 3],
    axis: [f64; 3],
    angle: f64,
}

const CASES: &[Case] = &[
    Case {
        name: "proptest_shrunk",
        a_min: [-1.6304261474312827, -1.3635631291487638, -0.5409381305938963],
        a_size: [2.9769341489955012, 0.7727152845317564, 1.385780304417514],
        b_min: [-1.635036035905773, -2.126505357416188, -1.273167972967614],
        b_size: [3.649752006027041, 2.1022053843017137, 3.615608517082627],
        axis: [-0.31681812426035605, 0.8964131053231463, -0.8569595303250017],
        angle: 0.17698030735721204,
    },
    Case {
        name: "sweep_261",
        a_min: [-1.72371594746207, -0.35246108913603935, -1.2204342720208154],
        a_size: [2.8534163464770894, 3.0795194627753784, 2.858202766048261],
        b_min: [-2.5947221996202225, 0.7995282321488091, -1.1895637752048271],
        b_size: [3.215043208338911, 0.9570224289084479, 3.548848436777412],
        axis: [0.413429423622099, -0.8221765971936017, -0.6789513492042303],
        angle: 1.3791241095493956,
    },
];

/// The property: an overlapping, rotated cutter must not tear the host open.
/// Checked over Difference, Union and Intersection, since #3353 found the
/// family in all three ops.
#[test]
fn overlapping_rotated_operands_never_tear() {
    let clipper = ClippingProcessor::new();
    let mut failures = Vec::new();
    for case in CASES {
        let a = boxed(case.a_min, case.a_size, None);
        let about = [
            case.b_min[0] + case.b_size[0] / 2.0,
            case.b_min[1] + case.b_size[1] / 2.0,
            case.b_min[2] + case.b_size[2] / 2.0,
        ];
        let b = boxed(
            case.b_min,
            case.b_size,
            Some((Vector3::new(case.axis[0], case.axis[1], case.axis[2]), case.angle, about)),
        );
        assert_eq!(open_edges(&a), Ok(0), "{}: operand A must be closed going in", case.name);
        assert_eq!(open_edges(&b), Ok(0), "{}: operand B must be closed going in", case.name);

        for (opname, out) in [
            ("Difference", clipper.subtract_mesh(&a, &b)),
            ("Union", clipper.union_mesh(&a, &b)),
            ("Intersection", clipper.intersection_mesh(&a, &b)),
        ] {
            let out = out.expect("boolean op must not error");
            match open_edges(&out) {
                Err(why) => failures.push(format!("{} {opname}: {why}", case.name)),
                Ok(0) => {}
                Ok(bad) => {
                    failures.push(format!("{} {opname}: {bad} unmatched edges", case.name))
                }
            }
        }
    }
    assert!(
        failures.is_empty(),
        "a closed-in operand pair must come back closed-out:\n  {}",
        failures.join("\n  ")
    );
}
