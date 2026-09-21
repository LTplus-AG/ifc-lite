/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Durable LandXML alignment, profile, cross-section, and roadway records.
//!
//! These source records deliberately retain authored stations and offsets.
//! They do not imply a sampled mesh, a corridor solid, or a generated road.

use serde::{Deserialize, Serialize};
use std::fmt;

use crate::LandXmlSourceId;

/// A horizontal alignment that owns profiles and cross-sections by source id.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlAlignment {
    pub source_id: LandXmlSourceId,
    pub ordinal: usize,
    pub name: String,
    pub length: f64,
    /// Exact LandXML `staStart`, named to match the alignment source model.
    pub sta_start: f64,
    pub profile_source_ids: Vec<LandXmlSourceId>,
    pub cross_section_source_ids: Vec<LandXmlSourceId>,
}

/// LandXML distinguishes proposed vertical geometry from sampled surface data.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LandXmlProfileKind {
    Design,
    Sampled,
}

/// A `ProfAlign` or `ProfSurf` record under an alignment.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlProfile {
    pub source_id: LandXmlSourceId,
    pub parent_alignment_source_id: LandXmlSourceId,
    pub ordinal: usize,
    pub name: String,
    pub kind: LandXmlProfileKind,
    pub pvis: Vec<LandXmlProfilePoint>,
    pub vertical_curves: Vec<LandXmlVerticalCurve>,
    /// A `ProfSurf` may contain multiple `PntList2D` segments; each stays
    /// separate so a source discontinuity is never interpolated away.
    pub grade_lines: Vec<LandXmlGradeLine>,
}

/// One station/elevation pair authored by `PVI` or a sampled grade line.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlProfilePoint {
    pub source_id: LandXmlSourceId,
    pub station: f64,
    /// Missing source elevations are preserved as an explicit capability gap.
    pub elevation: Option<f64>,
}

/// A continuous `PntList2D` segment of a sampled profile.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlGradeLine {
    pub source_id: LandXmlSourceId,
    pub parent_profile_source_id: LandXmlSourceId,
    pub ordinal: usize,
    pub points: Vec<LandXmlProfilePoint>,
}

/// The exact LandXML vertical-curve declaration.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LandXmlVerticalCurveKind {
    Parabolic,
    UnsymmetricalParabolic,
    Circular,
}

/// Why a design profile cannot be evaluated at a requested station.
///
/// The source records are deliberately preserved even when an evaluator cannot
/// prove the required tangent data.  In particular, this is preferable to
/// drawing a plausible-looking grade from a lone PVI.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LandXmlProfileEvaluationError {
    MissingTangentPvi,
    InvalidCurveDeclaration,
    InconsistentCircularCurve,
    NonFiniteEvaluation,
}

impl fmt::Display for LandXmlProfileEvaluationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::MissingTangentPvi => "vertical curve requires finite PVIs on both tangents",
            Self::InvalidCurveDeclaration => "vertical curve has an invalid length or radius",
            Self::InconsistentCircularCurve => {
                "circular curve radius, length, and tangent grades disagree"
            }
            Self::NonFiniteEvaluation => "vertical alignment produces a non-finite elevation",
        })
    }
}

impl std::error::Error for LandXmlProfileEvaluationError {}

/// A vertical curve anchored at its authored point of vertical intersection.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlVerticalCurve {
    pub source_id: LandXmlSourceId,
    pub parent_profile_source_id: LandXmlSourceId,
    pub kind: LandXmlVerticalCurveKind,
    pub station: f64,
    pub elevation: Option<f64>,
    pub length: Option<f64>,
    pub length_in: Option<f64>,
    pub length_out: Option<f64>,
    pub radius: Option<f64>,
}

/// A sampled cross-section at one station on its parent alignment.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlCrossSection {
    pub source_id: LandXmlSourceId,
    pub parent_alignment_source_id: LandXmlSourceId,
    pub ordinal: usize,
    pub station: f64,
    pub surface_source_ids: Vec<LandXmlSourceId>,
}

