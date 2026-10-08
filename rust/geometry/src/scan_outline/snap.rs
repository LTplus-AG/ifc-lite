// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Snap simplified rings back onto the point evidence.
//!
//! The traced rings follow cell edges, up to a cell off the surface the points
//! sample, and the closing rounds every inside corner into a short arc. For
//! each edge this gathers the points in a band beside it, on the solid side
//! where the surface is, fits a total-least-squares line and refits once on
//! the inliers. Then, per ring:
//! - consecutive edges whose fitted lines coincide merge into one edge;
//! - a short run of edges with no evidence of its own between two fitted
//!   edges that meet at an angle (the rounded corner) is replaced by the point
//!   where those two lines meet;
//! - every remaining vertex moves to where its two edges' lines meet.
//!
//! Merged edges are refitted, up to `PASSES` times. An edge without enough
//! evidence keeps its own line.

use super::fit::{cap_position, edge_line, fit_edge, intersect, Line};
use super::grid::PointIndex;
use super::ScanOutlineOptions;

/// Rounds of fit → merge.
const PASSES: usize = 4;
/// Fitted neighbours within this angle whose shorter edge lies on the longer
/// one's line (within the offset) are one wall.
const MERGE_ANGLE_RAD: f64 = 15.0 * std::f64::consts::PI / 180.0;
const MERGE_OFFSET_CELLS: f64 = 0.75;
/// A rounded corner joins edges at least this far apart in direction.
const CORNER_ANGLE_RAD: f64 = 30.0 * std::f64::consts::PI / 180.0;
/// Edges turned back on each other to within this of 180° are the two faces
/// of a thin wall, and the run between them is its end.
const CAP_ANGLE_RAD: f64 = 20.0 * std::f64::consts::PI / 180.0;

pub(super) struct Snapped {
    pub rings: Vec<Vec<[f64; 2]>>,
    /// Per output vertex, where it stood before it was moved: the input vertex
    /// it descends from, or the rebuilt corner point. Same shape as `rings`;
    /// the repair loop reverts moves to these.
    pub references: Vec<Vec<[f64; 2]>>,
    pub fitted_edges: usize,
}

pub(super) struct SnapContext<'a> {
    pub index: &'a PointIndex,
    pub xy: &'a [f32],
    pub cell: f64,
    pub close_radius_cells: usize,
    pub opts: &'a ScanOutlineOptions,
}

pub(super) fn snap_rings(rings: &[Vec<[f64; 2]>], ctx: &SnapContext) -> Snapped {
    let g = &ctx.index.geometry;
    let mut stamp = Stamp { cells: vec![u32::MAX; g.width * g.height], id: 0 };
    let mut fitted_edges = 0usize;
    let mut out = Vec::with_capacity(rings.len());
    let mut references = Vec::with_capacity(rings.len());
    for ring in rings {
        let mut verts = ring.clone();
        let mut refs = ring.clone();
        let mut lines = Vec::new();
        let mut fitted = Vec::new();
        for pass in 0..PASSES {
            (lines, fitted) = fit_ring(&verts, ctx, &mut stamp);
            if pass + 1 == PASSES {
                break;
            }
            match rebuild(&verts, &lines, &fitted, ctx) {
                Some((next, sources)) => {
                    refs = sources.iter().zip(&next).map(|(src, p)| src.map_or(*p, |k| refs[k])).collect();
                    verts = next;
                }
                None => break,
            }
        }
        fitted_edges += fitted.iter().filter(|&&f| f).count();
        // A vertex may move as far from where it stood as a rebuilt corner
        // may; the repair loop and the support field judge the result.
        let reach = corner_reach(ctx);
        let n = verts.len();
        let placed = (0..n)
            .map(|k| {
                let p = intersect(lines[(k + n - 1) % n], lines[k], verts[k]);
                if dist(p, refs[k]) <= reach { p } else { refs[k] }
            })
            .collect();
        out.push(placed);
        references.push(refs);
    }
    Snapped { rings: out, references, fitted_edges }
}

struct Stamp {
    cells: Vec<u32>,
    id: u32,
}

fn fit_ring(verts: &[[f64; 2]], ctx: &SnapContext, stamp: &mut Stamp) -> (Vec<Line>, Vec<bool>) {
    let n = verts.len();
    let mut lines = Vec::with_capacity(n);
    let mut fitted = Vec::with_capacity(n);
    for k in 0..n {
        let (a, b) = (verts[k], verts[(k + 1) % n]);
        stamp.id = stamp.id.wrapping_add(1);
        let band = ctx.opts.snap_distance_cells * ctx.cell;
        match fit_edge(a, b, ctx.index, ctx.xy, band, ctx.opts.min_snap_points, &mut stamp.cells, stamp.id) {
            Some(line) => {
                lines.push(line);
                fitted.push(true);
            }
            None => {
                lines.push(edge_line(a, b));
                fitted.push(false);
            }
        }
    }
    (lines, fitted)
}

