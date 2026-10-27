// SPDX-License-Identifier: MPL-2.0
//! Independent authored expectations from the canonical analytic source walk.
use super::metrics::{extend_bbox, transform};
use ifc_lite_geometry::analytic::{AnalyticCurveSegment, AnalyticStatus};
use ifc_lite_processing::{extrusion_nominal_quantities, AnalyticQuantitySources};

pub fn expected(
    sources: &AnalyticQuantitySources,
    id: u32,
    parts: usize,
) -> Option<(f64, Option<[f64; 6]>)> {
    let definitions = &sources.extrusion_definitions;
    let instances = definitions.instances.get(&id)?;
    if instances.len() != parts
        || instances
            .iter()
            .any(|i| i.source_modified || i.status != AnalyticStatus::Complete)
    {
        return None;
    }
    let mut volume = 0.;
    let mut bbox = Some([
        f64::INFINITY,
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ]);
    for instance in instances {
        let definition = definitions
            .sources
            .iter()
            .find(|s| s.key == instance.source)?;
        let source = &definition.source;
        let frame = instance.world_from_source?;
        let det = frame[0] * (frame[5] * frame[10] - frame[9] * frame[6])
            - frame[4] * (frame[1] * frame[10] - frame[9] * frame[2])
            + frame[8] * (frame[1] * frame[6] - frame[5] * frame[2]);
        volume += extrusion_nominal_quantities(source)?.nominal_volume * det.abs();
        let profile = source.profile.as_ref()?;
        let identity = [
            1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
        ];
        let solid = source.position_matrix.as_ref().unwrap_or(&identity);
        let profile_frame = profile.profile_position.as_ref().unwrap_or(&identity);
        let depth = source.depth?;
        let axis = source.axis_unit_vector?;
        for segment in profile.loops.iter().flat_map(|b| &b.segments) {
            let AnalyticCurveSegment::Line { start, end } = segment else {
                bbox = None;
                break;
            };
            for point in [*start, *end] {
                let p = transform(profile_frame, point);
                for z in [0., depth] {
                    let p = std::array::from_fn(|i| p[i] + z * axis[i]);
                    if let Some(bounds) = &mut bbox {
                        extend_bbox(bounds, transform(&frame, transform(solid, p)));
                    }
                }
            }
        }
    }
    Some((volume, bbox))
}
