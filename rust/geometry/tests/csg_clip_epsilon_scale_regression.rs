// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression: `ClippingProcessor::clip_mesh`'s vertex-vs-plane classification
//! epsilon must scale with the operand's coordinate magnitude, not stay a
//! fixed `1e-6`.
//!
//! `ClippingProcessor` (`csg/mod.rs`) classifies each triangle vertex against
//! a clip plane with `d >= -epsilon`. That plane arrives in WORLD coordinates
//! (`IfcAxis2Placement3D`, decoded in f64 — see `parse_half_space_solid` in
//! `processors/boolean/mod.rs`), while mesh vertex positions are f32-native.
//! Once a world coordinate exceeds 16 m, the f32 ULP is larger than a fixed
//! `1e-6`, so a vertex meant to sit exactly on the plane (signed distance 0,
//! e.g. a cut flush with a box face) can be quantized to the wrong side of the
//! epsilon band purely from float noise — dropping or flipping triangles that
//! should not change with translation alone. `LARGE_COORD_THRESHOLD_METERS`
//! (10 000 m, `lib.rs`) is the only re-basing trigger in the pipeline, so
//! ordinary building-scale coordinates (tens to low thousands of metres, e.g.
//! a project basepoint offset) pass through unshifted and hit this band.
//!
//! Reproduction: cut a box of half-extent 1 (side length 2, NOT a "unit box"
//! in the side-length-1 sense) with a plane placed exactly flush with its top
//! face, translated `offset` metres from the origin along all three axes. The
//! plane's point is built from the untruncated f64 offset; the mesh vertex is
//! built from `offset as f32` — the same mismatch a real IFC placement (f64)
//! vs. a real IFC mesh (f32) produces. All four top-face vertices then have a
//! signed distance of (near-)zero, so the epsilon alone decides whether they
//! classify as front or back.
//!
//! IMPORTANT: a plane flush with the top face has NO upper half to keep —
//! only a 2-triangle cap on that face. A correct clip keeps that cap (area
//! 4.0, i.e. the full 2x2 top face) and discards everything else; an earlier
//! version of this file's comment claimed the clip "keeps exactly the top
//! half of the box", which describes a *different* experiment (a plane
//! through the box's centre, see `mid_plane_clip_keeps_genuine_upper_half`
//! below) that happens to also total 14 triangles but exercises no epsilon at
//! all (its vertex distances are a clean +-1.0, nowhere near any tolerance).
//!
//! Instrumented (`cargo run --example probe -p ifc-lite-geometry`, since
//! deleted — see this file's tests, which now assert the same properties
//! directly) against the current fix at offsets 100.7 m and 50000.7 m: the 14
//! retained triangles split as exactly 2 non-degenerate cap triangles (area
//! 2.0 each, on the top face) and 12 *exactly* zero-area, zero-height
//! triangles — not merely "under epsilon tall". The reason is the edge
//! clamp in `clip_triangle_with_epsilon`: a front vertex whose true signed
//! distance is slightly negative (inside the eps band, e.g. because f32
//! quantization put it a few ULPs behind the true plane) yields a raw
//! interpolation parameter `t < 0`, which `edge_t` clamps to `0.0` — so the
//! "cut" vertex is placed exactly at the front vertex's own position, and the
//! resulting triangle has zero area and zero height by construction. This is
//! *more* degenerate than "bounded by eps", not less, which is why the
//! per-fragment-height assertion below holds with room to spare.
//!
//! Measured on `main` (fixed `epsilon = 1e-6`, `cargo test --test
//! csg_clip_epsilon_scale_regression`):
//!   offset   100.7 m -> 0 triangles (the cap is misclassified as behind and
//!                        discarded, along with everything else)
//!   offset 50000.7 m -> 0 triangles
//! while offset 1000.7 m and 5000.7 m survive (14 triangles) even on `main` —
//! the failure is non-monotonic in distance, which is why this test pins two
//! specific offsets rather than asserting "beyond distance X".
//! `offset` values are deliberately non-integer — integers below 2^24 are
//! exact in f32 and would round-trip losslessly, exposing nothing.

use ifc_lite_geometry::csg::{ClippingProcessor, Plane};
use ifc_lite_geometry::mesh::Mesh;
use nalgebra::{Point3, Vector3};

