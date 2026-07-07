// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use rustc_hash::FxHashMap;

use super::geom2d::line_intersection;
use super::{InputSegment, EPS};

/// An undirected edge of the resolved arrangement.
pub(super) struct ArrEdge {
    pub(super) a: usize,
    pub(super) b: usize,
    pub(super) source: Option<u32>,
    pub(super) half_thickness: f64,
}

/// The planar arrangement: snapped vertices + split, deduped edges. This is
/// the faithful port of the `auto-space-detect.ts` geometry, with a
/// `source` tag threaded through every stage.
pub(super) struct Arrangement {
    pub(super) vertices: Vec<[f64; 2]>,
    pub(super) edges: Vec<ArrEdge>,
}

impl Arrangement {
    pub(super) fn resolve(segments: &[InputSegment], snap: f64) -> Arrangement {
        // Corner cleanup first: real wall centrelines miss each corner by ~half
        // a wall thickness (one overshoots, the neighbour undershoots), so a
        // plain endpoint snap closes them at a skewed position → trapezoids.
        // Pull each wall-end onto the true intersection of its line with the
        // nearest crossing wall so orthogonal walls form clean rectangles.
        let mut owned: Vec<InputSegment> = segments.to_vec();
        snap_corners(&mut owned, snap);
        let segments: &[InputSegment] = &owned;
        let cell = snap.max(EPS);
        let mut vertices: Vec<[f64; 2]> = Vec::new();
        let mut grid: FxHashMap<(i64, i64), Vec<usize>> = FxHashMap::default();
        let snap_sq = snap * snap;

        let mut lookup = |pt: [f64; 2], vertices: &mut Vec<[f64; 2]>| -> usize {
            let cx = (pt[0] / cell).floor() as i64;
            let cy = (pt[1] / cell).floor() as i64;
            for dx in -1..=1 {
                for dy in -1..=1 {
                    if let Some(bucket) = grid.get(&(cx + dx, cy + dy)) {
                        for &id in bucket {
                            let ddx = vertices[id][0] - pt[0];
                            let ddy = vertices[id][1] - pt[1];
                            if ddx * ddx + ddy * ddy <= snap_sq {
                                return id;
                            }
                        }
                    }
                }
            }
            let id = vertices.len();
            vertices.push(pt);
            grid.entry((cx, cy)).or_default().push(id);
            id
        };

        // 1. Snap endpoints. `Seg` carries its source through every stage.
        let mut segs: Vec<Seg> = Vec::with_capacity(segments.len());
        for s in segments {
            let ai = lookup(s.a, &mut vertices);
            let bi = lookup(s.b, &mut vertices);
            if ai != bi {
                segs.push(Seg { a: ai, b: bi, source: s.source_element, half_thickness: s.half_thickness });
            }
        }

        // 2. T-junction snap: a dangling endpoint that lands inside another
        // segment splits that host at the projection.
        let mut guard = 0usize;
        let limit = (segments.len() * 5).max(50);
        loop {
            let mut applied = false;
            let endpoints: Vec<usize> = {
                let mut s: Vec<usize> = segs.iter().flat_map(|s| [s.a, s.b]).collect();
                s.sort_unstable();
                s.dedup();
                s
            };
            for vid in endpoints {
                let p = vertices[vid];
                for si in 0..segs.len() {
                    let Seg { a, b, source, half_thickness } = segs[si];
                    if a == vid || b == vid {
                        continue;
                    }
                    if let Some((proj, t)) = closest_point_on_segment(p, vertices[a], vertices[b]) {
                        let ddx = proj[0] - p[0];
                        let ddy = proj[1] - p[1];
                        if ddx * ddx + ddy * ddy > snap_sq {
                            continue;
                        }
                        if !(1e-6..=1.0 - 1e-6).contains(&t) {
                            continue; // endpoint, not interior
                        }
                        segs[si] = Seg { a, b: vid, source, half_thickness };
                        segs.push(Seg { a: vid, b, source, half_thickness });
                        applied = true;
                        // Apply ALL splits found this sweep (one per endpoint), not
                        // one per full O(n^2) pass: the T-junction fixpoint is
                        // order-independent (each split only subdivides an existing
                        // segment at an existing vertex), so this converges in a few
                        // sweeps instead of O(n) -> drops the pass from O(n^3) to
                        // ~O(n^2). Break only the inner scan for this endpoint.
                        break;
                    }
                }
            }
            guard += 1;
            if !applied || guard >= limit {
                break;
            }
        }

        // 3. Interior crossings: collect every split position per seed segment
        // in one O(N²) pass (bbox-pruned), then cut each segment once.
        let seeds: Vec<Seg> = segs.clone();
        let mut splits: Vec<Vec<(f64, usize)>> =
            seeds.iter().map(|s| vec![(0.0, s.a), (1.0, s.b)]).collect();
        let bboxes: Vec<[f64; 4]> = seeds
            .iter()
            .map(|s| {
                let (pa, pb) = (vertices[s.a], vertices[s.b]);
                [pa[0].min(pb[0]), pa[1].min(pb[1]), pa[0].max(pb[0]), pa[1].max(pb[1])]
            })
            .collect();
        for i in 0..seeds.len() {
            for j in (i + 1)..seeds.len() {
                let (si, sj) = (&seeds[i], &seeds[j]);
                if si.a == sj.a || si.a == sj.b || si.b == sj.a || si.b == sj.b {
                    continue;
                }
                let (bi, bj) = (bboxes[i], bboxes[j]);
                if bi[2] < bj[0] || bj[2] < bi[0] || bi[3] < bj[1] || bj[3] < bi[1] {
                    continue;
                }
                if let Some((point, t, u)) = segment_intersection_param(
                    vertices[si.a], vertices[si.b], vertices[sj.a], vertices[sj.b],
                ) {
                    let nv = lookup(point, &mut vertices);
                    if nv != si.a && nv != si.b {
                        splits[i].push((t, nv));
                    }
                    if nv != sj.a && nv != sj.b {
                        splits[j].push((u, nv));
                    }
                }
            }
        }

        // 4. Emit split pieces, deduped on the undirected pair.
        let mut edges: Vec<ArrEdge> = Vec::new();
        let mut seen: std::collections::HashSet<(usize, usize)> = std::collections::HashSet::new();
        for (i, mut cuts) in splits.into_iter().enumerate() {
            let source = seeds[i].source;
            let ht = seeds[i].half_thickness;
            if cuts.len() <= 2 {
                push_edge(&mut edges, &mut seen, cuts[0].1, cuts[1].1, source, ht);
                continue;
            }
            cuts.sort_by(|p, q| p.0.partial_cmp(&q.0).unwrap_or(std::cmp::Ordering::Equal));
            for w in cuts.windows(2) {
                push_edge(&mut edges, &mut seen, w[0].1, w[1].1, source, ht);
            }
        }

        Arrangement { vertices, edges }
    }
}

