/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::{
    cell::RefCell,
    collections::{BTreeMap, HashMap},
};

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
    Coordinates {
        point: LandXmlPlanPoint,
        /// A legal `pntRef` retained alongside authored coordinates. Numeric
        /// consumers use the coordinates; the reference remains inspectable.
        pnt_ref: Option<String>,
    },
    PointReference {
        pnt_ref: String,
    },
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
    pub point: Option<LandXmlPlanPoint>,
    pub pnt_ref: Option<String>,
    pub properties: LandXmlProperties,
}

/// Lookup tables are built while parsing, so reference resolution never scans
/// every COGO point for each endpoint or alias hop.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct LandXmlPlanReferenceIndex {
    pub(crate) scoped: HashMap<(LandXmlSourceId, String), Option<ReferenceTarget>>,
    pub(crate) global: HashMap<String, Option<ReferenceTarget>>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ReferenceTarget {
    pub(crate) index: usize,
    pub(crate) source_id: LandXmlSourceId,
}

impl LandXmlPlanReferenceIndex {
    pub(crate) fn insert(&mut self, point: &LandXmlCgPoint) {
        self.insert_at(point, point.ordinal.saturating_sub(1));
    }

    fn insert_at(&mut self, point: &LandXmlCgPoint, index: usize) {
        // `pntRef` is an authored COGO identity, not an implementation
        // source-id or a record ordinal. Accepting synthetic provenance here
        // would allow a display name to collide with an internal id.
        let mut keys = Vec::new();
        if let Some(name) = &point.name {
            keys.push(name.clone());
        }
        if let Some(oid) = point.properties.get("oID") {
            keys.push(oid.clone());
        }
        keys.sort();
        keys.dedup();
        let target = ReferenceTarget {
            index,
            source_id: point.source_id.clone(),
        };
        for key in keys {
            self.scoped
                .entry((point.scope_id.clone(), key.clone()))
                .and_modify(|slot| *slot = None)
                .or_insert(Some(target.clone()));
            self.global
                .entry(key)
                .and_modify(|slot| *slot = None)
                .or_insert(Some(target.clone()));
        }
    }

    pub(crate) fn from_points_checked<E>(
        points: &[LandXmlCgPoint],
        mut check: impl FnMut() -> std::result::Result<(), E>,
    ) -> std::result::Result<Self, E> {
        let mut index = Self::default();
        for (position, point) in points.iter().enumerate() {
            check()?;
            index.insert_at(point, position);
        }
        Ok(index)
    }
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
    pub locations: Vec<LandXmlPlanPointLocation>,
    pub geometry: Vec<LandXmlPlanGeometry>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlParcel {
    pub source_id: LandXmlSourceId,
    pub ordinal: usize,
    pub name: Option<String>,
    pub code: Option<String>,
    pub description: Option<String>,
    pub title: Option<String>,
    pub declared_area: Option<f64>,
    pub declared_perimeter: Option<f64>,
    pub declared_area_unit: Option<String>,
    pub properties: LandXmlProperties,
    /// Each `CoordGeom` is a distinct legal boundary loop.
    pub loops: Vec<Vec<LandXmlPlanGeometry>>,
    /// Set when a source primitive is malformed. The parcel remains
    /// inspectable but is never promoted to a filled analytic boundary.
    pub preservation_reason: Option<String>,
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
    pub perimeter_in_meters: Option<f64>,
    pub area_in_square_meters: Option<f64>,
}

/// Bounded source identifiers for host-side navigation and batching.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlPlanSourceBatch {
    pub source_ids: Vec<LandXmlSourceId>,
}

/// Durable COGO and plan records joined to the canonical LandXML document.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlPlanDocument {
    pub version: String,
    pub units: Option<LandXmlUnits>,
    pub area_unit: Option<String>,
    pub area_scale_to_square_meters: Option<f64>,
    pub(crate) cogo_points: Vec<LandXmlCgPoint>,
    pub monuments: Vec<LandXmlMonument>,
    pub plan_features: Vec<LandXmlPlanFeature>,
    pub parcels: Vec<LandXmlParcel>,
    pub warnings: Vec<String>,
    /// `None` only after deserialization; an empty index is still a completed
    /// cache for a source with no COGO points.
    #[serde(skip)]
    pub(crate) reference_index: RefCell<Option<LandXmlPlanReferenceIndex>>,
}

impl LandXmlPlanDocument {
    /// Split finalized plan metadata into move-owned stream records.
    pub(crate) fn into_stream_parts(self) -> crate::stream::metadata::PlanStreamParts {
        crate::stream::metadata::PlanStreamParts::new(self)
    }

    /// COGO records are immutable through this view so the derived resolver
    /// index cannot become stale behind a public `Vec` mutation.
    pub fn cogo_points(&self) -> &[LandXmlCgPoint] {
        &self.cogo_points
    }

    /// Replace authored COGO records and invalidate their resolver index.
    pub fn replace_cogo_points(&mut self, cogo_points: Vec<LandXmlCgPoint>) {
        self.cogo_points = cogo_points;
        *self.reference_index.get_mut() = None;
    }
}
