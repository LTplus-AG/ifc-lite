// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Reconciling an opening cutter's vertices with its host's (#6940).
//!
//! # What goes wrong without it
//!
//! An IFC file can author one point twice: once as a corner of a hole in the
//! host's profile, once as a corner of the `IfcOpeningElement` that fills
//! that hole. The two copies reach the cut by different arithmetic. The host
//! is placed and stored as f32 once. A cutter is placed down its own chain of
//! placements, and where the host is cut in a local frame it is then moved
//! into that frame by `translate_cutter_mesh`, which writes
//! `(c[0] as f64 + o[0] - host_origin[0]) as f32`: a second f32 round on top
//! of the one that stored `c`. `mesh_to_tris` then snaps each operand to the
//! kernel grid on its own, so wherever the two copies straddle a rounding
//! boundary they land ONE GRID STEP apart.
//!
//! One step is enough to tear the host. The cutter's corner is then off BOTH
//! hole walls that meet at the host's corner. The subtract weld reconciles a
//! vertex with one plane, the nearest, and leaves it off the other, so that
//! cutter wall and its hole wall stop being coplanar and the arrangement
//! leaves T-junctions along them. Measured on a slab whose openings each fill
//! a profile hole: two cutter corners one step off (4.5 micrometres from one
//! wall and 14.6 from the other; the weld took the first) gave 12 open edges,
//! with every other corner agreeing. A one-hole slab with a single corner
//! moved one step reproduces it; see the tests.
//!
//! Which corners straddle a boundary depends on the frame the vertices are
//! stored in, so one file came back closed from one pipeline and torn from
//! another.
//!
//! # The rule
//!
//! Before the cutter is extended through the host, a cutter vertex whose
//! snapped position is within one grid step of a host vertex's on every axis,
//! and equal to no host vertex's, is given that host vertex's coordinates.
//! Two roundings of one point onto a grid differ by at most a step, and no
//! opening is authored a step (15 micrometres) from a host corner on purpose:
//! the kernel already reads eight steps as one surface.
//!
//! * The host is never moved.
//! * The nearest host vertex wins and a tie goes to the smallest grid
//!   position, so the position chosen does not depend on vertex order.
//! * A host vertex that two distinct cutter positions would land on, or that
//!   another cutter vertex already occupies, is given to neither: merging
//!   them would collapse a cutter edge.
//! * A cutter edge that runs along the opening's depth moves as a whole or
//!   not at all: both ends onto host vertices, by the same offset. This one
//!   is measured, not derived. On a wall whose hole arris is itself creased
//!   by a step across the wall's thickness, one end of the cutter's edge
//!   agreed with the arris and the other was a step off; moving that end
//!   took the wall from 32 open edges to 45 (it is torn either way, and why
//!   it got worse was not traced). That wall is cut with its depth along a
//!   coordinate axis, where the two ends of a cutter edge share their other
//!   two coordinates and so round alike: an end that disagrees there says
//!   the HOST arris leans, and a leaning arris has no single position for
//!   the cutter to agree with. So the cutter is left as it was.
//!
//! # What it does not do
//!
//! * It compares vertices, not footprints. A cutter corner that lies on a
//!   host EDGE or FACE rather than at a host vertex is not touched and stays
//!   the subtract weld's business.
//! * An opening that pokes out of its host has its outer ring at no host
//!   vertex, so by the depth-edge rule its corners are not moved even where
//!   the inner ring is a step off. Not measured on any model.
//! * Where the depth axis is oblique to the coordinate axes, the two ends of
//!   a cutter edge round independently, so one end a step off and the other
//!   agreeing is an ordinary outcome there and not a sign of a creased host.
//!   The depth-edge rule declines that case all the same, and such a corner
//!   stays a step off. Not measured on any model; the slabs this was written
//!   for are cut with their depth along an axis.
//! * The step is not widened where f32 is itself coarser than the grid
//!   (coordinates past 256 units). Two roundings can differ by more than a
//!   step there, and such a pair is left alone. No model was measured there.
//! * It does not decide whether the opening removes anything. An opening that
//!   fills a hole exactly is still cut; it no longer misses the hole's
//!   corners.

use crate::kernel::mesh_bridge::SNAP_GRID;
use crate::{Mesh, Vector3};
use rustc_hash::FxHashMap;

/// A position in whole grid steps: what `mesh_to_tris`'s snap makes of it.
type Cell = [i64; 3];

/// Coordinates are keyed up to here: well inside the range where the grid
/// index is exact in `f64` (about 1.4e11), and far past where f32 is coarser
/// than the grid, so nothing beyond it could be reconciled anyway.
const MAX_KEYED_COORD: f32 = 1.0e9;

fn cell(p: &[f32]) -> Cell {
    [0, 1, 2].map(|k| (p[k] as f64 / SNAP_GRID).round() as i64)
}

/// The cutter's triangle edges that run along `depth` (a unit vector), as
/// pairs of distinct snapped positions: at least four grid steps long, and
/// no more than two steps off the axis, which is what f32 storage of a
/// straight extrusion edge can amount to.
fn depth_edges(cutter: &Mesh, depth: Vector3<f64>) -> Vec<(Cell, Cell)> {
    let at = |i: u32| cutter.positions.get(i as usize * 3..i as usize * 3 + 3);
    let mut edges = Vec::new();
    for t in cutter.indices.chunks_exact(3) {
        for (i, j) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            let (Some(a), Some(b)) = (at(i), at(j)) else {
                continue;
            };
            let e = Vector3::new(
                b[0] as f64 - a[0] as f64,
                b[1] as f64 - a[1] as f64,
                b[2] as f64 - a[2] as f64,
            );
            let along = e.dot(&depth);
            let across2 = e.norm_squared() - along * along;
            let (ca, cb) = (cell(a), cell(b));
            if along.abs() >= 4.0 * SNAP_GRID && across2 <= 4.0 * SNAP_GRID * SNAP_GRID && ca != cb
            {
                edges.push((ca, cb));
            }
        }
    }
    edges
}

