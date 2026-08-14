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
//! Reproduction: cut a unit box with a plane placed exactly on its top face,
//! translated `offset` metres from the origin along all three axes. The
//! plane's point is built from the untruncated f64 offset; the mesh vertex is
//! built from `offset as f32` — the same mismatch a real IFC placement (f64)
//! vs. a real IFC mesh (f32) produces. All four top-face vertices then have a
//! signed distance of (near-)zero, so the epsilon alone decides whether they
//! classify as front or back. A correct clip always keeps exactly the top
//! half of the box: 14 triangles (12 side/bottom-half + 2 cap), height 1.0.
//! `offset` values are deliberately non-integer — integers below 2^24 are
//! exact in f32 and would round-trip losslessly, exposing nothing.
//!
//! Measured on `main` (fixed `epsilon = 1e-6`, `cargo test --test
//! csg_clip_epsilon_scale_regression`):
//!   offset   100.7 m -> 0 triangles (whole top half vanishes)
//!   offset 50000.7 m -> 0 triangles
//! while offset 1000.7 m and 5000.7 m survive (14 triangles) — the failure is
//! non-monotonic in distance, which is why this test pins two specific
//! offsets rather than asserting "beyond distance X".

use ifc_lite_geometry::csg::{ClippingProcessor, Plane};
use ifc_lite_geometry::mesh::Mesh;
use nalgebra::{Point3, Vector3};

/// Axis-aligned unit-half-extent box, centred at `origin` (an f32-quantized
/// world position, matching how a real mesh vertex is stored).
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

/// Clip a unit box (translated to `offset_f64` along all three axes) against
/// a plane flush with its top face, and return the resulting triangle count.
/// The plane point comes from the untruncated f64 offset (the real-world
/// f64-placement side); the mesh vertices come from `offset_f64 as f32` (the
/// real-world f32-mesh side) — the exact mismatch `ClippingProcessor` must
/// tolerate.
fn clip_flush_top_face(offset_f64: f64) -> usize {
    let offset_f32 = offset_f64 as f32;
    let mesh = unit_box([offset_f32, offset_f32, offset_f32]);
    let plane = Plane::new(
        Point3::new(offset_f64, offset_f64, offset_f64 + 1.0),
        Vector3::new(0.0, 0.0, 1.0),
    );
    let clipper = ClippingProcessor::new();
    let out = clipper.clip_mesh(&mesh, &plane).expect("clip must not error");
    out.indices.len() / 3
}

#[test]
fn flush_plane_clip_survives_at_100m() {
    // Pre-fix (fixed 1e-6 epsilon): 0 triangles — the whole top half of the
    // box was misclassified as behind the plane and discarded.
    let tris = clip_flush_top_face(100.7);
    assert_eq!(
        tris, 14,
        "flush top-face cut at 100.7 m offset must keep the upper half of the \
         box (14 tris); got {tris} — the classification epsilon is not \
         tolerating f32 quantization at this coordinate magnitude"
    );
}

#[test]
fn flush_plane_clip_survives_at_50km() {
    // Pre-fix (fixed 1e-6 epsilon): 0 triangles. Distinct failure mode from
    // the 100.7 m case (non-monotonic: 1000.7 m and 5000.7 m pass even on
    // main) — both offsets are pinned so a partial fix can't slip through.
    let tris = clip_flush_top_face(50000.7);
    assert_eq!(
        tris, 14,
        "flush top-face cut at 50000.7 m offset must keep the upper half of \
         the box (14 tris); got {tris}"
    );
}

#[test]
fn flush_plane_clip_correct_near_origin() {
    // Sanity: the near-origin case already worked on main (f32 ULP is well
    // under 1e-6 there) and must keep working post-fix.
    let tris = clip_flush_top_face(0.7);
    assert_eq!(tris, 14, "flush top-face cut near the origin must keep 14 tris; got {tris}");
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
