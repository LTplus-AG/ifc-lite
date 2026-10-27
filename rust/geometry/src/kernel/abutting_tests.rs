// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for `abutting` (ratchet-exempt sibling).

use super::super::arrangement::{box_mesh, Tri};
use super::super::broadphase::tris_aabb;
use super::super::mesh_bridge::{
    mesh_to_tris, subtract_many, tris_to_mesh, BatchSubtract, SNAP_GRID,
};
use super::super::signed_volume::signed_volume_of;
use super::merge_abutting_components;
use crate::mesh::Mesh;
use crate::world_frame_fixture::ulp32;

fn mesh_box(lo: [f64; 3], hi: [f64; 3]) -> Mesh {
    tris_to_mesh(&box_mesh(lo, hi))
}

/// A box as the bridge hands it to the kernel: f32 positions, snapped to the
/// lattice, outward.
fn lattice_box(lo: [f64; 3], hi: [f64; 3]) -> Vec<Tri> {
    mesh_to_tris(&mesh_box(lo, hi))
}

/// The same exact incidence `merge_group` accepts a union on.
fn closed(tris: &[Tri]) -> bool {
    crate::exact_topology::strict_closed(tris.iter().copied())
}

fn bits(comps: &[Vec<Tri>]) -> Vec<Vec<[u64; 9]>> {
    comps
        .iter()
        .map(|c| {
            c.iter()
                .map(|t| {
                    let mut b = [0u64; 9];
                    for (i, v) in t.iter().enumerate() {
                        for k in 0..3 {
                            b[i * 3 + k] = v[k].to_bits();
                        }
                    }
                    b
                })
                .collect()
        })
        .collect()
}

/// Triangles whose three vertices all have `|x - at| < tol`.
fn faces_at_x(tris: &[Tri], at: f64, tol: f64) -> usize {
    tris.iter()
        .filter(|t| t.iter().all(|v| (v[0] - at).abs() < tol))
        .count()
}

/// Within the lattice snap of the fixtures' 0.3 m and 1.2 m edges (about 1e-5
/// relative).
fn near(got: f64, expected: f64) -> bool {
    (got - expected).abs() < 1e-4 * expected
}

const LEFT: ([f64; 3], [f64; 3]) = ([0.0, 0.0, 0.0], [1.0, 0.3, 1.2]);

#[test]
fn boxes_one_lattice_cell_apart_merge_into_one_closed_component() {
    let gap = SNAP_GRID;
    let comps = vec![
        lattice_box(LEFT.0, LEFT.1),
        lattice_box([1.0 + gap, 0.0, 0.0], [2.0, 0.3, 1.2]),
    ];
    let merged = merge_abutting_components(comps);
    assert_eq!(merged.len(), 1, "the abutting pair is one component");
    assert!(closed(&merged[0]), "the merged cutter is closed");
    assert_eq!(
        faces_at_x(&merged[0], 1.0, 2.0 * gap),
        0,
        "no face left on the seam"
    );
    let v = signed_volume_of(&merged[0]);
    assert!(near(v, 2.0 * 0.3 * 1.2), "volume {v}: the gap is absorbed");
}

#[test]
fn boxes_with_exactly_coincident_faces_merge() {
    let comps = vec![
        lattice_box(LEFT.0, LEFT.1),
        lattice_box([1.0, 0.0, 0.0], [2.0, 0.3, 1.2]),
    ];
    let merged = merge_abutting_components(comps);
    assert_eq!(merged.len(), 1);
    assert!(closed(&merged[0]));
    assert_eq!(faces_at_x(&merged[0], 1.0, SNAP_GRID), 0);
}

