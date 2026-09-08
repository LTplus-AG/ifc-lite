// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for the zone split (#2508 item 2).
//!
//! Every expected number here is hand-computable from the fixture, which is
//! what #2508's verification bar asks for: "a box wall crossing one boundary at
//! a known fraction, a wall crossing two boundaries, an element wholly inside,
//! an element wholly outside, an element touching exactly at a boundary plane".
//! A test that only asserted "the pieces sum to the whole" would pass on a
//! split that put every cubic metre in the wrong zone.

use super::*;
use crate::kernel::arrangement::box_mesh;

/// A 6 x 1 x 1 m wall from x = 0 to x = 6, so a boundary at x = c leaves
/// exactly `c` m3 below it. Volume 6.
fn wall() -> Vec<Tri> {
    box_mesh([0.0, 0.0, 0.0], [6.0, 1.0, 1.0])
}

/// A zone spanning `[x0, x1]` in x and covering the wall entirely in y and z.
fn slab(x0: f64, x1: f64) -> ZoneShape {
    ZoneShape::Box(ZoneBox {
        center: [(x0 + x1) / 2.0, 0.5, 0.5],
        size: [x1 - x0, 4.0, 4.0],
        rotation_y: 0.0,
    })
}

fn volume_of(split: &ZoneSplit, zone: Option<usize>) -> f64 {
    split
        .pieces
        .iter()
        .filter(|p| p.zone == zone)
        .map(|p| p.volume)
        .sum()
}

/// Tight, because these are exact-arithmetic cuts of axis-aligned boxes: the
/// residue is f64 accumulation in the divergence sum and nothing else.
const EPS: f64 = 1e-9;

#[test]
fn wall_crossing_one_boundary_splits_at_the_known_fraction() {
    let split = split_mesh_by_zones(&wall(), &[slab(-1.0, 2.0), slab(2.0, 7.0)]);

    assert!((split.whole_volume - 6.0).abs() < EPS, "whole {}", split.whole_volume);
    assert!((volume_of(&split, Some(0)) - 2.0).abs() < EPS, "{:?}", split.pieces.iter().map(|p| (p.zone, p.volume)).collect::<Vec<_>>());
    assert!((volume_of(&split, Some(1)) - 4.0).abs() < EPS);
    assert!(split.sum_error_rel() < 1e-12, "sum error {}", split.sum_error_rel());
}

#[test]
fn wall_crossing_two_boundaries_gives_three_pieces() {
    let split = split_mesh_by_zones(&wall(), &[slab(-1.0, 1.5), slab(1.5, 4.5), slab(4.5, 7.0)]);

    assert!((volume_of(&split, Some(0)) - 1.5).abs() < EPS);
    assert!((volume_of(&split, Some(1)) - 3.0).abs() < EPS);
    assert!((volume_of(&split, Some(2)) - 1.5).abs() < EPS);
    assert!(volume_of(&split, None) < EPS, "nothing should be left over");
    assert!(split.sum_error_rel() < 1e-12);
}

#[test]
fn an_element_wholly_inside_one_zone_is_one_piece_of_the_whole() {
    let split = split_mesh_by_zones(&wall(), &[slab(-1.0, 7.0)]);

    assert_eq!(split.pieces.len(), 1);
    assert_eq!(split.pieces[0].zone, Some(0));
    assert!((split.pieces[0].volume - 6.0).abs() < EPS);
}

#[test]
fn an_element_in_no_zone_becomes_the_remainder_rather_than_vanishing() {
    // The zone is far away in x. Returning no pieces here would say the
    // element ceased to exist, which is the one answer a split must never give.
    let split = split_mesh_by_zones(&wall(), &[slab(100.0, 110.0)]);

    assert_eq!(split.pieces.len(), 1);
    assert_eq!(split.pieces[0].zone, None);
    assert!((split.pieces[0].volume - 6.0).abs() < EPS);
    assert!(split.sum_error_rel() < 1e-12);
}

#[test]
fn part_of_an_element_outside_every_zone_survives_as_the_remainder() {
    let split = split_mesh_by_zones(&wall(), &[slab(-1.0, 2.0)]);

    assert!((volume_of(&split, Some(0)) - 2.0).abs() < EPS);
    assert!((volume_of(&split, None) - 4.0).abs() < EPS);
    assert!(split.sum_error_rel() < 1e-12);
}

