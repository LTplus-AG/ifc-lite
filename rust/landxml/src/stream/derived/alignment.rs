/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! One-at-a-time alignment display derivation held behind stream credit.

use super::super::LandXmlMetadataRecord;
use crate::alignment::{LandXmlAlignmentDocument, LandXmlAlignmentRenderRefusal};

const POINTS_PER_SPAN: usize = 65;
const MAX_POINTS: usize = 250_000;
const MAX_REFUSALS: usize = 1_024;

pub(crate) struct AlignmentDerivedCursor {
    document: Option<LandXmlAlignmentDocument>,
    alignment_index: usize,
    segment_index: usize,
    point_count: usize,
    refusal_count: usize,
    truncated: bool,
    terminal_emitted: bool,
}

impl AlignmentDerivedCursor {
    pub(crate) fn new(document: LandXmlAlignmentDocument) -> Self {
        Self {
            document: Some(document),
            alignment_index: 0,
            segment_index: 0,
            point_count: 0,
            refusal_count: 0,
            truncated: false,
            terminal_emitted: false,
        }
    }

    pub(crate) fn take_document(&mut self) -> Option<LandXmlAlignmentDocument> {
        self.terminal_emitted
            .then(|| self.document.take())
            .flatten()
    }

    pub(crate) fn next_record(&mut self) -> Option<LandXmlMetadataRecord> {
        let document = self.document.as_ref()?;
        while let Some(alignment) = document.alignments.get(self.alignment_index) {
            let Some(segment) = alignment.segments.get(self.segment_index) else {
                self.alignment_index += 1;
                self.segment_index = 0;
                continue;
            };
            self.segment_index += 1;
            match segment.render_span(POINTS_PER_SPAN) {
                Ok(Some(span)) => {
                    let Some(next_count) = self.point_count.checked_add(span.points.len()) else {
                        self.truncated = true;
                        continue;
                    };
                    if next_count > MAX_POINTS {
                        self.truncated = true;
                        continue;
                    }
                    self.point_count = next_count;
                    return Some(LandXmlMetadataRecord::AlignmentRenderSpan(span));
                }
                Ok(None) => {}
                Err(error) if self.refusal_count < MAX_REFUSALS => {
                    self.refusal_count += 1;
                    return Some(LandXmlMetadataRecord::AlignmentRenderRefusal(
                        LandXmlAlignmentRenderRefusal {
                            source_id: segment.source_id.0.clone(),
                            message: error.to_string(),
                        },
                    ));
                }
                Err(_) => self.truncated = true,
            }
        }
        if !self.terminal_emitted {
            self.terminal_emitted = true;
            return Some(LandXmlMetadataRecord::AlignmentRenderTruncated(
                self.truncated,
            ));
        }
        None
    }
}