#[test]
fn a_short_box_abutting_a_tall_one_keeps_the_jamb_above_it() {
    let gap = SNAP_GRID;
    let comps = vec![
        lattice_box(LEFT.0, LEFT.1),
        lattice_box([1.0 + gap, 0.0, 0.3], [1.6, 0.3, 0.9]),
    ];
    let merged = merge_abutting_components(comps);
    assert_eq!(merged.len(), 1);
    assert!(closed(&merged[0]));
    let on_seam: Vec<&Tri> = merged[0]
        .iter()
        .filter(|t| t.iter().all(|v| (v[0] - 1.0).abs() < 2.0 * gap))
        .collect();
    assert!(
        !on_seam.is_empty(),
        "the tall box's jamb above and below the short one stays"
    );
    for t in on_seam {
        let zc = (t[0][2] + t[1][2] + t[2][2]) / 3.0;
        assert!(
            !(0.3..0.9).contains(&zc),
            "a seam face inside the short box's height range: centroid z {zc}"
        );
    }
    let v = signed_volume_of(&merged[0]);
    assert!(near(v, 0.36 + 0.6 * 0.3 * 0.6), "volume {v}");
}

/// The refusal envelope: everything the one-cell rule must leave alone comes
/// back bit for bit, which is what makes an unchanged corpus row evidence that
/// the prepass did not touch it rather than evidence that it touched it
/// harmlessly.
#[test]
fn components_that_do_not_abut_come_back_bit_for_bit() {
    let gap = SNAP_GRID;
    let cases: [(&str, Vec<Vec<Tri>>); 4] = [
        (
            // A gap the snap cannot have produced from a flush pair near the
            // origin is in the input.
            "two lattice cells apart",
            vec![
                lattice_box(LEFT.0, LEFT.1),
                lattice_box([1.0 + 2.0 * gap, 0.0, 0.0], [2.0, 0.3, 1.2]),
            ],
        ),
        (
            "a ten-cell (160 um) pier",
            vec![
                lattice_box(LEFT.0, LEFT.1),
                lattice_box([1.0 + 160e-6, 0.0, 0.0], [2.0, 0.3, 1.2]),
            ],
        ),
        (
            "a corner contact, with no overlapping footprint",
            vec![
                lattice_box(LEFT.0, LEFT.1),
                lattice_box([1.0 + gap, 0.0, 1.2 + gap], [2.0, 0.3, 2.4]),
            ],
        ),
        (
            "a disjoint batch a millimetre apart",
            (0..4)
                .map(|i| {
                    let x = f64::from(i) * 1.001;
                    lattice_box([x, 0.0, 0.0], [x + 1.0, 0.3, 1.2])
                })
                .collect(),
        ),
    ];
    for (what, comps) in cases {
        let before = bits(&comps);
        assert_eq!(bits(&merge_abutting_components(comps)), before, "{what}");
    }
}

#[test]
fn a_merged_group_takes_its_first_members_slot() {
    let gap = SNAP_GRID;
    let comps = vec![
        lattice_box([5.0, 0.0, 0.0], [6.0, 0.3, 1.2]),
        lattice_box(LEFT.0, LEFT.1),
        lattice_box([8.0, 0.0, 0.0], [9.0, 0.3, 1.2]),
        lattice_box([1.0 + gap, 0.0, 0.0], [2.0, 0.3, 1.2]),
    ];
    let first = bits(&comps[..1]);
    let third = bits(&comps[2..3]);
    let after = merge_abutting_components(comps);
    assert_eq!(after.len(), 3);
    assert_eq!(bits(&after[..1]), first);
    assert_eq!(bits(&after[2..3]), third);
    assert!(near(signed_volume_of(&after[1]), 0.72));
}

/// Host: a 4 m x 0.3 m x 3 m wall; two through-cutters abutting at x = 0.2.
fn cut_wall(gap: f64) -> (Mesh, Mesh) {
    let host = mesh_box([-2.0, -0.15, -1.5], [2.0, 0.15, 1.5]);
    let left = mesh_box([-1.0, -0.5, -0.6], [0.2, 0.5, 0.6]);
    let right = mesh_box([0.2 + gap, -0.5, -0.6], [1.0, 0.5, 0.6]);
    let BatchSubtract::Cut(cut) = subtract_many(&host, &[&left, &right]) else {
        panic!("the batch conforms and changes the host");
    };
    (host, cut)
}

