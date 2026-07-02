// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use nalgebra::Rotation3;

// A SCALENE (chiral, asymmetry-in-every-edge) tetra: all four vertices distinct
// distances, no symmetry that would make its mirror a proper rotation.
fn tetra() -> Mesh {
    let mut m = Mesh::new();
    m.positions = vec![
        0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.3, 0.4, 3.0,
    ];
    m.normals = vec![0.0; 12];
    m.indices = vec![0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3];
    m
}

fn rotate(m: &Mesh, axis: Vector3<f64>, ang: f64) -> Mesh {
    let r = Rotation3::from_axis_angle(&nalgebra::Unit::new_normalize(axis), ang);
    let mut out = m.clone();
    for v in out.positions.chunks_exact_mut(3) {
        let p = r * Vector3::new(v[0] as f64, v[1] as f64, v[2] as f64);
        v[0] = p.x as f32;
        v[1] = p.y as f32;
        v[2] = p.z as f32;
    }
    out
}

#[test]
fn rotated_tetra_is_congruent() {
    let a = build_welded(&tetra()).unwrap();
    let b = build_welded(&rotate(&tetra(), Vector3::new(0.3, 1.0, 0.5), 0.9)).unwrap();
    let out = verify(&a, &b);
    assert!(out.corresponded, "should correspond");
    assert!(out.connectivity_ok, "connectivity should match");
    assert!(out.max_dev < 1.0e-4, "max_dev {} should be near f32 floor", out.max_dev);
}

#[test]
fn reflected_tetra_is_not_proper_congruent() {
    let mut mirror = tetra();
    for v in mirror.positions.chunks_exact_mut(3) {
        v[0] = -v[0]; // reflect across YZ
    }
    let a = build_welded(&tetra()).unwrap();
    let b = build_welded(&mirror).unwrap();
    let out = verify(&a, &b);
    // Either flagged reflection-only, or no proper-rotation correspondence within tol.
    assert!(
        !(out.corresponded && out.connectivity_ok && out.max_dev <= SAFE_TOL),
        "a chiral mirror must not pass as a safe proper-rotation merge"
    );
}

#[test]
fn different_shape_does_not_merge() {
    let mut big = tetra();
    for v in big.positions.iter_mut() {
        *v *= 2.0; // scaled tetra — congruent up to SCALE, not rigid
    }
    let a = build_welded(&tetra()).unwrap();
    let b = build_welded(&big).unwrap();
    let out = verify(&a, &b);
    assert!(
        out.max_dev > SAFE_TOL || !out.connectivity_ok || !out.corresponded,
        "a scaled (non-congruent) shape must not pass the safe gate"
    );
}

// ---- Adversarial fixture suite (HARD GATE: zero false merges) ----

/// Does this pair pass the full SAFE merge gate (the production decision)?
fn safe_merge(a: &Mesh, b: &Mesh) -> bool {
    let (wa, wb) = match (build_welded(a), build_welded(b)) {
        (Some(x), Some(y)) => (x, y),
        _ => return false,
    };
    let out = verify(&wa, &wb);
    out.corresponded && out.connectivity_ok && !out.reflection_only && out.max_dev <= SAFE_TOL
}

/// Axis-aligned box [0,dx]x[0,dy]x[0,dz], 8 verts / 12 triangles.
fn box_mesh(dx: f32, dy: f32, dz: f32) -> Mesh {
    let mut m = Mesh::new();
    m.positions = vec![
        0.0, 0.0, 0.0, dx, 0.0, 0.0, dx, dy, 0.0, 0.0, dy, 0.0, // z=0
        0.0, 0.0, dz, dx, 0.0, dz, dx, dy, dz, 0.0, dy, dz, // z=dz
    ];
    m.normals = vec![0.0; 24];
    m.indices = vec![
        0, 1, 2, 0, 2, 3, // bottom
        4, 6, 5, 4, 7, 6, // top
        0, 4, 5, 0, 5, 1, // front
        1, 5, 6, 1, 6, 2, // right
        2, 6, 7, 2, 7, 3, // back
        3, 7, 4, 3, 4, 0, // left
    ];
    m
}

#[test]
fn rotation_equivariance_all_rotations_merge() {
    // An asymmetric box rotated many ways must ALL be pairwise-congruent (the
    // win + determinism: every occurrence collapses to one template).
    let base = box_mesh(1.0, 2.0, 3.0);
    let angles = [
        (Vector3::new(1.0, 0.0, 0.0), 0.4),
        (Vector3::new(0.0, 1.0, 0.0), 1.1),
        (Vector3::new(0.0, 0.0, 1.0), 2.3),
        (Vector3::new(1.0, 1.0, 0.0), 0.7),
        (Vector3::new(0.2, 1.0, 0.5), 2.9),
        (Vector3::new(1.0, 0.3, 0.8), 1.7),
    ];
    let rotated: Vec<Mesh> = angles.iter().map(|(ax, a)| rotate(&base, *ax, *a)).collect();
    for (i, a) in rotated.iter().enumerate() {
        for (j, b) in rotated.iter().enumerate().skip(i + 1) {
            assert!(safe_merge(a, b), "two rotations of one box must merge ({i}-{j})");
        }
    }
}

#[test]
fn thin_beam_rotations_merge() {
    // The high-value rotation-baked-steel target: a long thin member at
    // different orientations must merge.
    // Non-square cross-section (like an asymmetric steel section): distinct
    // λ1≠λ2 so the PCA frame is well-defined. Fully-square/round (degenerate)
    // sections are a documented conservative under-merge, not handled here.
    let beam = box_mesh(0.1, 0.3, 5.0);
    let a = rotate(&beam, Vector3::new(0.0, 1.0, 0.0), 1.2);
    let b = rotate(&beam, Vector3::new(0.3, 0.4, 1.0), 2.5);
    assert!(safe_merge(&a, &b), "thin beam rotations must merge");
}

