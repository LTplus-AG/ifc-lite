// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcMappedItem` source resolution: caching, bounded owned continuations,
//! and merging an `IfcRepresentationMap`'s items into one source-coords mesh
//! per f64 frame (#6446).
//! Split out of `processing.rs` to stay within its module-size budget (#3691).

use super::frame_parts::{single_frame_source, SourceParts};
use super::GeometryRouter;
use crate::{Error, Mesh, Result, SubMeshCollection};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

use crate::program::mapping as control;

impl GeometryRouter {
    /// Reached cache effects of the common mapping child program. Lookup and
    /// publication keep their historical lock scope and degraded-source policy.
    pub(crate) fn cached_mapped_source(&self, id: u32) -> Option<std::sync::Arc<Mesh>> {
        match &self.shared_mapped_item_cache {
            Some(shared) => shared.lock().unwrap_or_else(|e| e.into_inner()).get(&id).cloned(),
            None => self.mapped_item_cache.borrow().get(&id).cloned(),
        }
    }

    pub(crate) fn publish_mapped_source(&self, id: u32, mesh: &Mesh, truncated: bool) -> Result<()> {
        crate::resource::check_current()?;
        match &self.shared_mapped_item_cache {
            Some(shared) => {
                if !mesh.positions.is_empty() && !crate::kernel::budget::tripped() && !truncated {
                    let source = self.clone_mapped_source(id, mesh)?;
                    shared.lock().unwrap_or_else(|e| e.into_inner()).insert(id, source);
                }
            }
            None => { self.mapped_item_cache.borrow_mut().insert(id, self.clone_mapped_source(id, mesh)?); }
        }
        Ok(())
    }

    fn clone_mapped_source(&self, id: u32, mesh: &Mesh) -> Result<std::sync::Arc<Mesh>> {
        if !crate::resource::is_active() { return Ok(std::sync::Arc::new(mesh.clone())) }
        self.check_mapped_cache_coverage()?;
        let (mesh, permit) = crate::resource::mesh::clone_mesh(mesh)?;
        self.retain_mapped_cache_account(id)?;
        permit.retain();
        Ok(std::sync::Arc::new(mesh))
    }

    /// Process MappedItem with caching for repeated geometry.
    ///
    /// Errors when the source's items cannot share one f64 frame (#6446); use
    /// [`Self::process_mapped_item_parts`] to keep such a source at full precision.
    #[inline]
    pub(super) fn process_mapped_item_cached(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Mesh> {
        single_frame_source("IfcMappedItem", item.id, self.process_mapped_item_parts(item, decoder)?)
    }

    /// [`Self::process_mapped_item_cached`] as frame parts: one mesh, unless the
    /// source's items lie in frames at least 1 km apart (#6446).
    pub(crate) fn process_mapped_item_parts(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Mesh>> {
        control::MergedWalk::new(item, self)?.run(self, decoder)
    }

    /// [`Self::process_representation_item`] as frame parts (#6446): only a
    /// mapped item can yield more than one.
    pub(crate) fn process_representation_item_parts(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Mesh>> {
        if item.ifc_type != IfcType::IfcMappedItem {
            return self.process_representation_item(item, decoder).map(|mesh| vec![mesh]);
        }
        self.process_mapped_item_parts(item, decoder)
    }

    /// The styled consumer shares the mapping continuation architecture but
    /// retains separate source ordering, error and occurrence policies.
    pub(crate) fn collect_submeshes_from_item(
        &self, item: &DecodedEntity, decoder: &mut EntityDecoder<'_>,
        sub_meshes: &mut SubMeshCollection, allow_instancing: bool,
        texture_index: Option<&rustc_hash::FxHashMap<u32, crate::processors::texture::ResolvedTextureMap>>,
    ) -> Result<()> {
        control::SubmeshWalk::new(item, allow_instancing, self)?
            .run(self, decoder, sub_meshes, texture_index)
    }

    /// Mesh one plain (non-`IfcMappedItem`) item of a mapped source into
    /// `source`. The one per-item step of the three source walks that do not
    /// go through [`Self::process_representation_item`]: this file,
    /// `ensure_shared_mapped_source` and the type-geometry walk (#7690).
    ///
    /// It rebases a raw-coordinate item by the model RTC in f64 before f32
    /// narrowing (#5698, ROUTER-27), kept as the item's origin (see
    /// [`Self::keep_rebase_in_origin`]), and, through
    /// [`Self::process_item_in_rtc_frame`], drains the #4901 curve-capped flag
    /// for this source rather than the next item on the thread (ROUTER-26). A
    /// failed or unsupported item is recorded as dropped; `walk` only names
    /// the caller in the debug message.
    pub(crate) fn merge_source_item(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        source: &mut SourceParts,
        walk: &str,
    ) {
        let meshed = match self.processor_for(&item.ifc_type) {
            Some(processor) => {
                self.process_item_in_rtc_frame(processor.as_ref(), item, decoder, self.rtc_offset)
            }
            None => Err(Error::geometry("no processor")),
        };
        if crate::resource::check_current().is_err() { return }
        match meshed {
            Ok(mut mesh) => {
                self.keep_rebase_in_origin(&mut mesh);
                source.merge(&mesh);
            }
            Err(_e) => {
                self.record_unsupported_item(item.ifc_type.clone());
                let _ = walk;
                crate::diag::diag_debug!(
                    { item_id = item.id, ifc_type = ?item.ifc_type, walk, error = %_e,
                      "skipping unsupported source item" }
                    else {
                        #[cfg(debug_assertions)]
                        eprintln!(
                            "[ifc-lite] Skipping unsupported {walk} item #{} ({:?}): {}",
                            item.id, item.ifc_type, _e
                        );
                    }
                );
            }
        }
    }

    /// Re-express a mapped-source item rebased by the model RTC (`rtc_applied`,
    /// #5698) as positions relative to an f64 `origin` holding that offset.
    ///
    /// The model-frame rebase is right only for an item already in the model
    /// frame. A source item still goes through its `MappingTarget` and the
    /// occurrence placement, and `M (p - rtc)` is not `M p - rtc` once `M`
    /// rotates: a 1 degree placement put an LV95 source 50 km away (#7690).
    /// Every later transform carries `origin` exactly in f64, and the final
    /// placement then subtracts the RTC once, so the item keeps its precision
    /// at any rotation. A no-op for an item that was not rebased.
    pub(crate) fn keep_rebase_in_origin(&self, mesh: &mut Mesh) {
        if mesh.rtc_applied {
            mesh.rtc_applied = false;
            let rtc = [self.rtc_offset.0, self.rtc_offset.1, self.rtc_offset.2];
            for (origin, offset) in mesh.origin.iter_mut().zip(rtc) {
                *origin += offset;
            }
        }
    }
}
