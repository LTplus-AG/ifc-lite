// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The bounded T-junction ("hairline") tolerance on top of the strict directed
//! closure verdict.
//!
//! A rigorous hairline test: the uncancelled directed edges, viewed as a 1-D
//! SIGNED measure along each supporting line, must net to ZERO everywhere.
//! Every stretch covered by an edge running one way is covered the SAME number
//! of times by edges running the other way (two adjacent faces subdividing a
//! shared line differently). A genuine hole, a boundary edge only PARTIALLY
//! covered, or one covered the wrong number of times leaves a stretch with
//! nonzero net coverage and fails. This is strictly stronger than a
//! midpoint-proximity test, which a LONG unmatched edge could spoof merely by
//! having a SHORT reverse edge near its midpoint.

use super::ledger::Key3;
use crate::math::v3::{dot, norm, scale, sub, V3};

/// Perpendicular slack, in grid units (~0.2 mm), for edges to share a line.
const COLLINEAR_TOL: f64 = 2.0;
/// Grid units: sub-interval slivers shorter than this are ignored.
const T_EPS: f64 = 1.0e-6;
/// The longest contiguous mis-covered run tolerated, in grid units. A hole or a
/// partially-covered long edge leaves a macroscopic run; the sub-grid jitter of
/// a genuine hairline stays inside the slack the collinearity grouping allows.
const GAP_TOL: f64 = COLLINEAR_TOL;
/// More unmatched directed edges than this is way past hairline territory.
const MAX_UNMATCHED: usize = 64;

/// An unmatched directed edge `(a, b)` with its positive net count.
pub(super) type Unmatched = (Key3, Key3, i64);

struct Seg {
    a: V3,
    b: V3,
    m: i64,
}

struct Line {
    o: V3,
    dir: V3,
    members: Vec<usize>,
}

/// Whether the unmatched directed edges `bad` are all collinearly covered by
/// opposite-sign edges (a T-junction chain), not a missing surface.
pub(super) fn hairline_closed(bad: &[Unmatched]) -> bool {
    if bad.is_empty() {
        return true;
    }
    if bad.len() > MAX_UNMATCHED {
        return false;
    }
    // Canonicalise only when the caller asks for the hairline verdict.
    //
    // Sorted by endpoint key, NOT left in ledger iteration order: `FxHashMap`
    // iterates target-dependently, and the grouping below is greedy, so an
    // arbitrary seed order could reach a different verdict on native than on
    // wasm32. Every `(a, b)` is unique, so the sort key is tie-free: an
    // unstable sort with a tie-free key yields one deterministic sequence
    // whatever order the map was walked in.
    let mut bad = bad.to_vec();
    bad.sort_unstable_by_key(|&(a, b, _)| (a, b));
    let p = |k: Key3| [k[0] as f64, k[1] as f64, k[2] as f64]; // grid units (0.1 mm)
    let segs: Vec<Seg> = bad.iter().map(|&(a, b, c)| Seg { a: p(a), b: p(b), m: c }).collect();
    match group_collinear(&segs) {
        Some(lines) => lines.iter().all(|line| line_nets_to_zero(&segs, line)),
        None => false,
    }
}

/// Perpendicular distance from `x` to the infinite line `(o, dir)` (`dir`
/// unit). Perp distance is convex along a segment, so if BOTH endpoints are
/// within tol of a line the whole segment is: that is the collinearity test
/// (and it rejects a segment that merely crosses the line).
fn perp(x: V3, o: V3, dir: V3) -> f64 {
    let w = sub(x, o);
    let along = dot(w, dir);
    norm(sub(w, scale(dir, along)))
}

/// `a / |a|` as `a * (1 / |a|)`, `None` for a non-finite or sub-1e-12 length.
/// The reciprocal multiply (not `math::v3::normalize`'s divide) is what the
/// verdict was tuned on, so it is kept bit for bit.
fn unit(a: V3) -> Option<V3> {
    let n = norm(a);
    if !n.is_finite() || n < 1.0e-12 {
        None
    } else {
        Some(scale(a, 1.0 / n))
    }
}

/// Group `segs` into supporting lines, seeding from the LONGEST segment first:
/// a long edge fixes a stable direction, so its collinear short neighbours join
/// it rather than each spawning a slightly-rotated line (greedy fragmentation
/// would split a genuinely-covered boundary and report phantom gaps). `None`
/// when a zero-length segment cannot seal anything.
fn group_collinear(segs: &[Seg]) -> Option<Vec<Line>> {
    let mut order: Vec<usize> = (0..segs.len()).collect();
    order.sort_by(|&i, &j| {
        let li = dot(sub(segs[i].b, segs[i].a), sub(segs[i].b, segs[i].a));
        let lj = dot(sub(segs[j].b, segs[j].a), sub(segs[j].b, segs[j].a));
        // `total_cmp` + index tie-break: a total order, so the seed sequence is
        // a pure function of `segs` (already canonically sorted).
        lj.total_cmp(&li).then(i.cmp(&j))
    });
    let mut lines: Vec<Line> = Vec::new();
    'seg: for si in order {
        let s = &segs[si];
        let sdir = unit(sub(s.b, s.a))?;
        for line in lines.iter_mut() {
            if perp(s.a, line.o, line.dir) <= COLLINEAR_TOL && perp(s.b, line.o, line.dir) <= COLLINEAR_TOL {
                line.members.push(si);
                continue 'seg;
            }
        }
        lines.push(Line { o: s.a, dir: sdir, members: vec![si] });
    }
    Some(lines)
}

/// Sweep one line's signed multiplicity coverage. At every point the signed
/// count of covering edges (this line's `+dir` edges minus its `-dir` edges,
/// weighted by multiplicity) must net to ZERO, tracking the longest CONTIGUOUS
/// mis-covered run and rejecting once it exceeds [`GAP_TOL`].
fn line_nets_to_zero(segs: &[Seg], line: &Line) -> bool {
    let mut ints: Vec<(f64, f64, i64)> = Vec::with_capacity(line.members.len());
    let mut breaks: Vec<f64> = Vec::with_capacity(line.members.len() * 2);
    for &si in &line.members {
        let s = &segs[si];
        let ta = dot(sub(s.a, line.o), line.dir);
        let tb = dot(sub(s.b, line.o), line.dir);
        let sign = if tb >= ta { 1 } else { -1 };
        ints.push((ta.min(tb), ta.max(tb), sign * s.m));
        breaks.push(ta);
        breaks.push(tb);
    }
    // `total_cmp`: a non-finite coordinate here must reject the cut, not abort.
    breaks.sort_by(|x, y| x.total_cmp(y));
    let mut run = 0.0_f64;
    for w in breaks.windows(2) {
        let (lo, hi) = (w[0], w[1]);
        let len = hi - lo;
        if len <= T_EPS {
            continue;
        }
        let mid = 0.5 * (lo + hi);
        let mut sum = 0i64;
        for &(ilo, ihi, sm) in &ints {
            if ilo - T_EPS <= mid && mid <= ihi + T_EPS {
                sum += sm;
            }
        }
        if sum != 0 {
            run += len;
            if run > GAP_TOL {
                return false;
            }
        } else {
            run = 0.0;
        }
    }
    true
}
