// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests of the subtract weld's exact-incidence guard, `incidence.rs` (#6940).

use super::super::{
    promote_cutter_verts_onto_host_faces as unguarded,
    promote_subtract_cutter_onto_host_faces as guarded, NearBand,
};
use super::{coincide, in_band_of, Guard};
use crate::kernel::plane_weld::Face;
use crate::kernel::arrangement::{box_mesh, Tri};
use crate::kernel::mesh_bridge::{mesh_to_tris, orient_outward};
use crate::{extrude_profile, Point2, Profile2D};

/// One snap-grid step.
const G: f64 = 1.0 / 65536.0;

fn faces(tris: &[Tri]) -> Vec<Face> {
    let mut band = NearBand::default();
    band.observe_tris(tris);
    tris.iter()
        .map(|t| Face::new(t, &band).expect("non-degenerate"))
        .collect()
}

/// Would the weld of a vertex exactly on the faces `on` to `w`, on
/// `tris[target]`'s plane, be refused against the host `tris`?
fn refused(tris: &[Tri], w: &[f64; 3], target: usize, on: &[usize]) -> bool {
    Guard::new(&faces(tris)).refuses(w, target, on)
}

/// `g`: a wall in the plane `y = 0`. The vertex `v` is exactly on it.
const WALL: Tri = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]];
const V: [f64; 3] = [0.5, 0.0, 2.0];
/// A second wall further along, skewed so it crosses `y = 0`.
const CROSSING: Tri = [[3.0, -G, 0.0], [5.0, 2.0 * G, 0.0], [3.0, -G, 1.0]];
/// Any point off `y = 0`: where a weld onto another wall would put `V`.
const OFF: [f64; 3] = [V[0], V[1] - 4.0 * G, V[2]];

#[test]
fn a_separate_wall_two_grid_steps_away_is_refused() {
    // CROSSING, and a wall that STARTS exactly on `y = 0`: touching the
    // other's plane does not make two walls one face, only a chain of
    // shared vertices does.
    let touching: Tri = [[3.0, 0.0, 0.0], [5.0, 2.0 * G, 0.0], [3.0, 0.0, 1.0]];
    let host = [WALL, CROSSING, touching];
    assert!(refused(&host, &OFF, 1, &[0]));
    assert!(refused(&host, &OFF, 2, &[0]));
}

#[test]
fn a_weld_that_stays_on_the_face_is_not_refused() {
    let w = [0.75, 0.0, 2.0]; // still on `y = 0`
    assert!(!refused(&[WALL, CROSSING], &w, 1, &[0]));
}

#[test]
fn a_facet_hinged_on_the_face_keeps_the_weld() {
    // Shares WALL's vertex `(1, 0, 0)` and leans one grid step off its
    // plane: the neighbouring facet of one creased face.
    let facet: Tri = [[1.0, 0.0, 0.0], [2.0, G, 0.0], [1.0, 0.0, 1.0]];
    let w = [V[0], V[1] + G, V[2]];
    assert!(!refused(&[WALL, facet], &w, 1, &[0]));
}

#[test]
fn a_facet_joined_through_another_facet_keeps_the_weld() {
    // Three facets of one creased wall in a row. The third shares no
    // vertex with WALL, the second joins them.
    let second: Tri = [[1.0, 0.0, 0.0], [2.0, G, 0.0], [1.0, 0.0, 1.0]];
    let third: Tri = [[2.0, G, 0.0], [3.0, G, 0.0], [2.0, G, 1.0]];
    let w = [V[0], V[1] + G, V[2]];
    assert!(!refused(&[WALL, second, third], &w, 2, &[0]));
    // Without the facet between them they are two walls.
    assert!(refused(&[WALL, third], &w, 1, &[0]));
    // A face square to the wall does not join them, though it shares a
    // vertex with each: two hole walls both meet the cap.
    let cap: Tri = [[1.0, 0.0, 0.0], [2.0, G, 0.0], [1.0, 1.0, 0.0]];
    assert!(refused(&[WALL, cap, third], &w, 2, &[0]));
}

