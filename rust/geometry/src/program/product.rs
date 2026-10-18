// SPDX-License-Identifier: MPL-2.0
//! Ordinary merged/styled item execution. Source remains reached per item;
//! nested mappings use owned child frames and custom processors keep the live decoder.
use super::{ProductProgram, ReachedItem};
use crate::processors::texture::ResolvedTextureMap;
use crate::router::transforms::instancing_enabled;
use crate::{GeometryRouter, Result, SubMeshCollection};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use rustc_hash::FxHashMap;

impl ProductProgram {
    pub(crate) fn merged(
        mut self,
        element: &DecodedEntity,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>,
    ) -> Result<super::resources::MergedParts> {
        // Body representations only ('Axis', 'FootPrint', 'Box' are skipped), and
        // a MappedRepresentation is skipped when direct geometry duplicates it.
        while let Some(ReachedItem { item, fill_only }) = self.next(decoder)? {
            // Process each representation item
            // A mapped item whose source mixes frames yields one mesh per frame (#6446).
            let item_parts = if element.ifc_type == IfcType::IfcAnnotation
                && item.ifc_type == IfcType::IfcAnnotationFillArea
            {
                vec![router.process_annotation_fill(&item, decoder)?]
            } else if fill_only {
                continue; // symbolic annotation item, never meshed (#5389)
            } else if let Some(mesh) =
                router.process_raw_item_for_element(&item, element, decoder)?
            {
                vec![mesh]
            } else {
                router.process_representation_item_parts(&item, decoder)?
            };
            for mesh in item_parts {
                if !mesh.positions.is_empty() {
                    self.merge(mesh, instancing_enabled());
                }
            }
        }
        Ok(self.finish_merged(instancing_enabled()))
    }

    pub(crate) fn styled(
        mut self,
        element: &DecodedEntity,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>,
        allow_instancing: bool,
        texture_index: Option<&FxHashMap<u32, ResolvedTextureMap>>,
    ) -> Result<SubMeshCollection> {
        let mut sub_meshes = SubMeshCollection::new();

        while let Some(ReachedItem { item, fill_only }) = self.next(decoder)? {
            // Process each representation item, preserving geometry IDs
            if element.ifc_type == IfcType::IfcAnnotation
                && item.ifc_type == IfcType::IfcAnnotationFillArea
            {
                sub_meshes.add(item.id, router.process_annotation_fill(&item, decoder)?);
                continue;
            }
            if fill_only {
                continue; // symbolic annotation item, never meshed (#5389)
            }
            // A textured face set keeps its UV channel (#1781) and, like
            // any raw item, rebases in its own frame (#5698). A failed
            // textured build falls through to the untextured paths.
            // A terrain TIN is a face set that only appends `Flags` (#5942).
            let texture = texture_index
                .and_then(|index| index.get(&item.id))
                .filter(|_| {
                    matches!(
                        item.ifc_type,
                        IfcType::IfcTriangulatedFaceSet | IfcType::IfcTriangulatedIrregularNetwork
                    )
                });
            if let Some(map) = texture {
                let offset = router.element_frame_rtc(element, decoder)?;
                if let Some((mesh, uvs)) = router.textured_face_set(&item, decoder, map, offset) {
                    sub_meshes.add_textured(item.id, mesh, uvs, map.attachment());
                    continue;
                }
            }
            if let Some(mesh) = router.process_raw_item_for_element(&item, element, decoder)? {
                if !mesh.is_empty() {
                    sub_meshes.add(item.id, mesh);
                }
                continue;
            }
            router.collect_submeshes_from_item(
                &item,
                decoder,
                &mut sub_meshes,
                allow_instancing,
                texture_index,
            )?;
        }

        Ok(sub_meshes)
    }
}
