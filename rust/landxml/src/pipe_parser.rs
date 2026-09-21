// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::{
    classify_landxml_version,
    preflight::preflight_xml_tokens,
    xml::{attr, attributes, error, normalize_encoding, split_name, Result},
    LandXmlCancellation, LandXmlDiagnosticCode as Code, LandXmlLimits, LandXmlPipeNetworkDocument,
    LandXmlPipeRefusal, LandXmlSourceId, LANDXML_12_NAMESPACE,
};
use quick_xml::{
    events::{BytesStart, Event},
    Reader,
};
use state::{
    properties, FeatureBuilder, Frame, NetworkBuilder, PipeBuilder, PositionCapture, RawUnits,
    StructureBuilder,
};
use std::collections::{HashMap, HashSet};
mod convert;
mod driver;
mod features;
mod finalize;
mod handlers;
mod inverts;
mod state;
mod units;
struct PipeParser<'a> {
    limits: &'a LandXmlLimits,
    cancelled: Option<&'a dyn LandXmlCancellation>,
    work: usize,
    character_references: usize,
    frames: Vec<Frame>,
    root_units: Option<RawUnits>,
    root_seen: bool,
    root_closed: bool,
    network: Option<NetworkBuilder>,
    structure: Option<StructureBuilder>,
    pipe: Option<PipeBuilder>,
    capture: Option<PositionCapture>,
    features_open: Vec<FeatureBuilder>,
    networks: Vec<crate::LandXmlPipeNetwork>,
    collections: Vec<crate::LandXmlPipeNetworkCollection>,
    features: Vec<crate::LandXmlPipeFeature>,
    pending_networks: Vec<NetworkBuilder>,
    refusals: Vec<LandXmlPipeRefusal>,
    refusal_keys: HashSet<(LandXmlSourceId, String)>,
    pipe_networks_seen: usize,
    structures_seen: usize,
    pipes_seen: usize,
    inverts_seen: usize,
    flows_seen: usize,
    points_seen: usize,
    references_seen: usize,
    pipe_network_collections: usize,
    network_ordinal: usize,
    feature_ordinals: HashMap<LandXmlSourceId, usize>,
}
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
    let input = normalize_encoding(input, limits, cancelled)?;
    preflight_xml_tokens(&input, limits, cancelled)?;
    let mut parser = PipeParser {
        limits,
        cancelled,
        work: 0,
        character_references: 0,
        frames: Vec::new(),
        root_units: None,
        root_seen: false,
        root_closed: false,
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
        refusal_keys: HashSet::new(),
        pipe_networks_seen: 0,
        structures_seen: 0,
        pipes_seen: 0,
        inverts_seen: 0,
        flows_seen: 0,
        points_seen: 0,
        references_seen: 0,
        pipe_network_collections: 0,
        network_ordinal: 0,
        feature_ordinals: HashMap::new(),
    };
    let mut reader = Reader::from_reader(input.as_slice());
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    loop {
        parser.check_cancel_and_work(1)?;
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|_| error(Code::InvalidXml, "malformed XML"))?;
        match event {
            Event::Start(start) => parser.start(&start)?,
            Event::Empty(start) => {
                parser.start(&start)?;
                parser.end(None)?;
            }
            Event::End(end) => parser.end(Some(end.name().as_ref().as_bytes()))?,
            Event::Text(text) => parser.text(text.as_ref().as_bytes())?,
            Event::CData(text) => parser.cdata(text.as_ref().as_bytes())?,
            Event::DocType(_) => return Err(error(Code::DtdForbidden, "DOCTYPE is not allowed")),
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    if !parser.frames.is_empty() || !parser.root_seen || !parser.root_closed {
        return Err(error(Code::InvalidXml, "unclosed XML element"));
    }
    parser.finish()
}