#[derive(Clone, Copy)]
struct Seg {
    a: usize,
    b: usize,
    source: Option<u32>,
    half_thickness: f64,
}

fn push_edge(
    edges: &mut Vec<ArrEdge>,
    seen: &mut std::collections::HashSet<(usize, usize)>,
    a: usize,
    b: usize,
    source: Option<u32>,
    half_thickness: f64,
) {
    if a == b {
        return;
    }
    let key = if a < b { (a, b) } else { (b, a) };
    if seen.insert(key) {
        edges.push(ArrEdge { a, b, source, half_thickness });
    }
}

/// Pull each wall-end onto the true line-intersection with the nearest crossing
/// wall (within `tol`), so offset centrelines — whose ends miss the corner by
/// ~half a wall thickness — close into clean (e.g. rectangular) rooms instead
/// of trapezoids. Intersections are computed against the original geometry;
/// ends with no crossing wall within `tol` are left untouched (leaks stay
/// leaks). T-junctions fall out for free: an end near where its line crosses
/// another wall snaps onto that crossing.
pub(super) fn snap_corners(segs: &mut [InputSegment], tol: f64) {
    let lines: Vec<([f64; 2], [f64; 2])> = segs.iter().map(|s| (s.a, s.b)).collect();
    let n = lines.len();
    let tol2 = tol * tol;
    for i in 0..n {
        for slot in 0..2 {
            let e = if slot == 0 { segs[i].a } else { segs[i].b };
            let mut best: Option<[f64; 2]> = None;
            let mut best_d2 = tol2;
            for j in 0..n {
                if i == j {
                    continue;
                }
                let Some(p) = line_intersection(lines[i].0, lines[i].1, lines[j].0, lines[j].1) else {
                    continue;
                };
                // The intersection must lie near segment j's FINITE extent, not
                // just its infinite line — else a distant aligned wall could
                // pull this end onto a phantom corner and fabricate a room.
                match closest_point_on_segment(p, lines[j].0, lines[j].1) {
                    Some((host, _)) if (host[0] - p[0]).powi(2) + (host[1] - p[1]).powi(2) <= tol2 => {}
                    _ => continue,
                }
                let d2 = (p[0] - e[0]).powi(2) + (p[1] - e[1]).powi(2);
                if d2 < best_d2 {
                    best_d2 = d2;
                    best = Some(p);
                }
            }
            if let Some(p) = best {
                if slot == 0 {
                    segs[i].a = p;
                } else {
                    segs[i].b = p;
                }
            }
        }
    }
}

fn closest_point_on_segment(q: [f64; 2], a: [f64; 2], b: [f64; 2]) -> Option<([f64; 2], f64)> {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let len2 = dx * dx + dy * dy;
    if len2 < 1e-12 {
        return None;
    }
    let mut t = ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / len2;
    t = t.clamp(0.0, 1.0);
    Some(([a[0] + t * dx, a[1] + t * dy], t))
}

/// Proper-crossing test. Returns the point + both parametric positions when
/// the segments cross strictly inside at least one of them (a shared endpoint
/// alone produces no new vertex). Naive f64 — see the robustness TODO.
pub(super) fn segment_intersection_param(
    p1: [f64; 2], p2: [f64; 2], p3: [f64; 2], p4: [f64; 2],
) -> Option<([f64; 2], f64, f64)> {
    let denom = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0]);
    if denom.abs() < EPS {
        return None;
    }
    let t = ((p1[0] - p3[0]) * (p3[1] - p4[1]) - (p1[1] - p3[1]) * (p3[0] - p4[0])) / denom;
    let u = -((p1[0] - p2[0]) * (p1[1] - p3[1]) - (p1[1] - p2[1]) * (p1[0] - p3[0])) / denom;
    let tol = 1e-7;
    if !(-tol..=1.0 + tol).contains(&t) || !(-tol..=1.0 + tol).contains(&u) {
        return None;
    }
    if (t < tol || t > 1.0 - tol) && (u < tol || u > 1.0 - tol) {
        return None;
    }
    Some(([p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])], t, u))
}
