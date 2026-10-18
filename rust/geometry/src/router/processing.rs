// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Core element processing: resolving representations, processing items, and caching.

use super::frame_parts::{mesh_bounds, single_frame};
use super::transforms::instancing_enabled;
use super::GeometryRouter;
use crate::{InstanceMeta, Mesh, Result, SubMeshCollection};
use crate::program::{EntryPolicy, ProductProgram};

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
pub(super) fn publish_object_frame_bounds(mesh: &mut Mesh, offset: (f64, f64, f64)) {
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
        crate::resource::check_current()?;
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

        let Some(program) = ProductProgram::admit(element, EntryPolicy::MergedProduct, decoder)? else {
            return Ok(vec![Mesh::new()]);
        };

        let (mut combined_mesh, far_parts, rebased) = program.merged(element, self, decoder)?;

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
        crate::resource::check_current()?;
        // If a material-layer buildup is attached, try slicing single-solid
        // elements (walls / slabs with IfcMaterialLayerSetUsage) first so each
        // layer gets its own sub-mesh keyed by IfcMaterial id. An empty void
        // index is passed — the caller's has_openings branch takes the
        // voids-aware path below.
        if let Some(layered) = self.try_layered_sub_meshes(element, decoder, None) {
            return Ok(layered);
        }

        let Some(program) = ProductProgram::admit(element, EntryPolicy::StyledProduct, decoder)? else {
            return Ok(SubMeshCollection::new());
        };

        let mut sub_meshes = program.styled(element, self, decoder, allow_instancing, texture_index)?;

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
        // in `process_item_in_rtc_frame`, so every walk reports it once.
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
        self.process_representation_item_body(item, decoder, offset_meters)
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
    pub(crate) fn process_raw_item_for_element(
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
    pub(crate) fn element_frame_rtc(
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
        crate::resource::check_current()?;
        self.record_processor_dispatch(processor.as_ref());
        let result = match processor.lower_owned(element, decoder, self.tessellation_quality, None) {
            Some(plan) => plan.and_then(|plan| {
                        crate::resource::check_current()?;
                        plan.evaluate()
                    }),
            None => crate::resource::check_current().map_err(crate::Error::from).and_then(|()|
                processor.process(element, decoder, self.schema, self.tessellation_quality)),
        };
        let mut mesh = match crate::resource::observe(result) {
            Ok(m) => m,
            Err(error @ crate::Error::ProgramStopped(_)) => return Err(error),
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
