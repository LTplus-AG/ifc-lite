// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Bounded pull parsing for exact LandXML alignment element names.

mod actions;
mod driver;
mod state;

use std::collections::HashMap;

use quick_xml::{events::Event, Reader};

use super::{LandXmlAlignment, LandXmlAlignmentDocument, LandXmlSuperelevationEventKind};
use crate::{
    preflight::preflight_xml_tokens,
    xml::{error, normalize_encoding, Result},
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
    let input = normalize_encoding(input, &limits.xml, cancelled)?;
    preflight_xml_tokens(&input, &limits.xml, cancelled)?;
    let mut parser = Parser::new(limits, cancelled, require_alignment);
    let mut reader = Reader::from_reader(input.as_slice());
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    loop {
        parser.check(1)?;
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|_| error(Code::InvalidXml, "malformed XML"))?;
        if matches!(event, Event::Eof) {
            break;
        }
        parser.consume_event(event)?;
        buffer.clear();
    }
    if !parser.frames.is_empty() {
        return Err(error(Code::InvalidXml, "unclosed XML element"));
    }
    parser.finish()
}
#[derive(Clone)]
pub(super) struct Frame {
    pub(super) local: String,
    pub(super) target: bool,
    pub(super) namespaces: HashMap<String, String>,
}
pub(super) enum Capture {
    Point {
        local: String,
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
pub(crate) struct Parser<'a> {
    pub(super) limits: LandXmlAlignmentLimits,
    pub(super) cancelled: Option<&'a dyn LandXmlCancellation>,
    pub(super) work: usize,
    pub(super) character_references: usize,
    pub(super) frames: Vec<Frame>,
    pub(super) units: Option<LandXmlUnits>,
    pub(super) alignments: Vec<LandXmlAlignment>,
    pub(super) segments_seen: usize,
    pub(super) alignment_points_seen: usize,
    pub(super) station_equations_seen: usize,
    pub(super) cant_stations_seen: usize,
    pub(super) superelevation_events_seen: usize,
    pub(super) alignment: Option<state::AlignmentBuilder>,
    pub(super) capture: Option<Capture>,
    pub(super) warnings: Vec<String>,
    pub(super) schema: String,
    pub(super) version: String,
    pub(super) capability_diagnostics: Vec<LandXmlCapabilityDiagnostic>,
    pub(super) target_namespace: Option<String>,
    pub(super) root_seen: bool,
    pub(super) root_closed: bool,
    pub(super) require_alignment: bool,
}
impl<'a> Parser<'a> {
    fn new(
        limits: &LandXmlAlignmentLimits,
        cancelled: Option<&'a dyn LandXmlCancellation>,
        require_alignment: bool,
    ) -> Self {
        Self {
            limits: limits.clone(),
            cancelled,
            work: 0,
            character_references: 0,
            frames: Vec::new(),
            units: None,
            alignments: Vec::new(),
            segments_seen: 0,
            alignment_points_seen: 0,
            station_equations_seen: 0,
            cant_stations_seen: 0,
            superelevation_events_seen: 0,
            alignment: None,
            capture: None,
            warnings: Vec::new(),
            schema: String::new(),
            version: String::new(),
            capability_diagnostics: Vec::new(),
            target_namespace: None,
            root_seen: false,
            root_closed: false,
            require_alignment,
        }
    }

    pub(crate) fn consume_event(&mut self, event: Event<'_>) -> Result<()> {
        match event {
            Event::Start(value) => self.start(&value),
            Event::Empty(value) => {
                self.start(&value)?;
                self.end(None)
            }
            Event::End(value) => self.end(Some(value.name().as_ref())),
            Event::Text(value) => self.text(value.as_ref()),
            Event::CData(value) => self.cdata(value.as_ref()),
            Event::DocType(_) => Err(error(Code::DtdForbidden, "DOCTYPE is not allowed")),
            _ => Ok(()),
        }
    }

    pub(crate) fn has_open_frames(&self) -> bool {
        !self.frames.is_empty()
    }
}

impl Parser<'static> {
    pub(crate) fn new_stream(limits: LandXmlAlignmentLimits) -> Self {
        Self::new(&limits, None, false)
    }
}
