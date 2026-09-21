/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Public, renderer-independent stream records.

use crate::{
    alignment::{LandXmlAlignmentDocument, LandXmlAlignmentRenderData},
    LandXmlPlanDocument, LandXmlTinDocument, LandXmlUnits,
};
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct LandXmlStreamHeader {
    pub version: String,
    pub units: LandXmlUnits,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LandXmlSurfaceComponent {
    Start,
    Points,
    CanonicalVertices,
    SourceDataPoints,
    Faces,
    Boundaries,
    Breaklines,
    Contours,
    End,
}

#[derive(Clone, Debug, Serialize)]
pub struct LandXmlSurfaceFragment {
    pub source_id: String,
    pub component: LandXmlSurfaceComponent,
    pub sequence: usize,
    pub continued: bool,
    pub payload_utf8: Vec<u8>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LandXmlStreamEvent {
    Header(LandXmlStreamHeader),
    Surface(LandXmlSurfaceFragment),
}

/// Complete non-surface semantics finalized from the same event-driven
/// parsers. `terrain.surfaces` is empty because complete surfaces were already
/// emitted as bounded fragments with stable source identities.
#[derive(Clone, Debug, Serialize)]
pub struct LandXmlStreamMetadata {
    pub terrain: LandXmlTinDocument,
    pub plan: LandXmlPlanDocument,
    pub alignments: LandXmlAlignmentDocument,
    pub alignment_render: LandXmlAlignmentRenderData,
}

/// Deliberately not a fake complete document: surface data is drained before
/// finalization and the summary owns only bounded counters and header facts.
#[derive(Clone, Debug, Serialize)]
pub struct LandXmlStreamSummary {
    pub header: LandXmlStreamHeader,
    pub surfaces_drained: usize,
    pub renderable_surfaces: usize,
    pub preserved_surfaces: usize,
    pub plan_cogo_points: usize,
    pub plan_parcels: usize,
    pub horizontal_alignments: usize,
    /// Pipe-family totals are finalized from the same canonical event stream;
    /// the stream deliberately does not retain complete pipe documents.
    pub pipe_networks: usize,
    pub pipe_structures: usize,
    pub pipes: usize,
    pub pipe_refusals: usize,
    pub metadata: LandXmlStreamMetadata,
}