#[test]
fn an_element_ending_exactly_on_a_boundary_plane_produces_no_second_piece() {
    // The wall ends at x = 6 and the second zone starts there. This is the
    // common case in takt planning, where sets tile a building on shared
    // planes, and it is why v1's straddle epsilon is negative. A zero-thickness
    // "piece" here would be a solid of no volume for a user to wonder about.
    let split = split_mesh_by_zones(&wall(), &[slab(-1.0, 6.0), slab(6.0, 9.0)]);

    assert_eq!(split.pieces.len(), 1, "{:?}", split.pieces.iter().map(|p| (p.zone, p.volume)).collect::<Vec<_>>());
    assert_eq!(split.pieces[0].zone, Some(0));
    assert!((split.pieces[0].volume - 6.0).abs() < EPS);
}

#[test]
fn a_rotated_zone_cuts_where_its_own_axes_are() {
    // A zone rotated 45 degrees about Y, centred on the wall's own centre line
    // at x = 3. Its local +x axis points along (1, 0, 1)/sqrt(2), and the plane
    // through the centre normal to that axis crosses the wall's centre line at
    // x = 3, so it takes exactly the half of the wall below x = 3 minus what
    // the rotation trims in z. The box is made long enough (8 m local x, 8 m
    // local z) that the only face cutting the wall is the one at local
    // x = -4... which the placement below puts far outside, so the whole wall
    // is inside. What this pins is that ROTATION IS APPLIED AT ALL: with
    // rotation ignored, the same box is an axis-aligned 8 x 4 x 0.5 slab whose
    // z extent (0.5 m, centred at z = 0.5) still covers the wall, so a naive
    // implementation passes. Hence the second, tighter zone below.
    let inside = ZoneShape::Box(ZoneBox { center: [3.0, 0.5, 0.5], size: [8.0, 4.0, 8.0], rotation_y: 45f64.to_radians() });
    let split = split_mesh_by_zones(&wall(), &[inside]);
    assert!((volume_of(&split, Some(0)) - 6.0).abs() < EPS);

    // A thin blade, 0.4 m across its local x, standing at 45 degrees through
    // the wall at x = 3. Rotated, it sweeps a diagonal band across the wall's
    // 1 m depth: the band's extent along x is 0.4*sqrt(2) plus the 1 m of z
    // depth projected, i.e. the intersection is a parallelogram prism of area
    // (0.4/cos45) * 1 in the x/z plane... which is 0.5656854 m2, times the 1 m
    // height = 0.5656854 m3. Unrotated, the same blade would take 0.4 m3.
    let blade = ZoneShape::Box(ZoneBox { center: [3.0, 0.5, 0.5], size: [0.4, 4.0, 8.0], rotation_y: 45f64.to_radians() });
    let split = split_mesh_by_zones(&wall(), &[blade]);
    let expected = 0.4 * 2f64.sqrt();
    assert!(
        (volume_of(&split, Some(0)) - expected).abs() < 1e-6,
        "rotated blade took {} m3, expected {}",
        volume_of(&split, Some(0)),
        expected,
    );
    assert!(split.sum_error_rel() < 1e-9, "sum error {}", split.sum_error_rel());
}

#[test]
fn a_zone_bigger_than_the_element_takes_all_of_it_and_leaves_no_remainder() {
    let split = split_mesh_by_zones(
        &wall(),
        &[ZoneShape::Box(ZoneBox { center: [3.0, 0.5, 0.5], size: [100.0, 100.0, 100.0], rotation_y: 0.0 })],
    );
    assert_eq!(split.pieces.len(), 1);
    assert!((split.pieces[0].volume - 6.0).abs() < EPS);
}

#[test]
fn a_zero_size_zone_takes_nothing_and_does_not_crash() {
    let split = split_mesh_by_zones(
        &wall(),
        &[ZoneShape::Box(ZoneBox { center: [3.0, 0.5, 0.5], size: [0.0, 0.0, 0.0], rotation_y: 0.0 })],
    );
    assert!(volume_of(&split, Some(0)) < EPS);
    assert!((volume_of(&split, None) - 6.0).abs() < EPS);
}

#[test]
fn an_empty_host_produces_nothing_rather_than_panicking() {
    let split = split_mesh_by_zones(&[], &[slab(0.0, 1.0)]);
    assert_eq!(split.whole_volume, 0.0);
    assert!(split.pieces.iter().all(|p| p.volume.abs() < EPS));
}

#[test]
fn an_inward_wound_host_still_yields_positive_pieces() {
    // Real IFC winding is not reliably outward (see `orient_outward`'s doc). A
    // split that reported negative volumes for an inward-wound wall would be
    // reporting the winding, not the geometry.
    let mut flipped = wall();
    for t in &mut flipped {
        t.swap(1, 2);
    }
    let split = split_mesh_by_zones(&flipped, &[slab(-1.0, 2.0), slab(2.0, 7.0)]);

    assert!(split.whole_volume > 0.0, "whole {}", split.whole_volume);
    assert!((volume_of(&split, Some(0)) - 2.0).abs() < EPS);
    assert!((volume_of(&split, Some(1)) - 4.0).abs() < EPS);
}

