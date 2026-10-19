// SPDX-License-Identifier: MPL-2.0
//! Submesh occurrence admission and the unchanged mapping arithmetic. Eligibility
//! is occurrence-local; nested sources never independently choose don't-bake.
use super::GeometryRouter;
use crate::{Result, SubMeshCollection, math::mat4};
use crate::processors::texture::ResolvedTextureMap;
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use nalgebra::Matrix4;
use rustc_hash::{FxHashMap, FxHashSet};
use crate::resource::{self, Cost};
use std::{cell::{Cell, RefCell}, rc::Rc};
use super::store::{ClaimId, MappingStore};

pub(super) struct Admission {
    pub source_id: u32,
    pub representation: DecodedEntity,
    pub transform: Option<Matrix4<f64>>,
    pub solid_id: Option<u32>,
    pub template: bool,
    claim: Option<ClaimId>,
}
pub(super) fn solid_id(source_id:u32,representation:&DecodedEntity,depth:usize,allow_instancing:bool,
    textures:Option<&FxHashMap<u32,ResolvedTextureMap>>,router:&GeometryRouter,decoder:&mut EntityDecoder<'_>)->Option<u32> {
    if allow_instancing && depth == 0 {
        router.output_instancing_plan()
            .and_then(|plan| plan.get(&source_id).copied())
            .filter(|&(count, _)| count >= 2)
            .and_then(|_| router.mapped_source_single_item(representation, decoder)
                .filter(|&id| !router.is_indexed_colour_split_source(id))
                .filter(|&id| textures.is_none_or(|index| !index.contains_key(&id))))
    } else { None }

}
#[allow(clippy::too_many_arguments)] // Reached derived occurrence and actual router claim authority.
pub(super) fn claim(item:&DecodedEntity,source_id:u32,representation:DecodedEntity,transform:Option<Matrix4<f64>>,
    solid_id:Option<u32>,router:&GeometryRouter,store:&mut MappingStore)->Result<Admission> {
    let mut marker_permit = None;
    let template = match solid_id {
        None => true,
        Some(_) if router.instancing_batch_local() => {
            if resource::is_active() && !router.materialized_source_handle().borrow().contains(&source_id) {
                // Admit the actual id before insertion. Hash-table control and
                // allocator backing remain explicitly opaque coverage.
                marker_permit = Some(resource::charge(Cost { work: 1,
                    live_bytes: std::mem::size_of::<u32>() as u64, ..Cost::default() })?);
                router.materialized_source_handle().borrow_mut().try_reserve(1)
                    .map_err(|_| resource::allocation_failure())?;
            }
            router.mark_source_materialized_if_first(source_id)
        },
        Some(_) => {
            let template_item = router.output_instancing_plan().and_then(|plan| plan.get(&source_id))
                .map(|&(_, template)| template).unwrap_or(item.id);
            item.id == template_item
        }
    };
    let provisional = (resource::is_active() && solid_id.is_some() && template && router.instancing_batch_local())
        .then(|| ProvisionalTemplate { id: source_id, sources: router.materialized_source_handle(), committed: Cell::new(false), permit: RefCell::new(marker_permit) });
    let claim = provisional.map(|claim| store.insert(claim));
    Ok(Admission { source_id, representation, transform, solid_id, template, claim })
}

pub(super) fn transform_children_owned(transform: Option<Matrix4<f64>>, start: usize,
    meshes: &mut SubMeshCollection) {
    if resource::is_active() {
        let work = meshes.sub_meshes[start..].iter().try_fold(0u64, |n, sub| n.checked_add(sub.mesh.positions.len() as u64));
        let Some(work) = work else { resource::overflow(); return };
        if resource::charge(Cost { work, ..Cost::default() }).is_err() { return }
    }
    if let Some(transform) = transform {
        let nontrivial_target = !transform.is_identity(1e-9);
        for sub in &mut meshes.sub_meshes[start..] {
            crate::router::transforms::transform_mesh_local(&mut sub.mesh, &transform);
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
pub(super) fn commit(admission: &Admission, nonempty: bool, router: &GeometryRouter, store: &mut MappingStore) {
    if let Some(mark) = admission.claim.and_then(|id| store.get(id)) {
        if !nonempty { return }
        if router.retain_local_resource_account().is_err() { return }
        if let Some(permit) = mark.permit.borrow_mut().take() { permit.retain(); }
        mark.committed.set(true);
    }
}

pub(super) fn release(admission: &Admission, store: &mut MappingStore) {
    if let Some(id) = admission.claim { store.release(id); }
}

/// Only dependent, unfinished template marks roll back; completed independent
/// cache publications remain at their original reached execution point.
pub(super) struct ProvisionalTemplate {
    id: u32, sources: Rc<RefCell<FxHashSet<u32>>>, committed: Cell<bool>,
    permit: RefCell<Option<resource::Reservation>>,
}
impl Drop for ProvisionalTemplate {
    fn drop(&mut self) { if !self.committed.get() { self.sources.borrow_mut().remove(&self.id); } }
}

/// Preserve a raw source child's model RTC in its f64 local origin before any
/// mapping transform. This is the canonical arithmetic formerly on the router.
pub(crate) fn keep_rebase_in_origin(mesh:&mut crate::Mesh,rtc:(f64,f64,f64)) {
    if mesh.rtc_applied {
        mesh.rtc_applied=false;
        for (origin,offset) in mesh.origin.iter_mut().zip([rtc.0,rtc.1,rtc.2]) {*origin+=offset;}
    }
}
