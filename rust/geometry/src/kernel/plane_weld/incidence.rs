// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The subtract weld's exact-incidence guard (#6940).
//!
//! # What goes wrong without it
//!
//! The router extends an opening cutter through its host, so a cutter corner
//! that started as a host vertex is no longer one and the exact-vertex
//! exemption stops applying. The corner still lies EXACTLY on the host faces
//! it was extended along (a hole's own walls, when the opening fills a hole
//! the host profile already has). If a second host face runs within the weld
//! band of that corner, the nearest-plane search finds it, because faces the
//! vertex is exactly on are skipped as already reconciled, and the weld moves
//! the corner onto it and so OFF the wall it was on. Cutter wall and host
//! wall stop being coplanar by micrometres, and the arrangement tears.
//!
//! # The rule
//!
//! A weld of a vertex onto target face `f` is refused when the vertex is
//! exactly on a host face `g`, the weld would take it off `g`, and `f` and
//! `g` are two SEPARATE surfaces that COINCIDE at weld tolerance:
//!
//! * coincide: every vertex of `f` is within the band of `g`'s plane and
//!   every vertex of `g` within the band of `f`'s. Over their whole extent
//!   the two faces are what the weld itself calls one surface up to noise. No
//!   angle threshold is involved; the test reuses the band the weld already
//!   decides by.
//! * separate: the two faces share no vertex, so they are not neighbours in
//!   the host mesh.
//!
//! Why refusing is right there: the weld exists to make a vertex agree with a
//! surface it is noisily near. Here it already agrees EXACTLY with one copy of
//! that surface, and moving it to the other copy cannot make any cutter face
//! coplanar with anything (one moved corner does not carry a triangle onto a
//! plane) while it certainly ends the coplanarity the cutter already had.
//!
//! # What it deliberately leaves alone
//!
//! * A target that is not in-band of `g` over its whole extent (the
//!   perpendicular end face of the original #1007 repro, any oblique face):
//!   that weld slides the vertex along `g` or reconciles a real second
//!   surface, and is the weld's purpose.
//! * HINGED faces, which coincide the same way but share a vertex: two
//!   neighbouring facets of one host face that the snap creased. A planar
//!   cutter face can be coplanar with only one facet, and which one it should
//!   follow depends on which facet it overlaps, not on where one corner sits.
//!   Refusing there too was measured on real hosts and is not settled: it
//!   closed one torn wall at the right volume, and it made another, torn
//!   before and after, newly depend on the triangulator's diagonal. So this
//!   guard does not decide it and the weld behaves as it did before; creased
//!   faces are not fixed here.

use super::Face;

/// How target face `f` relates to a face `g` the vertex is exactly on.
#[derive(PartialEq, Debug)]
enum Relation {
    /// Not in-band of each other over their whole extent.
    Unrelated,
    /// In-band both ways and sharing a vertex: neighbouring facets of one
    /// creased face.
    Hinged,
    /// In-band both ways and sharing no vertex.
    Separate,
}

/// Is every vertex of `a` within the band of `b`'s plane?
fn in_band_of(a: &Face, b: &Face) -> bool {
    a.t.iter().all(|p| {
        let d = b.raw_offset(p);
        (d * d) / b.nn <= b.band2
    })
}

fn relation(f: &Face, g: &Face) -> Relation {
    if !(in_band_of(f, g) && in_band_of(g, f)) {
        Relation::Unrelated
    } else if f.t.iter().any(|p| g.t.contains(p)) {
        Relation::Hinged
    } else {
        Relation::Separate
    }
}

/// Would welding a vertex to `w`, on `target`'s plane, take it off a host face
/// in `on` (the faces it is exactly on) and onto a separate surface that
/// coincides with that face? See the module docs for the rule.
///
/// One hinged face among those the weld would leave withdraws the refusal:
/// the vertex then sits on a creased face, the case this guard does not decide.
pub(super) fn leaves_a_separate_surface(w: &[f64; 3], target: &Face, on: &[&Face]) -> bool {
    let mut separate = false;
    for g in on {
        if g.raw_offset(w) == 0.0 {
            continue; // the weld keeps this incidence
        }
        match relation(target, g) {
            Relation::Hinged => return false,
            Relation::Separate => separate = true,
            Relation::Unrelated => {}
        }
    }
    separate
}

#[cfg(test)]
mod tests {
    use super::super::{
        promote_cutter_verts_onto_host_faces as unguarded,
        promote_subtract_cutter_onto_host_faces as guarded, NearBand,
    };
    use super::*;
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

