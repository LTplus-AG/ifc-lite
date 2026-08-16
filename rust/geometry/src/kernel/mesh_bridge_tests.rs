// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for `mesh_bridge` — split out of the module to keep it under its
//! size ratchet budget (`_tests.rs` siblings are ratchet-exempt).

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

/// `mesh_to_tris` is documented panic-free against a triangle whose vertex
/// index runs past the end of `positions` (a truncated/corrupt buffer):
/// the offending triangle is silently dropped rather than indexing OOB.
#[test]
fn mesh_to_tris_drops_out_of_range_index_without_panicking() {
    let mut m = Mesh::new();
    // one real triangle (verts 0,1,2)...
    m.positions.extend_from_slice(&[0.0, 0.0, 0.0]);
    m.positions.extend_from_slice(&[1.0, 0.0, 0.0]);
    m.positions.extend_from_slice(&[0.0, 1.0, 0.0]);
    // ...then a second face referencing vertex index 5, which is past the
    // end of a 3-vertex positions buffer (truncated/corrupt data).
    m.indices.extend_from_slice(&[0, 1, 2, 0, 1, 5]);

    let tris = mesh_to_tris(&m);

    assert_eq!(tris.len(), 1, "malformed triangle (OOB index) must be dropped, not panic");
    assert_eq!(tris[0], [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]);
}

/// `mesh_to_tris` is documented panic-free against a non-finite (NaN/Inf)
/// position coordinate: the offending triangle is silently dropped rather
/// than propagating NaN into the exact-predicate kernel.
#[test]
fn mesh_to_tris_drops_non_finite_coordinate_without_panicking() {
    let mut m = Mesh::new();
    // valid triangle (verts 0,1,2)
    m.positions.extend_from_slice(&[0.0, 0.0, 0.0]);
    m.positions.extend_from_slice(&[1.0, 0.0, 0.0]);
    m.positions.extend_from_slice(&[0.0, 1.0, 0.0]);
    // NaN-poisoned vertex 3, referenced by a second face
    m.positions.extend_from_slice(&[f32::NAN, 0.0, 0.0]);
    // Inf-poisoned vertex 4, referenced by a third face
    m.positions.extend_from_slice(&[f32::INFINITY, 0.0, 0.0]);
    m.indices
        .extend_from_slice(&[0, 1, 2, 0, 1, 3, 0, 1, 4]);

    let tris = mesh_to_tris(&m);

    assert_eq!(
        tris.len(),
        1,
        "triangles touching a NaN or Inf coordinate must be dropped, not panic"
    );
    assert_eq!(tris[0], [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]);
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

/// Extended-cutter-graze regression (a rotated tunnel-wall fixture): a
/// rotated 12-tri host box minus the cutter box that
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
    // exact f32 coords as dumped from the failing host/cutter pair;
    // 8 unique verts each, both watertight.
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

/// Directed-edge pairing audit at EXACT f32-bit coordinates — the crack
/// detector. A watertight oriented surface has every directed edge matched
/// by its reverse; any imbalance is an exact-coordinate boundary crack
/// (the crack family). No rounding: two seam vertices that differ by
/// even one ULP count as a crack, which is precisely the defect.
fn exact_open_edges(m: &Mesh) -> usize {
    use std::collections::HashMap;
    let key = |i: u32| {
        let b = i as usize * 3;
        (
            m.positions[b].to_bits(),
            m.positions[b + 1].to_bits(),
            m.positions[b + 2].to_bits(),
        )
    };
    let mut edges: HashMap<_, i64> = HashMap::new();
    for t in m.indices.chunks_exact(3) {
        for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            *edges.entry((key(a), key(b))).or_insert(0) += 1;
            *edges.entry((key(b), key(a))).or_insert(0) -= 1;
        }
    }
    edges.values().filter(|&&c| c != 0).count()
}

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

