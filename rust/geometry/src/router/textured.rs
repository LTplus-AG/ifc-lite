// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The router's surface-texture channel (#961, #1781): texture-aware
//! representation-map tessellation (orphan type geometry) and the textured
//! occurrence sub-mesh entry point. Split from `processing.rs` so the main
//! element pipeline stays within the module-size house rule; the texture
//! index itself is built in `crate::processors::texture`.

use ifc_lite_core::{DecodedEntity, EntityDecoder};

use super::frame_parts::{single_frame_source, SourceParts};
use super::GeometryRouter;
use crate::{Mesh, Result, SubMeshCollection};

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
        single_frame_source("IfcRepresentationMap", rep_map.id, mesh.into_parts())
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
    ) -> Result<
        Vec<(
            Mesh,
            Vec<f32>,
            Option<crate::processors::texture::TextureAttachment>,
        )>,
    > {
        let mut program = crate::program::GeometryProgram::type_map_entity(rep_map.clone());
        while let Some(request) = program.request().expect("synchronous TypeMap request") {
            let reply = program.execute_with_textures(request, self, decoder, Some(texture_index))
                .expect("synchronous TypeMap execution");
            program.accept(reply, self).expect("synchronous TypeMap acceptance");
        }
        program.finish_type_parts()
    }
}
