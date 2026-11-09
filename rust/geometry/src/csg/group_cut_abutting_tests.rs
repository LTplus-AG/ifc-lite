// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #8190 2c: an abutting cutter pair split across the 16-cutter chunk boundary.
//!
//! The abutting prepass runs inside `subtract_many`, so it only sees one
//! chunk. The control puts the pair in one chunk; the split arm puts the
//! partner 16 cutters later, in the second chunk, where it is cut against the
//! first chunk's intermediate.

use super::*;
use crate::kernel::arrangement::box_mesh;
use crate::kernel::mesh_bridge::{mesh_to_tris, tris_to_mesh};
use crate::kernel::signed_volume::signed_volume_of;

fn mesh_box(lo: [f64; 3], hi: [f64; 3]) -> Mesh {
    tris_to_mesh(&box_mesh(lo, hi))
}

/// A 35 m wall, 0.3 m thick and 3 m tall, along x.
fn wall() -> Mesh {
    mesh_box([-2.0, -0.15, -1.5], [33.0, 0.15, 1.5])
}

/// Two through-cutters abutting at x = 0.2 with `gap` between them, and
/// `others` disjoint 1 m through-cutters further along the wall. The partner
/// of the pair comes LAST, so with 15 others it is the 17th cutter.
fn cutters(gap: f64, others: usize) -> Vec<Mesh> {
    let mut v = vec![mesh_box([-1.0, -0.5, -0.6], [0.2, 0.5, 0.6])];
    v.extend((0..others).map(|i| {
        let x = 2.0 + 2.0 * i as f64;
        mesh_box([x, -0.5, -0.6], [x + 1.0, 0.5, 0.6])
    }));
    v.push(mesh_box([0.2 + gap, -0.5, -0.6], [1.0, 0.5, 0.6]));
    v
}

/// Triangles on the seam plane within the opening (sill to head inclusive,
/// through the wall's thickness): a sheet of host left standing between the
/// pair. A sheet spans the whole opening, so its corners sit ON z = +-0.6.
fn seam_faces(cut: &Mesh) -> usize {
    mesh_to_tris(cut)
        .iter()
        .filter(|t| {
            t.iter().all(|v| (v[0] - 0.2).abs() < 1e-3 && v[2].abs() <= 0.6 + 1e-4 && v[1].abs() <= 0.15 + 1e-4)
        })
        .count()
}

/// (seam triangles, removed volume, strictly closed, closed within a hairline).
fn cut(gap: f64, others: usize) -> (usize, f64, bool, bool) {
    let host = wall();
    let cutters = cutters(gap, others);
    let refs: Vec<&Mesh> = cutters.iter().collect();
    let GroupCut::Cut(cut) = ClippingProcessor::new().subtract_mesh_many(&host, &refs) else {
        panic!("{} cutters: the group cuts", refs.len());
    };
    let closed = crate::exact_topology::strict_closed_mesh(&cut);
    let hairline = crate::mesh_check::closed_or_hairline(&cut);
    let removed = signed_volume_of(&mesh_to_tris(&host)) - signed_volume_of(&mesh_to_tris(&cut));
    (seam_faces(&cut), removed, closed, hairline)
}

/// Both gaps the prepass welds in one chunk: under a cell, and exactly one.
/// The split arm must cut the same: the second chunk's lone partner is
/// promoted onto the faces the first chunk's cut left on the seam plane, so
/// the abutment is closed without the prepass ever seeing the pair.
#[test]
fn an_abutting_pair_split_across_chunks_cuts_like_one_chunk() {
    for gap in [8e-6, crate::kernel::mesh_bridge::SNAP_GRID] {
        let (one_chunk, _, closed, _) = cut(gap, 14);
        assert!(closed, "gap {gap}: the one-chunk cut is closed");
        assert_eq!(one_chunk, 0, "gap {gap}: control, one chunk leaves no sheet on the seam");
        let (split, removed, closed, _) = cut(gap, 15);
        assert!(closed, "gap {gap}: the split cut is closed");
        let expected = (2.0 + 15.0) * 0.3 * 1.2;
        assert!(
            (removed - expected).abs() < 1e-4 * expected,
            "gap {gap}: split removed {removed}, expected {expected}"
        );
        assert_eq!(split, 0, "gap {gap}: split across chunks, a sheet stands on the seam");
    }
}

/// The control that makes the zero above mean something: a 160 um pier, ten
/// cells wide, is authored geometry, and its two faces are counted on the seam
/// in both arms. Through the processor's consolidation this pier comes back
/// closed within a hairline but not bit for bit, so that is what is asserted
/// (`subtract_many_keeps_a_pier_wider_than_a_snap_cell` covers the raw cut).
#[test]
fn a_pier_between_the_pair_is_seen_in_both_arms() {
    for others in [14, 15] {
        let (pier, _, _, hairline) = cut(160e-6, others);
        assert!(hairline, "{} cutters: the pier cut is closed within a hairline", others + 2);
        assert!(pier >= 4, "{} cutters: both pier faces stand, {pier} seam triangles", others + 2);
    }
}
