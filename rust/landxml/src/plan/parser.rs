/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Bounded pull parsing for exact LandXML 1.2 COGO and plan element names.

use quick_xml::events::Event;

use super::{
    model::LandXmlPlanReferenceIndex, LandXmlCgPoint, LandXmlMonument, LandXmlParcel,
    LandXmlPlanDocument, LandXmlPlanFeature,
};
use crate::{
    semantics::units,
    xml::{
        attr, attributes, decode_ref, decode_text, error, normalize_encoding, read_events, source_len,
        split_name,
        Attributes, Budget, Meter, Result,
    },
    LandXmlCancellation, LandXmlCapabilityDiagnostic, LandXmlDiagnosticCode as Code, LandXmlLimits,
    LandXmlSourceId, LandXmlUnits,
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
    // #5175 / EDGE-LXPARSE-7 (#7693): refuse a bad override token before
    // any XML is read, exactly as the TIN entry point does.
    let assumed_units = crate::semantics::resolve_assumed_units(&limits.xml)?;
    let input = normalize_encoding(input, &limits.xml, cancelled)?;
    let mut parser = Parser::new(limits, cancelled, assumed_units);
    read_events(&input, &limits.xml, cancelled, |event| parser.consume_event(event))?;
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
    /// The `work` budget; charged per event in `consume_event` (D73).
    pub(super) meter: Meter<'a>,
    pub(super) characters: Budget,
    pub(super) references: Budget,
    pub(super) capability_diagnostics_seen: Budget,
    pub(super) vertices: Budget,
    pub(super) geometry_seen: Budget,
    pub(super) frames: Vec<Frame>,
    pub(super) units: Option<LandXmlUnits>,
    /// Effective only when the source declares no `LandXML/Units` (#5175).
    pub(super) assumed_units: Option<LandXmlUnits>,
    pub(super) area_unit: Option<String>,
    pub(super) area_scale_to_square_meters: Option<f64>,
    pub(super) schema: String,
    pub(super) version: String,
    pub(super) capability_diagnostics: Vec<LandXmlCapabilityDiagnostic>,
    pub(super) target_namespace: Option<String>,
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
    pub(super) feature_ordinal: usize,
    pub(super) parcel_ordinal: usize,
}
impl<'a> Parser<'a> {
    fn new(
        limits: &LandXmlPlanLimits,
        cancelled: Option<&'a dyn LandXmlCancellation>,
        assumed_units: Option<LandXmlUnits>,
    ) -> Self {
        Self {
            limits: limits.clone(),
            meter: Meter::new(limits.xml.max_work, cancelled),
            characters: Budget::new(limits.xml.max_character_references, "character reference"),
            references: Budget::new(limits.xml.max_references, "reference"),
            capability_diagnostics_seen: Budget::new(limits.xml.max_capability_diagnostics, "capability diagnostic"),
            vertices: Budget::new(limits.max_vertices, "plan vertex"),
            geometry_seen: Budget::new(limits.max_geometry, "CoordGeom primitive"),
            frames: Vec::new(),
            units: None,
            assumed_units,
            area_unit: None,
            area_scale_to_square_meters: None,
            schema: String::new(),
            version: String::new(),
            capability_diagnostics: Vec::new(),
            target_namespace: None,
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
            feature_ordinal: 0,
            parcel_ordinal: 0,
        }
    }
    pub(super) fn check(&mut self, added: usize) -> Result<()> {
        self.meter.charge(added)
    }

    /// A diagnostic is source output too: bounded like every other record.
    pub(super) fn record_capability_diagnostic(
        &mut self,
        diagnostic: LandXmlCapabilityDiagnostic,
    ) -> Result<()> {
        self.capability_diagnostics_seen.reserve(1)?;
        self.capability_diagnostics.push(diagnostic);
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
            Event::End(value) => self.end(Some(value.name().as_ref().as_bytes())),
            Event::Text(value) => self.text(value.as_ref().as_bytes()),
            // #7680: a reference in text arrives as its own event.
            Event::GeneralRef(reference) => self.reference(&reference),
            Event::CData(value) => self.cdata(value.as_ref().as_bytes()),
            Event::DocType(_) => Err(error(Code::DtdForbidden, "DOCTYPE is not allowed")),
            _ => Ok(()),
        }
    }

    pub(crate) fn has_open_frames(&self) -> bool {
        !self.frames.is_empty()
    }
}

impl Parser<'static> {
    pub(crate) fn new_stream(
        limits: LandXmlPlanLimits,
        assumed_units: Option<LandXmlUnits>,
    ) -> Self {
        Self::new(&limits, None, assumed_units)
    }
}
