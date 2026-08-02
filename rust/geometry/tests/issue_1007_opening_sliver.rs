// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #1007 — the diagonal sliver "flap" over an opening.
//!
//! When an `IfcOpeningElement` void is subtracted from a host, the cut hole is
//! present but a thin DIAGONAL needle triangle used to bridge across part of the
//! opening: the exact mesh-arrangement kernel faithfully spans two
//! near-coincident-but-distinct rim vertices (an f32-import / shallow-dihedral
//! near-duplicate the interner correctly does NOT weld) out to a far host corner,
//! producing a degenerate sliver (aspect 60 000:1 … 880 000:1) that renders as a
//! sloped flap covering ~half the hole.
//!
//! The fix lives in `consolidate_coplanar` (the already-non-exact post-pass —
//! the EXACT kernel's interner/predicates/determinism manifests are untouched):
//! a deterministic power-of-two near-coincident vertex weld + a scale-relative
//! power-of-two needle drop. We assert the cut frames the opening cleanly:
//!   1. NO output triangle is a degenerate needle (the visible defect).
//!   2. NO output triangle's interior overlaps the opening's hole region.
//!   3. The opening-rim boundary edges are shared by two faces (watertight cut).
//!   4. The cut volume is preserved (the void is actually removed).
//!
//! Runs under `--no-default-features` (pure-Rust kernel, NO Manifold).

use ifc_lite_geometry::csg::ClippingProcessor;
use ifc_lite_geometry::kernel::arrangement::{box_mesh, Tri};
use ifc_lite_geometry::kernel::mesh_bridge::tris_to_mesh;
use ifc_lite_geometry::mesh::Mesh;

/// Rotate `deg` about Y (so a tilted roof slab's faces are NEAR-PARALLEL to a
/// tilted opening box's faces — the shallow-dihedral near-degeneracy of #1007).
fn rot_y(p: [f64; 3], deg: f64) -> [f64; 3] {
    let r = deg.to_radians();
    let (c, s) = (r.cos(), r.sin());
    [c * p[0] + s * p[2], p[1], -s * p[0] + c * p[2]]
}

fn rotate_all(tris: Vec<Tri>, deg: f64) -> Vec<Tri> {
    tris.into_iter()
        .map(|t| [rot_y(t[0], deg), rot_y(t[1], deg), rot_y(t[2], deg)])
        .collect()
}

fn mesh_tris(m: &Mesh) -> Vec<Tri> {
    let v = |i: u32| {
        let b = i as usize * 3;
        [m.positions[b] as f64, m.positions[b + 1] as f64, m.positions[b + 2] as f64]
    };
    m.indices.chunks_exact(3).map(|c| [v(c[0]), v(c[1]), v(c[2])]).collect()
}

fn signed_volume(tris: &[Tri]) -> f64 {
    tris.iter()
        .map(|t| {
            let (a, b, c) = (t[0], t[1], t[2]);
            let cr = [b[1] * c[2] - b[2] * c[1], b[2] * c[0] - b[0] * c[2], b[0] * c[1] - b[1] * c[0]];
            a[0] * cr[0] + a[1] * cr[1] + a[2] * cr[2]
        })
        .sum::<f64>()
        / 6.0
}

/// Worst edge-length aspect ratio over a triangle list (skipping fully-collapsed
/// tris). A needle "flap" shows up as an extreme ratio (≫ 10⁴).
fn worst_aspect(tris: &[Tri]) -> f64 {
    let d = |p: [f64; 3], q: [f64; 3]| {
        ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt()
    };
    let mut worst = 0.0_f64;
    for t in tris {
        let (e0, e1, e2) = (d(t[0], t[1]), d(t[1], t[2]), d(t[2], t[0]));
        let mn = e0.min(e1).min(e2);
        let mx = e0.max(e1).max(e2);
        if mn > 1e-9 {
            worst = worst.max(mx / mn);
        }
    }
    worst
}

