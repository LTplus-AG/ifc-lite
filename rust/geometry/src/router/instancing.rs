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
    /// The meshing runs OUTSIDE the brief lock (no join held under lock).
    ///
    /// It shares `process_mapped_item_cached`'s insert guards — empty mesh and #1257
    /// budget trip — because both write the same model-wide cache, but deliberately
    /// NOT its recursion into nested mapped items: this is a flat walk. The only
    /// caller reaches here having passed `mapped_source_single_item`, so the source
    /// is exactly ONE non-mapped item and a nested one cannot occur. Should that ever
    /// change, the walk below bails without inserting rather than registering a mesh
    /// short of the source's real geometry — a truncated source under a key that does
    /// not encode the truncation is served to every later occurrence.
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
        // Same two rules the other three walks apply, from one place: a non-Body
        // source's dropped items are not a content loss, and this source's drops
        // are counted once rather than once per occurrence that re-walks it —
        // which is exactly this function, since the insert below is skipped for a
        // total-loss (empty) source and every later occurrence lands here again.
        // See `GeometryRouter::enter_unsupported_source`.
        let _drop_scope = self.enter_unsupported_source(source_id, mapped_repr);
        let mut mesh = Mesh::new();
        if let Some(items_attr) = mapped_repr.get(3) {
            if let Ok(items) = decoder.resolve_ref_list(items_attr) {
                for sub_item in items {
                    if sub_item.ifc_type == IfcType::IfcMappedItem {
                        // Unreachable via the only caller (see the doc above).
                        // Skipping it would leave `mesh` short of the source's real
                        // geometry, and the insert below would publish that model-wide.
                        //
                        // If it ever becomes reachable, note the second cost: the
                        // scope above has already CLAIMED `source_id` in
                        // `sources_recorded`, so a later, complete walk of the same
                        // source through `mapped_item.rs` would find it claimed and
                        // record nothing — losing its drops rather than duplicating
                        // them. Releasing the claim belongs with whatever makes this
                        // branch reachable.
                        return;
                    }
                    // A missing processor or a failing one leaves `mesh` short of
                    // the source's real geometry, and the insert below publishes
                    // that to EVERY instance of this source model-wide. The partial
                    // mesh itself is consistent with the per-occurrence path
                    // (`mapped_item.rs` also keeps going past a failed sub-item), so
                    // the drop is recorded rather than the source withheld — but it
                    // MUST be recorded, or the one place the loss is visible at all
                    // is the one place instancing removed.
                    match self.processors.get(&sub_item.ifc_type) {
                        Some(processor) => match processor.process(
                            &sub_item,
                            decoder,
                            &self.schema,
                            self.tessellation_quality,
                        ) {
                            Ok(mut sub_mesh) => {
                                sub_mesh.validate_indices();
                                self.scale_mesh(&mut sub_mesh);
                                mesh.merge(&sub_mesh);
                            }
                            Err(_e) => {
                                self.record_unsupported_item(sub_item.ifc_type);
                                crate::diag::diag_debug!(
                                    { item_id = sub_item.id, ifc_type = ?sub_item.ifc_type,
                                      error = %_e, "skipping unsupported shared-source item" }
                                    else {
                                        #[cfg(debug_assertions)]
                                        eprintln!(
                                            "[ifc-lite] Skipping unsupported shared-source item #{} ({:?}): {}",
                                            sub_item.id, sub_item.ifc_type, _e
                                        );
                                    }
                                );
                            }
                        },
                        None => {
                            self.record_unsupported_item(sub_item.ifc_type);
                            crate::diag::diag_debug!(
                                { item_id = sub_item.id, ifc_type = ?sub_item.ifc_type,
                                  "skipping unsupported shared-source item (no processor)" }
                                else {
                                    #[cfg(debug_assertions)]
                                    eprintln!(
                                        "[ifc-lite] Skipping unsupported shared-source item #{} ({:?}): no processor",
                                        sub_item.id, sub_item.ifc_type
                                    );
                                }
                            );
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

#[cfg(test)]
mod tests {
    use crate::router::GeometryRouter;
    use ifc_lite_core::EntityDecoder;

    /// A Body source whose two items both fail to mesh: `#8` has no registered
    /// processor at all (the `None` arm), `#7` has one that errors on a null
    /// profile/placement (the `Err` arm). `ensure_shared_mapped_source` is the
    /// don't-bake path's own flat walk of a source, structurally separate from
    /// `mapped_item.rs`'s, and its two drop arms had no test: deleting both
    /// `record_unsupported_item` calls left the whole suite green, so the one
    /// place a don't-bake occurrence's loss is visible was unguarded.
    const TWO_FAILING_ITEMS: &str = r#"
#7=IFCEXTRUDEDAREASOLID($,$,$,0.);
#8=IFCGEOMETRICSET(());
#9=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#7,#8));
"#;

    #[test]
    fn both_drop_arms_of_the_shared_source_walk_are_recorded() {
        let mut decoder = EntityDecoder::new(TWO_FAILING_ITEMS);
        let mut router = GeometryRouter::new();
        router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());

        let rep = decoder.decode_by_id(9).expect("decode #9");
        router.ensure_shared_mapped_source(&rep, 100, &mut decoder);

        assert_eq!(
            router.mapped_shared_unique_count(),
            0,
            "a source that meshes to nothing must not be published (unchanged)"
        );
        let unsupported = router.take_unsupported_items();
        assert_eq!(
            unsupported.get("IfcGeometricSet"),
            Some(&1),
            "the None arm (no processor for the type) must record: {unsupported:?}"
        );
        assert_eq!(
            unsupported.get("IfcExtrudedAreaSolid"),
            Some(&1),
            "the Err arm (processor ran and failed) must record: {unsupported:?}"
        );
    }

    /// The Body gate, on this walk. `plan_type_geometry` selects a type's
    /// RepresentationMaps by reference and instantiation only, so a 2D
    /// 'FootPrint'/'Annotation' map reaches the don't-bake path exactly as it
    /// reaches the other three, carrying items no processor handles and which
    /// are CORRECTLY absent from a 3D view. Counting them warns on a clean
    /// model. The other three walks already gated; this one did not.
    #[test]
    fn a_footprint_source_records_nothing_on_the_shared_source_walk() {
        let footprint = r#"
#8=IFCANNOTATIONFILLAREA($,());
#9=IFCSHAPEREPRESENTATION($,'FootPrint','Annotation2D',(#8));
"#;
        let mut decoder = EntityDecoder::new(footprint);
        let mut router = GeometryRouter::new();
        router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());

        let rep = decoder.decode_by_id(9).expect("decode #9");
        router.ensure_shared_mapped_source(&rep, 101, &mut decoder);

        let unsupported = router.take_unsupported_items();
        assert!(
            unsupported.is_empty(),
            "a 2D representation carries no 3D content to lose: {unsupported:?}"
        );
    }

    /// The other half of that gate, so it cannot be satisfied by never counting:
    /// the identical item under a Body representation IS a content loss.
    #[test]
    fn the_same_item_under_a_body_source_is_still_recorded_on_the_shared_source_walk() {
        let body = r#"
#8=IFCANNOTATIONFILLAREA($,());
#9=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#8));
"#;
        let mut decoder = EntityDecoder::new(body);
        let mut router = GeometryRouter::new();
        router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());

        let rep = decoder.decode_by_id(9).expect("decode #9");
        router.ensure_shared_mapped_source(&rep, 102, &mut decoder);

        let unsupported = router.take_unsupported_items();
        assert_eq!(
            unsupported.values().sum::<u64>(),
            1,
            "the gate keys on the representation, not on the item type: {unsupported:?}"
        );
    }

    fn fixture() -> String {
        std::fs::read_to_string("tests/fixtures/nested_mapped_item.ifc")
            .expect("read tests/fixtures/nested_mapped_item.ifc")
    }

    /// `ensure_shared_mapped_source` walks the source's items FLAT — it has no
    /// depth/visited bound, so it cannot recurse into a nested `IfcMappedItem` the
    /// way `process_mapped_item_cached` now does. Handed a nested source anyway, it
    /// must publish NOTHING: the shared cache is keyed on the source id, so a mesh
    /// missing the nested contribution would be served to every later occurrence,
    /// including through `process_mapped_item_cached`'s own lookup.
    ///
    /// `#20` is the outer map's representation: its own solid `#16` plus a nested
    /// mapped item `#19` on map `#14`.
    #[test]
    fn nested_source_is_not_registered_flat() {
        let content = fixture();
        let entity_index = ifc_lite_core::build_entity_index(&content);
        let mut decoder = EntityDecoder::with_index(&content, entity_index);
        let mut router = GeometryRouter::with_units(&content, &mut decoder);
        router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());

        let nested_rep = decoder.decode_by_id(20).expect("decode #20");
        router.ensure_shared_mapped_source(&nested_rep, 21, &mut decoder);
        assert_eq!(
            router.mapped_shared_unique_count(),
            0,
            "a flat walk of a nested source must not be registered"
        );

        // Negative half: the inner map's representation `#13` is a single solid,
        // the shape the caller actually reaches here, and it IS registered.
        let flat_rep = decoder.decode_by_id(13).expect("decode #13");
        router.ensure_shared_mapped_source(&flat_rep, 14, &mut decoder);
        assert_eq!(router.mapped_shared_unique_count(), 1);
    }

    /// The empty-mesh guard: a source that decodes fine but walks to ZERO items
    /// (`#40` is a well-formed `IfcShapeRepresentation` with an empty items list)
    /// must not be published into the shared registry — an empty/truncated source
    /// cached under `source_id` would be served to every later occurrence sharing
    /// that `IfcRepresentationMap`, per the doc on `ensure_shared_mapped_source`.
    ///
    /// The second half proves the guard doesn't poison the id going forward: a
    /// later call with the SAME `source_id` but a real single-solid source (`#13`)
    /// must still register, because the aborted empty attempt inserted nothing.
    #[test]
    fn empty_mesh_source_not_registered_then_real_source_still_is() {
        let content = fixture();
        let entity_index = ifc_lite_core::build_entity_index(&content);
        let mut decoder = EntityDecoder::with_index(&content, entity_index);
        let mut router = GeometryRouter::with_units(&content, &mut decoder);
        router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());

        let empty_rep = decoder.decode_by_id(40).expect("decode #40");
        router.ensure_shared_mapped_source(&empty_rep, 999, &mut decoder);
        assert_eq!(
            router.mapped_shared_unique_count(),
            0,
            "a source that meshes to zero positions must not be cached"
        );

        let flat_rep = decoder.decode_by_id(13).expect("decode #13");
        router.ensure_shared_mapped_source(&flat_rep, 999, &mut decoder);
        assert_eq!(
            router.mapped_shared_unique_count(),
            1,
            "a real mesh for the same source id must still register after an \
             aborted empty attempt didn't poison the entry"
        );
    }
}
