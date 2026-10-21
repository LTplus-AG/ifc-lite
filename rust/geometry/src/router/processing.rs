// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Core element processing: resolving representations, processing items, and caching.

use super::frame_parts::{
    frames_mergeable, merge_admitted, mesh_bounds, single_frame, union_bounds, FrameParts,
};
use super::transforms::instancing_enabled;
use super::GeometryRouter;
use crate::{InstanceMeta, Mesh, Result, SubMeshCollection};
use crate::representation::{product_shape, rep_items, Select};

use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use std::rc::Rc;

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
                // Per-item sub-meshes, following MappedItem references through
                // the common mapping controller's styled walk; `allow_instancing`
                // enables the #1623 don't-bake decision at the top-level item.
                sub_meshes = crate::program::GeometryProgram::styled_item(
                    &item, sub_meshes, allow_instancing, texture_index, self.rtc_offset,
                )
                .drain_styled(self, decoder)?;
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
    pub(crate) fn textured_face_set(
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
#[path = "processing_hygiene_tests.rs"]
mod hygiene_tests;
