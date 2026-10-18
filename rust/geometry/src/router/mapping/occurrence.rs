// SPDX-License-Identifier: MPL-2.0
//! Submesh occurrence admission and the unchanged mapping arithmetic. Eligibility
//! is occurrence-local; nested sources never independently choose don't-bake.
use super::{GeometryRouter, representation, source};
use crate::{InstanceMeta, Mesh, Result, SubMeshCollection, math::mat4};
use crate::processors::texture::ResolvedTextureMap;
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use nalgebra::Matrix4;
use rustc_hash::FxHashMap;

pub(super) struct Admission {
    pub source_id: u32,
    pub representation: DecodedEntity,
    pub transform: Option<Matrix4<f64>>,
    pub solid_id: Option<u32>,
    pub template: bool,
}
pub(super) fn admit(item: &DecodedEntity, depth: usize, allow_instancing: bool,
    textures: Option<&FxHashMap<u32, ResolvedTextureMap>>, router: &GeometryRouter,
    decoder: &mut EntityDecoder<'_>) -> Result<Admission> {
    let source = source(item, decoder)?;
    // Submeshes resolve the representation BEFORE decoding the transform.
    let representation = representation(&source, decoder)?;
    let transform = router.mapped_item_transform(item, &source, decoder)?;
    let solid_id = if allow_instancing && depth == 0 {
        router.output_instancing_plan()
            .and_then(|plan| plan.get(&source.id).copied())
            .filter(|&(count, _)| count >= 2)
            .and_then(|_| router.mapped_source_single_item(&representation, decoder)
                .filter(|&id| !router.is_indexed_colour_split_source(id))
                .filter(|&id| textures.is_none_or(|index| !index.contains_key(&id))))
    } else { None };
    let template = match solid_id {
        None => true,
        Some(_) if router.instancing_batch_local() => router.mark_source_materialized_if_first(source.id),
        Some(_) => {
            let template_item = router.output_instancing_plan().and_then(|plan| plan.get(&source.id))
                .map(|&(_, template)| template).unwrap_or(item.id);
            item.id == template_item
        }
    };
    Ok(Admission { source_id: source.id, representation, transform, solid_id, template })
}

pub(super) fn placeholder(admission: &Admission, meshes: &mut SubMeshCollection,
    router: &GeometryRouter, decoder: &mut EntityDecoder<'_>) -> bool {
    let Some(solid_id) = admission.solid_id.filter(|_| !admission.template) else { return false };
    router.ensure_shared_mapped_source(&admission.representation, admission.source_id, decoder);
    let local_transform = admission.transform.map(|mut transform| {
        router.scale_transform(&mut transform);
        mat4::from_na(&transform)
    });
    let mut mesh = Mesh::new();
    mesh.instance_meta = Some(InstanceMeta { transform: mat4::IDENTITY, local_transform,
        canonical_transform: None, rep_identity: admission.source_id as u128, instanceable: true });
    // add() drops empties; this occurrence deliberately carries metadata only.
    meshes.sub_meshes.push(crate::SubMesh::new(solid_id, mesh));
    true
}

pub(super) fn transform_children(transform: Option<Matrix4<f64>>, start: usize,
    meshes: &mut SubMeshCollection, router: &GeometryRouter) {
    if let Some(mut transform) = transform {
        router.scale_transform(&mut transform);
        let nontrivial_target = !transform.is_identity(1e-9);
        for sub in &mut meshes.sub_meshes[start..] {
            router.transform_mesh_local(&mut sub.mesh, &transform);
            if nontrivial_target {
                if let Some(instance) = sub.mesh.instance_meta.as_mut().filter(|instance| instance.instanceable) {
                    instance.local_transform = Some(match instance.local_transform {
                        Some(inner) => mat4::from_na(&(transform * Matrix4::from_row_slice(&inner))),
                        None => mat4::from_na(&transform),
                    });
                }
            }
        }
    }
}
pub(super) fn retag_template(admission: &Admission, start: usize,
    meshes: &mut SubMeshCollection, router: &GeometryRouter) {
    if admission.solid_id.is_some() && admission.template {
        let local_transform = admission.transform.map(|mut transform| {
            router.scale_transform(&mut transform);
            mat4::from_na(&transform)
        });
        for sub in &mut meshes.sub_meshes[start..] {
            if let Some(instance) = sub.mesh.instance_meta.as_mut() {
                instance.rep_identity = admission.source_id as u128;
                instance.local_transform = local_transform;
            }
        }
    }
}
