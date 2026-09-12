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
    let host = GeometryRouter::make_box_mesh(
        Point3::new(-2.0, -0.15, -1.5),
        Point3::new(2.0, 0.15, 1.5),
    );
    for o in &openings[1..] {
        let m = mesh_of(o);
        assert!(!mesh_is_closed_exact(m), "premise: the jittered cutter is bit-exactly open");
        assert!(
            mesh_is_closed_exact(&m.welded_by_position(1.0e-6)),
            "premise: the 1 µm weld closes it, so admission accepts it"
        );
    }
    let group_tris = mesh_of(&openings[1]).triangle_count() + mesh_of(&openings[2]).triangle_count();

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
        census.iter().any(|r| r.op == 0 && r.b_tris as usize == group_tris),
        "the two welded cutters must be subtracted as one batch ({group_tris} cutter \
         triangles in one call); the re-extension refused them and they were cut \
         one by one: {:?}",
        census.iter().map(|r| r.b_tris).collect::<Vec<_>>()
    );
}
