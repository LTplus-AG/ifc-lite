/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Bounded pull parsing for exact LandXML 1.2 COGO and plan element names.

use super::{
    model::LandXmlPlanReferenceIndex, LandXmlCgPoint, LandXmlMonument, LandXmlParcel,
    LandXmlPlanDocument, LandXmlPlanFeature,
};
use crate::{
    semantics::units,
    xml::{
        attr, drive, error, normalize_encoding, Attributes, Budget, Cx, Element, FamilyHandler, Frame,
        Meter, Result,
    },
    LandXmlCancellation, LandXmlCapabilityDiagnostic, LandXmlDiagnosticCode as Code, LandXmlLimits,
    LandXmlSourceId, LandXmlUnits,
};

mod actions;
mod driver;
mod state;
mod value;
use state::{Active, Capture, GeometryBuilder};
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
    let meter = Meter::new(limits.xml.max_work, cancelled);
    let mut handler = PlanHandler::new(limits, assumed_units);
    drive(&input, &limits.xml, cancelled, meter, &mut [&mut handler])?;
    Ok(handler.document())
}

/// The plan family's records (a [`FamilyHandler`]); pull and the stream drive
/// this one handler through the one driver.
pub(crate) struct PlanHandler {
    limits: LandXmlPlanLimits,
    references: Budget,
    capability_diagnostics_seen: Budget,
    vertices: Budget,
    geometry_seen: Budget,
    units: Option<LandXmlUnits>,
    /// Effective only when the source declares no `LandXML/Units` (#5175).
    assumed_units: Option<LandXmlUnits>,
    area_unit: Option<String>,
    area_scale_to_square_meters: Option<f64>,
    schema: String,
    version: String,
    capability_diagnostics: Vec<LandXmlCapabilityDiagnostic>,
    cogo_points: Vec<LandXmlCgPoint>,
    reference_index: LandXmlPlanReferenceIndex,
    monuments: Vec<LandXmlMonument>,
    features: Vec<LandXmlPlanFeature>,
    parcels: Vec<LandXmlParcel>,
    active: Vec<Active>,
    active_depths: Vec<usize>,
    geometry: Option<GeometryBuilder>,
    capture: Option<Capture>,
    scope_stack: Vec<(usize, LandXmlSourceId)>,
    reference_scope: Option<LandXmlSourceId>,
    scope_ordinal: usize,
    cogo_ordinal: usize,
    monument_ordinal: usize,
    feature_ordinal: usize,
    parcel_ordinal: usize,
}
impl PlanHandler {
    pub(crate) fn new(
        limits: &LandXmlPlanLimits,
        assumed_units: Option<LandXmlUnits>,
    ) -> Self {
        Self {
            limits: limits.clone(),
            references: Budget::new(limits.xml.max_references, "reference"),
            capability_diagnostics_seen: Budget::new(limits.xml.max_capability_diagnostics, "capability diagnostic"),
            vertices: Budget::new(limits.max_vertices, "plan vertex"),
            geometry_seen: Budget::new(limits.max_geometry, "CoordGeom primitive"),
            units: None,
            assumed_units,
            area_unit: None,
            area_scale_to_square_meters: None,
            schema: String::new(),
            version: String::new(),
            capability_diagnostics: Vec::new(),
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
    /// A diagnostic is source output too: bounded like every other record.
    pub(super) fn record_capability_diagnostic(
        &mut self,
        diagnostic: LandXmlCapabilityDiagnostic,
    ) -> Result<()> {
        self.capability_diagnostics_seen.reserve(1)?;
        self.capability_diagnostics.push(diagnostic);
        Ok(())
    }
}
