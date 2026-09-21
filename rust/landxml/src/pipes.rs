// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Durable LandXML pipe-network source records.
//!
//! These are source semantics only.  They deliberately do not imply an IFC
//! mapping, hydraulic analysis, or a renderer representation.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{LandXmlDiagnosticCode, LandXmlSourceId};

pub type LandXmlPipeProperties = BTreeMap<String, String>;

/// A finite authored measurement and the source unit used to make it useful.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlPipeMeasure {
    pub value: f64,
    pub unit: String,
    pub meters: f64,
}

/// The length units effective for one pipe-network collection.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlPipeUnits {
    pub linear_unit: String,
    pub elevation_unit: String,
    pub diameter_unit: String,
    pub width_unit: String,
    pub height_unit: String,
    /// Optional authored unit for `PipeFlow` and `StructFlow` quantities.
    pub flow_unit: Option<String>,
    pub linear_scale_to_meters: f64,
    pub elevation_scale_to_meters: f64,
    pub diameter_scale_to_meters: f64,
    pub width_scale_to_meters: f64,
    pub height_scale_to_meters: f64,
}

/// A coordinate authored directly in a pipe-network `Center` element.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlPipePosition {
    pub northing: f64,
    pub easting: f64,
    pub northing_meters: f64,
    pub easting_meters: f64,
    pub elevation: Option<LandXmlPipeMeasure>,
}

/// The declared cross-section part of a pipe.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LandXmlPipePart {
    Circular {
        properties: LandXmlPipeProperties,
        diameter: LandXmlPipeMeasure,
        thickness: Option<LandXmlPipeMeasure>,
        material: Option<String>,
    },
    Elliptical {
        properties: LandXmlPipeProperties,
        span: LandXmlPipeMeasure,
        height: LandXmlPipeMeasure,
        thickness: Option<LandXmlPipeMeasure>,
        material: Option<String>,
    },
    Egg {
        properties: LandXmlPipeProperties,
        span: LandXmlPipeMeasure,
        height: LandXmlPipeMeasure,
        thickness: Option<LandXmlPipeMeasure>,
        material: Option<String>,
    },
    Rectangular {
        properties: LandXmlPipeProperties,
        width: LandXmlPipeMeasure,
        height: LandXmlPipeMeasure,
        thickness: Option<LandXmlPipeMeasure>,
        material: Option<String>,
    },
}

/// The declared part of a structure.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LandXmlStructurePart {
    Circular {
        properties: LandXmlPipeProperties,
        diameter: LandXmlPipeMeasure,
        thickness: Option<LandXmlPipeMeasure>,
        material: Option<String>,
    },
    Rectangular {
        properties: LandXmlPipeProperties,
        length: LandXmlPipeMeasure,
        width: LandXmlPipeMeasure,
        thickness: Option<LandXmlPipeMeasure>,
        material: Option<String>,
    },
    Inlet {
        properties: LandXmlPipeProperties,
    },
    Outlet {
        properties: LandXmlPipeProperties,
    },
    Connection {
        properties: LandXmlPipeProperties,
    },
}

/// The direction-specific invert belonging to a structure and pipe.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlPipeInvert {
    pub source_id: LandXmlSourceId,
    pub source_path: String,
    pub pipe_source_id: LandXmlSourceId,
    pub flow_direction: String,
    pub elevation: LandXmlPipeMeasure,
    pub properties: LandXmlPipeProperties,
}

/// Preserved flow attributes; the parser does not derive hydraulic results.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlPipeFlow {
    pub source_id: LandXmlSourceId,
    pub source_path: String,
    pub unit: Option<String>,
    pub flow_in: Option<f64>,
    pub loss_in: Option<f64>,
    pub loss_out: Option<f64>,
    pub properties: LandXmlPipeProperties,
}

/// One structure in source order, with source-to-pipe invert provenance.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlPipeStructure {
    pub source_id: LandXmlSourceId,
    pub source_path: String,
    pub name: String,
    pub properties: LandXmlPipeProperties,
    /// Units effective at this record's exact `Structs` collection position.
    pub units: LandXmlPipeUnits,
    pub center: LandXmlPipePosition,
    pub part: LandXmlStructurePart,
    pub rim_elevation: Option<LandXmlPipeMeasure>,
    pub sump_elevation: Option<LandXmlPipeMeasure>,
    pub inverts: Vec<LandXmlPipeInvert>,
    pub flow: Option<LandXmlPipeFlow>,
}

/// A pipe's graph edge after `refStart` and `refEnd` resolve to source nodes.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LandXmlPipeConnectivity {
    pub start_structure_source_id: LandXmlSourceId,
    pub end_structure_source_id: LandXmlSourceId,
}

/// A direct point along the declared pipe route.
///
/// LandXML's `Pipe/Center` is a route pass-through point. It is not evidence
/// of a circular arc, so this source model does not invent a radius or curve.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LandXmlPipeGeometry {
    Straight,
    PassThrough { point: LandXmlPipePosition },
}