/// `cutter` with every vertex that is one grid step from a host vertex moved
/// onto it; the module docs give the rule. `depth` is the opening's unit
/// depth axis. Returned as it came when nothing qualifies, which is every
/// opening that shares no corner with its host. Where two host vertices snap
/// to one position, the first in the host's order supplies the coordinates;
/// the kernel's snap makes them the same vertex either way.
pub(in crate::router::voids) fn reconcile_with_host_vertices(
    mut cutter: Mesh,
    host: &Mesh,
    depth: Vector3<f64>,
) -> Mesh {
    reconcile_positions_with_host_vertices(&mut cutter, host, depth);
    cutter
}

/// Reconcile in place and report whether any stored coordinate changed. This
/// avoids cloning and comparing every position just to select the f64 prism
/// input on the overwhelmingly common unchanged path (#7024).
pub(in crate::router::voids) fn reconcile_positions_with_host_vertices(
    cutter: &mut Mesh,
    host: &Mesh,
    depth: Vector3<f64>,
) -> bool {
    // `abs() <= ..` is false for NaN, so a non-finite cutter bails too. So
    // does a non-finite axis: it would find no depth edge and so switch that
    // rule off while vertices still moved.
    if cutter.positions.is_empty()
        || !cutter.positions.iter().all(|v| v.abs() <= MAX_KEYED_COORD)
        || !depth.iter().all(|v| v.is_finite())
    {
        return false;
    }
    // Only host vertices within a step of the cutter's box can match. The
    // cheap f32 reject comes first (two steps wide, so f32 rounding of the
    // pad cannot lose a candidate); the exact test is the cell comparison.
    let (mut lo, mut hi) = ([i64::MAX; 3], [i64::MIN; 3]);
    let (mut flo, mut fhi) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
    for p in cutter.positions.chunks_exact(3) {
        let c = cell(p);
        for k in 0..3 {
            lo[k] = lo[k].min(c[k] - 1);
            hi[k] = hi[k].max(c[k] + 1);
            flo[k] = flo[k].min(p[k]);
            fhi[k] = fhi[k].max(p[k]);
        }
    }
    let pad = (2.0 * SNAP_GRID) as f32;
    let mut host_at: FxHashMap<Cell, [f32; 3]> = FxHashMap::default();
    for p in host.positions.chunks_exact(3) {
        // False for a NaN host coordinate, which is thereby skipped.
        if !(0..3).all(|k| p[k] >= flo[k] - pad && p[k] <= fhi[k] + pad) {
            continue;
        }
        let c = cell(p);
        if (0..3).all(|k| lo[k] <= c[k] && c[k] <= hi[k]) {
            host_at.entry(c).or_insert([p[0], p[1], p[2]]);
        }
    }
    if host_at.is_empty() {
        return false;
    }
    // Each distinct cutter position's host vertex: itself when it already is
    // one, else the nearest within a step, ties to the smallest position.
    let mut target: FxHashMap<Cell, Cell> = FxHashMap::default();
    for p in cutter.positions.chunks_exact(3) {
        let c = cell(p);
        if target.contains_key(&c) {
            continue;
        }
        if host_at.contains_key(&c) {
            target.insert(c, c);
            continue;
        }
        let mut best: Option<(i64, Cell)> = None;
        for d in 0..27 {
            let (dx, dy, dz) = (d % 3 - 1, d / 3 % 3 - 1, d / 9 - 1);
            let h = [c[0] + dx, c[1] + dy, c[2] + dz];
            if host_at.contains_key(&h) {
                let key = (dx * dx + dy * dy + dz * dz, h);
                if best.is_none_or(|b| key < b) {
                    best = Some(key);
                }
            }
        }
        if let Some((_, h)) = best {
            target.insert(c, h);
        }
    }
    let mut claims: FxHashMap<Cell, u32> = FxHashMap::default();
    target
        .values()
        .for_each(|h| *claims.entry(*h).or_default() += 1);
    // The moves still standing: cutter position -> the host position it takes.
    let mut moves: FxHashMap<Cell, Cell> = target
        .into_iter()
        .filter(|(c, h)| c != h && claims[h] == 1)
        .collect();
    if moves.is_empty() {
        return false;
    }
    // A cutter edge along `depth` moves as a whole or not at all: both ends
    // by the same offset. Dropping a move can strand its neighbour along the
    // next depth edge, hence the loop; it only ever removes moves.
    let edges = depth_edges(cutter, depth);
    loop {
        let offset = |c: &Cell| {
            moves
                .get(c)
                .map(|h| [h[0] - c[0], h[1] - c[1], h[2] - c[2]])
        };
        let stranded: Vec<Cell> = edges
            .iter()
            .filter(|(a, b)| offset(a) != offset(b))
            .flat_map(|(a, b)| [*a, *b])
            .filter(|c| moves.contains_key(c))
            .collect();
        if stranded.is_empty() {
            break;
        }
        stranded.iter().for_each(|c| {
            moves.remove(c);
        });
    }
    let mut changed = false;
    for p in cutter.positions.chunks_exact_mut(3) {
        if let Some(h) = moves.get(&cell(p)) {
            let target = &host_at[h];
            changed |= p != target;
            p.copy_from_slice(target);
        }
    }
    changed
}

#[cfg(test)]
#[path = "host_vertices_tests.rs"]
mod tests;
