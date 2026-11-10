// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Stages C and D below follow `incircleadapt` from the `geometry-predicates`
// crate 0.3.0 operation for operation (MIT License, Copyright (c) 2017 Egor
// Larionov; a port of Jonathan Richard Shewchuk's public-domain predicates).

//! Stages C and D of Shewchuk's adaptive in-circle test, continuing from the
//! stage-B state [`super::stage_b`] already built instead of redoing it.
//!
//! `geometry_predicates::incircleadapt` zeroes about 20 KB of scratch on every
//! call, 18 KB of it the two 1152-entry `fin` expansions, although every read
//! of them stays inside the prefix the same call wrote. On ISSUE_129 its 43k
//! stage-C calls spent about 78% of their instructions on that zeroing. Here
//! the two `fin` buffers are this thread's reused scratch, never re-zeroed;
//! every other buffer is zeroed per call exactly as in the crate, because the
//! crate does read past a written prefix in two places (the `bct`/`cat`/`abt`
//! defaults of length 1, and `cxtab`, whose length the crate shadows and so
//! reads as 8), and those reads must keep seeing zeros.
//!
//! Every expansion routine is the crate's public one, called with the same
//! operands in the same order, so the returned `f64` is bit-identical.

use geometry_predicates::predicates::{
    abs, fast_expansion_sum_zeroelim, scale_expansion_zeroelim, square, two_product, two_two_diff,
    two_two_sum,
};
use std::cell::RefCell;

/// `geometry_predicates`' private `PARAMS` values for stage C (`EPSILON` is
/// `2^-53`, as in the parent module).
const ICC_ERRBOUND_C: f64 = (44.0 + 576.0 * super::EPSILON) * super::EPSILON * super::EPSILON;
const RESULT_ERRBOUND: f64 = (3.0 + 8.0 * super::EPSILON) * super::EPSILON;

/// The crate's `fin` capacity: the longest expansion stage D can build.
const FIN: usize = 1152;

thread_local! {
    /// This thread's two `fin` expansions (2 x 1152 f64, 18 KB), fixed size,
    /// allocated once. Taken and put back around the computation,
    /// so a re-entrant call (there is none: this is a pure leaf) would mint
    /// its own instead of failing a borrow.
    static FINS: RefCell<Option<Box<[[f64; FIN]; 2]>>> = const { RefCell::new(None) };
}

/// The stage-B state stages C and D continue from.
pub(super) struct Tail {
    /// Stage B's determinant expansion and its length.
    pub(super) fin: [f64; 96],
    pub(super) len: usize,
    /// Its rounded sum, stage B's estimate.
    pub(super) det: f64,
    pub(super) permanent: f64,
    /// `adx, bdx, cdx, ady, bdy, cdy` and their roundoff tails, same order.
    pub(super) d: [f64; 6],
    pub(super) t: [f64; 6],
    /// The 2x2 minors `bc`, `ca`, `ab` as 4-entry expansions.
    pub(super) bc: [f64; 4],
    pub(super) ca: [f64; 4],
    pub(super) ab: [f64; 4],
}

/// Running `fin` expansion with the crate's `finnow`/`finother` swap.
struct Fin<'a> {
    now: &'a mut [f64; FIN],
    other: &'a mut [f64; FIN],
    len: usize,
}

impl Fin<'_> {
    fn add(&mut self, e: &[f64]) {
        self.len = fast_expansion_sum_zeroelim(&self.now[..self.len], e, &mut self.other[..]);
        std::mem::swap(&mut self.now, &mut self.other);
    }
}

/// Stages C and D: the refined estimate when its error bound decides, else the
/// exact expansion's most significant component, as `incircleadapt` returns.
pub(super) fn stages_c_d(tail: &Tail) -> f64 {
    let [adx, bdx, cdx, ady, bdy, cdy] = tail.d;
    let [adxtail, bdxtail, cdxtail, adytail, bdytail, cdytail] = tail.t;
    let mut det = tail.det;
    let errbound = ICC_ERRBOUND_C * tail.permanent + RESULT_ERRBOUND * abs(det);
    det += (adx * adx + ady * ady)
        * (bdx * cdytail + cdy * bdxtail - (bdy * cdxtail + cdx * bdytail))
        + 2.0 * (adx * adxtail + ady * adytail) * (bdx * cdy - bdy * cdx)
        + ((bdx * bdx + bdy * bdy)
            * (cdx * adytail + ady * cdxtail - (cdy * adxtail + adx * cdytail))
            + 2.0 * (bdx * bdxtail + bdy * bdytail) * (cdx * ady - cdy * adx))
        + ((cdx * cdx + cdy * cdy)
            * (adx * bdytail + bdy * adxtail - (ady * bdxtail + bdx * adytail))
            + 2.0 * (cdx * cdxtail + cdy * cdytail) * (adx * bdy - ady * bdx));
    if det >= errbound || -det >= errbound {
        return det;
    }
    let mut fins = FINS.with(|slot| slot.borrow_mut().take()).unwrap_or_else(|| Box::new([[0.0; FIN]; 2]));
    let [first, second] = &mut *fins;
    first[..tail.len].copy_from_slice(&tail.fin[..tail.len]);
    let mut fin = Fin { now: first, other: second, len: tail.len };
    let value = stage_d(tail, &mut fin);
    FINS.with(|slot| *slot.borrow_mut() = Some(fins));
    value
}