#[test]
fn flipped_quad_diagonal_same_cloud_stays_split() {
    // Same vertex cloud, different triangulation (split AC vs BD) — the
    // documented #1 false-merge path. The connectivity gate must reject it.
    let mut quad_ac = Mesh::new();
    quad_ac.positions = vec![
        0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.2, 0.0, 1.0, 0.0,
    ];
    quad_ac.normals = vec![0.0; 12];
    quad_ac.indices = vec![0, 1, 2, 0, 2, 3]; // diagonal 0-2
    let mut quad_bd = quad_ac.clone();
    quad_bd.indices = vec![0, 1, 3, 1, 2, 3]; // diagonal 1-3 (non-planar -> different surface)
    assert!(
        !safe_merge(&quad_ac, &quad_bd),
        "same cloud, different triangulation (non-planar) must NOT merge"
    );
}

#[test]
fn perturbed_vertex_stays_split() {
    // A box with one corner moved 1mm is a genuinely different shape; even
    // though counts + rough size match, the max-deviation gate must reject.
    let a = box_mesh(1.0, 2.0, 3.0);
    let mut b = a.clone();
    b.positions[0] += 0.001; // move corner 0 by 1mm (>> 30µm gate)
    assert!(
        !safe_merge(&a, &b),
        "a 1mm-perturbed corner must not pass the 30µm gate"
    );
}

#[test]
fn coincident_vertices_no_panic_no_false_merge() {
    // A mesh with a near-coincident vertex pair vs a genuinely different box
    // sharing vertex/triangle counts: must not panic and must not false-merge.
    let mut dense = box_mesh(1.0, 2.0, 3.0);
    dense.positions[3] = 1.0e-7; // nudge corner 1 to near-coincide with corner 0 axis
    let other = box_mesh(2.0, 2.0, 2.0);
    assert!(!safe_merge(&dense, &other), "different shapes must not merge");
}

#[test]
fn rigid_cache_groups_congruent_and_separates_different() {
    let mut cache = RigidCache::new();
    // First tetra registers as a template (identity C).
    let t0 = cache.classify(&tetra(), 100).unwrap();
    assert_eq!(t0.rigid_id, 100);
    assert!(t0.canonical_transform.is_none(), "template has identity C");
    // A rotated copy must join the SAME template (rigid_id 100, not 200) with a
    // non-identity canonical transform.
    let rot = rotate(&tetra(), Vector3::new(0.4, 1.0, 0.2), 1.3);
    let t1 = cache.classify(&rot, 200).unwrap();
    assert_eq!(t1.rigid_id, 100, "rotated copy joins the template");
    assert!(t1.canonical_transform.is_some(), "rotated copy has a recovered C");
    // A scaled (non-congruent) tetra must register as a NEW template.
    let mut scaled = tetra();
    for v in scaled.positions.iter_mut() {
        *v *= 1.7;
    }
    let t2 = cache.classify(&scaled, 300).unwrap();
    assert_eq!(t2.rigid_id, 300, "non-congruent shape is a new template");
}

#[test]
fn build_rigid_map_groups_distinct_locals() {
    let rot = rotate(&tetra(), Vector3::new(0.4, 1.0, 0.2), 1.3);
    let mut scaled = tetra();
    for v in scaled.positions.iter_mut() {
        *v *= 1.7;
    }
    let locals = vec![(100u128, tetra()), (200u128, rot), (300u128, scaled)];
    let map = build_rigid_map(&locals);
    // 100 and 200 are congruent -> same rigid id; 300 is its own.
    assert_eq!(map[&100].rigid_id, map[&200].rigid_id);
    assert_ne!(map[&100].rigid_id, map[&300].rigid_id);
    let distinct: std::collections::HashSet<u128> =
        map.values().map(|c| c.rigid_id).collect();
    assert_eq!(distinct.len(), 2, "3 exact locals -> 2 rigid templates");
}

#[test]
fn translated_copy_merges() {
    // Pure translation (no rotation) of an asymmetric shape must merge.
    let a = tetra();
    let mut b = a.clone();
    for v in b.positions.chunks_exact_mut(3) {
        v[0] += 12.0;
        v[1] -= 7.0;
        v[2] += 3.0;
    }
    assert!(safe_merge(&a, &b), "a translated copy must merge");
}

#[test]
fn non_finite_vertex_mesh_is_rejected() {
    // A NaN/inf coordinate poisons the centroid/covariance (NaN eigenvalues;
    // the pre-fix partial_cmp().unwrap() sorts panicked on them) and verify's
    // max-deviation fold is NaN-blind, so a malformed mesh could bucket AND
    // pass verification with a NaN canonical transform. build_welded is the
    // single entry to the pipeline and must reject it outright; the total_cmp
    // sorts stay as defense-in-depth for values arising later.
    let mut m = tetra();
    m.positions.extend_from_slice(&[f32::NAN, 0.5, 0.5]);
    m.normals.extend_from_slice(&[0.0, 0.0, 0.0]);
    m.indices.extend_from_slice(&[0, 1, 4]);
    assert!(build_welded(&m).is_none(), "NaN-vertex mesh must be rejected");

    let mut inf = tetra();
    inf.positions[0] = f32::INFINITY;
    assert!(build_welded(&inf).is_none(), "inf-vertex mesh must be rejected");

    // Finite meshes are unaffected by the gate.
    assert!(build_welded(&tetra()).is_some());
}
