/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Text-node isolation and bounded capture for the native LandXML parser.

use super::*;

impl Parser<'_> {
    pub(super) fn text(&mut self, bytes: &[u8]) -> Result<()> {
        let raw = self.utf8_text(bytes)?;
        // quick-xml 0.42 never puts a reference in a text event: each
        // `&name;` is its own `Event::GeneralRef` (see `reference`).
        // Outside the document element XML permits only literal XML S bytes.
        if self.frames.is_empty() {
            return crate::xml::outside_root_text(self.root_closed, raw, false);
        }
        let text = decode_text(raw, &mut self.character_references)?;
        self.capture_text(&text)
    }

    /// A `&name;` in element content: resolved by `xml::refs`, never through
    /// its source form.
    pub(super) fn reference(&mut self, reference: &BytesRef<'_>) -> Result<()> {
        let source = source_len(reference);
        if source > self.limits.max_text_bytes {
            return Err(error(Code::LimitExceeded, "text limit exceeded"));
        }
        self.check_cancel_and_work(source)?;
        // `&#32;` cannot pass for padding outside the document element.
        if self.frames.is_empty() {
            return crate::xml::outside_root_text(self.root_closed, "&", false);
        }
        let character = decode_ref(reference, &mut self.character_references)?;
        self.capture_text(character.encode_utf8(&mut [0; 4]))
    }

    pub(super) fn cdata(&mut self, bytes: &[u8]) -> Result<()> {
        let literal = self.utf8_text(bytes)?;
        // CDATA is literal character data: entity-looking sequences must not
        // be expanded before the numeric capture parser sees them.
        if self.frames.is_empty() {
            return crate::xml::outside_root_text(self.root_closed, literal, true);
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
