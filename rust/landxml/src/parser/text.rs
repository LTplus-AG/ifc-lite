/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Bounded capture of element text for the TIN family.

use super::*;

impl TinHandler<'_> {
    /// Append decoded element text to the numeric capture of the open element
    /// (the driver only calls this while that capture is open).
    pub(super) fn capture_text(&mut self, text: &str) -> Result<()> {
        if let Some(capture) = self.capture.as_mut() {
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
