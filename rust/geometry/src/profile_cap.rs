// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Recover cap boundaries lost with unrepresentable faces (#7631,
//! the source-cap defect isolated from #6940's opening-weld defect).
//!
//! This is a narrow retry for an earcut TRIANGLE DEFICIT on a profile with
//! holes and an exact-positive f64 face that collapses or reverses in local
//! f32. Representable caps retain established triangulation and hygiene,
//! including geometrically valid collinear subdivisions. A complete cap
//! over N nonduplicate boundary vertices and H disjoint interior holes has
//! N + 2H - 2 triangles. An equal-count result keeps the established path.
//! A deficit only triggers inspection: actual missing boundaries, a valid
//! ring domain, and a complete oriented CDT are required before adoption.
//! Faces outside the missing/collapsed vertex stars retain their diagonals;
//! opening arrangements must not change merely because a remote cap is repaired.

use crate::math::geom2d::{on_segment, orientation, segments_intersect};
use nalgebra::Point2;
use rustc_hash::{FxHashMap, FxHashSet};

type Edge = (usize, usize);

// The optional domain proof scans segment pairs. Bound that work independently
// of file size: at most 32,640 pairs, before entering the existing bounded CDT.
// Larger profiles retain safe_earcut, just as a declined constrained retry does.
const MAX_RECOVERY_VERTICES: usize = 256;

fn point(data: &[f64], i: usize) -> [f64; 2] {
    [data[2 * i], data[2 * i + 1]]
}
fn edge(a: usize, b: usize) -> Edge {
    (a.min(b), a.max(b))
}

/// Normalise only consecutive and closing coordinate duplicates, exactly as
/// safe_earcut does. Retain collinear corners and distinct nearly equal points.
/// `original` supplies an index remap, never a floating-point coordinate lookup.
fn normalized_ring(data: &[f64], start: usize, end: usize) -> Vec<usize> {
    let mut original = Vec::with_capacity((end - start).min(MAX_RECOVERY_VERTICES));
    for i in start..end {
        if original
            .last()
            .is_none_or(|&j| point(data, i) != point(data, j))
        {
            original.push(i);
        }
    }
    if original.len() > 1 && point(data, original[0]) == point(data, *original.last().unwrap()) {
        original.pop();
    }
    original
}

/// Effective vertex count without allocating the retry's rings/maps on the
/// ordinary path. Closing/consecutive duplicates contribute no profile edge.
fn ring_len(data: &[f64], start: usize, end: usize) -> usize {
    if start == end {
        return 0;
    }
    let count = 1
        + (start + 1..end)
            .filter(|&i| point(data, i) != point(data, i - 1))
            .count();
    count - usize::from(count > 1 && point(data, start) == point(data, end - 1))
}

fn contains(p: [f64; 2], ring: &[usize], data: &[f64]) -> bool {
    let mut inside = false;
    for i in 0..ring.len() {
        let (a, b) = (
            point(data, ring[i]),
            point(data, ring[(i + 1) % ring.len()]),
        );
        if (a[1] > p[1]) != (b[1] > p[1]) && (orientation(a, b, p) > 0) == (b[1] > a[1]) {
            inside = !inside;
        }
    }
    inside
}

