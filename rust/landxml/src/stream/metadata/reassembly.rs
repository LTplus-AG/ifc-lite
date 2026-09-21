/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Compatibility-only metadata reconstruction from credited records.

use super::super::{
    LandXmlMetadataRecord, LandXmlMetadataRecordFragment, LandXmlMetadataStreamEnd,
    LandXmlMetadataStreamEvent, LandXmlMetadataStreamHeader, LandXmlStreamMetadata,
    LandXmlStreamSummary, MAX_LANDXML_STREAM_METADATA_RECORD_BYTES,
};
use crate::alignment;

#[derive(Default)]
pub(crate) struct MetadataReassembler {
    header: Option<LandXmlMetadataStreamHeader>,
    end: Option<LandXmlMetadataStreamEnd>,
    fragments: Option<PendingRecordFragmentsForSummary>,
}

struct PendingRecordFragmentsForSummary {
    record: String,
    next_sequence: usize,
    payload: Vec<u8>,
}

impl MetadataReassembler {
    pub(crate) fn push(
        &mut self,
        event: LandXmlMetadataStreamEvent,
    ) -> Result<(), crate::LandXmlError> {
        match event {
            LandXmlMetadataStreamEvent::Header(header) => {
                if self.header.replace(*header).is_some() {
                    return Err(crate::xml::error(
                        crate::LandXmlDiagnosticCode::InvalidSemantic,
                        "metadata stream emitted multiple headers",
                    ));
                }
            }
            LandXmlMetadataStreamEvent::Record(record) => self.push_record(*record)?,
            LandXmlMetadataStreamEvent::RecordFragment(fragment) => self.push_fragment(fragment)?,
            LandXmlMetadataStreamEvent::End(end) => {
                if self.end.replace(end).is_some() {
                    return Err(crate::xml::error(
                        crate::LandXmlDiagnosticCode::InvalidSemantic,
                        "metadata stream emitted multiple end records",
                    ));
                }
            }
        }
        Ok(())
    }

    fn push_fragment(
        &mut self,
        fragment: LandXmlMetadataRecordFragment,
    ) -> Result<(), crate::LandXmlError> {
        let pending = self
            .fragments
            .get_or_insert_with(|| PendingRecordFragmentsForSummary {
                record: fragment.record.clone(),
                next_sequence: 0,
                payload: Vec::new(),
            });
        if pending.record != fragment.record || pending.next_sequence != fragment.sequence {
            return Err(crate::xml::error(
                crate::LandXmlDiagnosticCode::InvalidSemantic,
                "metadata record fragment sequence is invalid",
            ));
        }
        if pending
            .payload
            .len()
            .saturating_add(fragment.payload_utf8.len())
            > MAX_LANDXML_STREAM_METADATA_RECORD_BYTES
        {
            return Err(crate::xml::error(
                crate::LandXmlDiagnosticCode::LimitExceeded,
                "metadata record fragments exceed bounded assembly limit",
            ));
        }
        pending.payload.extend(fragment.payload_utf8);
        pending.next_sequence += 1;
        if fragment.continued {
            return Ok(());
        }
        let pending = self.fragments.take().expect("fragment checked");
        let value: serde_json::Value =
            serde_json::from_slice(&pending.payload).map_err(|value| {
                crate::xml::error(
                    crate::LandXmlDiagnosticCode::InvalidSemantic,
                    format!("metadata record fragment JSON is invalid: {value}"),
                )
            })?;
        let record = serde_json::from_value(serde_json::json!({
            "record": pending.record,
            "value": value,
        }))
        .map_err(|value| {
            crate::xml::error(
                crate::LandXmlDiagnosticCode::InvalidSemantic,
                format!("metadata record fragment shape is invalid: {value}"),
            )
        })?;
        self.push_record(record)
    }

