/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{LandXmlSourceId, LandXmlUnits};

pub type LandXmlProperties = BTreeMap<String, String>;

/// A coordinate in LandXML's authored northing/easting/elevation order.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlPlanPoint {
    pub northing: f64,
    pub easting: f64,
    pub elevation: Option<f64>,
}

/// A plan geometry endpoint is either authored directly or a COGO reference.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LandXmlPlanPointLocation {
    Coordinates { point: LandXmlPlanPoint },
    PointReference { pnt_ref: String },
}

/// A COGO point's namespace-local identity is distinct from its display name.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlCgPoint {
    pub source_id: LandXmlSourceId,
    pub scope_id: LandXmlSourceId,
    pub ordinal: usize,
    pub name: Option<String>,
    pub code: Option<String>,
    pub description: Option<String>,
    pub point: LandXmlPlanPoint,
    pub properties: LandXmlProperties,
}

/// A monument retains the source point reference instead of resolving it away.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlMonument {
    pub source_id: LandXmlSourceId,
    /// The COGO scope active when this exact `Monument` was authored.
    pub point_scope_id: Option<LandXmlSourceId>,
    pub ordinal: usize,
    pub name: Option<String>,
    pub code: Option<String>,
    pub description: Option<String>,
    pub pnt_ref: Option<String>,
    pub point: Option<LandXmlPlanPoint>,
    pub properties: LandXmlProperties,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LandXmlGeometryKind {
    Line,
    Curve,
    IrregularLine,
}

/// An analytic `CoordGeom` primitive, never a tessellated substitute.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlPlanGeometry {
    pub source_id: LandXmlSourceId,
    pub ordinal: usize,
    pub kind: LandXmlGeometryKind,
    pub point_scope_id: Option<LandXmlSourceId>,
    pub start: LandXmlPlanPointLocation,
    pub end: LandXmlPlanPointLocation,
    pub center: Option<LandXmlPlanPointLocation>,
    pub pi: Option<LandXmlPlanPointLocation>,
    pub intermediate_points: Vec<LandXmlPlanPoint>,
    pub rotation: Option<String>,
    pub radius: Option<f64>,
    pub declared_length: Option<f64>,
    pub properties: LandXmlProperties,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlPlanFeature {
    pub source_id: LandXmlSourceId,
    pub ordinal: usize,
    pub name: Option<String>,
    pub code: Option<String>,
    pub description: Option<String>,
    pub properties: LandXmlProperties,
    pub geometry: Vec<LandXmlPlanGeometry>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlParcel {
    pub source_id: LandXmlSourceId,
    pub ordinal: usize,
    pub name: Option<String>,
    pub code: Option<String>,
    pub description: Option<String>,
    pub declared_area: Option<f64>,
    pub declared_perimeter: Option<f64>,
    pub properties: LandXmlProperties,
    /// Each `CoordGeom` is a distinct legal boundary loop.
    pub loops: Vec<Vec<LandXmlPlanGeometry>>,
    pub labels: Vec<String>,
}

/// Whether a parcel can be probed without inventing a filled boundary.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LandXmlParcelState {
    Analytic,
    PreservedOnly { reason: String },
}

/// Measurements remain in the document's declared coordinate units.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlParcelProbe {
    pub state: LandXmlParcelState,
    pub perimeter_in_declared_linear_units: Option<f64>,
    pub area_in_declared_square_units: Option<f64>,
    pub declared_area: Option<f64>,
    pub declared_perimeter: Option<f64>,
}

/// Native-only source records awaiting the #5084 durable-document adapter.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlPlanDocument {
    pub version: String,
    pub units: Option<LandXmlUnits>,
    pub cogo_points: Vec<LandXmlCgPoint>,
    pub monuments: Vec<LandXmlMonument>,
    pub plan_features: Vec<LandXmlPlanFeature>,
    pub parcels: Vec<LandXmlParcel>,
    pub warnings: Vec<String>,
}
