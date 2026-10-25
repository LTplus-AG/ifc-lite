// SPDX-License-Identifier: MPL-2.0
//! The program's entries: one constructor per reached occurrence kind, each
//! selecting its controller.
use super::{Control, GeometryProgram};
use crate::program::inner_cache::CacheControl;
#[cfg(test)]
use crate::program::item::ItemControl;
use crate::program::layers::LayerControl;
use crate::program::mapping::{MappingControl, Reached};
use crate::program::product::ProductControl;
use crate::program::styled::StyledControl;
use crate::program::voids::VoidControl;
use ifc_lite_core::DecodedEntity;

impl<'a> GeometryProgram<'a> {
    /// The selected processor work for one item, without content-dedup.
    #[cfg(test)]
    pub(crate) fn item(item: &'a DecodedEntity, offset_meters: (f64, f64, f64)) -> Self {
        Self::with_control(Control::Item(item, ItemControl::new(offset_meters)))
    }

    /// One `IfcMappedItem` occurrence: its source walk (nested maps included),
    /// the mapped-item caches and its placement, as source-coords frame parts.
    pub(crate) fn mapped_item(item: &'a DecodedEntity) -> Self {
        Self::with_control(Control::Mapping(MappingControl::occurrence(Reached::Root(item))))
    }

    /// The don't-bake shared registry entry for one source (#1623): the flat
    /// source walk a styled placeholder runs, published instead of placed.
    #[cfg(test)]
    pub(crate) fn shared_mapped_source(representation: &'a DecodedEntity, source_id: u32) -> Self {
        Self::with_control(Control::Mapping(MappingControl::shared_source(representation, source_id)))
    }

    /// One styled representation item appended to `meshes` under its own id:
    /// a plain item, or a mapped item's source walked into per-item sub-meshes
    /// (nested maps included), with the #1623 don't-bake template/placeholder
    /// decision at the top level when `allow_instancing`.
    #[cfg(test)]
    pub(crate) fn styled_item(item: &'a DecodedEntity, meshes: crate::SubMeshCollection, allow_instancing: bool,
        textures: Option<&'a rustc_hash::FxHashMap<u32, crate::ResolvedTextureMap>>,
        offset_meters: (f64, f64, f64)) -> Self {
        let control = MappingControl::styled(Reached::Root(item), meshes, allow_instancing, textures, offset_meters);
        Self::with_control(Control::Mapping(control))
    }

    /// An orphan type's `IfcRepresentationMap` (#957, #961): its items, nested
    /// maps and textured face sets, with its MappingOrigin baked in.
    pub(crate) fn type_map(rep_map: &'a DecodedEntity,
        textures: &'a rustc_hash::FxHashMap<u32, crate::ResolvedTextureMap>) -> Self {
        Self::with_control(Control::Mapping(MappingControl::type_map(rep_map, textures)))
    }

    /// One product's walk merged into placed frame parts (#6349).
    pub(crate) fn product(element: &'a DecodedEntity, hygiene: crate::router::processing::SourceHygiene) -> Self {
        Self::with_control(Control::Product(ProductControl::merged(element, hygiene)))
    }

    /// One product's material-layer slices, or else its walk as placed
    /// per-item sub-meshes; `allow_instancing` gates the #1623 don't-bake
    /// decision, `textures` keeps UVs (#1781).
    pub(crate) fn styled_product(element: &'a DecodedEntity, allow_instancing: bool,
        textures: Option<&'a rustc_hash::FxHashMap<u32, crate::ResolvedTextureMap>>,
        hygiene: crate::router::processing::SourceHygiene) -> Self {
        Self::with_control(Control::Styled(StyledControl::product(element, allow_instancing, textures, hygiene)))
    }

    /// A host's frame parts, each cut by the openings `ids` (none: uncut).
    pub(crate) fn voided(host: &'a DecodedEntity, ids: &'a [u32]) -> Self {
        Self::with_control(Control::Voids(VoidControl::merged(host, ids)))
    }

    /// A voided host's material-layer slices or cut sub-meshes; `ids` are
    /// its openings, empty when it has none.
    pub(crate) fn voided_styled(host: &'a DecodedEntity, ids: &'a [u32]) -> Self {
        Self::with_control(Control::Styled(StyledControl::voided(host, ids)))
    }

    /// The void control alone over a voided host's sub-meshes, or over
    /// already-produced `hosts`.
    #[cfg(test)]
    pub(crate) fn voided_hosts(host: &'a DecodedEntity, ids: &'a [u32],
        hosts: Option<crate::SubMeshCollection>) -> Self {
        Self::with_control(Control::Voids(VoidControl::styled(host, ids, hosts)))
    }

    /// One material-layer attempt with an explicit `buildup`, over the host
    /// cut by `ids`.
    pub(crate) fn material_layers(element: &'a DecodedEntity, buildup: &'a crate::material_layer_index::LayerBuildup,
        ids: &'a [u32]) -> Self {
        Self::with_control(Control::Layers(LayerControl::buildup(element, buildup, ids)))
    }

    /// One representation item wrapped by the content-dedup and hash caches.
    pub(crate) fn representation_item(item: &'a DecodedEntity, offset_meters: (f64, f64, f64)) -> Self {
        Self::with_control(Control::Cache(item, CacheControl::new(offset_meters)))
    }
}