/// `x^2 + y^2` as a 4-entry expansion, or zeros when the crate skips it.
fn lift(needed: bool, x: f64, y: f64) -> [f64; 4] {
    if !needed {
        return [0.0; 4];
    }
    let [xx0, xx1] = square(x);
    let [yy0, yy1] = square(y);
    two_two_sum(xx1, xx0, yy1, yy0)
}

/// One first-order tail term: `minor * tail * 2 * coord + sq1 * tail * f1 +
/// sq2 * tail * f2`, added to `fin`; the scaled minor goes to `xt` (its length
/// returned), which the second-order terms reuse.
#[allow(clippy::too_many_arguments)] // the crate's six blocks differ only in these operands
fn first_order(fin: &mut Fin, minor: &[f64; 4], tail: f64, coord: f64,
    (sq1, f1): (&[f64; 4], f64), (sq2, f2): (&[f64; 4], f64), xt: &mut [f64; 8]) -> usize {
    let (mut t16a, mut t16b, mut t16c) = ([0.0; 16], [0.0; 16], [0.0; 16]);
    let (mut t8a, mut t8b, mut t32a, mut t48) = ([0.0; 8], [0.0; 8], [0.0; 32], [0.0; 48]);
    let xtlen = scale_expansion_zeroelim(minor, tail, xt);
    let t16alen = scale_expansion_zeroelim(&xt[..xtlen], 2.0 * coord, &mut t16a);
    let t8alen = scale_expansion_zeroelim(sq1, tail, &mut t8a);
    let t16blen = scale_expansion_zeroelim(&t8a[..t8alen], f1, &mut t16b);
    let t8blen = scale_expansion_zeroelim(sq2, tail, &mut t8b);
    let t16clen = scale_expansion_zeroelim(&t8b[..t8blen], f2, &mut t16c);
    let t32alen = fast_expansion_sum_zeroelim(&t16a[..t16alen], &t16b[..t16blen], &mut t32a);
    let t48len = fast_expansion_sum_zeroelim(&t16c[..t16clen], &t32a[..t32alen], &mut t48);
    fin.add(&t48[..t48len]);
    xtlen
}

/// One second-order term for the tail `tail` of `coord`: the products with the
/// cross-tail expansions `t` and `tt`, and the two optional `sq * tail * other`
/// terms between them (x tails only).
#[allow(clippy::too_many_arguments)]
fn second_order(fin: &mut Fin, xt: &[f64], tail: f64, coord: f64, t: &[f64], tt: &[f64],
    extra: [Option<(&[f64; 4], f64, f64)>; 2]) {
    let (mut t16a, mut t16b, mut t8) = ([0.0; 16], [0.0; 16], [0.0; 8]);
    let (mut t32a, mut t32b, mut t48, mut t64) = ([0.0; 32], [0.0; 32], [0.0; 48], [0.0; 64]);
    let (mut xtt, mut xttt) = ([0.0; 16], [0.0; 8]);
    let t16alen = scale_expansion_zeroelim(xt, tail, &mut t16a);
    let xttlen = scale_expansion_zeroelim(t, tail, &mut xtt);
    let t32alen = scale_expansion_zeroelim(&xtt[..xttlen], 2.0 * coord, &mut t32a);
    let t48len = fast_expansion_sum_zeroelim(&t16a[..t16alen], &t32a[..t32alen], &mut t48);
    fin.add(&t48[..t48len]);
    for (sq, factor, other) in extra.into_iter().flatten() {
        let t8len = scale_expansion_zeroelim(sq, factor, &mut t8);
        let t16alen = scale_expansion_zeroelim(&t8[..t8len], other, &mut t16a);
        fin.add(&t16a[..t16alen]);
    }
    let t32alen = scale_expansion_zeroelim(&xtt[..xttlen], tail, &mut t32a);
    let xtttlen = scale_expansion_zeroelim(tt, tail, &mut xttt);
    let t16alen = scale_expansion_zeroelim(&xttt[..xtttlen], 2.0 * coord, &mut t16a);
    let t16blen = scale_expansion_zeroelim(&xttt[..xtttlen], tail, &mut t16b);
    let t32blen = fast_expansion_sum_zeroelim(&t16a[..t16alen], &t16b[..t16blen], &mut t32b);
    let t64len = fast_expansion_sum_zeroelim(&t32a[..t32alen], &t32b[..t32blen], &mut t64);
    fin.add(&t64[..t64len]);
}

