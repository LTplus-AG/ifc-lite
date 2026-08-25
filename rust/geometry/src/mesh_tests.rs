// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

/// Build a mesh from explicit triangles (each tri = 3 xyz triples).
fn mesh_from_tris(tris: &[[[f32; 3]; 3]]) -> Mesh {
    let mut m = Mesh::new();
    for (i, t) in tris.iter().enumerate() {
        for v in t {
            m.positions.extend_from_slice(v);
            m.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
        }
        let b = (i * 3) as u32;
        m.indices.extend_from_slice(&[b, b + 1, b + 2]);
    }
    m
}

#[test]
fn clip_to_aabb_drops_protruding_flap_and_compacts() {
    // Two in-bounds triangles forming a unit quad in z=0, plus one spurious
    // "spike" flap whose apex pokes far below the host AABB (the malformed-
    // cutter artifact): apex at y = -5 while the host is y in [0,1].
    let mut m = mesh_from_tris(&[
        [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0]],
        [[0.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0]],
        // spike: one vertex 5 m below the host
        [[1.0, 1.0, 0.0], [0.0, 1.0, 0.0], [0.5, -5.0, 0.0]],
    ]);
    let dropped = m.clip_triangles_to_aabb([0.0, 0.0, 0.0], [1.0, 1.0, 0.0], 0.01);
    assert_eq!(dropped, 1, "only the spike triangle should be dropped");
    assert_eq!(m.triangle_count(), 2);
    // Orphaned spike apex must be compacted away so bounds() is clean.
    let (lo, hi) = m.bounds();
    assert!(lo.y >= -0.01, "protruding apex left in positions: lo.y = {}", lo.y);
    let _ = hi;
    // 9 input verts (3 per tri, unshared) → after dropping the spike's 3 and
    // compacting the orphaned apex, the 2 kept tris keep their 6 verts.
    assert_eq!(m.positions.len() / 3, 6, "orphaned apex must be compacted out");
    assert_eq!(m.normals.len(), m.positions.len(), "normals stay in sync");
    // every surviving index is in range
    assert!(m.indices.iter().all(|&i| (i as usize) < m.positions.len() / 3));
}

#[test]
fn clip_to_aabb_is_noop_when_nothing_protrudes() {
    let tris = [
        [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0]],
        [[0.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0]],
    ];
    let mut m = mesh_from_tris(&tris);
    let before_pos = m.positions.clone();
    let before_idx = m.indices.clone();
    let dropped = m.clip_triangles_to_aabb([0.0, 0.0, 0.0], [1.0, 1.0, 0.0], 0.01);
    assert_eq!(dropped, 0);
    // bit-identical: clean cuts must not perturb the frozen snapshot corpus
    assert_eq!(m.positions, before_pos);
    assert_eq!(m.indices, before_idx);
}

#[test]
fn clip_to_aabb_preserves_mesh_when_all_would_drop() {
    // Degenerate guard: if EVERY triangle is outside (an upstream frame bug,
    // not a spike), preserve the mesh rather than silently emptying it.
    let mut m = mesh_from_tris(&[[
        [100.0, 100.0, 0.0],
        [101.0, 100.0, 0.0],
        [101.0, 101.0, 0.0],
    ]]);
    let dropped = m.clip_triangles_to_aabb([0.0, 0.0, 0.0], [1.0, 1.0, 0.0], 0.01);
    assert_eq!(dropped, 0);
    assert_eq!(m.triangle_count(), 1, "mesh preserved, not emptied");
}

#[test]
fn clip_to_host_aabb_trims_reveal_overhang_on_a_large_slab_1633() {
    // #1633: a flush-capped through-opening's reveal is extended ~0.3·depth
    // past the host cap for a clean transversal cut, so the exact subtract
    // leaves a reveal triangle ~0.105 m past a 0.35 m floor slab. The auto pad
    // MUST trim it regardless of host size — the bug was that `1e-3 · diag`
    // grew to 0.13 m on this ~130 m-diagonal slab (wider than the overhang) and
    // let it through, while a 5 m wall's 5 mm pad trimmed the identical overhang.
    let big = 92.0_f32; // 92 × 92 × 0.35 slab ⇒ diag ≈ 130 m ⇒ old pad ≈ 0.13 m
    let mut m = mesh_from_tris(&[
        // two in-bounds cap triangles (host top face at z = 0.35)
        [[0.0, 0.0, 0.35], [big, 0.0, 0.35], [big, big, 0.35]],
        [[0.0, 0.0, 0.35], [big, big, 0.35], [0.0, big, 0.35]],
        // reveal-overhang sliver: apex 0.105 m above the slab top cap
        [[40.0, 40.0, 0.35], [41.0, 40.0, 0.35], [40.5, 40.5, 0.455]],
    ]);
    let dropped = m.clip_triangles_to_host_aabb([0.0, 0.0, 0.0], [big, big, 0.35]);
    assert_eq!(dropped, 1, "the 0.105 m reveal overhang must be trimmed on a large host");
    let (_lo, hi) = m.bounds();
    assert!(hi.z <= 0.36, "no vertex may remain above the slab top cap: hi.z = {}", hi.z);
}

