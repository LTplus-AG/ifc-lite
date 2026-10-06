// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Element proposals. Coordinates are the IFC model frame (Z up, metres).
use serde::{Deserialize, Serialize};

/// The IFC class a proposal would create (EXPRESS names).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProposalClass {
    IfcWall,
    IfcSlab,
    IfcColumn,
    IfcPipeSegment,
    IfcFlowSegment,
}

/// How the proposal was derived from its sources.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProposalBasis {
    /// Two opposite parallel wall faces: thickness measured.
    PairedFaces,
    /// One wall face: `defaultWallThicknessMetres`, behind the scanned side.
    SingleFace,
    /// A ceiling and the floor above it: thickness measured.
    FloorCeilingPair,
    /// A floor seen from above: `defaultSlabThicknessMetres` below it.
    Floor,
    /// A ceiling seen from below: `defaultSlabThicknessMetres` above it.
    Ceiling,
    /// One fitted cylinder.
    Cylinder,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DetectionKind {
    Plane,
    Cylinder,
}

/// A detection the proposal came from: an index into the segmentation
/// report's `planes` or `cylinders`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionRef {
    pub kind: DetectionKind,
    pub index: u32,
}

/// Fit statistics over all sources, in the model frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalFit {
    /// Inlier-weighted RMS of the sources' residuals.
    pub rms_metres: f64,
    pub inlier_points: u64,
    pub inlier_voxels: u64,
    /// Measured surface area of the sources (planes) or lateral area covered
    /// (cylinders: arc times radius times length).
    pub area_square_metres: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProposalGeometry {
    /// Axis line on the wall's centre plane at its base elevation.
    #[serde(rename_all = "camelCase")]
    Wall { start: [f64; 3], end: [f64; 3], thickness_metres: f64, height_metres: f64 },
    /// Top face outline, counter-clockwise seen from above, at the top
    /// elevation; the slab extends `thicknessMetres` below it.
    #[serde(rename_all = "camelCase")]
    Slab { outline: Vec<[f64; 3]>, thickness_metres: f64 },
    /// Circular column: axis base point, height up, radius.
    #[serde(rename_all = "camelCase")]
    Column { base: [f64; 3], height_metres: f64, radius_metres: f64 },
    /// Circular pipe between two axis points.
    #[serde(rename_all = "camelCase")]
    Pipe { start: [f64; 3], end: [f64; 3], radius_metres: f64 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanElementProposal {
    /// Stable within one report: `wall-0`, `slab-2`, `column-1`, `pipe-0`.
    pub id: String,
    pub ifc_class: ProposalClass,
    /// 0..1; see the module docs for the formula.
    pub confidence: f64,
    pub basis: ProposalBasis,
    pub sources: Vec<DetectionRef>,
    pub fit: ProposalFit,
    pub geometry: ProposalGeometry,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProposalStats {
    pub vertical_planes: u32,
    pub horizontal_planes: u32,
    /// Neither vertical nor horizontal in the model frame: no proposal.
    pub sloped_planes: u32,
    pub paired_walls: u32,
    pub single_face_walls: u32,
    /// Vertical planes below `minWallLengthMetres` or `minWallHeightMetres`.
    pub faces_too_small: u32,
    pub paired_slabs: u32,
    pub single_slabs: u32,
    /// Horizontal planes below `minSlabAreaSquareMetres`.
    pub slabs_too_small: u32,
    pub columns: u32,
    pub pipes: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProposalReport {
    pub algorithm: String,
    /// Walls, then slabs, columns and pipes; each class by descending support.
    pub proposals: Vec<ScanElementProposal>,
    /// Uniform scale of `scanToModel` (1 for a rigid alignment).
    pub transform_scale: f64,
    pub stats: ScanProposalStats,
}