/// One wall of the rebuilt ring: consecutive original edges that share a line.
struct Group {
    /// Original edge the group starts with.
    start: usize,
    /// Line of its longest fitted edge (or its own line when unfitted).
    line: Line,
    line_len: f64,
    /// Where the group starts when a rounded corner before it was replaced.
    corner: Option<[f64; 2]>,
}

/// Merge coincident fitted neighbours and replace rounded corners. Returns
/// the new vertices and, per vertex, the input vertex it stands for (`None`
/// for a rebuilt corner). `None` when nothing changes.
fn rebuild(verts: &[[f64; 2]], lines: &[Line], fitted: &[bool], ctx: &SnapContext) -> Option<(Vec<[f64; 2]>, Vec<Option<usize>>)> {
    let n = verts.len();
    let fitted_idx: Vec<usize> = (0..n).filter(|&k| fitted[k]).collect();
    if fitted_idx.len() < 2 {
        return None;
    }
    let corner_max_len = corner_reach(ctx);
    let merge_offset = MERGE_OFFSET_CELLS * ctx.cell;
    let edge_len = |e: usize| dist(verts[e], verts[(e + 1) % n]);
    let joins = |g: &Group, e: usize| {
        angle_between(g.line, lines[e]) <= MERGE_ANGLE_RAD && collinear(verts, n, g.line, g.line_len, e, lines[e], merge_offset)
    };
    // Start at a fitted edge that does not continue the previous fitted one,
    // so no wall is split across the wrap.
    let m = fitted_idx.len();
    let first = (0..m).find(|&i| {
        let (p, c) = (fitted_idx[(i + m - 1) % m], fitted_idx[i]);
        let g = Group { start: p, line: lines[p], line_len: edge_len(p), corner: None };
        !joins(&g, c)
    })?;
    let f0 = fitted_idx[first];
    let mut groups: Vec<Group> = vec![Group { start: f0, line: lines[f0], line_len: edge_len(f0), corner: None }];
    let mut prev = f0;
    for i in 1..=m {
        let b = fitted_idx[(first + i) % m];
        let run: Vec<usize> = (1..((b + n - prev) % n).max(1)).map(|s| (prev + s) % n).collect();
        let run_len: f64 = run.iter().map(|&e| edge_len(e)).sum();
        let wrap = i == m;
        let cur = groups.last().expect("one group");
        if !wrap && run_len <= corner_max_len && joins(cur, b) {
            let g = groups.last_mut().expect("one group");
            if edge_len(b) > g.line_len {
                g.line = lines[b];
                g.line_len = edge_len(b);
            }
            prev = b;
            continue;
        }
        let angle = angle_between(cur.line, lines[b]);
        if !run.is_empty() && run_len <= corner_max_len && angle >= std::f64::consts::PI - CAP_ANGLE_RAD {
            if let Some((p1, cap, p2)) = end_cap(cur.line, lines[b], &run, verts, ctx, corner_max_len) {
                groups.push(Group { start: run[0], line: cap, line_len: dist(p1, p2), corner: Some(p1) });
                if wrap {
                    groups[0].corner = Some(p2);
                } else {
                    groups.push(Group { start: b, line: lines[b], line_len: edge_len(b), corner: Some(p2) });
                }
                prev = b;
                continue;
            }
        }
        let mut corner = None;
        if !run.is_empty() && run_len <= corner_max_len && angle >= CORNER_ANGLE_RAD && angle < std::f64::consts::PI - CAP_ANGLE_RAD {
            let p = intersect(cur.line, lines[b], verts[b]);
            if (0..=run.len()).all(|s| dist(p, verts[(prev + 1 + s) % n]) <= corner_max_len) {
                corner = Some(p);
            }
        }
        if corner.is_none() {
            for &e in &run {
                groups.push(Group { start: e, line: lines[e], line_len: edge_len(e), corner: None });
            }
        }
        if wrap {
            groups[0].corner = corner;
        } else {
            groups.push(Group { start: b, line: lines[b], line_len: edge_len(b), corner });
        }
        prev = b;
    }
    let k = groups.len();
    if k == n || k < 3 {
        return None;
    }
    // Each group starts where the previous group's line meets its own.
    let vertices = (0..k)
        .map(|i| {
            let (g0, g1) = (&groups[(i + k - 1) % k], &groups[i]);
            g1.corner.unwrap_or_else(|| {
                let old = verts[g1.start];
                let p = intersect(g0.line, g1.line, old);
                if dist(p, old) <= corner_max_len { p } else { old }
            })
        })
        .collect();
    let sources = groups.iter().map(|g| if g.corner.is_some() { None } else { Some(g.start) }).collect();
    Some((vertices, sources))
}