#[test]
fn clip_to_host_aabb_is_byte_identical_to_1e3_diag_for_small_hosts() {
    // The bound only changes behaviour above a 10 m diagonal; a normal wall
    // (~5 m diag ⇒ pad = 5 mm) is untouched, so the frozen corpus is safe.
    let tris = [
        [[0.0, 0.0, 0.0], [3.0, 0.0, 0.0], [3.0, 4.0, 0.0]],
        [[0.0, 0.0, 0.0], [3.0, 4.0, 0.0], [0.0, 4.0, 0.0]],
    ];
    let mut auto = mesh_from_tris(&tris);
    let mut manual = mesh_from_tris(&tris);
    let diag = (3.0_f64 * 3.0 + 4.0 * 4.0).sqrt(); // 5 m
    let old_pad = (1.0e-3 * diag).max(5.0e-3) as f32;
    auto.clip_triangles_to_host_aabb([0.0, 0.0, 0.0], [3.0, 4.0, 0.0]);
    manual.clip_triangles_to_aabb([0.0, 0.0, 0.0], [3.0, 4.0, 0.0], old_pad);
    assert_eq!(auto.positions, manual.positions);
    assert_eq!(auto.indices, manual.indices);
}

#[test]
fn test_merge() {
    let mut mesh1 = Mesh::new();
    mesh1.add_vertex(Point3::new(0.0, 0.0, 0.0), Vector3::z());
    mesh1.add_triangle(0, 1, 2);

    let mut mesh2 = Mesh::new();
    mesh2.add_vertex(Point3::new(1.0, 1.0, 1.0), Vector3::y());
    mesh2.add_triangle(0, 1, 2);

    mesh1.merge(&mesh2);
    assert_eq!(mesh1.vertex_count(), 2);
    assert_eq!(mesh1.triangle_count(), 2);
}

#[test]
fn test_centroid_f64() {
    let mut mesh = Mesh::new();
    mesh.positions = vec![0.0, 0.0, 0.0, 10.0, 10.0, 10.0, 20.0, 20.0, 20.0];
    mesh.normals = vec![0.0; 9];

    let centroid = mesh.centroid_f64();
    assert!((centroid.x - 10.0).abs() < 0.001);
    assert!((centroid.y - 10.0).abs() < 0.001);
    assert!((centroid.z - 10.0).abs() < 0.001);
}

#[test]
fn test_validate_indices_strips_out_of_bounds() {
    let mut mesh = Mesh {
        positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0], // 3 vertices
        normals: vec![],
        indices: vec![
            0, 1, 2, // valid
            0, 1, 5, // invalid: vertex 5 out of bounds
            3, 4, 5, // invalid: all out of bounds
        ],
        rtc_applied: false,
        origin: [0.0; 3],
        instance_meta: None,
        local_bounds: None,
        local_to_world: None,
    };
    mesh.validate_indices();
    assert_eq!(mesh.indices, vec![0, 1, 2]);
}

#[test]
fn test_validate_indices_empty_positions() {
    let mut mesh = Mesh {
        positions: vec![],
        normals: vec![],
        indices: vec![0, 1, 2],
        rtc_applied: false,
        origin: [0.0; 3],
        instance_meta: None,
        local_bounds: None,
        local_to_world: None,
    };
    mesh.validate_indices();
    assert!(mesh.indices.is_empty());
}

#[test]
fn test_validate_indices_incomplete_triangle() {
    let mut mesh = Mesh {
        positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        normals: vec![],
        indices: vec![0, 1, 2, 0, 1], // trailing incomplete triangle
        rtc_applied: false,
        origin: [0.0; 3],
        instance_meta: None,
        local_bounds: None,
        local_to_world: None,
    };
    mesh.validate_indices();
    assert_eq!(mesh.indices, vec![0, 1, 2]);
}

