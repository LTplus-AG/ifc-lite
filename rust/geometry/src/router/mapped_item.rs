// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcMappedItem` source resolution: caching, cyclic/depth-bounded recursion,
//! and merging an `IfcRepresentationMap`'s items into one source-coords mesh
//! per f64 frame (#6446).
//! Split out of `processing.rs` to stay within its module-size budget (#3691).

use super::frame_parts::{single_frame_source, SourceParts};
use super::transforms::instancing_enabled;
use crate::math::mat4;
use super::GeometryRouter;
use crate::{Error, InstanceMeta, Mesh, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use rustc_hash::FxHashSet;
use std::sync::Arc;

// Maximum nested IfcMappedItem depth for a single geometry item. Shared with
// `ifc_lite_processing::element` and the wasm styling colour resolver, which
// walk the same chain; the constant's own docs say why they must agree.
use ifc_lite_core::MAX_MAPPED_ITEM_DEPTH;

impl GeometryRouter {
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
    pub(super) fn process_mapped_item_parts(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Mesh>> {
        let mut visited = FxHashSet::default();
        let mut truncated = false;
        self.process_mapped_item_cached_inner(item, decoder, 0, &mut visited, &mut truncated)
    }

    /// [`Self::process_representation_item`] as frame parts (#6446): only a
    /// mapped item can yield more than one.
    pub(in crate::router) fn process_representation_item_parts(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Mesh>> {
        if item.ifc_type != IfcType::IfcMappedItem {
            return self.process_representation_item(item, decoder).map(|mesh| vec![mesh]);
        }
        self.process_mapped_item_parts(item, decoder)
    }

    /// Recursion body of [`Self::process_mapped_item_cached`]. `depth`/`visited`
    /// bound the walk exactly as [`Self::collect_submeshes_from_item_inner`]
    /// does, so a malformed model with a cyclic (or absurdly deep) mapped-item
    /// chain terminates instead of overflowing the stack.
    ///
    /// `truncated` is set when this level's mesh is missing geometry a bound cut
    /// off — either a nested item whose error this level swallowed, or a nested
    /// item that was itself truncated. The caller ORs it into its own, so the
    /// flag reaches every enclosing level whose merged mesh is short.
    fn process_mapped_item_cached_inner(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: usize,
        visited: &mut FxHashSet<u32>,
        truncated: &mut bool,
    ) -> Result<Vec<Mesh>> {
        if depth >= MAX_MAPPED_ITEM_DEPTH as usize {
            return Err(Error::geometry(format!(
                "MappedItem nesting exceeded maximum depth of {} at #{}",
                MAX_MAPPED_ITEM_DEPTH, item.id
            )));
        }
        if !visited.insert(item.id) {
            return Err(Error::geometry(format!(
                "Detected cyclic IfcMappedItem reference at #{}",
                item.id
            )));
        }
        let result = self.process_mapped_item_cached_body(item, decoder, depth, visited, truncated);
        visited.remove(&item.id);
        result
    }

    fn process_mapped_item_cached_body(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: usize,
        visited: &mut FxHashSet<u32>,
        truncated: &mut bool,
    ) -> Result<Vec<Mesh>> {
        // IfcMappedItem attributes:
        // 0: MappingSource (IfcRepresentationMap)
        // 1: MappingTarget (IfcCartesianTransformationOperator)

        // Get mapping source (RepresentationMap)
        let source_attr = item
            .get(0)
            .ok_or_else(|| Error::geometry("MappedItem missing MappingSource".to_string()))?;

        let source_entity = decoder
            .resolve_ref(source_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve MappingSource".to_string()))?;

        let source_id = source_entity.id;

        // MappingTarget (attr 1) composed over the map's MappingOrigin (attr 0),
        // which applies innermost. #1985
        let mapping_transform = self.mapped_item_transform(item, &source_entity, decoder)?;

        // Check cache first. The model-wide shared cache (#1623) takes precedence
        // over the per-router RefCell fallback so a source shared across owning
        // elements is meshed once model-wide (a fresh router — hence a fresh
        // RefCell — is built per element). Only a brief get/clone runs under the
        // shared lock; the source build below (which nests faceted-brep's rayon
        // `par_iter`) runs OUTSIDE any lock, so a lock is never held across a nested
        // join (the #1587 deadlock class).
        let cached_source: Option<Arc<Mesh>> = match &self.shared_mapped_item_cache {
            Some(shared) => shared
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&source_id)
                .cloned(),
            None => self.mapped_item_cache.borrow().get(&source_id).cloned(),
        };
        if let Some(cached_mesh) = cached_source {
            let mut mesh = self.clone_cached_mesh(cached_mesh.as_ref())?;
            let mut local_rm = None;
            if let Some(mut transform) = mapping_transform {
                self.scale_transform(&mut transform);
                if instancing_enabled() {
                    local_rm = Some(mat4::from_na(&transform));
                }
                self.transform_mesh_local(&mut mesh, &transform);
            }
            // Instancing: all occurrences of this RepresentationMap share the
            // cached source-coords geometry; `local_transform` is the mapping
            // (canonical -> element-local), `transform` is filled later by the
            // element's apply_placement (element-local -> world).
            if instancing_enabled() {
                mesh.instance_meta = Some(InstanceMeta {
                    transform: mat4::IDENTITY,
                    local_transform: local_rm,
                    canonical_transform: None,
                    rep_identity: source_id as u128,
                    instanceable: true,
                });
            }
            return Ok(vec![mesh]);
        }

        // Cache miss - process the geometry
        // IfcRepresentationMap has:
        // 0: MappingOrigin (IfcAxis2Placement)
        // 1: MappedRepresentation (IfcRepresentation)

        let mapped_rep_attr = source_entity.get(1).ok_or_else(|| {
            Error::geometry("RepresentationMap missing MappedRepresentation".to_string())
        })?;

        let mapped_rep = decoder
            .resolve_ref(mapped_rep_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve MappedRepresentation".to_string()))?;

        // Get representation items
        let items_attr = mapped_rep
            .get(3)
            .ok_or_else(|| Error::geometry("Representation missing Items".to_string()))?;

        let items = decoder.resolve_ref_list(items_attr)?;

        // One scope for this source's whole walk: only a BODY representation's
        // dropped item is a content loss, and this source's drops are counted the
        // FIRST time any path walks it, not once per occurrence. See
        // `GeometryRouter::enter_unsupported_source`. Gates the counting only;
        // the walk and the geometry it produces are unchanged.
        let _drop_scope = self.enter_unsupported_source(source_id, &mapped_rep);

        // Process all items and merge. A nested MappedItem recurses (bounded by
        // `depth`/`visited` above) — it used to be skipped outright, which
        // silently dropped its geometry. The recursive call returns an
        // already-scaled mesh with its own MappingTarget baked in, so composing
        // this level's (scaled) transform over the merge below is the same
        // algebra `collect_submeshes_from_item_inner` applies per sub-mesh.
        // Items in frames >= 1 km apart stay separate parts (#6446).
        let mut source = SourceParts::default();
        // Set when a bound cut this level's mesh short (see the shared-cache guard
        // below); ORed into the caller's flag on the way out.
        let mut level_truncated = false;
        for sub_item in items {
            if sub_item.ifc_type == IfcType::IfcMappedItem {
                match self.process_mapped_item_cached_inner(
                    &sub_item,
                    decoder,
                    depth + 1,
                    visited,
                    &mut level_truncated,
                ) {
                    Ok(sub_parts) => sub_parts.iter().for_each(|part| source.merge(part)),
                    Err(error) => {
                        let _e = Self::recoverable_source_error(error)?;
                        level_truncated = true;
                        // Same drop, same counter as `merge_source_item` (a stop is
                        // terminal instead): the nested map's geometry is gone. Recording
                        // `IfcMappedItem`, not the inner type, is deliberate — the inner
                        // walk errored before it could attribute anything.
                        self.record_unsupported_item(sub_item.ifc_type.clone());
                        crate::diag::diag_debug!(
                            { item_id = sub_item.id, error = %_e,
                              "skipping nested IfcMappedItem" }
                            else {
                                #[cfg(debug_assertions)]
                                eprintln!(
                                    "[ifc-lite] Skipping nested IfcMappedItem #{}: {}",
                                    sub_item.id, _e
                                );
                            }
                        );
                    }
                }
                continue;
            }
            self.merge_source_item(&sub_item, decoder, &mut source, "mapped-source")?;
        }
        // The merge above is short, so every enclosing level's is too.
        *truncated |= level_truncated;
        let mut parts = source.into_parts()?;
        // A multi-frame source is never cached or instanced: both assume one
        // source-coords mesh per map (#6446). No fixture-corpus map is one.
        let single_frame = parts.len() == 1;

        // Store in cache (before transformation, so cached mesh is in source
        // coordinates). Shared model-wide cache first (#1623), else the per-router
        // RefCell. A concurrent miss on the same source by another router rebuilds
        // an identical source-coords mesh, so an overwrite here is byte-identical.
        // Brief lock only — the source build above ran outside it (no join held).
        match &self.shared_mapped_item_cache {
            _ if !single_frame => {}
            Some(shared) => {
                // Mirror the item-dedup #1257 guard: a mapped source can contain
                // IfcBooleanResult/IfcCsgSolid, and on a per-element CSG-budget trip
                // the boolean bails and returns the UNCUT host. Caching that degraded
                // source MODEL-WIDE would serve the wrong (uncut) mesh to a later
                // occurrence in a fresh-budget element that would otherwise get the
                // full exact cut. Skip the shared insert on a trip (or empty mesh) —
                // the next occurrence re-meshes and a clean element caches it. The
                // RefCell fallback arm below stays UNGUARDED: it is per-element
                // (consistent budget within the element), reproducing main exactly.
                //
                // `level_truncated` is the same shape for the nesting bounds this
                // walk introduced: the depth cap and the visited set depend on where
                // in the walk the source was reached, which `source_id` does not
                // encode. A source first met at depth 31 loses everything below it,
                // and caching that model-wide would serve the short mesh to a later
                // occurrence reached at depth 0, which would otherwise walk the
                // whole chain. Non-empty and budget-clean, so only this catches it.
                if !parts[0].positions.is_empty()
                    && !crate::kernel::budget::tripped()
                    && !level_truncated
                {
                    let source_arc = self.clone_source_for_cache(&parts[0])?;
                    shared
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(source_id, source_arc);
                }
            }
            None => {
                let source_arc = self.clone_source_for_cache(&parts[0])?;
                self.mapped_item_cache.borrow_mut().insert(source_id, source_arc);
            }
        }

        // Apply MappingTarget transformation to this instance
        let mut local_rm = None;
        if let Some(mut transform) = mapping_transform {
            self.scale_transform(&mut transform);
            if instancing_enabled() {
                local_rm = Some(mat4::from_na(&transform));
            }
            for part in &mut parts {
                self.transform_mesh_local(part, &transform);
            }
        }
        if instancing_enabled() && single_frame {
            parts[0].instance_meta = Some(InstanceMeta {
                transform: mat4::IDENTITY,
                local_transform: local_rm,
                        canonical_transform: None,
                rep_identity: source_id as u128,
                instanceable: true,
            });
        }

        Ok(parts)
    }

    /// Mesh one plain (non-`IfcMappedItem`) item of a mapped source into
    /// `source`. The one per-item step of the three source walks that do not
    /// go through [`Self::process_representation_item`]: this file,
    /// `ensure_shared_mapped_source` and the type-geometry walk (#7690).
    ///
    /// It rebases a raw-coordinate item by the model RTC in f64 before f32
    /// narrowing (#5698, ROUTER-27), kept as the item's origin (see
    /// [`Self::keep_rebase_in_origin`]), and, through the common item program
    /// (`crate::program::GeometryProgram::item`), drains the #4901 curve-capped flag
    /// for this source rather than the next item on the thread (ROUTER-26). A
    /// failed or unsupported item is recorded as dropped; `walk` only names
    /// the caller in the debug message. A program stop is not a drop: it
    /// propagates as a typed terminal and nothing further is merged.
    pub(super) fn merge_source_item(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        source: &mut SourceParts,
        walk: &str,
    ) -> Result<()> {
        let meshed = match self.processor_for(&item.ifc_type) {
            Some(_) => crate::program::GeometryProgram::item(item, self.rtc_offset).drain(self, decoder),
            None => Err(Error::geometry("no processor")),
        };
        match meshed {
            Ok(mut mesh) => {
                self.keep_rebase_in_origin(&mut mesh);
                source.merge(&mesh);
            }
            Err(error) => {
                let _e = Self::recoverable_source_error(error)?;
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
        Ok(())
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
    pub(super) fn keep_rebase_in_origin(&self, mesh: &mut Mesh) {
        if mesh.rtc_applied {
            mesh.rtc_applied = false;
            let rtc = [self.rtc_offset.0, self.rtc_offset.1, self.rtc_offset.2];
            for (origin, offset) in mesh.origin.iter_mut().zip(rtc) {
                *origin += offset;
            }
        }
    }
}
