// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::{
    xml::{character_references, error, split_name, unescape, Result},
    LandXmlDiagnosticCode as Code,
};

use super::PipeParser;

impl PipeParser<'_> {
    pub(super) fn end(&mut self, closing: Option<&[u8]>) -> Result<()> {
        let frame = self
            .frames
            .last()
            .cloned()
            .ok_or_else(|| error(Code::InvalidXml, "unexpected closing element"))?;
        if let Some(closing) = closing {
            let (_, local, _) = split_name(closing, self.limits.max_name_bytes)?;
            if local != frame.local {
                return Err(error(Code::InvalidXml, "mismatched closing element"));
            }
        }
        if self
            .capture
            .as_ref()
            .is_some_and(|capture| capture.depth == self.frames.len())
        {
            self.finish_center()?;
        }
        if frame.target && frame.local == "Feature" && self.feature.is_some() {
            let feature = self.feature.take().expect("Feature closing is active");
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
        } else if self.is_path(&[
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
        } else if self.is_path(&["LandXML", "PipeNetworks", "PipeNetwork", "Pipes", "Pipe"]) {
            let pipe = self.pipe.take().expect("pipe closing is active");
            self.network
                .as_mut()
                .expect("pipe has network")
                .pipes
                .push(pipe);
        } else if self.is_path(&["LandXML", "PipeNetworks", "PipeNetwork"]) {
            self.pending_networks
                .push(self.network.take().expect("network closing is active"));
        }
        if self.frames.len() == 1 {
            self.root_closed = true;
        }
        self.frames.pop();
        Ok(())
    }

    pub(super) fn text(&mut self, bytes: &[u8]) -> Result<()> {
        if bytes.len() > self.limits.max_text_bytes {
            return Err(error(Code::LimitExceeded, "text limit exceeded"));
        }
        self.check_cancel_and_work(bytes.len())?;
        let text =
            std::str::from_utf8(bytes).map_err(|_| error(Code::InvalidXml, "text is not UTF-8"))?;
        self.check_character_references(character_references(text))?;
        if self.frames.is_empty() && !text.trim().is_empty() {
            return Err(error(Code::InvalidXml, "text outside LandXML root"));
        }
        if let Some(capture) = &mut self.capture {
            if self.frames.len() != capture.depth {
                if !text.trim().is_empty() {
                    return Err(error(
                        Code::InvalidSemantic,
                        "Center must contain direct coordinates",
                    ));
                }
                return Ok(());
            }
            let text = unescape(text)?;
            if capture.input.text.len() + text.len() > self.limits.max_text_bytes {
                return Err(error(Code::LimitExceeded, "captured text limit exceeded"));
            }
            capture.input.text.push_str(&text);
        }
        Ok(())
    }
}
