/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Move-owned, bounded metadata records emitted after streamed surfaces.

mod cursor;
mod reassembly;
pub(crate) use cursor::MetadataCursor;
pub(crate) use reassembly::MetadataReassembler;

use super::LandXmlMetadataRecord;
use crate::{
    alignment::LandXmlAlignmentDocument, LandXmlPipeNetworkDocument, LandXmlPlanDocument,
    LandXmlTinDocument,
};
use std::cell::RefCell;

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
    pub(crate) fn header(document: &LandXmlPlanDocument) -> LandXmlPlanDocument {
        LandXmlPlanDocument {
            schema: document.schema.clone(),
            version: document.version.clone(),
            capability_diagnostics: document.capability_diagnostics.clone(),
            units: document.units.clone(),
            area_unit: document.area_unit.clone(),
            area_scale_to_square_meters: document.area_scale_to_square_meters,
            cogo_points: Vec::new(),
            monuments: Vec::new(),
            plan_features: Vec::new(),
            parcels: Vec::new(),
            warnings: Vec::new(),
            reference_index: RefCell::new(None),
        }
    }

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

    pub(crate) fn without_header(document: LandXmlPlanDocument) -> Self {
        let mut parts = Self::new(document);
        parts.header = None;
        parts
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
    pub(crate) fn header(document: &LandXmlAlignmentDocument) -> LandXmlAlignmentDocument {
        LandXmlAlignmentDocument {
            schema: document.schema.clone(),
            version: document.version.clone(),
            capability_diagnostics: document.capability_diagnostics.clone(),
            units: document.units.clone(),
            alignments: Vec::new(),
            warnings: Vec::new(),
        }
    }

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

    pub(crate) fn without_header(document: LandXmlAlignmentDocument) -> Self {
        let mut parts = Self::new(document);
        parts.header = None;
        parts
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
