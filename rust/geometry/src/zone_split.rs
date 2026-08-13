// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cut one element into one solid per location zone (issue #2508 item 2).
//!
//! #2515 answers "how much of this wall is in Takt A" with a number, by
//! integrating the zone's indicator function over the element's own boundary.
//! That is the right tool for a quantity and it produces no geometry at all:
//! there is nothing to look at, select, or export as a per-section model. This
//! module produces the geometry, on the explicit request of a user who asked
//! for it.
//!
//! ## Why this is a kernel call and not new geometry code
//!
//! Clipping a solid to a convex box is an INTERSECTION against a convex
//! operand, which is strictly easier than the general difference the exact
//! kernel already runs on every opening void of every model. So each piece is
//! one `boolean(host, box, Intersection)`, and the remainder is one
//! `difference_all` against every box at once. Nothing here re-derives cutting,
//! capping or classification.
//!
//! ## Two decisions worth stating
//!
//! - **One arrangement per piece, N+1 in total, not N composed operations.**
//!   Composing (cut by A, then cut the rest by B, ...) feeds each step the
//!   PREVIOUS step's output, so every cut re-snaps and re-jitters seams the
//!   last one made. Each piece instead arranges the ORIGINAL host against one
//!   box, and the remainder arranges the original host against all the boxes
//!   together.
//! - **f64 from end to end.** Operands stay `Tri` (f64) for the whole split and
//!   only reach `Mesh` (f32) at the caller's boundary. A per-piece f64 -> f32 ->
//!   f64 round trip is what turns a shared zone boundary into a crack.

use crate::kernel::arrangement::{boolean, box_mesh, difference_all, union_all, BoolOp, Tri};
use crate::kernel::mesh_bridge::orient_outward;
use crate::kernel::signed_volume::signed_volume_of;

/// A zone as the viewer authors it: an oriented box that rotates about the
/// VERTICAL axis only. Coordinates are the caller's frame; the viewer passes
/// its Y-up render frame, and nothing here assumes which axis is up except
/// `rotation_axis`.
#[derive(Clone, Copy, Debug)]
pub struct ZoneBox {
    pub center: [f64; 3],
    /// FULL extents along the box's own local axes, matching the viewer's
    /// `Zone.size` (not half-extents).
    pub size: [f64; 3],
    /// Rotation about the vertical axis, radians.
    pub rotation_y: f64,
}

/// What a zone actually is: v1's oriented box, or the convex prism #2508 item 4
/// adds. Both are convex, which is what keeps each piece one intersection.
#[derive(Clone, Debug)]
pub enum ZoneShape {
    Box(ZoneBox),
    /// A vertical prism over a CONVEX footprint in the caller's X/Z plane. The
    /// convexity is the caller's guarantee (the viewer gates it at import);
    /// a concave polygon fans into overlapping triangles and would cut wrong.
    Prism {
        footprint: Vec<[f64; 2]>,
        min_y: f64,
        max_y: f64,
    },
}

impl ZoneShape {
    fn to_tris(&self) -> Vec<Tri> {
        match self {
            ZoneShape::Box(b) => b.to_tris(),
            ZoneShape::Prism { footprint, min_y, max_y } => prism_tris(footprint, *min_y, *max_y),
        }
    }

    fn world_aabb(&self) -> ([f64; 3], [f64; 3]) {
        match self {
            ZoneShape::Box(b) => b.world_aabb(),
            ZoneShape::Prism { footprint, min_y, max_y } => {
                let mut lo = [f64::INFINITY, *min_y, f64::INFINITY];
                let mut hi = [f64::NEG_INFINITY, *max_y, f64::NEG_INFINITY];
                for p in footprint {
                    lo[0] = lo[0].min(p[0]);
                    hi[0] = hi[0].max(p[0]);
                    lo[2] = lo[2].min(p[1]);
                    hi[2] = hi[2].max(p[1]);
                }
                (lo, hi)
            }
        }
    }
}

