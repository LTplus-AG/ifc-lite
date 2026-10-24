// SPDX-License-Identifier: MPL-2.0
//! Product policy shared by the default batch and explicit retained admission.
use super::IfcAPI;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use ifc_lite_geometry::GeometryRouter;
use ifc_lite_processing::element::{plan_type_geometry, ElementJobKind, TypeGeometryMode};

impl IfcAPI {
    pub(super) fn configure_product_material_layers(&self, router: &mut GeometryRouter,
        content: &[u8], decoder: &mut EntityDecoder) {
        if !self.merge_layers() {
            router.set_material_layer_index(self.get_or_build_material_layer_index(content, decoder));
        }
    }
    pub(super) fn canonical_product_job_kind(&self, content: &[u8], entity: &DecodedEntity,
        ifc_type: &IfcType, decoder: &mut EntityDecoder) -> Option<ElementJobKind> {
        if !ifc_type.is_subtype_of(IfcType::IfcTypeProduct) { return Some(ElementJobKind::Product); }
        let referenced = self.get_or_build_referenced_repmaps(content, decoder);
        let instantiated = self.get_or_build_instantiated_type_ids(content, decoder);
        canonical_product_job_kind(entity, ifc_type, &referenced, &instantiated)
    }
}

pub(super) fn canonical_product_job_kind(entity: &DecodedEntity, ifc_type: &IfcType,
    referenced: &rustc_hash::FxHashSet<u32>, instantiated: &rustc_hash::FxHashSet<u32>) -> Option<ElementJobKind> {
    if !ifc_type.is_subtype_of(IfcType::IfcTypeProduct) { return Some(ElementJobKind::Product); }
    let rep_map_ids: Vec<u32> = entity.get(ifc_lite_core::slot::IfcTypeProduct::REPRESENTATION_MAPS.index()).and_then(|a| a.as_list())
        .map(|list| list.iter().filter_map(|v| v.as_entity_ref()).collect()).unwrap_or_default();
    if rep_map_ids.is_empty() { return None; }
    // #957: browser products emit orphan and instanced maps, tagged for the
    // Model/Types switch. Native export uses SuppressInstanced instead.
    let rep_maps = plan_type_geometry(&rep_map_ids, referenced,
        instantiated.contains(&entity.id), TypeGeometryMode::EmitTagged);
    (!rep_maps.is_empty()).then_some(ElementJobKind::TypeProduct { rep_maps })
}

pub(super) fn build_indexed_colour_maps(content: &[u8], decoder: &mut ifc_lite_core::EntityDecoder) -> std::sync::Arc<super::IndexedColourCache> {
    let mut map: rustc_hash::FxHashMap<u32, ifc_lite_processing::style::FullIndexedColourMap> =
        rustc_hash::FxHashMap::default();
    // Fast bail-out for the overwhelming common case: files with no
    // IfcIndexedColourMap pay only a single substring search (SIMD memmem),
    // not a full entity scan + decode, on the first batch of every worker.
    // The empty result is still cached so later batches skip even that.
    if ifc_lite_core::find_keyword(content, b"IFCINDEXEDCOLOURMAP").is_some() {
        let mut scanner = ifc_lite_core::EntityScanner::new(content);
        while let Some((_id, type_name, start, end)) = scanner.next_entity() {
            if ifc_lite_core::keyword_eq(type_name, "IFCINDEXEDCOLOURMAP") {
                if let Ok(icm) = decoder.decode_at(start, end) {
                    if let Some(full) =
                        ifc_lite_processing::style::resolve_indexed_colour_map_full(&icm, decoder)
                    {
                        map.entry(full.geometry_id).or_insert(full);
                    }
                }
            }
        }
    }

    std::sync::Arc::new(super::IndexedColourCache {
        split_guard_ids: ifc_lite_processing::style::indexed_colour_split_guard_ids(&map),
        maps: std::sync::Arc::new(map),
    })
}