#[test]
fn subtract_many_cuts_abutting_cutters_without_a_sheet() {
    let (host, cut) = cut_wall(8e-6);
    let tris = mesh_to_tris(&cut);
    assert!(closed(&tris), "the cut is closed");
    let sheet = tris
        .iter()
        .filter(|t| {
            t.iter()
                .all(|v| (v[0] - 0.2).abs() < 1e-4 && v[2].abs() < 0.59)
        })
        .count();
    assert_eq!(sheet, 0, "faces left on the seam inside the opening");
    let removed = signed_volume_of(&mesh_to_tris(&host)) - signed_volume_of(&tris);
    assert!(near(removed, 2.0 * 0.3 * 1.2), "removed {removed}");
}

#[test]
fn subtract_many_keeps_a_pier_wider_than_a_snap_cell() {
    let (host, cut) = cut_wall(160e-6);
    let tris = mesh_to_tris(&cut);
    assert!(closed(&tris));
    let pier = tris
        .iter()
        .filter(|t| {
            t.iter()
                .all(|v| (v[0] - 0.2).abs() < 1e-3 && v[2].abs() < 0.59)
        })
        .count();
    assert!(pier >= 4, "both pier faces stand, {pier} seam triangles");
    let removed = signed_volume_of(&mesh_to_tris(&host)) - signed_volume_of(&tris);
    assert!(
        near(removed, (2.0 - 160e-6) * 0.3 * 1.2),
        "removed {removed}"
    );
}

/// An axis-aligned abutting pair centred on `x`: a 1 m cutter up to a plane the
/// f32 cast represents exactly, and its neighbour starting at the NEXT f32
/// above it. That is ONE authored plane read through two independent roundings,
/// which is all the quantisation can produce.
fn pair_abutting_at(x: f64) -> Vec<Vec<Tri>> {
    let seam = f64::from(x as f32);
    let next = seam + ulp32(x);
    vec![
        lattice_box([seam - 1.0, 0.0, 0.0], [seam, 0.3, 1.2]),
        lattice_box([next, 0.0, 0.0], [next + 1.0, 0.3, 1.2]),
    ]
}

/// The gap between the pair's facing seam coordinates in lattice cells, read
/// off the snapped operands through the same bounds helper the candidate gate
/// reads them off.
fn seam_gap_cells(comps: &[Vec<Tri>]) -> f64 {
    (tris_aabb(&comps[1]).0[0] - tris_aabb(&comps[0]).1[0]) / SNAP_GRID
}

/// Where the one-cell rule stops reaching, measured on the same authored pair
/// at three distances.
///
/// Near the origin the snap absorbs an f32 step, so two independent roundings
/// of one plane land on one lattice plane and the pair merges.
/// Past 128 caller units one f32 step is itself a multiple of the cell, the
/// snap cannot pull the two roundings together, and the gap arrives at eight
/// cells at 1.3 km and sixty-four at 10 km. The gate declines there: a gap that
/// wide is indistinguishable from a pier the caller authored, and welding it
/// would shrink a solid.
#[test]
fn the_one_cell_rule_declines_an_f32_step_in_the_far_field() {
    // At 0.8 m the step is a 256th of a cell, so the snap puts both roundings
    // on ONE lattice plane and the pair merges on coincident faces. Without
    // this the far cases below would pass for any reason.
    let pair = pair_abutting_at(0.8);
    assert_eq!(seam_gap_cells(&pair), 0.0, "the snap absorbs the step at 0.8 m");
    assert_eq!(
        merge_abutting_components(pair).len(),
        1,
        "the pair merges where the snap reaches"
    );

    for (at, x, cells) in [("1.3 km", 1_300.0, 8.0), ("10 km", 10_000.0, 64.0)] {
        let comps = pair_abutting_at(x);
        // The number the far-field argument rests on: the snap is inert here,
        // so the f32 step survives it whole.
        assert_eq!(seam_gap_cells(&comps), cells, "{at}: one f32 step in cells");
        let before = bits(&comps);
        #[cfg(feature = "opening-perf-trace")]
        crate::opening_perf_trace::take();
        assert_eq!(
            bits(&merge_abutting_components(comps)),
            before,
            "{at}: the operands must come back untouched"
        );
        #[cfg(feature = "opening-perf-trace")]
        {
            // Declined by the padded-AABB gate, whose pad IS the one cell, so
            // the pair never reaches the facing-plane census. Bit-identical
            // output alone cannot tell that from a group that formed and was
            // refused.
            let w = crate::opening_perf_trace::take();
            assert_eq!((w.abutting_no_facing_pair, w.abutting_groups), (0, 0), "{at}");
        }
    }
}

