// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Bridge between the pure-Rust kernel (which works on `Tri = [[f64;3];3]`) and
//! ifc-lite's `Mesh` (f32 positions/normals/indices) — the M6 integration
//! foundation. `subtract`/`union`/`intersection` here are what the
//! `ClippingProcessor` seam will eventually call.

use super::arrangement::{boolean, union_all, BoolOp, Tri};
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

/// Twice-the-signed-volume sum for a triangle list (divergence theorem, ×6):
/// `Σ v0·(v1×v2)`. A closed outward-wound mesh has this `> 0`; an inward-wound
/// one `< 0`. Computed in plain FMA-free f64 over the snapped operand coords, so
/// only its SIGN is consumed — a global topological invariant, byte-identical
/// native==wasm. (The magnitude is irrelevant; we never compare it to a tolerance.)
fn signed_volume6(tris: &[Tri]) -> f64 {
    tris.iter()
        .map(|t| {
            let cr = [
                t[1][1] * t[2][2] - t[1][2] * t[2][1],
                t[1][2] * t[2][0] - t[1][0] * t[2][2],
                t[1][0] * t[2][1] - t[1][1] * t[2][0],
            ];
            t[0][0] * cr[0] + t[0][1] * cr[1] + t[0][2] * cr[2]
        })
        .sum()
}

/// Orient a closed operand OUTWARD before it enters the arrangement.
///
/// The kernel boolean (`boolean_vids` / `union_all`) derives its keep/flip rules
/// from the OUTWARD-normal convention (own-solid on `−n`; the difference flips the
/// kept B faces so their caps seam with A). Real IFC winding is NOT reliably
/// outward — a CW profile extruded along `+Z`, or a faceted brep with inconsistent
/// face loops, yields an INWARD-wound (negative-signed-volume) closed solid. Fed
/// in as-is it tears the result: open boundary edges along the cut rim + an
/// inverted-volume surface (the 1007 gable-wall slivers; #1007 defect A).
///
/// We flip winding (`[a,b,c] → [a,c,b]`, an EXACT index swap) iff the signed
/// volume is negative, so every operand the kernel sees is outward. The flip is a
/// no-op for already-outward inputs (every pinned box−box manifest: `cube_mesh`
/// has volume `+8`/`+27`), so determinism manifests are unperturbed.
fn orient_outward(mut tris: Vec<Tri>) -> Vec<Tri> {
    if signed_volume6(&tris) < 0.0 {
        for t in &mut tris {
            t.swap(1, 2);
        }
    }
    tris
}

