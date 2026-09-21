/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Move-owned, bounded metadata records emitted after streamed surfaces.

use super::{
    LandXmlMetadataRecord, LandXmlMetadataStreamEnd, LandXmlMetadataStreamEvent,
    LandXmlMetadataStreamHeader, LandXmlStreamHeader, LandXmlStreamMetadata, LandXmlStreamSummary,
};
use crate::{
    alignment::{self, LandXmlAlignmentDocument},
    LandXmlPipeNetworkDocument, LandXmlPlanDocument, LandXmlTinDocument,
};

pub(crate) struct TerrainStreamParts {
    header: Option<LandXmlTinDocument>,
    extensions: std::vec::IntoIter<crate::LandXmlExtension>,
    warnings: std::vec::IntoIter<String>,
    alignments: std::vec::IntoIter<crate::LandXmlAlignment>,
    profiles: std::vec::IntoIter<crate::LandXmlProfile>,
    cross_sections: std::vec::IntoIter<crate::LandXmlCrossSection>,
    cross_section_surfaces: std::vec::IntoIter<crate::LandXmlCrossSectionSurface>,
    roadways: std::vec::IntoIter<crate::LandXmlRoadway>,
    capability_diagnostics: std::vec::IntoIter<crate::LandXmlCapabilityDiagnostic>,
    preserved_only_extensions: std::vec::IntoIter<crate::LandXmlPreservedOnlyExtension>,
}

impl TerrainStreamParts {
    pub(crate) fn new(document: LandXmlTinDocument) -> Self {
        let LandXmlTinDocument {
            format,
            schema,
            capabilities,
            version,
            units,
            coordinate_system,
            surfaces,
            extensions,
            warnings,
            alignments,
            profiles,
            cross_sections,
            cross_section_surfaces,
            roadways,
            capability_diagnostics,
            preserved_only_extensions,
            pipe_networks,
        } = document;
        debug_assert!(
            surfaces.is_empty(),
            "streamed terrain surfaces must be drained first"
        );
        debug_assert!(
            pipe_networks.is_none(),
            "pipe metadata has its own stream family"
        );
        Self {
            header: Some(LandXmlTinDocument {
                format,
                schema,
                capabilities,
                version,
                units,
                coordinate_system,
                surfaces: Vec::new(),
                extensions: Vec::new(),
                warnings: Vec::new(),
                alignments: Vec::new(),
                profiles: Vec::new(),
                cross_sections: Vec::new(),
                cross_section_surfaces: Vec::new(),
                roadways: Vec::new(),
                capability_diagnostics: Vec::new(),
                preserved_only_extensions: Vec::new(),
                pipe_networks: None,
            }),
            extensions: extensions.into_iter(),
            warnings: warnings.into_iter(),
            alignments: alignments.into_iter(),
            profiles: profiles.into_iter(),
            cross_sections: cross_sections.into_iter(),
            cross_section_surfaces: cross_section_surfaces.into_iter(),
            roadways: roadways.into_iter(),
            capability_diagnostics: capability_diagnostics.into_iter(),
            preserved_only_extensions: preserved_only_extensions.into_iter(),
        }
    }

    fn take_header(&mut self) -> LandXmlTinDocument {
        self.header.take().expect("metadata header is emitted once")
    }

    fn next_record(&mut self) -> Option<LandXmlMetadataRecord> {
        self.extensions
            .next()
            .map(LandXmlMetadataRecord::TerrainExtension)
            .or_else(|| {
                self.warnings
                    .next()
                    .map(LandXmlMetadataRecord::TerrainWarning)
            })
            .or_else(|| {
                self.alignments
                    .next()
                    .map(LandXmlMetadataRecord::TerrainAlignment)
            })
            .or_else(|| {
                self.profiles
                    .next()
                    .map(LandXmlMetadataRecord::TerrainProfile)
            })
            .or_else(|| {
                self.cross_sections
                    .next()
                    .map(LandXmlMetadataRecord::TerrainCrossSection)
            })
            .or_else(|| {
                self.cross_section_surfaces
                    .next()
                    .map(LandXmlMetadataRecord::TerrainCrossSectionSurface)
            })
            .or_else(|| {
                self.roadways
                    .next()
                    .map(LandXmlMetadataRecord::TerrainRoadway)
            })
            .or_else(|| {
                self.capability_diagnostics
                    .next()
                    .map(LandXmlMetadataRecord::TerrainCapabilityDiagnostic)
            })
            .or_else(|| {
                self.preserved_only_extensions
                    .next()
                    .map(LandXmlMetadataRecord::TerrainPreservedOnlyExtension)
            })
    }
}

