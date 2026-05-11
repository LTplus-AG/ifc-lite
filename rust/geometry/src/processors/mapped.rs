// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! MappedItem processor - geometry instancing.

use crate::{Error, Mesh, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

use super::boolean::BooleanClippingProcessor;
use super::brep::FacetedBrepProcessor;
use super::extrusion::ExtrudedAreaSolidProcessor;
use super::extrusion_tapered::ExtrudedAreaSolidTaperedProcessor;
use super::swept::{RevolvedAreaSolidProcessor, SweptDiskSolidProcessor};
use super::tessellated::TriangulatedFaceSetProcessor;
use crate::router::GeometryProcessor;

/// MappedItem processor (P0)
/// Handles IfcMappedItem - geometry instancing
pub struct MappedItemProcessor;

impl MappedItemProcessor {
    pub fn new() -> Self {
        Self
    }
}

impl GeometryProcessor for MappedItemProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
    ) -> Result<Mesh> {
        // IfcMappedItem attributes:
        // 0: MappingSource (IfcRepresentationMap)
        // 1: MappingTarget (IfcCartesianTransformationOperator)

        // Get mapping source
        let source_attr = entity
            .get(0)
            .ok_or_else(|| Error::geometry("MappedItem missing MappingSource".to_string()))?;

        let source_entity = decoder
            .resolve_ref(source_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve MappingSource".to_string()))?;

        // IfcRepresentationMap has:
        // 0: MappingOrigin (IfcAxis2Placement)
        // 1: MappedRepresentation (IfcRepresentation)

        let mapped_rep_attr = source_entity.get(1).ok_or_else(|| {
            Error::geometry("RepresentationMap missing MappedRepresentation".to_string())
        })?;

        let mapped_rep = decoder
            .resolve_ref(mapped_rep_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve MappedRepresentation".to_string()))?;

        // Get representation items
        let items_attr = mapped_rep
            .get(3)
            .ok_or_else(|| Error::geometry("Representation missing Items".to_string()))?;

        let items = decoder.resolve_ref_list(items_attr)?;

        // Process all items and merge
        let mut mesh = Mesh::new();
        for item in items {
            let item_mesh = match item.ifc_type {
                IfcType::IfcExtrudedAreaSolid => {
                    let processor = ExtrudedAreaSolidProcessor::new(schema.clone());
                    processor.process(&item, decoder, schema)?
                }
                IfcType::IfcExtrudedAreaSolidTapered => {
                    let processor = ExtrudedAreaSolidTaperedProcessor::new(schema.clone());
                    processor.process(&item, decoder, schema)?
                }
                IfcType::IfcTriangulatedFaceSet => {
                    let processor = TriangulatedFaceSetProcessor::new();
                    processor.process(&item, decoder, schema)?
                }
                IfcType::IfcFacetedBrep => {
                    let processor = FacetedBrepProcessor::new();
                    processor.process(&item, decoder, schema)?
                }
                IfcType::IfcSweptDiskSolid => {
                    let processor = SweptDiskSolidProcessor::new(schema.clone());
                    processor.process(&item, decoder, schema)?
                }
                IfcType::IfcBooleanClippingResult | IfcType::IfcBooleanResult => {
                    let processor = BooleanClippingProcessor::new();
                    processor.process(&item, decoder, schema)?
                }
                IfcType::IfcRevolvedAreaSolid => {
                    let processor = RevolvedAreaSolidProcessor::new(schema.clone());
                    processor.process(&item, decoder, schema)?
                }
                _ => continue, // Skip unsupported types
            };
            mesh.merge(&item_mesh);
        }

        // Note: MappingTarget transformation is applied by the router's process_mapped_item_cached
        // when MappedItem is encountered through process_representation_item. This processor
        // is a fallback that doesn't have access to the router's transformation logic.

        Ok(mesh)
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcMappedItem]
    }
}

impl Default for MappedItemProcessor {
    fn default() -> Self {
        Self::new()
    }
}