    /// `g`: a wall in the plane `y = 0`. The vertex `v` is exactly on it.
    const WALL: Tri = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]];
    const V: [f64; 3] = [0.5, 0.0, 2.0];

    #[test]
    fn a_separate_wall_two_grid_steps_away_is_refused() {
        // A second wall further along, skewed so it crosses `y = 0`, and a
        // third that STARTS exactly on `y = 0`: touching the other's plane
        // does not make two walls one face, only a shared vertex does.
        let crossing: Tri = [[3.0, -G, 0.0], [5.0, 2.0 * G, 0.0], [3.0, -G, 1.0]];
        let touching: Tri = [[3.0, 0.0, 0.0], [5.0, 2.0 * G, 0.0], [3.0, 0.0, 1.0]];
        let f = faces(&[WALL, crossing, touching]);
        let w = [V[0], V[1] - 4.0 * G, V[2]]; // any point off `y = 0`
        for other in [&f[1], &f[2]] {
            assert_eq!(relation(other, &f[0]), Relation::Separate);
            assert!(leaves_a_separate_surface(&w, other, &[&f[0]]));
        }
    }

    #[test]
    fn a_weld_that_stays_on_the_face_is_not_refused() {
        let other: Tri = [[3.0, -G, 0.0], [5.0, 2.0 * G, 0.0], [3.0, -G, 1.0]];
        let f = faces(&[WALL, other]);
        let w = [0.75, 0.0, 2.0]; // still on `y = 0`
        assert!(!leaves_a_separate_surface(&w, &f[1], &[&f[0]]));
    }

    #[test]
    fn a_facet_hinged_on_the_face_keeps_the_weld() {
        // Shares WALL's vertex `(1, 0, 0)` and leans one grid step off its
        // plane: the neighbouring facet of one creased face.
        let facet: Tri = [[1.0, 0.0, 0.0], [2.0, G, 0.0], [1.0, 0.0, 1.0]];
        let f = faces(&[WALL, facet]);
        let w = [V[0], V[1] + G, V[2]];
        assert_eq!(relation(&f[1], &f[0]), Relation::Hinged);
        assert!(!leaves_a_separate_surface(&w, &f[1], &[&f[0]]));
    }

    #[test]
    fn a_hinged_facet_withdraws_a_refusal_another_face_would_make() {
        let other: Tri = [[3.0, -G, 0.0], [5.0, 2.0 * G, 0.0], [3.0, -G, 1.0]];
        // A second face the vertex is exactly on (it is one of its corners),
        // sharing `other`'s vertical edge: `other` is hinged on it.
        let hinge: Tri = [[3.0, -G, 0.0], [3.0, -G, 1.0], V];
        let f = faces(&[WALL, other, hinge]);
        let w = [V[0], V[1] - 4.0 * G, V[2]];
        assert_eq!(
            f[2].raw_offset(&V),
            0.0,
            "the vertex must be exactly on the hinge face"
        );
        assert_eq!(relation(&f[1], &f[2]), Relation::Hinged);
        assert!(leaves_a_separate_surface(&w, &f[1], &[&f[0]]));
        assert!(!leaves_a_separate_surface(&w, &f[1], &[&f[0], &f[2]]));
        assert!(!leaves_a_separate_surface(&w, &f[1], &[&f[2], &f[0]]));
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
        let f = faces(&[WALL, end, oblique]);
        let w = [V[0] + G, V[1] - G, V[2]]; // off `y = 0`, so only the relation decides
        assert_eq!(relation(&f[1], &f[0]), Relation::Unrelated);
        assert_eq!(relation(&f[2], &f[0]), Relation::Unrelated);
        assert!(!leaves_a_separate_surface(&w, &f[1], &[&f[0]]));
        assert!(!leaves_a_separate_surface(&w, &f[2], &[&f[0]]));
    }

    #[test]
    fn a_face_in_band_one_way_only_is_unrelated() {
        // A small facet close to `y = 0` but leaning 20 grid steps per unit:
        // all of it is inside WALL's band, while WALL's far corner `(1, 0, 0)`
        // is 17 steps off the facet's plane. The two diverge over WALL's
        // extent, so they are not one surface, whichever is the target.
        let lean: Tri = [[0.2, G, 0.2], [0.3, 3.0 * G, 0.2], [0.2, G, 0.3]];
        let f = faces(&[WALL, lean]);
        assert!(in_band_of(&f[1], &f[0]) && !in_band_of(&f[0], &f[1]));
        assert_eq!(relation(&f[1], &f[0]), Relation::Unrelated);
        assert_eq!(relation(&f[0], &f[1]), Relation::Unrelated);
    }

    #[test]
    fn a_parallel_face_outside_the_band_is_unrelated() {
        // 1 mm away: far beyond the band (8 grid steps here), a real second wall.
        let far: Tri = [[3.0, 1.0e-3, 0.0], [5.0, 1.0e-3, 0.0], [3.0, 1.0e-3, 1.0]];
        let f = faces(&[WALL, far]);
        assert_eq!(relation(&f[1], &f[0]), Relation::Unrelated);
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
}
