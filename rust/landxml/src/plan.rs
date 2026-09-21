/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! COGO and plan-source semantics kept separate from terrain ingestion.
//!
//! This is intentionally a native semantic seam.  #5084 owns the durable
//! terrain document and a later adapter may combine both documents without
//! treating a plan record as IFC or renderer geometry.

mod model;
mod numeric;
pub(crate) mod parser;

pub use model::{
    LandXmlCgPoint, LandXmlGeometryKind, LandXmlMonument, LandXmlParcel, LandXmlParcelProbe,
    LandXmlParcelState, LandXmlPlanDocument, LandXmlPlanFeature, LandXmlPlanGeometry,
    LandXmlPlanPoint, LandXmlPlanPointLocation, LandXmlPlanSourceBatch,
};
pub use numeric::references::LandXmlPlanResolver;
pub use parser::{parse_landxml_plan, parse_landxml_plan_with_cancel, LandXmlPlanLimits};

/// The durable LandXML source document joins terrain and plan semantics from
/// the same original byte stream. It deliberately does not create IFC or a
/// renderer-specific representation; the canonical loader owns that step.
#[derive(Clone, Debug, serde::Deserialize, PartialEq, serde::Serialize)]
pub struct LandXmlDocument {
    #[serde(flatten)]
    pub terrain: crate::LandXmlTinDocument,
    pub plan: LandXmlPlanDocument,
}

/// Parse all supported LandXML 1.2 semantic families from one source buffer.
pub fn parse_landxml_document(
    input: &[u8],
) -> std::result::Result<LandXmlDocument, crate::LandXmlError> {
    Ok(LandXmlDocument {
        terrain: crate::parser::parse_landxml_document(input)?,
        plan: parse_landxml_plan(input)?,
    })
}
