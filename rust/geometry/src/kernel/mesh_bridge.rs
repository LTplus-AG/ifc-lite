// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Bridge between the pure-Rust kernel (which works on `Tri = [[f64;3];3]`) and
//! ifc-lite's `Mesh` (f32 positions/normals/indices) — the M6 integration
//! foundation. `subtract`/`union`/`intersection` here are what the
//! `ClippingProcessor` seam will eventually call.

use super::arrangement::{boolean, BoolOp, Tri};
use crate::mesh::Mesh;

/// f32-near-coplanar reconciliation snap grid (metres). A POWER OF TWO so the
/// snap `(c/G).round()*G` is an EXACT f64 op ⇒ bit-deterministic across
/// x86_64/aarch64/wasm. Real IFC is authored in f32, so an intended-flush face is
/// NOT exactly coplanar after import; snapping both operands to a shared grid
/// makes such faces EXACTLY coplanar so the exact coplanar path fires instead of
/// emitting a noise sliver. Resolution is tunable against the corpus (flip plan
/// M7 / the open decision); 2^-16 m ≈ 15 µm.
const SNAP_GRID: f64 = 1.0 / 65536.0;

#[inline]
fn snap(c: f64) -> f64 {
    (c / SNAP_GRID).round() * SNAP_GRID
}

/// `Mesh` → the kernel's triangle list (f32 → f64, snapped to the reconcile
/// grid). Panic-free: an out-of-range index OR a non-finite (NaN/Inf) coord drops
/// that triangle rather than indexing past the end or crashing
/// `BigRational::from_float` deep in the predicates (the two empirically-found
/// reachable panic sites — see examples/csg_robustness.rs).
pub fn mesh_to_tris(m: &Mesh) -> Vec<Tri> {
    let vertex = |i: u32| -> Option<[f64; 3]> {
        let b = (i as usize) * 3;
        let c = [
            *m.positions.get(b)? as f64,
            *m.positions.get(b + 1)? as f64,
            *m.positions.get(b + 2)? as f64,
        ];
        if !c.iter().all(|v| v.is_finite()) {
            return None;
        }
        Some([snap(c[0]), snap(c[1]), snap(c[2])])
    };
    m.indices
        .chunks_exact(3)
        .filter_map(|c| Some([vertex(c[0])?, vertex(c[1])?, vertex(c[2])?]))
        .collect()
}

fn face_normal(t: &Tri) -> [f32; 3] {
    let e1 = [t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]];
    let e2 = [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]];
    let n = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
    ];
    let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    if len > 0.0 {
        [(n[0] / len) as f32, (n[1] / len) as f32, (n[2] / len) as f32]
    } else {
        [0.0, 0.0, 1.0]
    }
}

/// The kernel's triangle list → a `Mesh` (per-face flat normals, f64 → f32).
pub fn tris_to_mesh(tris: &[Tri]) -> Mesh {
    let mut m = Mesh::with_capacity(tris.len() * 3, tris.len() * 3);
    for t in tris {
        let n = face_normal(t);
        let base = (m.positions.len() / 3) as u32;
        for p in t {
            m.positions
                .extend_from_slice(&[p[0] as f32, p[1] as f32, p[2] as f32]);
            m.normals.extend_from_slice(&n);
        }
        m.indices.extend_from_slice(&[base, base + 1, base + 2]);
    }
    m
}

/// `host − cutter` as a `Mesh`.
pub fn subtract(host: &Mesh, cutter: &Mesh) -> Mesh {
    tris_to_mesh(&boolean(&mesh_to_tris(host), &mesh_to_tris(cutter), BoolOp::Difference))
}

/// `a ∪ b` as a `Mesh`.
pub fn union(a: &Mesh, b: &Mesh) -> Mesh {
    tris_to_mesh(&boolean(&mesh_to_tris(a), &mesh_to_tris(b), BoolOp::Union))
}

/// `a ∩ b` as a `Mesh`.
pub fn intersection(a: &Mesh, b: &Mesh) -> Mesh {
    tris_to_mesh(&boolean(&mesh_to_tris(a), &mesh_to_tris(b), BoolOp::Intersection))
}

#[cfg(all(test, feature = "manifold-csg"))]
mod manifold_compare {
    use super::super::arrangement::box_mesh;
    use super::*;

