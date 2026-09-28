// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5984: the IFC-authored finish (#5582) of an already PRODUCED mesh.
//!
//! `MeshData` carries no finish (a new pub field on it is a semver major), so
//! every consumer that gets meshes after production joins the finish on
//! afterwards: the wasm batch, its instanced (IFNS) occurrences, and the
//! server's JSON and Parquet transports. They all join here, once.
//!
//! THE RULE: a mesh's finish comes from the style its colour came from, never
//! from another. So the join asks the colour walks themselves which styled
//! item the colour was taken from (`crate::element`'s style-source walks), in
//! the same precedence mesh production applies (`resolve_submesh_color`):
//!
//! 1. **Item level.** The mesh's representation item, directly styled or
//!    reaching a styled item through the bounded `IfcMappedItem` chase
//!    (`find_geometry_item_color`). A hit decides: the finish is that item's,
//!    or none when its style authors none (a fill-only style).
//! 2. **Element level**, when the item resolved nothing and the colour fell
//!    back to the element's: the element's own style source. For a product
//!    that is its `IfcProductDefinitionShape` walk; for a type product (#957
//!    type geometry, no item id on its meshes) each `IfcRepresentationMap` in
//!    order, which is where a finish authored only on a type's
//!    representation map is reached. A fallback candidate is accepted only
//!    when its style's colour IS the mesh's colour: the element-level colour
//!    competes with the material chain and the type default, both colour-only,
//!    and the mesh does not record which one won. The equality is what tells
//!    them apart, and for a type with several maps it is what pairs each mesh
//!    with its own map. Its one blind spot is a material colour bit-identical
//!    to the element's style colour, which renders identically anyway.
//!
//! `finishes` is [`crate::prepass::resolve_geometry_finishes`]'s index (the
//! wasm host's `setStyleFinishes` wire decodes to the same map), keyed by
//! styled geometry item. `style_color` is the colour index's lookup by the
//! same key: its membership decides where each walk stops, exactly as the
//! colour walks stop, and its colour is what the fallback compares against.

use crate::prepass::{resolve_geometry_finishes, PrepassSpans};
use crate::style::{GeometryStyleInfo, SpecularMaterial};
use crate::types::mesh::MeshData;
use ifc_lite_core::{EntityDecoder, EntityIndex, EntityScanner, IfcType};
use rustc_hash::FxHashMap;

/// Element id → its element-level style-source candidates, in colour order.
type ElementSources = FxHashMap<u32, Vec<u32>>;

/// The join itself (see the module doc for the rule). `element_sources`
/// memoises step 2 per element: a type product or a multi-part product has
/// many meshes and one set of candidates.
fn join_finish(
    express_id: u32,
    geometry_item_id: Option<u32>,
    color: [f32; 4],
    style_color: &dyn Fn(u32) -> Option<[f32; 4]>,
    finishes: &FxHashMap<u32, SpecularMaterial>,
    element_sources: &mut ElementSources,
    decoder: &mut EntityDecoder,
) -> Option<SpecularMaterial> {
    if finishes.is_empty() {
        return None;
    }
    let has_style = |id: u32| style_color(id).is_some();
    let finish_of = |source: u32| {
        finishes
            .get(&source)
            .copied()
            .filter(|f| f.metallic.is_some() || f.roughness.is_some())
    };
    if let Some(item) = geometry_item_id {
        if let Some(source) = crate::element::find_geometry_item_style_source(item, &has_style, decoder) {
            return finish_of(source);
        }
    }
    let candidates = element_sources
        .entry(express_id)
        .or_insert_with(|| element_style_sources(express_id, &has_style, decoder));
    candidates
        .iter()
        .find(|&&source| style_color(source) == Some(color))
        .and_then(|&source| finish_of(source))
}

/// Step 2's candidates for one element: every representation map of a type
/// product (in `RepresentationMaps` order, as `produce_type_geometry` renders
/// them), or the one product-shape source of a product. Attribute 6 is
/// `RepresentationMaps` on `IfcTypeProduct` and `Representation` on
/// `IfcProduct`.
fn element_style_sources(
    express_id: u32,
    has_style: &dyn Fn(u32) -> bool,
    decoder: &mut EntityDecoder,
) -> Vec<u32> {
    let Ok(entity) = decoder.decode_by_id(express_id) else {
        return Vec::new();
    };
    if entity.ifc_type.is_subtype_of(IfcType::IfcTypeProduct) {
        return entity
            .get_refs(6)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|rep_map| crate::element::representation_map_style_source(rep_map, has_style, decoder))
            .collect();
    }
    entity
        .get_ref(6)
        .and_then(|shape| crate::element::product_shape_style_source(shape, has_style, decoder))
        .into_iter()
        .collect()
}

