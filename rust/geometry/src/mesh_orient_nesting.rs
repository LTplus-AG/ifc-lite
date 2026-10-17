// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Containment between the closed shells of one mesh (#7755).
//!
//! A solid whose cavity is a separate shell (a full 2π revolution of a holed
//! profile: outer surface plus bore) has components nested inside one another.
//! The producer winds the bore into the bore, so its own signed volume is
//! negative and the mesh volume is `outer - bore`. The orienter used to make
//! every closed component positive, which turned the bore inside out and read
//! `outer + bore`. Nesting alone is NOT a cavity signal: an element body is
//! many items merged, and window frames inside a window's envelope box are
//! nested, same-wound, separate solids (FM_ARC_DigitalHub). So a cavity is a
//! shell nested an odd number of levels deep whose authored winding is
//! opposite to its innermost container's. `*BrepWithVoids` void shells are
//! not rendered at all (#7688), so no producer emits an outward-wound cavity.
//!
//! Containment is the winding number of the container at a point of the
//! candidate: the sum of the solid angles its triangles subtend, over 4π. It
//! is ±1 inside a consistently wound closed shell and 0 outside, and unlike a
//! ray-parity count it has no degenerate directions.

/// A point counts as inside only beyond this winding magnitude. A point ON the
/// container (two coincident duplicate shells) scores 0.5 up to rounding and
/// must stay "not inside", or the answer would depend on rounding noise.
const INSIDE_WINDING: f64 = 0.75;

/// Points of a candidate tested against each container.
const SAMPLES: usize = 8;

/// Work bound for one mesh: bounding-box pair tests plus triangles visited by
/// winding sums. Past it no shell is taken for a cavity, which is the
/// pre-#7755 behaviour (every closed shell positive), so an adversarial mesh
/// of many nested shells costs at most this much, never `O(C^2 * T)`.
pub(super) const NESTING_WORK_BUDGET: usize = 1 << 26;

type Tri = [[f64; 3]; 3];

/// One closed orientable component: its triangles are `tris[start..end]`,
/// `vol6` is its signed volume * 6 as currently propagated, and `authored` is
/// the sign of its AS-AUTHORED volume when the input already wound it
/// consistently (no triangle had to flip), else 0.
#[derive(Clone, Copy, Debug)]
pub(super) struct ClosedSpan {
    pub start: usize,
    pub end: usize,
    pub vol6: f64,
    pub authored: i8,
}

impl ClosedSpan {
    /// The span of `comp` appended at `start`. As authored it is consistent
    /// iff the propagation flipped none of its triangles.
    pub fn new(start: usize, comp: &[usize], flip: &[bool], vol6: f64) -> Self {
        let consistent = !comp.iter().any(|&t| flip[t]);
        let authored = if !consistent || vol6 == 0.0 { 0 } else if vol6 < 0.0 { -1 } else { 1 };
        Self { start, end: start + comp.len(), vol6, authored }
    }
}

/// Wind every closed component so its signed volume is positive, except a
/// CAVITY, which stays wound into itself (negative).
///
/// A cavity needs an explicit signal, not just nesting: the producer must have
/// authored it consistently and OPPOSITE to its innermost container (a full
/// revolution of a holed profile writes the bore that way, #7747). A shell that
/// merely sits inside another with the same authored winding (window frames
/// and panes inside a window's envelope box, a pipe inside a sleeve, an
/// embedded duplicate) is a separate solid and is made positive as before.
/// `flip` is each triangle's current flip; `corners(t, flipped)` its corners.
pub(super) fn face_closed_components(
    spans: &[ClosedSpan],
    tris: &[usize],
    flip: &mut [bool],
    corners: &dyn Fn(usize, bool) -> Tri,
) {
    let cavity = cavities(spans, tris, &|t| corners(t, flip[t]));
    for (i, span) in spans.iter().enumerate() {
        let is_cavity = cavity.as_ref().is_some_and(|c| c[i]);
        if (span.vol6 < 0.0 && !is_cavity) || (span.vol6 > 0.0 && is_cavity) {
            for &t in &tris[span.start..span.end] {
                flip[t] = !flip[t];
            }
        }
    }
}