impl PipeParser<'_> {
    fn start(&mut self, start: &BytesStart<'_>) -> Result<()> {
        if self.frames.len() >= self.limits.max_depth {
            return Err(error(Code::LimitExceeded, "XML depth limit exceeded"));
        }
        let name = start.name();
        let (_, local, prefix) = split_name(name.as_ref().as_bytes(), self.limits.max_name_bytes)?;
        let (attributes, namespaces, references) = attributes(start, self.limits)?;
        self.check_cancel_and_work(attributes.len())?;
        self.check_character_references(references)?;
        let mut inherited = self
            .frames
            .last()
            .map_or_else(HashMap::new, |frame| frame.namespaces.clone());
        inherited.extend(namespaces);
        let namespace = inherited.get(prefix).map(String::as_str);
        if self.frames.is_empty() {
            if self.root_seen {
                return Err(error(
                    Code::InvalidXml,
                    "LandXML document has multiple roots",
                ));
            }
            if local != "LandXML" {
                return Err(error(Code::InvalidSemantic, "root element is not LandXML"));
            }
            match classify_landxml_version(namespace, attr(&attributes, "version")) {
                crate::LandXmlVersionCapability::LandXml12Tin => {}
                crate::LandXmlVersionCapability::NotLandXml => {
                    return Err(error(
                        Code::UnsupportedNamespace,
                        "root namespace is not a recognized LandXML namespace",
                    ));
                }
                _ => {
                    return Err(error(
                        Code::UnsupportedVersion,
                        "pipe ingestion requires LandXML 1.2",
                    ))
                }
            }
            self.root_seen = true;
        }
        let target = namespace == Some(LANDXML_12_NAMESPACE);
        self.frames.push(Frame {
            local: local.to_owned(),
            target,
            namespaces: inherited,
        });
        if let Some(capture) = self.capture.as_mut() {
            if self.frames.len() > capture.depth {
                capture
                    .invalid_reason
                    .get_or_insert_with(|| "Center must contain direct coordinates".to_owned());
            }
        }
        if !target {
            return Ok(());
        }
        let properties = properties(&attributes);
        match local {
            "PipeNetworks" if self.is_path(&["LandXML", "PipeNetworks"]) => {
                self.pipe_network_collections += 1;
                self.network_ordinal = 0;
                self.collections.push(crate::LandXmlPipeNetworkCollection {
                    source_id: LandXmlSourceId(format!(
                        "landxml:pipe-networks:{}",
                        self.pipe_network_collections
                    )),
                    source_path: format!("LandXML/PipeNetworks[{}]", self.pipe_network_collections),
                    properties,
                });
            }
            "PipeNetwork" if self.is_path(&["LandXML", "PipeNetworks", "PipeNetwork"]) => {
                Self::reserve(
                    &mut self.pipe_networks_seen,
                    self.limits.max_pipe_networks,
                    "pipe network",
                )?;
                self.network_ordinal += 1;
                if !matches!(
                    attr(&attributes, "pipeNetType"),
                    Some("water" | "storm" | "sanitary" | "other")
                ) {
                    return Err(error(
                        Code::InvalidSemantic,
                        "PipeNetwork has invalid pipeNetType",
                    ));
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
                    name: attr(&attributes, "name").map(str::to_owned),
                    pipe_network_type: attr(&attributes, "pipeNetType").map(str::to_owned),
                    properties,
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
            }
            "Feature" if self.feature_owner().is_some() => {
                let (owner_source_id, owner_path) = self.feature_owner().expect("checked owner");
                let ordinal = self
                    .feature_ordinals
                    .entry(owner_source_id.clone())
                    .or_insert(0);
                *ordinal += 1;
                let ordinal = *ordinal;
                self.features_open.push(FeatureBuilder {
                    source_id: LandXmlSourceId(format!("{}:feature:{ordinal}", owner_source_id.0)),
                    source_path: format!("{owner_path}/Feature[{ordinal}]"),
                    owner_source_id,
                    properties,
                    depth: self.frames.len(),
                });
            }
            "Property" if self.feature_property_path() => {
                if let Some(feature) = self.features_open.last_mut() {
                    let key = attr(&attributes, "label")
                        .or_else(|| attr(&attributes, "name"))
                        .ok_or_else(|| {
                            error(
                                Code::InvalidSemantic,
                                "Feature Property requires label or name",
                            )
                        })?;
                    feature.properties.insert(
                        key.to_owned(),
                        attr(&attributes, "value").unwrap_or_default().to_owned(),
                    );
                }
            }
            "Structs" if self.is_path(&["LandXML", "PipeNetworks", "PipeNetwork", "Structs"]) => {
                let network = self.network.as_mut().expect("Structs has network");
                network.structure_collection += 1;
                network.structures_in_collection = 0;
                network.structure_units = None;
                network.saw_structs = true;
            }
            "Pipes" if self.is_path(&["LandXML", "PipeNetworks", "PipeNetwork", "Pipes"]) => {
                let network = self.network.as_mut().expect("Pipes has network");
                network.pipe_collection += 1;
                network.pipes_in_collection = 0;
                network.pipe_units = None;
                network.saw_pipes = true;
            }
            "Struct"
                if self.is_path(&[
                    "LandXML",
                    "PipeNetworks",
                    "PipeNetwork",
                    "Structs",
                    "Struct",
                ]) =>
            {
                self.start_structure(properties, &attributes)?
            }
            "Pipe"
                if self.is_path(&["LandXML", "PipeNetworks", "PipeNetwork", "Pipes", "Pipe"]) =>
            {
                self.start_pipe(properties, &attributes)?
            }
            "Metric" | "Imperial" => self.record_units(properties)?,
            "Center" => self.start_center(&attributes)?,
            "Invert"
                if self.is_path(&[
                    "LandXML",
                    "PipeNetworks",
                    "PipeNetwork",
                    "Structs",
                    "Struct",
                    "Invert",
                ]) =>
            {
                self.start_invert(properties, &attributes)?
            }
            "PipeFlow"
                if self.is_path(&[
                    "LandXML",
                    "PipeNetworks",
                    "PipeNetwork",
                    "Pipes",
                    "Pipe",
                    "PipeFlow",
                ]) =>
            {
                self.start_flow(properties, &attributes, false)?
            }
            "StructFlow"
                if self.is_path(&[
                    "LandXML",
                    "PipeNetworks",
                    "PipeNetwork",
                    "Structs",
                    "Struct",
                    "StructFlow",
                ]) =>
            {
                self.start_flow(properties, &attributes, true)?
            }
            "CircPipe" | "ElliPipe" | "EggPipe" | "RectPipe" | "Channel" => {
                self.start_pipe_part(local, properties)?
            }
            "CircStruct" | "RectStruct" | "InletStruct" | "OutletStruct" | "Connection" => {
                self.start_structure_part(local, properties)?
            }
            _ => {}
        }
        Ok(())
    }

    fn is_path(&self, expected: &[&str]) -> bool {
        self.frames.len() == expected.len()
            && self
                .frames
                .iter()
                .zip(expected)
                .all(|(frame, local)| frame.target && frame.local == *local)
    }
}