/// A neighbouring component that OVERLAPS one of the pair must not join their
/// group: its overlap would fail the group-wide volume gate and refuse the
/// merge for the pair that really does abut. Grouping on the facing-pair
/// relation rather than on AABB proximity is what keeps it out.
#[test]
fn an_overlapping_neighbour_does_not_refuse_the_abutting_pair() {
    let gap = SNAP_GRID;
    let comps = vec![
        // Overlaps LEFT by 2 cm, and has no facing plane pair with it.
        lattice_box([-0.98, 0.0, 0.0], [0.02, 0.3, 1.2]),
        lattice_box(LEFT.0, LEFT.1),
        lattice_box([1.0 + gap, 0.0, 0.0], [2.0, 0.3, 1.2]),
    ];
    let after = merge_abutting_components(comps);
    assert_eq!(after.len(), 2, "the abutting pair merged, the overlap did not");
    assert!(closed(&after[1]), "the merged cutter is closed");
    assert_eq!(
        faces_at_x(&after[1], 1.0, 2.0 * gap),
        0,
        "no face left on the seam"
    );
    assert!(near(signed_volume_of(&after[1]), 2.0 * 0.3 * 1.2));
}

/// A cutter mesh of two disjoint solids, as the footprint union emits for a
/// Z- or S-profile opening cluster.
fn two_solids(a: ([f64; 3], [f64; 3]), b: ([f64; 3], [f64; 3])) -> Vec<Tri> {
    let mut tris = lattice_box(a.0, a.1);
    tris.extend(lattice_box(b.0, b.1));
    tris
}

/// Group membership must not depend on the caller's cutter order. The facing
/// relation is symmetric by construction; an earlier revision answered it with
/// the weld's own conflict map, which is keyed on the mover's coordinates, so
/// the same two cutters merged in one order and not in the other.
#[test]
fn the_cutter_order_does_not_decide_whether_a_group_forms() {
    let g = SNAP_GRID;
    let a = || {
        two_solids(
            ([0.5, 0.0, 0.0], [2.0, 0.3, 0.6 - g]),
            ([-1.0, 0.0, 0.6 + g], [0.0, 0.3, 1.2]),
        )
    };
    let b = || {
        two_solids(
            ([-1.0, 0.0, 0.3], [0.0, 0.3, 0.6]),
            ([0.5, 0.0, 0.6], [2.0, 0.3, 0.9]),
        )
    };
    #[cfg(feature = "opening-perf-trace")]
    crate::opening_perf_trace::take();
    let forward = merge_abutting_components(vec![a(), b()]);
    #[cfg(feature = "opening-perf-trace")]
    let forward_groups = crate::opening_perf_trace::take().abutting_groups;
    let reversed = merge_abutting_components(vec![b(), a()]);
    #[cfg(feature = "opening-perf-trace")]
    {
        // Not vacuous: the pair really does reach the prepass in both orders.
        let reversed_groups = crate::opening_perf_trace::take().abutting_groups;
        assert_eq!((forward_groups, reversed_groups), (1, 1), "a group must form");
    }
    assert_eq!(
        forward.len(),
        reversed.len(),
        "order decided the outcome: {} vs {}",
        forward.len(),
        reversed.len()
    );
}

