// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Core element processing: resolving representations, processing items, and caching.

use super::frame_parts::{
    frames_mergeable, merge_admitted, mesh_bounds, single_frame, union_bounds, FrameParts,
};
use super::transforms::instancing_enabled;
use crate::math::mat4;
use super::GeometryRouter;
use crate::{Error, InstanceMeta, Mesh, Result, SubMeshCollection};
use crate::representation::{product_shape, rep_items, Select};

use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use rustc_hash::FxHashSet;
use std::rc::Rc;

// Maximum nested IfcMappedItem depth for a single geometry item. Shared with
// `ifc_lite_processing::element` and the wasm styling colour resolver, which
// walk the same chain; the constant's own docs say why they must agree.
use ifc_lite_core::MAX_MAPPED_ITEM_DEPTH;

/// The nearest f32 that does not shrink the interval: rounds a minimum down
/// and a maximum up, so an f32 box always encloses the f64 geometry.
pub(super) fn enclosing_f32(value: f64, is_min: bool) -> f32 {
    let rounded = value as f32;
    match (is_min, (rounded as f64).partial_cmp(&value)) {
        (true, Some(std::cmp::Ordering::Greater)) => rounded.next_down(),
        (false, Some(std::cmp::Ordering::Less)) => rounded.next_up(),
        _ => rounded,
    }
}

/// Publish object-frame `local_bounds` for a mesh rebased by `offset`
/// (metres, item frame). No-op for an empty mesh.
///
/// Public bounds stay in the pre-RTC object frame (the contract
/// `local_to_world` pairs with), reconstituted from the rebased f32 positions
/// in f64 and then rounded OUTWARD to the enclosing f32 box: at a 5,000,000 m
/// offset the f32 ULP is 0.5 m, so a 0.125 m face would otherwise round both
/// faces onto one value and publish a zero extent (#5026 review).
fn publish_object_frame_bounds(mesh: &mut Mesh, offset: (f64, f64, f64)) {
    if mesh.positions.is_empty() {
        return;
    }
    let rebased = mesh_bounds(mesh);
    let offset = [offset.0, offset.1, offset.2];
    let mut bounds = [0.0f32; 6];
    for axis in 0..3 {
        let min = rebased[axis] as f64 + offset[axis];
        let max = rebased[axis + 3] as f64 + offset[axis];
        bounds[axis] = enclosing_f32(min, true);
        bounds[axis + 3] = enclosing_f32(max, false);
        if max > min && bounds[axis + 3] <= bounds[axis] {
            bounds[axis + 3] = bounds[axis].next_up();
        }
    }
    mesh.local_bounds = Some(bounds);
}

/// Scale mesh positions from file units to meters by `unit_scale`; a no-op at
/// `1.0`. Source-free, so owned numerical recipes apply the same scaling.
#[inline]
pub(crate) fn scale_positions(mesh: &mut Mesh, unit_scale: f64) {
    if unit_scale != 1.0 {
        let scale = unit_scale as f32;
        for pos in mesh.positions.iter_mut() {
            *pos *= scale;
        }
    }
}

/// Finish one item mesh at the boundary every item walk shares: strip
/// out-of-bounds indices, scale file units to metres, and publish object-frame
/// bounds when it was rebased by `rtc_offset` (metres, item frame).
pub(crate) fn finish_item_mesh(mesh: &mut Mesh, unit_scale: f64, rtc_offset: Option<(f64, f64, f64)>) {
    // Safety net: strip any out-of-bounds indices before downstream use
    mesh.validate_indices();
    scale_positions(mesh, unit_scale);
    if let Some(offset) = rtc_offset {
        publish_object_frame_bounds(mesh, offset);
    }
}

/// Which source hygiene an element's meshes get before placement (#5313).
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum SourceHygiene {
    /// [`Mesh::clean_degenerate_watertight`]: drops slivers without opening a
    /// T-junction. The default for output meshes.
    Watertight,
    /// [`Mesh::clean_degenerate`]: drops slivers, indices only. For meshes that
    /// are about to be boolean operands (void hosts, opening cutters): moving
    /// those inputs changed the cut on ~20 void hosts of the public corpus, so
    /// it is a separate, measured change.
    IndexOnly,
    /// Boolean inputs also split exactly collinear cap seams at an existing
    /// same-face apex index, without changing vertex arrays (#7292).
    BooleanOperand,
}

