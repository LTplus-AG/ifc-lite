// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::csg::{ClippingProcessor, Plane};

/// Outward-wound watertight unit cube, one face per quad → two triangles,
/// vertices duplicated per triangle (as the clipper itself emits them).
fn unit_box() -> Mesh {
    let c = [
        [0.0f32, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0], [1.0, 0.0, 1.0], [1.0, 1.0, 1.0], [0.0, 1.0, 1.0],
    ];
    let tris: [[usize; 3]; 12] = [
        [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
        [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
        [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
    ];
    let mut m = Mesh::new();
    for t in tris {
        let base = (m.positions.len() / 3) as u32;
        for &vi in &t {
            m.positions.extend_from_slice(&c[vi]);
            m.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
        }
        m.indices.extend_from_slice(&[base, base + 1, base + 2]);
    }
    m
}

/// Open boundary edges, vertices welded on a 10 µm grid.
fn open_edges(m: &Mesh) -> usize {
    use std::collections::HashMap;
    let key = |i: usize| -> (i64, i64, i64) {
        (
            (m.positions[i * 3] as f64 * 1.0e5).round() as i64,
            (m.positions[i * 3 + 1] as f64 * 1.0e5).round() as i64,
            (m.positions[i * 3 + 2] as f64 * 1.0e5).round() as i64,
        )
    };
    let mut vid: HashMap<(i64, i64, i64), u32> = HashMap::new();
    let mut bal: HashMap<(u32, u32), i32> = HashMap::new();
    for tri in m.indices.chunks_exact(3) {
        let mut id = [0u32; 3];
        for (j, &vi) in tri.iter().enumerate() {
            let k = key(vi as usize);
            let n = vid.len() as u32;
            id[j] = *vid.entry(k).or_insert(n);
        }
        for (x, y) in [(id[0], id[1]), (id[1], id[2]), (id[2], id[0])] {
            let (kk, s) = if x < y { ((x, y), 1) } else { ((y, x), -1) };
            *bal.entry(kk).or_insert(0) += s;
        }
    }
    bal.values().filter(|&&v| v != 0).count()
}

fn signed_volume(m: &Mesh) -> f64 {
    let p = |i: usize| {
        [
            m.positions[i * 3] as f64,
            m.positions[i * 3 + 1] as f64,
            m.positions[i * 3 + 2] as f64,
        ]
    };
    let mut vol = 0.0;
    for tri in m.indices.chunks_exact(3) {
        let (a, b, c) = (p(tri[0] as usize), p(tri[1] as usize), p(tri[2] as usize));
        vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
            + a[2] * (b[0] * c[1] - b[1] * c[0]))
            / 6.0;
    }
    vol
}

/// Extrude a CCW 2D profile (XY) along Z into a watertight, outward-wound
/// prism: side quads + earcut top/bottom caps, vertices duplicated per
/// triangle (as the clipper emits them). Lets a test build a NON-CONVEX host
/// whose thickness-slice section is itself non-convex/disjoint.
fn extrude_profile(profile: &[[f32; 2]], z0: f32, z1: f32) -> Mesh {
    use crate::triangulation::triangulate_polygon;
    use nalgebra::Point2;
    let mut m = Mesh::new();
    let mut push = |a: [f32; 3], b: [f32; 3], c: [f32; 3]| {
        let base = (m.positions.len() / 3) as u32;
        for v in [a, b, c] {
            m.positions.extend_from_slice(&v);
            m.normals.extend_from_slice(&[0.0, 0.0, 0.0]);
        }
        m.indices.extend_from_slice(&[base, base + 1, base + 2]);
    };
    let n = profile.len();
    for i in 0..n {
        let a = profile[i];
        let b = profile[(i + 1) % n];
        let (a0, b0) = ([a[0], a[1], z0], [b[0], b[1], z0]);
        let (b1, a1) = ([b[0], b[1], z1], [a[0], a[1], z1]);
        push(a0, b0, b1); // outward (CCW profile ⇒ interior on the left)
        push(a0, b1, a1);
    }
    let pts: Vec<Point2<f64>> = profile
        .iter()
        .map(|p| Point2::new(p[0] as f64, p[1] as f64))
        .collect();
    let idx = triangulate_polygon(&pts).expect("earcut profile");
    for t in idx.chunks_exact(3) {
        let (a, b, c) = (profile[t[0]], profile[t[1]], profile[t[2]]);
        // top cap (+Z, CCW), bottom cap (−Z, reversed) → outward both.
        push([a[0], a[1], z1], [b[0], b[1], z1], [c[0], c[1], z1]);
        push([a[0], a[1], z0], [c[0], c[1], z0], [b[0], b[1], z0]);
    }
    m
}

/// General guard for the material-layer cap on irregular hosts: an inner
/// slab built by the SAME two-pass clip the layer slicer runs (after_prev,
/// then the FLIPPED before_next) must come out watertight even when the cut
/// section is non-convex. The host is a U-profile prism, so a thickness (Y)
/// slice through the arms is two disjoint columns — a genuinely non-convex,
/// multi-loop cut section the cap has to triangulate. (The specific ULP-twin
/// weld regression is pinned by `cap_welds_ulp_twin_section_corner` below.)
#[test]
fn two_pass_layer_clip_on_nonconvex_profile_is_watertight() {
    // U opening +Y: arms at x∈[0,1] and x∈[2,3] for y∈[1,3], joined y∈[0,1].
    let u = [
        [0.0f32, 0.0], [3.0, 0.0], [3.0, 3.0], [2.0, 3.0],
        [2.0, 1.0], [1.0, 1.0], [1.0, 3.0], [0.0, 3.0],
    ];
    let host = extrude_profile(&u, 0.0, 2.5);
    assert_eq!(open_edges(&host), 0, "fixture U-prism must be watertight");

    // A thin inner slab in the arms band y∈[1.6,2.4] (section = two columns).
    let clipper = ClippingProcessor::new();
    let after_prev = Plane::new(Point3::new(0.0, 1.6, 0.0), Vector3::new(0.0, 1.0, 0.0));
    let before_next = Plane::new(Point3::new(0.0, 2.4, 0.0), Vector3::new(0.0, 1.0, 0.0));

    let mut slab = clipper.clip_mesh(&host, &after_prev).unwrap();
    cap_half_space_clip(&mut slab, after_prev.point, after_prev.normal);
    let flipped = Plane::new(before_next.point, -before_next.normal);
    let mut slab = clipper.clip_mesh(&slab, &flipped).unwrap();
    cap_half_space_clip(&mut slab, flipped.point, flipped.normal);

    assert_eq!(
        open_edges(&slab), 0,
        "two-pass-clipped non-convex inner slab must be watertight after capping"
    );
    // Two columns, each 1×0.8×2.5 ⇒ |V| = 4.0; positive ⇒ outward winding.
    let v = signed_volume(&slab);
    assert!(v > 0.0, "slab winding must stay outward (got {v})");
    assert!((v - 4.0).abs() < 1.0e-3, "slab volume should be ~4.0, got {v}");
}

/// Precise regression for the weld fix: a cut section whose boundary loop has
/// ONE corner stored as two ~1-ULP-apart f32 values (geometrically the same
/// point, as the two-pass layer clip produces on irregular profiles). With
/// exact-bit welding those twins stay separate, the boundary chain dead-ends
/// at that corner, the cap drops the whole loop and the section stays open
/// (the observed open edges). The spatial-grid weld collapses the twins so
/// the loop closes. Fixture: a unit box with its z=0 cap removed (open
/// section) and the right wall's shared bottom corner nudged 1 ULP in x.
#[test]
fn cap_welds_ulp_twin_section_corner() {
    let one_ulp = f32::from_bits(1.0f32.to_bits() + 1); // next f32 after 1.0
    let c = [
        [0.0f32, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0], [1.0, 0.0, 1.0], [1.0, 1.0, 1.0], [0.0, 1.0, 1.0],
    ];
    let c1_twin = [one_ulp, 0.0, 0.0]; // coincident with c[1] but 1 ULP off
    let mut m = Mesh::new();
    let mut push = |a: [f32; 3], b: [f32; 3], cc: [f32; 3]| {
        let base = (m.positions.len() / 3) as u32;
        for v in [a, b, cc] {
            m.positions.extend_from_slice(&v);
            m.normals.extend_from_slice(&[0.0, 0.0, 0.0]);
        }
        m.indices.extend_from_slice(&[base, base + 1, base + 2]);
    };
    // unit box MINUS its z=0 cap; right wall uses c1_twin for the shared
    // bottom-front corner so the z=0 loop has the coincident twin.
    push(c[4], c[5], c[6]); push(c[4], c[6], c[7]); // top   (z=1)
    push(c[0], c[1], c[5]); push(c[0], c[5], c[4]); // front (y=0) — c[1]
    push(c1_twin, c[2], c[6]); push(c1_twin, c[6], c[5]); // right (x=1) — twin
    push(c[2], c[3], c[7]); push(c[2], c[7], c[6]); // back  (y=1)
    push(c[3], c[0], c[4]); push(c[3], c[4], c[7]); // left  (x=0)

    assert!(open_edges(&m) > 0, "fixture is open at z=0 before capping");
    cap_half_space_clip(&mut m, Point3::new(0.5, 0.5, 0.0), Vector3::new(0.0, 0.0, 1.0));
    assert_eq!(
        open_edges(&m), 0,
        "cap must weld the ~1-ULP section twin and close the z=0 face"
    );
}

/// Regression for the #1024 BSP-cap deletion: an unbounded `IfcHalfSpaceSolid`
/// DIFFERENCE (the plane clip) must leave a watertight, correctly-wound solid,
/// not the open inverted shell the uncapped clip produced (AC20 gable walls).
#[test]
fn unbounded_half_space_clip_is_capped_and_watertight() {
    let bx = unit_box();
    assert_eq!(open_edges(&bx), 0, "fixture box must be watertight");
    assert!((signed_volume(&bx) - 1.0).abs() < 1.0e-6);

    // Keep the +z half — exactly what clip_mesh_with_half_space does.
    let clip_normal = Vector3::new(0.0, 0.0, 1.0);
    let plane_point = Point3::new(0.5, 0.5, 0.5);
    let clipper = ClippingProcessor::new();
    let mut clipped = clipper
        .clip_mesh(&bx, &Plane::new(plane_point, clip_normal))
        .unwrap();

    // Pre-fix: the cut cross-section is left open.
    assert!(open_edges(&clipped) > 0, "raw plane clip leaves the section open");
    let tris_before = clipped.indices.len() / 3;

    cap_half_space_clip(&mut clipped, plane_point, clip_normal);

    assert_eq!(open_edges(&clipped), 0, "capped clip must be watertight");
    assert!(clipped.indices.len() / 3 > tris_before, "cap must add triangles");
    // Closed kept-half of the unit box → +0.5 (positive ⇒ outward winding).
    let v = signed_volume(&clipped);
    assert!((v - 0.5).abs() < 1.0e-5, "capped half-box volume should be +0.5, got {v}");
}
