// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #1623 Phase 2/3 "don't-bake" router helpers: eligibility of a mapped source for
//! instancing, the template claim, the placeholder and template re-tag, and the
//! one-time source mesh into the shared registry that backs the finalize's orphan
//! recovery. The walk itself is the common mapping controller's styled walk
//! (`crate::program::mapping`).

use super::GeometryRouter;
use crate::math::mat4;
use crate::{InstanceMeta, Mesh, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix4;
use std::sync::Arc;

/// A provisional batch-local template claim (see
/// [`GeometryRouter::claim_template`]): settled once its occurrence finished.
pub(crate) struct TemplateClaim {
    source_id: u32,
    permit: Option<crate::resource::Reservation>,
}

impl GeometryRouter {
    /// #1623 / #7873 eligibility accepts exactly one raw reference, then decodes
    /// at most that member. Class X: ignored nonrefs no longer make malformed
    /// multi-slot Items eligible; they materialize flat under the full-list guard.
    /// No allocation or scan to find a reference among ignored members. Nested
    /// mapped items also stay flat; the solid id preserves placeholder colour.
    pub(super) fn mapped_source_single_item(
        &self,
        mapped_repr: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<u32> {
        let [only] = mapped_repr.get(3)?.as_list()? else {
            return None;
        };
        let only = decoder.decode_by_id(only.as_entity_ref()?).ok()?;
        (only.ifc_type != IfcType::IfcMappedItem).then_some(only.id)
    }

    /// #1623 Phase 2/3 eligibility of a TOP-LEVEL styled occurrence: its source
    /// is a REPEATED (count >= 2) single-solid `IfcRepresentationMap` the armed
    /// plan lists. Returns that solid's id, the placeholder's `geometry_id`, so
    /// colour resolves EXACTLY as the flat/template sub-mesh. `None` with no
    /// armed plan, so the flat output is unchanged.
    pub(super) fn dont_bake_solid(
        &self,
        source_id: u32,
        mapped_repr: &DecodedEntity,
        textures: Option<&rustc_hash::FxHashMap<u32, crate::processors::texture::ResolvedTextureMap>>,
        decoder: &mut EntityDecoder,
    ) -> Option<u32> {
        self.output_instancing_plan()
            .and_then(|plan| plan.get(&source_id).copied())
            .filter(|&(count, _)| count >= 2)
            .and_then(|_| {
                self.mapped_source_single_item(mapped_repr, decoder)
                    // #858: a solid carrying an IfcIndexedColourMap materializes
                    // flat so emit_sub_meshes can split it per palette group; an
                    // instance placeholder resolves ONE colour.
                    .filter(|&item_id| !self.is_indexed_colour_split_source(item_id))
                    // #1781: a TEXTURED solid too: a placeholder carries no UVs.
                    .filter(|&item_id| textures.is_none_or(|index| !index.contains_key(&item_id)))
            })
    }

    /// Which eligible occurrence MATERIALIZES the template. Native (global)
    /// mode: the plan's deterministic min-id occurrence, so all occurrences
    /// resolve against ONE model-wide template across the rayon pool. WASM
    /// batch-local mode: the FIRST occurrence this router sees, so each batch
    /// is a self-contained shard. Both emit identical world triangles.
    ///
    /// Under a resource account a batch-local claim is provisional: the marker
    /// is admitted before insertion and kept only by [`Self::settle_template`]
    /// once the template materialized geometry, so a refused or empty template
    /// leaves the next occurrence free to become it. Without an account the
    /// claim is permanent, as it always was.
    pub(crate) fn claim_template(&self, item_id: u32, source_id: u32) -> Result<(bool, Option<TemplateClaim>)> {
        if !self.instancing_batch_local() {
            let template = self
                .output_instancing_plan()
                .and_then(|plan| plan.get(&source_id))
                .map_or(item_id, |&(_, template)| template);
            return Ok((item_id == template, None));
        }
        let accounted = crate::resource::is_active();
        let mut permit = None;
        if accounted && !self.instanced_sources_materialized.borrow().contains(&source_id) {
            // The marker id is admitted before insertion; hash-table control
            // and allocator backing stay opaque coverage.
            let cost = crate::resource::Cost { work: 1, live_bytes: std::mem::size_of::<u32>() as u64,
                ..crate::resource::Cost::default() };
            permit = Some(crate::resource::charge(cost)?);
            self.instanced_sources_materialized
                .borrow_mut()
                .try_reserve(1)
                .map_err(|_| crate::resource::allocation_failure())?;
        }
        let template = self.mark_source_materialized_if_first(source_id);
        Ok((template, (accounted && template).then_some(TemplateClaim { source_id, permit })))
    }

    /// Keep a provisional template claim once its occurrence materialized
    /// geometry, else roll it back.
    pub(crate) fn settle_template(&self, claim: TemplateClaim, materialized: bool) {
        if materialized && self.retain_local_resource_account().is_ok() {
            if let Some(permit) = claim.permit {
                permit.retain();
            }
            return;
        }
        self.instanced_sources_materialized.borrow_mut().remove(&claim.source_id);
    }

    /// Logical refusal withholds the template even without a resource account.
    /// The caller owns this first-template marker; unrelated claims are untouched.
    pub(crate) fn rollback_logical_template(&self, source_id: u32, claim: Option<TemplateClaim>) {
        if let Some(claim) = claim {
            self.settle_template(claim, false);
        } else if self.instancing_batch_local() {
            self.instanced_sources_materialized
                .borrow_mut()
                .remove(&source_id);
        }
    }

    /// Whether a don't-bake occurrence must first mesh its source ONCE into the
    /// shared registry (source coords, pre-`MappingTarget`, pre-placement), so
    /// the streaming finalize can recover it in the (effectively unreachable)
    /// case that the template occurrence never materialized. Without a shared
    /// registry there is nothing to recover from; callers that arm output
    /// instancing always enable it too.
    pub(crate) fn shared_mapped_source_needed(&self, source_id: u32) -> Result<bool> {
        let Some(shared) = self.shared_mapped_item_cache.as_ref() else {
            return Ok(false);
        };
        // A hit is coverage too (as in the mapped-item walk): refuse an
        // unaccounted shared cache under a bounded account before the lookup.
        self.check_mapped_cache_coverage()?;
        Ok(!shared.lock().unwrap_or_else(|e| e.into_inner()).contains_key(&source_id))
    }

    /// The instance-only placeholder of a don't-bake occurrence: empty geometry
    /// carrying the scaled mapping transform and the source's `rep_identity`.
    /// `apply_submesh_placement` folds the world placement into its transform;
    /// the finalize turns it into an occurrence against the template.
    pub(crate) fn dont_bake_placeholder(source_id: u32, transform: Option<&Matrix4<f64>>) -> Mesh {
        let mut placeholder = Mesh::new();
        placeholder.instance_meta = Some(InstanceMeta::instanceable(
            source_id as u128,
            transform.map(mat4::from_na),
        ));
        placeholder
    }

    /// The don't-bake TEMPLATE occurrence materialized normally (a single-solid
    /// source, so exactly one sub-mesh). Re-tag its `rep_identity` to the source
    /// and record the scaled mapping as `local_transform`, MATCHING the
    /// placeholders so the finalize collates them onto it. The baked geometry is
    /// untouched: its world geometry is `transform · local_transform · source`,
    /// so `m_ref` recovers the same `source` the placeholders reference.
    pub(crate) fn retag_dont_bake_template(sub_meshes: &mut [crate::SubMesh], source_id: u32,
        transform: Option<&Matrix4<f64>>) {
        let local = transform.map(mat4::from_na);
        for sub in sub_meshes {
            if let Some(instance) = sub.mesh.instance_meta.as_mut() {
                instance.rep_identity = source_id as u128;
                instance.local_transform = local;
            }
        }
    }

    /// Mesh a mapped source ONCE into the shared registry, if not already
    /// present: the walk a don't-bake occurrence runs before its placeholder.
    #[cfg(test)]
    pub(super) fn ensure_shared_mapped_source(
        &self,
        mapped_repr: &DecodedEntity,
        source_id: u32,
        decoder: &mut EntityDecoder,
    ) -> Result<()> {
        if !self.shared_mapped_source_needed(source_id)? {
            return Ok(());
        }
        crate::program::GeometryProgram::shared_mapped_source(mapped_repr, source_id)
            .drain_parts(self, decoder)
            .map(drop)
    }

    /// The shared registry walk's items. A representation whose items do not
    /// resolve walks nothing and so registers nothing.
    pub(crate) fn shared_source_items(
        mapped_repr: &DecodedEntity,
        decoder: &mut EntityDecoder,
        budget: &mut crate::program::mapping_budget::LogicalBudget,
    ) -> crate::program::mapping_budget::SourceResult<Vec<DecodedEntity>> {
        let Some(items_attr) = mapped_repr.get(3) else {
            return Ok(Vec::new());
        };
        budget.materialize_items(items_attr.as_list().map_or(0, |items| items.len()))?;
        // Historical shared-source content failures walk nothing; logical
        // refusal above must never enter this empty-content fallback.
        Ok(decoder.resolve_ref_list(items_attr).unwrap_or_default())
    }

    /// Register a walked shared source. A missing processor or a failing one
    /// leaves the mesh short of the source's real geometry; that partial mesh is
    /// consistent with the per-occurrence walk (which also keeps going past a
    /// failed item), so the drop is recorded rather than the source withheld.
    pub(crate) fn publish_shared_mapped_source(&self, source_id: u32, mut parts: Vec<Mesh>) -> Result<()> {
        let Some(shared) = self.shared_mapped_item_cache.as_ref() else {
            return Ok(());
        };
        if parts.len() == 1
            && !parts[0].positions.is_empty()
            && !crate::kernel::budget::tripped()
        {
            // The moved mesh is published as is: under accounting its merges
            // were already admitted, so only the cache owner must be retained.
            if crate::resource::is_active() {
                self.retain_mapped_cache_account()?;
            }
            let mesh = parts.pop().unwrap_or_default();
            shared
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(source_id, Arc::new(mesh));
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "instancing_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "styled_walk_tests.rs"]
mod styled_walk_tests;