/// A convex footprint extruded between two heights: a triangle fan per cap and
/// two triangles per side. Winding is CONSISTENT rather than provably outward,
/// which is all the kernel needs -- `orient_outward` flips the whole operand if
/// the signed volume comes out negative.
fn prism_tris(footprint: &[[f64; 2]], min_y: f64, max_y: f64) -> Vec<Tri> {
    let n = footprint.len();
    if n < 3 {
        return Vec::new();
    }
    let lo = |i: usize| [footprint[i][0], min_y, footprint[i][1]];
    let hi = |i: usize| [footprint[i][0], max_y, footprint[i][1]];
    let mut tris = Vec::with_capacity(4 * n);
    for i in 1..n - 1 {
        tris.push([lo(0), lo(i + 1), lo(i)]);
        tris.push([hi(0), hi(i), hi(i + 1)]);
    }
    for i in 0..n {
        let j = (i + 1) % n;
        tris.push([lo(i), lo(j), hi(j)]);
        tris.push([lo(i), hi(j), hi(i)]);
    }
    tris
}

impl ZoneBox {
    /// The box as an outward-wound triangle soup in world coordinates.
    fn to_tris(self) -> Vec<Tri> {
        let h = [self.size[0] / 2.0, self.size[1] / 2.0, self.size[2] / 2.0];
        let local = box_mesh([-h[0], -h[1], -h[2]], [h[0], h[1], h[2]]);
        let (sin, cos) = self.rotation_y.sin_cos();
        local
            .into_iter()
            .map(|t| {
                t.map(|p| {
                    [
                        self.center[0] + p[0] * cos - p[2] * sin,
                        self.center[1] + p[1],
                        self.center[2] + p[0] * sin + p[2] * cos,
                    ]
                })
            })
            .collect()
    }

    /// World-space axis-aligned bounds, for the cheap reject below.
    fn world_aabb(self) -> ([f64; 3], [f64; 3]) {
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        for t in self.to_tris() {
            for p in t {
                for k in 0..3 {
                    lo[k] = lo[k].min(p[k]);
                    hi[k] = hi[k].max(p[k]);
                }
            }
        }
        (lo, hi)
    }
}

/// One solid produced by the split.
#[derive(Clone, Debug)]
pub struct ZonePiece {
    /// Index into the `zones` slice, or `None` for the remainder (the part of
    /// the element inside no zone).
    pub zone: Option<usize>,
    pub tris: Vec<Tri>,
    /// Enclosed volume of THIS piece, from the same divergence sum the kernel
    /// uses for a whole element.
    pub volume: f64,
}

/// The whole split of one element.
#[derive(Clone, Debug)]
pub struct ZoneSplit {
    /// Non-empty pieces only, in zone order, remainder last.
    pub pieces: Vec<ZonePiece>,
    /// Enclosed volume of the input, so a caller can check the pieces against
    /// it without re-deriving it from a different producer.
    pub whole_volume: f64,
}

impl ZoneSplit {
    /// How far the pieces are from summing to the whole, RELATIVE to the whole.
    ///
    /// The invariant #2508 puts above every other for this feature. Exposed
    /// rather than asserted here: a caller that wants to refuse an untrustworthy
    /// split needs the number, and a caller displaying a warning needs it too.
    pub fn sum_error_rel(&self) -> f64 {
        if self.whole_volume.abs() <= f64::MIN_POSITIVE {
            return 0.0;
        }
        let sum: f64 = self.pieces.iter().map(|p| p.volume).sum();
        ((sum - self.whole_volume) / self.whole_volume).abs()
    }
}

/// A piece whose volume is below this fraction of the whole is dropped.
///
/// The kernel can return a few slivers where two zone boxes share a boundary
/// plane, and a piece of a nanolitre is not a piece: it is noise a user would
/// have to identify and delete by hand. Matches the intent of the
/// apportionment path's own negligible-share threshold, one level up.
pub const NEGLIGIBLE_PIECE_REL: f64 = 1e-9;