/// `b`'s coordinate 0.6 carries a `+z` face of one of its solids and a `-z`
/// face of the other, with anchors a cell below and a cell above. Honouring
/// both pulls is impossible in an unindexed soup, and honouring one shrinks
/// that solid by a cell and widens the other seam — an under-cut the volume
/// gate cannot see, because it reads the operands AFTER the weld. The class is
/// left alone instead, so the components come back untouched.
#[test]
fn a_coordinate_pulled_two_ways_from_two_components_is_left_alone() {
    let g = SNAP_GRID;
    let comps = vec![
        lattice_box([0.5, 0.0, 0.0], [2.0, 0.3, 0.6 - g]),
        lattice_box([-1.0, 0.0, 0.6 + g], [0.0, 0.3, 1.2]),
        two_solids(
            ([-1.0, 0.0, 0.3], [0.0, 0.3, 0.6]),
            ([0.5, 0.0, 0.6], [2.0, 0.3, 0.9]),
        ),
    ];
    let before = bits(&comps);
    #[cfg(feature = "opening-perf-trace")]
    crate::opening_perf_trace::take();
    assert_eq!(bits(&merge_abutting_components(comps)), before);
    #[cfg(feature = "opening-perf-trace")]
    {
        // Not vacuous: a group forms and is refused, rather than never forming.
        let w = crate::opening_perf_trace::take();
        assert_eq!((w.abutting_groups, w.abutting_merges), (1, 0));
    }
}

/// A component that shares the upper coordinate without a facing partner under
/// it must not be welded. `c` reaches the group through its `-z` abutment with
/// `b`, and its `-x` face happens to sit on the same coordinate as `b`'s, but
/// nothing on x = 1.0 faces it: it is above `a` entirely. Moving it would widen
/// `c` by a cell nobody authored, and the volume gate cannot see that, because
/// it reads the operands AFTER the weld.
#[test]
fn an_unanchored_face_sharing_the_coordinate_is_not_welded() {
    let g = SNAP_GRID;
    let comps = vec![
        lattice_box(LEFT.0, LEFT.1),
        lattice_box([1.0 + g, 0.0, 0.0], [2.0, 0.3, 1.2]),
        lattice_box([1.0 + g, 0.0, 1.2 + g], [2.0, 0.3, 2.0]),
    ];
    let authored: f64 = comps.iter().map(|c| signed_volume_of(c)).sum();
    let merged = merge_abutting_components(comps);
    assert_eq!(merged.len(), 1, "all three are one group");
    assert!(closed(&merged[0]), "the merged cutter is closed");
    // The two welds this group is for: `b`'s `-x` onto x = 1.0 across `a`'s
    // 0.3 x 1.2 face, and `c`'s `-z` onto z = 1.2 across `b`'s 1.0 x 0.3 face.
    let anchored = g * 0.3 * 1.2 + g * 1.0 * 0.3;
    let growth = signed_volume_of(&merged[0]) - authored;
    // The residual is the lattice snap of the authored edges, about 2e-11. The
    // unanchored weld this excludes is 3.7e-6, five orders larger.
    assert!(
        (growth - anchored).abs() < 1e-9,
        "grew {growth} m3; the anchored welds account for {anchored} m3"
    );
    assert!(
        !merged[0]
            .iter()
            .flatten()
            .any(|v| v[0] == 1.0 && v[2] > 1.2),
        "`c`'s `-x` face was welded onto x = 1.0 with nothing facing it"
    );
}