#[test]
fn a_sliver_facet_between_them_still_joins_them() {
    // The facet between is a 10 mm sliver leaning one grid step across
    // its width: its plane leaves WALL's band within a metre, so it
    // coincides with neither neighbour, yet all of it lies in their band.
    let sliver: Tri = [[1.0, 0.0, 0.0], [2.0, G, 0.0], [1.0, G, 0.01]];
    let third: Tri = [[2.0, G, 0.0], [3.0, G, 0.0], [2.0, G, 1.0]];
    let host = [WALL, sliver, third];
    let f = faces(&host);
    assert!(!coincide(&f[1], &f[0]) && !coincide(&f[1], &f[2]));
    assert!(in_band_of(&f[1], &f[0]));
    let w = [V[0], V[1] + G, V[2]];
    assert!(!refused(&host, &w, 2, &[0]));
}

#[test]
fn the_chain_runs_through_faces_near_either_plane() {
    // The target leans one grid step per unit, so its plane leaves the band
    // 8 units out. WALL and the target coincide and share no vertex.
    let target: Tri = [[1.5, 0.0, 0.0], [2.5, G, 0.0], [1.5, 0.0, 1.0]];
    let w = [V[0], V[1] - 4.0 * G, V[2]];
    assert!(refused(&[WALL, target], &w, 1, &[0]));
    // A long face in WALL's plane joins them. Its far corner is 41 steps off
    // the target's plane: it is near WALL's plane only.
    let on_wall: Tri = [[1.0, 0.0, 0.0], [1.5, 0.0, 0.0], [-40.0, 0.0, 1.0]];
    assert!(!refused(&[WALL, target, on_wall], &w, 1, &[0]));
    // A long face in the target's plane joins them too. Its far corner is 38
    // steps off WALL's plane: it is near the target's plane only.
    let on_target: Tri = [[1.0, 0.0, 0.0], [1.5, 0.0, 0.0], [40.0, 38.5 * G, 1.0]];
    assert!(!refused(&[WALL, target, on_target], &w, 1, &[0]));
}

#[test]
fn a_face_of_the_targets_surface_withdraws_a_refusal_another_face_would_make() {
    // A second face the vertex is exactly on (it is one of its corners),
    // sharing CROSSING's vertical edge: CROSSING is hinged on it.
    let hinge: Tri = [[3.0, -G, 0.0], [3.0, -G, 1.0], V];
    let host = [WALL, CROSSING, hinge];
    assert_eq!(
        faces(&host)[2].raw_offset(&V),
        0.0,
        "the vertex must be exactly on the hinge face"
    );
    assert!(refused(&host, &OFF, 1, &[0]));
    assert!(!refused(&host, &OFF, 1, &[0, 2]));
    assert!(!refused(&host, &OFF, 1, &[2, 0]));
}

#[test]
fn one_guard_answers_each_question_on_its_own() {
    // The same target asked about with different faces under the vertex, on
    // ONE guard: the answer remembered for the last question must not stand
    // in for the next.
    let hinge: Tri = [[3.0, -G, 0.0], [3.0, -G, 1.0], V];
    let f = faces(&[WALL, CROSSING, hinge]);
    let mut guard = Guard::new(&f);
    assert!(guard.refuses(&OFF, 1, &[0]));
    assert!(!guard.refuses(&OFF, 1, &[0, 2]));
    assert!(guard.refuses(&OFF, 1, &[0]));
}

#[test]
fn a_perpendicular_or_oblique_face_is_unrelated_and_keeps_the_weld() {
    // The #1007 shape: on the bottom plane, a few micrometres off an end
    // face square to it. The end face's vertices are far outside the band
    // of `y = 0`.
    let end: Tri = [
        [0.5 + G, 0.0, 0.0],
        [0.5 + G, 1.0, 0.0],
        [0.5 + G, 0.0, 1.0],
    ];
    let oblique: Tri = [
        [0.5 + G, 0.0, 0.0],
        [1.5 + G, 1.0, 0.0],
        [0.5 + G, 0.0, 1.0],
    ];
    let host = [WALL, end, oblique];
    let w = [V[0] + G, V[1] - G, V[2]]; // off `y = 0`, so only the relation decides
    assert!(!refused(&host, &w, 1, &[0]));
    assert!(!refused(&host, &w, 2, &[0]));
}