impl SourceHygiene {
    /// `self`, downgraded to `IndexOnly` while the router is told to keep
    /// triangle order (see `GeometryRouter::set_preserve_triangle_order`).
    pub(super) fn for_router(self, router: &GeometryRouter) -> Self {
        if router.preserve_triangle_order.get() { Self::IndexOnly } else { self }
    }

    pub(super) fn apply(self, mesh: &mut Mesh) {
        match self {
            Self::Watertight => mesh.clean_degenerate_watertight(),
            Self::IndexOnly => mesh.clean_degenerate(),
            Self::BooleanOperand => mesh.clean_degenerate_exact_indexed(),
        }
    }
}

impl GeometryRouter {
    /// Process building element (IfcWall, IfcBeam, etc.) into mesh
    /// Follows the representation chain:
    /// Element → Representation → ShapeRepresentation → Items
    ///
    /// Errors when the items cannot share one f64 frame (#6349); use
    /// [`Self::process_element_parts`] to keep such products at full precision.
    #[inline]
    pub fn process_element(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Mesh> {
        single_frame(element.id, self.process_element_parts(element, decoder)?)
    }

    /// [`Self::process_element`] as frame parts: one mesh, unless body items lie
    /// in frames at least 1 km apart, which stay separate meshes (#6349).
    pub fn process_element_parts(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Mesh>> {
        self.process_element_parts_with_hygiene(element, decoder, SourceHygiene::Watertight)
    }

    /// [`Self::process_element_parts`] with an explicit [`SourceHygiene`]; the
    /// void path passes `IndexOnly` for hosts and cutters.
    pub(super) fn process_element_parts_with_hygiene(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        hygiene: SourceHygiene,
    ) -> Result<Vec<Mesh>> {
        // IfcAlignment carries its directrix curve in a dedicated `Axis`
        // attribute (IFC4X1) instead of (or in addition to) a normal
        // IfcShapeRepresentation. Route those through the alignment
        // processor before the standard representation walk, since the
        // Representation is often `$` in practice.
        if element.ifc_type == IfcType::IfcAlignment {
            if let Some(mesh) = self.try_alignment_mesh(element, decoder)? {
                return Ok(vec![mesh]);
            }
        }

        let Some(shape) = product_shape(element, decoder)? else {
            return Ok(vec![Mesh::new()]); // No geometry
        };

        // Process all representations and merge meshes
        let mut combined_mesh = Mesh::new();
        let mut rebased_mesh = Mesh::new();
        let mut captured_local_bounds: Option<[f32; 6]> = None;
        // #6349: items too far from `combined_mesh`'s frame, and the RTC-frame items' own bounds.
        let (mut far_parts, mut rebased_bounds) = (FrameParts::default(), None);

        // Instancing: an element is cleanly shareable only when its whole body is
        // exactly ONE representation item that itself carried instance metadata
        // (a mapped item). `Mesh::merge` does not propagate the side-channel, so we
        // capture the single item's metadata here and re-attach it below; any second
        // item disqualifies the element (left as None -> rendered flat).
        let mut single_instance_meta: Option<InstanceMeta> = None;
        let mut instanceable_item_count: usize = 0;

        // Body representations only ('Axis', 'FootPrint', 'Box' are skipped), and
        // a MappedRepresentation is skipped when direct geometry duplicates it.
        'items: for shape_rep in shape.select(element, Select::Meshed) {
            let items = rep_items(shape_rep, decoder)?;
            let fill_only = super::annotation::is_fill_only_representation(element, shape_rep);

            // Process each representation item
            // A mapped item whose source mixes frames yields one mesh per frame (#6446).
            for item in items {
                let item_parts = if element.ifc_type == IfcType::IfcAnnotation
                    && item.ifc_type == IfcType::IfcAnnotationFillArea
                {
                    vec![self.process_annotation_fill(&item, decoder)?]
                } else if fill_only {
                    continue; // symbolic annotation item, never meshed (#5389)
                } else if let Some(mesh) =
                    self.process_raw_item_for_element(&item, element, decoder)?
                {
                    vec![mesh]
                } else {
                    self.process_representation_item_parts(&item, decoder)?
                };
                for mesh in item_parts {
                    if mesh.positions.is_empty() {
                        continue; // Mesh::merge would ignore it too
                    }
                    let bounds = mesh.local_bounds.unwrap_or_else(|| mesh_bounds(&mesh));
                    if instancing_enabled() {
                        instanceable_item_count += 1;
                        single_instance_meta = if instanceable_item_count == 1 {
                            mesh.instance_meta.clone()
                        } else {
                            None
                        };
                    }
                    // #5684: early f64 processors and ordinary f32 processors can
                    // return different RTC frames. Merge only like frames until
                    // placement has brought both into the world/RTC frame.
                    if mesh.rtc_applied {
                        if !merge_admitted(&mut rebased_mesh, &mesh) {
                            break 'items;
                        }
                        union_bounds(&mut rebased_bounds, bounds);
                        continue;
                    } else if combined_mesh.positions.is_empty()
                        || frames_mergeable(combined_mesh.origin, mesh.origin)
                    {
                        if !merge_admitted(&mut combined_mesh, &mesh) {
                            break 'items;
                        }
                    } else {
                        far_parts.merge(&mesh, bounds);
                        continue;
                    }
                    union_bounds(&mut captured_local_bounds, bounds);
                }
            }
        }
        // A refused merge only records the account's sticky stop; surface it
        // before hygiene or placement run over partial output.
        if crate::resource::is_active() {
            crate::resource::check_current()?;
        }
        if combined_mesh.positions.is_empty() {
            std::mem::swap(&mut combined_mesh, &mut rebased_mesh);
            captured_local_bounds = rebased_bounds.take();
        }

        // Re-attach single-item instance metadata so apply_placement can fold the
        // element's world placement into `transform`.
        if instancing_enabled() {
            combined_mesh.instance_meta = single_instance_meta;
        }
        combined_mesh.local_bounds = captured_local_bounds;

        // Source-triangle hygiene before placement (rigid transforms preserve
        // degeneracy, while the element-local frame retains more f32 precision).
        // This is the merged-mesh router's choke point: downstream facet weld /
        // refinement passes canonicalize geometry but do not replace this input
        // cleanup or promise hygienic output. See `SourceHygiene` (#5313).
        // Cut-created candidates require separate, path-specific handling. See
        // #4797.
        hygiene.for_router(self).apply(&mut combined_mesh);

        // Apply placement transformation
        self.apply_placement(element, decoder, &mut combined_mesh)?;
        let rebased = (rebased_mesh, rebased_bounds);
        self.place_frame_parts(element, decoder, hygiene, combined_mesh, far_parts, rebased)
    }

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
        // If a material-layer buildup is attached, try slicing single-solid
        // elements (walls / slabs with IfcMaterialLayerSetUsage) first so each
        // layer gets its own sub-mesh keyed by IfcMaterial id. An empty void
        // index is passed — the caller's has_openings branch takes the
        // voids-aware path below.
        if let Some(layered) = self.try_layered_sub_meshes(element, decoder, None) {
            return Ok(layered);
        }

        let Some(shape) = product_shape(element, decoder)? else {
            return Ok(SubMeshCollection::new()); // No geometry
        };

        let mut sub_meshes = SubMeshCollection::new();

        for shape_rep in shape.select(element, Select::Meshed) {
            let items = rep_items(shape_rep, decoder)?;
            let fill_only = super::annotation::is_fill_only_representation(element, shape_rep);

            // Process each representation item, preserving geometry IDs
            for item in items {
                if element.ifc_type == IfcType::IfcAnnotation
                    && item.ifc_type == IfcType::IfcAnnotationFillArea
                {
                    sub_meshes.add(item.id, self.process_annotation_fill(&item, decoder)?);
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
                    if let Some((mesh, uvs)) = self.textured_face_set(&item, decoder, map, offset) {
                        sub_meshes.add_textured(item.id, mesh, uvs, map.attachment());
                        continue;
                    }
                }
                if let Some(mesh) = self.process_raw_item_for_element(&item, element, decoder)? {
                    if !mesh.is_empty() {
                        sub_meshes.add(item.id, mesh);
                    }
                    continue;
                }
                self.collect_submeshes_from_item(
                    &item,
                    decoder,
                    &mut sub_meshes,
                    allow_instancing,
                    texture_index,
                )?;
            }
        }

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

    /// Collect sub-meshes from a representation item, following MappedItem references.
    /// `allow_instancing` enables the #1623 Phase 2 don't-bake path at the top-level
    /// mapped item (see [`Self::collect_submeshes_from_item_inner`]).
    fn collect_submeshes_from_item(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        sub_meshes: &mut SubMeshCollection,
        allow_instancing: bool,
        texture_index: Option<
            &rustc_hash::FxHashMap<u32, crate::processors::texture::ResolvedTextureMap>,
        >,
    ) -> Result<()> {
        let mut visited = FxHashSet::default();
        self.collect_submeshes_from_item_inner(
            item,
            decoder,
            sub_meshes,
            0,
            &mut visited,
            allow_instancing,
            texture_index,
        )
    }

    #[allow(clippy::too_many_arguments)] // internal recursion carries per-walk state
    fn collect_submeshes_from_item_inner(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        sub_meshes: &mut SubMeshCollection,
        depth: usize,
        visited: &mut FxHashSet<u32>,
        allow_instancing: bool,
        texture_index: Option<
            &rustc_hash::FxHashMap<u32, crate::processors::texture::ResolvedTextureMap>,
        >,
    ) -> Result<()> {
        if depth >= MAX_MAPPED_ITEM_DEPTH as usize {
            return Err(Error::geometry(format!(
                "MappedItem nesting exceeded maximum depth of {} at #{}",
                MAX_MAPPED_ITEM_DEPTH, item.id
            )));
        }

        // For MappedItem, recurse into the mapped representation
        if item.ifc_type == IfcType::IfcMappedItem {
            if !visited.insert(item.id) {
                return Err(Error::geometry(format!(
                    "Detected cyclic IfcMappedItem reference at #{}",
                    item.id
                )));
            }

            // Get MappingSource (RepresentationMap)
            let source_attr = item
                .get(0)
                .ok_or_else(|| Error::geometry("MappedItem missing MappingSource".to_string()))?;

            let source_entity = decoder
                .resolve_ref(source_attr)?
                .ok_or_else(|| Error::geometry("Failed to resolve MappingSource".to_string()))?;
            let source_id = source_entity.id;

            // Get MappedRepresentation from RepresentationMap (attribute 1)
            let mapped_repr_attr = source_entity.get(1).ok_or_else(|| {
                Error::geometry("RepresentationMap missing MappedRepresentation".to_string())
            })?;

            let mapped_repr = decoder.resolve_ref(mapped_repr_attr)?.ok_or_else(|| {
                Error::geometry("Failed to resolve MappedRepresentation".to_string())
            })?;

            // MappingTarget · MappingOrigin (#1985: the origin used to be dropped).
            let mapping_transform = self.mapped_item_transform(item, &source_entity, decoder)?;

            // #1623 Phase 2/3 "don't-bake": if this top-level mapped item's source is
            // a REPEATED (count >= 2) single-solid `IfcRepresentationMap` the armed
            // plan lists, exactly ONE occurrence (the "template") materializes its
            // geometry; every OTHER occurrence skips the per-occurrence vertex clone /
            // MappingTarget bake / weld and emits an instance-only placeholder (empty
            // geometry carrying the mapping transform + rep_identity in `InstanceMeta`).
            // `apply_submesh_placement` folds the world placement into `im.transform`;
            // the finalize turns the placeholder into an occurrence against the template.
            //
            // `instance_solid_id` is the nested SOLID's id (used as the placeholder's
            // geometry_id so colour resolves EXACTLY as the flat/template sub-mesh).
            // Only fires at the TOP level (`depth == 0`) — a mapped item nested inside
            // another map is part of its parent's shared geometry, not an independent
            // occurrence — and only when `allow_instancing` (the non-void path). With
            // no armed plan this is skipped entirely, so the flat output is unchanged.
            let instance_solid_id: Option<u32> = if allow_instancing && depth == 0 {
                self.output_instancing_plan()
                    .and_then(|plan| plan.get(&source_id).copied())
                    .filter(|&(count, _)| count >= 2)
                    .and_then(|_| {
                        self.mapped_source_single_item(&mapped_repr, decoder)
                            // #858: a source whose single solid carries an
                            // IfcIndexedColourMap must materialize flat so
                            // emit_sub_meshes can split it into one mesh per palette
                            // group. An instance placeholder resolves ONE colour,
                            // collapsing the palette (WRONG vs the flat path); route
                            // to flat instead (byte-identical to instancing-off).
                            .filter(|&item_id| !self.is_indexed_colour_split_source(item_id))
                            // #1781: same rule for a TEXTURED single solid — an
                            // instance placeholder carries no UVs/texture, so the
                            // occurrence would render untextured. Materialize flat.
                            .filter(|&item_id| {
                                texture_index.is_none_or(|ti| !ti.contains_key(&item_id))
                            })
                    })
            } else {
                None
            };
            // Which occurrence MATERIALIZES the template. Native (global) mode: the
            // plan's deterministic min-id occurrence, so all occurrences resolve
            // against ONE model-wide template across the rayon pool. WASM batch-local
            // mode: the FIRST occurrence of this source seen by this router/batch (the
            // rest don't-bake), so each per-batch shard is self-contained. Both emit
            // geometrically identical world triangles.
            let is_template = match instance_solid_id {
                None => true, // not eligible ⇒ materialize flat as usual
                Some(_) if self.instancing_batch_local() => {
                    self.mark_source_materialized_if_first(source_id)
                }
                Some(_) => {
                    let template_item_id = self
                        .output_instancing_plan()
                        .and_then(|plan| plan.get(&source_id))
                        .map(|&(_, t)| t)
                        .unwrap_or(item.id);
                    item.id == template_item_id
                }
            };
            if let Some(solid_item_id) = instance_solid_id {
                if !is_template {
                    // NON-template occurrence: don't-bake. Ensure the shared registry
                    // holds the source geometry (meshed once model-wide) so the
                    // finalize can recover geometry even in the (effectively
                    // unreachable) case that the template occurrence never
                    // materialized, then push the instance-only placeholder. Its
                    // geometry_id is the nested SOLID's id (not the mapped-item id) so
                    // emit_sub_meshes resolves the occurrence colour identically to the
                    // flat/template sub-mesh.
                    self.ensure_shared_mapped_source(&mapped_repr, source_id, decoder)?;
                    let local_rm = mapping_transform.map(|mut t| {
                        self.scale_transform(&mut t);
                        mat4::from_na(&t)
                    });
                    let mut placeholder = Mesh::new();
                    placeholder.instance_meta = Some(InstanceMeta {
                        transform: mat4::IDENTITY,
                        local_transform: local_rm,
                        canonical_transform: None,
                        rep_identity: source_id as u128,
                        instanceable: true,
                    });
                    // Push directly (SubMeshCollection::add drops empty meshes; this
                    // placeholder is intentionally empty — its InstanceMeta is the payload).
                    sub_meshes
                        .sub_meshes
                        .push(crate::SubMesh::new(solid_item_id, placeholder));
                    visited.remove(&item.id);
                    return Ok(());
                }
            }
            // Record where THIS mapped item's sub-meshes start, so the don't-bake
            // TEMPLATE occurrence can be re-tagged with the source-id rep_identity
            // after the normal materialize below (see the retag after the loop).
            let mapped_items_start = sub_meshes.len();

            // One scope for this source's walk. It covers the loop below AND the
            // recursion beneath it: an unsupported item of this source is dropped
            // one level down, by the plain-item arm at the end of this function,
            // not by the loop here — so a gate written at this loop's own drop
            // site would never see the case it exists for. Body-only, and once
            // per source rather than once per occurrence; see
            // `GeometryRouter::enter_unsupported_source`.
            let _drop_scope = self.enter_unsupported_source(source_id, &mapped_repr);

            // Get items from the mapped representation
            if let Some(items_attr) = mapped_repr.get(3) {
                let items = decoder.resolve_ref_list(items_attr)?;
                for nested_item in items {
                    // Recursively collect sub-meshes (skip unsupported geometry types).
                    // Nested items never independently don't-bake (`allow_instancing =
                    // false`): they are this occurrence's own shared geometry.
                    let count_before = sub_meshes.len();
                    if let Err(_e) = self.collect_submeshes_from_item_inner(
                        &nested_item,
                        decoder,
                        sub_meshes,
                        depth + 1,
                        visited,
                        false,
                        texture_index,
                    ) {
                        self.record_unsupported_item(nested_item.ifc_type.clone());
                        crate::diag::diag_debug!(
                            { item_id = nested_item.id, ifc_type = ?nested_item.ifc_type,
                              error = %_e, "skipping unsupported nested geometry item" }
                            else {
                                #[cfg(debug_assertions)]
                                eprintln!(
                                    "[ifc-lite] Skipping unsupported nested geometry #{} ({:?}): {}",
                                    nested_item.id, nested_item.ifc_type, _e
                                );
                            }
                        );
                        continue;
                    }

                    // Apply MappedItem transform to newly added sub-meshes.
                    if let Some(mut transform) = mapping_transform {
                        self.scale_transform(&mut transform);
                        // The MappingTarget is a PER-OCCURRENCE transform: baked into the
                        // vertices here (flat output byte-for-byte unchanged), and for
                        // INSTANCING recorded in `local_transform` (keeping the canonical,
                        // pre-target `rep_identity`) — mirroring `process_mapped_item_cached`
                        // and the don't-bake TEMPLATE re-tag below — so occurrences sharing a
                        // map but differing by target collate under one template. Previously
                        // this RE-HASHED into `rep_identity`, giving every target a unique id
                        // and disabling instancing (GLB export #1443) for the MULTI-item class
                        // Phase 2 leaves flat (Tekla assemblies / MEP / metering skids). #1623
                        let nontrivial_target = !transform.is_identity(1e-9);
                        for sub in &mut sub_meshes.sub_meshes[count_before..] {
                            self.transform_mesh_local(&mut sub.mesh, &transform);
                            if nontrivial_target {
                                if let Some(im) =
                                    sub.mesh.instance_meta.as_mut().filter(|im| im.instanceable)
                                {
                                    im.local_transform = Some(match im.local_transform {
                                        // Nested map: outer target ∘ inner, bake order.
                                        Some(inner) => mat4::from_na(
                                            &(transform * nalgebra::Matrix4::from_row_slice(&inner)),
                                        ),
                                        None => mat4::from_na(&transform),
                                    });
                                }
                            }
                        }
                    }
                }
            }

            // #1623 Phase 2/3: this is the don't-bake TEMPLATE occurrence. It
            // materialized normally above (byte-identical to a flat occurrence — a
            // single-solid source ⇒ exactly one sub-mesh). Re-tag its `rep_identity`
            // to the source id and record the (scaled) MappingTarget as
            // `local_transform`, MATCHING the instance placeholders so the finalize
            // collates them onto this template. The baked geometry is untouched — the
            // MappingTarget is already folded into both the vertices AND
            // `local_transform`, which is consistent (the template's world geometry is
            // `transform · local_transform · source`, so `m_ref` recovers the same
            // `source` the placeholders reference). See the finalize in processor/mod.rs.
            if instance_solid_id.is_some() && is_template {
                let local_rm = mapping_transform.map(|mut t| {
                    self.scale_transform(&mut t);
                    mat4::from_na(&t)
                });
                for sub in &mut sub_meshes.sub_meshes[mapped_items_start..] {
                    if let Some(im) = sub.mesh.instance_meta.as_mut() {
                        im.rep_identity = source_id as u128;
                        im.local_transform = local_rm;
                    }
                }
            }

            visited.remove(&item.id);
        } else {
            // Textured tessellated face set (#1781): mesh with per-vertex UVs so
            // the occurrence path renders its image like the type-geometry path
            // (#961) always did. Bypasses the content-dedup cache — the cached
            // mesh has no UV channel, and UVs are per-face-set anyway. Falls
            // through to the plain path if the textured build fails. A nested
            // (mapped) item rebases by the model RTC (#5698) into its origin,
            // since its mapping targets and placement still apply (#7690).
            if let Some(map) = texture_index.and_then(|ti| ti.get(&item.id)) {
                let textured = self.textured_face_set(item, decoder, map, Some(self.rtc_offset));
                if let Some((mut mesh, uvs)) = textured {
                    if depth > 0 {
                        self.keep_rebase_in_origin(&mut mesh);
                    }
                    sub_meshes.add_textured(item.id, mesh, uvs, map.attachment());
                    return Ok(());
                }
            }
            // Regular geometry item - process and record with its ID
            // Skip unsupported geometry types (e.g. IfcGeometricSet) instead of failing
            match self.process_representation_item(item, decoder) {
                Ok(mut mesh) => {
                    if depth > 0 {
                        self.keep_rebase_in_origin(&mut mesh);
                    }
                    if !mesh.is_empty() {
                        sub_meshes.add(item.id, mesh);
                    }
                }
                Err(_e) => {
                    self.record_unsupported_item(item.ifc_type.clone());
                    crate::diag::diag_debug!(
                        { item_id = item.id, ifc_type = ?item.ifc_type, error = %_e,
                          "skipping unsupported geometry item" }
                        else {
                            #[cfg(debug_assertions)]
                            eprintln!(
                                "[ifc-lite] Skipping unsupported geometry #{} ({:?}): {}",
                                item.id, item.ifc_type, _e
                            );
                        }
                    );
                }
            }
        }

        Ok(())
    }

    /// Process a single representation item (IfcExtrudedAreaSolid, etc.), with
    /// content-dedup: a 128-bit structural hash of the item subtree skips the
    /// meshing + CSG for geometry byte-identical to an item meshed earlier (e.g.
    /// the thousands of Tekla connection plates/bolts an exporter failed to share
    /// via `IfcMappedItem`). The cached mesh is colour-free and pre-placement; the
    /// caller keeps this item's own `geometry_id` (so colour/palette/texture stay
    /// per-instance) and applies voids + placement afterwards, so a cache hit is
    /// indistinguishable from a fresh build.
    #[inline]
    pub fn process_representation_item(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Mesh> {
        // The curve-capped flag (#4901) is drained where the processor runs,
        // in the common item program, so every walk reports it once.
        self.process_representation_item_in_frame(item, decoder, self.rtc_offset)
    }

    /// [`Self::process_representation_item`] with the model RTC offset
    /// expressed in the item's own frame (`offset_meters`, #5698), so an
    /// element-frame rebase shares the content-dedup cache and direct-solid
    /// instancing of the model-frame path.
    fn process_representation_item_in_frame(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        offset_meters: (f64, f64, f64),
    ) -> Result<Mesh> {
        // MappedItem has its own instancing cache (the source representation is
        // already shared), so it never enters the structural-hash path. It also
        // sets its own instance_meta, so direct-solid tagging is skipped.
        if item.ifc_type == IfcType::IfcMappedItem {
            return self.process_mapped_item_cached(item, decoder);
        }
        crate::program::GeometryProgram::representation_item(item, offset_meters).drain(self, decoder)
    }

    /// Mesh a raw-coordinate item (tessellated, Brep, surface model or
    /// direct face) in an element-local RTC frame.
    ///
    /// Model RTC is world-space; subtracting it directly from object-space
    /// coordinates is only correct for an identity placement. Pull the RTC
    /// vector through the placement's inverse linear transform so the later
    /// placement produces `M(p) - rtc` for rotated/scaled elements as well.
    /// `None` when the item is not a raw-coordinate item beyond the RTC
    /// threshold; the ordinary item path then handles it.
    pub(in crate::router) fn process_raw_item_for_element(
        &self,
        item: &DecodedEntity,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<Mesh>> {
        if !self.has_rtc_offset()
            || !self
                .representation_item_first_vertex_meters(item, decoder)
                .is_some_and(crate::coord_is_large)
        {
            return Ok(None);
        }
        if self.processor_for(&item.ifc_type).is_none() {
            return Ok(None);
        }
        let Some(offset) = self.element_frame_rtc(element, decoder)? else {
            return Ok(None);
        };
        // The ordinary item path, in the element's frame: it keeps content
        // dedup and direct-solid instancing (keyed by the offset), and a
        // declined rebase is decided in the right frame too (#5684).
        self.process_representation_item_in_frame(item, decoder, offset).map(Some)
    }

    /// The model RTC offset expressed in `element`'s object frame (metres):
    /// pulled through the placement's inverse linear transform, so placing
    /// a mesh rebased by it yields `M(p) - rtc`. `None` for a singular
    /// placement, where no object-frame offset exists.
    fn element_frame_rtc(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<(f64, f64, f64)>> {
        let mut placement = self.get_placement_transform_from_element(element, decoder)?;
        self.scale_transform(&mut placement);
        let linear = placement.fixed_view::<3, 3>(0, 0).into_owned();
        Ok(linear.try_inverse().map(|inverse| {
            let rtc = inverse
                * nalgebra::Vector3::new(self.rtc_offset.0, self.rtc_offset.1, self.rtc_offset.2);
            (rtc.x, rtc.y, rtc.z)
        }))
    }

    /// A textured `IfcTriangulatedFaceSet` meshed with its per-vertex UVs,
    /// unit-scaled and rebased by `offset_meters` (item frame) when that
    /// preserves precision (#5698). Shared by the occurrence walk and the
    /// type-geometry walk (#7690). `None` when the item is not a face set,
    /// or the textured build fails or is empty.
    pub(super) fn textured_face_set(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        map: &crate::processors::texture::ResolvedTextureMap,
        offset_meters: Option<(f64, f64, f64)>,
    ) -> Option<(Mesh, Vec<f32>)> {
        // A terrain TIN is a face set that only appends `Flags` (#5942).
        if !matches!(item.ifc_type, IfcType::IfcTriangulatedFaceSet | IfcType::IfcTriangulatedIrregularNetwork) {
            return None;
        }
        let rtc = offset_meters.and_then(|offset| {
            self.raw_item_rtc_file_units(item, decoder, offset)
                .zip(Some(offset))
        });
        let proc = crate::processors::TriangulatedFaceSetProcessor::new();
        let (mut mesh, uvs) = proc
            .process_with_texture_rebased(item, decoder, map, rtc.map(|(file_units, _)| file_units))
            .ok()?;
        if mesh.is_empty() {
            return None;
        }
        self.scale_mesh(&mut mesh); // UVs are unaffected by scale
        if let Some((_, offset)) = rtc {
            publish_object_frame_bounds(&mut mesh, offset);
        }
        Some((mesh, uvs))
    }

    /// `offset_meters` in file units when rebasing `item` by it before f32
    /// narrowing reduces the item's coordinate magnitude; `None` when there
    /// is no model RTC or the item is not raw-coordinate geometry (#5684).
    pub(crate) fn raw_item_rtc_file_units(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        offset_meters: (f64, f64, f64),
    ) -> Option<(f64, f64, f64)> {
        (self.has_rtc_offset()
            && self.representation_item_benefits_from_rtc(item, decoder, offset_meters))
        .then(|| {
            (
                offset_meters.0 / self.unit_scale,
                offset_meters.1 / self.unit_scale,
                offset_meters.2 / self.unit_scale,
            )
        })
    }

    /// Run an `IfcAlignment` through the dedicated alignment processor, then
    /// apply the standard unit scale + placement transform. Returns `None`
    /// when the alignment has no recognisable directrix curve (the caller
    /// falls back to normal representation processing).
    fn try_alignment_mesh(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<Mesh>> {
        let processor = match self.processor_for(&IfcType::IfcAlignment) {
            Some(p) => Rc::clone(p),
            None => return Ok(None),
        };
        let mut mesh =
            match processor.process(element, decoder, self.schema, self.tessellation_quality) {
            Ok(m) => m,
            // Missing Axis or unparseable curve isn't fatal — fall back so
            // the caller can still walk a normal representation if present.
            Err(_) => return Ok(None),
        };
        if mesh.positions.is_empty() {
            return Ok(None);
        }
        mesh.validate_indices();
        self.scale_mesh(&mut mesh);
        self.apply_placement(element, decoder, &mut mesh)?;
        Ok(Some(mesh))
    }

    /// Drain refs the content-hash walk refused above `u32::MAX` (#3421/#3752).
    pub fn take_content_hash_oversized_ref_drops(&self) -> usize {
        std::mem::take(&mut *self.content_hash_oversized_ref_drops.borrow_mut())
    }
}

#[cfg(test)]
#[path = "processing_shared_cap_tests.rs"]
mod shared_cap_tests;

#[cfg(test)]
#[path = "processing_hygiene_tests.rs"]
mod hygiene_tests;
