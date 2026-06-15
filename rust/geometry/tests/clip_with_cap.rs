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

/// A faceted cylinder (drilling cutter) spanning the bar along Z, centred at
/// (cx,cy), radius r, `seg` facets. Its side facets each straddle the bar, so the
/// planar-clip detector must DEFER it to the exact kernel.
fn cylinder_z(cx: f32, cy: f32, r: f32, z0: f32, z1: f32, seg: usize) -> Mesh {
    let mut m = Mesh::new();
    let ring: Vec<[f32; 2]> = (0..seg)
        .map(|k| {
            let a = std::f32::consts::TAU * k as f32 / seg as f32;
            [cx + r * a.cos(), cy + r * a.sin()]
        })
        .collect();
    let mut tri = |a: [f32; 3], b: [f32; 3], c: [f32; 3]| {
        let base = (m.positions.len() / 3) as u32;
        for v in [a, b, c] {
            m.positions.extend_from_slice(&v);
            m.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
        }
        m.indices.extend_from_slice(&[base, base + 1, base + 2]);
    };
    for k in 0..seg {
        let (p, q) = (ring[k], ring[(k + 1) % seg]);
        // side wall (two tris, outward)
        tri([p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], z1]);
        tri([p[0], p[1], z0], [q[0], q[1], z1], [p[0], p[1], z1]);
        // caps
        tri([cx, cy, z1], [p[0], p[1], z1], [q[0], q[1], z1]);
        tri([cx, cy, z0], [q[0], q[1], z0], [p[0], p[1], z0]);
    }
    m
}

/// Extrude a 2D polygon (CCW in XY) along Z into a prism mesh with outward-wound
/// side walls. Caps are fan-triangulated (fine even when non-convex — the test
/// only needs the face planes + vertices for the convexity gate).
fn extrude_z(poly: &[[f32; 2]], z0: f32, z1: f32) -> Mesh {
    let mut m = Mesh::new();
    let mut tri = |a: [f32; 3], b: [f32; 3], c: [f32; 3]| {
        let base = (m.positions.len() / 3) as u32;
        for v in [a, b, c] {
            m.positions.extend_from_slice(&v);
            m.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
        }
        m.indices.extend_from_slice(&[base, base + 1, base + 2]);
    };
    let n = poly.len();
    for k in 0..n {
        let p = poly[k];
        let q = poly[(k + 1) % n];
        // side wall, outward normal for a CCW polygon
        tri([p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], z1]);
        tri([p[0], p[1], z0], [q[0], q[1], z1], [p[0], p[1], z1]);
    }
    for k in 1..n - 1 {
        tri([poly[0][0], poly[0][1], z1], [poly[k][0], poly[k][1], z1], [poly[k + 1][0], poly[k + 1][1], z1]);
        tri([poly[0][0], poly[0][1], z0], [poly[k + 1][0], poly[k + 1][1], z0], [poly[k][0], poly[k][1], z0]);
    }
    m
}

