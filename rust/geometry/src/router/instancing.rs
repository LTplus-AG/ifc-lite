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
        placeholder.instance_meta = Some(InstanceMeta::instanceable(source_id as u128, transform.map(mat4::from_na)));
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

#[cfg(test)]
#[path = "styled_walk_tests.rs"]
mod styled_walk_tests;