/// Square end of a thin wall whose faces run along `a` and back along `b`,
/// replacing the unfitted `run` between them: the end face sits where the
/// points between the two lines stop. Returns its two corners and its line.
fn end_cap(a: Line, b: Line, run: &[usize], verts: &[[f64; 2]], ctx: &SnapContext, reach: f64) -> Option<([f64; 2], Line, [f64; 2])> {
    let n = verts.len();
    let along = |p: [f64; 2]| (p[0] - a.point[0]) * a.dir[0] + (p[1] - a.point[1]) * a.dir[1];
    let ts: Vec<f64> = run.iter().flat_map(|&e| [along(verts[e]), along(verts[(e + 1) % n])]).collect();
    let t_max = ts.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let t_min = ts.iter().copied().fold(f64::INFINITY, f64::min);
    let t = cap_position(a, b, t_min - reach, t_max + 2.0 * ctx.cell, ctx.index, ctx.xy, ctx.opts.min_snap_points)?;
    if t > t_max + 2.0 * ctx.cell || t < t_max - reach {
        return None;
    }
    let p1 = [a.point[0] + t * a.dir[0], a.point[1] + t * a.dir[1]];
    // The end face runs from line `a` across to line `b`, square to `a`.
    let cap = Line { point: p1, dir: [a.dir[1], -a.dir[0]] };
    let normal = [-a.dir[1], a.dir[0]];
    let cap = Line { dir: if (b.point[0] - p1[0]) * normal[0] + (b.point[1] - p1[1]) * normal[1] >= 0.0 { normal } else { cap.dir }, ..cap };
    let p2 = intersect(cap, b, p1);
    Some((p1, cap, p2))
}

/// How far a rounded corner reaches: the closing rounds an inside corner with
/// a radius of about `close_radius_cells`, and the simplifier may keep
/// vertices a little further out along the walls.
fn corner_reach(ctx: &SnapContext) -> f64 {
    2.0 * (ctx.close_radius_cells as f64 + 3.0) * ctx.cell
}

fn angle_between(a: Line, b: Line) -> f64 {
    let sine = (a.dir[0] * b.dir[1] - a.dir[1] * b.dir[0]).clamp(-1.0, 1.0);
    let cosine = a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1];
    sine.atan2(cosine).abs()
}

/// Edge `e` lies on the wall `line` (fitted over `line_len`): the shorter of
/// the two, over its own extent, stays within `tol` of the longer one's line.
/// (A short edge's own fit can be off by a few degrees, so direction alone
/// does not decide; the traced vertices sit up to a cell off the surface, so
/// they are projected onto the fitted line first.)
fn collinear(verts: &[[f64; 2]], n: usize, line: Line, line_len: f64, e: usize, le: Line, tol: f64) -> bool {
    let (e0, e1) = (verts[e], verts[(e + 1) % n]);
    let d = |p: [f64; 2], l: Line| ((p[0] - l.point[0]) * l.dir[1] - (p[1] - l.point[1]) * l.dir[0]).abs();
    if dist(e0, e1) <= line_len {
        d(project(e0, le), line).max(d(project(e1, le), line)) <= tol
    } else {
        // The wall so far is the shorter part: its anchor and a point
        // `line_len` along it must sit on the edge's line.
        let half = [line.dir[0] * line_len * 0.5, line.dir[1] * line_len * 0.5];
        let (p0, p1) = ([line.point[0] - half[0], line.point[1] - half[1]], [line.point[0] + half[0], line.point[1] + half[1]]);
        d(p0, le).max(d(p1, le)) <= tol
    }
}

fn project(p: [f64; 2], l: Line) -> [f64; 2] {
    let t = (p[0] - l.point[0]) * l.dir[0] + (p[1] - l.point[1]) * l.dir[1];
    [l.point[0] + t * l.dir[0], l.point[1] + t * l.dir[1]]
}

#[inline]
fn dist(a: [f64; 2], b: [f64; 2]) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

