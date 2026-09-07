// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for [`super`] — the outward-orienting pass and the topology verdict it
//! now reports. Split out of `mesh_orient.rs` so that file stays under the
//! module-size rule.

use super::*;

/// Build a unit cube as a flat-shaded mesh (positions not index-shared), with
/// `bad` triangle indices given as flipped (inward) so the winding is mixed.
fn cube(flipped: &[usize]) -> Mesh {
    // 12 triangles, outward-wound.
    let c = [
        [0.0f32, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0], [1.0, 0.0, 1.0], [1.0, 1.0, 1.0], [0.0, 1.0, 1.0],
    ];
    let faces: [[usize; 3]; 12] = [
        [0, 2, 1], [0, 3, 2], // bottom z=0 (outward -z)
        [4, 5, 6], [4, 6, 7], // top z=1 (outward +z)
        [0, 1, 5], [0, 5, 4], // front y=0
        [2, 3, 7], [2, 7, 6], // back y=1
        [1, 2, 6], [1, 6, 5], // right x=1
        [0, 4, 7], [0, 7, 3], // left x=0
    ];
    let mut m = Mesh::new();
    for (t, f) in faces.iter().enumerate() {
        let mut tri = *f;
        if flipped.contains(&t) {
            tri.swap(1, 2);
        }
        for &vi in &tri {
            m.positions.extend_from_slice(&c[vi]);
            m.normals.extend_from_slice(&[0.0, 0.0, 0.0]);
        }
        let base = (m.indices.len()) as u32;
        m.indices.extend_from_slice(&[base, base + 1, base + 2]);
    }
    m
}

fn bad_edges(m: &Mesh) -> usize {
    let q = |v: f32| (v as f64 * WELD_SCALE).round() as i64;
    let key = |i: u32| {
        let b = i as usize * 3;
        (q(m.positions[b]), q(m.positions[b + 1]), q(m.positions[b + 2]))
    };
    let mut dir: FxHashMap<((i64, i64, i64), (i64, i64, i64)), u32> = FxHashMap::default();
    for t in m.indices.chunks_exact(3) {
        let (a, b, c) = (key(t[0]), key(t[1]), key(t[2]));
        for e in [(a, b), (b, c), (c, a)] {
            *dir.entry(e).or_insert(0) += 1;
        }
    }
    dir.values().filter(|&&c| c >= 2).count()
}

#[test]
fn fixes_mixed_winding_to_consistent_outward() {
    let mut m = cube(&[3, 7, 10]); // three inward-flipped faces
    assert!(bad_edges(&m) > 0, "fixture must start winding-inconsistent");
    let flipped = orient_mesh_outward(&mut m);
    assert!(flipped, "the mixed-winding cube must be re-oriented");
    assert_eq!(bad_edges(&m), 0, "winding must be consistent after orient");
}

#[test]
fn already_outward_is_untouched() {
    let mut m = cube(&[]);
    let before = m.indices.clone();
    let flipped = orient_mesh_outward(&mut m);
    assert!(!flipped, "a clean outward cube must not be touched");
    assert_eq!(m.indices, before, "index buffer must be byte-identical");
}

#[test]
fn fully_inward_cube_is_flipped_outward() {
    // Every face inward: globally consistent but negative volume → flip all.
    let all: Vec<usize> = (0..12).collect();
    let mut m = cube(&all);
    assert_eq!(bad_edges(&m), 0, "a fully-inward cube is still consistent");
    let flipped = orient_mesh_outward(&mut m);
    assert!(flipped, "an inward-wound cube must be flipped outward");
    assert_eq!(bad_edges(&m), 0);
}

/// An OPEN sheet (a flat quad = two tris, with boundary edges) has no
/// meaningful enclosed volume. Even with one tri authored backwards, the
/// orienter must leave it byte-identical rather than flip it by a bogus
/// signed volume (which would reverse a TIN / SurfaceModel's authored normals).
#[test]
fn open_sheet_is_left_untouched() {
    let p = [
        [0.0f32, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0],
    ];
    let faces: [[usize; 3]; 2] = [[0, 1, 2], [0, 3, 2]]; // tri 1 deliberately reversed
    let mut m = Mesh::new();
    for f in &faces {
        for &vi in f {
            m.positions.extend_from_slice(&p[vi]);
            m.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
        }
        let base = m.indices.len() as u32;
        m.indices.extend_from_slice(&[base, base + 1, base + 2]);
    }
    let before = m.indices.clone();
    let flipped = orient_mesh_outward(&mut m);
    assert!(!flipped, "an open sheet must not be re-oriented");
    assert_eq!(m.indices, before, "open-sheet index buffer must be untouched");
}

