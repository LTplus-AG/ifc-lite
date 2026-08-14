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
    assert!(cap_half_space_clip(&mut slab, after_prev.point, after_prev.normal));
    let flipped = Plane::new(before_next.point, -before_next.normal);
    let mut slab = clipper.clip_mesh(&slab, &flipped).unwrap();
    assert!(cap_half_space_clip(&mut slab, flipped.point, flipped.normal));

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
    assert!(cap_half_space_clip(
        &mut m,
        Point3::new(0.5, 0.5, 0.0),
        Vector3::new(0.0, 0.0, 1.0)
    ));
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

    assert!(cap_half_space_clip(&mut clipped, plane_point, clip_normal));

    assert_eq!(open_edges(&clipped), 0, "capped clip must be watertight");
    assert!(clipped.indices.len() / 3 > tris_before, "cap must add triangles");
    // Closed kept-half of the unit box → +0.5 (positive ⇒ outward winding).
    let v = signed_volume(&clipped);
    assert!((v - 0.5).abs() < 1.0e-5, "capped half-box volume should be +0.5, got {v}");
}

/// Pins the winding property the maintainer explicitly asked to carry over
/// from #2171: "cap winding derived from the cut direction coming out
/// inverted on both pieces". A volume-conservation-only test (like the one
/// above) passes straight through that bug — a mesh whose cap triangles are
/// wound inward can still integrate to the right positive magnitude if only
/// a minority of the surface is misoriented relative to its area, which is
/// exactly why the #2171 bug survived its own test suite. This asserts the
/// GEOMETRIC orientation of every cap triangle directly, on BOTH pieces you
/// get from cutting the same plane in each direction (`clip_normal = +z`
/// keeping the top half, `clip_normal = -z` keeping the bottom half — the
/// same two branches `clip_mesh_with_half_space` takes for
/// `AgreementFlag = .T.` vs `.F.`), not just their summed volume.
#[test]
fn cap_winding_faces_away_from_kept_material_on_both_complementary_pieces() {
    let bx = unit_box();
    let plane_point = Point3::new(0.5, 0.5, 0.5);
    let clipper = ClippingProcessor::new();

    for &clip_normal in &[Vector3::new(0.0, 0.0, 1.0), Vector3::new(0.0, 0.0, -1.0)] {
        let mut clipped = clipper
            .clip_mesh(&bx, &Plane::new(plane_point, clip_normal))
            .unwrap();
        let tris_before = clipped.indices.len() / 3;
        assert!(cap_half_space_clip(&mut clipped, plane_point, clip_normal));
        assert!(
            clipped.indices.len() / 3 > tris_before,
            "cap must add triangles for clip_normal={clip_normal:?}"
        );

        // Outward normal of the KEPT solid at the cut face points away from
        // the kept material, i.e. opposite the direction that was kept.
        let expected_outward = -clip_normal;
        let p = |i: u32| -> Point3<f64> {
            let b = i as usize * 3;
            Point3::new(
                clipped.positions[b] as f64,
                clipped.positions[b + 1] as f64,
                clipped.positions[b + 2] as f64,
            )
        };
        for tri in clipped.indices[tris_before * 3..].as_chunks::<3>().0 {
            let (a, b, c) = (p(tri[0]), p(tri[1]), p(tri[2]));
            let n = (b - a).cross(&(c - a));
            assert!(
                n.dot(&expected_outward) > 0.0,
                "cap triangle wound inward for clip_normal={clip_normal:?}: geo_n={n:?}"
            );
        }
    }
}

