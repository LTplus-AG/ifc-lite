// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The router's surface-texture channel (#961, #1781): texture-aware
//! representation-map tessellation (orphan type geometry) and the textured
//! occurrence sub-mesh entry point. Split from `processing.rs` so the main
//! element pipeline stays within the module-size house rule; the texture
//! index itself is built in `crate::processors::texture`.

use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix4;

use super::frame_parts::{single_frame_source, SourceParts};
use super::GeometryRouter;
use crate::processors::texture::TextureAttachment;
use crate::program::mapping_budget::{LogicalBudget, SourceResult};
use crate::{Error, Mesh, Result, SubMeshCollection};

/// The accounted header admission for one retained UV-carrying part, out of line.
#[cold]
#[inline(never)]
pub(crate) fn admit_textured_part<T>(textured: &mut Vec<T>) -> Result<()> {
    crate::resource::reserve_headers(textured, 1)?.retain();
    Ok(())
}
/// One textured item of a type's map: its own part, UVs and image (#961).
pub(crate) type TexturedPart = (Mesh, Vec<f32>, TextureAttachment);
/// A type map's render parts: textured ones carry their UVs and image.
pub(crate) type TypeParts = Vec<(Mesh, Vec<f32>, Option<TextureAttachment>)>;

impl GeometryRouter {
    /// Texture-aware [`Self::process_element_with_submeshes`] (#1781): a face
    /// set listed in `texture_index` becomes its own textured sub-mesh carrying
    /// per-vertex UVs + the texture attachment. The void path never passes an
    /// index — a CSG cut rebuilds vertices, which would orphan the UVs, so a
    /// voided textured element renders with its style colour instead.
    pub fn process_element_with_submeshes_textured(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        texture_index: &rustc_hash::FxHashMap<u32, crate::processors::texture::ResolvedTextureMap>,
    ) -> Result<SubMeshCollection> {
        let textures = if texture_index.is_empty() {
            None
        } else {
            Some(texture_index)
        };
        self.process_element_with_submeshes_impl(
            element,
            decoder,
            true,
            textures,
            super::processing::SourceHygiene::Watertight,
        )
    }