/// Malformed buffers (an index past the vertex array) must bail cleanly, not
/// panic.
#[test]
fn malformed_indices_bail_without_panic() {
    let mut m = cube(&[]);
    m.indices[0] = 9999; // out of range
    let flipped = orient_mesh_outward(&mut m);
    assert!(!flipped, "malformed input must be a no-op");
}

// ---------------------------------------------------------------------------
// The verdict (#1891). `orient_mesh_outward` already computed `closed` and
// `orientable` per component and discarded them; these pin what it now reports.
// ---------------------------------------------------------------------------

/// A translate-by-`d` copy of `m`, appended — two disjoint bodies in one mesh.
fn plus_translated(m: &Mesh, d: [f32; 3]) -> Mesh {
    let mut out = m.clone();
    let base = (out.positions.len() / 3) as u32;
    for v in m.positions.chunks_exact(3) {
        out.positions
            .extend_from_slice(&[v[0] + d[0], v[1] + d[1], v[2] + d[2]]);
    }
    out.normals.extend_from_slice(&m.normals);
    out.indices.extend(m.indices.iter().map(|i| i + base));
    out
}

/// A closed cube is exactly what the volume gate is looking for: one closed,
/// orientable component.
#[test]
fn closed_cube_reports_one_closed_orientable_component() {
    let mut m = cube(&[]);
    let v = orient_mesh_outward_verdict(&mut m);
    assert_eq!(
        v,
        OrientVerdict {
            flipped: false,
            all_closed: true,
            all_orientable: true,
            components: 1,
        }
    );
    assert!(v.is_single_closed_solid());
}

/// The verdict must survive a re-orientation: a mixed-winding cube is still ONE
/// closed component after the pass fixes it, and reporting otherwise would deny
/// a volume to every faceted brep the orienter successfully repaired.
#[test]
fn a_repaired_cube_is_still_a_single_closed_solid() {
    let mut m = cube(&[3, 7, 10]);
    let v = orient_mesh_outward_verdict(&mut m);
    assert!(v.flipped, "the fixture must actually have been re-wound");
    assert!(
        v.is_single_closed_solid(),
        "repairing the winding does not make the surface less closed: {v:?}"
    );
}

/// An OPEN sheet must be reported open. This is the clause that keeps a
/// divergence-theorem volume off material-layer wall slices and TINs, where the
/// sum is arbitrary rather than merely inaccurate.
#[test]
fn open_sheet_reports_not_closed() {
    let p = [
        [0.0f32, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0],
    ];
    let faces: [[usize; 3]; 2] = [[0, 1, 2], [0, 3, 2]];
    let mut m = Mesh::new();
    for f in &faces {
        for &vi in f {
            m.positions.extend_from_slice(&p[vi]);
            m.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
        }
        let base = m.indices.len() as u32;
        m.indices.extend_from_slice(&[base, base + 1, base + 2]);
    }
    let v = orient_mesh_outward_verdict(&mut m);
    assert!(!v.all_closed, "a quad with boundary edges is not closed");
    assert!(!v.is_single_closed_solid());
}

/// Two disjoint closed cubes are TWO components. The count is load-bearing:
/// this pass flips each closed component to positive volume, so it cannot tell
/// two solids apart from a solid plus the shell of its own cavity — and the
/// second sums to `outer + cavity` where the truth is `outer − cavity`.
#[test]
fn two_disjoint_cubes_report_two_components_and_no_single_solid() {
    let mut m = plus_translated(&cube(&[]), [10.0, 0.0, 0.0]);
    let v = orient_mesh_outward_verdict(&mut m);
    assert_eq!(v.components, 2, "two disjoint bodies are two components");
    assert!(v.all_closed && v.all_orientable, "both bodies are closed: {v:?}");
    assert!(
        !v.is_single_closed_solid(),
        "closed-but-two-pieces must NOT license a volume"
    );
}

