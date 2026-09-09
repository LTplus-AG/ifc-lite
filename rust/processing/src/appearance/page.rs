// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::{atlas_plan::{plan_sampled_appearance, AtlasSampler}, page_atlas, page_raster::{composite, Raster}, source::Source, *};
#[cfg(test)]
use super::atlas_plan::encode_png;
#[cfg(test)]
use sha2::{Digest, Sha256};

struct PageSampler<'a> { page: Raster<'a>, triangle: Option<usize>, uv: [[f64; 2]; 3] }
impl AtlasSampler for PageSampler<'_> {
    fn begin_item(&mut self, _: &mut Source<'_>, _: u32, _: &AppearanceItem, _: &[[f64; 3]], _: &[[u32; 3]], _: &crate::types::mesh::MeshData) -> Result<(), String> {
        self.triangle = None; Ok(())
    }
    fn reserve_pixels(&mut self, _: usize) -> Result<(), String> { Ok(()) }
    fn sample(&mut self, item: &AppearanceItem, triangle: usize, weights: [f64; 3], _: bool, background: [f64; 4]) -> Result<[u8; 4], String> {
        if self.triangle != Some(triangle) {
            let indices = item.tex_coord_index.get(triangle).ok_or("Missing projected triangle")?;
            for (i, index) in indices.iter().enumerate() {
                self.uv[i] = *item.tex_coords.get(index.checked_sub(1).ok_or("Zero projected index")? as usize).ok_or("Invalid projected corner")?;
            }
            self.triangle = Some(triangle);
        }
        Ok(composite(self.page, page_atlas::interpolate(self.uv, weights), background))
    }
}
/// Finite page composition shares target appearance preservation, charts and
/// canonical IFC image/material planning with other surface samplers.
pub fn plan_page_appearance(bytes: &[u8], request: &PageAppearanceRequest, rgba: &[u8]) -> Result<PageAppearancePlan, String> {
    let spec = &request.appearance;
    if spec.product_ids.is_empty() { return Err("Appearance scope must contain 1..10000 products".into()); }
    if !matches!(spec.mapping, Mapping::Planar { .. }) || spec.repeat_s || spec.repeat_t {
        return Err("Page appearance requires non-repeating planar mapping".into());
    }
    let page = Raster::supplied(&request.page, rgba)?;
    let mut sampler = PageSampler { page, triangle: None, uv: [[0.; 2]; 3] };
    plan_sampled_appearance(bytes, spec, &request.source_images, rgba, request.texels_per_metre, &mut sampler)
}

#[cfg(test)]
#[path = "page_tests.rs"]
mod tests;