/// The cross-tail expansions of one vertex group, built from the other two
/// vertices `q`, `r` (`bct`/`bctt` for `a`, `cat`/`catt` for `b`, `abt`/`abtt`
/// for `c`); the crate's length-1 zero defaults when they are all exact.
#[allow(clippy::too_many_arguments)]
fn cross(needed: bool, qx: f64, qy: f64, qxt: f64, qyt: f64, rx: f64, ry: f64, rxt: f64, ryt: f64)
    -> ([f64; 8], usize, [f64; 4], usize) {
    if !needed {
        return ([0.0; 8], 1, [0.0; 4], 1);
    }
    let [ti0, ti1] = two_product(qxt, ry);
    let [tj0, tj1] = two_product(qx, ryt);
    let u = two_two_sum(ti1, ti0, tj1, tj0);
    let [ti0, ti1] = two_product(rxt, -qy);
    let [tj0, tj1] = two_product(rx, -qyt);
    let v = two_two_sum(ti1, ti0, tj1, tj0);
    let mut t = [0.0; 8];
    let tlen = fast_expansion_sum_zeroelim(&u, &v, &mut t);
    let [ti0, ti1] = two_product(qxt, ryt);
    let [tj0, tj1] = two_product(rxt, qyt);
    (t, tlen, two_two_diff(ti1, ti0, tj1, tj0), 4)
}

fn stage_d(tail: &Tail, fin: &mut Fin) -> f64 {
    let [adx, bdx, cdx, ady, bdy, cdy] = tail.d;
    let [adxtail, bdxtail, cdxtail, adytail, bdytail, cdytail] = tail.t;
    let (a_t, b_t, c_t) = (adxtail != 0.0 || adytail != 0.0, bdxtail != 0.0 || bdytail != 0.0,
        cdxtail != 0.0 || cdytail != 0.0);
    let aa = lift(b_t || c_t, adx, ady);
    let bb = lift(c_t || a_t, bdx, bdy);
    let cc = lift(a_t || b_t, cdx, cdy);
    // The scaled minors, zeroed per call: the crate reads `cxtab` as 8 long.
    let mut xt = [[0.0; 8]; 6];
    let mut xtlen = [8usize; 6];
    let (bc, ca, ab) = (&tail.bc, &tail.ca, &tail.ab);
    if adxtail != 0.0 { xtlen[0] = first_order(fin, bc, adxtail, adx, (&cc, bdy), (&bb, -cdy), &mut xt[0]); }
    if adytail != 0.0 { xtlen[1] = first_order(fin, bc, adytail, ady, (&bb, cdx), (&cc, -bdx), &mut xt[1]); }
    if bdxtail != 0.0 { xtlen[2] = first_order(fin, ca, bdxtail, bdx, (&aa, cdy), (&cc, -ady), &mut xt[2]); }
    if bdytail != 0.0 { xtlen[3] = first_order(fin, ca, bdytail, bdy, (&cc, adx), (&aa, -cdx), &mut xt[3]); }
    // `cxtablen` is shadowed in the crate: its later reads use 8.
    if cdxtail != 0.0 { first_order(fin, ab, cdxtail, cdx, (&bb, ady), (&aa, -bdy), &mut xt[4]); }
    if cdytail != 0.0 { xtlen[5] = first_order(fin, ab, cdytail, cdy, (&aa, bdx), (&bb, -adx), &mut xt[5]); }
    let groups = [
        // (group has a tail, x/y tails, x/y coords, minor slots, cross from q, r, x-tail extras)
        (a_t, (adxtail, adytail), (adx, ady), (0, 1), (b_t || c_t, [bdx, bdy, bdxtail, bdytail], [cdx, cdy, cdxtail, cdytail]),
            [(bdytail, &cc), (cdytail, &bb)]),
        (b_t, (bdxtail, bdytail), (bdx, bdy), (2, 3), (c_t || a_t, [cdx, cdy, cdxtail, cdytail], [adx, ady, adxtail, adytail]),
            [(cdytail, &aa), (adytail, &cc)]),
        (c_t, (cdxtail, cdytail), (cdx, cdy), (4, 5), (a_t || b_t, [adx, ady, adxtail, adytail], [bdx, bdy, bdxtail, bdytail]),
            [(adytail, &bb), (bdytail, &aa)]),
    ];
    for (has, (xtail, ytail), (x, y), (sx, sy), (needed, q, r), [(q_ytail, r_sq), (r_ytail, q_sq)]) in groups {
        if !has {
            continue;
        }
        let (t, tlen, tt, ttlen) = cross(needed, q[0], q[1], q[2], q[3], r[0], r[1], r[2], r[3]);
        if xtail != 0.0 {
            let extra = [
                (q_ytail != 0.0).then_some((r_sq, xtail, q_ytail)),
                (r_ytail != 0.0).then_some((q_sq, -xtail, r_ytail)),
            ];
            second_order(fin, &xt[sx][..xtlen[sx]], xtail, x, &t[..tlen], &tt[..ttlen], extra);
        }
        if ytail != 0.0 {
            second_order(fin, &xt[sy][..xtlen[sy]], ytail, y, &t[..tlen], &tt[..ttlen], [None, None]);
        }
    }
    fin.now[fin.len - 1]
}
