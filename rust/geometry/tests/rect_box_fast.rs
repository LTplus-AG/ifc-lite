// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Phase 2 fast path: `subtract_box_fast` must produce a WATERTIGHT solid whose
//! volume matches the exact `subtract_mesh` for a rectangular opening cut
//! transversally through a slab-like host — at a fraction of the cost — and must
//! DEFER (return `None`) for anything that isn't a clean transversal box cut.
//!
//! Motivation: the pure-Rust exact kernel routed EVERY opening — rectangular
//! included — through the full arrangement, making CSG 85-90% of load time on
//! void-heavy models (issues #1109 / #1138). This restores an analytic path for
//! the rectangular common case (~95% of cuts) without reintroducing native/wasm
//! drift.
//!
//! cargo test -p ifc-lite-geometry --test rect_box_fast -- --nocapture

use ifc_lite_geometry::{ClippingProcessor, Mesh};
use nalgebra::Point3;

/// Build a closed, outward-wound axis-aligned box with `s`×`s` quads per face.
fn box_mesh(lo: [f32; 3], hi: [f32; 3], s: usize) -> Mesh {
    let mut m = Mesh::new();
    let mut push_quad = |a: [f32; 3], b: [f32; 3], c: [f32; 3], d: [f32; 3], n: [f32; 3]| {
        let base = (m.positions.len() / 3) as u32;
        for v in [a, b, c, d] {
            m.positions.extend_from_slice(&v);
            m.normals.extend_from_slice(&n);
        }
        m.indices
            .extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    };
    let mut face = |o: [f32; 3], u: [f32; 3], v: [f32; 3], n: [f32; 3]| {
        for i in 0..s {
            for j in 0..s {
                let (fi, fj, fs) = (i as f32, j as f32, s as f32);
                let p = |ti: f32, tj: f32| {
                    [
                        o[0] + u[0] * ti + v[0] * tj,
                        o[1] + u[1] * ti + v[1] * tj,
                        o[2] + u[2] * ti + v[2] * tj,
                    ]
                };
                push_quad(
                    p(fi / fs, fj / fs),
                    p((fi + 1.0) / fs, fj / fs),
                    p((fi + 1.0) / fs, (fj + 1.0) / fs),
                    p(fi / fs, (fj + 1.0) / fs),
                    n,
                );
            }
        }
    };
    let dx = [hi[0] - lo[0], 0.0, 0.0];
    let dy = [0.0, hi[1] - lo[1], 0.0];
    let dz = [0.0, 0.0, hi[2] - lo[2]];
    let [lx, ly, lz] = lo;
    face([lx, ly, lz], dz, dy, [-1.0, 0.0, 0.0]);
    face([hi[0], ly, lz], dy, dz, [1.0, 0.0, 0.0]);
    face([lx, ly, lz], dx, dz, [0.0, -1.0, 0.0]);
    face([lx, hi[1], lz], dz, dx, [0.0, 1.0, 0.0]);
    face([lx, ly, lz], dy, dx, [0.0, 0.0, -1.0]);
    face([lx, ly, hi[2]], dx, dy, [0.0, 0.0, 1.0]);
    m
}