#[test]
fn planar_clip_detection_routes_end_clips_and_defers_the_rest() {
    let clipper = ClippingProcessor::new();
    let bar = box_mesh([0.0, 0.0, 0.0], [1.0, 0.1, 0.05], 4);
    let bar_vol = volume(&bar);

    // (1) End-clip box overhanging the bar on every side but the cut face: APPLIES,
    //     and matches the exact subtract.
    let end_clip = box_mesh([0.8, -1.0, -1.0], [2.0, 2.0, 2.0], 1);
    let routed = clipper
        .try_planar_clip(&bar, &end_clip)
        .unwrap()
        .expect("end-clip must take the fast planar path");
    let exact = clipper.subtract_mesh(&bar, &end_clip).unwrap();
    let _ = clipper.take_failures();
    let rel = (volume(&routed) - volume(&exact)).abs() / volume(&exact).abs().max(1e-9);
    println!("end-clip: routed {:.6} vs exact {:.6}  rel {rel:.2e}  open {}",
        volume(&routed), volume(&exact), open_edges(&routed));
    assert_eq!(open_edges(&routed), 0, "routed end-clip not watertight");
    assert!(rel < 1.0e-3, "routed end-clip ≠ exact subtract ({rel:.2e})");
    assert!(volume(&routed) < bar_vol, "end-clip removed nothing");

    // (2) Drilling cutter through the bar (round hole): MANY straddling facets ⇒ DEFER.
    let drill = cylinder_z(0.5, 0.05, 0.02, -1.0, 1.0, 16);
    assert!(
        clipper.try_planar_clip(&bar, &drill).unwrap().is_none(),
        "a through-hole must defer to the exact kernel, not the planar clip"
    );

    // (3) A pocket/notch fully inside the bar (cutter doesn't overhang): two faces
    //     straddle ⇒ DEFER.
    let notch = box_mesh([0.4, 0.02, -1.0], [0.6, 0.08, 0.5], 1);
    assert!(
        clipper.try_planar_clip(&bar, &notch).unwrap().is_none(),
        "an interior pocket must defer to the exact kernel"
    );
    // (4) NON-CONVEX L-prism whose left face (x=0.8) cleanly straddles the bar and
    //     overhangs it everywhere else — it passes the single-straddle test but its
    //     reflex corner means the cutter ≠ the half-space, so the convexity gate
    //     must DEFER it (clipping would over-cut).
    let l_prism = extrude_z(
        &[[0.8, -1.0], [3.0, -1.0], [3.0, 3.0], [2.0, 3.0], [2.0, 1.0], [0.8, 1.0]],
        -1.0,
        2.0,
    );
    assert!(
        clipper.try_planar_clip(&bar, &l_prism).unwrap().is_none(),
        "a non-convex (L) cutter must defer — the convexity gate failed"
    );
    println!("detection OK: end-clip → fast path; hole, pocket, non-convex L → exact fallback");
}

#[test]
fn subtract_one_fires_on_clean_end_clip_and_matches_exact() {
    let c = ClippingProcessor::new();
    let bar = box_mesh([0.0, 0.0, 0.0], [1.0, 0.1, 0.05], 6);
    let cutter = box_mesh([0.8, -1.0, -1.0], [2.0, 2.0, 2.0], 1);

    // The wired entry point must take the fast path on a clean end-clip: the
    // result is watertight (so the strict gate accepts it) and volume-matches
    // the exact subtract.
    let fast = c.subtract_one(&bar, &cutter).unwrap();
    let exact = c.subtract_mesh(&bar, &cutter).unwrap();
    let _ = c.take_failures();
    assert_eq!(open_edges(&fast), 0, "subtract_one result not watertight");
    let rel = (volume(&fast) - volume(&exact)).abs() / volume(&exact).abs().max(1e-9);
    assert!(rel < 1.0e-3, "subtract_one diverged from exact subtract ({rel:.2e})");
    // It genuinely fired (the detector accepts this cutter)...
    assert!(c.try_planar_clip(&bar, &cutter).unwrap().is_some());
    // ...and the fast path produces a DIFFERENT triangulation than the exact
    // arrangement (proof it didn't silently fall through to subtract_mesh).
    assert_ne!(fast.triangle_count(), exact.triangle_count());

    // A through-hole cutter must defer (the exact kernel handles it); subtract_one
    // then returns exactly what subtract_mesh would.
    let drill = cylinder_z(0.5, 0.05, 0.02, -1.0, 1.0, 16);
    assert!(c.try_planar_clip(&bar, &drill).unwrap().is_none());
    let via_one = c.subtract_one(&bar, &drill).unwrap();
    let via_exact = c.subtract_mesh(&bar, &drill).unwrap();
    let _ = c.take_failures();
    assert_eq!(via_one.triangle_count(), via_exact.triangle_count());
    println!("subtract_one: fires on end-clip (watertight, matches exact), defers on hole");
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
