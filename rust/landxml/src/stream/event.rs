/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Public, renderer-independent stream records.

use crate::{
    alignment::{
        LandXmlAlignment as LandXmlHorizontalAlignment, LandXmlAlignmentDocument,
        LandXmlAlignmentRenderData,
    },
    LandXmlAlignment as LandXmlTerrainAlignment, LandXmlCapabilityDiagnostic, LandXmlCgPoint,
    LandXmlCrossSection, LandXmlCrossSectionSurface, LandXmlExtension, LandXmlMonument,
    LandXmlParcel, LandXmlPipeFeature, LandXmlPipeNetwork, LandXmlPipeNetworkCollection,
    LandXmlPipeNetworkDocument, LandXmlPipeRefusal, LandXmlPlanDocument, LandXmlPlanFeature,
    LandXmlPlanPoint, LandXmlPlanSourceBatch, LandXmlPreservedOnlyExtension, LandXmlProfile,
    LandXmlRoadway, LandXmlTinDocument, LandXmlUnits,
};
use serde::{Deserialize, Serialize};

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
    Metadata(LandXmlMetadataStreamEvent),
}

/// Metadata header emitted once, after all surface fragments have received
/// credit. Its record vectors are intentionally empty; their values follow as
/// individually owned [`LandXmlMetadataStreamEvent::Record`] values.
#[derive(Clone, Debug, Serialize)]
pub struct LandXmlMetadataStreamHeader {
    pub stream: LandXmlStreamHeader,
    pub terrain: LandXmlTinDocument,
    pub plan: LandXmlPlanDocument,
    pub alignments: LandXmlAlignmentDocument,
    pub pipe_networks: LandXmlPipeNetworkDocument,
}

/// One complete top-level LandXML semantic record. A consumer can release the
/// record before requesting the next credited event.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "record", content = "value", rename_all = "snake_case")]
pub enum LandXmlMetadataRecord {
    TerrainExtension(LandXmlExtension),
    TerrainWarning(String),
    TerrainAlignment(LandXmlTerrainAlignment),
    TerrainProfile(LandXmlProfile),
    TerrainCrossSection(LandXmlCrossSection),
    TerrainCrossSectionSurface(LandXmlCrossSectionSurface),
    TerrainRoadway(LandXmlRoadway),
    TerrainCapabilityDiagnostic(LandXmlCapabilityDiagnostic),
    TerrainPreservedOnlyExtension(LandXmlPreservedOnlyExtension),
    PlanCogoPoint(LandXmlCgPoint),
    PlanMonument(LandXmlMonument),
    PlanFeature(LandXmlPlanFeature),
    PlanParcel(LandXmlParcel),
    PlanWarning(String),
    /// Renderer-independent derived plan partitions.  These are ordinary
    /// credited records rather than an unbounded compatibility payload on End.
    PlanSourceBatch(LandXmlPlanSourceBatch),
    PlanParcelProbe(LandXmlPlanParcelProbe),
    PlanResolvedMonument(LandXmlPlanResolvedMonument),
    PlanResolvedGeometry(LandXmlPlanResolvedGeometry),
    AlignmentRenderSpan(crate::alignment::LandXmlAlignmentRenderSpan),
    AlignmentRenderRefusal(crate::alignment::LandXmlAlignmentRenderRefusal),
    AlignmentRenderTruncated(bool),
    HorizontalAlignment(LandXmlHorizontalAlignment),
    HorizontalAlignmentWarning(String),
    PipeCollection(LandXmlPipeNetworkCollection),
    PipeFeature(LandXmlPipeFeature),
    PipeNetwork(LandXmlPipeNetwork),
    PipeRefusal(LandXmlPipeRefusal),
}

/// One parcel probe paired with the authored parcel provenance it describes.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct LandXmlPlanParcelProbe {
    pub source_id: crate::LandXmlSourceId,
    #[serde(flatten)]
    pub probe: crate::LandXmlParcelProbe,
}

/// A single monument's canonical resolved position, if one exists.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct LandXmlPlanResolvedMonument {
    pub source_id: crate::LandXmlSourceId,
    pub point: Option<LandXmlPlanPoint>,
}

/// Canonical endpoint resolution for one authored plan geometry record.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct LandXmlPlanResolvedGeometry {
    pub source_id: crate::LandXmlSourceId,
    pub start: Option<LandXmlPlanPoint>,
    pub end: Option<LandXmlPlanPoint>,
    pub center: Option<LandXmlPlanPoint>,
    pub pi: Option<LandXmlPlanPoint>,
}

/// Counters emitted after every move-owned metadata record.
#[derive(Clone, Debug, Serialize)]
pub struct LandXmlMetadataStreamEnd {
    pub surfaces_drained: usize,
    pub renderable_surfaces: usize,
    pub preserved_surfaces: usize,
    pub plan_cogo_points: usize,
    pub plan_parcels: usize,
    pub horizontal_alignments: usize,
    pub pipe_networks: usize,
    pub pipe_structures: usize,
    pub pipes: usize,
    pub pipe_refusals: usize,
}

