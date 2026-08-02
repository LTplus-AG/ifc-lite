// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The router's surface-texture channel (#961, #1781): texture-aware
//! representation-map tessellation (orphan type geometry) and the textured
//! occurrence sub-mesh entry point. Split from `processing.rs` so the main
//! element pipeline stays within the module-size house rule; the texture
//! index itself is built in `crate::processors::texture`.

use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

use super::GeometryRouter;
use crate::{Error, Mesh, Result, SubMeshCollection};

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
        self.process_element_with_submeshes_impl(element, decoder, true, textures)
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
    pub fn process_representation_map(
        &self,
        rep_map: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Mesh> {
        let empty = rustc_hash::FxHashMap::default();
        let parts = self.process_representation_map_with_texture(rep_map, decoder, &empty)?;
        let mut mesh = Mesh::new();
        for (part, _uvs, _texture) in parts {
            mesh.merge(&part);
        }
        Ok(mesh)
    }

    /// Texture-aware variant of [`Self::process_representation_map`] (issue
    /// #961). Returns one render part per output mesh: each textured
    /// `IfcTriangulatedFaceSet` item becomes its OWN part carrying its UVs +
    /// decoded image (so a representation with several differently-textured
    /// items renders each with the correct image), and all untextured items are
    /// merged into a single part with empty UVs / no texture. The MappingOrigin
    /// placement is baked into every part.
    pub fn process_representation_map_with_texture(
        &self,
        rep_map: &DecodedEntity,
        decoder: &mut EntityDecoder,
        texture_index: &rustc_hash::FxHashMap<u32, crate::processors::texture::ResolvedTextureMap>,
    ) -> Result<
        Vec<(
            Mesh,
            Vec<f32>,
            Option<crate::processors::texture::TextureAttachment>,
        )>,
    > {
        // attr 1: MappedRepresentation (IfcShapeRepresentation)
        let mapped_rep_attr = rep_map.get(1).ok_or_else(|| {
            Error::geometry("RepresentationMap missing MappedRepresentation".to_string())
        })?;
        let mapped_rep = decoder
            .resolve_ref(mapped_rep_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve MappedRepresentation".to_string()))?;

        // attr 3: Items
        let items_attr = mapped_rep
            .get(3)
            .ok_or_else(|| Error::geometry("Representation missing Items".to_string()))?;
        let items = decoder.resolve_ref_list(items_attr)?;

        let mut untextured = Mesh::new();
        // One entry per textured item — keeps each item with its own image.
        let mut textured: Vec<(
            Mesh,
            Vec<f32>,
            crate::processors::texture::TextureAttachment,
        )> = Vec::new();
        for item in items {
            // A nested IfcMappedItem inside a type's own representation: process
            // it (applies its MappingTarget) rather than dropping its geometry.
            if item.ifc_type == IfcType::IfcMappedItem {
                if let Ok(sub_mesh) = self.process_mapped_item_cached(&item, decoder) {
                    untextured.merge(&sub_mesh); // already scaled inside the cached path
                }
                continue;
            }

            // Textured tessellated face set → its own part with per-vertex UVs (#961).
            if item.ifc_type == IfcType::IfcTriangulatedFaceSet {
                if let Some(map) = texture_index.get(&item.id) {
                    let proc = crate::processors::TriangulatedFaceSetProcessor::new();
                    if let Ok((mut sub_mesh, sub_uvs)) =
                        proc.process_with_texture(&item, decoder, map)
                    {
                        self.scale_mesh(&mut sub_mesh); // UVs are unaffected by scale
                        textured.push((sub_mesh, sub_uvs, map.attachment()));
                        continue;
                    }
                }
            }

            if let Some(processor) = self.processors.get(&item.ifc_type) {
                if let Ok(mut sub_mesh) =
                    processor.process(&item, decoder, &self.schema, self.tessellation_quality)
                {
                    sub_mesh.validate_indices();
                    self.scale_mesh(&mut sub_mesh);
                    untextured.merge(&sub_mesh);
                }
            }
        }

        // attr 0: MappingOrigin (IfcAxis2Placement3D) — the only 3D transform;
        // UVs are 2D and unaffected. Parse once, bake into every part.
        let origin_transform: Option<nalgebra::Matrix4<f64>> = match rep_map.get(0) {
            Some(origin_attr) if !origin_attr.is_null() => {
                match decoder.resolve_ref(origin_attr)? {
                Some(origin) if origin.ifc_type == IfcType::IfcAxis2Placement3D => {
                    let mut t = self.parse_axis2_placement_3d(&origin, decoder)?;
                    self.scale_transform(&mut t);
                    Some(t)
                }
                _ => None,
                }
            }
            _ => None,
        };

        let mut out: Vec<(
            Mesh,
            Vec<f32>,
            Option<crate::processors::texture::TextureAttachment>,
        )> = Vec::new();
        for (mut mesh, uvs, texture) in textured {
            if let Some(t) = &origin_transform {
                self.transform_mesh_local(&mut mesh, t);
            }
            // Same sliver hygiene as the other mesh-output chokepoints. This is
            // the type-geometry (RepresentationMap) channel and the only one
            // carrying a parallel per-vertex UV array; clean_degenerate edits
            // only indices (vertices/UVs untouched), so the UVs stay in sync.
            mesh.clean_degenerate();
            out.push((mesh, uvs, Some(texture)));
        }
        if !untextured.is_empty() {
            if let Some(t) = &origin_transform {
                self.transform_mesh_local(&mut untextured, t);
            }
            untextured.clean_degenerate();
            out.push((untextured, Vec::new(), None));
        }

        Ok(out)
    }
}