/// Decline malformed profiles rather than reinterpret safe_earcut's outside
/// rings (separate polygons), straddlers, touching rings or nested holes.
fn simple_domain(rings: &[Vec<usize>], data: &[f64]) -> bool {
    let edges: Vec<Edge> = rings
        .iter()
        .flat_map(|r| (0..r.len()).map(move |i| (r[i], r[(i + 1) % r.len()])))
        .collect();
    for (i, &(a, b)) in edges.iter().enumerate() {
        for &(c, d) in &edges[i + 1..] {
            let (pa, pb, pc, pd) = (
                point(data, a),
                point(data, b),
                point(data, c),
                point(data, d),
            );
            // Adjacent edges may meet at their common endpoint, but may not
            // double back and overlap. All other contact is rejected.
            if b == c {
                if on_segment(pb, pa, pd) || on_segment(pb, pd, pa) {
                    return false;
                }
            } else if a == d {
                if on_segment(pa, pb, pc) || on_segment(pa, pc, pb) {
                    return false;
                }
            } else if segments_intersect(pa, pb, pc, pd) {
                return false;
            }
        }
    }
    for (i, ring) in rings.iter().enumerate().skip(1) {
        let p = point(data, ring[0]);
        if !contains(p, &rings[0], data) {
            return false;
        }
        for (j, other) in rings.iter().enumerate().skip(1) {
            if i != j && contains(p, other, data) {
                return false;
            }
        }
    }
    true
}

/// A CCW planar cap has every boundary edge once and every other edge once
/// each way. Requiring the COMPLETE edge set also rejects extra boundaries,
/// duplicate faces, zero-area triangles and a missing disconnected region.
fn complete_cap(indices: &[usize], rings: &[Vec<usize>], data: &[f64]) -> bool {
    if !indices.len().is_multiple_of(3) {
        return false;
    }
    let boundary: FxHashSet<Edge> = rings
        .iter()
        .flat_map(|r| (0..r.len()).map(move |i| edge(r[i], r[(i + 1) % r.len()])))
        .collect();
    let mut uses: FxHashMap<Edge, (usize, usize)> = FxHashMap::default();
    for t in indices.chunks_exact(3) {
        if t.iter().any(|&i| i >= data.len() / 2)
            || orientation(point(data, t[0]), point(data, t[1]), point(data, t[2])) <= 0
        {
            return false;
        }
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            let counts = uses.entry(edge(a, b)).or_default();
            if a < b {
                counts.0 += 1;
            } else {
                counts.1 += 1;
            }
        }
    }
    boundary
        .iter()
        .all(|e| uses.get(e).is_some_and(|&(f, r)| f + r == 1))
        && uses.iter().all(|(e, &(f, r))| {
            if boundary.contains(e) {
                f + r == 1
            } else {
                f == 1 && r == 1
            }
        })
}

/// `Some(true)` identifies the measured lost-face class: every input triangle
/// is finite and positive in f64, but at least one is zero/reversed after the
/// mesh's local f32 cast. Nonfinite casts are unsupported, not a repair trigger.
/// This selects a bounded retry; it does not certify later placement or RTC.
fn unrepresentable_face(data: &[f64], indices: &[usize]) -> Option<bool> {
    if !indices.len().is_multiple_of(3) {
        return None;
    }
    let mut found = false;
    for t in indices.chunks_exact(3) {
        if t.iter().any(|&i| i >= data.len() / 2) {
            return None;
        }
        let original = [point(data, t[0]), point(data, t[1]), point(data, t[2])];
        if !original.iter().flatten().all(|v| v.is_finite())
            || orientation(original[0], original[1], original[2]) <= 0
        {
            return None;
        }
        let rounded = original.map(|p| p.map(|v| f64::from(v as f32)));
        if !rounded.iter().flatten().all(|v| v.is_finite()) {
            return None;
        }
        found |= orientation(rounded[0], rounded[1], rounded[2]) <= 0;
    }
    Some(found)
}

