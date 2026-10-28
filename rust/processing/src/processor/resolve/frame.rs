// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Placement resolution and frame publication before the first batch.

use super::Scanned;
use crate::mesh_frame::MeshFrame;
use crate::prepass::UnitScales;
use crate::processor::{
    diagnostics, native_to_baked, FrameEvent, ProcessingRequest, ProcessingSink,
};
use ifc_lite_geometry::GeometryRouter;
use std::sync::Arc;

/// The auxiliary router, the IfcSite and IfcBuilding placements and the mesh
/// frame. Raises `on_frame` before any batch.
pub(super) fn placement_phase(
    content: &[u8],
    req: &ProcessingRequest,
    sink: &mut dyn ProcessingSink,
    s: &mut Scanned<'_>,
    unit_scales: &UnitScales,
) -> (
    GeometryRouter,
    Option<Vec<f64>>,
    Option<Vec<f64>>,
    MeshFrame,
) {
    // Not drained: meshes nothing. Pinned by rust/geometry/tests/issue_3821_auxiliary_routers_mesh_nothing.rs.
    let mut router = diagnostics::unit_router(unit_scales); // refused with the unit (#7678)
    router.set_tessellation_quality(req.quality);
    // Build the #563 material-layer index from the IfcRelAssociatesMaterial spans
    // the main scan already stashed (like the wasm pre-pass), not a redundant
    // `from_content` re-walk of the whole file. Byte-identical; saves 6-15% load.
    let material_spans = &s.spans.rel_associates_material;
    router.set_material_layer_index(Arc::new(ifc_lite_geometry::MaterialLayerIndex::from_spans(
        material_spans,
        &mut s.decoder,
    )));

    let mut placement = |pos: Option<(usize, usize)>| -> Option<Vec<f64>> {
        pos.and_then(|(start, end)| {
            let entity = s.decoder.decode_at(start, end).ok()?;
            let matrix = router
                .resolve_scaled_placement(&entity, &mut s.decoder)
                .ok()?;
            Some(matrix.to_vec())
        })
    };
    let site_transform = placement(s.site_pos);
    let building_transform = placement(s.building_pos);

    // The RTC sample window is the file's, not this pipeline's job list
    // (#4611): `entity_jobs` is a schedule (priority-sorted under
    // `fast_first_batch`, plus the #957 synthetic type jobs appended at the
    // end), and the frame must not be a function of the schedule.
    let detected_rtc_offset = router.detect_rtc_offset_for_file(content, &mut s.decoder);

    // The three-tier frame selection lives on `MeshFrame::select`; this is
    // the site-tier caller (the browser pre-pass passes no site).
    let frame = MeshFrame::select(site_transform.as_deref(), detected_rtc_offset);
    router.set_rtc_offset(frame.rtc_offset());
    // Basis and frame come from one value, so they cannot disagree; fires before any batch.
    let (rx, ry, rz) = frame.rtc_offset();
    let baked_basis = native_to_baked(
        frame.coordinate_space(),
        site_transform.as_deref(),
        [rx, ry, rz],
    );
    sink.on_frame(&FrameEvent { frame, baked_basis });
    (router, site_transform, building_transform, frame)
}