/// Whether cross-section values are existing/sampled or planned/design values.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LandXmlCrossSectionSurfaceKind {
    Sampled,
    Design,
}

/// One source cross-section surface, never a generated corridor surface.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlCrossSectionSurface {
    pub source_id: LandXmlSourceId,
    pub parent_cross_section_source_id: LandXmlSourceId,
    pub kind: LandXmlCrossSectionSurfaceKind,
    pub name: Option<String>,
    pub segments: Vec<LandXmlCrossSectionSegment>,
    pub points: Vec<LandXmlCrossSectionPoint>,
}

/// A continuous sampled `CrossSectSurf/PntList2D` sequence.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlCrossSectionSegment {
    pub source_id: LandXmlSourceId,
    pub parent_surface_source_id: LandXmlSourceId,
    pub ordinal: usize,
    pub points: Vec<LandXmlCrossSectionPoint>,
}

/// The coordinate convention authored by a `CrossSectPnt`.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LandXmlCrossSectionPointDataFormat {
    OffsetElevation,
    SlopeDistance,
}

/// A cross-section point as authored, including its optional source references.
///
/// LandXML `PointType` permits a `pntRef` with no coordinates.  When both are
/// present, the coordinates are authoritative (per the schema documentation)
/// and the reference is retained as provenance rather than substituted.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlCrossSectionPoint {
    pub source_id: LandXmlSourceId,
    pub data_format: LandXmlCrossSectionPointDataFormat,
    pub offset: Option<f64>,
    /// Missing source elevations stay observable instead of becoming zero.
    pub elevation: Option<f64>,
    pub slope: Option<f64>,
    pub distance: Option<f64>,
    pub pnt_ref: Option<String>,
    pub alignment_ref: Option<String>,
    pub align_ref_station: Option<f64>,
    pub alignment_source_id: Option<LandXmlSourceId>,
    pub plan_feature_ref: Option<String>,
    pub plan_feature_ref_station: Option<f64>,
    pub parcel_ref: Option<String>,
    pub parcel_ref_station: Option<f64>,
}

/// A roadway's named source associations; it does not claim corridor geometry.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlRoadway {
    pub source_id: LandXmlSourceId,
    pub ordinal: usize,
    pub name: String,
    pub alignment_refs: Vec<String>,
    pub alignment_source_ids: Vec<LandXmlSourceId>,
    pub surface_refs: Vec<String>,
    pub surface_source_ids: Vec<LandXmlSourceId>,
    pub grade_model_refs: Vec<String>,
}

/// A parser capability gap retained with its source identity and path.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LandXmlCapabilityDiagnostic {
    pub code: LandXmlCapabilityDiagnosticCode,
    pub source_id: Option<LandXmlSourceId>,
    pub source_path: String,
    pub message: String,
}

/// Stable capability diagnostics for non-rendering LandXML road semantics.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LandXmlCapabilityDiagnosticCode {
    SchemaVersionMismatch,
    MissingElevation,
    MissingReference,
    AmbiguousReference,
    UnsupportedGradeModelReference,
    UnresolvedPointReference,
    UnsupportedPlanFeatureReference,
    UnsupportedParcelReference,
    UnsupportedSlopeDistance,
    SectionDiscontinuity,
    UnsupportedCorridorExtension,
    UnsupportedStringLineExtension,
}

/// A bounded preserved-only corridor or stringline extension root.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LandXmlPreservedOnlyExtension {
    pub source_id: LandXmlSourceId,
    pub parent_source_id: Option<LandXmlSourceId>,
    pub local_name: String,
    pub source_path: String,
    pub kind: LandXmlPreservedOnlyExtensionKind,
}

/// The source area containing an unsupported preserved-only subtree.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LandXmlPreservedOnlyExtensionKind {
    Corridor,
    StringLine,
}
