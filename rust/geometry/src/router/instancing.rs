// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #1623 Phase 2 "don't-bake" router helpers: eligibility of a mapped source for
//! instancing, and the one-time source mesh into the shared registry that backs the
//! finalize's orphan recovery. The don't-bake decision itself lives at the top-level
//! mapped-item branch of `collect_submeshes_from_item_inner` (see `processing.rs`).

use super::GeometryRouter;
use crate::Mesh;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use std::sync::Arc;

impl GeometryRouter {
    /// #1623 Phase 2 eligibility: if this `MappedRepresentation` resolves to exactly
    /// ONE direct (non-mapped) geometry item, return that item's express id, else
    /// `None`. The don't-bake template↔instance model represents an occurrence with a
    /// SINGLE placeholder / a SINGLE re-tagged sub-mesh, so it only applies when the
    /// source is one solid. Multi-item sources (each carrying its own per-item
    /// colour/rep_identity) and nested-mapped sources fall through to the normal flat
    /// materialize — never instanced, never lost. The returned id is used as the
    /// placeholder's `geometry_id` so colour resolves EXACTLY as the flat/template
    /// sub-mesh does (both key on the nested solid's id).
    pub(super) fn mapped_source_single_item(
        &self,
        mapped_repr: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<u32> {
        let items_attr = mapped_repr.get(3)?;
        let items = decoder.resolve_ref_list(items_attr).ok()?;
        match items.as_slice() {
            [only] if only.ifc_type != IfcType::IfcMappedItem => Some(only.id),
            _ => None,
        }
    }

    /// #1623 Phase 2: mesh a mapped source ONCE into the shared registry (source
    /// coords, pre-`MappingTarget`, pre-placement), if not already present. Called on
    /// the don't-bake instance path so the streaming finalize can recover an
    /// occurrence's geometry from the registry in the (effectively unreachable) case
    /// that the template occurrence never materialized — never a silent geometry loss.
    /// Mirrors `process_mapped_item_cached`'s miss path (incl. the #1257 budget-trip
    /// guard); the meshing runs OUTSIDE the brief lock (no join held under lock).
    pub(super) fn ensure_shared_mapped_source(
        &self,
        mapped_repr: &DecodedEntity,
        source_id: u32,
        decoder: &mut EntityDecoder,
    ) {
        let Some(shared) = self.shared_mapped_item_cache.as_ref() else {
            // Without a shared registry there is nothing to recover from; callers
            // that arm output instancing always enable the shared cache too.
            return;
        };
        if shared
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(&source_id)
        {
            return;
        }
        let mut mesh = Mesh::new();
        if let Some(items_attr) = mapped_repr.get(3) {
            if let Ok(items) = decoder.resolve_ref_list(items_attr) {
                for sub_item in items {
                    if sub_item.ifc_type == IfcType::IfcMappedItem {
                        continue;
                    }
                    if let Some(processor) = self.processors.get(&sub_item.ifc_type) {
                        if let Ok(mut sub_mesh) = processor.process(
                            &sub_item,
                            decoder,
                            &self.schema,
                            self.tessellation_quality,
                        ) {
                            sub_mesh.validate_indices();
                            self.scale_mesh(&mut sub_mesh);
                            mesh.merge(&sub_mesh);
                        }
                    }
                }
            }
        }
        if !mesh.positions.is_empty() && !crate::kernel::budget::tripped() {
            shared
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(source_id, Arc::new(mesh));
        }
    }
}
