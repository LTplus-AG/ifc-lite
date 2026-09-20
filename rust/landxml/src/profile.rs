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
}

impl fmt::Display for LandXmlProfileEvaluationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::MissingTangentPvi => "vertical curve requires finite PVIs on both tangents",
            Self::InvalidCurveDeclaration => "vertical curve has an invalid length or radius",
            Self::InconsistentCircularCurve => {
                "circular curve radius, length, and tangent grades disagree"
            }
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

impl LandXmlProfile {
    /// Evaluate a proposed profile at an authored station.
    ///
    /// This is intentionally only available for `ProfAlign`: sampled
    /// `ProfSurf` grade lines retain discontinuities and must not be bridged.
    /// A curve's text coordinate is its PVI.  Its incoming/outgoing tangents
    /// come from the adjacent finite PVIs, as prescribed by LandXML's vertical
    /// alignment representation.  `None` means the station lies outside the
    /// available source extent; an error means the source advertises a curve
    /// whose required tangent geometry is absent or contradictory.
    pub fn evaluate_elevation_at(
        &self,
        station: f64,
    ) -> Result<Option<f64>, LandXmlProfileEvaluationError> {
        if self.kind != LandXmlProfileKind::Design || !station.is_finite() {
            return Ok(None);
        }
        for curve in &self.vertical_curves {
            let Some(index) = self
                .pvis
                .iter()
                .position(|pvi| pvi.station == curve.station && pvi.elevation == curve.elevation)
            else {
                return Err(LandXmlProfileEvaluationError::MissingTangentPvi);
            };
            let Some((before, pvi, after)) = self
                .pvis
                .get(index.checked_sub(1).unwrap_or(usize::MAX))
                .zip(self.pvis.get(index))
                .zip(self.pvis.get(index + 1))
                .map(|((before, pvi), after)| (before, pvi, after))
            else {
                return Err(LandXmlProfileEvaluationError::MissingTangentPvi);
            };
            let (Some(before_elevation), Some(pvi_elevation), Some(after_elevation)) =
                (before.elevation, pvi.elevation, after.elevation)
            else {
                return Err(LandXmlProfileEvaluationError::MissingTangentPvi);
            };
            let incoming_run = pvi.station - before.station;
            let outgoing_run = after.station - pvi.station;
            if incoming_run <= 0.0 || outgoing_run <= 0.0 {
                return Err(LandXmlProfileEvaluationError::InvalidCurveDeclaration);
            }
            let incoming_grade = (pvi_elevation - before_elevation) / incoming_run;
            let outgoing_grade = (after_elevation - pvi_elevation) / outgoing_run;
            let (length_in, length_out) = match curve.kind {
                LandXmlVerticalCurveKind::Parabolic | LandXmlVerticalCurveKind::Circular => {
                    let Some(length) = curve.length.filter(|value| *value > 0.0) else {
                        return Err(LandXmlProfileEvaluationError::InvalidCurveDeclaration);
                    };
                    (length / 2.0, length / 2.0)
                }
                LandXmlVerticalCurveKind::UnsymmetricalParabolic => {
                    let (Some(length_in), Some(length_out)) = (curve.length_in, curve.length_out)
                    else {
                        return Err(LandXmlProfileEvaluationError::InvalidCurveDeclaration);
                    };
                    if length_in <= 0.0 || length_out <= 0.0 {
                        return Err(LandXmlProfileEvaluationError::InvalidCurveDeclaration);
                    }
                    (length_in, length_out)
                }
            };
            let start = pvi.station - length_in;
            let end = pvi.station + length_out;
            if station < start || station > end {
                continue;
            }
            let x = station - start;
            let start_elevation = pvi_elevation - incoming_grade * length_in;
            let total = length_in + length_out;
            return match curve.kind {
                LandXmlVerticalCurveKind::Parabolic => Ok(Some(
                    start_elevation
                        + incoming_grade * x
                        + (outgoing_grade - incoming_grade) * x * x / (2.0 * total),
                )),
                LandXmlVerticalCurveKind::UnsymmetricalParabolic => {
                    // A single quadratic cannot have its tangent intersection
                    // away from the midpoint.  LandXML's asymmetric form is
                    // therefore two parabolic halves joined at the PVI; each
                    // half uses the same constant rate of grade change.
                    let rate = (outgoing_grade - incoming_grade) / total;
                    if x <= length_in {
                        Ok(Some(
                            start_elevation + incoming_grade * x + rate * x * x / 2.0,
                        ))
                    } else {
                        let at_pvi = start_elevation
                            + incoming_grade * length_in
                            + rate * length_in * length_in / 2.0;
                        let pvi_grade = incoming_grade + rate * length_in;
                        let local = x - length_in;
                        Ok(Some(
                            at_pvi + pvi_grade * local + rate * local * local / 2.0,
                        ))
                    }
                }
                LandXmlVerticalCurveKind::Circular => {
                    let Some(radius) = curve.radius.filter(|value| *value > 0.0) else {
                        return Err(LandXmlProfileEvaluationError::InvalidCurveDeclaration);
                    };
                    let theta_in = incoming_grade.atan();
                    let theta_out = outgoing_grade.atan();
                    let sine_in = theta_in.sin();
                    let sine_out = theta_out.sin();
                    let change = sine_out - sine_in;
                    if change.abs() <= f64::EPSILON {
                        return Ok(Some(start_elevation + incoming_grade * x));
                    }
                    let curvature = change.signum() / radius;
                    if (change - curvature * total).abs() > 1.0e-8_f64.max(total * 1.0e-8) {
                        return Err(LandXmlProfileEvaluationError::InconsistentCircularCurve);
                    }
                    let sine = sine_in + curvature * x;
                    if sine.abs() > 1.0 + 1.0e-12 {
                        return Err(LandXmlProfileEvaluationError::InconsistentCircularCurve);
                    }
                    Ok(Some(
                        start_elevation
                            + ((1.0 - sine_in * sine_in).sqrt()
                                - (1.0 - sine * sine).max(0.0).sqrt())
                                / curvature,
                    ))
                }
            };
        }
        for pair in self.pvis.windows(2) {
            let (left, right) = (&pair[0], &pair[1]);
            if station < left.station || station > right.station {
                continue;
            }
            let (Some(left_elevation), Some(right_elevation)) = (left.elevation, right.elevation)
            else {
                return Ok(None);
            };
            let run = right.station - left.station;
            if run <= 0.0 {
                return Err(LandXmlProfileEvaluationError::InvalidCurveDeclaration);
            }
            return Ok(Some(
                left_elevation
                    + (station - left.station) * (right_elevation - left_elevation) / run,
            ));
        }
        Ok(None)
    }
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