/// One validated graph edge in a pipe network.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlPipe {
    pub source_id: LandXmlSourceId,
    pub source_path: String,
    pub name: String,
    pub properties: LandXmlPipeProperties,
    /// Units effective at this record's exact `Pipes` collection position.
    pub units: LandXmlPipeUnits,
    pub connectivity: LandXmlPipeConnectivity,
    pub part: LandXmlPipePart,
    pub geometry: LandXmlPipeGeometry,
    pub length: Option<LandXmlPipeMeasure>,
    pub flow: Option<LandXmlPipeFlow>,
}

/// A semantic refusal for a single source element, not a fabricated fallback.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LandXmlPipeRefusal {
    pub source_id: LandXmlSourceId,
    pub source_path: String,
    pub code: LandXmlDiagnosticCode,
    pub message: String,
}

/// A schema-valid `Feature` child retained without assigning IFC meaning.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlPipeFeature {
    pub source_id: LandXmlSourceId,
    pub source_path: String,
    pub owner_source_id: LandXmlSourceId,
    pub properties: LandXmlPipeProperties,
}

/// One exact `PipeNetworks` collection and its authored metadata.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlPipeNetworkCollection {
    pub source_id: LandXmlSourceId,
    pub source_path: String,
    pub properties: LandXmlPipeProperties,
}

/// One exact LandXML `PipeNetwork` source hierarchy.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlPipeNetwork {
    pub source_id: LandXmlSourceId,
    pub source_path: String,
    pub name: String,
    pub pipe_network_type: String,
    pub properties: LandXmlPipeProperties,
    pub features: Vec<LandXmlPipeFeature>,
    pub structure_units: Option<LandXmlPipeUnits>,
    pub pipe_units: Option<LandXmlPipeUnits>,
    pub structures: Vec<LandXmlPipeStructure>,
    pub pipes: Vec<LandXmlPipe>,
}

/// Pipe-network semantic result. It is intentionally independent from TIN.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LandXmlPipeNetworkDocument {
    /// Namespace-selected grammar used to parse this source, independent from
    /// the producer's declared version string.
    pub schema: String,
    pub version: String,
    /// Compatibility observations retained for direct pipe-parser consumers.
    pub capability_diagnostics: Vec<crate::LandXmlCapabilityDiagnostic>,
    pub root_units: Option<LandXmlPipeUnits>,
    pub collections: Vec<LandXmlPipeNetworkCollection>,
    /// Features authored at any schema-valid pipe-network owner.
    pub features: Vec<LandXmlPipeFeature>,
    pub networks: Vec<LandXmlPipeNetwork>,
    pub refusals: Vec<LandXmlPipeRefusal>,
}

impl LandXmlPipeNetworkDocument {
    /// Split finalized pipe metadata into move-owned stream records.
    pub(crate) fn into_stream_parts(self) -> crate::stream::metadata::PipeStreamParts {
        crate::stream::metadata::PipeStreamParts::new(self)
    }
}

/// Stable source identities prepared for a future canonical LandXML adapter.
///
/// This deliberately batches semantics only: it creates neither renderer
/// geometry nor a parallel model-loading path while the #5084 adapter remains
/// the integration owner.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LandXmlPipeSourceBatch {
    pub source_ids: Vec<LandXmlSourceId>,
}

impl LandXmlPipeNetworkDocument {
    /// Partition source identities without binding them to a renderer, WASM
    /// surface, or invented IFC representation.
    pub fn source_batches(&self, max_records: usize) -> Vec<LandXmlPipeSourceBatch> {
        if max_records == 0 {
            return Vec::new();
        }
        let source_ids = self
            .collections
            .iter()
            .map(|collection| collection.source_id.clone())
            .chain(
                self.features
                    .iter()
                    .map(|feature| feature.source_id.clone()),
            )
            .chain(self.networks.iter().flat_map(|network| {
                std::iter::once(network.source_id.clone())
                    .chain(network.structures.iter().flat_map(|structure| {
                        std::iter::once(structure.source_id.clone())
                            .chain(
                                structure
                                    .inverts
                                    .iter()
                                    .map(|invert| invert.source_id.clone()),
                            )
                            .chain(structure.flow.iter().map(|flow| flow.source_id.clone()))
                    }))
                    .chain(network.pipes.iter().flat_map(|pipe| {
                        std::iter::once(pipe.source_id.clone())
                            .chain(pipe.flow.iter().map(|flow| flow.source_id.clone()))
                    }))
            }));
        let mut batches = Vec::new();
        let mut current = Vec::new();
        for source_id in source_ids {
            current.push(source_id);
            if current.len() == max_records {
                batches.push(LandXmlPipeSourceBatch {
                    source_ids: current,
                });
                current = Vec::new();
            }
        }
        if !current.is_empty() {
            batches.push(LandXmlPipeSourceBatch {
                source_ids: current,
            });
        }
        batches
    }
}
