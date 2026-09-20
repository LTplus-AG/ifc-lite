// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use std::collections::HashMap;

use crate::{LandXmlPipeProperties, LandXmlSourceId};

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
    pub(super) source_id: LandXmlSourceId,
    pub(super) source_path: String,
    pub(super) flow_in: Option<String>,
    pub(super) loss_in: Option<String>,
    pub(super) loss_out: Option<String>,
    pub(super) properties: LandXmlPipeProperties,
}

pub(super) enum CaptureOwner {
    Structure,
    Pipe,
}

pub(super) struct PositionCapture {
    pub(super) depth: usize,
    pub(super) owner: CaptureOwner,
    pub(super) input: PositionInput,
}
