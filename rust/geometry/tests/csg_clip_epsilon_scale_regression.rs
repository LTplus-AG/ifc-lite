// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression: `ClippingProcessor::clip_mesh`'s vertex-vs-plane classification
//! epsilon must scale with the operand's coordinate magnitude, not stay a
//! fixed `1e-6` — and must derive that magnitude PER AXIS, projected onto the
//! plane's own normal, not as a single max over all three axes.
//!
//! Two distinct properties, two distinct groups of tests:
//!
//! 1. MAGNITUDE SCALING — `flush_plane_clip_*`. These offset the box
//!    uniformly along all three axes, so a max-over-axes extent and a
//!    projection onto the normal produce the same number. That makes them
//!    blind to property 2 by construction; they are kept because they pin the
//!    original defect (a fixed `1e-6` at large coordinates) which is a real
//!    and separate regression.
//! 2. AXIS SELECTION — `perpendicular_offset_must_not_inflate_the_normal_axis_tolerance`
//!    and `offset_axis_tolerance_still_scales_when_the_normal_points_along_it`.
//!    These deliberately make the offset axis DIFFER from the tested normal,
//!    which is the only way to distinguish the two formulas. The pair asserts
//!    the tolerance in BOTH directions — that an orthogonal axis must not
//!    widen it, and that the normal's own axis still must — so neither a
//!    uniformly-looser nor a uniformly-tighter epsilon passes.
//!
//! 3. SIGN INVARIANCE and the UPPER BOUND —
//!    `negated_plane_normal_must_get_the_same_tolerance` and
//!    `a_four_times_looser_ulp_scale_must_not_weld_separate_geometry`. Groups
//!    1 and 2 all use all-positive normals and all fail only when the epsilon
//!    is too TIGHT, so between them they leave the projection's `.abs()` and
//!    the size of `F32_ULP_SCALE` unpinned in the loosening direction. Each
//!    test carries its own measured mutation evidence.
//!
//! `ClippingProcessor` (`csg/mod.rs`) classifies each triangle vertex against
//! a clip plane with `d >= -epsilon`. WHICH FRAME the operands arrive in
//! depends on the caller, and the two production callers differ:
//!
//! - `processors/boolean/mod.rs` (`IfcHalfSpaceSolid` /
//!   `IfcPolygonalBoundedHalfSpace`) clips inside `BooleanProcessor::process`,
//!   dispatched at `router/processing.rs:818`, before `scale_mesh` (:846) and
//!   before `apply_placement`. Plane and mesh are both in the representation
//!   item's LOCAL, pre-scale, file-unit coordinates — the plane f64 out of
//!   `IfcAxis2Placement3D` (`parse_half_space_solid`), the vertices f32-native
//!   in that same frame. This is the frame every fixture below models.
//! - `router/layers.rs:569-570` (layered-material band splitting) clips a
//!   mesh that came back from `process_element_with_voids` → `process_element`
//!   and has therefore ALREADY been unit-scaled and placed, against interface
//!   planes built in metres. Not a pre-scale frame at all — the f32/f64 split
//!   and the ULP argument are identical, but the numbers are metres.
//!
//! Once a coordinate exceeds 16 m, the f32 ULP is larger than a fixed
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