/// Kernel-review counterexample (PR #2260, louistrue): a unit box clipped at
/// z=0.5 closes cleanly on its own, but if a SEPARATE dangling triangle with
/// exactly one fully-on-plane edge (and a third vertex off-plane) is also
/// present in the mesh, that triangle's on-plane edge gets enrolled in the
/// boundary chain walk, dead-ends (its far vertex has no continuation), and
/// is silently dropped by the `None => loop_v.clear()` arm — never affecting
/// `outer_count`/`outer_filled`. The dangling triangle's edges stay open
/// (never welded to anything else in the mesh) yet `cap_half_space_clip`
/// still reports `capped = true`, contradicting both its own doc ("a
/// boundary that does not close bails") and the property #1810 zone
/// splitting depends on (a trustworthy per-piece "was the cut closed"
/// signal).
#[test]
fn cap_reports_false_when_a_dangling_on_plane_edge_stays_open() {
    let bx = unit_box();
    let clip_normal = Vector3::new(0.0, 0.0, 1.0);
    let plane_point = Point3::new(0.5, 0.5, 0.5);
    let clipper = ClippingProcessor::new();
    let mut clipped = clipper
        .clip_mesh(&bx, &Plane::new(plane_point, clip_normal))
        .unwrap();

    // Dangling triangle, disconnected from the box (shares no vertices with
    // its cut loop): edge a-b lies fully on z=0.5, vertex c is off-plane.
    let base = (clipped.positions.len() / 3) as u32;
    let a = [5.0f32, 5.0, 0.5];
    let b = [6.0f32, 5.0, 0.5];
    let c = [5.0f32, 6.0, 3.0];
    for v in [a, b, c] {
        clipped.positions.extend_from_slice(&v);
        clipped.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
    }
    clipped.indices.extend_from_slice(&[base, base + 1, base + 2]);

    let open_before = open_edges(&clipped);
    assert!(open_before > 0, "fixture must start with open edges");

    let capped = cap_half_space_clip(&mut clipped, plane_point, clip_normal);

    let open_after = open_edges(&clipped);
    assert!(
        open_after > 0,
        "the dangling triangle's edges must remain open after capping (got {open_after})"
    );
    assert!(
        !capped,
        "capped must be false when boundary edges remain open (got true with {open_after} open edges)"
    );
}

/// `capped` must be MEASURED, not seeded: a plane that never touches the mesh
/// (no vertex lies on it, so there is no open boundary to close) must report
/// `false`, never a leftover-`true` from some earlier call or a hopeful
/// default. This is the exact shape of the #2171 regression — the caller
/// asked for a cap, nothing was capped, so the answer must be `false`.
#[test]
fn cap_reports_false_when_the_plane_touches_no_boundary() {
    let bx = unit_box();
    assert_eq!(open_edges(&bx), 0, "fixture box must be watertight");
    let mut untouched = bx.clone();
    // Plane far outside the unit box — no vertex is within `on_plane_eps` of it.
    let capped = cap_half_space_clip(
        &mut untouched,
        Point3::new(0.5, 0.5, 100.0),
        Vector3::new(0.0, 0.0, 1.0),
    );
    assert!(!capped, "a plane touching nothing must report false, not a seeded true");
    assert_eq!(
        untouched.indices.len(),
        bx.indices.len(),
        "an unmatched plane must leave the mesh unchanged"
    );
}

/// Kernel-gate finding (PR #2260, louistrue, 2026-08-07): the boundary walk's
/// "merge into an already-visited vertex" arm sets `boundary_incomplete` and
/// `break`s, but does NOT `loop_v.clear()` before the `if loop_v.len() >= 3`
/// push below it — unlike the sibling dead-end (`None`) arm, which does clear.
/// So an unclosed chain that folds back into a vertex some OTHER chain already
/// visited is triangulated and appended to the mesh as if it were a real ring,
/// even though the function correctly reports `capped = false`.
///
/// Four dangling on-plane triangles wired s->a->b->c->a (a "rho": a tail that
/// loops back one hop short of its own start) reproduce this without needing
/// any real cut at all. The walk starting at `s` visits a, b, c, then hits `a`
/// again — already visited by this same walk, and `cur != s` — so it takes the
/// merge arm, not the `cur == s` closure. `loop_v` still holds `[s, a, b, c]`
/// and is pushed as a "loop" because the merge arm never clears it.
#[test]
fn cap_does_not_leak_garbage_triangles_from_an_unclosed_merge_chain() {
    let z_plane = 0.5f32;
    // On-plane quad corners.
    let s = [0.0f32, 0.0, z_plane];
    let a = [1.0f32, 0.0, z_plane];
    let b = [1.0f32, 1.0, z_plane];
    let c = [0.0f32, 1.0, z_plane];
    // Off-plane third vertex for each dangling triangle, distinct so none
    // welds to another and none lies on the cut plane.
    let off_a = [2.0f32, 0.0, 3.0];
    let off_b = [2.0f32, 1.0, 4.0];
    let off_c = [1.0f32, 2.0, 5.0];
    let off_d = [0.0f32, 2.0, 6.0];

    let mut m = Mesh::new();
    let push_tri = |m: &mut Mesh, verts: [[f32; 3]; 3]| {
        let base = (m.positions.len() / 3) as u32;
        for v in verts {
            m.positions.extend_from_slice(&v);
            m.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
        }
        m.indices.extend_from_slice(&[base, base + 1, base + 2]);
    };
    push_tri(&mut m, [s, a, off_a]); // on-plane edge s->a
    push_tri(&mut m, [a, b, off_b]); // on-plane edge a->b
    push_tri(&mut m, [b, c, off_c]); // on-plane edge b->c
    push_tri(&mut m, [c, a, off_d]); // on-plane edge c->a (merges back into `a`)

    let tris_before = m.indices.len() / 3;
    let positions_before = m.positions.len();

    let capped = cap_half_space_clip(
        &mut m,
        Point3::new(0.0, 0.0, z_plane as f64),
        Vector3::new(0.0, 0.0, 1.0),
    );

    assert!(
        !capped,
        "an unclosed merge chain must not report capped=true"
    );
    assert_eq!(
        m.indices.len() / 3,
        tris_before,
        "a chain that never closes must not append ANY triangles to the mesh, \
         even when the overall verdict is correctly `false` — got {} new tri(s)",
        m.indices.len() / 3 - tris_before
    );
    assert_eq!(
        m.positions.len(),
        positions_before,
        "a chain that never closes must not append ANY vertices to the mesh"
    );
}

