// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Topology-preserving Douglas-Peucker over a set of closed rings.
//!
//! Each ring is split at two anchors (its first vertex and the vertex farthest
//! from it) and both chains are simplified with the usual farthest-point
//! recursion, run on an explicit stack. The kept vertices are a subset of the
//! traced ones, so every simplified edge stands for a span of original edges.
//! Whenever a simplified edge touches or crosses another edge, folds back, or
//! a ring flips or leaves its container, the farthest original vertex of the
//! offending span is put back. The traced rings are valid, and a span of one
//! original edge cannot be split further, so the loop ends; a capped number of
//! rounds is followed by restoring any ring still involved in full.

use super::topology::{find_violations, Violations};
use crate::geom2d::{perp_distance, polygon_area};

/// Reinsertion rounds before involved rings are restored to the trace.
const MAX_ROUNDS: usize = 256;

/// Simplify `rings` with tolerance `eps`. Returns the rings and the number of
/// vertices reinserted to keep the set valid.
pub(super) fn simplify_rings(rings: &[Vec<[f64; 2]>], parents: &[Option<usize>], eps: f64) -> (Vec<Vec<[f64; 2]>>, usize) {
    let expect_outer: Vec<bool> = rings.iter().map(|r| polygon_area(r) > 0.0).collect();
    let mut keeps: Vec<Vec<usize>> = rings.iter().map(|r| dp_ring(r, eps)).collect();
    let mut reinserted = 0usize;
    for round in 0..=MAX_ROUNDS {
        let current = materialise(rings, &keeps);
        let v = find_violations(&current, parents, &expect_outer);
        if v.is_empty() {
            return (current, reinserted);
        }
        let added = if round == MAX_ROUNDS { 0 } else { reinsert(rings, &mut keeps, &v) };
        if added == 0 {
            // No span left to split: restore the rings involved in full.
            restore_involved(rings, &mut keeps, &v);
            let restored = materialise(rings, &keeps);
            let still = find_violations(&restored, parents, &expect_outer);
            if still.is_empty() {
                return (restored, reinserted);
            }
            return (rings.to_vec(), reinserted);
        }
        reinserted += added;
    }
    (rings.to_vec(), reinserted)
}

fn materialise(rings: &[Vec<[f64; 2]>], keeps: &[Vec<usize>]) -> Vec<Vec<[f64; 2]>> {
    rings
        .iter()
        .zip(keeps)
        .map(|(ring, keep)| keep.iter().map(|&i| ring[i]).collect())
        .collect()
}

/// Split every offending span at its farthest original vertex.
fn reinsert(rings: &[Vec<[f64; 2]>], keeps: &mut [Vec<usize>], v: &Violations) -> usize {
    let mut added = 0usize;
    let mut targets: Vec<(usize, usize)> = v.edges.iter().map(|e| (e.ring, e.edge)).collect();
    for &r in &v.rings {
        for k in 0..keeps[r].len() {
            targets.push((r, k));
        }
    }
    // Insert from the highest edge index down so earlier indices stay valid.
    targets.sort_unstable_by(|a, b| b.cmp(a));
    targets.dedup();
    for (r, k) in targets {
        let ring = &rings[r];
        let n = ring.len();
        let keep = &mut keeps[r];
        let m = keep.len();
        if k >= m {
            continue;
        }
        let (i, j) = (keep[k], keep[(k + 1) % m]);
        let span = (j + n - i) % n;
        if span < 2 {
            continue;
        }
        let (a, b) = (ring[i], ring[j]);
        let mut best = (0.0f64, usize::MAX);
        for s in 1..span {
            let idx = (i + s) % n;
            let d = perp_distance(ring[idx], a, b);
            if d > best.0 || best.1 == usize::MAX {
                best = (d, idx);
            }
        }
        keep.insert(k + 1, best.1);
        added += 1;
    }
    for keep in keeps.iter_mut() {
        normalise(keep);
    }
    added
}

/// A ring's kept indices are stored in ring order starting at its smallest
/// index, so the edge numbering of `find_violations` matches `keep`.
fn normalise(keep: &mut Vec<usize>) {
    if let Some(min_pos) = keep.iter().enumerate().min_by_key(|(_, &v)| v).map(|(p, _)| p) {
        keep.rotate_left(min_pos);
    }
    keep.dedup();
}

fn restore_involved(rings: &[Vec<[f64; 2]>], keeps: &mut [Vec<usize>], v: &Violations) {
    let mut involved: Vec<usize> = v.edges.iter().map(|e| e.ring).chain(v.rings.iter().copied()).collect();
    involved.sort_unstable();
    involved.dedup();
    for r in involved {
        keeps[r] = (0..rings[r].len()).collect();
    }
}

/// Indices kept by Douglas-Peucker on a closed ring, in ring order.
fn dp_ring(ring: &[[f64; 2]], eps: f64) -> Vec<usize> {
    let n = ring.len();
    if n <= 4 {
        return (0..n).collect();
    }
    let a = ring[0];
    let far = (1..n)
        .max_by(|&i, &j| dist2(ring[i], a).total_cmp(&dist2(ring[j], a)))
        .unwrap_or(n / 2);
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[far] = true;
    dp_chain(ring, 0, far, eps, &mut keep);
    dp_chain(ring, far, n, eps, &mut keep);
    let mut out: Vec<usize> = (0..n).filter(|&i| keep[i]).collect();
    if out.len() < 3 {
        // A sliver thinner than `eps`: keep the farthest vertex from the
        // anchor chord on each side so the ring keeps its area.
        for (lo, hi) in [(1, far), (far + 1, n)] {
            if let Some(i) = (lo..hi).max_by(|&i, &j| {
                perp_distance(ring[i], a, ring[far]).total_cmp(&perp_distance(ring[j], a, ring[far]))
            }) {
                out.push(i);
            }
        }
        out.sort_unstable();
    }
    out
}

/// Farthest-point recursion on the chain `ring[start..=end]`, where `end == n`
/// stands for vertex 0 again. Iterative.
fn dp_chain(ring: &[[f64; 2]], start: usize, end: usize, eps: f64, keep: &mut [bool]) {
    let n = ring.len();
    let at = |i: usize| ring[i % n];
    let mut stack = vec![(start, end)];
    while let Some((s, e)) = stack.pop() {
        if e <= s + 1 {
            continue;
        }
        let (a, b) = (at(s), at(e));
        let mut best = (0.0f64, s);
        for i in s + 1..e {
            let d = perp_distance(at(i), a, b);
            if d > best.0 {
                best = (d, i);
            }
        }
        if best.0 > eps {
            keep[best.1 % n] = true;
            stack.push((s, best.1));
            stack.push((best.1, e));
        }
    }
}

#[inline]
fn dist2(a: [f64; 2], b: [f64; 2]) -> f64 {
    (a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)
}