/// The finish join over caller-held indexes: the wasm batch, which already
/// holds its colour index (as `id -> rgba`) and the installed finishes, and
/// decodes through its own per-batch decoder.
pub struct MeshFinishJoin<'a> {
    finishes: &'a FxHashMap<u32, SpecularMaterial>,
    style_color: Box<dyn Fn(u32) -> Option<[f32; 4]> + 'a>,
    element_sources: ElementSources,
}

impl<'a> MeshFinishJoin<'a> {
    /// `style_color(id)` is the colour index's entry for styled geometry
    /// item `id` (`None` when it has no style).
    pub fn new(
        finishes: &'a FxHashMap<u32, SpecularMaterial>,
        style_color: impl Fn(u32) -> Option<[f32; 4]> + 'a,
    ) -> Self {
        Self { finishes, style_color: Box::new(style_color), element_sources: ElementSources::default() }
    }

    /// The finish of the mesh (or instanced occurrence) with this element,
    /// source item and colour. `None` when nothing authored one.
    pub fn finish(
        &mut self,
        express_id: u32,
        geometry_item_id: Option<u32>,
        color: [f32; 4],
        decoder: &mut EntityDecoder,
    ) -> Option<SpecularMaterial> {
        join_finish(
            express_id,
            geometry_item_id,
            color,
            &*self.style_color,
            self.finishes,
            &mut self.element_sources,
            decoder,
        )
    }

    /// [`Self::finish`] for a produced mesh.
    pub fn finish_for_mesh(&mut self, mesh: &MeshData, decoder: &mut EntityDecoder) -> Option<SpecularMaterial> {
        self.finish(mesh.express_id, mesh.geometry_item_id, mesh.color, decoder)
    }
}

/// The finish join resolved from a file's bytes alone, for a consumer that
/// holds nothing but the file and its produced meshes (the server's
/// transports). One scan collects the styled items and the entity index; the
/// colour index is the pipeline's own (`resolve_styled_items_into`, every
/// styled item resolved, as the finished pipeline has them) and the finish
/// index is the one the wasm prepass ships.
pub struct ModelFinishes<'c> {
    decoder: EntityDecoder<'c>,
    geometry_styles: FxHashMap<u32, GeometryStyleInfo>,
    finishes: FxHashMap<u32, SpecularMaterial>,
    element_sources: ElementSources,
}

impl<'c> ModelFinishes<'c> {
    pub fn from_content(content: &'c [u8]) -> Self {
        let mut spans = PrepassSpans::default();
        let mut index = EntityIndex::default();
        let mut scanner = EntityScanner::new(content);
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            index.insert(id, (start, end));
            spans.stash(type_name, id, start, end);
        }
        let mut decoder = EntityDecoder::with_index(content, index);
        let finishes = resolve_geometry_finishes(&spans.styled_items, &mut decoder);
        let mut geometry_styles = FxHashMap::default();
        if !finishes.is_empty() {
            crate::prepass::resolve_styled_items_into(
                &spans.styled_items,
                &mut decoder,
                false,
                &mut FxHashMap::default(),
                &mut geometry_styles,
                &mut Vec::new(),
            );
        }
        Self { decoder, geometry_styles, finishes, element_sources: ElementSources::default() }
    }

    /// Whether the file authors no finish at all (every join is then `None`).
    pub fn is_empty(&self) -> bool {
        self.finishes.is_empty()
    }

    /// The finish `mesh` carries, by the module's rule.
    pub fn finish_for_mesh(&mut self, mesh: &MeshData) -> Option<SpecularMaterial> {
        let styles = &self.geometry_styles;
        join_finish(
            mesh.express_id,
            mesh.geometry_item_id,
            mesh.color,
            &|id| styles.get(&id).map(|s| s.color),
            &self.finishes,
            &mut self.element_sources,
            &mut self.decoder,
        )
    }
}

#[cfg(test)]
#[path = "finish_join_tests.rs"]
mod tests;