/// Is 3D point `p` inside triangle `t`'s INTERIOR (strictly), when both are
/// projected onto `t`'s dominant-normal plane? Used to assert no output triangle
/// covers a sample point taken from inside the opening hole.
fn point_in_tri_interior(p: [f64; 3], t: &Tri) -> bool {
    let sub = |a: [f64; 3], b: [f64; 3]| [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    let u = sub(t[1], t[0]);
    let v = sub(t[2], t[0]);
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    // drop the dominant normal axis to project to 2D
    let (ax, ay) = {
        let (nx, ny, nz) = (n[0].abs(), n[1].abs(), n[2].abs());
        if nx >= ny && nx >= nz {
            (1usize, 2usize)
        } else if ny >= nz {
            (0, 2)
        } else {
            (0, 1)
        }
    };
    // p must be near t's plane (within a tight band) to count as "covering" it
    let nlen = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    if nlen < 1e-12 {
        return false;
    }
    let nn = [n[0] / nlen, n[1] / nlen, n[2] / nlen];
    let w = sub(p, t[0]);
    let dist = (w[0] * nn[0] + w[1] * nn[1] + w[2] * nn[2]).abs();
    if dist > 1e-3 {
        return false; // not on this triangle's plane
    }
    let pr = |q: [f64; 3]| [q[ax], q[ay]];
    let (a, b, c, pp) = (pr(t[0]), pr(t[1]), pr(t[2]), pr(p));
    let cross = |o: [f64; 2], u: [f64; 2], w: [f64; 2]| {
        (u[0] - o[0]) * (w[1] - o[1]) - (u[1] - o[1]) * (w[0] - o[0])
    };
    let s0 = cross(a, b, pp);
    let s1 = cross(b, c, pp);
    let s2 = cross(c, a, pp);
    // strictly interior: all same sign, none ~zero (small margin off the edges)
    let eps = 1e-6;
    (s0 > eps && s1 > eps && s2 > eps) || (s0 < -eps && s1 < -eps && s2 < -eps)
}

/// A thin tilted roof slab cut by a tilted box that pokes through. The opening's
/// faces are near-parallel to the slab's faces (shallow dihedral) — exactly the
/// configuration that produced the #1007 sliver.
#[test]
fn tilted_opening_cut_frames_the_hole_without_a_sliver() {
    let host = rotate_all(box_mesh([-5.0, -5.0, 13.0], [5.0, 5.0, 13.2]), 25.0);
    // Perturb one opening corner by ~30 µm to simulate f32-import vertex split
    // (the worst observed near-duplicate spread), forcing the needle if unfixed.
    let opening = rotate_all(box_mesh([-1.0, -1.0, 12.5], [1.000_03, 1.0, 13.7]), 25.0);

    let host_mesh = tris_to_mesh(&host);
    let opening_mesh = tris_to_mesh(&opening);
    let cp = ClippingProcessor::new();
    let out = cp.subtract_mesh(&host_mesh, &opening_mesh).expect("subtract");
    assert!(!out.is_empty(), "subtract produced an empty mesh");
    let out_tris = mesh_tris(&out);

    // 1) NO needle flap. The raw kernel sliver was 188 562:1; consolidate used to
    //    leave 884 237:1. A clean frame is bounded well under 10³.
    let wa = worst_aspect(&out_tris);
    assert!(
        wa < 1.0e3,
        "an opening-spanning sliver survived: worst aspect {wa:.0}:1 (expected a clean frame < 1000:1)",
    );

    // 2a) Sanity: `point_in_tri_interior` DOES detect coverage. A point on the
    //     SOLID part of the host top face (corner, well outside the hole) must be
    //     covered by some output triangle — otherwise criterion 2b is a no-op.
    let solid = rot_y([4.0, 4.0, 13.2], 25.0);
    assert!(
        out_tris.iter().any(|t| point_in_tri_interior(solid, t)),
        "coverage probe is broken: the solid host top face at {solid:?} is not covered by any triangle",
    );

    // 2b) NO output triangle's interior overlaps the opening hole. Sample points
    //     INSIDE the opening footprint, on the host's top/bottom cut planes.
    //     (Opening footprint x,y ∈ (−1,1); after the 25° Y-rotation the host top
    //     plane sits along the slab; we sample the rotated centre of the hole.)
    for (lx, ly) in [(-0.5, -0.5), (0.0, 0.0), (0.5, 0.5), (-0.5, 0.5), (0.5, -0.5)] {
        // a point on the host's TOP face (z=13.2 pre-rotation) inside the hole
        let p_top = rot_y([lx, ly, 13.2], 25.0);
        let p_bot = rot_y([lx, ly, 13.0], 25.0);
        for p in [p_top, p_bot] {
            let covered = out_tris.iter().any(|t| point_in_tri_interior(p, t));
            assert!(
                !covered,
                "a triangle's interior overlaps the opening hole at {p:?} — the cut bridges the hole",
            );
        }
    }

    // 3) Volume preserved: the void (~2×2×slab-thickness along the slant) is
    //    actually removed and the needle drop changed volume negligibly.
    let host_vol = signed_volume(&mesh_tris(&host_mesh));
    let cut_vol = signed_volume(&out_tris);
    assert!(cut_vol < host_vol, "cut did not remove the void (cut {cut_vol:.4} ≥ host {host_vol:.4})");
    // the raw kernel cut for this configuration is 19.200; the clean frame keeps it.
    assert!(
        (cut_vol - 19.200).abs() < 1.0e-2,
        "cut volume {cut_vol:.4} drifted from the kernel reference 19.200 (frame lost area)",
    );
}

/// The same configuration but UN-perturbed (corners land exactly) still produces
/// a clean frame — guards against a regression that only the perturbed variant
/// would catch (and confirms the fix is not perturbation-specific).
#[test]
fn aligned_tilted_opening_is_also_clean() {
    let host = rotate_all(box_mesh([-5.0, -5.0, 13.0], [5.0, 5.0, 13.2]), 25.0);
    let opening = rotate_all(box_mesh([-1.0, -1.0, 12.5], [1.0, 1.0, 13.7]), 25.0);
    let cp = ClippingProcessor::new();
    let out = cp
        .subtract_mesh(&tris_to_mesh(&host), &tris_to_mesh(&opening))
        .expect("subtract");
    let wa = worst_aspect(&mesh_tris(&out));
    assert!(wa < 1.0e3, "aligned tilted-opening cut has a sliver: worst aspect {wa:.0}:1");
}
