// SPDX-License-Identifier: MPL-2.0
//! Orphan type maps: ordered common item control and late MappingOrigin.
use super::{ProductProgram, ReachedItem};
use crate::processors::texture::{ResolvedTextureMap, TextureAttachment};
use crate::router::{frame_parts::SourceParts, GeometryRouter};
use crate::{Mesh, Result};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix4;
use rustc_hash::FxHashMap;

type TexturedPart = (Mesh, Vec<f32>, TextureAttachment);
pub(crate) type TypeParts = Vec<(Mesh, Vec<f32>, Option<TextureAttachment>)>;
pub(crate) struct TypeMap {
    rep_map: DecodedEntity,
    program: ProductProgram,
    policy: bool,
    untextured: SourceParts,
    textured: Vec<TexturedPart>,
}
impl TypeMap {
    pub(crate) fn admit(
        rep_map: &DecodedEntity,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>,
    ) -> Result<Self> {
        let representation = super::mapping::representation(rep_map, decoder)?;
        let program = ProductProgram::type_map(rep_map, &representation, decoder)?;
        let policy = router.claim_unsupported_source(rep_map.id, &representation);
        Ok(Self {
            rep_map: rep_map.clone(),
            program,
            policy,
            untextured: SourceParts::default(),
            textured: Vec::new(),
        })
    }

    pub(crate) fn run(
        mut self,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>,
        texture_index: &FxHashMap<u32, ResolvedTextureMap>,
    ) -> Result<TypeParts> {
        while let Some(ReachedItem { item, .. }) = self.program.next(decoder)? {
            router.with_unsupported_policy(self.policy, || {
                self.item(item, router, decoder, texture_index)
            });
        }
        // A live callback may have repaired the origin. Do not admit it early.
        let origin = router.with_unsupported_policy(self.policy, || {
            Self::origin(&self.rep_map, router, decoder)
        })?;
        Ok(self.finish(origin, router))
    }

    fn item(
        &mut self,
        item: DecodedEntity,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>,
        texture_index: &FxHashMap<u32, ResolvedTextureMap>,
    ) {
        // A nested IfcMappedItem inside a type's own representation: process
        // it (applies its MappingTarget) rather than dropping its geometry.
        if item.ifc_type == IfcType::IfcMappedItem {
            match router.process_mapped_item_parts(&item, decoder) {
                // already scaled inside the cached path
                Ok(sub_parts) => sub_parts
                    .iter()
                    .for_each(|part| self.untextured.merge(part)),
                Err(_e) => {
                    router.record_unsupported_item(item.ifc_type.clone());
                    crate::diag::diag_debug!(
                        { item_id = item.id, error = %_e,
                          "skipping unsupported nested IfcMappedItem in representation map" }
                        else {
                            #[cfg(debug_assertions)]
                            eprintln!(
                                "[ifc-lite] Skipping unsupported nested IfcMappedItem #{} in representation map: {}",
                                item.id, _e
                            );
                        }
                    );
                }
            }
            return;
        }

        // Textured tessellated face set → its own part with per-vertex UVs (#961),
        // rebased like the plain items below (#5698, #7690).
        if let Some(map) = texture_index.get(&item.id) {
            if let Some((mut sub_mesh, sub_uvs)) =
                router.textured_face_set(&item, decoder, map, Some(router.rtc_offset()))
            {
                router.keep_rebase_in_origin(&mut sub_mesh);
                self.textured.push((sub_mesh, sub_uvs, map.attachment()));
                return;
            }
        }

        router.merge_source_item(&item, decoder, &mut self.untextured, "representation-map");
    }

    fn origin(
        rep_map: &DecodedEntity,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>,
    ) -> Result<Option<Matrix4<f64>>> {
        let origin_transform: Option<nalgebra::Matrix4<f64>> =
            match rep_map.get(slot::IfcRepresentationMap::MAPPING_ORIGIN.index()) {
                Some(origin_attr) if !origin_attr.is_null() => {
                    match decoder.resolve_ref(origin_attr)? {
                        Some(origin) if origin.ifc_type == IfcType::IfcAxis2Placement3D => {
                            let mut t = router.parse_axis2_placement_3d(&origin, decoder)?;
                            router.scale_transform(&mut t);
                            Some(t)
                        }
                        _ => None,
                    }
                }
                _ => None,
            };

        Ok(origin_transform)
    }

    fn finish(self, origin_transform: Option<Matrix4<f64>>, router: &GeometryRouter) -> TypeParts {
        let mut out: Vec<(
            Mesh,
            Vec<f32>,
            Option<crate::processors::texture::TextureAttachment>,
        )> = Vec::new();
        for (mut mesh, uvs, texture) in self.textured {
            if let Some(t) = &origin_transform {
                router.transform_mesh_local(&mut mesh, t);
            }
            // Same sliver hygiene as the other mesh-output chokepoints. This is
            // the type-geometry (RepresentationMap) channel and the only one
            // carrying a parallel per-vertex UV array; clean_degenerate edits
            // only indices (vertices/UVs untouched), so the UVs stay in sync.
            mesh.clean_degenerate();
            out.push((mesh, uvs, Some(texture)));
        }
        for mut untextured in self
            .untextured
            .into_parts()
            .into_iter()
            .filter(|mesh| !mesh.is_empty())
        {
            if let Some(t) = &origin_transform {
                router.transform_mesh_local(&mut untextured, t);
            }
            untextured.clean_degenerate();
            out.push((untextured, Vec::new(), None));
        }

        out
    }
}
