// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Vector outlines traced from a slab of scan points (#6871).
//!
//! The scan section layer selects the points within a band around a section
//! plane and projects them into the plane. This module turns those 2D points
//! into closed rings: the boundary of what the scan says is solid (walls,
//! columns, furniture) at the cut, ready for a drawing or a DXF layer.
//!
//! Pipeline, every stage bounded:
//! 1. **Count grid** (`grid`): bin the points into square cells (adaptive size
//!    from the point density unless fixed, a total cell cap that is reported
//!    when it forces coarser cells) and keep the cells whose count clears a
//!    noise threshold relative to the median occupied-cell count.
//! 2. **Morphology** (`morph`): a binary close with a disk sized to bridge gaps
//!    up to `max_gap` (two faces of one wall merge into a solid band, a scan
//!    shadow in a wall closes), then an opening by reconstruction that drops
//!    speckle without rounding the corners of what survives. Diagonal-only
//!    contacts are filled so the cell boundary is a set of disjoint simple
//!    loops; small components are dropped and small holes filled.
//! 3. **Contours** (`trace`): walk the cell edges between solid and empty
//!    cells. Outer boundaries come out counter-clockwise, holes clockwise, and
//!    every ring knows its container (`parents`).
//! 4. **Simplification** (`simplify`): Douglas-Peucker per ring, then any edge
//!    that touches or crosses another edge gets its farthest dropped vertex
//!    back until nothing does (`topology`).
//! 5. **Snapping** (`snap`): each simplified edge is refitted to the scan
//!    points along it (total least squares), and vertices move to where
//!    consecutive fitted lines meet.
//! 6. **Squaring** (`square`): edges within a tolerance of the dominant
//!    building direction (or its perpendicular) are rotated onto it.
//!
//! Steps 5 and 6 move vertices; any move that would make a ring touch or cross
//! itself or another ring, or change which ring contains it, is undone
//! (`topology::repair_moves`). The output therefore holds the same invariants
//! as the cell-edge trace it started from: closed, simple, pairwise disjoint,
//! correctly oriented and nested rings.

mod fit;
mod grid;
mod morph;
mod options;
mod simplify;
mod snap;
mod square;
mod support;
mod topology;
mod trace;

#[cfg(test)]
#[path = "synth_tests.rs"]
mod synth_tests;
#[cfg(test)]
#[path = "scan_outline_tests.rs"]
mod tests;

use crate::geom2d::polygon_area;
pub use options::{ScanOutlineDiagnostics, ScanOutlineOptions, MAX_CELLS_LIMIT};

/// Hard upper bound on [`ScanOutlineOptions::max_gap`]: a closing radius that
/// bridges more than half a metre starts to fuse rooms and erase corridors.
pub const MAX_GAP_LIMIT: f64 = 0.5;

/// Traced outline in plane coordinates.
///
/// Rings carry no duplicated closing vertex. Outer boundaries wind
/// counter-clockwise, holes clockwise, so NonZero and EvenOdd fill agree.
/// Rings are grouped like `ContourSet`: `shape_offsets[s]` is shape `s`'s outer
/// ring and the rings up to the next offset are its holes.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ScanOutline {
    pub rings: Vec<Vec<[f64; 2]>>,
    pub shape_offsets: Vec<usize>,
    /// The ring directly containing each ring: a hole's outer boundary, or for
    /// an outer boundary the hole it sits in (an island). `None` at top level.
    pub parents: Vec<Option<usize>>,
    pub diagnostics: ScanOutlineDiagnostics,
}

/// A plane in 3D: `world = origin + u * u_axis + v * v_axis`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlaneFrame {
    pub origin: [f64; 3],
    pub u_axis: [f64; 3],
    pub v_axis: [f64; 3],
}

impl PlaneFrame {
    pub fn to_world(&self, p: [f64; 2]) -> [f64; 3] {
        let (o, u, v) = (self.origin, self.u_axis, self.v_axis);
        [
            o[0] + p[0] * u[0] + p[1] * v[0],
            o[1] + p[0] * u[1] + p[1] * v[1],
            o[2] + p[0] * u[2] + p[1] * v[2],
        ]
    }
}

impl ScanOutline {
    /// Every ring mapped into 3D through `frame`.
    pub fn world_rings(&self, frame: &PlaneFrame) -> Vec<Vec<[f64; 3]>> {
        self.rings
            .iter()
            .map(|ring| ring.iter().map(|p| frame.to_world(*p)).collect())
            .collect()
    }
}

