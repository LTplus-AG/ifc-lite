// SPDX-License-Identifier: MPL-2.0
//! Owned, unresolved appearance inputs. These are obligations, not display output.
use crate::{resource, GeometryRouter, ResolvedTextureMap, Result};
use std::sync::Arc;

/// An ordered source/occurrence binding. IFC colours, indexed palette splitting,
/// UV evaluation and final material resolution still belong to presentation.
/// Geometry and style identities must survive even when no mesh is produced.
#[derive(Debug, Clone)]
pub struct RetainedPresentation {
    pub geometry_id: u32,
    pub style_source_id: u32,
    pub representation_map: Option<u32>,
    pub type_product: Option<(u32,u8)>,
    pub fallback_color:Option<[f32;4]>,
    pub template: bool,
    pub placeholder: bool,
    pub indexed_palette_pending: bool,
    pub texture_pending: Option<Arc<ResolvedTextureMap>>,
}
impl RetainedPresentation {
    pub(super) fn item(id: u32, router: &GeometryRouter, texture: Option<&ResolvedTextureMap>) -> Result<Self> {
        let texture_pending = match texture {
            Some(texture) => {
                // Own only the reached texture. Image/string backing is immutable
                // and charged conservatively before cloning; never borrow an index.
                let bytes = texture.tex_coords.len().checked_mul(std::mem::size_of::<[f32;2]>())
                    .and_then(|n| texture.tex_coord_index.as_ref().map_or(Some(n), |v|
                        v.len().checked_mul(std::mem::size_of::<[u32;3]>()).and_then(|m| n.checked_add(m))))
                    .ok_or_else(resource::overflow)?;
                let bytes=bytes.checked_add(std::mem::size_of::<ResolvedTextureMap>())
                    .and_then(|n|match &texture.texture {
                        crate::processors::texture::TextureSource::Image(image)=>n.checked_add(image.url.len()),
                        _=>Some(n),
                    }).ok_or_else(resource::overflow)?;
                resource::charge(resource::Cost { copy_bytes: bytes as u64,
                    live_bytes: bytes as u64, work: 1, ..Default::default() })?.retain();
                Some(Arc::new(texture.clone()))
            }
            None => None,
        };
        Ok(Self { geometry_id: id, style_source_id: id, representation_map: None,
            type_product:None,fallback_color:None,template: true, placeholder: false,
            indexed_palette_pending: router.is_indexed_colour_split_source(id), texture_pending })
    }
    pub(super) fn occurrence(item: u32, source: u32, solid: Option<u32>, template: bool) -> Self {
        Self { geometry_id: solid.unwrap_or(item), style_source_id: item,
            representation_map: Some(source), type_product:None,fallback_color:None,template, placeholder: solid.is_some() && !template,
            indexed_palette_pending: false, texture_pending: None }
    }
}
impl PartialEq for RetainedPresentation {
    fn eq(&self, other: &Self) -> bool {
        self.geometry_id == other.geometry_id && self.style_source_id == other.style_source_id
            && self.type_product==other.type_product && self.fallback_color==other.fallback_color
            && self.representation_map == other.representation_map && self.template == other.template
            && self.placeholder == other.placeholder && self.indexed_palette_pending == other.indexed_palette_pending
            && match (&self.texture_pending, &other.texture_pending) {
                (None,None) => true, (Some(a),Some(b)) => Arc::ptr_eq(a,b), _ => false,
            }
    }
}