/// Kernel-gate finding (PR #2260, deep review): `outer_filled == outer_count`
/// (the "did every outer ring actually triangulate" accounting) had NO
/// fixture — mutating it to `outer_filled <= outer_count` or `>= 1` passed
/// every other test in this file, because none of them produce two SEPARATE
/// outer rings where only one fails its CDT. That shape needs a genuine
/// triangulation failure, which `safe_earcut`'s deliberate robustness makes
/// hard to trigger with real degenerate geometry (see the fn-level doc on
/// `force_cdt_fail_on_ring_for_test`), so this drives it through the
/// `#[cfg(test)]` seam instead: two unit boxes far apart, both clipped by the
/// SAME plane in one call (two disjoint, non-nested cut sections ⇒
/// `outer_count == 2`), with the second ring's CDT forced to fail.
#[test]
fn cap_reports_false_when_one_of_two_outer_rings_fails_its_cdt() {
    let mut combined = unit_box();
    let second = {
        let mut b = unit_box();
        for c in b.positions.as_chunks_mut::<3>().0 {
            c[0] += 10.0; // far enough that the two cut sections never nest
        }
        b
    };
    let base = (combined.positions.len() / 3) as u32;
    combined.positions.extend_from_slice(&second.positions);
    combined.normals.extend_from_slice(&second.normals);
    combined
        .indices
        .extend(second.indices.iter().map(|&i| i + base));

    let plane_point = Point3::new(0.5, 0.5, 0.5);
    let clip_normal = Vector3::new(0.0, 0.0, 1.0);
    let clipper = ClippingProcessor::new();
    let mut clipped = clipper
        .clip_mesh(&combined, &Plane::new(plane_point, clip_normal))
        .unwrap();

    // Sanity: with no forced failure, both sections cap and the verdict is
    // true — establishes `outer_count == 2` is really reached before we
    // start forcing failures.
    let mut baseline = clipped.clone();
    force_cdt_fail_on_ring_for_test(None);
    assert!(
        cap_half_space_clip(&mut baseline, plane_point, clip_normal),
        "both disjoint sections must cap cleanly with no forced failure"
    );

    let tris_before = clipped.indices.len() / 3;
    force_cdt_fail_on_ring_for_test(Some(1)); // fail the SECOND outer ring
    let capped = cap_half_space_clip(&mut clipped, plane_point, clip_normal);
    force_cdt_fail_on_ring_for_test(None); // don't leak into later tests

    assert!(
        !capped,
        "one outer ring failing its CDT must make the whole verdict false, \
         even though the other ring succeeded"
    );
    let tris_after = clipped.indices.len() / 3;
    assert!(
        tris_after > tris_before,
        "the ring that DID triangulate must still contribute its cap \
         triangles (best-effort geometry), got {} new tris",
        tris_after - tris_before
    );
}

