// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The host-side ray parity (`BComponents::inside`) uses a per-component BVH
//! instead of scanning every triangle of the other operand. These tests pin
//! that it is the same function: same verdict on adversarial queries, same
//! boolean output byte for byte, and less work on a large cutter.

use super::super::ray_parity::SEG_TESTS;
use super::super::{boolean, box_mesh, BoolOp, Tri};
use super::{operand_extent, point_inside, BComponents};

thread_local! {
    /// Test-only: route `BComponents::inside` through the old linear scan.
    pub(super) static FORCE_LINEAR: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn linear<T>(f: impl FnOnce() -> T) -> T {
    FORCE_LINEAR.with(|c| c.set(true));
    let out = f();
    FORCE_LINEAR.with(|c| c.set(false));
    out
}

fn seg_tests<T>(f: impl FnOnce() -> T) -> (T, u64) {
    let before = SEG_TESTS.with(|c| c.get());
    let out = f();
    (out, SEG_TESTS.with(|c| c.get()) - before)
}

/// Closed prism along x over a CCW (y, z) outline, outward-wound.
fn prism_x(outline: &[[f64; 2]], x0: f64, x1: f64) -> Vec<Tri> {
    let n = outline.len();
    let cy = outline.iter().map(|o| o[0]).sum::<f64>() / n as f64;
    let cz = outline.iter().map(|o| o[1]).sum::<f64>() / n as f64;
    let mut t = Vec::new();
    for i in 0..n {
        let (a, b) = (outline[i], outline[(i + 1) % n]);
        let (a0, b0, a1, b1) = ([x0, a[0], a[1]], [x0, b[0], b[1]], [x1, a[0], a[1]], [x1, b[0], b[1]]);
        t.push([a0, b0, b1]);
        t.push([a0, b1, a1]);
        t.push([[x0, cy, cz], b0, a0]);
        t.push([[x1, cy, cz], a1, b1]);
    }
    t
}

/// A wall-like box (0.3 x 4 x 3.5) and an N-segment cylinder through its thickness.
fn wall_and_cylinder(n: usize, offset: f64) -> (Vec<Tri>, Vec<Tri>) {
    let o = offset;
    let wall = box_mesh([o, o, 0.0], [o + 0.3, o + 4.0, 3.5]);
    let outline: Vec<[f64; 2]> = (0..n)
        .map(|i| {
            let t = i as f64 / n as f64 * std::f64::consts::TAU;
            [o + 2.0 + 0.6 * t.cos(), 1.6 + 0.6 * t.sin()]
        })
        .collect();
    (wall, prism_x(&outline, o - 0.09, o + 0.39))
}

/// Deterministic xorshift in [0, 1).
fn rng(seed: &mut u64) -> f64 {
    *seed ^= *seed << 13;
    *seed ^= *seed >> 7;
    *seed ^= *seed << 17;
    (*seed >> 11) as f64 / (1u64 << 53) as f64
}

/// Queries that stress the BVH's pruning: random points in and around the
/// component's box, every vertex, edge midpoint and face centroid (graze and
/// on-surface cases), and points displaced from them by one ulp-scale step.
fn queries(comp: &[Tri], seed: u64) -> Vec<[f64; 3]> {
    let mut lo = [f64::MAX; 3];
    let mut hi = [f64::MIN; 3];
    for t in comp {
        for v in t {
            for k in 0..3 {
                lo[k] = lo[k].min(v[k]);
                hi[k] = hi[k].max(v[k]);
            }
        }
    }
    let mut s = seed;
    let mut q = Vec::new();
    for _ in 0..1500 {
        q.push([0, 1, 2].map(|k| lo[k] - 0.5 * (hi[k] - lo[k]) + 2.0 * (hi[k] - lo[k]) * rng(&mut s)));
    }
    for t in comp {
        let c = [0, 1, 2].map(|k| (t[0][k] + t[1][k] + t[2][k]) / 3.0);
        q.push(c);
        q.push(t[0]);
        q.push([0, 1, 2].map(|k| 0.5 * (t[0][k] + t[1][k])));
        q.push(c.map(|x| x.next_up()));
        q.push(c.map(|x| x.next_down()));
    }
    q
}

#[test]
fn host_side_bvh_parity_matches_the_linear_scan() {
    let mut cases: Vec<Vec<Tri>> = Vec::new();
    for (n, off) in [(12, 0.0), (64, 0.0), (160, 0.0), (64, 1.0e5), (64, -3.7e6)] {
        cases.push(wall_and_cylinder(n, off).1);
        cases.push(wall_and_cylinder(n, off).0);
    }
    // a tiny component far from the origin, where the tree's own pad is smallest
    cases.push(box_mesh([4.0e6, 4.0e6, 10.0], [4.0e6 + 1.0e-3, 4.0e6 + 2.0e-3, 10.0 + 1.0e-3]));
    let mut checked = 0usize;
    for (i, comp) in cases.iter().enumerate() {
        let comps: [&[Tri]; 1] = [comp.as_slice()];
        let bc = BComponents::new(&comps);
        for p in queries(comp, 0x9e37_79b9_7f4a_7c15 ^ i as u64) {
            let old = point_inside(p, comp, bc.exts[0], bc.aabbs[0]);
            let new = bc.component_inside(0, comp, p);
            assert!(old == new, "case {i}: verdict differs at {p:?} (linear {old}, bvh {new})");
            checked += 1;
        }
        assert!(bc.exts[0] == operand_extent(comp), "case {i}: extent changed");
    }
    assert!(checked > 15_000, "too few queries checked: {checked}");
}

#[test]
fn boolean_output_is_byte_identical_to_the_linear_scan() {
    let mut cases: Vec<(Vec<Tri>, Vec<Tri>)> = vec![
        wall_and_cylinder(16, 0.0),
        wall_and_cylinder(64, 0.0),
        wall_and_cylinder(64, 1.0e5),
        // flush cutter of the host's exact thickness (coplanar faces on both sides)
        (box_mesh([0.0, 0.0, 0.0], [200.0, 5500.0, 4250.0]), box_mesh([0.0, 800.0, 300.0], [200.0, 4700.0, 2200.0])),
        // overlapping boxes, partly outside
        (box_mesh([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]), box_mesh([0.5, 0.25, -0.5], [1.5, 0.75, 0.5])),
    ];
    let (h, c) = wall_and_cylinder(48, 0.0);
    cases.push((c, h)); // many-triangle host, box cutter
    for (i, (a, b)) in cases.iter().enumerate() {
        for op in [BoolOp::Difference, BoolOp::Union, BoolOp::Intersection] {
            let old = linear(|| boolean(a, b, op));
            let new = boolean(a, b, op);
            let bits = |m: &Vec<Tri>| m.iter().flat_map(|t| t.iter().flat_map(|v| v.iter().map(|x| x.to_bits()))).collect::<Vec<u64>>();
            assert!(bits(&old) == bits(&new), "case {i} {op:?}: output differs ({} vs {} triangles)", old.len(), new.len());
        }
    }
}

#[test]
fn host_side_classification_work_grows_subquadratically_with_the_cutter() {
    // Cutter triangles 4N: 256 -> 512 -> 1024. The linear scan's work grows
    // about 4x per doubling (host fragments x cutter triangles); the BVH's about 2x.
    let work = |n: usize, lin: bool| {
        let (wall, cyl) = wall_and_cylinder(n, 0.0);
        let run = || seg_tests(|| boolean(&wall, &cyl, BoolOp::Difference)).1;
        if lin { linear(run) } else { run() }
    };
    let (w1, w2, w3) = (work(64, false), work(128, false), work(256, false));
    assert!(w2 as f64 <= 3.0 * w1 as f64, "BVH work 256->512 tris: {w1} -> {w2}");
    assert!(w3 as f64 <= 3.0 * w2 as f64, "BVH work 512->1024 tris: {w2} -> {w3}");
    // The linear baseline grows ~4x per doubling, so the ratios above discriminate,
    // and at 1024 cutter triangles the BVH does a small fraction of its work.
    let (l2, l3) = (work(128, true), work(256, true));
    assert!(l3 as f64 >= 3.5 * l2 as f64, "the linear baseline should grow ~4x ({l2} -> {l3}); the test no longer discriminates");
    assert!(w3 * 8 < l3, "BVH work {w3} not well below the linear scan's {l3} at 1024 cutter triangles");
}