#[test]
fn overlapping_zones_are_reported_by_the_sum_invariant_rather_than_hidden() {
    // v1 does not forbid overlapping zones. Both pieces are individually
    // correct and together they double-count the overlap, so the honest signal
    // is the invariant failing loudly rather than a plausible-looking split.
    let split = split_mesh_by_zones(&wall(), &[slab(-1.0, 4.0), slab(2.0, 7.0)]);

    assert!((volume_of(&split, Some(0)) - 4.0).abs() < EPS);
    assert!((volume_of(&split, Some(1)) - 4.0).abs() < EPS);
    assert!(
        split.sum_error_rel() > 0.1,
        "overlap should be visible in the sum, got {}",
        split.sum_error_rel(),
    );
}

#[test]
fn the_pieces_are_closed_solids_and_not_merely_clipped_shells() {
    // A volume measured about the origin and about a far-away point agree only
    // for a CLOSED surface: the divergence sum of an open shell depends on the
    // point it is measured about. This is what distinguishes a real split from
    // a set of cut-open faces that happen to sum correctly.
    let split = split_mesh_by_zones(&wall(), &[slab(-1.0, 2.0), slab(2.0, 7.0)]);
    for piece in &split.pieces {
        let shifted: Vec<Tri> = piece
            .tris
            .iter()
            .map(|t| t.map(|p| [p[0] + 1000.0, p[1] - 500.0, p[2] + 250.0]))
            .collect();
        let about_far = crate::kernel::signed_volume::signed_volume_of(&shifted);
        assert!(
            (about_far - piece.volume).abs() < 1e-6,
            "piece {:?} is not closed: {} about the origin, {} about a far point",
            piece.zone,
            piece.volume,
            about_far,
        );
    }
}

#[test]
fn a_prism_zone_cuts_by_its_polygon_and_not_by_its_bounding_box() {
    // A triangle in plan whose bounding box covers the whole wall but which
    // itself covers a known fraction of it. The wall spans x = 0..6, z = 0..1.
    // The triangle (0,0) - (6,0) - (0,1) cuts the wall's plan rectangle along
    // the diagonal, taking exactly half of its 6 m2 footprint, so half its
    // volume. A box-shaped implementation would take all 6 m3.
    let prism = ZoneShape::Prism {
        footprint: vec![[0.0, 0.0], [6.0, 0.0], [0.0, 1.0]],
        min_y: -1.0,
        max_y: 2.0,
    };
    let split = split_mesh_by_zones(&wall(), &[prism]);

    assert!(
        (volume_of(&split, Some(0)) - 3.0).abs() < 1e-6,
        "prism took {} m3, expected 3",
        volume_of(&split, Some(0)),
    );
    assert!((volume_of(&split, None) - 3.0).abs() < 1e-6, "remainder {}", volume_of(&split, None));
    assert!(split.sum_error_rel() < 1e-9, "sum error {}", split.sum_error_rel());
}

#[test]
fn two_prisms_tiling_the_plan_split_the_element_between_them() {
    let lower = ZoneShape::Prism {
        footprint: vec![[-1.0, -1.0], [8.0, -1.0], [8.0, 2.0]],
        min_y: -1.0,
        max_y: 2.0,
    };
    let upper = ZoneShape::Prism {
        footprint: vec![[-1.0, -1.0], [8.0, 2.0], [-1.0, 2.0]],
        min_y: -1.0,
        max_y: 2.0,
    };
    let split = split_mesh_by_zones(&wall(), &[lower, upper]);

    assert!(volume_of(&split, None) < 1e-6, "the tiling should leave no remainder");
    assert!(split.sum_error_rel() < 1e-9, "sum error {}", split.sum_error_rel());
    // Neither zone took the lot, or the test would pass on a splitter that
    // ignored the second polygon.
    assert!(volume_of(&split, Some(0)) > 0.5 && volume_of(&split, Some(1)) > 0.5);
}

#[test]
fn a_prism_with_too_few_points_takes_nothing_rather_than_panicking() {
    let degenerate = ZoneShape::Prism { footprint: vec![[0.0, 0.0], [1.0, 0.0]], min_y: -1.0, max_y: 2.0 };
    let split = split_mesh_by_zones(&wall(), &[degenerate]);
    assert!(volume_of(&split, Some(0)) < EPS);
    assert!((volume_of(&split, None) - 6.0).abs() < EPS);
}