/// Reproduce `csg::plane_eps::PlaneEps`'s computation for an arbitrary
/// mesh/plane pair, so assertions can be stated against the real per-call
/// epsilon instead of a duplicated constant that could drift from the
/// production formula.
///
/// Mirrors the production shape exactly: per-axis f32 rounding-noise
/// amplitudes over the MESH VERTICES ONLY — the plane point is f64 end to end
/// and contributes no rounding noise, see
/// [`plane_representative_point_must_not_change_the_clip`] — projected onto
/// the plane's own unit normal, floored at the default `self.epsilon` of
/// `1e-6`. Note the per-axis tracking — collapsing this to a single max over
/// all three axes is precisely the defect
/// [`perpendicular_offset_must_not_inflate_the_normal_axis_tolerance`] exists
/// to catch.
fn eps_for(mesh: &Mesh, plane: &Plane) -> f64 {
    let mut axis_noise = [0.0f64; 3];
    for (i, &c) in mesh.positions.iter().enumerate() {
        let a = (c as f64).abs();
        if a > axis_noise[i % 3] {
            axis_noise[i % 3] = a;
        }
    }
    for noise in axis_noise.iter_mut() {
        *noise *= 1.0 / 4_194_304.0;
    }
    let n = plane.normal;
    let projected =
        n.x.abs() * axis_noise[0] + n.y.abs() * axis_noise[1] + n.z.abs() * axis_noise[2];
    projected.max(1e-6)
}