/// Axis-aligned box of half-extent 1 (side length 2), centred at `origin` (an
/// f32-quantized world position, matching how a real mesh vertex is stored).
fn unit_box(origin: [f32; 3]) -> Mesh {
    let (ox, oy, oz) = (origin[0], origin[1], origin[2]);
    let c = [
        [ox - 1.0, oy - 1.0, oz - 1.0],
        [ox + 1.0, oy - 1.0, oz - 1.0],
        [ox + 1.0, oy + 1.0, oz - 1.0],
        [ox - 1.0, oy + 1.0, oz - 1.0],
        [ox - 1.0, oy - 1.0, oz + 1.0],
        [ox + 1.0, oy - 1.0, oz + 1.0],
        [ox + 1.0, oy + 1.0, oz + 1.0],
        [ox - 1.0, oy + 1.0, oz + 1.0],
    ];
    let faces: [[usize; 3]; 12] = [
        [0, 2, 1],
        [0, 3, 2],
        [4, 5, 6],
        [4, 6, 7],
        [0, 1, 5],
        [0, 5, 4],
        [2, 3, 7],
        [2, 7, 6],
        [1, 2, 6],
        [1, 6, 5],
        [0, 4, 7],
        [0, 7, 3],
    ];
    let mut positions = Vec::new();
    let mut indices = Vec::new();
    for v in c.iter() {
        positions.extend_from_slice(v);
    }
    for f in faces.iter() {
        for &i in f.iter() {
            indices.push(i as u32);
        }
    }
    Mesh {
        positions,
        indices,
        ..Default::default()
    }
}

/// Build the box-plus-flush-plane fixture shared by [`clip_flush_top_face`]
/// and [`expected_eps`], so both use identical inputs when computing the
/// classification epsilon `clip_mesh` would derive internally.
fn build_flush_case(offset_f64: f64) -> (Mesh, Plane) {
    let offset_f32 = offset_f64 as f32;
    let mesh = unit_box([offset_f32, offset_f32, offset_f32]);
    let plane = Plane::new(
        Point3::new(offset_f64, offset_f64, offset_f64 + 1.0),
        Vector3::new(0.0, 0.0, 1.0),
    );
    (mesh, plane)
}

/// Clip a box of half-extent 1 (translated to `offset_f64` along all three
/// axes) against a plane flush with its top face, and return the resulting
/// `Mesh` so callers can inspect area, height and vertex positions rather
/// than trusting a bare triangle count. The plane point comes from the
/// untruncated f64 offset (the real-world f64-placement side); the mesh
/// vertices come from `offset_f64 as f32` (the real-world f32-mesh side) —
/// the exact mismatch `ClippingProcessor` must tolerate.
fn clip_flush_top_face(offset_f64: f64) -> Mesh {
    let (mesh, plane) = build_flush_case(offset_f64);
    let clipper = ClippingProcessor::new();
    clipper.clip_mesh(&mesh, &plane).expect("clip must not error")
}

/// Reproduce `ClippingProcessor::clip_mesh`'s internal epsilon computation
/// (`(extent * 2^-22).max(self.epsilon)`, `self.epsilon` == the default
/// `1e-6`) for the same fixture `clip_flush_top_face` clips, so assertions
/// can be stated against the real per-call epsilon instead of a duplicated
/// constant that could drift from the production formula.
fn expected_eps(offset_f64: f64) -> f64 {
    let (mesh, plane) = build_flush_case(offset_f64);
    let mut extent = 1.0f64;
    for &c in &mesh.positions {
        extent = extent.max((c as f64).abs());
    }
    extent = extent
        .max(plane.point.x.abs())
        .max(plane.point.y.abs())
        .max(plane.point.z.abs());
    (extent * (1.0 / 4_194_304.0)).max(1e-6)
}