/// Signed volume of a triangle soup (positive for an outward-wound closed solid).
fn volume(m: &Mesh) -> f64 {
    let p = &m.positions;
    let mut v = 0.0;
    for t in m.indices.chunks(3) {
        let g = |i: u32| {
            let b = i as usize * 3;
            [p[b] as f64, p[b + 1] as f64, p[b + 2] as f64]
        };
        let (a, b, c) = (g(t[0]), g(t[1]), g(t[2]));
        v += a[0] * (b[1] * c[2] - b[2] * c[1])
            + a[1] * (b[2] * c[0] - b[0] * c[2])
            + a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
    (v / 6.0).abs()
}

/// Every directed edge must have its reverse (closed 2-manifold). Quantize to a
/// 0.1mm grid so f32 round-off doesn't spuriously fail.
type Edge = ((i64, i64, i64), (i64, i64, i64));

fn watertight(m: &Mesh) -> bool {
    use std::collections::HashMap;
    let p = &m.positions;
    let key = |i: u32| {
        let b = i as usize * 3;
        (
            (p[b] as f64 * 1.0e4).round() as i64,
            (p[b + 1] as f64 * 1.0e4).round() as i64,
            (p[b + 2] as f64 * 1.0e4).round() as i64,
        )
    };
    let mut bal: HashMap<Edge, i32> = HashMap::new();
    for t in m.indices.chunks(3) {
        if t.len() < 3 {
            continue;
        }
        for (u, v) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            let (ku, kv) = (key(u), key(v));
            if ku == kv {
                continue;
            }
            *bal.entry((ku, kv)).or_insert(0) += 1;
            *bal.entry((kv, ku)).or_insert(0) -= 1;
        }
    }
    bal.values().all(|&c| c == 0)
}

/// host slab x∈[0,4] (length), y∈[0,0.2] (thickness), z∈[0,3] (height).
fn wall(s: usize) -> Mesh {
    box_mesh([0.0, 0.0, 0.0], [4.0, 0.2, 3.0], s)
}

#[test]
fn window_through_thickness_matches_exact_and_is_watertight() {
    let clip = ClippingProcessor::new();
    // window 1×1, cut transversally through the Y thickness (penetrating caps).
    let bmin = Point3::new(1.0, -0.1, 1.0);
    let bmax = Point3::new(2.0, 0.3, 2.0);

    for s in [1usize, 4] {
        let host = wall(s);
        let fast = clip
            .subtract_box_fast(&host, bmin, bmax)
            .unwrap()
            .unwrap_or_else(|| panic!("fast path deferred on a clean slab (s={s})"));
        assert!(watertight(&fast), "fast result not watertight (s={s})");

        let cutter = box_mesh([1.0, -0.1, 1.0], [2.0, 0.3, 2.0], 1);
        let exact = clip.subtract_mesh(&host, &cutter).unwrap();

        let (vf, ve) = (volume(&fast), volume(&exact));
        // wall 4·0.2·3 = 2.4 minus window column 1·0.2·1 = 0.2 ⇒ 2.2
        assert!((vf - 2.2).abs() < 1e-4, "fast volume {vf} != 2.2 (s={s})");
        assert!((vf - ve).abs() < 1e-4, "fast {vf} vs exact {ve} (s={s})");
    }
}

#[test]
fn window_through_height_axis_generality() {
    // Same wall, but a box that spans the Z (height) axis instead — exercises a
    // different through-axis so the axis bookkeeping isn't hard-wired to Y.
    let clip = ClippingProcessor::new();
    let host = wall(2);
    let bmin = Point3::new(1.0, 0.05, -0.1);
    let bmax = Point3::new(2.0, 0.15, 3.1);
    let fast = clip
        .subtract_box_fast(&host, bmin, bmax)
        .unwrap()
        .expect("fast path deferred on a clean Z-through slab");
    assert!(watertight(&fast));
    // column removed: x 1, y 0.1, z 3 ⇒ 0.3 ; wall 2.4 ⇒ 2.1
    assert!((volume(&fast) - 2.1).abs() < 1e-4, "vol {}", volume(&fast));
}

#[test]
fn two_disjoint_windows_sequentially() {
    let clip = ClippingProcessor::new();
    let host = wall(2);
    let w1 = clip
        .subtract_box_fast(&host, Point3::new(0.5, -0.1, 1.0), Point3::new(1.0, 0.3, 2.0))
        .unwrap()
        .expect("window 1 deferred");
    let w2 = clip
        .subtract_box_fast(&w1, Point3::new(2.5, -0.1, 1.0), Point3::new(3.0, 0.3, 2.0))
        .unwrap()
        .expect("window 2 deferred on already-cut host");
    assert!(watertight(&w2), "sequential cut not watertight");
    // two 0.5·0.2·1 = 0.1 columns removed ⇒ 2.4 - 0.2 = 2.2
    assert!((volume(&w2) - 2.2).abs() < 1e-4, "vol {}", volume(&w2));
}

