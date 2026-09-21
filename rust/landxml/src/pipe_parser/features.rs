// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::LandXmlSourceId;

use super::PipeParser;

impl PipeParser<'_> {
    pub(super) fn feature_owner(&self) -> Option<(LandXmlSourceId, String)> {
        // Namespace validity is an ancestry property. A target-named child
        // below a foreign namespace boundary is not a LandXML Feature.
        if !self.frames.iter().all(|frame| frame.target) {
            return None;
        }
        if self.frames.len() < 3
            || self.frames[0].local != "LandXML"
            || self.frames[1].local != "PipeNetworks"
        {
            return None;
        }
        let parent = self.frames.get(self.frames.len().saturating_sub(2))?.local.as_str();
        if parent == "Feature"
            && self.features_open.last().is_some_and(|feature| feature.depth + 1 == self.frames.len())
        {
            let feature = self.features_open.last().expect("checked active Feature");
            return Some((feature.source_id.clone(), feature.source_path.clone()));
        }
        if let Some(pipe) = self.pipe.as_ref() {
            if matches!(parent, "CircPipe" | "ElliPipe" | "EggPipe" | "RectPipe" | "Channel" | "PipeFlow") {
                let suffix = parent.to_ascii_lowercase();
                return Some((
                    LandXmlSourceId(format!("{}:{suffix}", pipe.source_id.0)),
                    format!("{}/{}", pipe.source_path, parent),
                ));
            }
            if parent == "Pipe" {
                return Some((pipe.source_id.clone(), pipe.source_path.clone()));
            }
            return None;
        }
        if let Some(structure) = self.structure.as_ref() {
            if matches!(parent, "CircStruct" | "RectStruct" | "InletStruct" | "OutletStruct" | "Connection" | "StructFlow") {
                let suffix = parent.to_ascii_lowercase();
                return Some((
                    LandXmlSourceId(format!("{}:{suffix}", structure.source_id.0)),
                    format!("{}/{}", structure.source_path, parent),
                ));
            }
            if parent == "Struct" {
                return Some((structure.source_id.clone(), structure.source_path.clone()));
            }
            return None;
        }
        if let Some(network) = self.network.as_ref() {
            if parent == "Structs" {
                return Some((
                    LandXmlSourceId(format!("{}:structs:{}", network.source_id.0, network.structure_collection)),
                    format!("{}/Structs[{}]", network.source_path, network.structure_collection),
                ));
            }
            if parent == "Pipes" {
                return Some((
                    LandXmlSourceId(format!("{}:pipes:{}", network.source_id.0, network.pipe_collection)),
                    format!("{}/Pipes[{}]", network.source_path, network.pipe_collection),
                ));
            }
            if parent == "PipeNetwork" {
                return Some((network.source_id.clone(), network.source_path.clone()));
            }
            return None;
        }
        if parent == "PipeNetworks" {
            return self.collections
                .last()
                .map(|collection| (collection.source_id.clone(), collection.source_path.clone()));
        }
        None
    }

    pub(super) fn feature_property_path(&self) -> bool {
        self.features_open.last().is_some_and(|feature| feature.depth + 1 == self.frames.len())
            && self.frames.len() >= 2
            && self.frames.iter().all(|frame| frame.target)
            && self.frames[self.frames.len() - 2].local == "Feature"
            && self
                .frames
                .last()
                .is_some_and(|frame| frame.target && frame.local == "Property")
    }
}
