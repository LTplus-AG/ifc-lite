// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::{
    xml::{attr, drive, error, normalize_encoding, Attributes, Budget, Cx, Element, FamilyHandler, Meter, Result},
    LandXmlCancellation, LandXmlDiagnosticCode as Code, LandXmlLimits, LandXmlPipeNetworkDocument,
    LandXmlSourceId,
};
pub(crate) use state::PipeHandler;
use state::{properties, FeatureBuilder, NetworkBuilder};
use std::collections::{HashMap, HashSet};
mod convert;
mod driver;
mod features;
mod finalize;
mod handlers;
mod inverts;
mod state;
mod units;
/// Parse exact LandXML 1.2 pipe networks with default resource limits.
/// This native source parser exposes no renderer, WASM, or invented IFC path.
pub fn parse_landxml_pipe_networks(input: &[u8]) -> Result<LandXmlPipeNetworkDocument> {
    parse_landxml_pipe_networks_with_cancel(input, &LandXmlLimits::default(), None)
}
/// Parse exact LandXML 1.2 pipe networks with host limits and cancellation.
pub fn parse_landxml_pipe_networks_with_cancel(
    input: &[u8],
    limits: &LandXmlLimits,
    cancelled: Option<&dyn LandXmlCancellation>,
) -> Result<LandXmlPipeNetworkDocument> {
    if input.len() > limits.max_bytes {
        return Err(error(Code::InputTooLarge, "input exceeds byte limit"));
    }
    // #5175 / EDGE-LXPARSE-7 (#7693): refuse a bad override token before
    // any XML is read. The validated token is applied from `limits` when the
    // root units are resolved (`effective_root_units`).
    crate::semantics::resolve_assumed_units(limits)?;
    let input = normalize_encoding(input, limits, cancelled)?;
    let meter = Meter::new(limits.max_work, cancelled);
    let mut handler = PipeHandler::new(limits, meter.clone(), true);
    drive(&input, limits, cancelled, meter, &mut [&mut handler])?;
    handler.finish_stream()
}

impl<'a> PipeHandler<'a> {
    pub(crate) fn new(limits: &LandXmlLimits, meter: Meter<'a>, require_pipe_networks: bool) -> Self {
        Self {
            limits: limits.clone(),
            require_pipe_networks,
            meter,
            capability_diagnostics_seen: Budget::new(limits.max_capability_diagnostics, "capability diagnostic"),
            root_units: None,
            schema: String::new(),
            version: String::new(),
            capability_diagnostics: Vec::new(),
            network: None,
            structure: None,
            pipe: None,
            capture: None,
            features_open: Vec::new(),
            networks: Vec::new(),
            collections: Vec::new(),
            features: Vec::new(),
            pending_networks: Vec::new(),
            refusals: Vec::new(),
            preflight_refusal_batches: Vec::new(),
            refusal_keys: HashSet::new(),
            pipe_networks_seen: Budget::new(limits.max_pipe_networks, "pipe network"),
            structures_seen: Budget::new(limits.max_pipe_structures, "pipe structure"),
            pipes_seen: Budget::new(limits.max_pipes, "pipe"),
            inverts_seen: Budget::new(limits.max_pipe_inverts, "pipe invert"),
            flows_seen: Budget::new(limits.max_pipe_flows, "pipe flow"),
            points_seen: Budget::new(limits.max_points, "pipe Center point"),
            references_seen: Budget::new(limits.max_references, "pipe reference"),
            pipe_network_collections: 0,
            network_ordinal: 0,
            feature_ordinals: HashMap::new(),
        }
    }

    /// Take what the driver validated at the document element.
    fn open_root(&mut self, cx: &Cx<'_>) -> Result<()> {
        self.schema = cx.root.schema.clone();
        if let Some(diagnostic) = cx.root.diagnostic.clone() {
            self.record_capability_diagnostic(diagnostic)?;
        }
        self.version = cx.root.version.clone();
        Ok(())
    }
}

impl FamilyHandler for PipeHandler<'_> {
    fn start(&mut self, cx: &Cx<'_>, element: &Element<'_>) -> Result<()> {
        if element.depth == 1 {
            self.open_root(cx)?;
        }
        // Markup inside a Center refuses that record, not the document.
        if let Some(capture) = self.capture.as_mut() {
            if element.depth > capture.depth {
                capture
                    .invalid_reason
                    .get_or_insert_with(|| "Center must contain direct coordinates".to_owned());
            }
        }
        if !element.target {
            return Ok(());
        }
        self.start_target(cx, element.local, element.attributes)
    }

    fn end(&mut self, cx: &Cx<'_>) -> Result<()> {
        self.end_element(cx)
    }

    fn text(&mut self, _cx: &Cx<'_>, text: &str) -> Result<()> {
        self.capture_decoded(text)
    }

    fn capture_depth(&self) -> Option<usize> {
        self.capture.as_ref().map(|capture| capture.depth)
    }
}

