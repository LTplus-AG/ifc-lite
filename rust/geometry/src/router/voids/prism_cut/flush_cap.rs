// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! An end cap that is numerically flush with host faces.
//!
//! A cap that could not be extended has host material beyond it. Where that
//! material begins at a face in the cap's own plane (the interface between
//! two touching bodies of one host, or the floor of a recess the host already
//! has), face and cap agree only to f32 rounding: the cutter is f64, the host
//! f32. Which side of the cap each face vertex landed on then decided the
//! cut. A face of the material being removed that sat a rounding step outside
//! the prism was kept whole and the cap was built against it: a closed sheet
//! with no thickness where the opening should have reached the body behind.
//!
//! A flush face is read by the way it faces instead:
//!
//! - one facing away from the prism bounds material inside it, so it is cut.
//!   The cap plane is moved just past all such faces, which puts them
//!   strictly inside the prism;
//! - one facing the prism bounds material beyond the cap. It is the floor of
//!   the opening already: it passes through uncut, with everything else that
//!   lies wholly beyond the cap, and no cap is built over it.
//!
//! The side strips stop at the authored plane, so nothing is emitted between
//! it and the moved cap.
//!
//! A cap with only its floor in its plane removes nothing there: an opening
//! the host already has. Nor is a cap seated where a host face runs through
//! its plane over the footprint: material continues past the cap there with
//! no floor face, and a moved cap would cut into it. Both keep the plain cut.

use super::extension::{extend_prism_caps, tri_touches_slab_footprint};
use super::frame::PrismFrame;
use super::kit::{dot, lerp, norm, V2, V3};
use super::plane2::pip;
use super::ptri::PTri;
use crate::math::v3::tri_normal;

/// One seated end cap.
struct Seat {
    /// Depth at which the prism begins on this side: the authored cap plane,
    /// moved into the prism by the allowance. Host geometry wholly on the far
    /// side of it is beyond the cap.
    limit: f64,
    /// The far edge of the flush band: the authored plane, moved away from
    /// the prism by the allowance.
    band: f64,
    /// Footprints, in the profile plane, of the flush faces that face the
    /// prism.
    floor: Vec<[V2; 3]>,
}

/// The seated end caps of one prism: low depth side, then high.
#[derive(Default)]
pub(super) struct FlushSeats([Option<Seat>; 2]);

/// How far apart a cap and a host face in its plane can sit over the cap's
/// footprint when both store the same authored plane. Each is rounded to f32
/// at the model's coordinates, and the prism axis is fitted to the rounded
/// opening, so the two planes also tilt against each other by a rounding step
/// across the opening. A few f32 steps of the largest coordinate.
fn rounding_allowance(pf: &PrismFrame) -> f64 {
    (pf.corner_mag() * 4.0 * f64::from(f32::EPSILON)).max(1.0e-7)
}

/// How far outside the profile's bounding box a host triangle still counts as
/// over the footprint.
pub(super) fn footprint_pad(pf: &PrismFrame) -> f64 {
    1.0e-6 * (1.0 + pf.corner_mag())
}

/// The depth range of `t` over the profile's bounding box, or `None` when it
/// does not reach the box. A large host face is only as flush as it is over
/// the opening: its far corners can drift from the cap plane by the tilt.
fn depths_over_footprint(t: &PTri, pf: &PrismFrame, pad: f64) -> Option<(f64, f64)> {
    // (u, v, depth) polygon clipped by the four sides of the box.
    let mut poly: Vec<V3> = t.p.iter().map(|p| [dot(*p, pf.u), dot(*p, pf.v), dot(*p, pf.d)]).collect();
    for (axis, bound, keep_below) in [
        (0, pf.bb.0[0] - pad, false),
        (0, pf.bb.1[0] + pad, true),
        (1, pf.bb.0[1] - pad, false),
        (1, pf.bb.1[1] + pad, true),
    ] {
        let side = |p: &V3| if keep_below { p[axis] - bound } else { bound - p[axis] };
        let mut next = Vec::with_capacity(poly.len() + 1);
        for (i, a) in poly.iter().enumerate() {
            let b = &poly[(i + 1) % poly.len()];
            let (da, db) = (side(a), side(b));
            if da <= 0.0 {
                next.push(*a);
            }
            if (da <= 0.0) != (db <= 0.0) {
                next.push(lerp(*a, *b, da / (da - db)));
            }
        }
        poly = next;
        if poly.len() < 3 {
            return None;
        }
    }
    Some(poly.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), p| (lo.min(p[2]), hi.max(p[2]))))
}

/// Whether `t` faces along `+d` (`Some(true)`) or against it. `None` for a
/// triangle that is not roughly square to `d`: a sliver a fraction of a
/// micrometre tall lies within the allowance of a cap plane without being a
/// face in it, and its normal is noise.
fn faces_along(t: &PTri, d: V3) -> Option<bool> {
    let normal = tri_normal(t.p[0], t.p[1], t.p[2]);
    let turn = dot(normal, d);
    (turn.abs() > 0.5 * norm(normal)).then_some(turn > 0.0)
}