/// Cross-operand near-coincidence promotion: weld every CUTTER vertex that
/// sits within the snap-scatter band of a HOST face plane — and projects
/// STRICTLY inside that face — onto the plane, then back onto the snap grid.
///
/// WHY (M7 BUG-1; TUN32 wall #97211 / opening #97266): when
/// `extend_opening_mesh_through_host` pushes a flush opening cap along the
/// host depth axis `d`, a cap corner that was bit-exactly a HOST corner can
/// slide ALONG a host face plane that contains `d` (here: the wall END face).
/// In exact arithmetic the slid corner stays on that plane, but the f32 round
/// of `p + d·shift` lands it a few µm OFF — a TILTED gap below the per-axis
/// `SNAP_GRID` reconcile (per-axis snapping cannot flatten a tilt). The host
/// EDGE then GRAZES the cutter jamb FACE at ~5e-5 rad; the conforming
/// arrangement splits the grazed face into degenerate sub-triangles whose
/// keep/drop classification is undefined → open edges + inverted volume
/// (the M7 sweep's negative-volume family: 27 tris / vol −4.268 / 13 bad
/// edges from two CLEAN watertight 12-tri boxes).
///
/// The gate is PLANE-level, deliberately NOT footprint-level: in the repro the
/// cutter jamb face is PARALLEL to the host end face but 4× longer, so its
/// verts perpendicular-project 0.18–0.4 m OUTSIDE the end face's footprint —
/// a point-in-face containment test can never associate them, yet their plane
/// IS the host plane up to f32 noise. A sub-band parallel-plane separation is
/// never representable design intent (the band is three orders below the
/// smallest real feature edge, ~0.2 m — same argument as
/// `near_on_surface_normal`), so welding the vertex onto the plane only
/// removes noise. The CUTTER-ONLY direction suffices and never perturbs the
/// host. The band and far-from-origin widening mirror
/// `near_on_surface_normal` (8·SNAP_GRID ≈ 122 µm; the `extent·2⁻²²` term
/// only dominates >32 km out). DETERMINISM: plain FMA-free f64 over
/// already-snapped coords, fixed iteration order, nearest-plane ties broken
/// by face index ⇒ byte-identical native==wasm. Every pinned box−box
/// manifest is transversal (no cutter vertex within the band of a
/// non-incident host plane), so the promotion never fires there.
fn promote_cutter_verts_onto_host_faces(cutter: &mut [Tri], host: &[Tri]) {
    if cutter.is_empty() || host.is_empty() {
        return;
    }
    let mut extent = 1.0f64;
    for t in cutter.iter().chain(host.iter()) {
        for v in t {
            for &x in v {
                extent = extent.max(x.abs());
            }
        }
    }
    let band = (8.0 * SNAP_GRID).max(extent * (1.0 / 4_194_304.0));
    let band2 = band * band;

    struct Face {
        t0: [f64; 3],
        n: [f64; 3], // raw (unnormalised) plane normal
        nn: f64,     // |n|²
    }
    let faces: Vec<Face> = host
        .iter()
        .filter_map(|t| {
            let e1 = [t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]];
            let e2 = [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]];
            let n = [
                e1[1] * e2[2] - e1[2] * e2[1],
                e1[2] * e2[0] - e1[0] * e2[2],
                e1[0] * e2[1] - e1[1] * e2[0],
            ];
            let nn = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
            if nn <= 0.0 || !nn.is_finite() {
                return None; // degenerate host triangle
            }
            Some(Face { t0: t[0], n, nn })
        })
        .collect();

    for t in cutter.iter_mut() {
        for v in t.iter_mut() {
            // Nearest host plane the vertex is within the band of but NOT
            // exactly on (d == 0 planes are already reconciled — and must not
            // shadow a second, still-noisy plane: in the repro the jamb verts
            // sit EXACTLY on the host bottom plane while 18–25 µm off the end
            // plane; the end plane is the one that needs the weld, and the
            // perpendicular projection onto it slides ALONG the bottom plane).
            // Ties → first in face order (deterministic).
            let mut best: Option<(f64, [f64; 3])> = None; // (perp-dist², foot)
            for f in &faces {
                let d = (v[0] - f.t0[0]) * f.n[0]
                    + (v[1] - f.t0[1]) * f.n[1]
                    + (v[2] - f.t0[2]) * f.n[2];
                if d == 0.0 {
                    continue; // already exactly on this plane
                }
                let d2 = (d * d) / f.nn;
                if d2 > band2 {
                    continue; // outside the snap-scatter band
                }
                if let Some((bd2, _)) = best {
                    if d2 >= bd2 {
                        continue;
                    }
                }
                // foot of the perpendicular from v onto the face plane
                let s = d / f.nn;
                best = Some((d2, [v[0] - s * f.n[0], v[1] - s * f.n[1], v[2] - s * f.n[2]]));
            }
            if let Some((_, p)) = best {
                *v = [snap(p[0]), snap(p[1]), snap(p[2])];
            }
        }
    }
}

/// `host − cutter` as a `Mesh`.
pub fn subtract(host: &Mesh, cutter: &Mesh) -> Mesh {
    let h = orient_outward(mesh_to_tris(host));
    let mut c = mesh_to_tris(cutter);
    promote_cutter_verts_onto_host_faces(&mut c, &h);
    let c = orient_outward(c);
    tris_to_mesh(&boolean(&h, &c, BoolOp::Difference))
}

/// `a ∪ b` as a `Mesh`.
pub fn union(a: &Mesh, b: &Mesh) -> Mesh {
    let a = orient_outward(mesh_to_tris(a));
    let b = orient_outward(mesh_to_tris(b));
    tris_to_mesh(&boolean(&a, &b, BoolOp::Union))
}

/// `∪ meshes` as one watertight `Mesh` — the N-ary union, computed in a single
/// conforming arrangement so coplanar seams shared by 3+ operands (the #960
/// segmented-roof cutters) dissolve without the tearing that left-deep pairwise
/// accumulation produces. Empty input ⇒ empty mesh.
pub fn union_many(meshes: &[&Mesh]) -> Mesh {
    let tri_lists: Vec<Vec<Tri>> =
        meshes.iter().map(|m| orient_outward(mesh_to_tris(m))).collect();
    let refs: Vec<&[Tri]> = tri_lists.iter().map(|t| t.as_slice()).collect();
    tris_to_mesh(&union_all(&refs))
}