/// Standard 8-vert box/prism face table (bottom quad 0-3, top quad 4-7).
const PRISM_FACES: [[u32; 3]; 12] = [
    [3, 1, 0], [1, 3, 2], [7, 4, 5], [5, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
];
const BOX_FACES: [[u32; 3]; 12] = [
    [2, 0, 3], [0, 2, 1], [6, 7, 4], [4, 5, 6], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
];

/// Crack-family regression (a far-from-origin tunnel wall, step 0 of the
/// minimal repro): a clean 12-tri plan-rotated wall prism minus ONE small
/// recess box whose jamb face is intended-flush with the TILTED host end
/// plane (they share the host corner (300.84857, 362.50748) bit-exactly;
/// the other jamb verts sit ~24 µm off-plane after the per-axis 2^-16
/// snap). Pre-fix the near-coplanar carve ran on the still-off-plane
/// coordinates, the A/B seam vertices never interned identically, and the
/// cut emitted 16 exact-coordinate open edges with volume 0.107 instead of
/// the analytic 0.306705. The exact-plane lift welds the jamb verts EXACTLY
/// onto the host plane so the coplanar carve conforms: watertight + exact.
#[test]
fn tilted_flush_recess_cut_is_watertight_198779() {
    let host = mesh_of(
        &[
            [301.04767, 363.11743, 47.6],
            [300.70264, 362.6059, 47.6],
            [300.84857, 362.50748, 47.6],
            [301.24, 363.08783, 47.6],
            [301.04767, 363.11743, 50.25],
            [300.70264, 362.6059, 50.25],
            [300.84857, 362.50748, 50.25],
            [301.24, 363.08783, 50.25],
        ],
        &PRISM_FACES,
    );
    let cutter = mesh_of(
        &[
            [300.85583, 362.51828, 47.6],
            [300.84506, 362.52554, 47.6],
            [300.8378, 362.51477, 47.6],
            [300.84857, 362.50748, 47.6],
            [300.85583, 362.51828, 50.25],
            [300.84506, 362.52554, 50.25],
            [300.8378, 362.51477, 50.25],
            [300.84857, 362.50748, 50.25],
        ],
        &BOX_FACES,
    );
    let result = subtract(&host, &cutter);
    let open = exact_open_edges(&result);
    assert_eq!(open, 0, "tilted-flush recess cut left {open} exact-coordinate open edges");
    let v = mesh_volume(&result);
    assert!(
        (v - 0.306705).abs() < 1e-3,
        "recess cut volume = {v}, expected ≈0.306705 (analytic; pre-fix 0.107)"
    );
}

/// Crack-family regression (the +10.3% max-error row of the far-from-origin
/// sweep): an 8×8-tri body `IfcBooleanClippingResult` DIFF in
/// native units (|y|≈6699 ⇒ one f32 ULP = 4.88e-4 ≈ 32 snap cells, so the
/// per-axis 2^-16 snap is structurally unable to reconcile the flush slant
/// plane). The cutter's bottom face is intended-flush with the host's slant
/// plane but 1 ULP off; pre-fix the cut emitted a 13-tri open result (16
/// exact open edges) at +10.3% vs IfcOpenShell. Post-fix the kernel output
/// is exactly closed at f32 with volume at IOS parity: 5868311718 mm³ =
/// 5.8683117 m³ vs IfcOpenShell 0.8.2's 5.868313 m³ (2.6e-7 relative).
#[test]
fn native_unit_flush_slant_diff_is_watertight_387738() {
    let host = mesh_of(
        &[
            [478.50012207031250, -0.0000457763671875, 0.0],
            [3580.001708984375, -6699.17578125, 167.4681396484375],
            [-1764.322265625, -6699.17578125, 167.4681396484375],
            [478.50012207031250, -0.0000457763671875, 499.907318115234375],
            [-1764.322265625, -6699.17578125, 667.37548828125],
            [3580.001708984375, -6699.17578125, 667.37548828125],
        ],
        &[
            [0, 1, 2], [3, 4, 5], [2, 1, 5], [2, 5, 4],
            [1, 0, 3], [1, 3, 5], [0, 2, 4], [0, 4, 3],
        ],
    );
    let cutter = mesh_of(
        &[
            [-1764.322113037109375, -6699.175338745117188, 283.737548828125],
            [478.50012207031250, -0.0000457763671875, 283.737548828125],
            [478.50012207031250, -0.0000457763671875, 0.0],
            [-1764.322265625, -6699.17529296875, 167.468124389648438],
            [3580.0015258789062, -6699.175384521484375, 283.737548828125],
            [3580.001708984375, -6699.17529296875, 167.468124389648438],
        ],
        &[
            [0, 1, 2], [0, 2, 3], [4, 1, 0], [1, 4, 5],
            [1, 5, 2], [5, 3, 2], [4, 0, 3], [4, 3, 5],
        ],
    );
    let host_vol = mesh_volume(&host);
    let result = subtract(&host, &cutter);
    let open = exact_open_edges(&result);
    assert_eq!(open, 0, "flush-slant DIFF left {open} exact-coordinate open edges");
    let v = mesh_volume(&result);
    // The kept part is the host above the flush z≈283.74 cut plane
    // (pre-fix: open 13-tri garbage at +10.3% vs the oracle).
    assert!(
        v > 0.0 && v < host_vol,
        "DIFF volume {v} not inside (0, host {host_vol})"
    );
    let expected = 5.868313e9_f64; // IfcOpenShell 0.8.2, mm³
    assert!(
        (v - expected).abs() / expected < 1e-5,
        "DIFF volume = {v}, expected ≈{expected} (IfcOpenShell oracle)"
    );
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

/// Tangential-touch conformity regression (the `TriTri::Point` fix): a
/// window box whose top-left corner lands EXACTLY on the host face
/// triangle's diagonal (z = x/2 at x=4). The lower face triangle sees the
/// window-top intersection as a SEGMENT ending on the diagonal and splits
/// it there; the upper triangle's intersection with the window top is just
/// that single POINT — pre-fix it was discarded, the upper triangle never
/// split its edge, and the resulting T-junction opened 12 exact-coordinate
/// edges on a plain binary subtract. The touch point is now interned as a
/// conformity vertex in BOTH triangles (`RetriInput::points`).
#[test]
fn tangential_touch_on_host_diagonal_is_watertight() {
    use super::super::arrangement::box_mesh;
    let wall = tris_to_mesh(&box_mesh([0., 0., 0.], [6., 0.2, 3.])); // vol 3.6
    let window = tris_to_mesh(&box_mesh([4., -0.3, 0.5], [5., 0.5, 2.0])); // corner on diag
    let result = subtract(&wall, &window);
    let open = exact_open_edges(&result);
    assert_eq!(open, 0, "tangential-touch cut left {open} exact open edges");
    let v = mesh_volume(&result);
    assert!((v - 3.3).abs() < 1e-3, "window cut volume = {v}, expected 3.3");
}

/// Batching: a two-pocket batched group (flush-bottom door + a window whose
/// corner touches the face diagonal) must equal the sequential chain and
/// stay watertight — the configuration that exposed both the tangential-
/// touch defect and the swallowed-endpoint constraint-recovery bail.
#[test]
fn subtract_many_two_pocket_group_matches_sequential() {
    use super::super::arrangement::box_mesh;
    let wall = tris_to_mesh(&box_mesh([0., 0., 0.], [6., 0.2, 3.])); // vol 3.6
    let door = tris_to_mesh(&box_mesh([1., -1.0, 0.0], [2., 1.2, 2.5])); // flush bottom
    let window = tris_to_mesh(&box_mesh([4., -0.3, 0.5], [5., 0.5, 2.0]));
    let seq = subtract(&subtract(&wall, &door), &window);
    let many = subtract_many(&wall, &[&door, &window]).expect("group must conform");
    let (vs, vm) = (mesh_volume(&seq), mesh_volume(&many));
    let om = exact_open_edges(&many);
    assert_eq!(om, 0, "batched two-pocket cut left {om} exact open edges");
    assert!(
        (vs - vm).abs() < 1e-6,
        "batched volume {vm} != sequential volume {vs} on disjoint cutters"
    );
}

/// Disjoint-cutter batching: `subtract_many` of three pairwise-
/// disjoint through-openings in ONE arrangement equals the sequential
/// per-cutter chain (analytic volume), is watertight, and is robust to a
/// component arriving INWARD-wound — the per-component orientation inside
/// `subtract_many` must fix it (a global signed-volume orientation of the
/// concatenated soup cannot; the #2176 lesson).
#[test]
fn subtract_many_disjoint_openings_matches_sequential() {
    use super::super::arrangement::box_mesh;
    let wall = tris_to_mesh(&box_mesh([0., 0., 0.], [9., 3., 0.2])); // vol 5.4
    let op1 = tris_to_mesh(&box_mesh([1., 1., -0.5], [2., 2., 0.7])); // hole 0.2
    let mut op2 = tris_to_mesh(&box_mesh([4., 1., -0.5], [5., 2., 0.7])); // hole 0.2
    let op3 = tris_to_mesh(&box_mesh([7., 1., -0.5], [8., 2., 0.7])); // hole 0.2
    // flip op2's winding inward — per-component orientation must recover it
    for t in op2.indices.chunks_exact_mut(3) {
        t.swap(1, 2);
    }
    let batched = subtract_many(&wall, &[&op1, &op2, &op3])
        .expect("disjoint box group must conform");
    let v = mesh_volume(&batched);
    assert!((v - 4.8).abs() < 1e-3, "batched 3-opening wall volume = {v}, expected 4.8");
    let open = exact_open_edges(&batched);
    assert_eq!(open, 0, "batched cut left {open} exact-coordinate open edges");
    // parity with the sequential chain
    let seq = subtract(&subtract(&subtract(&wall, &op1), &op2), &op3);
    let vs = mesh_volume(&seq);
    assert!(
        (v - vs).abs() < 1e-6,
        "batched volume {v} != sequential volume {vs} on disjoint cutters"
    );
}
