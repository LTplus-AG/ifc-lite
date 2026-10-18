// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::{source::Source, AppearanceItem, AppearanceRequest};
use crate::element::{
    produce_element_meshes_owned, ElementJobKind, ElementMeshJob, OwnedMeshProductionContext,
    MeshProductionOptions,
};
use crate::types::mesh::MeshData;
use ifc_lite_geometry::{ ImageTextureRef, ResolvedTextureMap, TextureSource};
use rustc_hash::FxHashMap;
use std::sync::Arc;

/// Raw tessellation is not the final vertex contract: placement/source welding
/// may merge corners. Run the canonical funnel for BOTH appearances, proving
/// triangle-corner geometry equality before returning a source-to-target binding.
pub(super) fn align_source_corners(
    source: &mut Source<'_>,
    product_id: u32,
    items: &mut [AppearanceItem],
    textures: &Arc<FxHashMap<u32, ResolvedTextureMap>>,
    request: &AppearanceRequest,
) -> Result<(), String> {
    let before = produce(source, product_id, textures, None)?;
    // Clone only selected items' maps; direct eligibility guarantees these are
    // the product's complete Body and no mapped sibling may contribute geometry.
    let replacements = Arc::new(items
        .iter()
        .map(|item| {
            (
                item.geometry_item_id,
                ResolvedTextureMap {
                    texture_id: request.next_express_id,
                    texture: TextureSource::Image(ImageTextureRef {
                        url: request.image_uri.clone(),
                        repeat_s: request.repeat_s,
                        repeat_t: request.repeat_t,
                    }),
                    tex_coords: item
                        .tex_coords
                        .iter()
                        .map(|p| p.map(|v| v as f32))
                        .collect(),
                    tex_coord_index: Some(item.tex_coord_index.clone()),
                },
            )
        })
        .collect());
    let target = source.empty_styles.snapshot(&source.production_model, &replacements);
    let after = produce_with_context(source, product_id, &target, false, false)?;
    // A face-masked conversion leaves one retained face set unmapped; it must
    // survive both passes with identical geometry and no texture binding.
    let retained = source.evaluated_splits.get(&product_id).map(|split| split.retained);
    let expected = items.len() + usize::from(retained.is_some());
    if before.len() != expected || after.len() != expected {
        return Err("Canonical representation was split, combined, or rejected".into());
    }
    if let Some(id) = retained {
        let (old, new) = (one_item(&before, id)?, one_item(&after, id)?);
        if old.positions != new.positions || old.indices != new.indices || old.normals != new.normals
            || old.origin != new.origin || old.uvs.is_some() || new.uvs.is_some() || old.texture.is_some() || new.texture.is_some() {
            return Err("The unmasked face set must keep its source geometry without a texture".into());
        }
    }
    for item in items {
        let old = one_item(&before, item.geometry_item_id)?;
        let new = one_item(&after, item.geometry_item_id)?;
        let uvs = new
            .uvs
            .as_ref()
            .ok_or("Canonical geometry did not attach the planned UVs")?;
        if old.indices.len() != new.indices.len()
            || old.origin != new.origin
            || uvs.len() != new.positions.len() / 3 * 2
            || new.normals.len() != new.positions.len()
            || new.normals.iter().any(|v| !v.is_finite())
        {
            return Err("Canonical geometry changed source corner correspondence".into());
        }
        for (&a, &b) in old.indices.iter().zip(&new.indices) {
            let old_position = corner_position(&old.positions, a)?;
            let new_position = corner_position(&new.positions, b)?;
            if old_position != new_position {
                return Err("Appearance would change canonical triangle geometry".into());
            }
        }
        // UV seams participate in the canonical weld key. Removing a seam can
        // select a different near-coplanar normal representative without moving
        // any triangle. Ship that exact target shading instead of a tolerance.
        item.target_corner_normals = new.indices.iter().flat_map(|&i| {
            let i = i as usize * 3;
            [new.normals[i], new.normals[i + 2], -new.normals[i + 1]]
        }).collect();
        item.source_indices.clone_from(&old.indices);
        item.target_indices.clone_from(&new.indices);
        item.target_vertex_count = new.positions.len() / 3;
        item.preview_corner_uvs = new
            .indices
            .iter()
            .flat_map(|&i| [uvs[i as usize * 2], uvs[i as usize * 2 + 1]])
            .collect();
    }
    Ok(())
}

