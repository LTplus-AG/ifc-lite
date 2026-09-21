/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Bounded pull parsing for exact LandXML 1.2 COGO and plan element names.

use quick_xml::{events::Event, Reader};

use super::{
    model::LandXmlPlanReferenceIndex, LandXmlCgPoint, LandXmlMonument, LandXmlParcel,
    LandXmlPlanDocument, LandXmlPlanFeature,
};
use crate::{
    classify_landxml_version,
    preflight::preflight_xml_tokens,
    semantics::units,
    xml::{
        attr, attributes, character_references, error, normalize_encoding, split_name, unescape,
        Attributes, Result,
    },
    LandXmlCancellation, LandXmlDiagnosticCode as Code, LandXmlLimits, LandXmlSourceId,
    LandXmlUnits, LandXmlVersionCapability, LANDXML_12_NAMESPACE,
};

mod actions;
mod driver;
mod state;
mod value;
use state::{Active, Capture, Frame, GeometryBuilder};
pub(super) use value::area_scale;
/// Plan-record bounds layered over the shared hostile-XML limits.
#[derive(Clone, Debug)]
pub struct LandXmlPlanLimits {
    pub xml: LandXmlLimits,
    pub max_cogo_points: usize,
    pub max_monuments: usize,
    pub max_plan_features: usize,
    pub max_parcels: usize,
    pub max_geometry: usize,
    pub max_vertices: usize,
}
impl Default for LandXmlPlanLimits {
    fn default() -> Self {
        Self {
            xml: LandXmlLimits::default(),
            max_cogo_points: 5_000_000,
            max_monuments: 1_000_000,
            max_plan_features: 1_000_000,
            max_parcels: 1_000_000,
            max_geometry: 5_000_000,
            max_vertices: 10_000_000,
        }
    }
}

/// Parse COGO points, monuments, parcels and plan features from LandXML 1.2.
pub fn parse_landxml_plan(input: &[u8]) -> Result<LandXmlPlanDocument> {
    parse_landxml_plan_with_cancel(input, &LandXmlPlanLimits::default(), None)
}
/// Parse plan records while bounding work and polling the caller's cancellation hook.
pub fn parse_landxml_plan_with_cancel(
    input: &[u8],
    limits: &LandXmlPlanLimits,
    cancelled: Option<&dyn LandXmlCancellation>,
) -> Result<LandXmlPlanDocument> {
    if input.len() > limits.xml.max_bytes {
        return Err(error(Code::InputTooLarge, "input exceeds byte limit"));
    }
    let input = normalize_encoding(input, &limits.xml, cancelled)?;
    preflight_xml_tokens(&input, &limits.xml, cancelled)?;
    let mut parser = Parser::new(limits, cancelled);
    let mut reader = Reader::from_reader(input.as_slice());
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|_| error(Code::InvalidXml, "malformed XML"))?;
        if matches!(event, Event::Eof) {
            break;
        }
        parser.consume_event(event)?;
        buffer.clear();
    }
    if !parser.root_seen {
        return Err(error(Code::InvalidXml, "LandXML document is empty"));
    }
    if !parser.frames.is_empty() {
        return Err(error(Code::InvalidXml, "unclosed XML element"));
    }
    Ok(parser.document())
}

// Child action modules need the builders while the one-pass driver needs only
// the opaque parser type and its methods.
#[allow(private_interfaces)]
pub(crate) struct Parser<'a> {
    pub(super) limits: LandXmlPlanLimits,
    pub(super) cancelled: Option<&'a dyn LandXmlCancellation>,
    pub(super) work: usize,
    pub(super) characters: usize,
    pub(super) references: usize,
    pub(super) frames: Vec<Frame>,
    pub(super) units: Option<LandXmlUnits>,
    pub(super) area_unit: Option<String>,
    pub(super) area_scale_to_square_meters: Option<f64>,
    pub(super) version: String,
    pub(super) root_seen: bool,
    pub(super) cogo_points: Vec<LandXmlCgPoint>,
    pub(super) reference_index: LandXmlPlanReferenceIndex,
    pub(super) monuments: Vec<LandXmlMonument>,
    pub(super) features: Vec<LandXmlPlanFeature>,
    pub(super) parcels: Vec<LandXmlParcel>,
    pub(super) active: Vec<Active>,
    pub(super) active_depths: Vec<usize>,
    pub(super) geometry: Option<GeometryBuilder>,
    pub(super) capture: Option<Capture>,
    pub(super) scope_stack: Vec<(usize, LandXmlSourceId)>,
    pub(super) reference_scope: Option<LandXmlSourceId>,
    pub(super) scope_ordinal: usize,
    pub(super) cogo_ordinal: usize,
    pub(super) monument_ordinal: usize,
    pub(super) vertices: usize,
    pub(super) geometry_count: usize,
    pub(super) feature_ordinal: usize,
    pub(super) parcel_ordinal: usize,
}
impl<'a> Parser<'a> {
    fn new(limits: &LandXmlPlanLimits, cancelled: Option<&'a dyn LandXmlCancellation>) -> Self {
        Self {
            limits: limits.clone(),
            cancelled,
            work: 0,
            characters: 0,
            references: 0,
            frames: Vec::new(),
            units: None,
            area_unit: None,
            area_scale_to_square_meters: None,
            version: String::new(),
            root_seen: false,
            cogo_points: Vec::new(),
            reference_index: LandXmlPlanReferenceIndex::default(),
            monuments: Vec::new(),
            features: Vec::new(),
            parcels: Vec::new(),
            active: Vec::new(),
            active_depths: Vec::new(),
            geometry: None,
            capture: None,
            scope_stack: Vec::new(),
            reference_scope: None,
            scope_ordinal: 0,
            cogo_ordinal: 0,
            monument_ordinal: 0,
            vertices: 0,
            geometry_count: 0,
            feature_ordinal: 0,
            parcel_ordinal: 0,
        }
    }
    pub(super) fn check(&mut self, added: usize) -> Result<()> {
        if self
            .cancelled
            .is_some_and(LandXmlCancellation::is_cancelled)
        {
            return Err(error(Code::Cancelled, "ingestion cancelled"));
        }
        self.work = self
            .work
            .checked_add(added)
            .ok_or_else(|| error(Code::LimitExceeded, "work limit exceeded"))?;
        if self.work > self.limits.xml.max_work {
            return Err(error(Code::LimitExceeded, "work limit exceeded"));
        }
        Ok(())
    }

    pub(crate) fn consume_event(&mut self, event: Event<'_>) -> Result<()> {
        self.check(1)?;
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
    pub(crate) fn new_stream(limits: LandXmlPlanLimits) -> Self {
        Self::new(&limits, None)
    }
}
