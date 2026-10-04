// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Count grid: robust extent, cell-size choice under a cell budget, per-cell
//! point counts thresholded to an occupancy mask, and a cell → points index
//! for the snapping stage.

use super::{ScanOutlineDiagnostics, ScanOutlineOptions};

/// The robust extent grows outward from the median until consecutive
/// coordinates (of a bounded subsample) are further apart than this, so far
/// outliers cannot stretch the grid while separate wings of a building, which
/// are continuous in projection, stay in.
const EXTENT_BREAK_METRES: f64 = 10.0;
/// Coordinates sorted per axis to find the extent.
const EXTENT_SAMPLE: usize = 1 << 16;
/// Adaptive cell growth per step, and the step bound.
const CELL_GROWTH: f64 = 1.25;
const MAX_CELL_STEPS: usize = 16;

/// Placement of the padded cell grid in plane coordinates. Cell `(i, j)`
/// covers `[x0 + i*cell, x0 + (i+1)*cell] × [y0 + j*cell, y0 + (j+1)*cell]`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct GridGeometry {
    pub x0: f64,
    pub y0: f64,
    pub cell: f64,
    pub width: usize,
    pub height: usize,
    /// Empty cells kept on every side so morphology never reaches the edge.
    pub pad: usize,
    /// Robust extent; points outside it are not binned.
    pub min: [f64; 2],
    pub max: [f64; 2],
}

impl GridGeometry {
    /// Cell index of a point inside the robust extent.
    #[inline]
    pub fn cell_of(&self, x: f64, y: f64) -> Option<usize> {
        if !(x >= self.min[0] && x <= self.max[0] && y >= self.min[1] && y <= self.max[1]) {
            return None;
        }
        let i = ((x - self.x0) / self.cell).floor() as isize;
        let j = ((y - self.y0) / self.cell).floor() as isize;
        let (lo, hi_i, hi_j) = (self.pad as isize, (self.width - self.pad) as isize - 1, (self.height - self.pad) as isize - 1);
        let i = i.clamp(lo, hi_i) as usize;
        let j = j.clamp(lo, hi_j) as usize;
        Some(j * self.width + i)
    }
}

pub(super) struct Binned {
    pub geometry: GridGeometry,
    /// `1` for an occupied cell.
    pub occupied: Vec<u8>,
}

/// Radius (cells) of the closing disk that bridges `max_gap`.
pub(super) fn close_radius_cells(max_gap: f64, cell: f64) -> usize {
    if max_gap <= 0.0 {
        return 0;
    }
    (max_gap / (2.0 * cell)).ceil() as usize
}

/// Bin the points and threshold them. `None` when no finite point exists.
pub(super) fn bin_points(
    xy: &[f32],
    opts: &ScanOutlineOptions,
    max_gap: f64,
    diag: &mut ScanOutlineDiagnostics,
) -> Option<Binned> {
    let (min, max) = robust_extent(xy, diag)?;
    let span = [(max[0] - min[0]).max(0.0), (max[1] - min[1]).max(0.0)];

    let mut cell = opts.cell_size.unwrap_or(opts.min_cell_size);
    let mut counts: Vec<u32> = Vec::new();
    let mut geometry = None;
    for step in 0..MAX_CELL_STEPS {
        let (geo, capped) = fit_geometry(min, max, span, cell, max_gap, opts);
        if capped {
            diag.cell_cap_hit = true;
        }
        cell = geo.cell;
        count_cells(xy, &geo, &mut counts);
        geometry = Some(geo);
        let last_step = step + 1 == MAX_CELL_STEPS;
        if opts.cell_size.is_some() || capped || last_step || cell >= opts.max_cell_size {
            break;
        }
        if median_occupied(&counts) >= opts.target_points_per_cell {
            break;
        }
        cell = (cell * CELL_GROWTH).min(opts.max_cell_size);
    }
    let geometry = geometry?;
    diag.used_points = counts.iter().map(|&c| c as usize).sum();
    diag.cell_size = geometry.cell;
    diag.grid_width = geometry.width;
    diag.grid_height = geometry.height;

    let median = median_occupied(&counts);
    let relative = (opts.noise_fraction * median).ceil();
    let threshold = (opts.min_points_per_cell.max(1) as f64).max(relative) as u32;
    diag.count_threshold = threshold;
    let occupied: Vec<u8> = counts.iter().map(|&c| u8::from(c >= threshold)).collect();
    diag.occupied_cells = occupied.iter().filter(|&&o| o != 0).count();
    Some(Binned { geometry, occupied })
}

/// Lay the padded grid over the extent, growing the cell when the budget
/// would be exceeded. Returns whether the budget forced the growth.
fn fit_geometry(
    min: [f64; 2],
    max: [f64; 2],
    span: [f64; 2],
    mut cell: f64,
    max_gap: f64,
    opts: &ScanOutlineOptions,
) -> (GridGeometry, bool) {
    let mut capped = false;
    // Bounded: each pass multiplies the cell by at least the overshoot ratio.
    for _ in 0..64 {
        let pad = close_radius_cells(max_gap, cell) + opts.open_radius_cells as usize + 2;
        let width = (span[0] / cell).floor() as usize + 1 + 2 * pad;
        let height = (span[1] / cell).floor() as usize + 1 + 2 * pad;
        let cells = width.saturating_mul(height);
        if cells <= opts.max_cells {
            let geo = GridGeometry {
                x0: min[0] - pad as f64 * cell,
                y0: min[1] - pad as f64 * cell,
                cell,
                width,
                height,
                pad,
                min,
                max,
            };
            return (geo, capped);
        }
        capped = true;
        cell *= ((cells as f64 / opts.max_cells as f64).sqrt() * 1.02).max(1.02);
    }
    // Unreachable for finite extents: 64 growths of >= 2 % exceed any span.
    let cell = (span[0].max(span[1]) + 1.0).max(cell);
    let geo = GridGeometry { x0: min[0] - cell, y0: min[1] - cell, cell, width: 4, height: 4, pad: 1, min, max };
    (geo, true)
}