#[test]
fn a_face_in_band_one_way_only_keeps_the_weld() {
    // A small facet close to `y = 0` but leaning 20 grid steps per unit:
    // all of it is inside WALL's band, while WALL's far corner `(1, 0, 0)`
    // is 17 steps off the facet's plane. The two diverge over WALL's
    // extent, so they are not one surface, whichever is the target.
    let lean: Tri = [[0.2, G, 0.2], [0.3, 3.0 * G, 0.2], [0.2, G, 0.3]];
    let host = [WALL, lean];
    let f = faces(&host);
    assert!(in_band_of(&f[1], &f[0]) && !in_band_of(&f[0], &f[1]));
    assert!(!refused(&host, &OFF, 1, &[0]));
    assert!(!refused(&host, &OFF, 0, &[1]));
}

#[test]
fn a_parallel_face_outside_the_band_keeps_the_weld() {
    // 1 mm away: far beyond the band (8 grid steps here), a real second wall.
    let far: Tri = [[3.0, 1.0e-3, 0.0], [5.0, 1.0e-3, 0.0], [3.0, 1.0e-3, 1.0]];
    assert!(!refused(&[WALL, far], &OFF, 1, &[0]));
}

/// A slab `[0,8] x [0,8]`, depth 0.25, with the given holes, as the host
/// triangles `subtract` hands the weld.
fn slab(holes: &[&[[f64; 2]]]) -> Vec<Tri> {
    let ring = |r: &[[f64; 2]]| {
        r.iter()
            .map(|p| Point2::new(p[0], p[1]))
            .collect::<Vec<_>>()
    };
    let mut profile = Profile2D::new(ring(&[[0.0, 0.0], [8.0, 0.0], [8.0, 8.0], [0.0, 8.0]]));
    holes.iter().for_each(|h| profile.add_hole(ring(h)));
    orient_outward(mesh_to_tris(
        &extrude_profile(&profile, 0.25, None).expect("slab extrudes"),
    ))
}

/// The weld run both ways over one cutter: `(guarded, moved, unguarded, moved)`.
fn both(cutter: &[Tri], host: &[Tri]) -> (Vec<Tri>, usize, Vec<Tri>, usize) {
    let (mut a, mut b) = (cutter.to_vec(), cutter.to_vec());
    let (na, nb) = (guarded(&mut a, host), unguarded(&mut b, host));
    (a, na, b, nb)
}

/// #6940's shape end to end: the cutter fills hole A and is pushed through
/// both caps; hole B's left wall runs a few grid steps off collinear with
/// hole A's. The unguarded weld drags the cutter's `x = 1` corners onto
/// hole B's wall; the subtract weld leaves the cutter exactly as it came.
#[test]
fn a_cutter_filling_a_hole_is_not_welded_onto_a_neighbouring_holes_wall() {
    for skew in [G, 2.0 * G, 3.0 * G] {
        let host = slab(&[
            &[[1.0, 1.0], [1.0, 2.0], [2.0, 2.0], [2.0, 1.0]],
            &[[1.0, 3.0], [1.0 + skew, 5.0], [2.0, 5.0], [2.0, 3.0]],
        ]);
        let cutter = box_mesh([1.0, 1.0, -0.125], [2.0, 2.0, 0.375]);
        let (kept, moved, dragged, dragged_n) = both(&cutter, &host);
        assert!(
            dragged_n > 0 && dragged != cutter,
            "skew {skew}: the fixture must weld unguarded"
        );
        assert_eq!(
            (moved, &kept),
            (0, &cutter),
            "skew {skew}: the guarded weld moved the cutter"
        );
    }
}

