// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Options (one struct, every tunable, with defaults) and diagnostics of the
//! scan outline tracer.

use serde::{Deserialize, Serialize};

/// Largest cell budget accepted: about 64 M cells, a few hundred MB of
/// working grids, which is what a 32-bit wasm heap can still afford.
pub const MAX_CELLS_LIMIT: usize = 1 << 26;

/// Every tunable of the tracer, with defaults sized for building scans in
/// metres. Deserialises from camelCase with every field optional (absent
/// means the default) and unknown fields refused, which is the shape the wasm
/// binding accepts.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ScanOutlineOptions {
    /// Fixed cell edge length (metres). `None` picks it from the point density
    /// between `min_cell_size` and `max_cell_size`.
    pub cell_size: Option<f64>,
    /// Finest cell the adaptive choice starts from.
    pub min_cell_size: f64,
    /// Coarsest cell the adaptive choice grows to.
    pub max_cell_size: f64,
    /// The adaptive choice grows the cell until the median occupied cell holds
    /// at least this many points.
    pub target_points_per_cell: f64,
    /// Total cell budget for the padded grid. When the extent needs more, the
    /// cell grows to fit and [`ScanOutlineDiagnostics::cell_cap_hit`] is set.
    pub max_cells: usize,
    /// A cell needs at least this many points to count as occupied.
    pub min_points_per_cell: u32,
    /// Noise threshold relative to density: a cell is occupied when its count
    /// reaches `noise_fraction` × the median occupied-cell count (and
    /// `min_points_per_cell`).
    pub noise_fraction: f64,
    /// Widest gap (metres) the closing bridges, about one wall thickness.
    /// Clamped to [`MAX_GAP_LIMIT`](super::MAX_GAP_LIMIT).
    pub max_gap: f64,
    /// Radius (cells) of the speckle-removing opening. A connected blob that
    /// cannot hold a disk of this radius anywhere is dropped; anything that can
    /// is kept whole. `0` disables it.
    pub open_radius_cells: u32,
    /// Solid components smaller than this (m²) are dropped.
    pub min_component_area: f64,
    /// Enclosed empty regions smaller than this (m²) are filled.
    pub min_hole_area: f64,
    /// Douglas-Peucker tolerance in cells.
    pub simplify_tolerance_cells: f64,
    /// Refit simplified edges to the point evidence.
    pub snap: bool,
    /// How far (cells) beside an edge points count as its evidence.
    pub snap_distance_cells: f64,
    /// Fewest points an edge needs before it is refitted.
    pub min_snap_points: usize,
    /// A snapped or squared vertex may move at most this far (cells).
    pub max_vertex_move_cells: f64,
    /// Square edges against the dominant building direction.
    pub square: bool,
    /// Edges within this angle (degrees) of the dominant direction, or its
    /// perpendicular, are squared.
    pub square_angle_tolerance_deg: f64,
    /// An edge whose ends would move at most this far (metres) when squared is
    /// squared too, up to four times the angle tolerance.
    pub square_offset_tolerance: f64,
}

impl Default for ScanOutlineOptions {
    fn default() -> Self {
        Self {
            cell_size: None,
            min_cell_size: 0.02,
            max_cell_size: 0.05,
            target_points_per_cell: 6.0,
            max_cells: 16 * 1024 * 1024,
            min_points_per_cell: 1,
            noise_fraction: 0.25,
            max_gap: 0.3,
            open_radius_cells: 1,
            min_component_area: 0.02,
            min_hole_area: 0.5,
            simplify_tolerance_cells: 1.5,
            snap: true,
            snap_distance_cells: 3.0,
            min_snap_points: 8,
            max_vertex_move_cells: 4.0,
            square: true,
            square_angle_tolerance_deg: 3.0,
            square_offset_tolerance: 0.03,
        }
    }
}

