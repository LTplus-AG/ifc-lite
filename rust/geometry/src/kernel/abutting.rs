// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cutter components that abut on the snap lattice merge into one closed
//! component before the N-ary subtract.
//!
//! `mesh_bridge::subtract_many` arranges host against cutters only, and its
//! classifier keeps a cutter face that lies inside the host without asking
//! whether it also lies inside another cutter. Two components whose facing
//! planes coincide after the snap therefore both keep their face on the shared
//! plane, and two components a lattice cell apart leave a closed sliver of host
//! standing between them (#8156). Both are one authored geometry: openings that
//! abut, placed through independent f32 roundings.
//!
//! Facing axis-aligned planes at most one [`SNAP_GRID`] cell apart are welded
//! onto one plane and the group is unioned in one N-ary arrangement, whose
//! classifier drops the faces interior to the union. A group whose union does
//! not come back conforming, closed and volume-exact is left as it was, so the
//! subtract never does worse than before. The union also runs under a budget
//! snapshot: a speculative arrangement must not spend the caller's #1109
//! allowance, or a REFUSED merge would still push the element into
//! `csg::group_cut`'s AABB box-cut.
//!
//! ## One cell is a rule for operands near the origin
//!
//! `mesh_to_tris` rounds every coordinate to the cell, so near the origin two
//! faces authored flush but rounded independently land on one lattice plane or
//! on two adjacent ones, and a wider gap really was in the input. That argument
//! runs out where the snap does: past |c| = 128 caller units the f32 spacing is
//! itself a multiple of the cell and the snap is INERT ([`SNAP_GRID`]'s own
//! doc), so from about 256 units out two roundings of ONE true coordinate sit
//! two cells apart, eight at 1.3 km, sixty-four at 8.7 km. There this gate
//! declines to weld a gap the quantisation created.
//! `tests::the_one_cell_rule_declines_an_f32_step_in_the_far_field` is where
//! those cell counts are measured rather than argued: ONE axis-aligned abutting
//! pair at 0.8 m, 1.3 km and 10 km, the gap read off the snapped operands,
//! merged where the snap still reaches it and untouched where it does not.
//!
//! The direction is safe — a threshold tighter than the real noise never welds
//! a feature that is really there, it only fails to close a seam — but it is not
//! general. `near_band` does model the far field (f32 scatter as
//! `extent * 2^-22`) and a first revision used it; that also merged a wall with
//! an authored 68 um pier under a sloped top and made its tessellation worse.
//! Widening this again means solving the pier case first.
//!
//! ## Limits, all of them conservative
//!
//! - Only axis-aligned planes are welded: the census takes a triangle only when
//!   its three vertices share the coordinate bit for bit, read off the operand
//!   as the snap left it. A plan-rotated wall still has its top and bottom
//!   faces, since the rotation is about z, but its SEAM faces are off-axis and
//!   no distance makes them weldable.
//! - Grouping is by the facing-pair relation, not proximity, so a merely nearby
//!   OVERLAPPING component cannot drag a pair into a group its own overlap would
//!   then refuse. A pair that both abuts and overlaps still refuses.
//! - A weld moves every vertex of the moving component at that coordinate, not
//!   just the matched face's: the operand is an unindexed soup, so moving one
//!   face's triangles alone would tear them off the side walls sharing those
//!   positions. An unrelated face of the same component at that coordinate moves
//!   too, by at most one cell. What a component DOES need to move at all is a
//!   `+k` face matched within the cell below, so a member that reached the
//!   group through another axis is not dragged along by a coordinate it merely
//!   shares; it still welds on the axis it does abut on. The match is per
//!   component and per coordinate, and it reads per-plane footprint BOUNDS, so
//!   both coarsenesses stay inside the one-cell growth bound rather than being
//!   excluded by it.
//! - Each axis is planned whole, and a class of coordinates is welded only in
//!   the shape a snap can produce from ONE authored plane: exactly two
//!   coordinates, at most a cell apart, the lower carrying `+k` faces only and
//!   the upper `-k` faces only, no component spanning both. A third coordinate
//!   in the chain, or one coordinate carrying both sides, is a pull two ways at
//!   once that a soup cannot honour, so it is left alone — two abutting
//!   Z-profile cutters sharing such a coordinate are given up on purpose,
//!   because welding one way shrinks a solid by a cell and widens the other
//!   seam where the volume gate, reading post-weld operands, cannot see it.
//! - No `+k` face ever moves, so nothing shrinks and a weld cannot create an
//!   overlap. That is what lets the volume gate run at 1e-9 and bound something.