/// `a ∩ b` as a `Mesh`.
pub fn intersection(a: &Mesh, b: &Mesh) -> Mesh {
    let a = orient_outward(mesh_to_tris(a));
    let b = orient_outward(mesh_to_tris(b));
    tris_to_mesh(&boolean(&a, &b, BoolOp::Intersection))
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

    /// M7 BUG-1 regression (TUN32 wall #97211 / opening #97266): a rotated
    /// 12-tri host box minus the cutter box that
    /// `extend_opening_mesh_through_host` pushed through it. The push slid a
    /// bit-exactly-shared corner ALONG the host end-face plane; the f32 round
    /// left it ~8 µm off (a tilt the per-axis snap can't flatten), so a host
    /// edge GRAZED the cutter jamb face and the subtract emitted 27 tris /
    /// 13 open edges / signed volume −4.268 (vs Manifold's +3.182871 on the
    /// SAME operands). The cross-operand promotion welds the slid corner back
    /// onto the host plane; the cut must be watertight with the oracle volume.
    #[test]
    fn extended_cutter_graze_subtracts_exactly() {
        fn mesh_of(vs: &[[f32; 3]], fs: &[[u32; 3]]) -> Mesh {
            let mut m = Mesh::new();
            for v in vs {
                m.positions.extend_from_slice(v);
                m.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
            }
            for f in fs {
                m.indices.extend_from_slice(f);
            }
            m
        }
        // exact f32 coords as dumped from the M7 probe (tun97211_real_host /
        // tun97211_extended_cutter); 8 unique verts each, both watertight.
        let host = mesh_of(
            &[
                [274.05923, 400.96225, 34.600006],
                [276.68744, 404.85873, 34.600006],
                [276.52164, 404.97058, 34.600006],
                [274.00525, 401.2399, 34.600006],
                [274.05923, 400.96225, 38.600006],
                [276.68744, 404.85873, 38.600006],
                [276.52164, 404.97058, 38.600006],
                [274.00525, 401.2399, 38.600006],
            ],
            &[
                [3, 1, 0], [1, 3, 2], [7, 4, 5], [5, 6, 7], [0, 1, 5], [0, 5, 4],
                [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
            ],
        );
        let cutter = mesh_of(
            &[
                [277.01904, 404.63507, 34.6],
                [276.39276, 403.70654, 34.6],
                [276.39276, 403.70654, 36.82],
                [277.01904, 404.63507, 36.82],
                [276.3724, 405.07123, 34.6],
                [275.7461, 404.1427, 34.6],
                [275.7461, 404.1427, 36.82],
                [276.3724, 405.07123, 36.82],
            ],
            &[
                [2, 0, 3], [0, 2, 1], [6, 7, 4], [4, 5, 6], [0, 1, 5], [0, 5, 4],
                [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
            ],
        );
        assert!((mesh_volume(&host) - 3.680154).abs() < 1e-4, "host operand changed");
        assert!((mesh_volume(&cutter) - 1.939390).abs() < 1e-4, "cutter operand changed");
        let result = subtract(&host, &cutter);
        let v = mesh_volume(&result);
        // Manifold oracle on the same operands: +3.182871 (pure on the
        // UNextended cutter: +3.18291). f32 round-trip noise stays ≪ 1e-3.
        assert!((v - 3.182871).abs() < 1e-3, "subtract volume = {v}, expected ≈3.182871");
        // watertight: every directed edge must be paired (the broken cut had 13 bad)
        let s = 1e5_f32;
        let key = |i: u32| {
            let b = i as usize * 3;
            (
                (result.positions[b] * s).round() as i64,
                (result.positions[b + 1] * s).round() as i64,
                (result.positions[b + 2] * s).round() as i64,
            )
        };
        let mut edges = std::collections::HashMap::new();
        for t in result.indices.chunks_exact(3) {
            for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
                *edges.entry((key(a), key(b))).or_insert(0i32) += 1;
                *edges.entry((key(b), key(a))).or_insert(0i32) -= 1;
            }
        }
        let bad = edges.values().filter(|&&c| c != 0).count();
        assert_eq!(bad, 0, "result has {bad} unpaired directed edges");
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
    fn perf_realistic_openings() {
        use super::super::arrangement::box_mesh;
        let wall = tris_to_mesh(&box_mesh([0., 0., 0.], [6., 3., 0.3]));
        // a rectangular door (the COMMON case) + a single curved window
        let door = tris_to_mesh(&box_mesh([1., 0., -0.5], [2., 2.1, 0.8]));
        let t = std::time::Instant::now();
        for _ in 0..10 { let _ = subtract(&wall, &door); }
        let rect = t.elapsed().as_secs_f64() * 1e3 / 10.0;
        let m = std::time::Instant::now();
        for _ in 0..10 { let _ = crate::manifold_kernel::difference(&wall, &door).unwrap(); }
        let mrect = m.elapsed().as_secs_f64() * 1e3 / 10.0;
        println!("rectangular door: kernel {:.2}ms  manifold {:.2}ms  ratio {:.0}x", rect, mrect, rect / mrect.max(1e-9));
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
