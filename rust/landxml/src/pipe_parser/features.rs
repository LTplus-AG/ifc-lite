// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::LandXmlSourceId;

use super::PipeParser;

impl PipeParser<'_> {
    pub(super) fn feature_owner(&self) -> Option<(LandXmlSourceId, String)> {
        if self.is_path(&["LandXML", "PipeNetworks", "Feature"]) {
            return self
                .collections
                .last()
                .map(|collection| (collection.source_id.clone(), collection.source_path.clone()));
        }
        if self.is_path(&["LandXML", "PipeNetworks", "PipeNetwork", "Feature"]) {
            return self
                .network
                .as_ref()
                .map(|network| (network.source_id.clone(), network.source_path.clone()));
        }
        if self.is_path(&[
            "LandXML",
            "PipeNetworks",
            "PipeNetwork",
            "Structs",
            "Struct",
            "Feature",
        ]) {
            return self
                .structure
                .as_ref()
                .map(|structure| (structure.source_id.clone(), structure.source_path.clone()));
        }
        if self.is_path(&[
            "LandXML",
            "PipeNetworks",
            "PipeNetwork",
            "Pipes",
            "Pipe",
            "Feature",
        ]) {
            return self
                .pipe
                .as_ref()
                .map(|pipe| (pipe.source_id.clone(), pipe.source_path.clone()));
        }
        None
    }

    pub(super) fn feature_property_path(&self) -> bool {
        self.feature.is_some()
            && self.frames.len() >= 2
            && self.frames[self.frames.len() - 2].target
            && self.frames[self.frames.len() - 2].local == "Feature"
            && self
                .frames
                .last()
                .is_some_and(|frame| frame.target && frame.local == "Property")
    }
}
