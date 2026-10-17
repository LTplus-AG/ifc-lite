// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::xml::{error, Cx, Result};
use crate::LandXmlDiagnosticCode as Code;

use super::PipeHandler;

impl PipeHandler<'_> {
    pub(super) fn end_element(&mut self, cx: &Cx<'_>) -> Result<()> {
        let depth = cx.frames().len();
        let frame = cx.frames().last().expect("an element is closing");
        if self
            .capture
            .as_ref()
            .is_some_and(|capture| capture.depth == depth)
        {
            self.finish_center()?;
        }
        if frame.target
            && &*frame.local == "Feature"
            && self.features_open.last().is_some_and(|feature| feature.depth == depth)
        {
            let feature = self.features_open.pop().expect("Feature closing is active");
            let record = crate::LandXmlPipeFeature {
                source_id: feature.source_id,
                source_path: feature.source_path,
                owner_source_id: feature.owner_source_id,
                properties: feature.properties,
            };
            if self
                .network
                .as_ref()
                .is_some_and(|network| network.source_id == record.owner_source_id)
            {
                self.network
                    .as_mut()
                    .expect("network feature owner")
                    .features
                    .push(record.clone());
            }
            self.features.push(record);
        } else if cx.path_is(&[
            "LandXML",
            "PipeNetworks",
            "PipeNetwork",
            "Structs",
            "Struct",
        ]) {
            let structure = self.structure.take().expect("structure closing is active");
            self.network
                .as_mut()
                .expect("structure has network")
                .structures
                .push(structure);
        } else if cx.path_is(&["LandXML", "PipeNetworks", "PipeNetwork", "Pipes", "Pipe"]) {
            let pipe = self.pipe.take().expect("pipe closing is active");
            self.network
                .as_mut()
                .expect("pipe has network")
                .pipes
                .push(pipe);
        } else if cx.path_is(&["LandXML", "PipeNetworks", "PipeNetwork"]) {
            self.pending_networks
                .push(self.network.take().expect("network closing is active"));
        }
        Ok(())
    }

    pub(super) fn capture_decoded(&mut self, text: &str) -> Result<()> {
        if let Some(capture) = &mut self.capture {
            if capture.input.text.len() + text.len() > self.limits.max_text_bytes {
                return Err(error(Code::LimitExceeded, "captured text limit exceeded"));
            }
            capture.input.text.push_str(text);
        }
        Ok(())
    }
}