#[test]
fn blind_pocket_cuts_watertight() {
    // Box recessed into the wall (penetrates the front face only, stops inside):
    // a blind pocket. The general path handles it — front face opens, the other 5
    // faces are reveals (incl. the pocket back). Watertight + volume-equal.
    let clip = ClippingProcessor::new();
    let host = wall(2);
    let (bmin, bmax) = (Point3::new(1.0, -0.1, 1.0), Point3::new(2.0, 0.1, 2.0));
    let fast = clip
        .subtract_box_fast(&host, bmin, bmax)
        .unwrap()
        .expect("blind pocket should now cut");
    assert!(watertight(&fast), "blind pocket not watertight");
    let cutter = box_mesh([1.0, -0.1, 1.0], [2.0, 0.1, 2.0], 1);
    let exact = clip.subtract_mesh(&host, &cutter).unwrap();
    // pocket X 1 × Y[0,0.1] × Z 1 = 0.1 removed ⇒ 2.3
    assert!((volume(&fast) - 2.3).abs() < 1e-3, "pocket vol {}", volume(&fast));
    assert!((volume(&fast) - volume(&exact)).abs() < 1e-3, "fast vs exact");
}

#[test]
fn corner_cut_watertight() {
    // Box spans the thickness (through) and pokes past the -X wall end: an
    // end/corner notch. The general path handles it — the -X side opens to the
    // wall end, X=2 / Z=1 / Z=2 are reveals.
    let clip = ClippingProcessor::new();
    let host = wall(2);
    let (bmin, bmax) = (Point3::new(-0.1, -0.1, 1.0), Point3::new(2.0, 0.3, 2.0));
    let fast = clip
        .subtract_box_fast(&host, bmin, bmax)
        .unwrap()
        .expect("corner notch should now cut");
    assert!(watertight(&fast), "corner notch not watertight");
    let cutter = box_mesh([-0.1, -0.1, 1.0], [2.0, 0.3, 2.0], 1);
    let exact = clip.subtract_mesh(&host, &cutter).unwrap();
    // removes X[0,2] × Y[0,0.2] × Z 1 = 0.4 ⇒ 2.0
    assert!((volume(&fast) - 2.0).abs() < 1e-3, "notch vol {}", volume(&fast));
    assert!((volume(&fast) - volume(&exact)).abs() < 1e-3, "fast vs exact");
}

#[test]
fn floor_flush_door_watertight() {
    // The dominant real-IFC case: a door flush with the floor — Z-min sits on the
    // wall base (no bottom reveal; opens to the host edge), Z-max is the lintel.
    let clip = ClippingProcessor::new();
    let host = wall(2);
    let (bmin, bmax) = (Point3::new(1.5, -0.1, 0.0), Point3::new(2.5, 0.3, 2.0));
    let fast = clip
        .subtract_box_fast(&host, bmin, bmax)
        .unwrap()
        .expect("floor-flush door should cut");
    assert!(watertight(&fast), "door not watertight");
    let cutter = box_mesh([1.5, -0.1, 0.0], [2.5, 0.3, 2.0], 1);
    let exact = clip.subtract_mesh(&host, &cutter).unwrap();
    // removes X 1 × Y 0.2 × Z[0,2] = 0.4 ⇒ 2.0
    assert!((volume(&fast) - 2.0).abs() < 1e-3, "door vol {}", volume(&fast));
    assert!((volume(&fast) - volume(&exact)).abs() < 1e-3, "fast vs exact");
}

#[test]
fn disjoint_box_is_noop() {
    let clip = ClippingProcessor::new();
    let host = wall(2);
    let r = clip
        .subtract_box_fast(&host, Point3::new(10.0, -0.1, 1.0), Point3::new(11.0, 0.3, 2.0))
        .unwrap()
        .expect("disjoint box should return the host unchanged");
    assert!((volume(&r) - 2.4).abs() < 1e-4, "no-op changed volume: {}", volume(&r));
}