/// The guard's scope: on a CREASED wall (flat to `x = 2`, then leaning into
/// the hole) the facets are hinged, and the subtract weld must do exactly
/// what the unguarded weld does, vertex for vertex.
#[test]
fn a_creased_hole_wall_is_welded_exactly_as_without_the_guard() {
    for skew in [G, 2.0 * G, 4.0 * G] {
        let host = slab(&[&[
            [1.0, 1.0],
            [1.0, 2.0],
            [2.0, 2.0],
            [3.0, 2.0 - skew],
            [3.0, 1.0],
        ]]);
        let cutter = box_mesh([1.0, 1.0, -0.125], [3.0, 2.0, 0.375]);
        let (a, moved, b, moved_unguarded) = both(&cutter, &host);
        assert!(moved_unguarded > 0, "skew {skew}: the fixture must weld");
        assert_eq!(
            (moved, a),
            (moved_unguarded, b),
            "skew {skew}: the guard reached a creased wall"
        );
    }
}

/// The same scope when the crease has more than two facets: flat to
/// `x = 2`, leaning to `x = 3`, then flat again one skew lower. The first
/// and third facets share no vertex and are in-band of each other, but
/// they are one wall, joined through the second. A corner exactly on the
/// first facet's plane and nearest the third's is still on a creased face.
#[test]
fn a_hole_wall_creased_twice_is_welded_exactly_as_without_the_guard() {
    for skew in [G, 2.0 * G, 4.0 * G] {
        let host = slab(&[&[
            [1.0, 1.0],
            [1.0, 2.0],
            [2.0, 2.0],
            [3.0, 2.0 - skew],
            [4.0, 2.0 - skew],
            [4.0, 1.0],
        ]]);
        let cutter = box_mesh([1.0, 1.0, -0.125], [4.0, 2.0, 0.375]);
        let (a, moved, b, moved_unguarded) = both(&cutter, &host);
        assert!(moved_unguarded > 0, "skew {skew}: the fixture must weld");
        assert_eq!(
            (moved, a),
            (moved_unguarded, b),
            "skew {skew}: the guard reached a wall creased twice"
        );
    }
}

/// The host's faces reordered, and each face's vertices rotated (which keeps
/// its orientation and moves the corner that anchors its plane).
fn reordered(host: &[Tri], shift: usize, reverse: bool, rotate: usize) -> Vec<Tri> {
    let mut out: Vec<Tri> = host.to_vec();
    out.rotate_left(shift % host.len());
    if reverse {
        out.reverse();
    }
    out.iter_mut().for_each(|t| t.rotate_left(rotate));
    out
}

/// The refusal is a property of the vertex and the host, not of the order the
/// host's faces or their corners arrive in.
#[test]
fn the_guard_does_not_depend_on_the_order_of_the_host_faces() {
    let two_holes = slab(&[
        &[[1.0, 1.0], [1.0, 2.0], [2.0, 2.0], [2.0, 1.0]],
        &[[1.0, 3.0], [1.0 + 2.0 * G, 5.0], [2.0, 5.0], [2.0, 3.0]],
    ]);
    let creased = slab(&[&[
        [1.0, 1.0],
        [1.0, 2.0],
        [2.0, 2.0],
        [3.0, 2.0 - 2.0 * G],
        [4.0, 2.0 - 2.0 * G],
        [4.0, 1.0],
    ]]);
    let filling = box_mesh([1.0, 1.0, -0.125], [2.0, 2.0, 0.375]);
    let along = box_mesh([1.0, 1.0, -0.125], [4.0, 2.0, 0.375]);
    for (shift, reverse, rotate) in [(0, true, 0), (7, false, 1), (31, true, 2), (53, false, 2)] {
        let host = reordered(&two_holes, shift, reverse, rotate);
        let (kept, moved, _, dragged) = both(&filling, &host);
        assert!(dragged > 0, "order {shift}/{reverse}/{rotate}: the fixture must weld unguarded");
        assert_eq!((moved, &kept), (0, &filling), "order {shift}/{reverse}/{rotate}");

        let host = reordered(&creased, shift, reverse, rotate);
        let (a, moved, b, moved_unguarded) = both(&along, &host);
        assert!(moved_unguarded > 0, "order {shift}/{reverse}/{rotate}: the fixture must weld");
        assert_eq!((moved, a), (moved_unguarded, b), "order {shift}/{reverse}/{rotate}");
    }
}
