// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Ring-set validity: no ring touches or crosses itself or another, every
//! ring keeps its winding, and every ring stays directly inside the ring the
//! trace said contains it. Plus the repair loop that undoes vertex moves
//! until those hold again.
//!
//! Intersections use the exact closed-segment test from `crate::geom2d`, so a
//! shared vertex or a collinear overlap between non-adjacent edges counts as a
//! violation, not only a proper crossing.

use super::support::Support;
use crate::geom2d::{orientation, point_in_polygon, polygon_area, segments_intersect};

/// Rounds of the repair loop before falling back to whole-ring reverts.
const REPAIR_ROUNDS: usize = 64;

/// Edge `k` of ring `r` runs from vertex `k` to vertex `k + 1` (wrapping).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(super) struct EdgeRef {
    pub ring: usize,
    pub edge: usize,
}

/// Everything wrong with a ring set.
#[derive(Debug, Default)]
pub(super) struct Violations {
    /// Edges that touch or cross another edge, or fold back on a neighbour.
    pub edges: Vec<EdgeRef>,
    /// Rings that are degenerate, flipped their winding, or left their container.
    pub rings: Vec<usize>,
}

impl Violations {
    pub fn is_empty(&self) -> bool {
        self.edges.is_empty() && self.rings.is_empty()
    }
}

/// Find every violation. `parents[r]` is the ring that must directly contain
/// ring `r`; outer rings (positive area expected) are those whose parent is
/// `None` or a hole. A ring's expected winding is taken from `expect_outer`.
pub(super) fn find_violations(rings: &[Vec<[f64; 2]>], parents: &[Option<usize>], expect_outer: &[bool]) -> Violations {
    let mut out = Violations::default();
    for (r, ring) in rings.iter().enumerate() {
        let area = polygon_area(ring);
        let winding_ok = if expect_outer[r] { area > 0.0 } else { area < 0.0 };
        if ring.len() < 3 || !winding_ok || !area.is_finite() {
            out.rings.push(r);
        }
    }
    let mut bad_edges = crossing_edges(rings);
    for (r, ring) in rings.iter().enumerate() {
        let n = ring.len();
        if n < 3 {
            continue;
        }
        for k in 0..n {
            let (a, b, c) = (ring[k], ring[(k + 1) % n], ring[(k + 2) % n]);
            // A zero-length edge, or a turn that doubles straight back.
            if a == b || (orientation(a, b, c) == 0 && dot(sub(b, a), sub(c, b)) <= 0.0) {
                bad_edges.push(EdgeRef { ring: r, edge: k });
                bad_edges.push(EdgeRef { ring: r, edge: (k + 1) % n });
            }
        }
    }
    bad_edges.sort_unstable();
    bad_edges.dedup();
    out.edges = bad_edges;
    if out.is_empty() {
        // Nesting only means something once nothing crosses: then one vertex
        // decides containment for the whole ring.
        for r in containment_violations(rings, parents) {
            out.rings.push(r);
        }
    }
    out.rings.sort_unstable();
    out.rings.dedup();
    out
}

/// [`find_violations`] plus, with `support`, the edges that left the evidence.
fn violations_with_support(
    rings: &[Vec<[f64; 2]>],
    parents: &[Option<usize>],
    expect_outer: &[bool],
    support: Option<&Support>,
) -> Violations {
    let mut v = find_violations(rings, parents, expect_outer);
    if let Some(s) = support {
        v.edges.extend(s.unsupported_edges(rings));
        v.edges.sort_unstable();
        v.edges.dedup();
    }
    v
}

/// Rings whose innermost container is not their recorded parent, together
/// with the containers involved.
fn containment_violations(rings: &[Vec<[f64; 2]>], parents: &[Option<usize>]) -> Vec<usize> {
    let boxes: Vec<[f64; 4]> = rings.iter().map(|r| bbox(r)).collect();
    let mut bad = Vec::new();
    for (r, ring) in rings.iter().enumerate() {
        let Some(&probe) = ring.first() else { continue };
        let mut innermost: Option<(usize, f64)> = None;
        for (c, other) in rings.iter().enumerate() {
            if c == r || !box_contains(&boxes[c], probe) || !point_in_polygon(probe, other) {
                continue;
            }
            let area = polygon_area(other).abs();
            if innermost.is_none_or(|(_, a)| area < a) {
                innermost = Some((c, area));
            }
        }
        let found = innermost.map(|(c, _)| c);
        if found != parents[r] {
            // Either side may have moved: the ring, the ring that now wrongly
            // contains it, or the parent it escaped from.
            bad.push(r);
            bad.extend(found);
            bad.extend(parents[r]);
        }
    }
    bad
}