/// A shell nested INSIDE another is the case the component count exists to
/// refuse: both are closed, both get flipped outward, and summing them reports
/// `outer + inner` for what is physically `outer − inner`.
#[test]
fn a_shell_inside_a_shell_is_refused_not_summed() {
    // Inner cube fully inside the outer one (0.25..0.75 inside 0..1).
    let inner = {
        let mut m = cube(&[]);
        for v in m.positions.chunks_exact_mut(3) {
            v[0] = v[0] * 0.5 + 0.25;
            v[1] = v[1] * 0.5 + 0.25;
            v[2] = v[2] * 0.5 + 0.25;
        }
        m
    };
    let mut m = cube(&[]);
    let base = (m.positions.len() / 3) as u32;
    m.positions.extend_from_slice(&inner.positions);
    m.normals.extend_from_slice(&inner.normals);
    m.indices.extend(inner.indices.iter().map(|i| i + base));

    let v = orient_mesh_outward_verdict(&mut m);
    assert_eq!(v.components, 2);
    assert!(
        !v.is_single_closed_solid(),
        "a cavity shell is indistinguishable from a second solid here, so neither may pass"
    );
}

/// Buffers the pass refuses to analyse claim NOTHING. `all_closed` false rather
/// than vacuously true, so a consumer gating a volume on it emits nothing.
#[test]
fn unanalysable_meshes_report_indeterminate() {
    let mut malformed = cube(&[]);
    malformed.indices[0] = 9999;
    assert_eq!(
        orient_mesh_outward_verdict(&mut malformed),
        OrientVerdict::INDETERMINATE
    );

    let mut tiny = Mesh::new();
    tiny.positions.extend_from_slice(&[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]);
    tiny.normals.extend_from_slice(&[0.0; 9]);
    tiny.indices.extend_from_slice(&[0, 1, 2]);
    assert_eq!(
        orient_mesh_outward_verdict(&mut tiny),
        OrientVerdict::INDETERMINATE,
        "one triangle cannot enclose a volume, so it must not claim to be closed"
    );
    const { assert!(!OrientVerdict::INDETERMINATE.all_closed) };
    assert!(!OrientVerdict::INDETERMINATE.is_single_closed_solid());
}

/// THE NO-GEOMETRY-CHANGE PIN. Reporting the verdict must not move one index or
/// one vertex: the legacy entry point and the verdict entry point have to
/// mutate byte-identically, and the legacy `bool` has to stay `verdict.flipped`.
/// Every mesh shape the pass distinguishes is checked, because the flip
/// decision differs per shape.
#[test]
fn reporting_the_verdict_does_not_change_a_single_index() {
    let fixtures = [
        cube(&[]),
        cube(&[3, 7, 10]),
        cube(&(0..12).collect::<Vec<_>>()),
        plus_translated(&cube(&[]), [10.0, 0.0, 0.0]),
        plus_translated(&cube(&[1, 4]), [0.0, 10.0, 0.0]),
    ];
    for (i, base) in fixtures.iter().enumerate() {
        let mut legacy = base.clone();
        let mut with_verdict = base.clone();
        let flipped = orient_mesh_outward(&mut legacy);
        let verdict = orient_mesh_outward_verdict(&mut with_verdict);
        assert_eq!(
            legacy.indices, with_verdict.indices,
            "fixture {i}: the two entry points must produce the SAME index buffer"
        );
        assert_eq!(
            legacy.positions, with_verdict.positions,
            "fixture {i}: neither may touch positions at all"
        );
        assert_eq!(
            flipped, verdict.flipped,
            "fixture {i}: the legacy bool must remain exactly `verdict.flipped`"
        );
    }
}

/// Flat-shaded triangle soup from a vertex table and a face list — one vertex
/// per corner, exactly like [`cube`], so welding (not index sharing) is what
/// builds the edge graph.
fn soup(verts: &[[f32; 3]], faces: &[[usize; 3]]) -> Mesh {
    let mut m = Mesh::new();
    for f in faces {
        for &vi in f {
            m.positions.extend_from_slice(&verts[vi]);
            m.normals.extend_from_slice(&[0.0, 0.0, 0.0]);
        }
        let base = m.indices.len() as u32;
        m.indices.extend_from_slice(&[base, base + 1, base + 2]);
    }
    m
}

