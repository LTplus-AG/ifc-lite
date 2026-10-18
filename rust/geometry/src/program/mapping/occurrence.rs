// SPDX-License-Identifier: MPL-2.0
//! Submesh occurrence admission and the unchanged mapping arithmetic. Eligibility
//! is occurrence-local; nested sources never independently choose don't-bake.
use super::{GeometryRouter, representation, source};
use crate::{InstanceMeta, Mesh, Result, SubMeshCollection, math::mat4};
use crate::processors::texture::ResolvedTextureMap;
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use nalgebra::Matrix4;
use rustc_hash::{FxHashMap, FxHashSet};
use crate::resource::{self, Cost};
use std::{cell::{Cell, RefCell}, rc::Rc};

pub(super) struct Admission {
    pub source_id: u32,
    pub representation: DecodedEntity,
    pub transform: Option<Matrix4<f64>>,
    pub solid_id: Option<u32>,
    pub template: bool,
    provisional: Option<ProvisionalTemplate>,
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
    let mut marker_permit = None;
    let template = match solid_id {
        None => true,
        Some(_) if router.instancing_batch_local() => {
            if resource::is_active() && !router.materialized_source_handle().borrow().contains(&source.id) {
                // Admit the actual id before insertion. Hash-table control and
                // allocator backing remain explicitly opaque coverage.
                marker_permit = Some(resource::charge(Cost { work: 1,
                    live_bytes: std::mem::size_of::<u32>() as u64, ..Cost::default() })?);
                router.materialized_source_handle().borrow_mut().try_reserve(1)
                    .map_err(|_| resource::allocation_failure())?;
            }
            router.mark_source_materialized_if_first(source.id)
        },
        Some(_) => {
            let template_item = router.output_instancing_plan().and_then(|plan| plan.get(&source.id))
                .map(|&(_, template)| template).unwrap_or(item.id);
            item.id == template_item
        }
    };
    let provisional = (resource::is_active() && solid_id.is_some() && template && router.instancing_batch_local())
        .then(|| ProvisionalTemplate { id: source.id, sources: router.materialized_source_handle(), committed: Cell::new(false), permit: RefCell::new(marker_permit) });
    Ok(Admission { source_id: source.id, representation, transform, solid_id, template, provisional })
}

pub(super) fn placeholder(admission: &Admission, meshes: &mut SubMeshCollection,
    router: &GeometryRouter, decoder: &mut EntityDecoder<'_>) -> Result<bool> {
    let Some(solid_id) = admission.solid_id.filter(|_| !admission.template) else { return Ok(false) };
    resource::charge(Cost { output_bytes: std::mem::size_of::<crate::SubMesh>() as u64,
        live_bytes: std::mem::size_of::<crate::SubMesh>() as u64, ..Cost::default() })?.retain();
    router.ensure_shared_mapped_source(&admission.representation, admission.source_id, decoder);
    resource::check_current()?;
    let local_transform = admission.transform.map(|mut transform| {
        router.scale_transform(&mut transform);
        mat4::from_na(&transform)
    });
    let mut mesh = Mesh::new();
    mesh.instance_meta = Some(InstanceMeta { transform: mat4::IDENTITY, local_transform,
        canonical_transform: None, rep_identity: admission.source_id as u128, instanceable: true });
    // add() drops empties; this occurrence deliberately carries metadata only.
    resource::reserve_headers(&mut meshes.sub_meshes, 1)?.retain();
    meshes.sub_meshes.push(crate::SubMesh::new(solid_id, mesh));
    Ok(true)
}

pub(super) fn transform_children(transform: Option<Matrix4<f64>>, start: usize,
    meshes: &mut SubMeshCollection, router: &GeometryRouter) {
    if resource::is_active() {
        let work = meshes.sub_meshes[start..].iter().try_fold(0u64, |n, sub| n.checked_add(sub.mesh.positions.len() as u64));
        let Some(work) = work else { resource::overflow(); return };
        if resource::charge(Cost { work, ..Cost::default() }).is_err() { return }
    }
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
    if resource::check_current().is_err() { return }
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
    if let Some(mark) = &admission.provisional {
        if !meshes.sub_meshes[start..].iter().any(|sub| !sub.mesh.is_empty()) { return }
        if router.retain_local_resource_account().is_err() { return }
        if let Some(permit) = mark.permit.borrow_mut().take() { permit.retain(); }
        mark.committed.set(true);
    }
}

/// Only dependent, unfinished template marks roll back; completed independent
/// cache publications remain at their original reached execution point.
struct ProvisionalTemplate {
    id: u32, sources: Rc<RefCell<FxHashSet<u32>>>, committed: Cell<bool>,
    permit: RefCell<Option<resource::Reservation>>,
}
impl Drop for ProvisionalTemplate {
    fn drop(&mut self) { if !self.committed.get() { self.sources.borrow_mut().remove(&self.id); } }
}
