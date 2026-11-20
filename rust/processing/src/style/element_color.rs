// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_core::{DecodedEntity, EntityDecoder};
use ifc_lite_geometry::representation::product_shape_id;
use rustc_hash::FxHashMap;

/// Resolve a browser prepass colour without copying its flat style map (#7782).
///
/// Geometry-item styles win over the element-keyed material/type fallback.
/// The canonical style-source walk preserves document order, lenient reference
/// decoding and bounded mapped-item traversal, and also supplies native finish
/// provenance. Missing representations must still reach the material fallback.
/// Indexed palettes are resolved by the prepass and mesh producer, not here.
pub fn resolve_element_color(
    entity: &DecodedEntity,
    geometry_styles: &FxHashMap<u32, [f32; 4]>,
    decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    resolve_element_style(entity, geometry_styles, decoder).map(|(color, _)| color)
}

/// [`resolve_element_color`] and the styled item it took the colour from, from
/// the same walk (#10698): the product shape's first styled item, else a style
/// keyed by the element itself. Pass the source to
/// [`produce_element_meshes_owned_styled`] with the colour, so a mesh that
/// falls back to the element colour takes that item's finish and no other.
///
/// [`produce_element_meshes_owned_styled`]: crate::element::produce_element_meshes_owned_styled
pub fn resolve_element_style(
    entity: &DecodedEntity,
    geometry_styles: &FxHashMap<u32, [f32; 4]>,
    decoder: &mut EntityDecoder,
) -> Option<([f32; 4], crate::element::StyleSource)> {
    if geometry_styles.is_empty() {
        return None;
    }
    product_shape_id(entity)
        .and_then(|shape| {
            crate::element::product_shape_style_source(
                shape, &|id| geometry_styles.contains_key(&id), decoder,
            )
        })
        .or_else(|| geometry_styles.contains_key(&entity.id).then_some(entity.id))
        .and_then(|source| geometry_styles.get(&source).map(|&color| (color, crate::element::StyleSource::Style(source))))
}

#[cfg(test)]
#[path = "element_color_tests.rs"]
mod tests;