/// `all_closed` must reject a NON-MANIFOLD edge, not just a boundary one.
///
/// Two tetrahedra glued at a shared face, with that face emitted by BOTH — the
/// doubled coincident sheet `router::layers` names as the "ghost face", and what
/// exporters produce whenever two bodies are stacked at a common interface.
/// Every edge here has TWO or FOUR incident triangles, never one, so a gate
/// that asks "is any edge under-shared" (`count < 2`) sees a perfectly closed
/// shell and licenses a divergence-theorem volume over a surface with no
/// well-defined inside. The pass asks `count != 2`; this pins that.
///
/// The existing open-sheet fixtures cannot see the difference: their bad edges
/// are BOUNDARY edges, degree 1, which both readings reject. Only a
/// degree-FOUR edge separates the two.
#[test]
fn a_doubled_interface_face_is_not_closed_even_though_no_edge_is_under_shared() {
    // P, Q, R = the shared base; A above it, B below it.
    let verts = [
        [0.0f32, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [0.0, 0.0, -1.0],
    ];
    let faces = [
        [0, 1, 2], [3, 1, 0], [3, 2, 1], [3, 0, 2], // tetra A, base included
        [0, 2, 1], [4, 0, 1], [4, 1, 2], [4, 2, 0], // tetra B, base included again
    ];
    let mut m = soup(&verts, &faces);

    // The fixture's defining property: no edge is under-shared, three are
    // OVER-shared. Asserted, not assumed — it is the whole point of the case.
    let q = |v: f32| (v as f64 * WELD_SCALE).round() as i64;
    let mut counts: FxHashMap<((i64, i64, i64), (i64, i64, i64)), u32> = FxHashMap::default();
    for t in m.indices.chunks_exact(3) {
        let key = |i: u32| {
            let b = i as usize * 3;
            (q(m.positions[b]), q(m.positions[b + 1]), q(m.positions[b + 2]))
        };
        let (a, b, c) = (key(t[0]), key(t[1]), key(t[2]));
        for (x, y) in [(a, b), (b, c), (c, a)] {
            let e = if x < y { (x, y) } else { (y, x) };
            *counts.entry(e).or_insert(0) += 1;
        }
    }
    assert!(
        counts.values().all(|&c| c >= 2),
        "fixture must have NO boundary edge, else it cannot distinguish the two readings"
    );
    assert_eq!(
        counts.values().filter(|&&c| c > 2).count(),
        3,
        "the doubled base contributes exactly three non-manifold edges"
    );

    let before = m.indices.clone();
    let v = orient_mesh_outward_verdict(&mut m);
    assert!(
        !v.all_closed,
        "a shell with a degree-4 edge is NOT closed — it has no well-defined inside: {v:?}"
    );
    assert!(
        !v.is_single_closed_solid(),
        "and therefore must not license a volume: {v:?}"
    );
    assert_eq!(
        m.indices, before,
        "an unclosed component is left wound exactly as authored"
    );
}

/// `all_orientable` must be able to come out FALSE. Nothing else in the suite
/// ever observes it: every other fixture is orientable, so the contradiction
/// branch could be deleted outright and the whole package still passed.
///
/// The 6-vertex hemi-icosahedron is the minimal triangulation of the real
/// projective plane: 6 vertices, 15 edges, 10 faces, χ = 1. Every edge is
/// shared by EXACTLY two triangles — so it is closed and manifold — yet
/// orientation propagated around it comes back reversed. That combination
/// (closed AND non-orientable) is the only one that isolates the branch; an
/// open Möbius band would be rejected by `all_closed` first and prove nothing.
///
/// The positions are the octahedron's, which makes the surface self-intersect
/// in R³. That is unavoidable — no closed non-orientable surface embeds in R³ —
/// and irrelevant here: the pass reads welded positions for vertex identity and
/// the edge graph for topology, and never reaches the signed-volume sum on a
/// component it has already refused.
#[test]
fn a_closed_but_non_orientable_shell_is_refused_rather_than_wound_outward() {
    let verts = [
        [1.0f32, 0.0, 0.0],
        [-1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, -1.0, 0.0],
        [0.0, 0.0, 1.0],
        [0.0, 0.0, -1.0],
    ];
    let faces = [
        [0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 5], [0, 5, 1],
        [1, 2, 4], [2, 3, 5], [3, 4, 1], [4, 5, 2], [5, 1, 3],
    ];
    let mut m = soup(&verts, &faces);
    let before = m.indices.clone();
    let v = orient_mesh_outward_verdict(&mut m);

    assert_eq!(v.components, 1, "the hemi-icosahedron is connected: {v:?}");
    assert!(
        v.all_closed,
        "every one of its 15 edges is shared by exactly two triangles: {v:?}"
    );
    assert!(
        !v.all_orientable,
        "a projective plane has no consistent orientation, so the pass must say so: {v:?}"
    );
    assert!(
        !v.is_single_closed_solid(),
        "closed is not enough — without an orientation the sign of each \
         triangle's contribution is arbitrary: {v:?}"
    );
    assert!(!v.flipped, "nothing may be re-wound: {v:?}");
    assert_eq!(
        m.indices, before,
        "a non-orientable component keeps the winding it was authored with"
    );
}

// #3988: index sharing is storage only. The orienter must produce the same
// ordered, directed triangles and topology for shared, soup and sparse storage.
#[test]
fn issue_3988_orientation_is_independent_of_vertex_index_sharing() {
    for flipped in [&[][..], &[0][..], &[2, 4, 7][..], &[0, 1, 2, 3, 4, 5][..]] {
        let mut expanded = cube(flipped);
        let mut indexed = Mesh::new();
        let mut ids = FxHashMap::default();
        for p in expanded.positions.chunks_exact(3) {
            let key = (p[0].to_bits(), p[1].to_bits(), p[2].to_bits());
            let id = *ids.entry(key).or_insert_with(|| {
                let id = indexed.positions.len() as u32 / 3;
                indexed.positions.extend_from_slice(p);
                id
            });
            indexed.indices.push(id);
        }
        let mut sparse = indexed.clone();
        // Unreferenced positions must not influence welding IDs or topology.
        sparse.positions.extend(std::iter::repeat_n(37.0, 300));
        let expected = orient_mesh_outward_verdict(&mut expanded);
        let directed_positions = |m: &Mesh| -> Vec<u32> {
            m.indices.iter().flat_map(|&i| {
                m.positions[i as usize * 3..i as usize * 3 + 3].iter().map(|p| p.to_bits())
            }).collect()
        };
        for m in [&mut indexed, &mut sparse] {
            assert_eq!(orient_mesh_outward_verdict(m), expected);
            assert_eq!(directed_positions(m), directed_positions(&expanded));
        }
        assert!(expected.is_single_closed_solid());
    }
}

// #3988: compact edge bookkeeping must preserve the actual incidence stream,
// including repeated triangle IDs. Only count<=2 exposes triangle slots.
#[test]
fn compact_incidence_preserves_incident_prefixes_3988() {
    for sequence in [
        (0..16).collect::<Vec<usize>>(),
        vec![7; 16],
        vec![usize::MAX / 3, usize::MAX / 3 - 1, 0, 1, 1, 0],
    ] {
        let mut edge = EdgeInc::default();
        let mut oracle = Vec::new();
        assert_eq!(edge.count(), 0);
        assert!(edge.incident().is_empty());
        for triangle in sequence {
            oracle.push(triangle);
            edge.push(triangle);
            assert_eq!(edge.count() as usize, oracle.len());
            if oracle.len() <= 2 {
                assert_eq!(edge.incident(), oracle);
            }
        }
    }
}

// #3988: the old record's u32 arithmetic is observable at overflow. Starting
// near the boundary avoids allocating billions of triangles while checking the
// same state transitions, including usize::MAX collision on wasm32.
#[test]
fn compact_incidence_preserves_counter_overflow_3988() {
    #[derive(Clone)]
    struct Original { tris: [usize; 2], count: u32 }
    impl Original {
        fn push(&mut self, triangle: usize) {
            if self.count < 2 { self.tris[self.count as usize] = triangle; }
            self.count += 1;
        }
    }
    let mut original = Original { tris: [42, 73], count: u32::MAX - 1 };
    let mut compact = EdgeInc {
        tris: [(u32::MAX - 1) as usize, EdgeInc::NONMANIFOLD],
    };
    original.push(9);
    compact.push(9);
    assert_eq!(compact.count(), original.count);
    let original_overflow = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        original.push(10);
    }));
    let compact_overflow = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        compact.push(10);
    }));
    assert_eq!(compact_overflow.is_err(), original_overflow.is_err());
    assert_eq!(compact.count(), original.count);
    if original_overflow.is_ok() {
        assert!(compact.incident().is_empty());
        for triangle in [19, 23] {
            original.push(triangle);
            compact.push(triangle);
            assert_eq!(compact.count(), original.count);
            assert_eq!(compact.incident(), &original.tris[..original.count as usize]);
        }
    }
}