pub(super) fn recover_missing_boundaries(
    data: &[f64],
    holes: &[usize],
    earcut: &[usize],
) -> Option<Vec<usize>> {
    if holes.is_empty() {
        return None;
    }
    let mut count = 0usize;
    let mut start = 0;
    for end in holes.iter().copied().chain(std::iter::once(data.len() / 2)) {
        let n = ring_len(data, start, end);
        if n < 3 {
            return None;
        }
        count += n;
        start = end;
    }
    let expected = count + 2 * holes.len() - 2;
    if earcut.len() / 3 >= expected
        || count > MAX_RECOVERY_VERTICES
        || unrepresentable_face(data, earcut) != Some(true)
    {
        return None;
    }

    let mut rings = Vec::with_capacity(holes.len() + 1);
    start = 0;
    for end in holes.iter().copied().chain(std::iter::once(data.len() / 2)) {
        rings.push(normalized_ring(data, start, end));
        start = end;
    }
    // safe_earcut already remaps its indices to the first nonduplicate source
    // vertex, which is also the normalization convention above.
    if complete_cap(earcut, &rings, data) || !simple_domain(&rings, data) {
        return None;
    }

    let normalized: Vec<Vec<Point2<f64>>> = rings
        .iter()
        .map(|r| {
            r.iter()
                .map(|&i| {
                    let p = point(data, i);
                    Point2::new(p[0], p[1])
                })
                .collect()
        })
        .collect();
    let original: Vec<usize> = rings.iter().flatten().copied().collect();
    // Preserve earcut faces outside the affected vertex stars: changing unrelated diagonals
    // changes the exact-kernel opening arrangement (#7631, Revit 13797).
    // Only the affected vertex stars may be retriangulated.
    let points: Vec<Point2<f64>> = normalized.into_iter().flatten().collect();
    let remap: FxHashMap<usize, usize> = original
        .iter().enumerate().map(|(i, &source)| (source, i)).collect();
    let mut constraints: Vec<Edge> = rings.iter().flat_map(|r| {
        (0..r.len()).map(|i| edge(remap[&r[i]], remap[&r[(i + 1) % r.len()]]))
    }).collect();
    let existing_edges: FxHashSet<Edge> = earcut.chunks_exact(3)
        .flat_map(|t| (0..3).map(move |i| edge(t[i], t[(i + 1) % 3])))
        .collect();
    let mut repair_vertices: FxHashSet<usize> = earcut.chunks_exact(3)
        .filter(|t| unrepresentable_face(data, t) == Some(true))
        .flatten().copied().collect();
    for ring in &rings {
        for i in 0..ring.len() {
            let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
            if !existing_edges.contains(&edge(a, b)) {
                repair_vertices.extend([a, b]);
            }
        }
    }
    for triangle in earcut.chunks_exact(3) {
        // A collapsed face needs its incident vertex star to change diagonals;
        // locking its neighbouring faces would lock the collapsed face too.
        if !triangle.iter().any(|i| repair_vertices.contains(i)) {
            for i in 0..3 {
                constraints.push(edge(remap[&triangle[i]], remap[&triangle[(i + 1) % 3]]));
            }
        }
    }
    constraints.sort_unstable();
    constraints.dedup();
    let (points, all_indices) = crate::cdt::triangulate_pslg(&points, &constraints)?;
    let indices: Vec<usize> = all_indices.chunks_exact(3).filter(|t| {
        let p = [(points[t[0]].x + points[t[1]].x + points[t[2]].x) / 3.0,
                 (points[t[0]].y + points[t[1]].y + points[t[2]].y) / 3.0];
        contains(p, &rings[0], data) && !rings[1..].iter().any(|r| contains(p, r, data))
    }).flatten().copied().collect();
    // No Steiner vertices and no reordered/replaced inputs: keep the generic
    // scalar coordinates, not f64 values reconstructed from a coordinate map.
    if points.len() != original.len()
        || indices.len() / 3 != expected
        || !points
            .iter()
            .zip(&original)
            .all(|(p, &i)| [p.x, p.y] == point(data, i))
    {
        return None;
    }
    let remapped: Option<Vec<usize>> = indices.iter().map(|&i| original.get(i).copied()).collect();
    let remapped = remapped?;
    (complete_cap(&remapped, &rings, data) && unrepresentable_face(data, &remapped) == Some(false))
        .then_some(remapped)
}

#[cfg(test)]
#[path = "profile_cap_predicate_tests.rs"]
mod predicate_tests;
