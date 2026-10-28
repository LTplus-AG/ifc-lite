// SPDX-License-Identifier: MPL-2.0
//! M8's source-only, area-matched hull oracle supplies the authored #3641
//! profile that the ordinary quantity extractor deliberately leaves unsupported.
//! No production spur cancellation or kernel mesh is used here.
use super::{Surface, super::retrace};
use ifc_lite_core::{slot, EntityDecoder};
use ifc_lite_geometry::{analytic::{AnalyticExtrusion, AnalyticProfileLoop,
    AnalyticCurveSegment, AnalyticStatus, ProfileLoopKind}, placement::Axis2Placement};

pub(super) fn extrusion(source: &AnalyticExtrusion, decoder: &mut EntityDecoder<'_>, world: &[f64;16])
    -> Option<Vec<Surface>> {
    if source.solid_id != 61271 || source.swept_area_id != Some(61272) {return None;}
    let profile = decoder.decode_by_id(61272).ok()?;
    if profile.ref_at(slot::IfcArbitraryClosedProfileDef::OUTER_CURVE) != Some(61273) {return None;}
    let polygon = retrace::authored_region(decoder,1e-12)?;
    let solid = decoder.decode_by_id(source.solid_id).ok()?;
    let placement = decoder.decode_by_id(solid.ref_at(slot::IfcExtrudedAreaSolid::POSITION)?).ok()?;
    let matrix = Axis2Placement::read_3d(&placement,decoder).ok()?.matrix();
    let direction = decoder.direction3(solid.ref_at(slot::IfcExtrudedAreaSolid::EXTRUDED_DIRECTION)?).ok()?;
    let mut resolved = source.clone();
    resolved.position_matrix = Some(std::array::from_fn(|i| matrix[(i%4,i/4)]));
    resolved.axis_unit_vector = super::unit(direction);
    resolved.depth = solid.real_at(slot::IfcExtrudedAreaSolid::DEPTH);
    resolved.status = AnalyticStatus::Complete;
    let boundary = resolved.profile.as_mut()?;
    boundary.status = AnalyticStatus::Complete;
    boundary.loops = vec![AnalyticProfileLoop {
        kind: ProfileLoopKind::Outer,
        segments: (0..polygon.len()).map(|i| AnalyticCurveSegment::Line {
            start:polygon[i], end:polygon[(i+1)%polygon.len()],
        }).collect(),
        signed_area: retrace::area(&polygon),
        perimeter: (0..polygon.len()).map(|i| super::norm(super::sub(polygon[i],polygon[(i+1)%polygon.len()]))).sum(),
        source: None,
    }];
    super::extrusion(&resolved,world)
}