/// [`eps_for`] applied to the fixture `clip_flush_top_face` clips.
fn expected_eps(offset_f64: f64) -> f64 {
    let (mesh, plane) = build_flush_case(offset_f64);
    eps_for(&mesh, &plane)
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

    // The z extent the mesh contributes (the plane point is f64 and never
    // sizes the epsilon), projected onto the +z normal.
    let extent = f64::from(behind_z);
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

/// A rectangular slab spanning `x0..x1` at a constant `z`, as f32 vertices.
/// Two triangles, so a "kept" verdict is 6 indices and a "discarded" one is 0.
fn slab_at_z(x0: f32, x1: f32, z: f32) -> Mesh {
    Mesh {
        positions: vec![
            x0, 0.0, z, x1, 0.0, z, x1, 1000.0, z, //
            x0, 0.0, z, x1, 1000.0, z, x0, 1000.0, z,
        ],
        indices: vec![0, 1, 2, 3, 4, 5],
        ..Default::default()
    }
}

/// The max-over-all-axes epsilon this file's fix replaced, reproduced so the
/// discriminating tests can assert their fixtures actually separate the two
/// formulas instead of assuming it.
fn pre_fix_max_over_axes_eps(mesh: &Mesh, plane: &Plane) -> f64 {
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

#[test]
fn perpendicular_offset_must_not_inflate_the_normal_axis_tolerance() {
    // THE axis-selection regression. The flush-cap fixtures above offset the
    // box uniformly along all three axes, so a max-over-all-axes extent and a
    // projection onto the plane normal produce the SAME number and those tests
    // cannot tell a correct implementation from the broken one. Here the
    // offset axis (x) is deliberately DIFFERENT from the tested normal (z).
    //
    // Millimetre-unit model (the common IFC case): a site-offset building at
    // x ~= 1e6 mm (1 km from the local origin) with a wall spanning
    // z = 0..3000 mm, clipped by a HORIZONTAL plane (normal +z) at z = 3000.
    //
    //   pre-fix  eps = max|coord over ALL axes| * 2^-22
    //                = 1.005e6 * 2^-22  ~= 2.396e-1 mm
    //   post-fix eps = |n_z| * max|z| * 2^-22
    //                = 3000 * 2^-22     ~= 7.153e-4 mm
    //
    // a ~335x difference, driven entirely by an x offset that contributes
    // NOTHING to `dot(v - p, n)` for a +z normal. The real f32 rounding step
    // at z = 3000 is 2^-12 ~= 2.44e-4 mm, so the post-fix value is a ~3x safe
    // over-estimate of the actual noise while the pre-fix value is ~1000x it.
    //
    // The slab sits a GENUINE 0.05 mm below the plane — comfortably above the
    // post-fix tolerance (so it must be classified behind and discarded) and
    // comfortably below the pre-fix one (so the pre-fix code keeps it). 0.05 mm
    // also survives f32 quantization at z = 3000 with ~200x margin, so the
    // separation under test is real geometry, not float noise.
    let x0 = 1.0e6_f32;
    let x1 = 1.0e6_f32 + 5000.0;
    let plane_z = 3000.0_f64;
    let separation = 0.05_f64;
    let mesh = slab_at_z(x0, x1, (plane_z - separation) as f32);
    let plane = Plane::new(Point3::new(1.0e6, 0.0, plane_z), Vector3::new(0.0, 0.0, 1.0));

    // Guard the fixture itself: it only discriminates while the post-fix
    // epsilon is below the separation and the pre-fix one is above it. If a
    // future tolerance change moves either side past 0.05 mm this assertion
    // fires instead of the test silently going vacuous again.
    let post_fix_eps = eps_for(&mesh, &plane);
    let pre_fix_eps = pre_fix_max_over_axes_eps(&mesh, &plane);
    assert!(
        post_fix_eps < separation,
        "fixture is vacuous: the projected epsilon {post_fix_eps:e} must be \
         tighter than the {separation} mm separation, or a correct \
         implementation would also keep the slab"
    );
    assert!(
        pre_fix_eps > separation,
        "fixture is vacuous: the max-over-axes epsilon {pre_fix_eps:e} must be \
         looser than the {separation} mm separation, or the pre-fix \
         implementation would also discard the slab and this test could not \
         detect the regression"
    );

    let out = ClippingProcessor::new()
        .clip_mesh(&mesh, &plane)
        .expect("clip must not error");
    assert_eq!(
        out.indices.len(),
        0,
        "a slab sitting a genuine {separation} mm behind a horizontal plane \
         must be discarded: the classification tolerance for a +z normal is \
         set by the z extent ({post_fix_eps:e}), not by the model's 1 km x \
         offset. A non-empty result means the epsilon regressed to a \
         max-over-all-axes extent ({pre_fix_eps:e}), letting an axis \
         orthogonal to the plane normal inflate the tolerance ~335x"
    );
}

#[test]
fn offset_axis_tolerance_still_scales_when_the_normal_points_along_it() {
    // Direction check, the counterpart to the test above: projection must not
    // be mistaken for "always take the smallest axis". Same 1 km x offset, but
    // now the plane's normal points along +x — so the x extent IS the relevant
    // one and the tolerance must widen to it, exactly as the pre-fix code did.
    //
    //   eps = |n_x| * 1e6 * 2^-22 ~= 2.384e-1 mm
    //
    // A slab a fraction of a millimetre behind an +x plane is therefore INSIDE
    // the band and must be kept — the opposite verdict to the perpendicular
    // case, from the same offset. Tightening the tolerance uniformly (a bare
    // per-axis min, or dropping the scaling altogether) fails here even though
    // it passes the test above.
    //
    // NOTE the separation is measured, not nominal: `(1.0e6 - 0.05) as f32`
    // quantizes to 999999.9375 (the f32 ULP at 1e6 is 0.0625: 1e6 lies in
    // [2^19, 2^20), so the step is 2^19 * 2^-23 = 2^-4), so the geometry
    // actually under test is 0.0625 mm behind the plane, not 0.05. Still an
    // order of magnitude under the 0.238 mm epsilon, so the verdict stands.
    let plane_x = 1.0e6_f64;
    let behind_x = (plane_x - 0.05) as f32;
    let separation = plane_x - f64::from(behind_x);
    let mesh = Mesh {
        positions: vec![
            behind_x, 0.0, 0.0, behind_x, 1000.0, 0.0, behind_x, 0.0, 3000.0,
        ],
        indices: vec![0, 1, 2],
        ..Default::default()
    };
    let plane = Plane::new(Point3::new(plane_x, 0.0, 0.0), Vector3::new(1.0, 0.0, 0.0));

    let eps = eps_for(&mesh, &plane);
    assert!(
        eps > separation,
        "fixture is vacuous: with the normal along the offset axis the \
         projected epsilon {eps:e} must exceed the {separation} mm separation, \
         or this test asserts nothing about direction"
    );

    let out = ClippingProcessor::new()
        .clip_mesh(&mesh, &plane)
        .expect("clip must not error");
    assert!(
        !out.indices.is_empty(),
        "with the plane normal along the 1 km-offset x axis the tolerance \
         ({eps:e}) must widen to that axis's f32 noise and keep a triangle \
         only {separation} mm behind the plane; an empty result means the \
         projection collapsed the tolerance on the axis that actually matters"
    );
}

/// The bare projected term, WITHOUT the `1e-6` floor — the thing
/// [`floor_keeps_a_vertex_the_bare_projected_term_would_drop`] proves is
/// load-bearing.
fn unfloored_projected_eps(mesh: &Mesh, plane: &Plane) -> f64 {
    let mut axis_noise = [0.0f64; 3];
    for (i, &c) in mesh.positions.iter().enumerate() {
        let a = (c as f64).abs();
        if a > axis_noise[i % 3] {
            axis_noise[i % 3] = a;
        }
    }
    let n = plane.normal;
    (n.x.abs() * axis_noise[0] + n.y.abs() * axis_noise[1] + n.z.abs() * axis_noise[2])
        * (1.0 / 4_194_304.0)
}

#[test]
fn plane_representative_point_must_not_change_the_clip() {
    // `Plane::point` is an ARBITRARY representative of the plane, not a
    // property of it — and it is f64 end to end (`IfcAxis2Placement3D`, never
    // round-tripped through f32), so it carries no rounding noise the
    // classification epsilon needs to absorb. Only `Mesh::positions` is
    // f32-native, and only its magnitude may size the tolerance.
    //
    // Both planes below have the same unit normal (0.6, 0, 0.8) and both
    // representative points lie EXACTLY on the plane through the origin:
    // 0.6*8000 + 0.8*(-6000) = 0. They are therefore the same half-space and
    // must produce the same verdict on the same mesh.
    //
    // Folding max|p_i| into the per-axis noise breaks that:
    //   near point (0, 0, 0)        -> eps = 1.0e-6 (the floor)
    //   far  point (8000, 0, -6000) -> eps = (0.6*8000 + 0.8*6000) * 2^-22
    //                                     = 9600 * 2^-22 = 2.289e-3, 2288x
    // which is the exact failure mode this file exists to catch — an
    // irrelevant magnitude inflating the tolerance — reintroduced through the
    // plane point instead of through an orthogonal mesh axis. Reachable in
    // production: `subtract_half_space` (`processors/boolean/mod.rs`) builds
    // the plane from the half-space placement's Location, which is under no
    // obligation to sit anywhere near the mesh it cuts.
    //
    // The triangle sits a genuine 1e-4 BEHIND the plane: outside the correct
    // 1e-6 band (so a correct clip discards it for either representative) and
    // inside the inflated 2.289e-3 one (so the plane-point variant keeps it
    // for the far representative only).
    let n = Vector3::new(0.6_f64, 0.0, 0.8);
    let separation = 1.0e-4_f64;
    // Two in-plane directions for n: u = (0,1,0) and w = (0.8,0,-0.6).
    let v = |a: f64, b: f64| -> [f32; 3] {
        [
            (0.8 * b - separation * n.x) as f32,
            (a - separation * n.y) as f32,
            (-0.6 * b - separation * n.z) as f32,
        ]
    };
    let (p0, p1, p2) = (v(0.0, 0.0), v(3.0, 0.0), v(0.0, 3.0));
    let mesh = Mesh {
        positions: vec![
            p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2],
        ],
        indices: vec![0, 1, 2],
        ..Default::default()
    };

    let near = Plane::new(Point3::new(0.0, 0.0, 0.0), n);
    let far = Plane::new(Point3::new(8000.0, 0.0, -6000.0), n);

    // Both representatives really do describe the same plane.
    for (name, plane) in [("near", &near), ("far", &far)] {
        let d = plane.signed_distance(&Point3::new(0.0, 0.0, 0.0));
        assert!(
            d.abs() < 1e-9,
            "fixture error: the {name} representative is not on the plane \
             through the origin (signed distance {d:e})"
        );
    }

    // Guard the fixture: it only discriminates while the correct epsilon is
    // tighter than the separation and the plane-point-inflated one is looser.
    let correct_eps = eps_for(&mesh, &near);
    assert!(
        correct_eps < separation,
        "fixture is vacuous: the correct epsilon {correct_eps:e} must be \
         tighter than the {separation:e} separation"
    );
    let inflated_eps = 9600.0 * (1.0 / 4_194_304.0);
    assert!(
        inflated_eps > separation,
        "fixture is vacuous: the plane-point-inflated epsilon {inflated_eps:e} \
         must be looser than the {separation:e} separation, or this test \
         cannot detect the regression"
    );

    let clipper = ClippingProcessor::new();
    let out_near = clipper.clip_mesh(&mesh, &near).expect("clip must not error");
    let out_far = clipper.clip_mesh(&mesh, &far).expect("clip must not error");

    assert_eq!(
        out_near.indices.len(),
        0,
        "sanity: a triangle a genuine {separation:e} behind the plane must be \
         discarded (eps {correct_eps:e})"
    );
    assert_eq!(
        out_far.indices.len(),
        out_near.indices.len(),
        "the SAME plane, described by a representative point further out along \
         an axis, produced a different clip — the classification epsilon is \
         being sized by `Plane::point`, an arbitrary f64 representative that \
         carries no f32 rounding noise. Only `Mesh::positions` may size it"
    );
}

#[test]
fn floor_keeps_a_vertex_the_bare_projected_term_would_drop() {
    // The `1e-6` floor is the anti-regression guard for the ORIGINAL
    // behaviour: scaling may only ever widen the tolerance, never narrow it.
    // Below the crossover (a projected noise amplitude of ~4.19 file units)
    // the projected term really is TIGHTER than the constant it replaces, so
    // dropping the floor would misclassify near-origin vertices that classify
    // correctly today — a fresh regression traded for the far-field fix.
    //
    // Near-origin fixture, +z plane at z = f32(1.7):
    //   projected (no floor) = 1.7 * 2^-22       ~= 4.053e-7
    //   floored              = max(1e-6, 4.05e-7) = 1.000e-6
    // A triangle a genuine 7.153e-7 behind the plane sits BETWEEN them: kept
    // under the floored epsilon, dropped under the bare projected term.
    let plane_z = f64::from(1.7_f32);
    let behind_z = 1.7_f32 - 7.0e-7_f32;
    let separation = plane_z - f64::from(behind_z);
    let mesh = Mesh {
        positions: vec![0.0, 0.0, behind_z, 1.0, 0.0, behind_z, 0.0, 1.0, behind_z],
        indices: vec![0, 1, 2],
        ..Default::default()
    };
    let plane = Plane::new(Point3::new(0.0, 0.0, plane_z), Vector3::new(0.0, 0.0, 1.0));

    // Guard the fixture: the separation must straddle the two candidates, or
    // the test proves nothing about the floor.
    let projected = unfloored_projected_eps(&mesh, &plane);
    let floored = eps_for(&mesh, &plane);
    assert!(
        projected < separation && separation < floored,
        "fixture is vacuous: the {separation:e} separation must sit strictly \
         between the unfloored projected epsilon {projected:e} and the floored \
         one {floored:e}"
    );
    assert!(
        (floored - 1e-6).abs() < 1e-18,
        "fixture is vacuous: at this magnitude the floor must be what wins; \
         got {floored:e}"
    );

    let out = ClippingProcessor::new()
        .clip_mesh(&mesh, &plane)
        .expect("clip must not error");
    assert_eq!(
        out.indices.len(),
        3,
        "a triangle only {separation:e} behind the plane must be kept: below \
         the crossover the projected term ({projected:e}) is TIGHTER than the \
         `1e-6` it replaces, and the floor is what stops magnitude scaling from \
         narrowing the tolerance. An empty result means the floor was removed \
         and near-origin classification regressed"
    );
}

#[test]
fn body_diagonal_normal_widens_to_the_l1_sum_not_the_per_axis_max() {
    // The projection is an L1 sum, `sum_i |n_i| * noise_i`, not a max over the
    // axes `n` touches. For a unit normal that sum is bounded by
    // `sqrt(3) * max_i noise_i`, with equality for a body-diagonal normal on
    // an axis-symmetric mesh — so this form is up to sqrt(3) LOOSER than the
    // max-over-axes scalar it replaced, not uniformly tighter. That is
    // correct, not a defect: it is the right worst-case bound when all three
    // axes' f32 rounding errors align, which a body-diagonal normal is exactly
    // the case for. Any prose claiming the projection is "never looser" than
    // max-over-axes is wrong, and no other test in this file exercises a
    // non-axis-aligned normal.
    //
    // Three exactly-f32-representable vertices with x + y + z = 1e5, hence
    // exactly coplanar with respect to n = (1,1,1)/sqrt(3):
    //   per-axis max = 1e5 * 2^-22           ~= 2.384e-2
    //   L1 projected = sqrt(3) * 1e5 * 2^-22 ~= 4.130e-2
    // The plane is placed so all three vertices sit a genuine 3.0e-2 behind
    // it — between the two — so the L1 form keeps the triangle while any
    // per-axis-max form discards it.
    let m = 1.0e5_f32;
    let mesh = Mesh {
        positions: vec![m, 0.0, 0.0, 0.0, m, 0.0, 0.0, 0.0, m],
        indices: vec![0, 1, 2],
        ..Default::default()
    };
    let n = Vector3::new(1.0_f64, 1.0, 1.0).normalize();
    let separation = 3.0e-2_f64;
    // `n` is unit, so `origin + n * t` has plane-coordinate exactly `t`.
    let vertex_coord = f64::from(m) * n.x;
    let plane_point = Point3::from(n * (vertex_coord + separation));
    let plane = Plane::new(plane_point, n);

    for i in 0..3 {
        let v = Point3::new(
            f64::from(mesh.positions[i * 3]),
            f64::from(mesh.positions[i * 3 + 1]),
            f64::from(mesh.positions[i * 3 + 2]),
        );
        let d = plane.signed_distance(&v);
        assert!(
            (d + separation).abs() < 1e-9,
            "fixture error: vertex {i} is at signed distance {d:e}, expected \
             -{separation:e}"
        );
    }

    let l1 = unfloored_projected_eps(&mesh, &plane);
    let per_axis_max = f64::from(m) * (1.0 / 4_194_304.0);
    assert!(
        (l1 / per_axis_max - 3.0_f64.sqrt()).abs() < 1e-9,
        "fixture error: a body-diagonal normal on an axis-symmetric mesh must \
         make the L1 projection exactly sqrt(3) times the per-axis max; got \
         {l1:e} vs {per_axis_max:e}"
    );
    assert!(
        per_axis_max < separation && separation < l1,
        "fixture is vacuous: the {separation:e} separation must sit strictly \
         between the per-axis max {per_axis_max:e} and the L1 sum {l1:e}"
    );

    let out = ClippingProcessor::new()
        .clip_mesh(&mesh, &plane)
        .expect("clip must not error");
    assert_eq!(
        out.indices.len(),
        3,
        "with a body-diagonal normal all three axes' f32 rounding errors can \
         align, so the tolerance must be the L1 sum {l1:e} — sqrt(3) times the \
         per-axis max {per_axis_max:e} — and a triangle {separation:e} behind \
         the plane stays inside the band. An empty result means the projection \
         degenerated into a max over axes"
    );
}

#[test]
fn negated_plane_normal_must_get_the_same_tolerance() {
    // SIGN INVARIANCE, at the `clip_mesh` level. `eps(n)` bounds the f32
    // rounding noise in `|dot(v - p, n)|` — an absolute magnitude. Negating
    // `n` negates every signed distance but changes no vertex's rounding
    // error, so the band must be exactly as wide for `-n` as for `+n`.
    //
    // Without the per-component `.abs()` in `PlaneEps::for_normal` the
    // weighted sum goes NEGATIVE for any normal with a negative component and
    // `.max(floor)` collapses it to the bare `1e-6` — reintroducing the very
    // defect this file exists to pin, for roughly half of all clip directions.
    // Every other test here uses an all-positive normal, so all of them pass
    // with the `.abs()` removed.
    //
    // Both production `clip_mesh` callers negate:
    //   - `router/layers.rs` clips ONE remainder with `+n` (rest, above the
    //     material interface) and `-n` (band, below it) and welds the two
    //     results edge-for-edge. That is only sound while the two tolerances
    //     match; a difference leaves a gap or an overlap at every interface.
    //   - `processors/boolean/mod.rs` negates the half-space normal whenever
    //     the `IfcHalfSpaceSolid`'s `AgreementFlag` is `.F.`.
    //
    // Mirror-image fixture at a 50 km coordinate, so the projected term (not
    // the floor) decides:
    //   eps = 5e4 * 2^-22 ~= 1.192e-2
    // and each triangle sits a genuine 2 f32-ULPs (7.8125e-3) BEHIND its own
    // plane — inside that band, so both must be KEPT. Under the mutation the
    // `-z` case's epsilon drops to 1e-6 and its triangle is discarded while
    // the `+z` case still keeps three indices: a direction-dependent verdict
    // on geometrically mirror-image inputs.
    let plane_z = 5.0e4_f64;
    // 2 * ULP(5e4). 5e4 is in [2^15, 2^16), so ULP = 2^15 * 2^-23 = 2^-8.
    let sep = 2.0 * f64::exp2(-8.0);

    let triangle_at_z = |z: f32| Mesh {
        positions: vec![0.0, 0.0, z, 1000.0, 0.0, z, 0.0, 1000.0, z],
        indices: vec![0, 1, 2],
        ..Default::default()
    };

    let mut verdicts = Vec::new();
    for sign in [1.0_f64, -1.0] {
        // Behind a plane with normal `sign * z` means displaced by `-sign * sep`.
        let z = (plane_z - sign * sep) as f32;
        let mesh = triangle_at_z(z);
        let plane = Plane::new(Point3::new(0.0, 0.0, plane_z), Vector3::new(0.0, 0.0, sign));

        // The fixture is only a mirror image if f32 quantization did not eat
        // the offset asymmetrically. Measure, do not assume.
        let measured = -plane.signed_distance(&Point3::new(0.0, 0.0, f64::from(z)));
        assert!(
            (measured - sep).abs() < 1e-12,
            "fixture error: with normal sign {sign} the triangle sits \
             {measured:e} behind the plane, expected exactly {sep:e} — f32 \
             quantization broke the mirror symmetry and the two halves are no \
             longer comparable"
        );

        let eps = eps_for(&mesh, &plane);
        assert!(
            eps > sep && eps > 1e-6,
            "fixture is vacuous: the projected epsilon {eps:e} must exceed both \
             the {sep:e} separation (so a correct clip KEEPS the triangle) and \
             the 1e-6 floor (so the floor is not what is being measured)"
        );

        let out = ClippingProcessor::new()
            .clip_mesh(&mesh, &plane)
            .expect("clip must not error");
        verdicts.push(out.indices.len());
    }

    assert_eq!(
        verdicts[0], verdicts[1],
        "mirror-image inputs produced different clips: normal +z kept {} \
         indices, normal -z kept {}. The classification epsilon is \
         direction-DEPENDENT, which means the per-component `.abs()` in the \
         projection was dropped and the weighted sum went negative for the -z \
         normal, collapsing eps to the 1e-6 floor. `router/layers.rs` clips \
         the same remainder with `+n` and `-n` and welds the halves, so this \
         opens a gap or an overlap at every material interface",
        verdicts[0], verdicts[1]
    );
    assert_eq!(
        verdicts[0], 3,
        "sanity: at a 50 km coordinate a triangle only {sep:e} behind the \
         plane is inside the scaled band and must be kept whole"
    );
}

#[test]
fn a_four_times_looser_ulp_scale_must_not_weld_separate_geometry() {
    // UPPER BOUND on the epsilon. Every other test here fails when the
    // tolerance is too TIGHT; none of them fails when it is too LOOSE by less
    // than ~8x. Measured by mutating `F32_ULP_SCALE` in `csg/plane_eps.rs`:
    // 4x tighter (2^-24) fails 2 tests, but 4x looser (2^-20) passed the
    // ENTIRE `ifc-lite-geometry` suite, and only 16x looser (2^-18) failed
    // anything. "Too loose" is the direction that silently welds genuinely
    // separate geometry together, so it needs its own pin.
    //
    // A millimetre-unit site-offset model: a horizontal plane at z = 1e6 mm
    // and a slab a genuine 0.5 mm below it. 0.5 is an exact multiple of the
    // f32 ULP at 1e6 (2^19 * 2^-23 = 0.0625), so the separation survives
    // quantization exactly and is real geometry, not float noise.
    //
    //   shipped 2^-22 : eps = 999999.5 * 2^-22 ~= 2.384e-1 mm  -> DISCARD
    //   loosened 2^-20: eps = 999999.5 * 2^-20 ~= 9.537e-1 mm  -> keep (bug)
    //
    // 0.5 mm sits strictly between, so exactly a 4x loosening flips the
    // verdict. Half a millimetre of wall is not "on the plane".
    let plane_z = 1.0e6_f64;
    let sep = 0.5_f64;
    let behind_z = (plane_z - sep) as f32;
    let measured = plane_z - f64::from(behind_z);
    assert!(
        (measured - sep).abs() < 1e-12,
        "fixture error: {sep} mm below 1e6 quantized to {behind_z} — a \
         {measured:e} mm separation, not the exact multiple of the 0.0625 mm \
         f32 ULP this test assumes"
    );

    let mesh = slab_at_z(0.0, 5000.0, behind_z);
    let plane = Plane::new(Point3::new(0.0, 0.0, plane_z), Vector3::new(0.0, 0.0, 1.0));

    // The discriminating window: the shipped epsilon must be under the
    // separation (so a correct clip discards) AND within 4x of it (so a 4x
    // loosening of `F32_ULP_SCALE` crosses it). If a future change moves
    // either bound this assertion fires instead of the test going vacuous.
    let eps = eps_for(&mesh, &plane);
    assert!(
        eps < sep,
        "fixture is vacuous: the shipped epsilon {eps:e} must be tighter than \
         the {sep} mm separation, or a correct implementation also keeps the \
         slab"
    );
    assert!(
        sep < 4.0 * eps,
        "fixture is vacuous: the {sep} mm separation must be within 4x of the \
         shipped epsilon {eps:e}, or a 4x loosening of F32_ULP_SCALE would \
         still discard the slab and this test would not bound the epsilon \
         from above"
    );

    let out = ClippingProcessor::new()
        .clip_mesh(&mesh, &plane)
        .expect("clip must not error");
    assert_eq!(
        out.indices.len(),
        0,
        "a slab a genuine {sep} mm behind a horizontal plane must be \
         discarded. Keeping it means the classification epsilon ({eps:e}) was \
         loosened past {sep} mm — at 2^-20 it becomes 9.54e-1 mm — and the \
         clipper is now welding geometry that is half a millimetre apart onto \
         the plane. Scaling the tolerance to coordinate magnitude is only \
         sound while the scale factor stays at the f32 ULP fraction it is \
         derived from"
    );
}
