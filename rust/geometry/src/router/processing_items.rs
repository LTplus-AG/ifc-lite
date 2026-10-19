// SPDX-License-Identifier: MPL-2.0
//! Canonical item dispatch and cache copies; bounded work uses the same numerics.
use super::GeometryRouter;
#[cfg(test)]
use super::GeometryProcessor;
#[cfg(test)]
use super::processing::publish_object_frame_bounds;
use crate::{Mesh, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
impl GeometryRouter {

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
    #[cfg(test)]
    pub(super) fn process_item_in_rtc_frame(
        &self,
        processor: &dyn GeometryProcessor,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        offset_meters: (f64, f64, f64),
    ) -> Result<Mesh> {
        // Dispatch is selected through this router; the common program retains
        // actual owned lowering, RTC fallback and callback admission order.
        debug_assert!(self.processor_for(&item.ifc_type)
            .is_some_and(|selected| std::ptr::eq(selected.as_ref(), processor)));
        crate::program::GeometryProgram::item(item.clone(), offset_meters).drain(self, decoder)
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

    pub(super) fn process_representation_item_body(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        offset_meters: (f64, f64, f64),
    ) -> Result<Mesh> {
        crate::resource::check_current()?;
        if item.ifc_type == IfcType::IfcMappedItem {
            return self.process_mapped_item_cached(item, decoder);
        }
        crate::program::GeometryProgram::representation_item(item.clone(),offset_meters).drain(self,decoder)
    }

    /// A textured `IfcTriangulatedFaceSet` meshed with its per-vertex UVs,
    /// unit-scaled and rebased by `offset_meters` (item frame) when that
    /// preserves precision (#5698). Shared by the occurrence walk and the
    /// type-geometry walk (#7690). `None` when the item is not a face set,
    /// or the textured build fails or is empty.
    #[cfg(test)]
    pub(crate) fn textured_face_set(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        map: &crate::processors::texture::ResolvedTextureMap,
        offset_meters: Option<(f64, f64, f64)>,
    ) -> Option<(Mesh, Vec<f32>)> {
        crate::resource::check_current().ok()?;
        // A terrain TIN is a face set that only appends `Flags` (#5942).
        if !matches!(item.ifc_type, IfcType::IfcTriangulatedFaceSet | IfcType::IfcTriangulatedIrregularNetwork) {
            return None;
        }
        let rtc = offset_meters.and_then(|offset| {
            self.raw_item_rtc_file_units(item, decoder, offset)
                .zip(Some(offset))
        });
        let plan = crate::program::TextureConstructor::admit(item, decoder,
            rtc.map(|(file_units, _)| file_units)).ok()?;
        crate::resource::check_current().ok()?;
        let (mut mesh, uvs) = plan.evaluate(map);
        crate::resource::check_current().ok()?;
        if mesh.is_empty() {
            return None;
        }
        self.scale_mesh(&mut mesh); // UVs are unaffected by scale
        if let Some((_, offset)) = rtc {
            publish_object_frame_bounds(&mut mesh, offset);
        }
        Some((mesh, uvs))
    }


}

#[cfg(test)]
#[path = "rtc_terminal_tests.rs"]
mod rtc_terminal_tests;
