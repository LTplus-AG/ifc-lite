/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Text-node isolation and bounded capture for the native LandXML parser.

use super::*;

impl Parser<'_> {
    pub(super) fn text(&mut self, bytes: &[u8]) -> Result<()> {
        let raw = self.utf8_text(bytes)?;
        // XML character references are syntax in text nodes, but outside the
        // document element XML permits only literal XML S bytes.  Check the
        // raw event before expansion so `&#32;` cannot impersonate padding.
        self.check_character_references(character_references(raw))?;
        if self.frames.is_empty() {
            return self.outside_root_text(raw, false);
        }
        self.capture_text(&crate::xml::unescape(raw)?)
    }

    pub(super) fn cdata(&mut self, bytes: &[u8]) -> Result<()> {
        let literal = self.utf8_text(bytes)?;
        // CDATA is literal character data: entity-looking sequences must not
        // be expanded before the numeric capture parser sees them.
        if self.frames.is_empty() {
            return self.outside_root_text(literal, true);
        }
        self.capture_text(literal)
    }

    fn utf8_text<'text>(&mut self, bytes: &'text [u8]) -> Result<&'text str> {
        if bytes.len() > self.limits.max_text_bytes {
            return Err(error(Code::LimitExceeded, "text limit exceeded"));
        }
        self.check_cancel_and_work(bytes.len())?;
        std::str::from_utf8(bytes).map_err(|_| error(Code::InvalidXml, "text is not UTF-8"))
    }

    fn outside_root_text(&self, raw: &str, cdata: bool) -> Result<()> {
        if !cdata && raw.bytes().all(is_xml_s) {
            return Ok(());
        }
        let location = if self.root_closed { "after" } else { "before" };
        let kind = if cdata {
            "CDATA"
        } else {
            "non-whitespace content"
        };
        Err(error(
            Code::InvalidXml,
            format!("LandXML document has {kind} {location} its root element"),
        ))
    }

    fn capture_text(&mut self, text: &str) -> Result<()> {
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
                | Capture::Polyline { text, .. }
                | Capture::ProfilePoint { text, .. }
                | Capture::PairList { text, .. }
                | Capture::CrossSectionPoint { text, .. } => text,
            };
            if target.len() + text.len() > self.limits.max_text_bytes {
                return Err(error(Code::LimitExceeded, "captured text limit exceeded"));
            }
            target.push_str(text);
        }
        Ok(())
    }
}

fn is_xml_s(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\r' | b'\n')
}
