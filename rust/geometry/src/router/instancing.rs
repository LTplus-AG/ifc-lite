// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #1623 Phase 2 "don't-bake" router helpers: eligibility of a mapped source for
//! instancing, and the one-time source mesh into the shared registry that backs the
//! finalize's orphan recovery. The don't-bake decision itself lives at the top-level
//! mapped-item visitor in `submesh_walk.rs`.

use super::GeometryRouter;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use std::sync::Arc;
use crate::{Mesh, Result};

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
    /// The walk is the common mapping controller's
    /// (`crate::program::GeometryProgram::shared_mapped_source`): the same per-item
    /// step, ordered accumulation and once-per-source drop counting as a mapped
    /// item's own source walk, which writes the same model-wide cache entry. It
    /// shares that walk's insert guards — empty mesh and #1257 budget trip — but
    /// deliberately NOT its recursion into nested mapped items: this is a flat walk.
    /// The only caller reaches here having passed `mapped_source_single_item`, so
    /// the source is exactly ONE non-mapped item and a nested one cannot occur.
    /// Should that ever change, the walk bails without inserting rather than
    /// registering a mesh short of the source's real geometry — a truncated source
    /// under a key that does not encode the truncation is served to every later
    /// occurrence.
    ///
    /// The #6446 single-frame guard needs no copy here: one non-mapped item is one
    /// mesh with one origin, so it can never be a multi-frame source. A mixed
    /// near+far source has at least two items, so it never reaches this walk.
    pub(super) fn ensure_shared_mapped_source(
        &self,
        mapped_repr: &DecodedEntity,
        source_id: u32,
        decoder: &mut EntityDecoder,
    ) -> Result<()> {
        let Some(shared) = self.shared_mapped_item_cache.as_ref() else {
            // Without a shared registry there is nothing to recover from; callers
            // that arm output instancing always enable the shared cache too.
            return Ok(());
        };
        // A hit is coverage too (as in the mapped-item walk): refuse an
        // unaccounted shared cache under a bounded account before the lookup.
        self.check_mapped_cache_coverage()?;
        if shared
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(&source_id)
        {
            return Ok(());
        }
        crate::program::GeometryProgram::shared_mapped_source(mapped_repr, source_id)
            .drain_parts(self, decoder)
            .map(drop)
    }

    /// The shared registry walk's items. A representation whose items do not
    /// resolve walks nothing and so registers nothing.
    pub(crate) fn shared_source_items(mapped_repr: &DecodedEntity, decoder: &mut EntityDecoder) -> Vec<DecodedEntity> {
        mapped_repr
            .get(3)
            .and_then(|items_attr| decoder.resolve_ref_list(items_attr).ok())
            .unwrap_or_default()
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
mod tests {
    use crate::router::GeometryRouter;
    use ifc_lite_core::EntityDecoder;

    /// A Body source whose two items both fail to mesh: `#8` has no registered
    /// processor at all (the `None` arm), `#7` has one that errors on a null
    /// profile/placement (the `Err` arm). `ensure_shared_mapped_source` is the
    /// don't-bake path's own flat walk of a source, a separate entry into the
    /// mapping controller from a mapped item's, and its two drop arms had no test: deleting both
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
        router.ensure_shared_mapped_source(&rep, 100, &mut decoder).unwrap();

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
        router.ensure_shared_mapped_source(&rep, 101, &mut decoder).unwrap();

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
        router.ensure_shared_mapped_source(&rep, 102, &mut decoder).unwrap();

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

    /// `ensure_shared_mapped_source` walks the source's items FLAT — it does not
    /// recurse into a nested `IfcMappedItem` the way `process_mapped_item_cached`
    /// does. Handed a nested source anyway, it
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
        router.ensure_shared_mapped_source(&nested_rep, 21, &mut decoder).unwrap();
        assert_eq!(
            router.mapped_shared_unique_count(),
            0,
            "a flat walk of a nested source must not be registered"
        );

        // Negative half: the inner map's representation `#13` is a single solid,
        // the shape the caller actually reaches here, and it IS registered.
        let flat_rep = decoder.decode_by_id(13).expect("decode #13");
        router.ensure_shared_mapped_source(&flat_rep, 14, &mut decoder).unwrap();
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
        router.ensure_shared_mapped_source(&empty_rep, 999, &mut decoder).unwrap();
        assert_eq!(
            router.mapped_shared_unique_count(),
            0,
            "a source that meshes to zero positions must not be cached"
        );

        let flat_rep = decoder.decode_by_id(13).expect("decode #13");
        router.ensure_shared_mapped_source(&flat_rep, 999, &mut decoder).unwrap();
        assert_eq!(
            router.mapped_shared_unique_count(),
            1,
            "a real mesh for the same source id must still register after an \
             aborted empty attempt didn't poison the entry"
        );
    }
}
