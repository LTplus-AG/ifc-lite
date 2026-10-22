// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcMappedItem` source services for the common mapping controller
//! (`crate::program::mapping`): source admission, the mapped-item caches and
//! occurrence placement. The walk itself (cyclic/depth-bounded nesting, the
//! ordered per-frame merge of a map's items (#6446), dropped-item records) is
//! the controller's.
//! Split out of `processing.rs` to stay within its module-size budget (#3691).

use super::frame_parts::single_frame_source;
use super::transforms::instancing_enabled;
use crate::math::mat4;
use super::GeometryRouter;
use crate::{Error, InstanceMeta, Mesh, Result};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder};
use nalgebra::Matrix4;
use std::sync::Arc;

/// A mapped item's admitted source: a cached source-coords mesh, or the
/// source's representation and items to walk. `transform` is the scaled
/// `MappingTarget` composed over the map's `MappingOrigin` (#1985).
pub(crate) enum MappedOccurrence {
    Cached { mesh: Arc<Mesh>, transform: Option<Matrix4<f64>> },
    Source { representation: DecodedEntity, items: Vec<DecodedEntity>, transform: Option<Matrix4<f64>> },
}

/// A styled occurrence's admitted source. Styled sources are never cached:
/// each occurrence walks its source into per-item sub-meshes. `transform` is
/// the scaled `MappingTarget` over `MappingOrigin`; `solid_id` is the single
/// solid of a top-level source the armed don't-bake plan may instance (#1623).
pub(crate) struct StyledSource {
    pub(crate) source_id: u32,
    pub(crate) representation: DecodedEntity,
    pub(crate) transform: Option<Matrix4<f64>>,
    pub(crate) solid_id: Option<u32>,
}

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
        crate::program::GeometryProgram::mapped_item(item).drain_parts(self, decoder)
    }

    /// Admit one mapped item: resolve its `MappingSource` and transform, then
    /// look the source up in the cache. A miss resolves the source's
    /// representation and items for the walk. The transform is resolved
    /// before the lookup, so a broken target is an error even on a hit.
    pub(crate) fn admit_mapped_occurrence(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<(u32, MappedOccurrence)> {
        // IfcMappedItem attributes:
        // 0: MappingSource (IfcRepresentationMap)
        // 1: MappingTarget (IfcCartesianTransformationOperator)
        let source_attr = item
            .get(0)
            .ok_or_else(|| Error::geometry("MappedItem missing MappingSource".to_string()))?;
        let source_entity = decoder
            .resolve_ref(source_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve MappingSource".to_string()))?;
        let source_id = source_entity.id;

        // MappingTarget (attr 1) composed over the map's MappingOrigin (attr 0),
        // which applies innermost. #1985
        let mut transform = self.mapped_item_transform(item, &source_entity, decoder)?;
        if let Some(transform) = &mut transform {
            self.scale_transform(transform);
        }

        // The model-wide shared cache (#1623) takes precedence over the
        // per-router RefCell fallback so a source shared across owning elements
        // is meshed once model-wide (a fresh router — hence a fresh RefCell — is
        // built per element). Only a brief get/clone runs under the shared lock;
        // the source walk (which nests faceted-brep's rayon `par_iter`) runs
        // OUTSIDE any lock, so a lock is never held across a nested join (the
        // #1587 deadlock class).
        let cached: Option<Arc<Mesh>> = match &self.shared_mapped_item_cache {
            Some(shared) => shared
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&source_id)
                .cloned(),
            None => self.mapped_item_cache.borrow().get(&source_id).cloned(),
        };
        if let Some(mesh) = cached {
            return Ok((source_id, MappedOccurrence::Cached { mesh, transform }));
        }

        // IfcRepresentationMap has:
        // 0: MappingOrigin (IfcAxis2Placement)
        // 1: MappedRepresentation (IfcRepresentation)
        let mapped_rep_attr = source_entity.get(1).ok_or_else(|| {
            Error::geometry("RepresentationMap missing MappedRepresentation".to_string())
        })?;
        let representation = decoder
            .resolve_ref(mapped_rep_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve MappedRepresentation".to_string()))?;
        let items_attr = representation
            .get(3)
            .ok_or_else(|| Error::geometry("Representation missing Items".to_string()))?;
        let items = decoder.resolve_ref_list(items_attr)?;
        Ok((source_id, MappedOccurrence::Source { representation, items, transform }))
    }

    /// Admit one styled mapped item: its `MappingSource`, the source's
    /// representation and its transform, then (top level only, when
    /// `eligible`) its don't-bake eligibility. The items resolve later, after
    /// the source's drop-count claim, as the historical walk read them.
    pub(crate) fn admit_styled_occurrence(
        &self,
        item: &DecodedEntity,
        eligible: bool,
        textures: Option<&rustc_hash::FxHashMap<u32, crate::processors::texture::ResolvedTextureMap>>,
        decoder: &mut EntityDecoder,
    ) -> Result<StyledSource> {
        let source_attr = item
            .get(slot::IfcMappedItem::MAPPING_SOURCE.index())
            .ok_or_else(|| Error::geometry("MappedItem missing MappingSource".to_string()))?;
        let source = decoder
            .resolve_ref(source_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve MappingSource".to_string()))?;
        let representation_attr = source.get(slot::IfcRepresentationMap::MAPPED_REPRESENTATION.index())
            .ok_or_else(|| Error::geometry("RepresentationMap missing MappedRepresentation".to_string()))?;
        let representation = decoder
            .resolve_ref(representation_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve MappedRepresentation".to_string()))?;
        // MappingTarget · MappingOrigin (#1985), scaled once for every use.
        let mut transform = self.mapped_item_transform(item, &source, decoder)?;
        if let Some(transform) = &mut transform {
            self.scale_transform(transform);
        }
        let solid_id = if eligible {
            self.dont_bake_solid(source.id, &representation, textures, decoder)
        } else {
            None
        };
        Ok(StyledSource { source_id: source.id, representation, transform, solid_id })
    }

    /// A styled source's items. A representation without an Items attribute
    /// walks nothing; one whose Items do not resolve is an error.
    pub(crate) fn styled_source_items(representation: &DecodedEntity, decoder: &mut EntityDecoder)
        -> Result<Vec<DecodedEntity>> {
        match representation.get(slot::IfcRepresentation::ITEMS.index()) {
            Some(items_attr) => Ok(decoder.resolve_ref_list(items_attr)?),
            None => Ok(Vec::new()),
        }
    }

    /// Publish a walked source's frame parts (source coordinates, before the
    /// mapping) for later occurrences. A multi-frame source is never cached
    /// or instanced: both assume one source-coords mesh per map (#6446).
    ///
    /// Shared model-wide cache first (#1623), else the per-router RefCell. A
    /// concurrent miss on the same source by another router rebuilds an
    /// identical source-coords mesh, so an overwrite is byte-identical. Brief
    /// lock only: the source walk ran outside it (no join held).
    pub(crate) fn publish_mapped_source(&self, source_id: u32, parts: &[Mesh], truncated: bool) -> Result<()> {
        match (&self.shared_mapped_item_cache, parts) {
            (Some(shared), [source]) => {
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
                // `truncated` is the same shape for the nesting bounds of the walk:
                // the depth cap and the cycle check depend on where in the walk the
                // source was reached, which `source_id` does not encode. A source
                // first met at depth 31 loses everything below it, and caching that
                // model-wide would serve the short mesh to a later occurrence reached
                // at depth 0, which would otherwise walk the whole chain. Non-empty
                // and budget-clean, so only this catches it.
                if !source.positions.is_empty() && !crate::kernel::budget::tripped() && !truncated {
                    let source_arc = self.clone_source_for_cache(source)?;
                    shared
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(source_id, source_arc);
                }
            }
            (None, [source]) => {
                let source_arc = self.clone_source_for_cache(source)?;
                self.mapped_item_cache.borrow_mut().insert(source_id, source_arc);
            }
            _ => {}
        }
        Ok(())
    }

    /// Apply an occurrence's scaled mapping transform to its source-coords
    /// parts. Instancing: all occurrences of a single-frame RepresentationMap
    /// share the cached source-coords geometry; `local_transform` is the
    /// mapping (canonical -> element-local), `transform` is filled later by the
    /// element's apply_placement (element-local -> world).
    pub(crate) fn place_mapped_parts(&self, source_id: u32, parts: &mut [Mesh], transform: Option<&Matrix4<f64>>) {
        let mut local_rm = None;
        if let Some(transform) = transform {
            if instancing_enabled() {
                local_rm = Some(mat4::from_na(transform));
            }
            for part in parts.iter_mut() {
                self.transform_mesh_local(part, transform);
            }
        }
        if let ([part], true) = (parts, instancing_enabled()) {
            part.instance_meta = Some(InstanceMeta {
                transform: mat4::IDENTITY,
                local_transform: local_rm,
                canonical_transform: None,
                rep_identity: source_id as u128,
                instanceable: true,
            });
        }
    }

    /// Bake a styled source's mapping into the sub-meshes its items produced.
    /// The MappingTarget is a PER-OCCURRENCE transform: baked into the vertices
    /// (flat output unchanged), and for INSTANCING recorded in an instanceable
    /// sub-mesh's `local_transform` (keeping its canonical `rep_identity`), so
    /// occurrences sharing a map but differing by target collate under one
    /// template (GLB export #1443, the multi-item class Phase 2 leaves flat). #1623
    pub(crate) fn bake_styled_mapping(&self, sub_meshes: &mut [crate::SubMesh], transform: &Matrix4<f64>) {
        let nontrivial_target = !transform.is_identity(1e-9);
        for sub in sub_meshes {
            self.transform_mesh_local(&mut sub.mesh, transform);
            if nontrivial_target {
                if let Some(instance) = sub.mesh.instance_meta.as_mut().filter(|instance| instance.instanceable) {
                    instance.local_transform = Some(match instance.local_transform {
                        // Nested map: outer target ∘ inner, bake order.
                        Some(inner) => mat4::from_na(&(transform * Matrix4::from_row_slice(&inner))),
                        None => mat4::from_na(transform),
                    });
                }
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

#[cfg(test)]
#[path = "mapped_item_tests.rs"]
mod tests;