    fn aspect(m: &Mesh) -> (f64, u32) {
        let v = |i: u32| {
            let b = i as usize * 3;
            [m.positions[b] as f64, m.positions[b + 1] as f64, m.positions[b + 2] as f64]
        };
        let (mut worst, mut spikes) = (0.0f64, 0u32);
        for t in m.indices.chunks_exact(3) {
            let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
            let d = |p: [f64; 3], q: [f64; 3]| {
                ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt()
            };
            let (e0, e1, e2) = (d(a, b), d(b, c), d(c, a));
            let (mn, mx) = (e0.min(e1).min(e2), e0.max(e1).max(e2));
            if mn > 1e-6 {
                worst = worst.max(mx / mn);
                if mx / mn > 50.0 {
                    spikes += 1;
                }
            }
        }
        (worst, spikes)
    }

    fn rot(m: &mut Mesh, deg: f64) {
        let r = deg.to_radians();
        let (c, s) = (r.cos(), r.sin());
        for v in m.positions.chunks_exact_mut(3) {
            let (x, y) = (v[0] as f64, v[1] as f64);
            v[0] = (c * x - s * y) as f32;
            v[1] = (s * x + c * y) as f32;
        }
    }

    #[test]
    fn kernel_vs_manifold_thin_wall_slant_aspect() {
        // gable-like: a thin wall sliced by a slanted prism. Print both kernels'
        // worst aspect ratio + spike count — does the kernel sliver where
        // Manifold (the FZK-gable baseline) stays clean?
        let mut wall = tris_to_mesh(&box_mesh([0., 0., 0.], [4., 0.3, 2.]));
        let mut cut = tris_to_mesh(&box_mesh([1., -0.5, 0.5], [2., 0.8, 1.5]));
        rot(&mut wall, 45.);
        rot(&mut cut, 45.);
        let k = subtract(&wall, &cut);
        let kc = crate::csg::ClippingProcessor::consolidate_coplanar(k.clone());
        let m = crate::manifold_kernel::difference(&wall, &cut).unwrap();
        let (wk, sk) = aspect(&k);
        let (wkc, skc) = aspect(&kc);
        let (wm, sm) = aspect(&m);
        println!("KERNEL        worst {wk:.0}:1 spikes {sk} ({} tris)", k.indices.len() / 3);
        println!("KERNEL+consol worst {wkc:.0}:1 spikes {skc} ({} tris)", kc.indices.len() / 3);
        println!("MANIFOLD      worst {wm:.0}:1 spikes {sm} ({} tris)", m.indices.len() / 3);
    }
}

#[cfg(test)]
mod tests {
    use super::super::arrangement::cube_mesh;
    use super::*;

    fn mesh_volume(m: &Mesh) -> f64 {
        let vertex = |i: u32| {
            let b = (i as usize) * 3;
            [
                m.positions[b] as f64,
                m.positions[b + 1] as f64,
                m.positions[b + 2] as f64,
            ]
        };
        m.indices
            .chunks_exact(3)
            .map(|c| {
                let (a, bb, cc) = (vertex(c[0]), vertex(c[1]), vertex(c[2]));
                let cr = [
                    bb[1] * cc[2] - bb[2] * cc[1],
                    bb[2] * cc[0] - bb[0] * cc[2],
                    bb[0] * cc[1] - bb[1] * cc[0],
                ];
                a[0] * cr[0] + a[1] * cr[1] + a[2] * cr[2]
            })
            .sum::<f64>()
            / 6.0
    }

    #[test]
    fn snap_reconciles_near_coplanar_and_is_deterministic() {
        // coords closer than the grid snap to the SAME value (f32-flush → exact)
        assert_eq!(super::snap(1.0), super::snap(1.0 + 1e-6));
        assert_eq!(super::snap(2.5), super::snap(2.5 - 5e-6));
        // grid multiples (incl. integers) are exact fixed points
        assert_eq!(super::snap(3.0), 3.0);
        assert_eq!(super::snap(0.0), 0.0);
        assert_eq!(super::snap(7.0 / 65536.0), 7.0 / 65536.0);
        // distinct grid cells stay distinct
        assert_ne!(super::snap(1.0), super::snap(1.0 + 1e-3));
    }

