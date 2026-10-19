// SPDX-License-Identifier: MPL-2.0
//! Shared viewer job-kind selection for exact batches and explicit retained products.
use super::IfcAPI;
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};
use ifc_lite_processing::element::{plan_type_geometry, ElementJobKind, TypeGeometryMode};
impl IfcAPI {
    /// Configure a newly created canonical product router. The merge toggle
    /// intentionally disables layer slicing in both exact and retained entries.
    pub(super) fn configure_product_material_layers(&self, router: &mut ifc_lite_geometry::GeometryRouter,
        content: &[u8], decoder: &mut EntityDecoder<'_>) {
        if !self.merge_layers() {
            router.set_material_layer_index(self.get_or_build_material_layer_index(content,decoder));
        }
    }
    pub(super) fn canonical_product_job_kind(&self, content: &[u8], entity: &DecodedEntity,
        ifc_type: &IfcType, decoder: &mut EntityDecoder<'_>) -> Option<ElementJobKind> {
        if !ifc_type.is_subtype_of(IfcType::IfcTypeProduct) { return Some(ElementJobKind::Product); }
        let rep_map_ids: Vec<u32> = entity.attr(slot::IfcTypeProduct::REPRESENTATION_MAPS).and_then(|a|a.as_list())
            .map(|list|list.iter().filter_map(|v|v.as_entity_ref()).collect()).unwrap_or_default();
        if rep_map_ids.is_empty() { return None; }
        let referenced = self.get_or_build_referenced_repmaps(content, decoder);
        let instantiated = self.get_or_build_instantiated_type_ids(content, decoder);
        let rep_maps = plan_type_geometry(&rep_map_ids,&referenced,instantiated.contains(&entity.id),TypeGeometryMode::EmitTagged);
        if rep_maps.is_empty() { return None; }
        Some(ElementJobKind::TypeProduct {rep_maps})
    }
}
