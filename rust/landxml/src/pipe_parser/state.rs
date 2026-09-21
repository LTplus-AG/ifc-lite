// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use std::collections::{HashMap, HashSet};

use crate::{
    LandXmlCancellation, LandXmlLimits, LandXmlPipeFeature, LandXmlPipeNetwork,
    LandXmlPipeNetworkCollection, LandXmlPipeProperties, LandXmlPipeRefusal, LandXmlSourceId,
};

/// Shared pipe-family semantic state. Both complete input and the resumable
/// driver deliver quick-xml events to this one machine.
pub(crate) struct PipeParser<'a> {
    pub(super) limits: LandXmlLimits,
    pub(super) cancelled: Option<&'a dyn LandXmlCancellation>,
    pub(super) require_pipe_networks: bool,
    pub(super) work: usize,
    pub(super) character_references: usize,
    pub(super) frames: Vec<Frame>,
    pub(super) root_units: Option<RawUnits>,
    pub(super) root_seen: bool,
    pub(super) root_closed: bool,
    pub(super) network: Option<NetworkBuilder>,
    pub(super) structure: Option<StructureBuilder>,
    pub(super) pipe: Option<PipeBuilder>,
    pub(super) capture: Option<PositionCapture>,
    pub(super) features_open: Vec<FeatureBuilder>,
    pub(super) networks: Vec<LandXmlPipeNetwork>,
    pub(super) collections: Vec<LandXmlPipeNetworkCollection>,
    pub(super) features: Vec<LandXmlPipeFeature>,
    pub(super) pending_networks: Vec<NetworkBuilder>,
    pub(super) refusals: Vec<LandXmlPipeRefusal>,
    pub(super) refusal_keys: HashSet<(LandXmlSourceId, String)>,
    pub(super) pipe_networks_seen: usize,
    pub(super) structures_seen: usize,
    pub(super) pipes_seen: usize,
    pub(super) inverts_seen: usize,
    pub(super) flows_seen: usize,
    pub(super) points_seen: usize,
    pub(super) references_seen: usize,
    pub(super) pipe_network_collections: usize,
    pub(super) network_ordinal: usize,
    pub(super) feature_ordinals: HashMap<LandXmlSourceId, usize>,
}

#[derive(Clone)]
pub(super) struct Frame {
    pub(super) local: String,
    pub(super) target: bool,
    pub(super) namespaces: HashMap<String, String>,
}

pub(super) fn properties(attributes: &[(String, String)]) -> LandXmlPipeProperties {
    attributes.iter().cloned().collect()
}

pub(super) struct NetworkBuilder {
    pub(super) source_id: LandXmlSourceId,
    pub(super) source_path: String,
    pub(super) name: Option<String>,
    pub(super) pipe_network_type: Option<String>,
    pub(super) properties: LandXmlPipeProperties,
    pub(super) structure_units: Option<RawUnits>,
    pub(super) pipe_units: Option<RawUnits>,
    pub(super) structures: Vec<StructureBuilder>,
    pub(super) pipes: Vec<PipeBuilder>,
    pub(super) structure_ordinal: usize,
    pub(super) pipe_ordinal: usize,
    pub(super) structure_collection: usize,
    pub(super) pipe_collection: usize,
    pub(super) structures_in_collection: usize,
    pub(super) pipes_in_collection: usize,
    pub(super) saw_structs: bool,
    pub(super) saw_pipes: bool,
    pub(super) features: Vec<crate::LandXmlPipeFeature>,
}

pub(super) struct FeatureBuilder {
    pub(super) source_id: LandXmlSourceId,
    pub(super) source_path: String,
    pub(super) owner_source_id: LandXmlSourceId,
    pub(super) properties: LandXmlPipeProperties,
    /// Stack depth of this exact Feature frame. Nested or foreign Features
    /// must never close the feature below them.
    pub(super) depth: usize,
}

#[derive(Clone)]
pub(super) struct RawUnits {
    pub(super) properties: LandXmlPipeProperties,
}

pub(super) struct PositionInput {
    pub(super) text: String,
    pub(super) pnt_ref: Option<String>,
}

pub(super) struct StructureBuilder {
    pub(super) source_id: LandXmlSourceId,
    pub(super) source_path: String,
    pub(super) name: Option<String>,
    pub(super) properties: LandXmlPipeProperties,
    pub(super) units: Option<RawUnits>,
    pub(super) center: Option<PositionInput>,
    pub(super) part: Option<PartInput>,
    pub(super) inverts: Vec<InvertInput>,
    pub(super) flow: Option<FlowInput>,
    pub(super) invert_ordinal: usize,
    pub(super) invalid_reason: Option<String>,
}

pub(super) struct PipeBuilder {
    pub(super) source_id: LandXmlSourceId,
    pub(super) source_path: String,
    pub(super) name: Option<String>,
    pub(super) start_ref: Option<String>,
    pub(super) end_ref: Option<String>,
    pub(super) properties: LandXmlPipeProperties,
    pub(super) units: Option<RawUnits>,
    pub(super) part: Option<PartInput>,
    pub(super) center: Option<PositionInput>,
    pub(super) flow: Option<FlowInput>,
    pub(super) invalid_reason: Option<String>,
}

pub(super) enum PartInput {
    Circ { properties: LandXmlPipeProperties },
    Elli { properties: LandXmlPipeProperties },
    Egg { properties: LandXmlPipeProperties },
    Rect { properties: LandXmlPipeProperties },
    Channel,
    StructCirc { properties: LandXmlPipeProperties },
    StructRect { properties: LandXmlPipeProperties },
    Inlet { properties: LandXmlPipeProperties },
    Outlet { properties: LandXmlPipeProperties },
    Connection { properties: LandXmlPipeProperties },
}

pub(super) struct InvertInput {
    pub(super) source_id: LandXmlSourceId,
    pub(super) source_path: String,
    pub(super) pipe_ref: Option<String>,
    pub(super) flow_direction: Option<String>,
    pub(super) elevation: Option<String>,
    pub(super) properties: LandXmlPipeProperties,
}

pub(super) struct FlowInput {
    pub(super) kind: FlowKind,
    pub(super) source_id: LandXmlSourceId,
    pub(super) source_path: String,
    pub(super) flow_in: Option<String>,
    pub(super) loss_in: Option<String>,
    pub(super) loss_out: Option<String>,
    pub(super) properties: LandXmlPipeProperties,
}

pub(super) enum FlowKind {
    Structure,
    Pipe,
}

pub(super) enum CaptureOwner {
    Structure,
    Pipe,
}

pub(super) struct PositionCapture {
    pub(super) depth: usize,
    pub(super) owner: CaptureOwner,
    pub(super) input: PositionInput,
    /// Coordinate elements are text-only. Keep this refusal local to the
    /// owning pipe/structure so one bad record cannot discard a network.
    pub(super) invalid_reason: Option<String>,
}
