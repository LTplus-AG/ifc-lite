/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Text-node isolation and bounded capture for the native LandXML parser.

use super::*;

impl Parser<'_> {
    pub(super) fn text(&mut self, bytes: &[u8]) -> Result<()> {
        if bytes.len() > self.limits.max_text_bytes {
            return Err(error(Code::LimitExceeded, "text limit exceeded"));
        }
        self.check_cancel_and_work(bytes.len())?;
        let text =
            std::str::from_utf8(bytes).map_err(|_| error(Code::InvalidXml, "text is not UTF-8"))?;
        self.check_character_references(character_references(text))?;
        let text = crate::xml::unescape(text)?;
        if self.frames.is_empty() && !text.trim().is_empty() {
            let location = if self.root_closed { "after" } else { "before" };
            return Err(error(
                Code::InvalidXml,
                format!("LandXML document has non-whitespace content {location} its root element"),
            ));
        }
        if self
            .capture
            .as_ref()
            .is_some_and(|capture| capture.depth() == self.frames.len())
        {
            let capture = self.capture.as_mut().expect("capture checked");
            let target = match capture {
                Capture::Point { text, .. }
                | Capture::Face { text, .. }
                | Capture::SourcePoints { text, .. }
                | Capture::Polyline { text, .. } => text,
            };
            if target.len() + text.len() > self.limits.max_text_bytes {
                return Err(error(Code::LimitExceeded, "captured text limit exceeded"));
            }
            target.push_str(&text);
        }
        Ok(())
    }
}