fn make_unwelded_box() -> Mesh {
    // A 1×1×1 cube emitted as triangle soup: each face has its own 4
    // vertices (not shared with adjacent faces), so 6 faces × 4 verts
    // = 24 vertices, 12 triangles. This is what the extrusion path
    // produces today.
    let mut m = Mesh::new();
    let corners = [
        (0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (1.0, 1.0, 0.0), (0.0, 1.0, 0.0),
        (0.0, 0.0, 1.0), (1.0, 0.0, 1.0), (1.0, 1.0, 1.0), (0.0, 1.0, 1.0),
    ];
    let faces: [([usize; 4], [f32; 3]); 6] = [
        ([0, 3, 2, 1], [0.0, 0.0, -1.0]), // bottom
        ([4, 5, 6, 7], [0.0, 0.0, 1.0]),  // top
        ([0, 1, 5, 4], [0.0, -1.0, 0.0]), // front
        ([2, 3, 7, 6], [0.0, 1.0, 0.0]),  // back
        ([0, 4, 7, 3], [-1.0, 0.0, 0.0]), // left
        ([1, 2, 6, 5], [1.0, 0.0, 0.0]),  // right
    ];
    for (idx, normal) in faces {
        let base = (m.positions.len() / 3) as u32;
        for &i in idx.iter() {
            let (x, y, z) = corners[i];
            m.positions.extend_from_slice(&[x, y, z]);
            m.normals.extend_from_slice(&normal);
        }
        m.indices.extend_from_slice(&[base, base + 1, base + 2]);
        m.indices.extend_from_slice(&[base, base + 2, base + 3]);
    }
    m
}

#[test]
fn welded_by_position_collapses_corner_to_one_vertex() {
    let m = make_unwelded_box();
    // Position-only weld: all 24 input vertices map to the 8 box
    // corners. 8 vertices, 12 triangles (no degenerates since a
    // 1×1×1 box's corner-only mesh is non-degenerate).
    let welded = m.welded_by_position(1e-6);
    assert_eq!(
        welded.vertex_count(),
        8,
        "position-only weld must collapse 24 face-corner duplicates to 8 box corners"
    );
    assert_eq!(welded.triangle_count(), 12);
    // Averaged normal at each corner must be unit length (within f32
    // precision); we don't pin a specific direction because three
    // faces' normals sum to a face-diagonal direction.
    for chunk in welded.normals.chunks_exact(3) {
        let len_sq = chunk[0] * chunk[0] + chunk[1] * chunk[1] + chunk[2] * chunk[2];
        assert!(
            (len_sq - 1.0).abs() < 1e-4,
            "welded normal must be unit length, got |n|^2 = {}",
            len_sq
        );
    }
}

/// #1474 / B7 regression guard: a vertex-changing rebuild MUST carry the
/// mesh's placement/frame metadata (origin, rtc_applied, local_bounds,
/// local_to_world) forward and MUST drop instance_meta (the changed vertices
/// no longer match the canonical rep). Directly exercises `rebuilt_like` and
/// the two public seams that route through it (`subdivided`,
/// `welded_by_position`). Pure unit test — no fixture.
#[test]
fn rebuild_carries_placement_metadata_and_drops_instancing() {
    // One triangle, placed: non-default origin/rtc + a set #1474 capture and
    // an attached instance side-channel.
    let mut m = mesh_from_tris(&[[[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0]]]);
    m.origin = [100.0, 200.0, 300.0];
    m.rtc_applied = true;
    m.local_bounds = Some([0.0, 0.0, 0.0, 1.0, 1.0, 0.0]);
    let l2w: [f64; 16] = [
        1.0, 0.0, 0.0, 10.0, //
        0.0, 1.0, 0.0, 20.0, //
        0.0, 0.0, 1.0, 30.0, //
        0.0, 0.0, 0.0, 1.0,
    ];
    m.local_to_world = Some(l2w);
    m.instance_meta = Some(InstanceMeta {
        transform: l2w,
        local_transform: None,
        canonical_transform: None,
        rep_identity: 0xDEAD_BEEF,
        instanceable: true,
    });

    // Metadata carried; instancing dropped. Assert on every seam.
    let via_ctor = m.rebuilt_like(vec![0.0, 0.0, 0.0], vec![0.0, 0.0, 1.0], vec![]);
    let via_subdivide = m.subdivided(1);
    let via_weld = m.welded_by_position(1e-6);

    for (label, out) in [
        ("rebuilt_like", &via_ctor),
        ("subdivided", &via_subdivide),
        ("welded_by_position", &via_weld),
    ] {
        assert_eq!(out.origin, [100.0, 200.0, 300.0], "{label}: origin must carry");
        assert!(out.rtc_applied, "{label}: rtc_applied must carry");
        assert_eq!(
            out.local_bounds,
            Some([0.0, 0.0, 0.0, 1.0, 1.0, 0.0]),
            "{label}: local_bounds (#1474) must carry"
        );
        assert_eq!(out.local_to_world, Some(l2w), "{label}: local_to_world (#1474) must carry");
        assert!(
            out.instance_meta.is_none(),
            "{label}: instance_meta must be dropped (vertices changed -> not the canonical rep)"
        );
    }
}

#[test]
fn welded_drops_degenerate_triangles() {
    // A triangle whose three vertices all quantize to the same
    // position should be dropped after welding (it collapsed to a
    // point).
    let mut m = Mesh::new();
    m.positions = vec![
        0.0, 0.0, 0.0,
        // Two more "vertices" within position_eps of vertex 0:
        5e-8, 0.0, 0.0,
        0.0, 5e-8, 0.0,
        // A real non-degenerate triangle:
        1.0, 0.0, 0.0,
        1.0, 1.0, 0.0,
    ];
    m.normals = vec![
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,
    ];
    m.indices = vec![
        0, 1, 2,   // collapses to a point after weld at eps=1e-6
        0, 3, 4,   // survives
    ];
    let welded = m.welded_by_position(1e-6);
    assert_eq!(welded.triangle_count(), 1);
}

#[test]
fn welded_handles_empty_mesh() {
    let m = Mesh::new();
    let welded_pos = m.welded_by_position(1e-6);
    assert!(welded_pos.is_empty());
}

#[test]
fn welded_strips_out_of_bound_indices() {
    let mut m = Mesh::new();
    m.positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    m.normals = vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
    m.indices = vec![0, 1, 2, 0, 1, 99];
    let welded = m.welded_by_position(1e-6);
    assert_eq!(welded.triangle_count(), 1);
}

#[test]
fn test_validate_indices_all_valid() {
    let mut mesh = Mesh {
        positions: vec![0.0; 12], // 4 vertices
        normals: vec![],
        indices: vec![0, 1, 2, 1, 2, 3],
        rtc_applied: false,
        origin: [0.0; 3],
        instance_meta: None,
        local_bounds: None,
        local_to_world: None,
    };
    mesh.validate_indices();
    assert_eq!(mesh.indices, vec![0, 1, 2, 1, 2, 3]);
}

// ── drop_thin_triangles / clean_degenerate ───────────────────────────

const GRID: f64 = 1.0 / 65536.0; // ≈ 15.26 µm, the kernel reconcile grid

#[test]
fn drop_thin_removes_collinear_sliver_keeps_real_triangle() {
    // v0,v1,v2 are near-collinear: v2 sits 5 µm off the v0→v1 line over a
    // 1 m span — a zero-area sliver. A second, well-formed triangle
    // (v3,v4,v5, height 0.5 m) must survive.
    let mut mesh = Mesh {
        positions: vec![
            0.0, 0.0, 0.0, // v0
            1.0, 0.0, 0.0, // v1
            0.5, 5.0e-6, 0.0, // v2  (5 µm off the line → sliver)
            0.0, 0.0, 0.0, // v3
            1.0, 0.0, 0.0, // v4
            0.5, 0.5, 0.0, // v5  (real, 0.5 m tall)
        ],
        normals: vec![],
        indices: vec![0, 1, 2, 3, 4, 5],
        rtc_applied: false,
        origin: [0.0; 3],
    instance_meta: None, local_bounds: None, local_to_world: None };
    mesh.drop_thin_triangles(GRID);
    assert_eq!(mesh.indices, vec![3, 4, 5], "sliver dropped, real kept");
    // Positions/normals are never touched (orphan vertices are fine).
    assert_eq!(mesh.positions.len(), 18);
}

#[test]
fn drop_thin_removes_coincident_pair_needle() {
    // Two vertices identical → zero area regardless of the third.
    let mut mesh = Mesh {
        positions: vec![0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        normals: vec![],
        indices: vec![0, 1, 2],
        rtc_applied: false,
        origin: [0.0; 3],
    instance_meta: None, local_bounds: None, local_to_world: None };
    mesh.drop_thin_triangles(GRID);
    assert!(mesh.indices.is_empty(), "coincident-pair needle dropped");
}

#[test]
fn drop_thin_keeps_thin_but_real_triangle_just_above_grid() {
    // Height 30 µm (> 15.26 µm grid) over a 1 m base — thin but real.
    let mut mesh = Mesh {
        positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.5, 30.0e-6, 0.0],
        normals: vec![],
        indices: vec![0, 1, 2],
        rtc_applied: false,
        origin: [0.0; 3],
    instance_meta: None, local_bounds: None, local_to_world: None };
    mesh.drop_thin_triangles(GRID);
    assert_eq!(mesh.indices, vec![0, 1, 2], "above-grid triangle kept");
}

#[test]
fn drop_thin_does_not_open_a_crack_in_a_closed_solid() {
    // A closed tetrahedron with ONE extra degenerate sliver triangle glued
    // along an existing edge. Dropping the sliver must leave exactly the 4
    // real faces — i.e. it removes the sliver and nothing else, so the
    // watertight surface is unchanged (no real face is collateral-dropped).
    let a = [0.0f32, 0.0, 0.0];
    let b = [1.0f32, 0.0, 0.0];
    let c = [0.0f32, 1.0, 0.0];
    let d = [0.0f32, 0.0, 1.0];
    let mut pos = vec![];
    for v in [a, b, c, d] {
        pos.extend_from_slice(&v);
    }
    // sliver vertex on edge a→b, 5 µm off-line
    pos.extend_from_slice(&[0.5, 5.0e-6, 0.0]); // index 4
    let mut mesh = Mesh {
        positions: pos,
        normals: vec![],
        indices: vec![
            0, 1, 2, // 4 tetra faces
            0, 1, 3, 0, 2, 3, 1, 2, 3, // (winding irrelevant for this test)
            0, 1, 4, // the degenerate sliver along edge 0→1
        ],
        rtc_applied: false,
        origin: [0.0; 3],
    instance_meta: None, local_bounds: None, local_to_world: None };
    mesh.drop_thin_triangles(GRID);
    assert_eq!(
        mesh.indices,
        vec![0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3],
        "only the sliver dropped; the 4 closed faces are intact"
    );
}

#[test]
fn drop_thin_skips_oob_and_fully_collapsed_without_panic() {
    let mut mesh = Mesh {
        positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        normals: vec![],
        indices: vec![
            0, 1, 2, // valid, real
            0, 1, 9, // out-of-bounds index → skipped
            0, 0, 0, // fully collapsed (longest == 0) → skipped
        ],
        rtc_applied: false,
        origin: [0.0; 3],
    instance_meta: None, local_bounds: None, local_to_world: None };
    mesh.drop_thin_triangles(GRID);
    assert_eq!(mesh.indices, vec![0, 1, 2]);
}

// Sibling of the above for drop_degenerate_triangles: the bits() closure
// indexed positions[] unchecked before vert()'s bounds check, so an OOB index
// panicked. It must now drop the bad triangle without panicking.
#[test]
fn drop_degenerate_skips_oob_index_without_panic() {
    let mut mesh = Mesh {
        positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        normals: vec![],
        indices: vec![
            0, 1, 2, // valid
            0, 1, 9, // out-of-bounds index → would panic in bits() pre-fix
        ],
        rtc_applied: false,
        origin: [0.0; 3],
        instance_meta: None,
        local_bounds: None,
        local_to_world: None,
    };
    mesh.drop_degenerate_triangles();
    assert_eq!(mesh.indices, vec![0, 1, 2]);
}

#[test]
fn drop_thin_is_idempotent() {
    let mut mesh = Mesh {
        positions: vec![
            0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.5, 5.0e-6, 0.0, // sliver
            0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.5, 0.5, 0.0, // real
        ],
        normals: vec![],
        indices: vec![0, 1, 2, 3, 4, 5],
        rtc_applied: false,
        origin: [0.0; 3],
    instance_meta: None, local_bounds: None, local_to_world: None };
    mesh.drop_thin_triangles(GRID);
    let once = mesh.indices.clone();
    mesh.drop_thin_triangles(GRID);
    assert_eq!(mesh.indices, once, "second pass is a no-op");
}

#[test]
fn clean_degenerate_uses_the_reconcile_grid() {
    // clean_degenerate must drop a 10 µm sliver (below grid) and keep a
    // 30 µm one (above grid).
    let mut mesh = Mesh {
        positions: vec![
            0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.5, 10.0e-6, 0.0, // below grid
            0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.5, 30.0e-6, 0.0, // above grid
        ],
        normals: vec![],
        indices: vec![0, 1, 2, 3, 4, 5],
        rtc_applied: false,
        origin: [0.0; 3],
    instance_meta: None, local_bounds: None, local_to_world: None };
    mesh.clean_degenerate();
    assert_eq!(mesh.indices, vec![3, 4, 5]);
}
