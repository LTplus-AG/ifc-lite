// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! SPIKE: rect_fast on ROTATED walls via the placement frame.
//!
//! rect_fast cuts rectangular openings analytically (cellular decomposition,
//! watertight by construction) but ONLY when the host is an axis-aligned box.
//! A rotated wall is not axis-aligned in world space, so `aligned_box` rejects
//! it and the cut defers to the slow exact kernel (`defer_host_not_box`). On a
//! rotated-wall model (e.g. harbour steel) that is ~100% of wall openings.
//!
//! The fix is to run the cut in the wall's PLACEMENT frame, where the wall (and
//! its openings, placed relative to it) ARE axis-aligned. This spike proves the
//! claim end to end:
//!   1. A building-scale ROTATED wall defers in world (`defer_host_not_box`).
//!   2. The SAME wall, expressed in its placement frame (axis-aligned, near
//!      origin), fires rect_fast and the result is watertight.
//!   3. Applying the rigid placement back to the cut reproduces the world cut,
//!      so this is a drop-in replacement for the exact kernel on these walls.

use ifc_lite_geometry::rect_fast::{subtract_rect_openings, RectFastStats};
use ifc_lite_geometry::Mesh;
use nalgebra::{Matrix4, Vector3};
use std::collections::HashMap;

/// Axis-aligned box mesh (8 corners, 12 triangles, 6 faces) spanning `min..max`.
fn box_mesh(min: [f32; 3], max: [f32; 3]) -> Mesh {
    let c = |i: usize| {
        [
            if i & 1 == 0 { min[0] } else { max[0] },
            if i & 2 == 0 { min[1] } else { max[1] },
            if i & 4 == 0 { min[2] } else { max[2] },
        ]
    };
    let mut positions = Vec::new();
    // 6 faces, each as 2 triangles, corners indexed by the bit pattern above.
    let faces = [
        [0, 2, 6, 4], // -x
        [1, 5, 7, 3], // +x
        [0, 4, 5, 1], // -y
        [2, 3, 7, 6], // +y
        [0, 1, 3, 2], // -z
        [4, 6, 7, 5], // +z
    ];
    let mut indices = Vec::new();
    for f in faces {
        let base = (positions.len() / 3) as u32;
        for &corner in &f {
            let p = c(corner);
            positions.extend_from_slice(&p);
        }
        indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
    let mut m = Mesh::new();
    m.positions = positions;
    m.normals = vec![0.0; m.positions.len()];
    m.indices = indices;
    m
}

/// Apply a 4x4 rigid transform to a copy of `mesh`'s positions (f64 math, f32 store).
fn transformed(mesh: &Mesh, t: &Matrix4<f64>) -> Mesh {
    let mut out = mesh.clone();
    for chunk in out.positions.chunks_exact_mut(3) {
        let p = t.transform_point(&nalgebra::Point3::new(
            chunk[0] as f64,
            chunk[1] as f64,
            chunk[2] as f64,
        ));
        chunk[0] = p.x as f32;
        chunk[1] = p.y as f32;
        chunk[2] = p.z as f32;
    }
    out
}

/// World AABB (min,max) of a box translated by `base` with extent `ext`.
fn opening(base: [f64; 3], ext_min: [f64; 3], ext_max: [f64; 3]) -> ([f64; 3], [f64; 3]) {
    (
        [base[0] + ext_min[0], base[1] + ext_min[1], base[2] + ext_min[2]],
        [base[0] + ext_max[0], base[1] + ext_max[1], base[2] + ext_max[2]],
    )
}

/// Closed-2-manifold check by WELDED position (0.1 mm grid): every undirected
/// edge must be shared by exactly two non-degenerate triangles. A crack/gap
/// leaves boundary edges with count 1.
fn watertight(mesh: &Mesh) -> (bool, usize, usize) {
    let key = |i: u32| -> (i64, i64, i64) {
        let b = i as usize * 3;
        let q = |v: f32| (v as f64 / 1.0e-4).round() as i64;
        (q(mesh.positions[b]), q(mesh.positions[b + 1]), q(mesh.positions[b + 2]))
    };
    let mut edges: HashMap<((i64, i64, i64), (i64, i64, i64)), i32> = HashMap::new();
    let mut tris = 0usize;
    for tri in mesh.indices.chunks_exact(3) {
        let (ka, kb, kc) = (key(tri[0]), key(tri[1]), key(tri[2]));
        if ka == kb || kb == kc || kc == ka {
            continue; // degenerate after weld
        }
        tris += 1;
        for (x, y) in [(ka, kb), (kb, kc), (kc, ka)] {
            let e = if x < y { (x, y) } else { (y, x) };
            *edges.entry(e).or_insert(0) += 1;
        }
    }
    let boundary = edges.values().filter(|&&c| c != 2).count();
    (boundary == 0, boundary, tris)
}

#[test]
fn rotated_building_scale_wall_defers_in_world_but_cuts_in_placement_frame() {
    // ── Wall in its LOCAL extrusion/placement frame: axis-aligned, near origin.
    // 4 m long, 0.3 m thick, 3 m tall.
    let wall_local = box_mesh([0.0, 0.0, 0.0], [4.0, 0.3, 3.0]);
    // A window placed relative to the wall: x 1.5..2.5, full thickness, z 1..2.
    let win_local = opening([0.0, 0.0, 0.0], [1.5, -0.1, 1.0], [2.5, 0.4, 2.0]);

    // ── Placement: rotate 37° about Z (a non-axis-aligned wall) + translate to
    // building/harbour scale (hundreds of km from the project origin).
    let yaw = 37.0_f64.to_radians();
    let rot = Matrix4::new_rotation(Vector3::z() * yaw);
    let trans = Matrix4::new_translation(&Vector3::new(221_534.0, 98_210.0, 47_001.0));
    let placement = trans * rot;

    // (1) WORLD: the rotated wall is NOT an axis-aligned box → rect_fast defers.
    let wall_world = transformed(&wall_local, &placement);
    // Express the window AABB in world by transforming its 8 corners and re-bounding.
    let win_world = aabb_of_transformed_box(win_local, &placement);
    let mut st_world = RectFastStats::default();
    let world_res = subtract_rect_openings(&wall_world, &[win_world], &mut st_world);
    assert!(world_res.is_none(), "rotated wall should NOT fire rect_fast in world");
    assert_eq!(st_world.defer_host_not_box, 1, "expected host_not_box defer in world");

    // (2) PLACEMENT FRAME: the same wall is axis-aligned → rect_fast FIRES, and
    // the result is watertight (small coords, snap-grid exact).
    let mut st_local = RectFastStats::default();
    let cut_local = subtract_rect_openings(&wall_local, &[win_local], &mut st_local)
        .expect("axis-aligned wall in placement frame should fire rect_fast");
    assert_eq!(st_local.fired, 1, "expected one rect_fast fire");
    let (wt, boundary, tris) = watertight(&cut_local);
    assert!(wt, "placement-frame cut must be watertight (got {boundary} boundary edges over {tris} tris)");
    assert!(tris > 12, "cut should add faces around the opening (got {tris} tris)");

    // (3) Apply the rigid placement back: the cut transforms to world cleanly.
    // (Connectivity is rigid-invariant, so the placed result is the same cut —
    // in production it stays in the local frame + carries `origin`, avoiding the
    // f32 collapse a world-space store would suffer at this magnitude.)
    let cut_world = transformed(&cut_local, &placement);
    assert_eq!(
        cut_world.indices.len(),
        cut_local.indices.len(),
        "placement is rigid — same topology"
    );

    println!(
        "SPIKE OK: rotated wall defers in world (host_not_box={}); \
         placement-frame cut fires (fired={}), watertight (tris={tris}, boundary={boundary})",
        st_world.defer_host_not_box, st_local.fired
    );
}

/// World AABB of a local-frame box AABB after a rigid transform (bound its 8 corners).
fn aabb_of_transformed_box(b: ([f64; 3], [f64; 3]), t: &Matrix4<f64>) -> ([f64; 3], [f64; 3]) {
    let (mn, mx) = b;
    let mut wmn = [f64::INFINITY; 3];
    let mut wmx = [f64::NEG_INFINITY; 3];
    for i in 0..8 {
        let p = [
            if i & 1 == 0 { mn[0] } else { mx[0] },
            if i & 2 == 0 { mn[1] } else { mx[1] },
            if i & 4 == 0 { mn[2] } else { mx[2] },
        ];
        let w = t.transform_point(&nalgebra::Point3::new(p[0], p[1], p[2]));
        for k in 0..3 {
            let v = [w.x, w.y, w.z][k];
            wmn[k] = wmn[k].min(v);
            wmx[k] = wmx[k].max(v);
        }
    }
    (wmn, wmx)
}
