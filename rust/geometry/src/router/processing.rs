// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Core element processing: resolving representations, processing items, and caching.

use super::frame_parts::{mesh_bounds, single_frame};
use super::GeometryRouter;
use crate::{Mesh, Result, SubMeshCollection};
use crate::program::{GeometryProgram, product_control::ProductConsumer};

use ifc_lite_core::{DecodedEntity, EntityDecoder};

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
pub(crate) fn publish_object_frame_bounds(mesh: &mut Mesh, offset: (f64, f64, f64)) {
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
pub(crate) enum SourceHygiene {
    /// Dedicated alignment output historically skips source cleanup.
    None,
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
    pub(crate) fn for_router(self, router: &GeometryRouter) -> Self {
        if self == Self::None { return self }
        if router.preserve_triangle_order.get() { Self::IndexOnly } else { self }
    }

    pub(crate) fn apply(self, mesh: &mut Mesh) {
        match self {
            Self::None => {},
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
        let mut program=GeometryProgram::product(element.clone(),ProductConsumer::Merged,hygiene);
        while let Some(request)=program.request().expect("canonical product request") {
            let reply=program.execute(request,self,decoder).expect("canonical product execution");
            program.accept(reply,self).expect("canonical product acceptance");
        }
        program.finish_parts()
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
        let mut program=GeometryProgram::product(element.clone(),ProductConsumer::Styled {allow_instancing},hygiene);
        while let Some(request)=program.request().expect("canonical styled product request") {
            let reply=program.execute_with_textures(request,self,decoder,texture_index).expect("canonical styled product execution");
            program.accept(reply,self).expect("canonical styled product acceptance");
        }
        program.finish_submeshes()
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
        self.process_representation_item_body(item, decoder, offset_meters)
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

    /// Drain refs the content-hash walk refused above `u32::MAX` (#3421/#3752).
    pub fn take_content_hash_oversized_ref_drops(&self) -> usize {
        std::mem::take(&mut *self.content_hash_oversized_ref_drops.borrow_mut())
    }
}
