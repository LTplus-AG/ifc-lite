// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Durable LandXML alignment records, deliberately independent of rendering.

use serde::{Deserialize, Serialize};

use crate::{LandXmlSourceId, LandXmlUnits};

/// A LandXML plan coordinate in its declared `northing easting [elevation]`
/// order. It is never silently swapped into a renderer axis convention.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlPlanPoint {
    pub northing: f64,
    pub easting: f64,
    pub elevation: Option<f64>,
}

/// A coordinate leaf as authored. Resolving `pntRef` belongs to the later COGO
/// source adapter; numerical geometry refuses unresolved references explicitly.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LandXmlPointLocation {
    Coordinates { point: LandXmlPlanPoint },
    PointReference { pnt_ref: String },
}

/// One authored `AlignPIs/AlignPI` location, preserved independently from
/// primitive PI leaves and with a stable source identity.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlAlignmentPi {
    pub source_id: LandXmlSourceId,
    pub location: LandXmlPointLocation,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LandXmlRotation {
    Clockwise,
    CounterClockwise,
}

impl LandXmlRotation {
    pub const fn sign(self) -> f64 {
        match self {
            Self::Clockwise => -1.0,
            Self::CounterClockwise => 1.0,
        }
    }
}

/// LandXML uses `INF` for a transition's infinite radius.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LandXmlRadius {
    Finite(f64),
    Infinite,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlLine {
    pub start: LandXmlPointLocation,
    pub end: LandXmlPointLocation,
    pub declared_length: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlIrregularLine {
    pub start: LandXmlPointLocation,
    pub end: LandXmlPointLocation,
    /// The source's intermediate polyline, retained rather than reduced to a
    /// single straight segment.
    pub points: Vec<LandXmlPlanPoint>,
    pub declared_length: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlCurve {
    pub start: LandXmlPointLocation,
    pub center: LandXmlPointLocation,
    pub end: LandXmlPointLocation,
    pub pi: Option<LandXmlPointLocation>,
    pub rotation: LandXmlRotation,
    pub radius: Option<f64>,
    pub declared_length: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlSpiral {
    pub start: LandXmlPointLocation,
    pub pi: LandXmlPointLocation,
    pub end: LandXmlPointLocation,
    /// Exact LandXML `spiType`, retained even when this numeric foundation does
    /// not implement it.
    pub spi_type: String,
    pub radius_start: LandXmlRadius,
    pub radius_end: LandXmlRadius,
    pub rotation: LandXmlRotation,
    pub declared_length: f64,
}

/// A source primitive with a durable source id independent of chunks or meshes.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LandXmlAlignmentPrimitive {
    Line(LandXmlLine),
    IrregularLine(LandXmlIrregularLine),
    Curve(LandXmlCurve),
    Spiral(LandXmlSpiral),
    /// Preserved in geometric order but deliberately unavailable to evaluation.
    UnsupportedSpiral(LandXmlSpiral),
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlAlignmentSegment {
    pub source_id: LandXmlSourceId,
    /// One-based source order within this `CoordGeom`.
    pub ordinal: usize,
    pub primitive: LandXmlAlignmentPrimitive,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlStationEquation {
    pub source_id: LandXmlSourceId,
    pub sta_internal: f64,
    pub sta_ahead: f64,
    pub sta_back: Option<f64>,
    pub sta_increment: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlCantStation {
    pub source_id: LandXmlSourceId,
    pub station: f64,
    pub applied_cant: f64,
    pub equilibrium_cant: Option<f64>,
    pub curvature: LandXmlRotation,
    pub cant_deficiency: Option<f64>,
    pub cant_excess: Option<f64>,
    pub rate_of_change_of_applied_cant_over_time: Option<f64>,
    pub rate_of_change_of_applied_cant_over_length: Option<f64>,
    pub rate_of_change_of_cant_deficiency_over_time: Option<f64>,
    pub cant_gradient: Option<f64>,
    pub speed: Option<f64>,
    pub transition_type: Option<String>,
    pub adverse: Option<bool>,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlSpeedStation {
    pub source_id: LandXmlSourceId,
    pub station: f64,
    pub speed: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlCant {
    pub source_id: LandXmlSourceId,
    pub name: String,
    pub gauge: f64,
    pub rotation_point: Option<String>,
    pub equilibrium_constant: Option<f64>,
    pub applied_cant_constant: Option<f64>,
    pub stations: Vec<LandXmlCantStation>,
    pub speed_stations: Vec<LandXmlSpeedStation>,
}

/// The exact named events in LandXML `Superelevation`.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LandXmlSuperelevationEventKind {
    BeginRunoutSta,
    BeginRunoffSta,
    FullSuperSta,
    FullSuperelev,
    RunoffSta,
    StartofRunoutSta,
    EndofRunoutSta,
    AdverseSE,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlSuperelevationEvent {
    pub source_id: LandXmlSourceId,
    pub kind: LandXmlSuperelevationEventKind,
    /// `None` retains an explicitly nil/empty schema event.
    pub value: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlSuperelevation {
    pub source_id: LandXmlSourceId,
    pub sta_start: Option<f64>,
    pub sta_end: Option<f64>,
    pub events: Vec<LandXmlSuperelevationEvent>,
}

/// A transition retained but intentionally unavailable to numeric probing.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlUnsupportedTransition {
    pub source_id: LandXmlSourceId,
    pub spi_type: String,
    pub spiral: LandXmlSpiral,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlAlignment {
    pub source_id: LandXmlSourceId,
    pub ordinal: usize,
    pub name: String,
    pub length: f64,
    pub sta_start: f64,
    pub start: Option<LandXmlPointLocation>,
    /// Authored `AlignPIs` leaves. They are an explicit source capability,
    /// not inferred from primitive `PI` leaves or reconstructed geometry.
    pub align_pis: Vec<LandXmlAlignmentPi>,
    pub segments: Vec<LandXmlAlignmentSegment>,
    pub station_equations: Vec<LandXmlStationEquation>,
    pub cant: Option<LandXmlCant>,
    pub superelevations: Vec<LandXmlSuperelevation>,
    pub unsupported_transitions: Vec<LandXmlUnsupportedTransition>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlAlignmentDocument {
    /// Namespace-selected grammar used to parse this source, independent from
    /// the producer's declared version string.
    pub schema: String,
    /// The producer-authored root version, retained verbatim as provenance.
    pub version: String,
    /// Compatibility observations retained for direct alignment-parser consumers.
    pub capability_diagnostics: Vec<crate::LandXmlCapabilityDiagnostic>,
    /// LandXML's declared linear/elevation units. Alignment geometry remains
    /// authored-value data; a format-neutral georeferencing adapter owns any
    /// coordinate conversion.
    pub units: Option<LandXmlUnits>,
    pub alignments: Vec<LandXmlAlignment>,
    pub warnings: Vec<String>,
}