/// Split `host` into one solid per zone it reaches, plus the remainder.
///
/// `host` must be a closed orientable solid; the caller is responsible for that
/// gate (in the viewer, the same `GeometryClosure` proof that gates a stated
/// volume at all). Winding need not be outward: each operand is oriented before
/// it enters the arrangement, exactly as `subtract` / `intersection` do.
///
/// Zones that cannot reach the host's bounds are skipped without touching a
/// triangle, so the cost is `O(triangles x zones the element actually reaches)`.
///
/// Zones are expected to be pairwise non-overlapping, the same contract
/// `subtract_many` states for its cutter group. Nothing forbids a user drawing
/// overlapping zones, and the failure is not silent: overlapping pieces
/// double-count, so [`ZoneSplit::sum_error_rel`] rises far above any floating
/// point residue and the caller can refuse on it. That is the same signal the
/// apportionment path reports as `overlapping`.
pub fn split_mesh_by_zones(host: &[Tri], zones: &[ZoneShape]) -> ZoneSplit {
    let host = orient_outward(host.to_vec());
    let whole_volume = signed_volume_of(&host);
    let negligible = whole_volume.abs() * NEGLIGIBLE_PIECE_REL;
    let (host_lo, host_hi) = tris_aabb(&host);

    let mut pieces = Vec::new();
    let mut reached: Vec<Vec<Tri>> = Vec::new();
    for (index, zone) in zones.iter().enumerate() {
        let (lo, hi) = zone.world_aabb();
        if (0..3).any(|k| lo[k] > host_hi[k] || hi[k] < host_lo[k]) {
            continue;
        }
        let box_tris = orient_outward(zone.to_tris());
        let piece = boolean(&host, &box_tris, BoolOp::Intersection);
        let volume = signed_volume_of(&piece);
        if piece.is_empty() || volume <= negligible {
            // NOT subtracted from the remainder. A zone the element merely
            // abuts takes nothing, so leaving it out cannot double-count: the
            // sliver simply stays in the remainder and the sum stays exact.
            // Subtracting it would instead feed the arrangement an
            // exactly-coplanar operand with no intersection to show for it,
            // which is the kernel's hardest case for no benefit.
            continue;
        }
        reached.push(box_tris);
        pieces.push(ZonePiece { zone: Some(index), tris: piece, volume });
    }

    if !reached.is_empty() {
        // UNIONED first, then subtracted as ONE operand.
        //
        // `difference_all` requires its cutters to be pairwise disjoint, and a
        // zone set that TILES shares boundary planes: two coincident,
        // opposite-wound cutter faces at each shared plane are classified only
        // against the host, so both survive into the result as a zero-volume
        // membrane inside the remainder. The volume is unaffected (the pair
        // cancels), which is exactly why no volume-based check can see it --
        // but the remainder is published as a closed solid, and a consumer that
        // renders or exports it would show a phantom wall at every zone
        // boundary. `union_all` merges the tiles first and drops each
        // co-oriented duplicate, so the difference sees one clean operand.
        let operands: Vec<&[Tri]> = reached.iter().map(|t| t.as_slice()).collect();
        let (cutter, _conforming) = union_all(&operands);
        if let Some(rest) = difference_all(&host, &[&cutter]) {
            let volume = signed_volume_of(&rest);
            if !rest.is_empty() && volume > negligible {
                pieces.push(ZonePiece { zone: None, tris: rest, volume });
            }
        }
    } else {
        // No zone reaches the element at all, so all of it is the remainder.
        // Returning nothing here would state that the element vanished.
        pieces.push(ZonePiece { zone: None, tris: host, volume: whole_volume });
    }

    ZoneSplit { pieces, whole_volume }
}

fn tris_aabb(tris: &[Tri]) -> ([f64; 3], [f64; 3]) {
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for t in tris {
        for p in t {
            for k in 0..3 {
                lo[k] = lo[k].min(p[k]);
                hi[k] = hi[k].max(p[k]);
            }
        }
    }
    (lo, hi)
}

#[cfg(test)]
#[path = "zone_split_tests.rs"]
mod tests;
