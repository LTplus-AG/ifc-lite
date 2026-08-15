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
