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
mod parser;

pub use model::{
    LandXmlCgPoint, LandXmlGeometryKind, LandXmlMonument, LandXmlParcel, LandXmlParcelProbe,
    LandXmlParcelState, LandXmlPlanDocument, LandXmlPlanFeature, LandXmlPlanGeometry,
    LandXmlPlanPoint, LandXmlPlanPointLocation,
};
pub use parser::{parse_landxml_plan, parse_landxml_plan_with_cancel, LandXmlPlanLimits};
