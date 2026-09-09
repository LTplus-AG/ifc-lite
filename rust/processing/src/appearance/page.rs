// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::{page_atlas::{self, AtlasInput}, page_raster::Raster, source::Source, *};
use ifc_lite_geometry::TextureSource;
use std::collections::{BTreeMap, BTreeSet};
use sha2::{Digest, Sha256};

/// Project one finite page across selected objects, preserving original sampled
/// albedo outside the page. Atlas resampling changes texture pixels, never mesh
/// positions/triangles. Input/output/work limits refuse rather than downsample.
pub fn plan_page_appearance(bytes: &[u8], request: &PageAppearanceRequest, rgba: &[u8]) -> Result<PageAppearancePlan, String> {
    let spec = &request.appearance;
    if !matches!(spec.mapping, Mapping::Planar { .. }) || spec.repeat_s || spec.repeat_t {
        return Err("Page appearance requires non-repeating planar mapping".into());
    }
    if !request.texels_per_metre.is_finite() || request.texels_per_metre <= 0. || request.texels_per_metre > 16_384.
        || rgba.len() > 128 * 1024 * 1024 || request.source_images.len() > 10_000 {
        return Err("Page raster input or texel density exceeds its budget".into());
    }
    let page = Raster::supplied(&request.page, rgba)?;
    let mut supplied = BTreeMap::new();
    for image in &request.source_images {
        let pixels = Raster::supplied(&image.raster, rgba)?;
        if image.image_uri.is_empty() || image.image_uri.len() > 4096 || supplied.insert(image.image_uri.as_str(), pixels).is_some() {
            return Err("Source rasters need distinct bounded IFC image URIs".into());
        }
    }
    let mut plan = plan_appearance(bytes, spec)?;
    let mut source = Source::new(bytes)?;
    texture_budget::preflight(&mut source)?;
    let textures = ifc_lite_geometry::build_texture_index(bytes, &mut source.decoder);
    let styles = page_source::appearance(bytes, &mut source);
    let scale = source.decoder.length_unit_scale();
    let extra = plan.items.len().checked_mul(3).ok_or("Page entity capacity overflow")?;
    if u64::from(plan.next_available_express_id) + extra as u64 >= u64::from(u32::MAX) {
        return Err("Page entity capacity exceeded".into());
    }
    let corners: usize = plan.items.iter().map(|item| item.tex_coord_index.len() * 3).sum();
    if corners > 500_000 { return Err("Page atlas exceeds 500000 UV corners; choose fewer objects".into()); }
    let mut remaining = page_atlas::MAX_PIXELS;
    let mut output_bytes = 0;
    let mut assets = Vec::new();
    let mut image_uris = BTreeSet::new();
    let mut item_images = Vec::new();
    let mut start = 0;
    while start < plan.items.len() {
        let product = plan.items[start].product_id;
        let count = plan.items[start..].iter().take_while(|item| item.product_id == product).count();
        let original = canonical::produce(&mut source, product, &textures, Some(&styles))?;
        for item in &mut plan.items[start..start + count] {
            let matching: Vec<_> = original.iter().filter(|mesh| mesh.geometry_item_id == Some(item.geometry_item_id)).collect();
            if matching.len() != 1 { return Err("Page source appearance was split or missing; per-face palettes require a split-aware atlas".into()); }
            let mesh = matching[0];
            if mesh.color.iter().any(|v| !v.is_finite()) { return Err("Source albedo is non-finite".into()); }
            if source.incoming.get(&item.geometry_item_id).is_some_and(|ids| ids.iter().any(|id|
                source.types.get(id) == Some(&IfcType::IfcPresentationLayerWithStyle))) {
                return Err("Page appearance does not yet preserve presentation-layer style overrides".into());
            }
            let entity = source.entity(item.geometry_item_id)?;
            let coordinates = source.entity(entity.get_ref(0).ok_or("Missing source coordinates")?)?;
            let points = mapping::rows::<3>(coordinates.get(0))?;
            let triangles = mapping::triangles(entity.get(3), points.len())?;
            let old = textures.get(&item.geometry_item_id);
            if old.is_none() && mesh.color[3] > 0. && mesh.color[3] < 1. {
                return Err("Page projection cannot yet preserve a translucent untextured surface".into());
            }
            if old.is_some() != mesh.texture.is_some() { return Err("Source texture could not be attached canonically".into()); }
            let old_indices = old.map(|map| map.tex_coord_index.as_deref().unwrap_or(&triangles));
            if old.is_some_and(|map| map.tex_coords.iter().flatten().any(|v| !v.is_finite())) {
                return Err("Source texture coordinates are non-finite".into());
            }
            let old_raster = match old.map(|map| &map.texture) {
                Some(TextureSource::Decoded(image)) => Some((Raster::new(image.width, image.height, &image.rgba)?, [image.repeat_s, image.repeat_t])),
                Some(TextureSource::Image(image)) => Some((*supplied.get(image.url.as_str())
                    .ok_or_else(|| format!("Missing pixels for source IFC texture #{}", old.unwrap().texture_id))?, [image.repeat_s, image.repeat_t])),
                None => None,
            };
            let atlas = page_atlas::bake(AtlasInput {
                positions: &points, triangles: &triangles, page_uv: &item.tex_coords,
                page_indices: &item.tex_coord_index,
                old_uv: old.zip(old_indices).map(|(map, indices)| (map.tex_coords.as_slice(), indices)),
                old_raster, color: mesh.color, metres_per_unit: scale,
                density: request.texels_per_metre, page,
            }, &mut remaining)?;
            let png = encode_png(&atlas, 96 * 1024 * 1024 - output_bytes)?;
            let uri = format!("textures/{:x}.png", Sha256::digest(&png));
            if image_uris.insert(uri.clone()) {
                output_bytes += png.len();
                assets.push(AppearanceGeneratedImage { image_uri: uri.clone(), width: atlas.width, height: atlas.height, png });
            }
            item_images.push(AppearanceItemImage { geometry_item_id: item.geometry_item_id, image_uri: uri });
            item.tex_coords = atlas.uv;
            item.tex_coord_index = (0..triangles.len() as u32).map(|i| [i * 3 + 1, i * 3 + 2, i * 3 + 3]).collect();
        }
        canonical::align_source_corners(&mut source, product, &mut plan.items[start..start + count], &textures, spec)?;
        start += count;
    }
    bind_images(&mut plan, &item_images, &source)?;
    Ok(PageAppearancePlan { plan, item_images, assets, texels_per_metre: request.texels_per_metre })
}
fn encode_png(atlas: &page_atlas::Atlas, limit: usize) -> Result<Vec<u8>, String> {
    struct Bounded { bytes: Vec<u8>, limit: usize }
    impl std::io::Write for Bounded {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
                return Err(std::io::Error::other("Page PNG output budget exceeded"));
            }
            self.bytes.extend_from_slice(bytes); Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }
    let mut output = Bounded { bytes: Vec::new(), limit };
    let mut encoder = png::Encoder::new(&mut output, atlas.width, atlas.height);
    encoder.set_color(png::ColorType::Rgba); encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header().map_err(|e| e.to_string())?.write_image_data(&atlas.rgba).map_err(|e| e.to_string())?;
    Ok(output.bytes)
}
fn bind_images(plan: &mut AppearancePlan, images: &[AppearanceItemImage], source: &Source<'_>) -> Result<(), String> {
    if images.is_empty() { return Ok(()); }
    let master_image = plan.created.iter().find(|e| e.r#type == "IfcImageTexture").ok_or("Missing planned image")?.clone();
    let master_textures = plan.created.iter().find(|e| e.r#type == "IfcSurfaceStyleWithTextures").ok_or("Missing planned textures")?.clone();
    let master_style = plan.created.iter().find(|e| e.r#type == "IfcSurfaceStyle").ok_or("Missing planned style")?.clone();
    for (index, image) in images.iter().enumerate() {
        let mut attributes = master_image.attributes.clone(); attributes[5] = json!(image.image_uri);
        let (image_id, style_id) = if index == 0 {
            plan.created.iter_mut().find(|e| e.express_id == master_image.express_id).unwrap().attributes = attributes;
            (master_image.express_id, master_style.express_id)
        } else {
            let image_id = add(plan, "IfcImageTexture", attributes);
            let texture_id = add(plan, "IfcSurfaceStyleWithTextures", vec![json!([reference(image_id)])]);
            let mut attributes = master_style.attributes.clone();
            let list = attributes[2].as_array_mut().ok_or("Invalid style wire values")?;
            for value in list { if *value == reference(master_textures.express_id) { *value = reference(texture_id); } }
            (image_id, add(plan, "IfcSurfaceStyle", attributes))
        };
        let item = plan.items.iter().find(|i| i.geometry_item_id == image.geometry_item_id).ok_or("Missing planned item")?;
        let map = plan.created.iter_mut().find(|e| e.r#type == "IfcIndexedTriangleTextureMap" && e.attributes[1] == reference(image.geometry_item_id)).ok_or("Missing planned UV map")?;
        map.attributes[0] = json!([reference(image_id)]); map.attributes[3] = json!(item.tex_coord_index);
        let list_ref = map.attributes[2].clone();
        let list = plan.created.iter_mut().find(|e| reference(e.express_id) == list_ref).ok_or("Missing planned UV list")?;
        list.attributes[0] = json!(item.tex_coords);
        let old_styled = source.styled_items.get(&image.geometry_item_id).and_then(|ids| ids.first());
        for edit in &mut plan.edits {
            if Some(&edit.express_id) == old_styled && edit.index == 1 {
                replace_style(&mut edit.value, master_style.express_id, style_id)?;
            }
        }
        for entity in &mut plan.created {
            if entity.r#type == "IfcStyledItem" && entity.attributes[0] == reference(image.geometry_item_id) {
                replace_style(&mut entity.attributes[1], master_style.express_id, style_id)?;
            }
        }
    }
    Ok(())
}
fn replace_style(value: &mut Value, old: u32, new: u32) -> Result<(), String> {
    for v in value.as_array_mut().ok_or("Invalid style list")? { if *v == reference(old) { *v = reference(new); } }
    Ok(())
}

#[cfg(test)]
#[path = "page_tests.rs"]
mod tests;