    fn push_record(&mut self, record: LandXmlMetadataRecord) -> Result<(), crate::LandXmlError> {
        let header = self.header.as_mut().ok_or_else(|| {
            crate::xml::error(
                crate::LandXmlDiagnosticCode::InvalidSemantic,
                "metadata record arrived before its header",
            )
        })?;
        match record {
            LandXmlMetadataRecord::TerrainExtension(value) => header.terrain.extensions.push(value),
            LandXmlMetadataRecord::TerrainWarning(value) => header.terrain.warnings.push(value),
            LandXmlMetadataRecord::TerrainAlignment(value) => header.terrain.alignments.push(value),
            LandXmlMetadataRecord::TerrainProfile(value) => header.terrain.profiles.push(value),
            LandXmlMetadataRecord::TerrainCrossSection(value) => {
                header.terrain.cross_sections.push(value)
            }
            LandXmlMetadataRecord::TerrainCrossSectionSurface(value) => {
                header.terrain.cross_section_surfaces.push(value)
            }
            LandXmlMetadataRecord::TerrainRoadway(value) => header.terrain.roadways.push(value),
            LandXmlMetadataRecord::TerrainCapabilityDiagnostic(value) => {
                header.terrain.capability_diagnostics.push(value)
            }
            LandXmlMetadataRecord::TerrainPreservedOnlyExtension(value) => {
                header.terrain.preserved_only_extensions.push(value)
            }
            LandXmlMetadataRecord::PlanCogoPoint(value) => header.plan.cogo_points.push(value),
            LandXmlMetadataRecord::PlanMonument(value) => header.plan.monuments.push(value),
            LandXmlMetadataRecord::PlanFeature(value) => header.plan.plan_features.push(value),
            LandXmlMetadataRecord::PlanParcel(value) => header.plan.parcels.push(value),
            LandXmlMetadataRecord::PlanWarning(value) => header.plan.warnings.push(value),
            // These cursor-only conveniences are already represented by the
            // owned plan records above. Legacy callers deliberately rebuild
            // only the semantic summary, not its WASM presentation adapter.
            LandXmlMetadataRecord::PlanSourceBatch(_)
            | LandXmlMetadataRecord::PlanParcelProbe(_)
            | LandXmlMetadataRecord::PlanResolvedMonument(_)
            | LandXmlMetadataRecord::PlanResolvedGeometry(_)
            | LandXmlMetadataRecord::AlignmentRenderSpan(_)
            | LandXmlMetadataRecord::AlignmentRenderRefusal(_)
            | LandXmlMetadataRecord::AlignmentRenderTruncated(_) => {}
            LandXmlMetadataRecord::HorizontalAlignment(value) => {
                header.alignments.alignments.push(value)
            }
            LandXmlMetadataRecord::HorizontalAlignmentWarning(value) => {
                header.alignments.warnings.push(value)
            }
            LandXmlMetadataRecord::PipeCollection(value) => {
                header.pipe_networks.collections.push(value)
            }
            LandXmlMetadataRecord::PipeFeature(value) => header.pipe_networks.features.push(value),
            LandXmlMetadataRecord::PipeNetwork(value) => header.pipe_networks.networks.push(value),
            LandXmlMetadataRecord::PipeRefusal(value) => header.pipe_networks.refusals.push(value),
        }
        Ok(())
    }

    pub(crate) fn finish(mut self) -> Result<LandXmlStreamSummary, crate::LandXmlError> {
        if self.fragments.is_some() {
            return Err(crate::xml::error(
                crate::LandXmlDiagnosticCode::InvalidSemantic,
                "metadata stream ended with an incomplete record fragment",
            ));
        }
        let end = self.end.take().ok_or_else(|| {
            crate::xml::error(
                crate::LandXmlDiagnosticCode::InvalidSemantic,
                "metadata stream ended without an end record",
            )
        })?;
        let header = self.header.take().ok_or_else(|| {
            crate::xml::error(
                crate::LandXmlDiagnosticCode::InvalidSemantic,
                "metadata stream ended without a header",
            )
        })?;
        header.plan.ensure_reference_index();
        let alignment_render = alignment::alignment_render_data(&header.alignments);
        let mut terrain = header.terrain;
        terrain.pipe_networks = Some(header.pipe_networks);
        Ok(LandXmlStreamSummary {
            header: header.stream,
            surfaces_drained: end.surfaces_drained,
            renderable_surfaces: end.renderable_surfaces,
            preserved_surfaces: end.preserved_surfaces,
            plan_cogo_points: end.plan_cogo_points,
            plan_parcels: end.plan_parcels,
            horizontal_alignments: end.horizontal_alignments,
            pipe_networks: end.pipe_networks,
            pipe_structures: end.pipe_structures,
            pipes: end.pipes,
            pipe_refusals: end.pipe_refusals,
            metadata: LandXmlStreamMetadata {
                terrain,
                plan: header.plan,
                alignments: header.alignments,
                alignment_render,
            },
        })
    }
}
