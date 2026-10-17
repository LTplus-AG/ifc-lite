// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Bounded pull parsing for exact LandXML alignment element names.

mod actions;
mod driver;
mod state;

use super::{LandXmlAlignment, LandXmlAlignmentDocument, LandXmlSuperelevationEventKind};
use crate::{
    xml::{drive, error, normalize_encoding, Budget, Meter, Result},
    LandXmlCancellation, LandXmlCapabilityDiagnostic, LandXmlDiagnosticCode as Code, LandXmlLimits,
    LandXmlUnits,
};

/// Alignment-specific record bounds layered over the shared hostile-XML bounds.
#[derive(Clone, Debug)]
pub struct LandXmlAlignmentLimits {
    pub xml: LandXmlLimits,
    pub max_alignments: usize,
    pub max_alignment_segments: usize,
    pub max_alignment_points: usize,
    pub max_station_equations: usize,
    pub max_cant_stations: usize,
    pub max_superelevation_events: usize,
}
impl Default for LandXmlAlignmentLimits {
    fn default() -> Self {
        Self {
            xml: LandXmlLimits::default(),
            max_alignments: 100_000,
            max_alignment_segments: 5_000_000,
            max_alignment_points: 5_000_000,
            max_station_equations: 1_000_000,
            max_cant_stations: 5_000_000,
            max_superelevation_events: 5_000_000,
        }
    }
}
/// Parse LandXML 1.2 horizontal alignments with default resource limits.
pub fn parse_landxml_alignments(input: &[u8]) -> Result<LandXmlAlignmentDocument> {
    parse_landxml_alignments_with_cancel(input, &LandXmlAlignmentLimits::default(), None)
}
/// Parse a LandXML source while retaining an empty alignment collection when
/// the document contains terrain-only content. This is for format adapters
/// that own both source families; callers needing an alignment require the
/// strict [`parse_landxml_alignments`] entry point above.
pub fn parse_landxml_alignments_optional(input: &[u8]) -> Result<LandXmlAlignmentDocument> {
    parse_landxml_alignments_inner(input, &LandXmlAlignmentLimits::default(), None, false)
}
/// Parse a source with explicit resource limits while allowing terrain-only
/// documents to return an empty alignment collection.
pub fn parse_landxml_alignments_optional_with_cancel(
    input: &[u8],
    limits: &LandXmlAlignmentLimits,
    cancelled: Option<&dyn LandXmlCancellation>,
) -> Result<LandXmlAlignmentDocument> {
    parse_landxml_alignments_inner(input, limits, cancelled, false)
}
/// Parse alignment source records with cancellation and explicit record limits.
pub fn parse_landxml_alignments_with_cancel(
    input: &[u8],
    limits: &LandXmlAlignmentLimits,
    cancelled: Option<&dyn LandXmlCancellation>,
) -> Result<LandXmlAlignmentDocument> {
    parse_landxml_alignments_inner(input, limits, cancelled, true)
}
fn parse_landxml_alignments_inner(
    input: &[u8],
    limits: &LandXmlAlignmentLimits,
    cancelled: Option<&dyn LandXmlCancellation>,
    require_alignment: bool,
) -> Result<LandXmlAlignmentDocument> {
    if input.len() > limits.xml.max_bytes {
        return Err(error(Code::InputTooLarge, "input exceeds byte limit"));
    }
    // #5175 / EDGE-LXPARSE-7 (#7693): refuse a bad override token before
    // any XML is read, exactly as the TIN entry point does.
    let assumed_units = crate::semantics::resolve_assumed_units(&limits.xml)?;
    let input = normalize_encoding(input, &limits.xml, cancelled)?;
    let meter = Meter::new(limits.xml.max_work, cancelled);
    let mut handler = AlignmentHandler::new(limits, require_alignment, assumed_units);
    drive(&input, &limits.xml, cancelled, meter, &mut [&mut handler])?;
    handler.finish()
}
/// Which point a captured coordinate list names.
pub(super) enum PointRole {
    /// The `Start` of the alignment itself.
    AlignmentStart,
    /// One `AlignPI`.
    AlignPi,
    /// `Start`, `End`, `Center` or `PI` of the open primitive.
    Primitive(&'static str),
}
pub(super) enum Capture {
    Point {
        role: PointRole,
        depth: usize,
        pnt_ref: Option<String>,
        text: String,
    },
    PointList {
        dimension: usize,
        depth: usize,
        text: String,
    },
    Superelevation {
        kind: LandXmlSuperelevationEventKind,
        depth: usize,
        text: String,
    },
}
impl Capture {
    pub(super) fn depth(&self) -> usize {
        match self {
            Self::Point { depth, .. }
            | Self::PointList { depth, .. }
            | Self::Superelevation { depth, .. } => *depth,
        }
    }
}
/// The alignment family's records (a [`FamilyHandler`]); pull and the stream
/// drive this one handler through the one driver.
pub(crate) struct AlignmentHandler {
    limits: LandXmlAlignmentLimits,
    capability_diagnostics_seen: Budget,
    units: Option<LandXmlUnits>,
    /// Effective only when the source declares no `LandXML/Units` (#5175).
    assumed_units: Option<LandXmlUnits>,
    alignments: Vec<LandXmlAlignment>,
    segments_seen: Budget,
    alignment_points_seen: Budget,
    station_equations_seen: Budget,
    cant_stations_seen: Budget,
    superelevation_events_seen: Budget,
    alignment: Option<state::AlignmentBuilder>,
    capture: Option<Capture>,
    warnings: Vec<String>,
    schema: String,
    version: String,
    capability_diagnostics: Vec<LandXmlCapabilityDiagnostic>,
    require_alignment: bool,
}
impl AlignmentHandler {
    pub(crate) fn new(
        limits: &LandXmlAlignmentLimits,
        require_alignment: bool,
        assumed_units: Option<LandXmlUnits>,
    ) -> Self {
        Self {
            limits: limits.clone(),
            capability_diagnostics_seen: Budget::new(limits.xml.max_capability_diagnostics, "capability diagnostic"),
            units: None,
            assumed_units,
            alignments: Vec::new(),
            segments_seen: Budget::new(limits.max_alignment_segments, "alignment segment"),
            alignment_points_seen: Budget::new(limits.max_alignment_points, "alignment point"),
            station_equations_seen: Budget::new(limits.max_station_equations, "station equation"),
            cant_stations_seen: Budget::new(limits.max_cant_stations, "CantStation"),
            superelevation_events_seen: Budget::new(limits.max_superelevation_events, "superelevation event"),
            alignment: None,
            capture: None,
            warnings: Vec::new(),
            schema: String::new(),
            version: String::new(),
            capability_diagnostics: Vec::new(),
            require_alignment,
        }
    }
}
