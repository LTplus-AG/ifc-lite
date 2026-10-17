// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `ItemMesher`: the one per-item pipeline. A representation item is meshed
//! under an [`ItemFrame`] that selects the stages the walk it belongs to has
//! always applied: content dedup and the direct-instance stamp for a direct
//! item, the f64 rebase kept in `origin` for a mapped-source item. Split out of
//! `processing.rs` (the element walks).

use super::frame_parts::mesh_bounds;
use super::{GeometryProcessor, GeometryRouter};
use crate::math::mat4;
use crate::{Error, Mesh, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix4;

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

/// The frame an item is meshed in, i.e. which per-item stages apply.
#[derive(Clone, Copy)]
pub(super) enum ItemFrame {
    /// A direct item of an element or a probe: content dedup, the instance
    /// stamp, and `rtc_applied` kept.
    Direct,
    /// An item of a mapped source: no dedup, and the rebase moved into `origin`
    /// (the `MappingTarget` and placement still apply to it, #7690).
    MappedSource,
    /// A direct item nested under a mapped item in the sub-mesh walk: the
    /// direct stages, then the rebase moved into `origin`.
    Nested,
}

impl GeometryRouter {
    /// `transform` unit-scaled (see [`Self::scale_transform`]) as the row-major
    /// array `InstanceMeta` stores.
    pub(crate) fn scaled_row_major(&self, transform: &Matrix4<f64>) -> [f64; 16] {
        let mut scaled = *transform;
        self.scale_transform(&mut scaled);
        mat4::from_na(&scaled)
    }

    /// Mesh `item` under `frame`.
    pub(super) fn mesh_item(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        frame: ItemFrame,
    ) -> Result<Mesh> {
        match frame {
            ItemFrame::Direct => self.process_representation_item(item, decoder),
            ItemFrame::Nested => {
                let mut mesh = self.process_representation_item(item, decoder)?;
                self.keep_rebase_in_origin(&mut mesh);
                Ok(mesh)
            }
            ItemFrame::MappedSource => {
                let processor = self
                    .processor_for(&item.ifc_type)
                    .ok_or_else(|| Error::geometry("no processor"))?;
                let mut mesh = self.process_item_in_rtc_frame(
                    processor.as_ref(),
                    item,
                    decoder,
                    self.rtc_offset(),
                )?;
                self.keep_rebase_in_origin(&mut mesh);
                Ok(mesh)
            }
        }
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
        self.process_representation_item_in_frame(item, decoder, self.rtc_offset())
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
    pub(super) fn element_frame_rtc(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<(f64, f64, f64)>> {
        let placement = self.element_world_placement(element, decoder, false)?;
        let linear = placement.fixed_view::<3, 3>(0, 0).into_owned();
        Ok(linear.try_inverse().map(|inverse| {
            let rtc = inverse
                * nalgebra::Vector3::new(self.rtc_offset().0, self.rtc_offset().1, self.rtc_offset().2);
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

    /// Mesh one item, rebasing it by `offset_meters` (model RTC expressed in
    /// the item's own coordinate frame) before f32 narrowing.
    ///
    /// The rebase runs only when it reduces the item's coordinate magnitude
    /// (#5684: site-local vertices kilometres from a national-grid site must
    /// stay local) and the processor implements
    /// [`GeometryProcessor::process_in_rtc_frame`]. Every built-in
    /// raw-coordinate processor does; they subtract in f64 so detail below one
    /// f32 ULP at national-grid magnitude survives (#5698). Otherwise the
    /// ordinary output keeps its object frame and final placement applies RTC
    /// in f64: shifting already-f32 output cannot recover precision.
    ///
    /// Returns the unit-scaled mesh. A rebased mesh carries `rtc_applied`
    /// and object-frame `local_bounds`.
    ///
    /// Every walk meshes an item's processor here and nowhere else, so this
    /// is also where the thread-local curve-capped flag (#4901) is drained:
    /// a capped edge is reported for the item that set it, never for the next
    /// item on the thread, whichever walk ran it (ROUTER-26, #7690).
    pub(super) fn process_item_in_rtc_frame(
        &self,
        processor: &dyn GeometryProcessor,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        offset_meters: (f64, f64, f64),
    ) -> Result<Mesh> {
        // Drop flags a direct `AdvancedBrepProcessor` call left set on this
        // thread: the drains below must count THIS item only (#7687).
        let _ = crate::processors::take_curve_capped();
        let _ = crate::processors::take_face_refused();
        let rebased = self
            .raw_item_rtc_file_units(item, decoder, offset_meters)
            .and_then(|rtc_file_units| {
                processor.process_in_rtc_frame(
                    item,
                    decoder,
                    self.schema,
                    self.tessellation_quality(),
                    rtc_file_units,
                )
            });
        let rtc_applied = rebased.is_some();
        let result = match rebased {
            Some(result) => result,
            None => processor.process(item, decoder, self.schema, self.tessellation_quality()),
        };
        if crate::processors::take_curve_capped() {
            self.record_unsupported_item(IfcType::IfcBSplineCurveWithKnots);
        }
        // A face refused because its loop, curve or surface data does not
        // read (#7687, D3): the brep skips it per face, so this is the only
        // place the drop becomes visible.
        for face_type in crate::processors::take_face_refused() {
            self.record_unsupported_item(face_type);
        }
        let mut mesh = result?;
        // Safety net: strip any out-of-bounds indices before downstream use
        mesh.validate_indices();
        self.scale_mesh(&mut mesh);
        if rtc_applied {
            publish_object_frame_bounds(&mut mesh, offset_meters);
        }
        Ok(mesh)
    }

    /// `offset_meters` in file units when rebasing `item` by it before f32
    /// narrowing reduces the item's coordinate magnitude; `None` when there
    /// is no model RTC or the item is not raw-coordinate geometry (#5684).
    fn raw_item_rtc_file_units(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        offset_meters: (f64, f64, f64),
    ) -> Option<(f64, f64, f64)> {
        (self.has_rtc_offset()
            && self.representation_item_benefits_from_rtc(item, decoder, offset_meters))
        .then(|| {
            (
                offset_meters.0 / self.unit_scale(),
                offset_meters.1 / self.unit_scale(),
                offset_meters.2 / self.unit_scale(),
            )
        })
    }

    /// The meshing body of [`Self::process_representation_item`] (everything except
    /// the MappedItem path and the content-dedup wrapper).
    pub(super) fn process_representation_item_uncached(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        offset_meters: (f64, f64, f64),
    ) -> Result<Mesh> {
        // Raw-coordinate items rebase in the model frame here; element
        // walkers take `process_raw_item_for_element` first for their own
        // items, so this frame matters for mapped and opening items.
        if let Some(processor) = self.processor_for(&item.ifc_type) {
            let mesh =
                self.process_item_in_rtc_frame(processor.as_ref(), item, decoder, offset_meters)?;

            // Deduplicate by hash - buildings with repeated floors have identical geometry
            if !mesh.positions.is_empty() {
                let cached = self.get_or_cache_by_hash(mesh);
                return Ok((*cached).clone());
            }
            return Ok(mesh);
        }

        // No processor is registered for this type. Every `GeometryCategory`
        // that has a real implementation (SweptSolid, ExplicitMesh, Boolean) is
        // already caught by the processor lookup above; `MappedItem` never
        // reaches here (`process_representation_item` intercepts it first, see
        // `process_mapped_item_cached`). So landing here means the type is
        // genuinely unsupported, not merely "not implemented yet".
        Err(Error::geometry(format!(
            "Unsupported representation type: {}",
            item.ifc_type
        )))
    }

}

#[cfg(test)]
#[path = "item_tests.rs"]
mod item_tests;