/// Kernel-gate finding (PR #2260, deep review, minor): the merge-arm
/// `loop_v.clear()` fix (above) makes an unclosed chain correctly contribute
/// NO triangles — but which vertex a walk happens to START from is decided
/// by welded-vertex insertion order, and for a "cycle plus one dangling tail
/// that merges into it" shape (a rho: closed ring C, plus an edge t->c into
/// one of C's own vertices), that order decides whether C's own,
/// independently-valid loop ever gets walked at all.
///
/// Same solid — a unit box cut at z=0.5 (a clean, independently-capping
/// cycle) plus one on-plane dangling triangle whose edge targets a cycle
/// corner — reproduced under BOTH vertex orderings. In both, `capped` is
/// correctly `false` (the invariant #1810 depends on: never a false
/// positive). What differs is whether the cycle's own cap geometry survives:
///
/// - tail-vertices-inserted-first: the walk starting at the tail consumes the
///   ENTIRE cycle into `visited` before merging back into itself, so the
///   cycle never gets its own walk and NOTHING is capped.
/// - cycle-vertices-inserted-first: a cycle vertex is walked (and closes)
///   before the tail's start is reached, so the cycle IS capped — the
///   tail's own walk then correctly contributes nothing.
///
/// This is a real latent difference in output completeness (not correctness
/// — `capped` is false either way) that the kernel-gate review flagged as
/// non-blocking, latent risk rather than an observed regression, since fixing
/// it needs picking genuine chain "sources" before genuine cycles, which is
/// a bigger structural change than this PR's "small fixes" scope. This test
/// pins BOTH observed behaviours as a regression guard and a citation for the
/// follow-up, rather than leaving the finding untested.
#[test]
fn cap_verdict_stays_false_but_cap_completeness_is_order_dependent_for_a_cycle_plus_tail() {
    let plane_point = Point3::new(0.5, 0.5, 0.5);
    let clip_normal = Vector3::new(0.0, 0.0, 1.0);
    let clipper = ClippingProcessor::new();
    let box_cut = clipper
        .clip_mesh(&unit_box(), &Plane::new(plane_point, clip_normal))
        .unwrap();

    // Dangling on-plane edge t -> c, where `c` coincides exactly with the
    // box cut's (0.0, 0.0, 0.5) corner (an axis-aligned edge cut at an
    // exactly-representable f32 midpoint, so this is a bit-exact weld).
    let t = [2.0f32, 0.0, 0.5];
    let c = [0.0f32, 0.0, 0.5];
    let off = [2.0f32, 1.0, 3.0];

    // Order A: tail vertices FIRST → the cycle is entirely consumed into the
    // tail's own failed walk and never capped.
    let mut order_a = Mesh::new();
    for v in [t, c, off] {
        order_a.positions.extend_from_slice(&v);
        order_a.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
    }
    order_a.indices.extend_from_slice(&[0, 1, 2]);
    let box_base = (order_a.positions.len() / 3) as u32;
    order_a.positions.extend_from_slice(&box_cut.positions);
    order_a.normals.extend_from_slice(&box_cut.normals);
    order_a
        .indices
        .extend(box_cut.indices.iter().map(|&i| i + box_base));

    let tris_before_a = order_a.indices.len() / 3;
    let capped_a = cap_half_space_clip(&mut order_a, plane_point, clip_normal);
    assert!(!capped_a, "order A must still report capped=false");
    assert_eq!(
        order_a.indices.len() / 3,
        tris_before_a,
        "order A (tail-first ids): the cycle must be swallowed by the tail's \
         walk and end up with NO cap triangles at all"
    );

    // Order B: box (cycle) vertices FIRST → the cycle gets its own walk and
    // IS capped; the tail's walk correctly contributes nothing.
    let mut order_b = box_cut.clone();
    let tail_base = (order_b.positions.len() / 3) as u32;
    for v in [t, c, off] {
        order_b.positions.extend_from_slice(&v);
        order_b.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
    }
    order_b
        .indices
        .extend_from_slice(&[tail_base, tail_base + 1, tail_base + 2]);

    let tris_before_b = order_b.indices.len() / 3;
    let capped_b = cap_half_space_clip(&mut order_b, plane_point, clip_normal);
    assert!(!capped_b, "order B must still report capped=false");
    assert!(
        order_b.indices.len() / 3 > tris_before_b,
        "order B (cycle-first ids): the cycle must still be capped even \
         though the overall verdict is correctly false"
    );
}