pub(crate) struct PlanStreamParts {
    header: Option<LandXmlPlanDocument>,
    cogo_points: std::vec::IntoIter<crate::LandXmlCgPoint>,
    monuments: std::vec::IntoIter<crate::LandXmlMonument>,
    features: std::vec::IntoIter<crate::LandXmlPlanFeature>,
    parcels: std::vec::IntoIter<crate::LandXmlParcel>,
    warnings: std::vec::IntoIter<String>,
}

impl PlanStreamParts {
    pub(crate) fn new(document: LandXmlPlanDocument) -> Self {
        let LandXmlPlanDocument {
            schema,
            version,
            capability_diagnostics,
            units,
            area_unit,
            area_scale_to_square_meters,
            cogo_points,
            monuments,
            plan_features,
            parcels,
            warnings,
            reference_index,
        } = document;
        Self {
            header: Some(LandXmlPlanDocument {
                schema,
                version,
                capability_diagnostics,
                units,
                area_unit,
                area_scale_to_square_meters,
                cogo_points: Vec::new(),
                monuments: Vec::new(),
                plan_features: Vec::new(),
                parcels: Vec::new(),
                warnings: Vec::new(),
                reference_index,
            }),
            cogo_points: cogo_points.into_iter(),
            monuments: monuments.into_iter(),
            features: plan_features.into_iter(),
            parcels: parcels.into_iter(),
            warnings: warnings.into_iter(),
        }
    }

    fn take_header(&mut self) -> LandXmlPlanDocument {
        self.header.take().expect("metadata header is emitted once")
    }

    fn next_record(&mut self) -> Option<LandXmlMetadataRecord> {
        self.cogo_points
            .next()
            .map(LandXmlMetadataRecord::PlanCogoPoint)
            .or_else(|| {
                self.monuments
                    .next()
                    .map(LandXmlMetadataRecord::PlanMonument)
            })
            .or_else(|| self.features.next().map(LandXmlMetadataRecord::PlanFeature))
            .or_else(|| self.parcels.next().map(LandXmlMetadataRecord::PlanParcel))
            .or_else(|| self.warnings.next().map(LandXmlMetadataRecord::PlanWarning))
    }
}

pub(crate) struct AlignmentStreamParts {
    header: Option<LandXmlAlignmentDocument>,
    alignments: std::vec::IntoIter<crate::alignment::LandXmlAlignment>,
    warnings: std::vec::IntoIter<String>,
}

impl AlignmentStreamParts {
    pub(crate) fn new(document: LandXmlAlignmentDocument) -> Self {
        let LandXmlAlignmentDocument {
            schema,
            version,
            capability_diagnostics,
            units,
            alignments,
            warnings,
        } = document;
        Self {
            header: Some(LandXmlAlignmentDocument {
                schema,
                version,
                capability_diagnostics,
                units,
                alignments: Vec::new(),
                warnings: Vec::new(),
            }),
            alignments: alignments.into_iter(),
            warnings: warnings.into_iter(),
        }
    }

    fn take_header(&mut self) -> LandXmlAlignmentDocument {
        self.header.take().expect("metadata header is emitted once")
    }

    fn next_record(&mut self) -> Option<LandXmlMetadataRecord> {
        self.alignments
            .next()
            .map(LandXmlMetadataRecord::HorizontalAlignment)
            .or_else(|| {
                self.warnings
                    .next()
                    .map(LandXmlMetadataRecord::HorizontalAlignmentWarning)
            })
    }
}

pub(crate) struct PipeStreamParts {
    header: Option<LandXmlPipeNetworkDocument>,
    collections: std::vec::IntoIter<crate::LandXmlPipeNetworkCollection>,
    features: std::vec::IntoIter<crate::LandXmlPipeFeature>,
    networks: std::vec::IntoIter<crate::LandXmlPipeNetwork>,
    refusals: std::vec::IntoIter<crate::LandXmlPipeRefusal>,
}

