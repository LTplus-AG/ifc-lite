// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Rust review finding D3: the disjoint-cutter batch re-extends each member
//! against the host once the host has been cut, and that re-extension must
//! apply the same 1 µm weld as admission, or a cutter admitted only because of
//! the weld takes its whole group back to the sequential loop.

use super::*;
use crate::csg::take_csg_census;

/// A through-Y box opening `[min, max]` subdivided `levels` times, so each
/// cutter carries a triangle count no other test's cutter shares.
fn box_opening(min: [f64; 3], max: [f64; 3], levels: usize, jitter: bool) -> OpeningType {
    let (mn, mx) = (Point3::from(min), Point3::from(max));
    let mut mesh = GeometryRouter::make_box_mesh(mn, mx).subdivided(levels);
    if jitter {
        // One ULP on one per-face copy of a corner: geometrically still closed,
        // bit-exactly open, which is what a placement transform leaves behind.
        mesh.positions[0] = mesh.positions[0].next_up();
    }
    OpeningType::NonRectangular(mesh, mn, mx, Some(Vector3::new(0.0, 1.0, 0.0)))
}

fn mesh_of(o: &OpeningType) -> &Mesh {
    match o {
        OpeningType::NonRectangular(m, ..) => m,
        _ => unreachable!("fixture openings are NonRectangular"),
    }
}

#[test]
fn a_welded_cutter_still_batches_after_the_host_was_cut() {
    // Opening 0 crosses openings 1 and 2, so the greedy grouping leaves it a
    // singleton (cut first, sequentially, which mutates the host) and puts the
    // two disjoint jittered cutters in one group that is cut after it.
    let openings = vec![
        box_opening([-1.5, -0.4, -0.2], [1.5, 0.4, 0.2], 0, false),
        box_opening([-1.2, -0.4, -0.6], [-0.8, 0.4, 0.6], 1, true),
        box_opening([0.8, -0.4, -0.6], [1.2, 0.4, 0.6], 2, true),
    ];
    let host =
        GeometryRouter::make_box_mesh(Point3::new(-2.0, -0.15, -1.5), Point3::new(2.0, 0.15, 1.5));
    for o in &openings[1..] {
        let m = mesh_of(o);
        assert!(
            !mesh_is_closed_exact(m),
            "premise: the jittered cutter is bit-exactly open"
        );
        assert!(
            mesh_is_closed_exact(&m.welded_by_position(1.0e-6)),
            "premise: the 1 µm weld closes it, so admission accepts it"
        );
    }
    let group_tris =
        mesh_of(&openings[1]).triangle_count() + mesh_of(&openings[2]).triangle_count();

    let ctx = VoidContext {
        merged_openings: openings.clone(),
        openings,
        param: None,
        bool2d: None,
    };
    // The overlap-union prepass would take opening 0 and a member together.
    coaxial_union::set_enabled_override(Some(false));
    let router = GeometryRouter::new();
    let bounds = world_host_bounds(&host);
    let cut = router.apply_void_context_inner(host, &ctx, 1, bounds, false);
    coaxial_union::set_enabled_override(None);
    assert!(!cut.is_empty(), "the host survives three through-cuts");

    // The census is process-global; a batched kernel call for this group is
    // the one record whose cutter side is exactly both members' triangles.
    let census = take_csg_census();
    assert!(
        census
            .iter()
            .any(|r| r.op == 0 && r.b_tris as usize == group_tris),
        "the two welded cutters must be subtracted as one batch ({group_tris} cutter \
         triangles in one call); the re-extension refused them and they were cut \
         one by one: {:?}",
        census.iter().map(|r| r.b_tris).collect::<Vec<_>>()
    );
}

fn issue_3977_prism(profile: &[(f32, f32)], z0: f32, z1: f32) -> Mesh {
    let mut mesh = Mesh::new();
    for &z in &[z0, z1] {
        for &(x, y) in profile {
            mesh.positions.extend_from_slice(&[x, y, z]);
            mesh.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
        }
    }
    let count = profile.len() as u32;
    for i in 1..count - 1 {
        mesh.indices.extend_from_slice(&[0, i + 1, i]);
        mesh.indices
            .extend_from_slice(&[count, count + i, count + i + 1]);
    }
    for i in 0..count {
        let next = (i + 1) % count;
        mesh.indices
            .extend_from_slice(&[i, next, count + next, i, count + next, count + i]);
    }
    mesh
}

fn issue_3977_rotate(mesh: &Mesh, angle: f64) -> Mesh {
    let (sin, cos) = angle.sin_cos();
    let mut rotated = mesh.clone();
    for position in rotated.positions.chunks_exact_mut(3) {
        let (x, y) = (position[0] as f64, position[1] as f64);
        position[0] = (cos * x - sin * y) as f32;
        position[1] = (sin * x + cos * y) as f32;
    }
    rotated
}

#[test]
fn plan_rotated_mitred_wall_tip_strip_is_closed_3977() {
    let angle = 3.0_f64.to_radians();
    let host = issue_3977_rotate(
        &issue_3977_prism(
            &[(0.0, -0.05), (4.0, -0.05), (3.85, 0.05), (0.0, 0.05)],
            0.0,
            3.0,
        ),
        angle,
    );
    // A 13 mm strip has one face on the long wall face, crosses the mitred
    // corner, and is flush with both vertical caps. In the world frame this
    // exact configuration returns 147 triangles with unmatched edges.
    let cutter = issue_3977_rotate(
        &issue_3977_prism(
            &[(3.987, -0.05), (4.0, -0.05), (4.0, 0.1), (3.987, 0.1)],
            0.0,
            3.0,
        ),
        angle,
    );
    let (sin, cos) = angle.sin_cos();
    let frame = OpeningFrame {
        depth: Vector3::new(0.0, 0.0, 1.0),
        cross_a: Vector3::new(cos, sin, 0.0),
        cross_b: Vector3::new(-sin, cos, 0.0),
        depth_is_authored: true,
    };
    let openings = vec![OpeningType::DiagonalRectangular(cutter, frame)];
    assert!(
        vertical_depth_wall_frame(&host, &openings).is_some(),
        "the authored vertical cutter and thin, tall host must qualify"
    );
    let mut inferred = openings.clone();
    let OpeningType::DiagonalRectangular(_, inferred_frame) = &mut inferred[0] else {
        unreachable!()
    };
    inferred_frame.depth_is_authored = false;
    assert!(
        vertical_depth_wall_frame(&host, &inferred).is_none(),
        "an inferred vertical direction must not opt a host into the new path"
    );
    let host_volume = mesh_signed_volume(&host).abs();
    let context = VoidContext {
        merged_openings: openings.clone(),
        openings,
        param: None,
        bool2d: None,
    };
    let bounds = world_host_bounds(&host);
    let output = GeometryRouter::new().apply_void_context_inner(host, &context, 3977, bounds, true);
    assert!(
        mesh_is_closed_exact(&output),
        "wall-local cut must close the rotated mitred-tip strip ({} tris)",
        output.triangle_count()
    );
    assert!(
        mesh_signed_volume(&output).abs() < host_volume - 1.0e-5,
        "the closed result must retain the actual tip cut"
    );
}
