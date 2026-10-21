// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Styled product roots, admitted before the existing mapping controller.
use super::{GeometryRouter, processing::SourceHygiene};
use crate::{Result, SubMeshCollection};
use crate::representation::MAX_WALK_LEVELS;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

impl GeometryRouter {
    /// Process element and return sub-meshes with their geometry item IDs.
    /// This preserves per-item identity for color/style lookup.
    ///
    /// For elements with multiple styled geometry items (like windows with frames + glass),
    /// this returns separate sub-meshes that can receive different colors.
    pub fn process_element_with_submeshes(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<SubMeshCollection> {
        // Public entry: the ordinary (non-void) element path, so the #1623 Phase 2
        // don't-bake instancing is allowed here. The void path
        // (`process_element_with_submeshes_and_voids`) calls the impl below with
        // `allow_instancing = false` — a voided occurrence must materialize its cut
        // geometry, never instance an un-cut shared template.
        self.process_element_with_submeshes_impl(element, decoder, true, None, SourceHygiene::Watertight)
    }

    /// [`Self::process_element_with_submeshes`] with an explicit don't-bake gate.
    /// `allow_instancing` is `true` only on the ordinary (non-void) path; the void
    /// path passes `false` so its occurrences always materialize. The don't-bake
    /// additionally requires an armed [`GeometryRouter::enable_output_instancing`]
    /// plan, so with no plan this is byte-identical to the historical flat path.
    /// `texture_index` is `Some` only on the textured non-void path (#1781).
    pub(super) fn process_element_with_submeshes_impl(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        allow_instancing: bool,
        texture_index: Option<
            &rustc_hash::FxHashMap<u32, crate::processors::texture::ResolvedTextureMap>,
        >,
        hygiene: SourceHygiene,
    ) -> Result<SubMeshCollection> {
        self.process_element_submeshes_with_budget(
            element, decoder, allow_instancing, texture_index, hygiene, MAX_WALK_LEVELS,
        )
    }

    pub(super) fn process_element_submeshes_with_budget(
        &self, element: &DecodedEntity, decoder: &mut EntityDecoder,
        allow_instancing: bool,
        texture_index: Option<&rustc_hash::FxHashMap<u32, crate::processors::texture::ResolvedTextureMap>>,
        hygiene: SourceHygiene, allowance: u32,
    ) -> Result<SubMeshCollection> {
        let plan = self.admitted_product(element, decoder, allowance)?;
        if plan.representations.iter().all(|(_, items)| items.is_empty()) {
            return Ok(SubMeshCollection::new());
        }
        // If a material-layer buildup is attached, try slicing single-solid
        // elements (walls / slabs with IfcMaterialLayerSetUsage) first so each
        // layer gets its own sub-mesh keyed by IfcMaterial id. An empty void
        // index is passed — the caller's has_openings branch takes the
        // voids-aware path below.
        // Slicing re-reads the product, so a truncated logical plan must use
        // only its completed roots below. The layer entry also gates its probe.
        if plan.refusal.is_none() {
            plan.validate(self, decoder)?;
            if let Some(layered) = self.try_layered_sub_meshes(element, decoder, None)? {
                crate::resource::check_current()?;
                return Ok(layered);
            }
        }
        crate::resource::check_current()?;

        let mut sub_meshes = SubMeshCollection::new();

        for (shape_rep, items) in &plan.representations {
            let fill_only = super::annotation::is_fill_only_representation(element, shape_rep);

            // Process each representation item, preserving geometry IDs
            for item in items {
                plan.validate(self, decoder)?;
                if element.ifc_type == IfcType::IfcAnnotation
                    && item.ifc_type == IfcType::IfcAnnotationFillArea
                {
                    sub_meshes.add(item.id, self.process_annotation_fill(item, decoder)?);
                    continue;
                }
                if fill_only {
                    continue; // symbolic annotation item, never meshed (#5389)
                }
                // A textured face set keeps its UV channel (#1781) and, like
                // any raw item, rebases in its own frame (#5698). A failed
                // textured build falls through to the untextured paths.
                // A terrain TIN is a face set that only appends `Flags` (#5942).
                let texture = texture_index
                    .and_then(|index| index.get(&item.id))
                    .filter(|_| matches!(
                        item.ifc_type,
                        IfcType::IfcTriangulatedFaceSet | IfcType::IfcTriangulatedIrregularNetwork
                    ));
                if let Some(map) = texture {
                    let offset = self.element_frame_rtc(element, decoder)?;
                    if let Some((mesh, uvs)) = self.textured_face_set(item, decoder, map, offset) {
                        sub_meshes.add_textured(item.id, mesh, uvs, map.attachment());
                        continue;
                    }
                }
                if let Some(mesh) = self.process_raw_item_for_element(item, element, decoder)? {
                    if !mesh.is_empty() {
                        sub_meshes.add(item.id, mesh);
                    }
                    continue;
                }
                // Per-item sub-meshes, following MappedItem references through
                // the common mapping controller's styled walk; `allow_instancing`
                // enables the #1623 don't-bake decision at the top-level item.
                sub_meshes = crate::program::GeometryProgram::styled_item(
                    item, sub_meshes, allow_instancing, texture_index, self.rtc_offset,
                )
                .drain_styled(self, decoder)?;
            }
        }

        crate::resource::check_current()?;
        // Source-triangle hygiene before placement — the per-style counterpart
        // to `process_element`'s choke point. Facet canonicalizers downstream do
        // not replace this cleanup or promise hygienic output; cut-created
        // candidates require path-specific handling. Positions are never
        // removed, so unreferenced ones may remain. See `SourceHygiene`
        // (#5313); a textured sub-mesh stays `IndexOnly` because an appended
        // apex vertex would desynchronise its parallel UV array. The layered
        // and textured early-return channels clean at their own sites and are
        // not switched (#5313 left them unmeasured). See #4797.
        for sub in &mut sub_meshes.sub_meshes {
            let own =
                if sub.uvs.is_some() { SourceHygiene::IndexOnly } else { hygiene.for_router(self) };
            own.apply(&mut sub.mesh);
        }

        self.apply_submesh_placement(&mut sub_meshes, element, decoder)?;
        Ok(sub_meshes)
    }

}
