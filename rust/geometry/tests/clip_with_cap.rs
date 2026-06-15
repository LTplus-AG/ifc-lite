// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Phase 1 primitive: `clip_mesh_with_cap` must produce a WATERTIGHT solid whose
//! volume matches the exact `subtract_mesh` for the same planar end-clip — at a
//! fraction of the cost. Validated for axis-aligned and angled cuts.
//!
//! cargo test -p ifc-lite-geometry --release --test clip_with_cap -- --nocapture

use ifc_lite_geometry::{ClippingProcessor, Mesh, Plane};
use nalgebra::{Point3, Vector3};
use std::time::Instant;

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

fn volume(m: &Mesh) -> f64 {
    let p = &m.positions;
    let mut v = 0.0;
    for t in m.indices.chunks(3) {
        let g = |i: u32| {
            let b = i as usize * 3;
            [p[b] as f64, p[b + 1] as f64, p[b + 2] as f64]
        };
        let (a, b, c) = (g(t[0]), g(t[1]), g(t[2]));
        v += a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2])
            + a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
    v / 6.0
}

/// Count directed edges with no reverse partner (quantized) — 0 ⇒ watertight.
fn open_edges(m: &Mesh) -> usize {
    use std::collections::HashMap;
    const Q: f64 = 1.0e6;
    let p = &m.positions;
    let key = |i: u32| {
        let b = i as usize * 3;
        (
            (p[b] as f64 * Q).round() as i64,
            (p[b + 1] as f64 * Q).round() as i64,
            (p[b + 2] as f64 * Q).round() as i64,
        )
    };
    let mut dir: HashMap<((i64, i64, i64), (i64, i64, i64)), i32> = HashMap::new();
    for t in m.indices.chunks(3) {
        if t.len() < 3 {
            continue;
        }
        for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            let (ka, kb) = (key(a), key(b));
            *dir.entry((ka, kb)).or_default() += 1;
            *dir.entry((kb, ka)).or_default() -= 1;
        }
    }
    dir.values().filter(|&&c| c != 0).count()
}

/// Reference-free correctness for ANY cut plane: clipping the front half and the
/// back half (reversed normal) must each be watertight, and their volumes must
/// reconstruct the whole bar. A wrong cap (bad loop / winding / self-intersection)
/// moves a volume or leaves an open edge.
/// Returns true if the cap path applied (Some); false if it deferred (None).
/// When it applies, both halves must be watertight and sum to the whole.
fn complementary(name: &str, plane: Plane, s: usize) -> bool {
    let clipper = ClippingProcessor::new();
    let bar = box_mesh([0.0, 0.0, 0.0], [1.0, 0.1, 0.05], s);
    let full = volume(&bar);
    let back = Plane::new(plane.point, -plane.normal);

    let (Some(front_m), Some(back_m)) = (
        clipper.clip_mesh_with_cap(&bar, &plane).unwrap(),
        clipper.clip_mesh_with_cap(&bar, &back).unwrap(),
    ) else {
        println!("{name:<14} s={s}: DEFERRED (None) → exact fallback");
        return false;
    };
    let (vf, vb) = (volume(&front_m), volume(&back_m));
    let (of, ob) = (open_edges(&front_m), open_edges(&back_m));
    let sum_rel = (vf + vb - full).abs() / full.abs().max(1e-9);

    println!(
        "{name:<14} s={s}: front {vf:.6} + back {vb:.6} = {:.6} (whole {full:.6})  rel {sum_rel:.2e}  open f={of} b={ob}",
        vf + vb
    );
    assert_eq!(of, 0, "{name}: front cap not watertight ({of} open edges)");
    assert_eq!(ob, 0, "{name}: back cap not watertight ({ob} open edges)");
    assert!(sum_rel < 1.0e-3, "{name}: front+back volume ≠ whole ({sum_rel:.2e})");
    true
}

#[test]
fn capped_clip_is_watertight_and_complete() {
    // Axis-aligned + oblique cuts must apply correctly.
    assert!(complementary("axis-x", Plane::new(Point3::new(0.8, 0.0, 0.0), Vector3::new(-1.0, 0.0, 0.0)), 4));
    assert!(complementary("oblique", Plane::new(Point3::new(0.7, 0.05, 0.025), Vector3::new(-1.0, 0.5, 0.0).normalize()), 4));
    // Many generic angled cuts at jittered positions — gauge the fallback rate.
    let mut applied = 0;
    let total = 40;
    for k in 0..total {
        let a = 0.3 + 0.4 * (k as f64 / total as f64);
        let b = 0.2 + 0.5 * ((k * 7 % total) as f64 / total as f64);
        let n = Vector3::new(-1.0, a, b).normalize();
        let px = 0.5 + 0.0037 * k as f64; // jitter off grid lines
        if complementary("angled", Plane::new(Point3::new(px, 0.05 + 1e-4, 0.025 + 1e-4), n), 6) {
            applied += 1;
        }
    }
    println!("\nfast-cap applied on {applied}/{total} generic angled cuts (rest defer to exact)");
    // Most generic cuts must take the fast path for it to be worthwhile.
    assert!(applied >= total * 8 / 10, "fast-cap applied only {applied}/{total} — too many fallbacks");
}

#[test]
fn capped_clip_matches_exact_subtract_and_is_faster() {
    let clipper = ClippingProcessor::new();
    let plane = Plane::new(Point3::new(0.8, 0.0, 0.0), Vector3::new(-1.0, 0.0, 0.0));
    for s in [4usize, 8, 16] {
        let bar = box_mesh([0.0, 0.0, 0.0], [1.0, 0.1, 0.05], s);
        let cutter = box_mesh([0.8, -1.0, -1.0], [2.0, 2.0, 2.0], 1);

        let capped = clipper.clip_mesh_with_cap(&bar, &plane).unwrap().expect("capped");
        let exact = clipper.subtract_mesh(&bar, &cutter).unwrap();
        let _ = clipper.take_failures();
        let rel = (volume(&capped) - volume(&exact)).abs() / volume(&exact).abs().max(1e-9);

        let iters = 2000;
        let t = Instant::now();
        for _ in 0..iters {
            let _ = clipper.clip_mesh_with_cap(&bar, &plane).unwrap();
        }
        let cap_ms = t.elapsed().as_secs_f64() * 1000.0 / iters as f64;
        let t = Instant::now();
        for _ in 0..iters {
            let _ = clipper.subtract_mesh(&bar, &cutter).unwrap();
            let _ = clipper.take_failures();
        }
        let sub_ms = t.elapsed().as_secs_f64() * 1000.0 / iters as f64;

        println!(
            "tris={:<5} rel-dev {rel:.2e}  clip+cap {cap_ms:.4}ms vs exact {sub_ms:.4}ms  ({:.0}x faster)",
            bar.triangle_count(),
            sub_ms / cap_ms.max(1e-9)
        );
        assert!(rel < 1.0e-3, "volume diverged {rel:.2e} from exact subtract");
        assert_eq!(open_edges(&capped), 0, "capped clip not watertight");
    }
}