/// Extend the end caps of `pf` where the swept slab is empty, then seat each
/// cap that host faces lie flush with over its footprint.
pub(super) fn extend_and_seat_caps(pf: &mut PrismFrame, tris: &[PTri], aabbs: &[(V3, V3)]) -> FlushSeats {
    extend_prism_caps(pf, tris, aabbs);
    let allowance = rounding_allowance(pf);
    let pad = footprint_pad(pf);
    // The footprint clip does not depend on the cap: once per triangle, and
    // only for one whose vertex depths reach a cap's band, which bound the
    // clipped depths.
    let caps = [pf.d0(), pf.d1()];
    let near_a_cap = |t: &PTri| {
        let w = t.p.map(|p| dot(p, pf.d));
        let (lo, hi) = (w[0].min(w[1]).min(w[2]), w[0].max(w[1]).max(w[2]));
        caps.iter().any(|&plane| lo <= plane + allowance && hi >= plane - allowance)
    };
    let depths: Vec<_> =
        tris.iter().map(|t| if near_a_cap(t) { depths_over_footprint(t, pf, pad) } else { None }).collect();
    let mut seats = FlushSeats::default();
    for high in [false, true] {
        let (plane, slab) = if high { (pf.d1(), pf.profiles.len() - 1) } else { (pf.d0(), 0) };
        let mut reach = plane;
        let mut floor = Vec::new();
        let mut removes = false;
        let mut crossed = false;
        for (t, depth) in tris.iter().zip(&depths) {
            let Some((lo, hi)) = *depth else { continue };
            // Clear of the band: nothing to do with this cap.
            if hi < plane - allowance || lo > plane + allowance {
                continue;
            }
            let (below, above) = (lo < plane - allowance, hi > plane + allowance);
            let along = faces_along(t, pf.d);
            // Only side faces can carry material on through the plane, and
            // only cap-parallel faces are flush.
            if (below != above && along.is_some()) || (!below && !above && along.is_none()) {
                continue;
            }
            if !tri_touches_slab_footprint(t, pf, &pf.profiles[slab], f64::NEG_INFINITY, f64::INFINITY, pad) {
                continue;
            }
            // Through the plane: in one triangle, or as a side face that ends
            // in the band strictly inside the footprint, where its mesh may
            // be split at the plane and carry on in the next triangle.
            if below || above {
                if (below && above) || depths_over_footprint(t, pf, -pad).is_some() {
                    crossed = true;
                    break;
                }
                continue;
            }
            // Facing the prism: along +d at the low cap, against it at the high.
            match along {
                Some(along) if along != high => floor.push(t.p.map(|p| pf.to2(p))),
                Some(_) => removes = true,
                None => continue,
            }
            reach = if high { reach.max(hi) } else { reach.min(lo) };
        }
        // Only a floor in the plane, or a face through it: the plain cut
        // (module doc).
        if !removes || crossed {
            continue;
        }
        // Past the farthest flush face by a fraction of an f32 step: far
        // above f64 noise, and it is the most the cut can reach into material
        // beyond the cap where no flush face floors it.
        let margin = allowance / 16.0;
        seats.0[usize::from(high)] = Some(if high {
            let last = pf.planes.len() - 1;
            pf.planes[last] = reach + margin;
            Seat { limit: plane - allowance, band: plane + allowance, floor }
        } else {
            pf.planes[0] = reach - margin;
            Seat { limit: plane + allowance, band: plane - allowance, floor }
        });
    }
    seats
}

impl FlushSeats {
    /// Whether `t`, with vertex depths `w`, lies outside the depth range the
    /// prism cuts: clear of both caps, or beyond a seated cap over the whole
    /// footprint without being a flush face of the material inside. `pad` is
    /// [`footprint_pad`] of `pf`.
    pub(super) fn beyond_caps(&self, pf: &PrismFrame, t: &PTri, w: [f64; 3], pad: f64) -> bool {
        if w[0].max(w[1]).max(w[2]) < pf.d0() || w[0].min(w[1]).min(w[2]) > pf.d1() {
            return true;
        }
        if self.0.iter().all(Option::is_none) {
            return false;
        }
        let Some((lo, hi)) = depths_over_footprint(t, pf, pad) else {
            return false; // clear of the profile: the cut passes it through
        };
        let beyond = |seat: &Seat, high: bool| {
            let (past, flush) = if high {
                (lo >= seat.limit, hi <= seat.band)
            } else {
                (hi <= seat.limit, lo >= seat.band)
            };
            // Facing away from the prism: against +d at the low cap.
            past && !(flush && faces_along(t, pf.d) == Some(high))
        };
        self.0[0].as_ref().is_some_and(|seat| beyond(seat, false))
            || self.0[1].as_ref().is_some_and(|seat| beyond(seat, true))
    }

    /// Whether the end cap (`high` picks which) is already floored at `q` by
    /// a flush host face.
    pub(super) fn floored(&self, high: bool, q: V2) -> bool {
        self.0[usize::from(high)].as_ref().is_some_and(|seat| seat.floor.iter().any(|tri| pip(q, tri)))
    }

    /// Whether cap plane `j` of a prism whose last plane is `last` is floored
    /// at `q`. Only end caps are seated, so an end cap is not built where a
    /// flush host face floors it.
    pub(super) fn floors_cap(&self, j: usize, last: usize, q: V2) -> bool {
        (j == 0 && self.floored(false, q)) || (j == last && self.floored(true, q))
    }

    /// Whether a side strip is emitted at depth `w`: not in the allowance
    /// between a moved cap and its authored plane.
    pub(super) fn strip_reaches(&self, w: f64) -> bool {
        self.0[0].as_ref().is_none_or(|seat| w > seat.limit) && self.0[1].as_ref().is_none_or(|seat| w < seat.limit)
    }
}