/// Validate before multiplying indices, including on wasm32. Missing corners
/// must not compare equal and then reach direct normal/UV indexing.
pub(super) fn corner_position(positions: &[f32], index: u32) -> Result<&[f32], String> {
    let index = index as usize;
    if index >= positions.len() / 3 {
        return Err("Canonical geometry produced an out-of-range corner".into());
    }
    Ok(&positions[index * 3..index * 3 + 3])
}

fn one_item(meshes: &[MeshData], id: u32) -> Result<&MeshData, String> {
    let mut matches = meshes
        .iter()
        .filter(|mesh| mesh.geometry_item_id == Some(id));
    let mesh = matches
        .next()
        .ok_or("Canonical representation item is missing")?;
    if matches.next().is_some() {
        return Err("Canonical representation item was split".into());
    }
    Ok(mesh)
}

pub(super) fn produce(
    source: &mut Source<'_>,
    product_id: u32,
    textures: &Arc<FxHashMap<u32, ResolvedTextureMap>>,
    appearance: Option<&super::owned_context::Styles>,
) -> Result<Vec<MeshData>, String> {
    produce_with_frame(source, product_id, textures, appearance, false)
}

/// Evaluate an occurrence in the same placement-independent frame on native
/// and wasm. This is kept separate from ordinary canonical production because
/// authoring previews must retain the target's established output frame.
pub(super) fn produce_evaluated(
    source: &mut Source<'_>,
    product_id: u32,
    textures: &Arc<FxHashMap<u32, ResolvedTextureMap>>,
    appearance: Option<&super::owned_context::Styles>,
) -> Result<Vec<MeshData>, String> {
    produce_with_frame(source, product_id, textures, appearance, true)
}

fn produce_with_frame(
    source: &mut Source<'_>,
    product_id: u32,
    textures: &Arc<FxHashMap<u32, ResolvedTextureMap>>,
    appearance: Option<&super::owned_context::Styles>,
    evaluated: bool,
) -> Result<Vec<MeshData>, String> {
    let styles = appearance.unwrap_or(&source.empty_styles);
    let context = styles.context(&source.production_model, source.production_identity, textures);
    produce_with_context(source, product_id, &context, appearance.is_some(), evaluated)
}

fn produce_with_context(
    source: &mut Source<'_>, product_id: u32, production: &Arc<OwnedMeshProductionContext>,
    resolve_color: bool, evaluated: bool,
) -> Result<Vec<MeshData>, String> {
    let product = source.entity(product_id)?;
    source.validate_world_placement(&product)?;
    let scale = source.decoder.length_unit_scale();
    if !scale.is_finite() || scale <= 0. {
        return Err("Invalid model length unit scale".into());
    }
    let styles = production.borrowed();
    let element_color = resolve_color.then(|| {
        product.get(ifc_lite_core::slot::IfcProduct::REPRESENTATION.index()).and_then(|a| a.as_entity_ref()).and_then(|pds| crate::processor::resolve_element_color_for_product_definition_shape(
            pds, styles.geometry_style_index, &mut source.decoder))
            .or_else(|| styles.element_material_colors.get(&product_id).and_then(|colors| crate::style::element_material_fallback_color(colors)))
    }).flatten();
    let context = source.context.as_ref().ok_or("Missing canonical load context")?;
    if context.layers.is_sliceable(product_id) {
        return Err("Material-layer slicing is unsupported for appearance authoring".into());
    }
    let router = if evaluated { context.evaluated_router() } else { context.router() };
    let produced = produce_element_meshes_owned(
        &ElementMeshJob {
            id: product_id,
            ifc_type: product.ifc_type.clone(),
            entity: &product,
            kind: ElementJobKind::Product,
            element_color,
            metadata: None,
        },
        production,
        &MeshProductionOptions::default(),
        &mut source.decoder,
        &router,
    ).map_err(|error| error.to_string())?;
    if !produced.csg_failures.is_empty() {
        return Err("Canonical geometry reported a processing failure".into());
    }
    Ok(produced.meshes)
}

#[cfg(test)]
#[path = "context_tests.rs"]
mod context_tests;