/// Resumable metadata events delivered through [`LandXmlStreamEvent::Metadata`].
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "metadata_kind", rename_all = "snake_case")]
pub enum LandXmlMetadataStreamEvent {
    Header(LandXmlMetadataStreamHeader),
    Record(LandXmlMetadataRecord),
    /// A single legal metadata value which is too large for one credited
    /// transport event. The receiver must concatenate `payload_utf8` in
    /// sequence order, decode it as JSON, and handle it exactly as the
    /// corresponding [`Self::Record`] value.
    RecordFragment(LandXmlMetadataRecordFragment),
    End(LandXmlMetadataStreamEnd),
}

/// Bounded transport fragment for one metadata record value.
#[derive(Clone, Debug, Serialize)]
pub struct LandXmlMetadataRecordFragment {
    pub record: String,
    pub sequence: usize,
    pub continued: bool,
    pub payload_utf8: Vec<u8>,
}

impl LandXmlMetadataRecord {
    pub(crate) fn wire_name(&self) -> &'static str {
        match self {
            Self::TerrainExtension(_) => "terrain_extension",
            Self::TerrainWarning(_) => "terrain_warning",
            Self::TerrainAlignment(_) => "terrain_alignment",
            Self::TerrainProfile(_) => "terrain_profile",
            Self::TerrainCrossSection(_) => "terrain_cross_section",
            Self::TerrainCrossSectionSurface(_) => "terrain_cross_section_surface",
            Self::TerrainRoadway(_) => "terrain_roadway",
            Self::TerrainCapabilityDiagnostic(_) => "terrain_capability_diagnostic",
            Self::TerrainPreservedOnlyExtension(_) => "terrain_preserved_only_extension",
            Self::PlanCogoPoint(_) => "plan_cogo_point",
            Self::PlanMonument(_) => "plan_monument",
            Self::PlanFeature(_) => "plan_feature",
            Self::PlanParcel(_) => "plan_parcel",
            Self::PlanWarning(_) => "plan_warning",
            Self::PlanSourceBatch(_) => "plan_source_batch",
            Self::PlanParcelProbe(_) => "plan_parcel_probe",
            Self::PlanResolvedMonument(_) => "plan_resolved_monument",
            Self::PlanResolvedGeometry(_) => "plan_resolved_geometry",
            Self::AlignmentRenderSpan(_) => "alignment_render_span",
            Self::AlignmentRenderRefusal(_) => "alignment_render_refusal",
            Self::AlignmentRenderTruncated(_) => "alignment_render_truncated",
            Self::HorizontalAlignment(_) => "horizontal_alignment",
            Self::HorizontalAlignmentWarning(_) => "horizontal_alignment_warning",
            Self::PipeCollection(_) => "pipe_collection",
            Self::PipeFeature(_) => "pipe_feature",
            Self::PipeNetwork(_) => "pipe_network",
            Self::PipeRefusal(_) => "pipe_refusal",
        }
    }

    pub(crate) fn serialize_value(&self) -> Result<Vec<u8>, serde_json::Error> {
        match self {
            Self::TerrainExtension(value) => serde_json::to_vec(value),
            Self::TerrainWarning(value) => serde_json::to_vec(value),
            Self::TerrainAlignment(value) => serde_json::to_vec(value),
            Self::TerrainProfile(value) => serde_json::to_vec(value),
            Self::TerrainCrossSection(value) => serde_json::to_vec(value),
            Self::TerrainCrossSectionSurface(value) => serde_json::to_vec(value),
            Self::TerrainRoadway(value) => serde_json::to_vec(value),
            Self::TerrainCapabilityDiagnostic(value) => serde_json::to_vec(value),
            Self::TerrainPreservedOnlyExtension(value) => serde_json::to_vec(value),
            Self::PlanCogoPoint(value) => serde_json::to_vec(value),
            Self::PlanMonument(value) => serde_json::to_vec(value),
            Self::PlanFeature(value) => serde_json::to_vec(value),
            Self::PlanParcel(value) => serde_json::to_vec(value),
            Self::PlanWarning(value) => serde_json::to_vec(value),
            Self::PlanSourceBatch(value) => serde_json::to_vec(value),
            Self::PlanParcelProbe(value) => serde_json::to_vec(value),
            Self::PlanResolvedMonument(value) => serde_json::to_vec(value),
            Self::PlanResolvedGeometry(value) => serde_json::to_vec(value),
            Self::AlignmentRenderSpan(value) => serde_json::to_vec(value),
            Self::AlignmentRenderRefusal(value) => serde_json::to_vec(value),
            Self::AlignmentRenderTruncated(value) => serde_json::to_vec(value),
            Self::HorizontalAlignment(value) => serde_json::to_vec(value),
            Self::HorizontalAlignmentWarning(value) => serde_json::to_vec(value),
            Self::PipeCollection(value) => serde_json::to_vec(value),
            Self::PipeFeature(value) => serde_json::to_vec(value),
            Self::PipeNetwork(value) => serde_json::to_vec(value),
            Self::PipeRefusal(value) => serde_json::to_vec(value),
        }
    }
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