use super::arrangement::{union_all, Tri};
use super::broadphase::{tris_aabb, Aabb};
use super::budget;
use super::mesh_bridge::SNAP_GRID;
use super::signed_volume::{signed_volume6_about, volume_reference};
use crate::union_find::UnionFind;
use std::borrow::Cow;
use weld::{face_each_other, weld_facing_planes};

#[path = "abutting_weld.rs"]
mod weld;

/// Merge cutter components whose facing planes are at most one lattice cell
/// apart into one closed component each. Components that do not abut, and
/// groups whose union is refused, come back untouched and in their original
/// order.
pub(crate) fn merge_abutting_components(comps: Vec<Vec<Tri>>) -> Vec<Vec<Tri>> {
    let n = comps.len();
    if n < 2 {
        return comps;
    }
    let aabbs: Vec<Aabb> = comps.iter().map(|c| tris_aabb(c)).collect();
    // Group by the FACING-PAIR relation, not by proximity. A component that
    // merely sits within a cell of the group — a neighbouring opening that
    // overlaps it, say — must not join it: its overlap would fail the group's
    // volume gate and refuse the merge for every member, including the pair
    // that really does abut.
    let mut groups = UnionFind::new(n);
    let mut grouped = false;
    for i in 0..n {
        for j in (i + 1)..n {
            if !abut_candidates(&aabbs[i], &aabbs[j]) {
                continue;
            }
            if face_each_other(&comps[i], &comps[j]) {
                groups.union(i as u32, j as u32);
                grouped = true;
            } else {
                #[cfg(feature = "opening-perf-trace")]
                crate::opening_perf_trace::record(|c| {
                    c.abutting_no_facing_pair = c.abutting_no_facing_pair.saturating_add(1);
                });
            }
        }
    }
    // The disjoint batch the router groups by snap-band-inflated AABBs: a
    // millimetre of pad against a cell of 15 um, so no group forms and the
    // caller's components come back as they arrived, with nothing copied.
    if !grouped {
        return comps;
    }
    // Members in ascending component order, keyed by their set's root, so the
    // groups reach `merge_group` in the same order on every target. Hash order
    // would not do: a union that trips its budget must refuse the same group
    // on every run and on every target.
    let mut members_of: Vec<Vec<usize>> = vec![Vec::new(); n];
    for i in 0..n {
        members_of[groups.find(i as u32) as usize].push(i);
    }
    // A merged group takes its first member's slot and its other members go
    // away; a refused group keeps every member where it was, so a refusal is
    // bit-identical to no merge at all.
    let mut slots: Vec<Option<Vec<Tri>>> = comps.into_iter().map(Some).collect();
    for members in members_of.iter().filter(|m| m.len() >= 2) {
        #[cfg(feature = "opening-perf-trace")]
        crate::opening_perf_trace::record(|c| {
            c.abutting_groups = c.abutting_groups.saturating_add(1);
        });
        let group: Vec<&[Tri]> = members
            .iter()
            .map(|&i| slots[i].as_deref().expect("a component is in one group"))
            .collect();
        let merged = merge_group(&group);
        #[cfg(feature = "opening-perf-trace")]
        crate::opening_perf_trace::record(|c| {
            c.abutting_merges = c.abutting_merges.saturating_add(u64::from(merged.is_some()));
        });
        if let Some(merged) = merged {
            slots[members[0]] = Some(merged);
            for &i in &members[1..] {
                slots[i] = None;
            }
        }
    }
    slots.into_iter().flatten().collect()
}