/// #3988: compare dense links with the original map incidence representation
/// through the SAME canonical orientation pass, including exact winding order.
fn assert_dense_matches_map_3988(input: &Mesh) {
    let mut dense = input.clone();
    let mut wide = input.clone();
    ORIENT_SCRATCH.with(|slot| *slot.borrow_mut() = Some(OrientScratch::default()));
    let dense_verdict = orient_mesh_outward_verdict(&mut dense);
    ORIENT_SCRATCH.with(|slot| *slot.borrow_mut() = Some(OrientScratch {
        edge_tris: EdgeAdjacency::wide_for_test(), ..OrientScratch::default()
    }));
    let wide_verdict = orient_mesh_outward_verdict(&mut wide);
    ORIENT_SCRATCH.with(|slot| *slot.borrow_mut() = Some(OrientScratch::default()));
    assert_eq!(dense_verdict, wide_verdict);
    assert_eq!(dense.indices, wide.indices);
    assert_eq!(dense.positions.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
        wide.positions.iter().map(|v| v.to_bits()).collect::<Vec<_>>());
    assert_eq!(dense.normals.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
        wide.normals.iter().map(|v| v.to_bits()).collect::<Vec<_>>());
}

#[test]
fn dense_adjacency_preserves_orientation_and_degenerate_incidence_3988() {
    for mask in 0..256u32 {
        let flips: Vec<usize> = (0..12).filter(|bit| mask & (1 << bit) != 0).collect();
        assert_dense_matches_map_3988(&cube(&flips));
    }
    let vertices = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    // Repeated non-zero edges within one degenerate triangle are two distinct
    // incidences; a later third incidence must revoke BOTH earlier links.
    for faces in [
        vec![[0, 1, 0], [0, 2, 3]],
        vec![[0, 1, 0], [0, 1, 2]],
        vec![[0, 1, 2], [1, 0, 3], [0, 1, 3]],
        vec![[0, 0, 0], [1, 1, 1]],
        vec![[0, 1, 2], [0, 2, 1]],
    ] { assert_dense_matches_map_3988(&soup(&vertices, &faces)); }
    // File-like arbitrary topology, deterministic and including repeated refs.
    let mut state = 0x3988u32;
    for _ in 0..128 {
        let faces: Vec<[usize; 3]> = (0..17).map(|_| std::array::from_fn(|_| {
            state = state.wrapping_mul(1664525).wrapping_add(1013904223);
            ((state >> 16) & 3) as usize
        })).collect();
        assert_dense_matches_map_3988(&soup(&vertices, &faces));
    }
    let mut malformed = cube(&[]);
    malformed.indices.push(u32::MAX);
    assert_dense_matches_map_3988(&malformed);
    let mut partial = cube(&[3]);
    partial.indices.push(0);
    assert_dense_matches_map_3988(&partial);
}