    #[test]
    fn kernel_cuts_a_real_mesh() {
        // Round-trip through ifc-lite's Mesh: two cube meshes, subtract via the
        // kernel, and the result Mesh has the exact box−box volume.
        let host = tris_to_mesh(&cube_mesh(0.0, 2.0)); // vol 8
        let cutter = tris_to_mesh(&cube_mesh(1.0, 3.0)); // overlap [1,2]³ = 1
        let result = subtract(&host, &cutter);
        assert!(!result.indices.is_empty(), "subtract produced an empty mesh");
        let v = mesh_volume(&result);
        assert!((v - 7.0).abs() < 1e-3, "Mesh host−cutter volume = {v}, expected 7");
        // sanity: the round-tripped host mesh has volume 8
        assert!((mesh_volume(&host) - 8.0).abs() < 1e-4, "host round-trip volume wrong");
    }

    #[test]
    fn kernel_cuts_a_through_wall_opening() {
        use super::super::arrangement::box_mesh;
        // a thin wall slab with a box opening poking all the way through (z)
        let wall = tris_to_mesh(&box_mesh([0., 0., 0.], [4., 3., 0.2])); // vol 2.4
        let opening = tris_to_mesh(&box_mesh([1., 1., -0.5], [2., 2., 0.7])); // hole vol 0.2
        let result = subtract(&wall, &opening);
        let v = mesh_volume(&result);
        assert!((v - 2.2).abs() < 1e-3, "through-opening wall volume = {v}, expected 2.2");
    }

    #[test]
    fn kernel_cuts_two_sequential_openings() {
        use super::super::arrangement::box_mesh;
        // The void-router pattern: a host cut by several openings in sequence,
        // each subtract's OUTPUT fed back in as the next host.
        let wall = tris_to_mesh(&box_mesh([0., 0., 0.], [6., 3., 0.2])); // vol 3.6
        let op1 = tris_to_mesh(&box_mesh([1., 1., -0.5], [2., 2., 0.7])); // hole 0.2
        let op2 = tris_to_mesh(&box_mesh([4., 1., -0.5], [5., 2., 0.7])); // hole 0.2
        let after2 = subtract(&subtract(&wall, &op1), &op2);
        let v = mesh_volume(&after2);
        assert!((v - 3.2).abs() < 1e-3, "two-opening wall volume = {v}, expected 3.2");
    }
}

#[cfg(all(test, feature = "manifold-csg"))]
mod perf_compare {
    use super::super::arrangement::box_mesh;
    use super::*;

    // a wall with a high-poly cylindrical opening — closer to real IFC than a box cut
    fn cylinder(cx: f64, cy: f64, r: f64, z0: f64, z1: f64, n: usize) -> Mesh {
        let mut tris = Vec::new();
        let p = |i: usize, z: f64| {
            let a = (i as f64) / (n as f64) * std::f64::consts::TAU;
            [cx + r * a.cos(), cy + r * a.sin(), z]
        };
        for i in 0..n {
            let j = (i + 1) % n;
            // side quad
            tris.push([p(i, z0), p(j, z0), p(j, z1)]);
            tris.push([p(i, z0), p(j, z1), p(i, z1)]);
            // caps (fan)
            tris.push([[cx, cy, z0], p(j, z0), p(i, z0)]);
            tris.push([[cx, cy, z1], p(i, z1), p(j, z1)]);
        }
        tris_to_mesh(&tris)
    }

    #[test]
    fn perf_wall_with_cylinder_opening() {
        let wall = tris_to_mesh(&box_mesh([0., 0., 0.], [4., 3., 0.3]));
        for n in [8usize, 12, 16, 24, 32] {
            let cyl = cylinder(2.0, 1.5, 0.6, -0.5, 0.8, n);
            let t0 = std::time::Instant::now();
            let k = subtract(&wall, &cyl);
            let tk = t0.elapsed();
            let t2 = std::time::Instant::now();
            let _m = crate::manifold_kernel::difference(&wall, &cyl).unwrap();
            let tm = t2.elapsed();
            println!(
                "n={:<3} kernel {:>10.3}ms  manifold {:>7.3}ms  ratio {:>7.0}x  tris {}",
                n,
                tk.as_secs_f64() * 1e3,
                tm.as_secs_f64() * 1e3,
                tk.as_secs_f64() / tm.as_secs_f64().max(1e-9),
                k.indices.len() / 3
            );
        }
    }
}