/// Two components can only abut when their AABBs, each inflated by one lattice
/// cell, still overlap on all three axes.
fn abut_candidates(a: &Aabb, b: &Aabb) -> bool {
    (0..3).all(|k| a.0[k] - SNAP_GRID <= b.1[k] && b.0[k] - SNAP_GRID <= a.1[k])
}

/// Union one abutting group: weld, N-ary union, then the acceptance checks.
/// `None` when the union is not trustworthy, in which case the caller keeps the
/// group's members exactly as they were.
fn merge_group(members: &[&[Tri]]) -> Option<Vec<Tri>> {
    // Borrowed until a weld actually moves a plane, so a refusal costs no copy.
    let mut ops: Vec<Cow<'_, [Tri]>> = members.iter().copied().map(Cow::Borrowed).collect();
    if !weld_facing_planes(&mut ops) {
        // Grouping already found a facing pair, so this is the narrow case
        // where welding an earlier axis moved a marginal footprint out of
        // overlap. Counted with the other post-grouping refusals: a refusal
        // the counters cannot see is the thing they exist to prevent.
        #[cfg(feature = "opening-perf-trace")]
        crate::opening_perf_trace::record(|c| {
            c.abutting_refusals = c.abutting_refusals.saturating_add(1);
        });
        return None;
    }
    let refs: Vec<&[Tri]> = ops.iter().map(Cow::as_ref).collect();
    // The prepass is speculative, so its arrangement is not charged to the
    // caller's budget — `batch_oracle` snapshots around its volume oracle for
    // the same reason (codex P2 on #1660). Without this, a merge that is
    // REFUSED still leaves the caller tripped, and `csg::group_cut` turns any
    // post-call trip into `GroupReject::BudgetTripped` and box-cuts the
    // element: strictly worse than not having tried. A trip DURING the union
    // makes its result untrustworthy, so it refuses.
    let snap = budget::snapshot_counters();
    let (merged, conforming) = union_all(&refs);
    let tripped = budget::tripped();
    budget::restore_counters(snap);
    if tripped {
        #[cfg(feature = "opening-perf-trace")]
        crate::opening_perf_trace::record(|c| {
            c.abutting_budget_refusals = c.abutting_budget_refusals.saturating_add(1);
        });
        return None;
    }
    // `strict_closed` is the crate's exact directed-edge incidence: every
    // geometric edge used once forward and once back, signed zero folded.
    if !conforming || !crate::exact_topology::strict_closed(merged.iter().copied()) {
        #[cfg(feature = "opening-perf-trace")]
        crate::opening_perf_trace::record(|c| {
            c.abutting_refusals = c.abutting_refusals.saturating_add(1);
        });
        return None;
    }
    // The weld only ever moves a `-k` face ONTO the `+k` plane it faces, so the
    // welded members touch rather than overlap and the union's volume is their
    // sum. Anything else means a face was classified wrongly, or that the
    // members overlapped to begin with. Both sides are read about ONE point, as
    // `signed_volume6_about` requires: each list's own AABB centre would leave
    // the members' flux in the difference.
    //
    // The tolerance has to be tight enough to bound a real error rather than
    // just gross overlap. The arrangement is exact, so a correct touching union
    // matches to about 1e-15 relative (measured 2e-16 on the fixtures); one
    // cell of accidental overlap over an opening-sized face is about 1e-6
    // relative, which a 1e-4 gate waved through. 1e-9 separates them with three
    // orders of headroom over the f64 summation error.
    let o = volume_reference(&merged);
    let expected: f64 = ops.iter().map(|c| signed_volume6_about(c, &o)).sum();
    let got = signed_volume6_about(&merged, &o);
    if (got - expected).abs() > 1.0e-9 * expected.abs() {
        #[cfg(feature = "opening-perf-trace")]
        crate::opening_perf_trace::record(|c| {
            c.abutting_refusals = c.abutting_refusals.saturating_add(1);
        });
        return None;
    }
    Some(merged)
}

#[cfg(test)]
#[path = "abutting_tests.rs"]
mod tests;