/// A triangle's vertices in a rotation-independent, winding-SENSITIVE key, so
/// two copies of the same face wound oppositely hash differently.
fn oriented_key(t: &Tri) -> String {
    let start = (0..3)
        .min_by(|&a, &b| {
            let (x, y) = (t[a], t[b]);
            x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap_or(0);
    (0..3)
        .map(|i| {
            let p = t[(start + i) % 3];
            format!("{:.9},{:.9},{:.9}", p[0], p[1], p[2])
        })
        .collect::<Vec<_>>()
        .join("|")
}

/// The first face whose opposite winding is also present, for a failure message
/// that points at the membrane instead of at triangle zero.
fn first_membrane_face(tris: &[Tri]) -> Option<Tri> {
    use std::collections::HashSet;
    let forward: HashSet<String> = tris.iter().map(oriented_key).collect();
    tris.iter()
        .find(|t| forward.contains(&oriented_key(&[t[0], t[2], t[1]])))
        .copied()
}

/// Faces that appear both ways round in one solid: a zero-volume membrane.
fn back_to_back_pairs(tris: &[Tri]) -> usize {
    use std::collections::HashSet;
    let forward: HashSet<String> = tris.iter().map(oriented_key).collect();
    tris.iter()
        .filter(|t| {
            let flipped = [t[0], t[2], t[1]];
            forward.contains(&oriented_key(&flipped))
        })
        .count()
}

#[test]
fn a_tiling_leaves_no_membrane_inside_the_remainder() {
    // Two zones sharing the plane x = 2, covering only part of the wall, so the
    // remainder is a real solid rather than a dropped sliver.
    //
    // `difference_all` documents that its cutters must be pairwise disjoint,
    // and a tiling zone set is precisely the case that violates it: the two
    // coincident, opposite-wound cutter faces at x = 2 are each classified only
    // against the host, so BOTH survive into the remainder as a zero-volume
    // membrane. Volume cannot see it (the pair cancels), which is why the
    // assertion is on the faces rather than on any number.
    let split = split_mesh_by_zones(&wall(), &[slab(0.0, 2.0), slab(2.0, 4.0)]);

    let remainder = split
        .pieces
        .iter()
        .find(|p| p.zone.is_none())
        .expect("the wall's x = 4..6 tail must survive as the remainder");
    assert!((remainder.volume - 2.0).abs() < EPS, "remainder volume {}", remainder.volume);
    let membranes = back_to_back_pairs(&remainder.tris);
    assert_eq!(
        membranes,
        0,
        "the remainder carries {} membrane faces, e.g. {:?}",
        membranes,
        // The FIRST triangle whose flip is also present, rather than the first
        // triangle of the piece: a message that always names triangle 0 tells
        // the next reader nothing about where the membrane is.
        first_membrane_face(&remainder.tris),
    );
}

#[test]
fn a_prism_tiling_leaves_no_membrane_either() {
    let lower = ZoneShape::Prism {
        footprint: vec![[-1.0, -1.0], [3.0, -1.0], [3.0, 2.0], [-1.0, 2.0]],
        min_y: -1.0,
        max_y: 2.0,
    };
    let upper = ZoneShape::Prism {
        footprint: vec![[3.0, -1.0], [5.0, -1.0], [5.0, 2.0], [3.0, 2.0]],
        min_y: -1.0,
        max_y: 2.0,
    };
    let split = split_mesh_by_zones(&wall(), &[lower, upper]);
    let remainder = split
        .pieces
        .iter()
        .find(|p| p.zone.is_none())
        .expect("x = 5..6 must survive as the remainder");
    assert_eq!(back_to_back_pairs(&remainder.tris), 0);
    assert!(split.sum_error_rel() < 1e-9, "sum error {}", split.sum_error_rel());
}

#[test]
fn a_zone_the_element_only_abuts_is_not_subtracted_from_the_remainder() {
    // The second zone starts exactly where the wall ends, so it takes nothing.
    // Subtracting it anyway would hand the arrangement an exactly-coplanar
    // operand with no intersection to show for it, and a refusal there
    // (`difference_all` returns None) would lose the remainder entirely.
    let split = split_mesh_by_zones(&wall(), &[slab(0.0, 2.0), slab(6.0, 9.0)]);

    let remainder = split.pieces.iter().find(|p| p.zone.is_none());
    assert!(remainder.is_some(), "the x = 2..6 remainder was lost");
    assert!((remainder.unwrap().volume - 4.0).abs() < EPS);
    assert!(split.sum_error_rel() < 1e-12);
}