/// Pairs of non-adjacent edges that intersect, via a uniform bucket grid.
fn crossing_edges(rings: &[Vec<[f64; 2]>]) -> Vec<EdgeRef> {
    let mut edges: Vec<(EdgeRef, [f64; 2], [f64; 2])> = Vec::new();
    let (mut lo, mut hi) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
    let mut total_len = 0.0;
    for (r, ring) in rings.iter().enumerate() {
        let n = ring.len();
        for k in 0..n {
            let (a, b) = (ring[k], ring[(k + 1) % n]);
            lo = [lo[0].min(a[0]), lo[1].min(a[1])];
            hi = [hi[0].max(a[0]), hi[1].max(a[1])];
            total_len += ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
            edges.push((EdgeRef { ring: r, edge: k }, a, b));
        }
    }
    if edges.len() < 2 || !total_len.is_finite() {
        return Vec::new();
    }
    // Bucket about twice the mean edge length, with the bucket count capped
    // at a few per edge so a sparse spread cannot allocate a huge grid.
    let area = (hi[0] - lo[0]).max(1e-9) * (hi[1] - lo[1]).max(1e-9);
    let max_buckets = (4 * edges.len()).min(1 << 20) as f64;
    let size = (2.0 * total_len / edges.len() as f64).max((area / max_buckets).sqrt()).max(1e-9);
    let cols = ((hi[0] - lo[0]) / size).floor() as usize + 1;
    let rows = ((hi[1] - lo[1]) / size).floor() as usize + 1;
    let mut buckets: Vec<Vec<u32>> = vec![Vec::new(); cols * rows];
    for (e, &(_, a, b)) in edges.iter().enumerate() {
        let c0 = (((a[0].min(b[0]) - lo[0]) / size).floor() as usize).min(cols - 1);
        let c1 = (((a[0].max(b[0]) - lo[0]) / size).floor() as usize).min(cols - 1);
        for col in c0..=c1 {
            // The edge's y-range within this column: exact supercover.
            let x_lo = lo[0] + col as f64 * size;
            let x_hi = x_lo + size;
            let (y_a, y_b) = y_range_in_slab(a, b, x_lo, x_hi);
            let r0 = (((y_a - lo[1]) / size).floor().max(0.0) as usize).min(rows - 1);
            let r1 = (((y_b - lo[1]) / size).floor().max(0.0) as usize).min(rows - 1);
            for row in r0..=r1 {
                buckets[row * cols + col].push(e as u32);
            }
        }
    }
    let mut pairs: Vec<(u32, u32)> = Vec::new();
    for bucket in &buckets {
        for i in 0..bucket.len() {
            for j in i + 1..bucket.len() {
                let (p, q) = (bucket[i].min(bucket[j]), bucket[i].max(bucket[j]));
                pairs.push((p, q));
            }
        }
    }
    pairs.sort_unstable();
    pairs.dedup();
    let mut bad = Vec::new();
    for (p, q) in pairs {
        let (ep, a, b) = edges[p as usize];
        let (eq, c, d) = edges[q as usize];
        if ep.ring == eq.ring && adjacent(ep.edge, eq.edge, rings[ep.ring].len()) {
            continue;
        }
        if segments_intersect(a, b, c, d) {
            bad.push(ep);
            bad.push(eq);
        }
    }
    bad
}

fn y_range_in_slab(a: [f64; 2], b: [f64; 2], x_lo: f64, x_hi: f64) -> (f64, f64) {
    let dx = b[0] - a[0];
    if dx.abs() < 1e-300 {
        return (a[1].min(b[1]), a[1].max(b[1]));
    }
    let t0 = ((x_lo - a[0]) / dx).clamp(0.0, 1.0);
    let t1 = ((x_hi - a[0]) / dx).clamp(0.0, 1.0);
    let y0 = a[1] + t0 * (b[1] - a[1]);
    let y1 = a[1] + t1 * (b[1] - a[1]);
    (y0.min(y1), y0.max(y1))
}

#[inline]
fn adjacent(i: usize, j: usize, n: usize) -> bool {
    (i + 1) % n == j || (j + 1) % n == i
}