/// Trace outlines from plane points given as flat `[u0, v0, u1, v1, …]`.
///
/// An odd trailing coordinate is ignored. Non-finite points are skipped and
/// counted. Errors only on invalid options.
pub fn trace_scan_outline(xy: &[f32], opts: &ScanOutlineOptions) -> Result<ScanOutline, String> {
    opts.validate()?;
    let mut diag = ScanOutlineDiagnostics {
        input_points: xy.len() / 2,
        ..Default::default()
    };
    let max_gap = if opts.max_gap > MAX_GAP_LIMIT {
        diag.max_gap_clamped = true;
        MAX_GAP_LIMIT
    } else {
        opts.max_gap
    };

    let Some(binned) = grid::bin_points(xy, opts, max_gap, &mut diag) else {
        return Ok(ScanOutline { diagnostics: diag, ..Default::default() });
    };
    let geo = binned.geometry;
    let close_radius = grid::close_radius_cells(max_gap, geo.cell);
    let mut mask = binned.occupied;
    morph::close(&mut mask, geo.width, geo.height, close_radius);
    morph::open_by_reconstruction(&mut mask, geo.width, geo.height, opts.open_radius_cells);
    morph::fill_saddles(&mut mask, geo.width, geo.height);
    let cell_area = geo.cell * geo.cell;
    let labels = morph::filter_components(
        &mut mask,
        geo.width,
        geo.height,
        area_cells(opts.min_component_area, cell_area),
        area_cells(opts.min_hole_area, cell_area),
    );
    diag.components_dropped = labels.dropped;
    diag.holes_filled = labels.filled;
    diag.solid_cells = mask.iter().filter(|&&m| m != 0).count();

    let traced = trace::trace_rings(&mask, &labels, &geo);
    let lattice = traced.rings;
    let parents = traced.parents;

    let eps = opts.simplify_tolerance_cells * geo.cell;
    let (mut rings, reinsertions) = simplify::simplify_rings(&lattice, &parents, eps);
    diag.simplify_reinsertions = reinsertions;

    let max_move = opts.max_vertex_move_cells * geo.cell;
    // Moved edges must stay near the traced boundary; a rebuilt corner sits
    // up to about half the closing radius off the rounded lattice corner.
    let support_cells = opts.max_vertex_move_cells.max(0.5 * close_radius as f64) + 1.0;
    let support = support::Support::new(&mask, &geo, support_cells);
    if opts.snap {
        let index = grid::PointIndex::build(xy, &geo);
        let ctx = snap::SnapContext { index: &index, xy, cell: geo.cell, close_radius_cells: close_radius, opts };
        let snapped = snap::snap_rings(&rings, &ctx);
        diag.snapped_edges = snapped.fitted_edges;
        // Merging and corner rebuilding change the vertex count: first make
        // the rebuilt topology valid ring by ring, then repair the moves
        // vertex by vertex against it.
        let mut references = snapped.references;
        let mut moved = snapped.rings;
        diag.reverted_moves += topology::restore_invalid_rings(&mut references, &mut moved, &rings, &parents, Some(&support));
        diag.reverted_moves += topology::repair_moves(&mut moved, &references, &parents, Some(&support));
        rings = moved;
    }
    if opts.square {
        let before = rings.clone();
        let squared = square::square_rings(&rings, geo.cell, opts);
        diag.dominant_angle_deg = squared.dominant_angle_deg;
        diag.squared_edges = squared.squared_edges;
        let mut moved = squared.rings;
        cap_moves(&mut moved, &before, max_move);
        diag.reverted_moves += topology::repair_moves(&mut moved, &before, &parents, Some(&support));
        rings = moved;
    }
    topology::drop_collinear_vertices(&mut rings, &parents);

    let (rings, shape_offsets, parents) = group_shapes(rings, &parents);
    diag.ring_count = rings.len();
    diag.outer_ring_count = shape_offsets.len();
    diag.hole_ring_count = rings.len() - shape_offsets.len();
    diag.vertex_count = rings.iter().map(Vec::len).sum();
    Ok(ScanOutline { rings, shape_offsets, parents, diagnostics: diag })
}

fn area_cells(area: f64, cell_area: f64) -> usize {
    (area / cell_area).ceil() as usize
}

/// Undo any single vertex move longer than `max_move`. Rings whose vertex
/// count changed (snapping merged edges) bound their own moves.
fn cap_moves(moved: &mut [Vec<[f64; 2]>], before: &[Vec<[f64; 2]>], max_move: f64) {
    for (ring, old) in moved.iter_mut().zip(before) {
        if ring.len() != old.len() {
            continue;
        }
        for (p, q) in ring.iter_mut().zip(old) {
            let d = ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2)).sqrt();
            if !d.is_finite() || d > max_move {
                *p = *q;
            }
        }
    }
}

/// Order rings shape by shape (outer, then its holes) and remap `parents`.
fn group_shapes(
    rings: Vec<Vec<[f64; 2]>>,
    parents: &[Option<usize>],
) -> (Vec<Vec<[f64; 2]>>, Vec<usize>, Vec<Option<usize>>) {
    let is_outer: Vec<bool> = rings.iter().map(|r| polygon_area(r) > 0.0).collect();
    let mut order = Vec::with_capacity(rings.len());
    let mut offsets = Vec::new();
    let mut holes_of: Vec<Vec<usize>> = vec![Vec::new(); rings.len()];
    for (i, p) in parents.iter().enumerate() {
        if !is_outer[i] {
            if let Some(p) = p {
                holes_of[*p].push(i);
            }
        }
    }
    for i in 0..rings.len() {
        if is_outer[i] {
            offsets.push(order.len());
            order.push(i);
            order.extend_from_slice(&holes_of[i]);
        }
    }
    let mut new_index = vec![usize::MAX; rings.len()];
    for (new, old) in order.iter().enumerate() {
        new_index[*old] = new;
    }
    let new_parents = order.iter().map(|old| parents[*old].map(|p| new_index[p])).collect();
    let mut slots: Vec<Option<Vec<[f64; 2]>>> = rings.into_iter().map(Some).collect();
    let new_rings = order.iter().map(|old| slots[*old].take().unwrap_or_default()).collect();
    (new_rings, offsets, new_parents)
}