impl PipeStreamParts {
    pub(crate) fn new(document: LandXmlPipeNetworkDocument) -> Self {
        let LandXmlPipeNetworkDocument {
            schema,
            version,
            capability_diagnostics,
            root_units,
            collections,
            features,
            networks,
            refusals,
        } = document;
        Self {
            header: Some(LandXmlPipeNetworkDocument {
                schema,
                version,
                capability_diagnostics,
                root_units,
                collections: Vec::new(),
                features: Vec::new(),
                networks: Vec::new(),
                refusals: Vec::new(),
            }),
            collections: collections.into_iter(),
            features: features.into_iter(),
            networks: networks.into_iter(),
            refusals: refusals.into_iter(),
        }
    }

    fn take_header(&mut self) -> LandXmlPipeNetworkDocument {
        self.header.take().expect("metadata header is emitted once")
    }

    fn next_record(&mut self) -> Option<LandXmlMetadataRecord> {
        self.collections
            .next()
            .map(LandXmlMetadataRecord::PipeCollection)
            .or_else(|| self.features.next().map(LandXmlMetadataRecord::PipeFeature))
            .or_else(|| self.networks.next().map(LandXmlMetadataRecord::PipeNetwork))
            .or_else(|| self.refusals.next().map(LandXmlMetadataRecord::PipeRefusal))
    }
}

pub(crate) struct MetadataCursor {
    header: Option<LandXmlMetadataStreamHeader>,
    terrain: TerrainStreamParts,
    plan: PlanStreamParts,
    plan_derived: std::collections::VecDeque<LandXmlMetadataRecord>,
    alignment: AlignmentStreamParts,
    alignment_derived: std::collections::VecDeque<LandXmlMetadataRecord>,
    pipe: PipeStreamParts,
    end: Option<LandXmlMetadataStreamEnd>,
}

impl MetadataCursor {
    pub(crate) fn new(
        header: LandXmlStreamHeader,
        mut terrain: TerrainStreamParts,
        mut plan: PlanStreamParts,
        plan_derived: std::collections::VecDeque<LandXmlMetadataRecord>,
        mut alignment: AlignmentStreamParts,
        alignment_derived: std::collections::VecDeque<LandXmlMetadataRecord>,
        mut pipe: PipeStreamParts,
        end: LandXmlMetadataStreamEnd,
    ) -> Self {
        Self {
            header: Some(LandXmlMetadataStreamHeader {
                stream: header,
                terrain: terrain.take_header(),
                plan: plan.take_header(),
                alignments: alignment.take_header(),
                pipe_networks: pipe.take_header(),
            }),
            terrain,
            plan,
            plan_derived,
            alignment,
            alignment_derived,
            pipe,
            end: Some(end),
        }
    }

    pub(crate) fn next_event(&mut self) -> Option<LandXmlMetadataStreamEvent> {
        self.header
            .take()
            .map(LandXmlMetadataStreamEvent::Header)
            .or_else(|| {
                self.terrain
                    .next_record()
                    .map(LandXmlMetadataStreamEvent::Record)
            })
            .or_else(|| {
                self.plan
                    .next_record()
                    .map(LandXmlMetadataStreamEvent::Record)
            })
            .or_else(|| {
                self.plan_derived
                    .pop_front()
                    .map(LandXmlMetadataStreamEvent::Record)
            })
            .or_else(|| {
                self.alignment
                    .next_record()
                    .map(LandXmlMetadataStreamEvent::Record)
            })
            .or_else(|| {
                self.alignment_derived
                    .pop_front()
                    .map(LandXmlMetadataStreamEvent::Record)
            })
            .or_else(|| {
                self.pipe
                    .next_record()
                    .map(LandXmlMetadataStreamEvent::Record)
            })
            .or_else(|| self.end.take().map(LandXmlMetadataStreamEvent::End))
    }
}

#[derive(Default)]
pub(crate) struct MetadataReassembler {
    header: Option<LandXmlMetadataStreamHeader>,
    end: Option<LandXmlMetadataStreamEnd>,
}

impl MetadataReassembler {
    pub(crate) fn push(
        &mut self,
        event: LandXmlMetadataStreamEvent,
    ) -> Result<(), crate::LandXmlError> {
        match event {
            LandXmlMetadataStreamEvent::Header(header) => {
                if self.header.replace(header).is_some() {
                    return Err(crate::xml::error(
                        crate::LandXmlDiagnosticCode::InvalidSemantic,
                        "metadata stream emitted multiple headers",
                    ));
                }
            }
            LandXmlMetadataStreamEvent::Record(record) => self.push_record(record)?,
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
