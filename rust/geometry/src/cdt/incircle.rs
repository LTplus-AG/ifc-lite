// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shewchuk's adaptive in-circle test with stage-B scratch sized to fit.
//!
//! `geometry_predicates::incircleadapt` declares every scratch expansion of
//! all its stages up front, including two 1152-entry `fin` buffers that only
//! stage C can fill, and zeroes about 20 KB per call. Stage A rejects most
//! calls; the adaptive ones are nearly cocircular, and the CDT meets them in
//! bulk wherever collinear vertices sit on a constraint (#9016: the T-junction
//! vertices of #8421 added 21k such calls on ISSUE_129). Most of them finish in
//! stage B, where the largest expansion has 96 entries, so the zeroing was
//! most of their cost.
//!
//! [`incircle`] runs stage A, stage B and the exact zero-tail return with the
//! same public expansion routines, in the same order, as the crate, so it
//! returns the bit-identical `f64`. What stage B cannot decide continues from
//! stage B's own state into stages C and D ([`tail`]), which keep the crate's
//! operations but reuse this thread's `fin` scratch instead of zeroing 18 KB
//! per call. That path was not rare: on ISSUE_129 43k calls reached it and
//! their zeroing was about 3% of the model's pipeline instructions.

use geometry_predicates::predicates::{
    abs, fast_expansion_sum_zeroelim, scale_expansion_zeroelim, two_diff_tail, two_product, two_two_diff,
};

#[path = "incircle_tail.rs"]
mod tail;

/// `geometry_predicates`' machine epsilon, `2^-53`: the bounds below must match
/// its private `PARAMS` exactly for stage A and B to decide the same calls.
const EPSILON: f64 = 0.000_000_000_000_000_111_022_302_462_515_65;
const ICC_ERRBOUND_A: f64 = (10.0 + 96.0 * EPSILON) * EPSILON;
const ICC_ERRBOUND_B: f64 = (4.0 + 48.0 * EPSILON) * EPSILON;

/// Positive when `pd` lies inside the circle through the CCW triangle
/// `(pa, pb, pc)`, negative outside, zero on it. Bit-identical to
/// [`geometry_predicates::incircle`] for every input.
#[inline]
pub(super) fn incircle(pa: [f64; 2], pb: [f64; 2], pc: [f64; 2], pd: [f64; 2]) -> f64 {
    let adx = pa[0] - pd[0];
    let bdx = pb[0] - pd[0];
    let cdx = pc[0] - pd[0];
    let ady = pa[1] - pd[1];
    let bdy = pb[1] - pd[1];
    let cdy = pc[1] - pd[1];
    let bdxcdy = bdx * cdy;
    let cdxbdy = cdx * bdy;
    let alift = adx * adx + ady * ady;
    let cdxady = cdx * ady;
    let adxcdy = adx * cdy;
    let blift = bdx * bdx + bdy * bdy;
    let adxbdy = adx * bdy;
    let bdxady = bdx * ady;
    let clift = cdx * cdx + cdy * cdy;
    let det = alift * (bdxcdy - cdxbdy) + blift * (cdxady - adxcdy) + clift * (adxbdy - bdxady);
    let permanent = (abs(bdxcdy) + abs(cdxbdy)) * alift
        + (abs(cdxady) + abs(adxcdy)) * blift
        + (abs(adxbdy) + abs(bdxady)) * clift;
    let errbound = ICC_ERRBOUND_A * permanent;
    if det > errbound || -det > errbound {
        return det;
    }
    stage_b_or_tail(pa, pb, pc, pd, permanent).unwrap_or_else(|tail| tail::stages_c_d(&tail))
}

/// [`stage_b_or_tail`]'s decision alone: `None` when stage C is needed.
#[cfg(test)]
fn stage_b(pa: [f64; 2], pb: [f64; 2], pc: [f64; 2], pd: [f64; 2], permanent: f64) -> Option<f64> {
    stage_b_or_tail(pa, pb, pc, pd, permanent).ok()
}

/// The determinant of the rounded differences as a 96-entry expansion, summed.
/// `Ok` when its sign is certain, as in `incircleadapt`; else the state stage C
/// continues from.
fn stage_b_or_tail(pa: [f64; 2], pb: [f64; 2], pc: [f64; 2], pd: [f64; 2], permanent: f64)
    -> Result<f64, Box<tail::Tail>> {
    let adx = pa[0] - pd[0];
    let bdx = pb[0] - pd[0];
    let cdx = pc[0] - pd[0];
    let ady = pa[1] - pd[1];
    let bdy = pb[1] - pd[1];
    let cdy = pc[1] - pd[1];
    let mut adet = [0.0; 32];
    let mut bdet = [0.0; 32];
    let mut cdet = [0.0; 32];
    let (bc, ca, ab) = (two_minor(bdx, cdy, cdx, bdy), two_minor(cdx, ady, adx, cdy), two_minor(adx, bdy, bdx, ady));
    let alen = lifted_term(bc, adx, ady, &mut adet);
    let blen = lifted_term(ca, bdx, bdy, &mut bdet);
    let clen = lifted_term(ab, cdx, cdy, &mut cdet);
    let mut abdet = [0.0; 64];
    let ablen = fast_expansion_sum_zeroelim(&adet[..alen], &bdet[..blen], &mut abdet);
    let mut fin = [0.0; 96];
    let finlength = fast_expansion_sum_zeroelim(&abdet[..ablen], &cdet[..clen], &mut fin);
    let det: f64 = fin[..finlength].iter().sum();
    let errbound = ICC_ERRBOUND_B * permanent;
    if det >= errbound || -det >= errbound {
        return Ok(det);
    }
    let t = [
        two_diff_tail(pa[0], pd[0], adx),
        two_diff_tail(pb[0], pd[0], bdx),
        two_diff_tail(pc[0], pd[0], cdx),
        two_diff_tail(pa[1], pd[1], ady),
        two_diff_tail(pb[1], pd[1], bdy),
        two_diff_tail(pc[1], pd[1], cdy),
    ];
    // With exact differences the expansion IS the determinant.
    if t.iter().all(|&tail| tail == 0.0) {
        return Ok(det);
    }
    Err(Box::new(tail::Tail { fin, len: finlength, det, permanent, d: [adx, bdx, cdx, ady, bdy, cdy], t, bc, ca, ab }))
}

/// `p*s - q*r` as a 4-entry expansion (`two_two_diff` of two exact products).
#[inline]
fn two_minor(p: f64, s: f64, q: f64, r: f64) -> [f64; 4] {
    let [ps0, ps1] = two_product(p, s);
    let [qr0, qr1] = two_product(q, r);
    two_two_diff(ps1, ps0, qr1, qr0)
}

/// `minor * (x^2 + y^2)` into `out`, as `incircleadapt` builds `adet`.
#[inline]
fn lifted_term(minor: [f64; 4], x: f64, y: f64, out: &mut [f64; 32]) -> usize {
    let (mut mx, mut mxx, mut my, mut myy) = ([0.0; 8], [0.0; 16], [0.0; 8], [0.0; 16]);
    let mxlen = scale_expansion_zeroelim(&minor, x, &mut mx);
    let mxxlen = scale_expansion_zeroelim(&mx[..mxlen], x, &mut mxx);
    let mylen = scale_expansion_zeroelim(&minor, y, &mut my);
    let myylen = scale_expansion_zeroelim(&my[..mylen], y, &mut myy);
    fast_expansion_sum_zeroelim(&mxx[..mxxlen], &myy[..myylen], out)
}

#[cfg(test)]
#[path = "incircle_tests.rs"]
mod tests;