impl ScanOutlineOptions {
    /// Reject options no run could honour (non-finite, non-positive sizes,
    /// inverted ranges). `max_gap` above [`MAX_GAP_LIMIT`](super::MAX_GAP_LIMIT) is not an error; it
    /// is clamped and reported.
    pub fn validate(&self) -> Result<(), String> {
        let positive = |name: &str, v: f64| -> Result<(), String> {
            if v.is_finite() && v > 0.0 {
                Ok(())
            } else {
                Err(format!("{name} must be a finite number > 0, got {v}"))
            }
        };
        let non_negative = |name: &str, v: f64| -> Result<(), String> {
            if v.is_finite() && v >= 0.0 {
                Ok(())
            } else {
                Err(format!("{name} must be a finite number >= 0, got {v}"))
            }
        };
        if let Some(c) = self.cell_size {
            positive("cellSize", c)?;
        }
        positive("minCellSize", self.min_cell_size)?;
        positive("maxCellSize", self.max_cell_size)?;
        if self.max_cell_size < self.min_cell_size {
            return Err(format!(
                "maxCellSize ({}) must be >= minCellSize ({})",
                self.max_cell_size, self.min_cell_size
            ));
        }
        positive("targetPointsPerCell", self.target_points_per_cell)?;
        if !(64..=MAX_CELLS_LIMIT).contains(&self.max_cells) {
            return Err(format!("maxCells must be in 64..={MAX_CELLS_LIMIT}, got {}", self.max_cells));
        }
        non_negative("noiseFraction", self.noise_fraction)?;
        non_negative("maxGap", self.max_gap)?;
        non_negative("minComponentArea", self.min_component_area)?;
        non_negative("minHoleArea", self.min_hole_area)?;
        non_negative("simplifyToleranceCells", self.simplify_tolerance_cells)?;
        positive("snapDistanceCells", self.snap_distance_cells)?;
        non_negative("maxVertexMoveCells", self.max_vertex_move_cells)?;
        non_negative("squareAngleToleranceDeg", self.square_angle_tolerance_deg)?;
        if self.square_angle_tolerance_deg >= 45.0 {
            return Err(format!(
                "squareAngleToleranceDeg must be < 45, got {}",
                self.square_angle_tolerance_deg
            ));
        }
        non_negative("squareOffsetTolerance", self.square_offset_tolerance)?;
        if self.open_radius_cells > 64 {
            return Err(format!("openRadiusCells must be <= 64, got {}", self.open_radius_cells));
        }
        Ok(())
    }
}

/// What the run did, for the UI and for judging a result. Serialises to
/// camelCase for the wasm binding.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanOutlineDiagnostics {
    /// Points passed in (pairs of coordinates).
    pub input_points: usize,
    /// Points binned: finite and inside the robust extent.
    pub used_points: usize,
    /// Non-finite points skipped.
    pub non_finite_points: usize,
    /// Finite points outside the robust extent (far outliers) skipped.
    pub outlier_points: usize,
    /// Cell edge length used (metres).
    pub cell_size: f64,
    /// Grid size in cells, padding included.
    pub grid_width: usize,
    pub grid_height: usize,
    /// The cell budget forced a coarser cell than asked for.
    pub cell_cap_hit: bool,
    /// `max_gap` was above [`MAX_GAP_LIMIT`](super::MAX_GAP_LIMIT) and was clamped.
    pub max_gap_clamped: bool,
    /// Points a cell needed to count as occupied.
    pub count_threshold: u32,
    /// Cells occupied after thresholding, before morphology.
    pub occupied_cells: usize,
    /// Cells solid after morphology and filtering.
    pub solid_cells: usize,
    /// Solid components dropped as too small.
    pub components_dropped: usize,
    /// Enclosed holes filled as too small.
    pub holes_filled: usize,
    pub ring_count: usize,
    pub outer_ring_count: usize,
    pub hole_ring_count: usize,
    pub vertex_count: usize,
    /// Vertices put back by the simplifier to keep rings disjoint.
    pub simplify_reinsertions: usize,
    /// Edges refitted to the point evidence.
    pub snapped_edges: usize,
    /// Dominant building direction, degrees in `[0, 90)`, when one was found.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dominant_angle_deg: Option<f64>,
    /// Edges rotated onto the dominant direction or its perpendicular.
    pub squared_edges: usize,
    /// Vertex moves (snap or square) undone because they broke a ring.
    pub reverted_moves: usize,
}