/// Which components are cavities, or `None` when none can be (one component,
/// or no two components with opposite authored windings) or the work budget
/// ran out.
fn cavities(spans: &[ClosedSpan], tris: &[usize], tri: &dyn Fn(usize) -> Tri) -> Option<Vec<bool>> {
    let has = |s: i8| spans.iter().any(|c| c.authored == s);
    if spans.len() < 2 || !has(1) || !has(-1) {
        return None;
    }
    let members = |c: &ClosedSpan| &tris[c.start..c.end];
    let boxes: Vec<([f64; 3], [f64; 3])> = spans
        .iter()
        .map(|c| {
            let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
            for &t in members(c) {
                for p in tri(t) {
                    for k in 0..3 {
                        lo[k] = lo[k].min(p[k]);
                        hi[k] = hi[k].max(p[k]);
                    }
                }
            }
            (lo, hi)
        })
        .collect();
    let mut work = 0usize;
    let mut out = vec![false; spans.len()];
    for (c, span) in spans.iter().enumerate() {
        let own = members(span);
        if span.authored == 0 || own.is_empty() {
            continue;
        }
        // Containers by bounding box first (cheap); the candidate must have
        // one authored the other way round before any winding is summed.
        let in_box: Vec<usize> = (0..spans.len())
            .filter(|&o| o != c)
            .filter(|&o| {
                let (lo, hi) = boxes[o];
                (0..3).all(|k| boxes[c].0[k] >= lo[k] && boxes[c].1[k] <= hi[k])
            })
            .collect();
        work = work.saturating_add(spans.len());
        if work > NESTING_WORK_BUDGET {
            return None;
        }
        if !in_box.iter().any(|&o| spans[o].authored == -span.authored) {
            continue;
        }
        // Spread points of `c`: a shell is nested only when ALL of them are
        // inside, so one that merely overlaps another (a frame partly
        // embedded in a wall) is not taken for a cavity.
        let samples: Vec<[f64; 3]> =
            (0..SAMPLES).map(|k| tri(own[k * own.len() / SAMPLES])[k % 3]).collect();
        let mut containers = Vec::new();
        for o in in_box {
            let theirs = members(&spans[o]);
            work = work.saturating_add(SAMPLES.saturating_mul(theirs.len()));
            if work > NESTING_WORK_BUDGET {
                return None;
            }
            if samples.iter().all(|&p| winding(theirs, tri, p).abs() > INSIDE_WINDING) {
                containers.push(o);
            }
        }
        let innermost = containers
            .iter()
            .copied()
            .min_by(|&a, &b| spans[a].vol6.abs().total_cmp(&spans[b].vol6.abs()));
        out[c] = containers.len() % 2 == 1
            && innermost.is_some_and(|o| spans[o].authored == -span.authored);
    }
    Some(out)
}

/// Winding number of the closed shell `tris` about `p`.
fn winding(tris: &[usize], tri: &dyn Fn(usize) -> Tri, p: [f64; 3]) -> f64 {
    let sub = |a: [f64; 3]| [a[0] - p[0], a[1] - p[1], a[2] - p[2]];
    let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let norm = |a: [f64; 3]| dot(a, a).sqrt();
    let cross = |a: [f64; 3], b: [f64; 3]| {
        [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
    };
    let total: f64 = tris
        .iter()
        .map(|&t| {
            let [a, b, c] = tri(t).map(sub);
            let (la, lb, lc) = (norm(a), norm(b), norm(c));
            let denom = la * lb * lc + dot(a, b) * lc + dot(b, c) * la + dot(c, a) * lb;
            // Van Oosterom-Strackee solid angle of the triangle seen from `p`.
            2.0 * dot(a, cross(b, c)).atan2(denom)
        })
        .sum();
    total / (4.0 * std::f64::consts::PI)
}