/// Signed area of triangle `tri_idx` in `mesh` (0 for a degenerate triangle).
fn triangle_area(mesh: &Mesh, tri_idx: usize) -> f64 {
    let base = tri_idx * 3;
    let idx = [
        mesh.indices[base] as usize,
        mesh.indices[base + 1] as usize,
        mesh.indices[base + 2] as usize,
    ];
    let p: Vec<[f64; 3]> = idx
        .iter()
        .map(|&i| {
            [
                mesh.positions[i * 3] as f64,
                mesh.positions[i * 3 + 1] as f64,
                mesh.positions[i * 3 + 2] as f64,
            ]
        })
        .collect();
    let e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    let e2 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    let cross = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
    ];
    0.5 * (cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]).sqrt()
}

/// `(min_z, max_z)` across every vertex referenced by `mesh`'s triangles.
fn mesh_z_bounds(mesh: &Mesh) -> (f64, f64) {
    let mut min_z = f64::INFINITY;
    let mut max_z = f64::NEG_INFINITY;
    for &idx in &mesh.indices {
        let z = mesh.positions[idx as usize * 3 + 2] as f64;
        min_z = min_z.min(z);
        max_z = max_z.max(z);
    }
    (min_z, max_z)
}

/// Pin what a correct flush-top-face clip must produce: the top face's 2
/// triangles present, non-degenerate, and reconstructing the full 2x2 face
/// (area 4.0) — and no retained fragment (cap or otherwise) taller than the
/// classification epsilon `eps`. This replaces a bare `assert_eq!(tris, 14)`,
/// which a collapsed cap plus 12 zero-area slivers also satisfies (see the
/// module doc): it pins the cap's shape and the fragment-height bound, which
/// a count alone cannot distinguish from "everything is garbage that happens
/// to add up to 14".
fn assert_flush_cap(mesh: &Mesh, eps: f64, case_name: &str) {
    let tris = mesh.indices.len() / 3;
    assert!(
        tris > 0,
        "{case_name}: clip retained no triangles at all — the flush cap was \
         misclassified as behind the plane and discarded"
    );

    let mut nondegenerate = 0usize;
    let mut nondegenerate_area_sum = 0.0f64;
    for t in 0..tris {
        let area = triangle_area(mesh, t);
        if area > 1e-9 {
            nondegenerate += 1;
            nondegenerate_area_sum += area;
        }
    }
    assert_eq!(
        nondegenerate, 2,
        "{case_name}: expected exactly 2 non-degenerate (area > 1e-9) cap \
         triangles on the top face, found {nondegenerate} among {tris} total \
         triangles — a correct clip keeps the flush cap and nothing thicker \
         than a float-noise sliver"
    );
    assert!(
        (nondegenerate_area_sum - 4.0).abs() < 1e-3,
        "{case_name}: the 2 non-degenerate triangles must reconstruct the \
         full 2x2 top face (area 4.0); got total area {nondegenerate_area_sum}"
    );

    let (min_z, max_z) = mesh_z_bounds(mesh);
    let height = max_z - min_z;
    assert!(
        height <= eps,
        "{case_name}: retained mesh spans {height:e} in z, which exceeds the \
         classification epsilon {eps:e} — a flush-plane clip must not retain \
         any fragment taller than the band that decided its classification"
    );
}

#[test]
fn flush_plane_clip_survives_at_100m() {
    // Pre-fix (fixed 1e-6 epsilon): 0 triangles — the flush cap itself is
    // misclassified as behind the plane and discarded, along with the
    // (already-degenerate) side slivers.
    let offset = 100.7;
    let mesh = clip_flush_top_face(offset);
    let eps = expected_eps(offset);
    assert_flush_cap(&mesh, eps, "100.7 m flush cut");
}

#[test]
fn flush_plane_clip_survives_at_50km() {
    // Pre-fix (fixed 1e-6 epsilon): 0 triangles. Distinct failure mode from
    // the 100.7 m case (non-monotonic: 1000.7 m and 5000.7 m pass even on
    // main) — both offsets are pinned so a partial fix can't slip through.
    let offset = 50000.7;
    let mesh = clip_flush_top_face(offset);
    let eps = expected_eps(offset);
    assert_flush_cap(&mesh, eps, "50000.7 m flush cut");
}

#[test]
fn flush_plane_clip_correct_near_origin() {
    // Sanity: the near-origin case already worked on main (f32 ULP is well
    // under 1e-6 there) and must keep working post-fix.
    let offset = 0.7;
    let mesh = clip_flush_top_face(offset);
    let eps = expected_eps(offset);
    assert_flush_cap(&mesh, eps, "0.7 m flush cut (near-origin sanity)");
}