impl PipeHandler<'_> {
    fn start_target(&mut self, cx: &Cx<'_>, local: &str, attributes: &Attributes) -> Result<()> {
        // Record properties are built only by the arm that keeps them
        // (EDGE-LXPARSE-15): most elements are not records.
        match local {
            "PipeNetworks" if cx.path_is(&["LandXML", "PipeNetworks"]) => self.start_collection(attributes),
            "PipeNetwork" if cx.path_is(&["LandXML", "PipeNetworks", "PipeNetwork"]) => self.start_network(attributes)?,
            "Feature" if self.feature_owner(cx).is_some() => self.start_feature(cx, attributes),
            "Property" if self.feature_property_path(cx) => self.add_feature_property(attributes)?,
            "Structs" if cx.path_is(&["LandXML", "PipeNetworks", "PipeNetwork", "Structs"]) => {
                let network = self.network.as_mut().expect("Structs has network");
                network.structure_collection += 1;
                network.structures_in_collection = 0;
                network.structure_units = None;
                network.saw_structs = true;
            }
            "Pipes" if cx.path_is(&["LandXML", "PipeNetworks", "PipeNetwork", "Pipes"]) => {
                let network = self.network.as_mut().expect("Pipes has network");
                network.pipe_collection += 1;
                network.pipes_in_collection = 0;
                network.pipe_units = None;
                network.saw_pipes = true;
            }
            "Struct" if cx.path_is(&["LandXML", "PipeNetworks", "PipeNetwork", "Structs", "Struct"]) => {
                self.start_structure(properties(attributes), attributes)?
            }
            "Pipe" if cx.path_is(&["LandXML", "PipeNetworks", "PipeNetwork", "Pipes", "Pipe"]) => {
                self.start_pipe(properties(attributes), attributes)?
            }
            "Metric" | "Imperial" => self.record_units(cx, properties(attributes))?,
            "Center" => self.start_center(cx, attributes)?,
            "Invert" if cx.path_is(&["LandXML", "PipeNetworks", "PipeNetwork", "Structs", "Struct", "Invert"]) => {
                self.start_invert(properties(attributes), attributes)?
            }
            "PipeFlow" if cx.path_is(&["LandXML", "PipeNetworks", "PipeNetwork", "Pipes", "Pipe", "PipeFlow"]) => {
                self.start_flow(properties(attributes), attributes, false)?
            }
            "StructFlow"
                if cx.path_is(&["LandXML", "PipeNetworks", "PipeNetwork", "Structs", "Struct", "StructFlow"]) =>
            {
                self.start_flow(properties(attributes), attributes, true)?
            }
            "CircPipe" | "ElliPipe" | "EggPipe" | "RectPipe" | "Channel" => {
                self.start_pipe_part(cx, local, attributes)?
            }
            "CircStruct" | "RectStruct" | "InletStruct" | "OutletStruct" | "Connection" => {
                self.start_structure_part(cx, local, attributes)?
            }
            _ => {}
        }
        Ok(())
    }

    fn start_collection(&mut self, attributes: &Attributes) {
        self.pipe_network_collections += 1;
        self.network_ordinal = 0;
        self.collections.push(crate::LandXmlPipeNetworkCollection {
            source_id: LandXmlSourceId(format!("landxml:pipe-networks:{}", self.pipe_network_collections)),
            source_path: format!("LandXML/PipeNetworks[{}]", self.pipe_network_collections),
            properties: properties(attributes),
        });
    }

    fn start_network(&mut self, attributes: &Attributes) -> Result<()> {
        self.pipe_networks_seen.reserve(1)?;
        self.network_ordinal += 1;
        if !matches!(attr(attributes, "pipeNetType"), Some("water" | "storm" | "sanitary" | "other")) {
            return Err(error(Code::InvalidSemantic, "PipeNetwork has invalid pipeNetType"));
        }
        let source_path = format!(
            "LandXML/PipeNetworks[{}]/PipeNetwork[{}]",
            self.pipe_network_collections, self.network_ordinal
        );
        self.network = Some(NetworkBuilder {
            source_id: LandXmlSourceId(format!(
                "landxml:pipe-network:{}:{}",
                self.pipe_network_collections, self.network_ordinal
            )),
            source_path,
            name: attr(attributes, "name").map(str::to_owned),
            pipe_network_type: attr(attributes, "pipeNetType").map(str::to_owned),
            properties: properties(attributes),
            structure_units: None,
            pipe_units: None,
            structures: Vec::new(),
            pipes: Vec::new(),
            structure_ordinal: 0,
            pipe_ordinal: 0,
            structure_collection: 0,
            pipe_collection: 0,
            structures_in_collection: 0,
            pipes_in_collection: 0,
            saw_structs: false,
            saw_pipes: false,
            features: Vec::new(),
        });
        Ok(())
    }

    fn start_feature(&mut self, cx: &Cx<'_>, attributes: &Attributes) {
        let (owner_source_id, owner_path) = self.feature_owner(cx).expect("checked owner");
        let ordinal = self.feature_ordinals.entry(owner_source_id.clone()).or_insert(0);
        *ordinal += 1;
        let ordinal = *ordinal;
        self.features_open.push(FeatureBuilder {
            source_id: LandXmlSourceId(format!("{}:feature:{ordinal}", owner_source_id.0)),
            source_path: format!("{owner_path}/Feature[{ordinal}]"),
            owner_source_id,
            properties: properties(attributes),
            depth: cx.frames().len(),
        });
    }

    fn add_feature_property(&mut self, attributes: &Attributes) -> Result<()> {
        if let Some(feature) = self.features_open.last_mut() {
            let key = attr(attributes, "label")
                .or_else(|| attr(attributes, "name"))
                .ok_or_else(|| error(Code::InvalidSemantic, "Feature Property requires label or name"))?;
            feature
                .properties
                .insert(key.to_owned(), attr(attributes, "value").unwrap_or_default().to_owned());
        }
        Ok(())
    }
}