    /// Tessellate an `IfcRepresentationMap`'s `MappedRepresentation` and bake
    /// its `MappingOrigin` placement (issue #957).
    ///
    /// Used to render geometry that hangs off an `IfcTypeProduct` (e.g.
    /// `IfcBoilerType`) through its `RepresentationMaps` when no occurrence
    /// instantiates it — the buildingSMART annex-E "tessellated shape with
    /// style" samples ship exactly this shape (geometry on the type, declared
    /// via `IfcRelDeclares`, with no product instance).
    ///
    /// Unlike [`Self::process_mapped_item_cached`], this applies `MappingOrigin`
    /// (`IfcRepresentationMap` attr 0) rather than a `MappingTarget`: there is
    /// no occurrence placement and no `IfcMappedItem` to carry one, so the
    /// MappingOrigin axis placement is the only transform. It is the caller's
    /// responsibility to only invoke this for orphan representation maps so
    /// normally-instanced typed products aren't double-rendered.
    ///
    /// Errors when the map's items cannot share one f64 frame (#6446); use
    /// [`Self::process_representation_map_with_texture`] to keep such a map
    /// at full precision.
    pub fn process_representation_map(
        &self,
        rep_map: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Mesh> {
        let empty = rustc_hash::FxHashMap::default();
        let parts = self.process_representation_map_with_texture(rep_map, decoder, &empty)?;
        let mut mesh = SourceParts::default();
        for (part, _uvs, _texture) in parts {
            mesh.merge(&part);
        }
        single_frame_source("IfcRepresentationMap", rep_map.id, mesh.into_parts()?)
    }

    /// Texture-aware variant of [`Self::process_representation_map`] (issue
    /// #961). Returns one render part per output mesh: each textured
    /// `IfcTriangulatedFaceSet` item becomes its OWN part carrying its UVs +
    /// decoded image (so a representation with several differently-textured
    /// items renders each with the correct image), and all untextured items are
    /// merged into a single part with empty UVs / no texture, except that
    /// untextured items in frames at least 1 km apart stay separate untextured
    /// parts (#6446). The MappingOrigin placement is baked into every part.
    pub fn process_representation_map_with_texture(
        &self,
        rep_map: &DecodedEntity,
        decoder: &mut EntityDecoder,
        texture_index: &rustc_hash::FxHashMap<u32, crate::processors::texture::ResolvedTextureMap>,
    ) -> Result<Vec<(Mesh, Vec<f32>, Option<TextureAttachment>)>> {
        crate::program::GeometryProgram::type_map(rep_map, texture_index).drain_type_parts(self, decoder)
    }

    /// Admit a type's representation map for the type-map walk: its
    /// `MappedRepresentation` and that representation's whole Items list.
    pub(crate) fn admit_type_map(&self, rep_map: &DecodedEntity, decoder: &mut EntityDecoder,
        budget: &mut LogicalBudget) -> SourceResult<(DecodedEntity, Vec<DecodedEntity>)> {
        let mapped_rep_attr = rep_map.get(slot::IfcRepresentationMap::MAPPED_REPRESENTATION.index())
            .ok_or_else(|| Error::geometry("RepresentationMap missing MappedRepresentation".to_string()))?;
        let mapped_rep = decoder
            .resolve_ref(mapped_rep_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve MappedRepresentation".to_string()))?;
        let items_attr = mapped_rep
            .get(slot::IfcRepresentation::ITEMS.index())
            .ok_or_else(|| Error::geometry("Representation missing Items".to_string()))?;
        budget.materialize_items(items_attr.as_list().map_or(0, |items| items.len()))?;
        let items = decoder.resolve_ref_list(items_attr)?;
        Ok((mapped_rep, items))
    }

    /// The map's `MappingOrigin` (IfcAxis2Placement3D), scaled: the only 3D
    /// transform of type geometry. Read after the last item, as it always was.
    pub(crate) fn type_map_origin(&self, rep_map: &DecodedEntity, decoder: &mut EntityDecoder)
        -> Result<Option<Matrix4<f64>>> {
        Ok(match rep_map.get(slot::IfcRepresentationMap::MAPPING_ORIGIN.index()) {
            Some(origin_attr) if !origin_attr.is_null() => match decoder.resolve_ref(origin_attr)? {
                Some(origin) if origin.ifc_type == IfcType::IfcAxis2Placement3D => {
                    let mut transform = self.parse_axis2_placement_3d(&origin, decoder)?;
                    self.scale_transform(&mut transform);
                    Some(transform)
                }
                _ => None,
            },
            _ => None,
        })
    }

    /// Bake the MappingOrigin into every part of a walked map: textured parts
    /// first, each with its own image, then the untextured frame parts. UVs are
    /// 2D and unaffected. Same sliver hygiene as the other mesh-output
    /// chokepoints; `clean_degenerate` edits only indices, so a part's
    /// parallel per-vertex UV array stays in sync.
    pub(crate) fn finish_type_map(&self, untextured: SourceParts, textured: Vec<TexturedPart>,
        origin: Option<&Matrix4<f64>>) -> Result<TypeParts> {
        let mut out: TypeParts = Vec::new();
        for (mut mesh, uvs, texture) in textured {
            if let Some(origin) = origin {
                self.transform_mesh_local(&mut mesh, origin);
            }
            mesh.clean_degenerate();
            out.push((mesh, uvs, Some(texture)));
        }
        for mut mesh in untextured.into_parts()?.into_iter().filter(|mesh| !mesh.is_empty()) {
            if let Some(origin) = origin {
                self.transform_mesh_local(&mut mesh, origin);
            }
            mesh.clean_degenerate();
            out.push((mesh, Vec::new(), None));
        }
        Ok(out)
    }
}
