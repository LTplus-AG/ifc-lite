// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Bounded display samples derived from already-parsed alignment semantics.

use super::{LandXmlAlignmentDocument, LandXmlAlignmentRenderSpan};

const POINTS_PER_SPAN: usize = 65;
const MAX_POINTS: usize = 250_000;
const MAX_REFUSALS: usize = 1_024;

/// One numeric display-sampling refusal retained with its authored identity.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct LandXmlAlignmentRenderRefusal {
    pub source_id: String,
    pub message: String,
}

/// Bounded derived display data. It is never a substitute for the source
/// alignment document or its exact probe API.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct LandXmlAlignmentRenderData {
    pub spans: Vec<LandXmlAlignmentRenderSpan>,
    pub refusals: Vec<LandXmlAlignmentRenderRefusal>,
    pub truncated: bool,
}

/// Sample only the supported analytic primitives from an existing source
/// document. This does not parse XML and so is safe after stream finalization.
pub fn alignment_render_data(document: &LandXmlAlignmentDocument) -> LandXmlAlignmentRenderData {
    let mut spans = Vec::new();
    let mut refusals = Vec::new();
    let mut point_count = 0usize;
    let mut truncated = false;
    for alignment in &document.alignments {
        for segment in &alignment.segments {
            match segment.render_span(POINTS_PER_SPAN) {
                Ok(Some(span)) => {
                    let Some(next_point_count) = point_count.checked_add(span.points.len()) else {
                        return LandXmlAlignmentRenderData {
                            spans,
                            refusals,
                            truncated: true,
                        };
                    };
                    if next_point_count > MAX_POINTS {
                        return LandXmlAlignmentRenderData {
                            spans,
                            refusals,
                            truncated: true,
                        };
                    }
                    point_count = next_point_count;
                    spans.push(span);
                }
                Ok(None) => {}
                Err(error) if refusals.len() < MAX_REFUSALS => {
                    refusals.push(LandXmlAlignmentRenderRefusal {
                        source_id: segment.source_id.0.clone(),
                        message: error.to_string(),
                    });
                }
                Err(_) => truncated = true,
            }
        }
    }
    LandXmlAlignmentRenderData {
        spans,
        refusals,
        truncated,
    }
}