/// Undo vertex moves (positions in `moved` versus the valid `before`) until
/// the set is valid again. A ring with the same vertex count is reverted
/// vertex by vertex at the offending edges; a ring whose count changed is
/// restored whole. Returns the number of vertices reverted.
pub(super) fn repair_moves(
    moved: &mut [Vec<[f64; 2]>],
    before: &[Vec<[f64; 2]>],
    parents: &[Option<usize>],
    support: Option<&Support>,
) -> usize {
    let expect_outer: Vec<bool> = before.iter().map(|r| polygon_area(r) > 0.0).collect();
    let mut reverted = 0usize;
    let restore_whole = |moved: &mut [Vec<[f64; 2]>], r: usize, reverted: &mut usize| {
        *reverted += before[r].len();
        moved[r] = before[r].clone();
    };
    for round in 0..=REPAIR_ROUNDS {
        let v = violations_with_support(moved, parents, &expect_outer, support);
        if v.is_empty() {
            return reverted;
        }
        let mut progress = false;
        for r in v.edges.iter().map(|e| e.ring).chain(v.rings.iter().copied()) {
            if moved[r].len() != before[r].len() {
                restore_whole(moved, r, &mut reverted);
                progress = true;
            }
        }
        if progress {
            continue;
        }
        let mut revert = |r: usize, k: usize, moved: &mut [Vec<[f64; 2]>]| {
            if moved[r][k] != before[r][k] {
                moved[r][k] = before[r][k];
                reverted += 1;
                progress = true;
            }
        };
        let whole_rings = round == REPAIR_ROUNDS;
        for e in &v.edges {
            let n = moved[e.ring].len();
            if whole_rings {
                for k in 0..n {
                    revert(e.ring, k, moved);
                }
            } else {
                revert(e.ring, e.edge, moved);
                revert(e.ring, (e.edge + 1) % n, moved);
            }
        }
        for &r in &v.rings {
            for k in 0..moved[r].len() {
                revert(r, k, moved);
            }
        }
        if !progress {
            break;
        }
    }
    // Everything implicated is back where it was; anything left is a moved
    // vertex elsewhere interacting with it, so return the whole set.
    for r in 0..moved.len() {
        if moved[r] != before[r] {
            restore_whole(moved, r, &mut reverted);
        }
    }
    reverted
}

/// Restore `original` for every ring of `rebuilt` (and its paired `moved`)
/// that takes part in a violation, until `rebuilt` is valid. Bounded: each
/// round restores at least one ring, and the originals are valid. Returns the
/// number of vertices restored.
pub(super) fn restore_invalid_rings(
    rebuilt: &mut [Vec<[f64; 2]>],
    moved: &mut [Vec<[f64; 2]>],
    original: &[Vec<[f64; 2]>],
    parents: &[Option<usize>],
    support: Option<&Support>,
) -> usize {
    let expect_outer: Vec<bool> = original.iter().map(|r| polygon_area(r) > 0.0).collect();
    let mut restored = 0usize;
    for _ in 0..=rebuilt.len() {
        let v = violations_with_support(rebuilt, parents, &expect_outer, support);
        if v.is_empty() {
            break;
        }
        let mut progress = false;
        for r in v.edges.iter().map(|e| e.ring).chain(v.rings.iter().copied()) {
            if rebuilt[r] != original[r] {
                rebuilt[r] = original[r].clone();
                moved[r] = original[r].clone();
                restored += original[r].len();
                progress = true;
            }
        }
        if !progress {
            break;
        }
    }
    restored
}

/// Remove vertices where the ring runs straight on (exactly collinear, or a
/// turn below `1e-9` rad with sub-micrometre deviation), when that keeps the
/// set valid. Squaring makes such vertices exact.
pub(super) fn drop_collinear_vertices(rings: &mut [Vec<[f64; 2]>], parents: &[Option<usize>]) {
    let expect_outer: Vec<bool> = rings.iter().map(|r| polygon_area(r) > 0.0).collect();
    let before: Vec<Vec<[f64; 2]>> = rings.to_vec();
    for ring in rings.iter_mut() {
        let mut k = 0;
        // Bounded: every pass either removes a vertex or advances `k`.
        while ring.len() > 3 && k < ring.len() {
            let n = ring.len();
            let (a, b, c) = (ring[(k + n - 1) % n], ring[k], ring[(k + 1) % n]);
            let ab = sub(b, a);
            let bc = sub(c, b);
            let cross = ab[0] * bc[1] - ab[1] * bc[0];
            let len = (dot(ab, ab).sqrt() * dot(bc, bc).sqrt()).max(1e-300);
            let straight = dot(ab, bc) > 0.0 && (orientation(a, b, c) == 0 || cross.abs() / len < 1e-9);
            if straight {
                ring.remove(k);
            } else {
                k += 1;
            }
        }
    }
    if !find_violations(rings, parents, &expect_outer).is_empty() {
        rings.clone_from_slice(&before);
    }
}

pub(super) fn bbox(ring: &[[f64; 2]]) -> [f64; 4] {
    let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for p in ring {
        b = [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])];
    }
    b
}

fn box_contains(b: &[f64; 4], p: [f64; 2]) -> bool {
    p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3]
}

#[inline]
fn sub(a: [f64; 2], b: [f64; 2]) -> [f64; 2] {
    [a[0] - b[0], a[1] - b[1]]
}

#[inline]
fn dot(a: [f64; 2], b: [f64; 2]) -> f64 {
    a[0] * b[0] + a[1] * b[1]
}