fn count_cells(xy: &[f32], geo: &GridGeometry, counts: &mut Vec<u32>) {
    counts.clear();
    counts.resize(geo.width * geo.height, 0);
    for p in xy.chunks_exact(2) {
        if let Some(c) = geo.cell_of(p[0] as f64, p[1] as f64) {
            counts[c] = counts[c].saturating_add(1);
        }
    }
}

fn median_occupied(counts: &[u32]) -> f64 {
    let mut occ: Vec<u32> = counts.iter().copied().filter(|&c| c > 0).collect();
    if occ.is_empty() {
        return 0.0;
    }
    let mid = occ.len() / 2;
    let (_, m, _) = occ.select_nth_unstable(mid);
    *m as f64
}

/// Robust extent of the finite points: per axis, the run of sorted
/// (subsampled) coordinates around the median with no gap wider than
/// `EXTENT_BREAK_METRES`. Counts non-finite and out-of-extent points.
fn robust_extent(xy: &[f32], diag: &mut ScanOutlineDiagnostics) -> Option<([f64; 2], [f64; 2])> {
    let finite = xy.chunks_exact(2).filter(|p| p[0].is_finite() && p[1].is_finite()).count();
    diag.non_finite_points = xy.len() / 2 - finite;
    if finite == 0 {
        return None;
    }
    let stride = finite.div_ceil(EXTENT_SAMPLE);
    let mut xs: Vec<f64> = Vec::with_capacity(finite / stride + 1);
    let mut ys: Vec<f64> = Vec::with_capacity(finite / stride + 1);
    for p in xy.chunks_exact(2).filter(|p| p[0].is_finite() && p[1].is_finite()).step_by(stride) {
        xs.push(p[0] as f64);
        ys.push(p[1] as f64);
    }
    let (lx, hx) = gap_bounded_run(&mut xs);
    let (ly, hy) = gap_bounded_run(&mut ys);
    // Shrink the box to the points actually inside it, so the grid hugs them.
    let (mut tmin, mut tmax) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
    let mut outliers = 0usize;
    for p in xy.chunks_exact(2) {
        let (x, y) = (p[0] as f64, p[1] as f64);
        if !(x.is_finite() && y.is_finite()) {
            continue;
        }
        if x < lx - EXTENT_BREAK_METRES || x > hx + EXTENT_BREAK_METRES || y < ly - EXTENT_BREAK_METRES || y > hy + EXTENT_BREAK_METRES {
            outliers += 1;
            continue;
        }
        tmin = [tmin[0].min(x), tmin[1].min(y)];
        tmax = [tmax[0].max(x), tmax[1].max(y)];
    }
    diag.outlier_points = outliers;
    (tmin[0] <= tmax[0]).then_some((tmin, tmax))
}

/// The span of sorted `v` around its median with no gap above the break.
fn gap_bounded_run(v: &mut [f64]) -> (f64, f64) {
    v.sort_unstable_by(f64::total_cmp);
    let mid = v.len() / 2;
    let mut lo = mid;
    while lo > 0 && v[lo] - v[lo - 1] <= EXTENT_BREAK_METRES {
        lo -= 1;
    }
    let mut hi = mid;
    while hi + 1 < v.len() && v[hi + 1] - v[hi] <= EXTENT_BREAK_METRES {
        hi += 1;
    }
    (v[lo], v[hi])
}

/// Points bucketed by grid cell (CSR layout) for the snapping stage.
pub(super) struct PointIndex {
    pub geometry: GridGeometry,
    starts: Vec<u32>,
    ids: Vec<u32>,
}

impl PointIndex {
    pub fn build(xy: &[f32], geo: &GridGeometry) -> Self {
        let cells = geo.width * geo.height;
        let mut starts = vec![0u32; cells + 1];
        for p in xy.chunks_exact(2) {
            if let Some(c) = geo.cell_of(p[0] as f64, p[1] as f64) {
                starts[c + 1] += 1;
            }
        }
        for c in 0..cells {
            starts[c + 1] += starts[c];
        }
        let mut fill = starts.clone();
        let mut ids = vec![0u32; starts[cells] as usize];
        for (k, p) in xy.chunks_exact(2).enumerate() {
            if let Some(c) = geo.cell_of(p[0] as f64, p[1] as f64) {
                ids[fill[c] as usize] = k as u32;
                fill[c] += 1;
            }
        }
        Self { geometry: *geo, starts, ids }
    }

    /// Ids of the points binned in cell `(i, j)`; empty outside the grid.
    pub fn cell_points(&self, i: isize, j: isize) -> &[u32] {
        let g = &self.geometry;
        if i < 0 || j < 0 || i as usize >= g.width || j as usize >= g.height {
            return &[];
        }
        let c = j as usize * g.width + i as usize;
        &self.ids[self.starts[c] as usize..self.starts[c + 1] as usize]
    }
}