/// Two anchors in a chain must not move one cutter face twice. An earlier
/// revision welded pair by pair, each pair re-reading the geometry the last one
/// left, so this moved the face two cells and pushed it a cell INSIDE the first
/// anchor; the volume gate passed that overlap at 1.45e-6 relative.
#[test]
fn a_chain_of_anchors_moves_a_face_at_most_one_cell() {
    let g = SNAP_GRID;
    let comps = vec![
        lattice_box([0.0, 0.0, 0.6 + g], [1.0, 0.3, 1.2]),
        lattice_box([0.0, 0.0, 0.0], [1.0 - g, 0.3, 0.6]),
        lattice_box([1.0 + g, 0.0, 0.3], [2.0, 0.3, 1.2]),
    ];
    #[cfg(feature = "opening-perf-trace")]
    crate::opening_perf_trace::take();
    let merged = merge_abutting_components(comps);
    #[cfg(feature = "opening-perf-trace")]
    {
        // Not vacuous: all three really are one group, so the chain is live.
        let w = crate::opening_perf_trace::take();
        assert_eq!(w.abutting_groups, 1, "the chain must form one group");
    }
    for c in &merged {
        assert!(closed(c), "every component comes back closed");
        for t in c {
            for v in t {
                assert!(
                    v[0] <= 2.0 + g && v[0] >= -g,
                    "x {} left the authored span",
                    v[0]
                );
                // 1.0 - 2*g would be the two-cell overcorrection.
                assert!(
                    (v[0] - (1.0 - 2.0 * g)).abs() > g / 2.0,
                    "a face moved two cells, to {}",
                    v[0]
                );
            }
        }
    }
}

/// The prepass's outcomes are counted, so an unchanged corpus row can be told
/// apart from a row the prepass never looked at. `plane_weld`'s doc states the
/// rule: "the golden did not move" reads two ways, and inferring which from an
/// unchanged number is the shape this repo keeps rediscovering.
#[cfg(feature = "opening-perf-trace")]
#[test]
fn the_prepass_counts_its_candidates_refusals_and_merges() {
    let gap = SNAP_GRID;
    crate::opening_perf_trace::take();

    // One cell apart: one facing candidate, one group, one merge.
    let _ = merge_abutting_components(vec![
        lattice_box(LEFT.0, LEFT.1),
        lattice_box([1.0 + gap, 0.0, 0.0], [2.0, 0.3, 1.2]),
    ]);
    let w = crate::opening_perf_trace::take();
    assert_eq!((w.abutting_groups, w.abutting_merges), (1, 1));
    assert_eq!(w.abutting_no_facing_pair, 0);
    assert_eq!((w.abutting_refusals, w.abutting_budget_refusals), (0, 0));
    assert_eq!(
        w.abutting_groups,
        w.abutting_budget_refusals + w.abutting_refusals + w.abutting_merges,
        "every group has exactly one counted outcome"
    );

    // A corner contact is a padded-AABB candidate with no facing pair, so it
    // never forms a group. This is the outcome an unchanged output cannot show.
    let _ = merge_abutting_components(vec![
        lattice_box(LEFT.0, LEFT.1),
        lattice_box([1.0 + gap, 0.0, 1.2 + gap], [2.0, 0.3, 2.4]),
    ]);
    let w = crate::opening_perf_trace::take();
    assert_eq!(w.abutting_no_facing_pair, 1);
    assert_eq!((w.abutting_groups, w.abutting_merges), (0, 0));

    // A ten-cell pier is not even a candidate, so nothing is counted at all.
    let _ = merge_abutting_components(vec![
        lattice_box(LEFT.0, LEFT.1),
        lattice_box([1.0 + 160e-6, 0.0, 0.0], [2.0, 0.3, 1.2]),
    ]);
    let w = crate::opening_perf_trace::take();
    assert_eq!((w.abutting_no_facing_pair, w.abutting_groups), (0, 0));
}
