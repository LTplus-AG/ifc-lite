// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Core element processing: resolving representations, processing items, and caching.

use super::frame_parts::{mesh_bounds, single_frame};
use super::GeometryRouter;
use crate::{Mesh, Result, SubMeshCollection};

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
pub(crate) enum SourceHygiene {
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
    pub(crate) fn for_router(self, router: &GeometryRouter) -> Self {
        if router.preserve_triangle_order.get() { Self::IndexOnly } else { self }
    }

    pub(crate) fn apply(self, mesh: &mut Mesh) {
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
    pub(crate) fn process_element_parts_with_hygiene(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        hygiene: SourceHygiene,
    ) -> Result<Vec<Mesh>> {
        // The walk (alignment axis, representations in order, items through
        // their canonical item/cache or mapping children, frame-aware merge,
        // hygiene and placement) is the common program's product control.
        crate::program::GeometryProgram::product(element, hygiene).drain_parts(self, decoder)
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

        // Per-item sub-meshes (annotation fills, textured face sets, raw
        // items in their element frame and the styled mapping walk, whose
        // `allow_instancing` enables the #1623 don't-bake decision), their
        // source hygiene and placement: the common program's product control.
        crate::program::GeometryProgram::styled_product(element, allow_instancing, texture_index, hygiene)
            .drain_styled(self, decoder)
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
        // MappedItem has its own instancing cache (the source representation is
        // already shared), so it never enters the structural-hash path. It also
        // sets its own instance_meta, so direct-solid tagging is skipped.
        if item.ifc_type == IfcType::IfcMappedItem {
            return self.process_mapped_item_cached(item, decoder);
        }
        crate::program::GeometryProgram::representation_item(item, self.rtc_offset).drain(self, decoder)
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

    /// Run an `IfcAlignment` through the dedicated alignment processor and
    /// scale it to metres; the product control places it. `None` when the
    /// alignment has no recognisable directrix curve (the walk falls back to
    /// normal representation processing).
    pub(crate) fn alignment_mesh(&self, element: &DecodedEntity, decoder: &mut EntityDecoder) -> Option<Mesh> {
        let processor = Rc::clone(self.processor_for(&IfcType::IfcAlignment)?);
        // Missing Axis or unparseable curve isn't fatal — fall back so the
        // walk can still read a normal representation if present.
        let mut mesh = processor.process(element, decoder, self.schema, self.tessellation_quality).ok()?;
        if mesh.positions.is_empty() {
            return None;
        }
        mesh.validate_indices();
        self.scale_mesh(&mut mesh);
        Some(mesh)
    }

    /// Drain refs the content-hash walk refused above `u32::MAX` (#3421/#3752).
    pub fn take_content_hash_oversized_ref_drops(&self) -> usize {
        std::mem::take(&mut *self.content_hash_oversized_ref_drops.borrow_mut())
    }
}

#[cfg(test)]
#[path = "processing_hygiene_tests.rs"]
mod hygiene_tests;

#[cfg(test)]
#[path = "product_program_tests.rs"]
mod product_tests;