#[test]
fn dense_adjacency_reuses_links_across_width_transitions_3988() {
    let mut retained_dense = OrientScratch::default();
    for triangles in [2, 21845, 21846, 7, 24000, 2] {
        // Disjoint closed tetrahedra exercise volume order and orientation;
        // trailing open triangles cover counts not divisible by four.
        let mut input = Mesh::new();
        for t in 0..triangles {
            let group = t / 4;
            let x = group as f32 * 4.0;
            let vertices = [[x, 0.0, 0.0], [x + 1.0, 0.0, 0.0],
                [x, 1.0, 0.0], [x, 0.0, 1.0]];
            let faces = [[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]];
            let part = soup(&vertices, &[faces[t % 4]]);
            let offset = input.positions.len() as u32 / 3;
            input.positions.extend(part.positions);
            input.normals.extend(part.normals);
            input.indices.extend(part.indices.into_iter().map(|i| i + offset));
        }
        let mut expected = input.clone();
        ORIENT_SCRATCH.with(|slot| *slot.borrow_mut() = Some(OrientScratch {
            edge_tris: EdgeAdjacency::wide_for_test(), ..OrientScratch::default()
        }));
        let expected_verdict = orient_mesh_outward_verdict(&mut expected);
        ORIENT_SCRATCH.with(|slot| *slot.borrow_mut() = Some(retained_dense));
        let actual_verdict = orient_mesh_outward_verdict(&mut input);
        retained_dense = ORIENT_SCRATCH.with(|slot| slot.borrow_mut().take().unwrap());
        assert_eq!(actual_verdict, expected_verdict, "{triangles} triangles");
        assert_eq!(input.indices, expected.indices, "{triangles} triangles");
    }
    ORIENT_SCRATCH.with(|slot| *slot.borrow_mut() = Some(OrientScratch::default()));
}