/// Clip the same half-extent-1 box against a plane through its CENTRE
/// (`offset_f64`, not `offset_f64 + 1.0`) instead of flush with its top
/// face.
fn clip_mid_plane(offset_f64: f64) -> Mesh {
    let offset_f32 = offset_f64 as f32;
    let mesh = unit_box([offset_f32, offset_f32, offset_f32]);
    let plane = Plane::new(Point3::new(offset_f64, offset_f64, offset_f64), Vector3::new(0.0, 0.0, 1.0));
    let clipper = ClippingProcessor::new();
    clipper.clip_mesh(&mesh, &plane).expect("clip must not error")
}

#[test]
fn mid_plane_clip_keeps_genuine_upper_half() {
    // Companion to the flush-cap tests above, added because the module doc
    // used to (incorrectly) describe the flush case as "keeping the top
    // half of the box". This test gives that description something real to
    // attach to: a plane through the box's CENTRE has a genuine upper half
    // of height 1.0. Its vertex distances are a clean +-1.0, nowhere near
    // any epsilon this file's other tests exercise, so it is not a
    // magnitude-scaling regression test — it exists only so "upper half of
    // the box" is asserted somewhere instead of merely claimed in a comment.
    let offset = 100.7;
    let mesh = clip_mid_plane(offset);
    let (min_z, max_z) = mesh_z_bounds(&mesh);
    let height = max_z - min_z;
    assert!(
        (height - 1.0).abs() < 1e-3,
        "a plane through the box centre must retain a genuine upper half of \
         height 1.0; got {height}"
    );
    assert!(
        !mesh.indices.is_empty(),
        "a plane through the box centre must retain a non-empty upper half"
    );
}

#[test]
fn clip_mesh_epsilon_at_building_extent_is_unscaled() {
    // Pin the effective classification epsilon at an ordinary building extent
    // (28.76 m, from the corpus) by constructing a triangle that a correct
    // `1e-6`-floored epsilon and a buggy `near_band_from_extent`-floored
    // epsilon (8*SNAP_GRID ~= 1.22e-4) disagree on.
    //
    // `near_band_from_extent` is sized for the exact CSG kernel's snap grid,
    // not this clip-plane test, and its scaling term only exceeds that floor
    // past ~512 m — so at 28.76 m it would silently replace `1e-6` with a
    // flat 122x-looser epsilon. A triangle sitting genuinely `5e-5` behind
    // the plane is far enough to be classified "behind" under the correct
    // `1e-6` floor (extent*2^-22 ~= 6.86e-6 here, still < 5e-5) but would be
    // misclassified "front" under the buggy 1.22e-4 floor (5e-5 < 1.22e-4) —
    // discriminating the two without depending on the flush-cut case, where
    // either floor happens to give the right answer.
    let offset = 28.76_f64;
    let behind_z = (offset - 5e-5) as f32;
    let mesh = Mesh {
        positions: vec![0.0, 0.0, behind_z, 1.0, 0.0, behind_z, 0.0, 1.0, behind_z],
        indices: vec![0, 1, 2],
        ..Default::default()
    };
    let plane = Plane::new(Point3::new(0.0, 0.0, offset), Vector3::new(0.0, 0.0, 1.0));

    let extent = offset; // matches ClippingProcessor::mesh_plane_extent (plane point z)
    let scaled = extent * (1.0 / 4_194_304.0);
    assert!(
        scaled < 5e-5 && scaled >= 1e-6,
        "test fixture must sit between the 1e-6 floor and the 5e-5 offset to \
         discriminate; got scaled term {scaled}"
    );

    let clipper = ClippingProcessor::new();
    let out = clipper.clip_mesh(&mesh, &plane).expect("clip must not error");
    assert_eq!(
        out.indices.len(),
        0,
        "a triangle genuinely 5e-5 behind the plane at 28.76 m extent must be \
         discarded under the 1e-6-floored epsilon; a non-zero result means the \
         epsilon regressed to the ~1.22e-4 near_band_from_extent floor"
    );
}
