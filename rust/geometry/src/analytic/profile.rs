// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Exact profile boundaries before extrusion, in IFC file-length units.

use super::{curve::CurveWalk, AnalyticCurveSegment, AnalyticPoint, AnalyticStatus};
use crate::transform::parse_axis2_placement_2d;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use serde::Serialize;
use std::f64::consts::TAU;

const MAX_LOOPS: usize = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileLoopKind { Outer, Inner }

/// One ordered, closed source boundary. Signed area preserves the authored
/// traversal direction: positive is counterclockwise in the profile XY plane.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AnalyticProfileLoop {
    pub kind: ProfileLoopKind,
    pub segments: Vec<AnalyticCurveSegment>,
    pub signed_area: f64,
    /// Exact boundary length in raw IFC file units.
    pub perimeter: f64,
}

/// `IfcProfileDef` geometry before `IfcExtrudedAreaSolid.Position` and mapping.
/// Its `Position` belongs to the profile and is returned separately, in raw
/// IFC file units; no approximation from drawing or meshing is used.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AnalyticProfile {
    pub profile_id: u32,
    pub ifc_type_name: String,
    #[serde(rename = "ProfileType")]
    pub profile_type: Option<String>,
    pub position_id: Option<u32>,
    pub profile_position: Option<[f64; 16]>,
    pub loops: Vec<AnalyticProfileLoop>,
    pub status: AnalyticStatus,
}

/// Read supported exact profile loops, preserving an unsupported reason on
/// the source record rather than publishing a partial or tessellated contour.
pub fn extract_analytic_profile(profile: &DecodedEntity, decoder: &mut EntityDecoder) -> AnalyticProfile {
    let mut result = AnalyticProfile {
        profile_id: profile.id, ifc_type_name: profile.ifc_type.name().to_string(),
        profile_type: profile.get(0).and_then(|value| value.as_enum()).map(str::to_owned),
        position_id: None, profile_position: None,
        loops: Vec::new(), status: AnalyticStatus::Complete,
    };
    let parsed = parse_profile(profile, decoder, &mut result);
    if let Err(reason) = parsed {
        result.loops.clear();
        result.status = AnalyticStatus::Unsupported(reason);
    }
    result
}

fn parse_profile(
    profile: &DecodedEntity, decoder: &mut EntityDecoder, result: &mut AnalyticProfile,
) -> Result<(), String> {
    result.loops = match profile.ifc_type {
        IfcType::IfcRectangleProfileDef => {
            parse_profile_position(profile, decoder, result)?;
            let x = positive(profile.get_float(3), "XDim")? / 2.0;
            let y = positive(profile.get_float(4), "YDim")? / 2.0;
            let points = [[-x, -y, 0.0], [x, -y, 0.0], [x, y, 0.0], [-x, y, 0.0]];
            vec![loop_from_segments(ProfileLoopKind::Outer, (0..4).map(|i| {
                AnalyticCurveSegment::Line { start: points[i], end: points[(i + 1) % 4] }
            }).collect())?]
        }
        IfcType::IfcCircleProfileDef => {
            parse_profile_position(profile, decoder, result)?;
            let radius = positive(profile.get_float(3), "Radius")?;
            vec![loop_from_segments(ProfileLoopKind::Outer, vec![AnalyticCurveSegment::Arc {
                center: [0.0; 3], normal: [0.0, 0.0, 1.0], x_axis: [1.0, 0.0, 0.0],
                radius, start_angle: 0.0, sweep_angle: TAU,
            }])?]
        }
        IfcType::IfcArbitraryClosedProfileDef | IfcType::IfcArbitraryProfileDefWithVoids => {
            arbitrary_loops(profile, decoder)?
        }
        _ => return Err(format!("unsupported profile {}", profile.ifc_type.name())),
    };
    Ok(())
}

fn positive(value: Option<f64>, attribute: &str) -> Result<f64, String> {
    value.filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| format!("invalid or missing {attribute}"))
}

fn parse_profile_position(
    profile: &DecodedEntity, decoder: &mut EntityDecoder, result: &mut AnalyticProfile,
) -> Result<(), String> {
    let Some(position) = profile.get(2).filter(|value| !value.is_null()) else { return Ok(()) };
    let id = position.as_entity_ref().ok_or("invalid profile Position reference")?;
    result.position_id = Some(id);
    let entity = decoder.decode_by_id(id).map_err(|error| format!("Position #{id}: {error}"))?;
    if entity.ifc_type != IfcType::IfcAxis2Placement2D {
        return Err(format!("Position #{id} is not IfcAxis2Placement2D"));
    }
    let matrix = parse_axis2_placement_2d(&entity, decoder)
        .map_err(|error| format!("Position #{id}: {error}"))?;
    if matrix.iter().any(|value| !value.is_finite()) {
        return Err(format!("Position #{id} has non-finite coordinates"));
    }
    let mut values = [0.0; 16];
    values.copy_from_slice(matrix.as_slice());
    result.profile_position = Some(values);
    Ok(())
}

fn arbitrary_loops(
    profile: &DecodedEntity, decoder: &mut EntityDecoder,
) -> Result<Vec<AnalyticProfileLoop>, String> {
    let outer = profile.get_ref(2).ok_or("missing OuterCurve")?;
    let mut loops = vec![curve_loop(outer, ProfileLoopKind::Outer, decoder)?];
    let mut emitted_segments = loops[0].segments.len();
    if profile.ifc_type == IfcType::IfcArbitraryProfileDefWithVoids {
        let references = profile.get(3).and_then(|value| value.as_list())
            .ok_or("missing or malformed InnerCurves")?;
        if references.len() > MAX_LOOPS { return Err("InnerCurves exceed work budget".into()); }
        for reference in references {
            if emitted_segments >= MAX_LOOPS {
                return Err("profile segments exceed aggregate work budget".into());
            }
            let id = reference.as_entity_ref().ok_or("invalid InnerCurves reference")?;
            let loop_data = curve_loop(id, ProfileLoopKind::Inner, decoder)?;
            if loop_data.segments.len() > MAX_LOOPS.saturating_sub(emitted_segments) {
                return Err("profile segments exceed aggregate work budget".into());
            }
            emitted_segments += loop_data.segments.len();
            loops.push(loop_data);
        }
    }
    Ok(loops)
}

fn curve_loop(
    id: u32, kind: ProfileLoopKind, decoder: &mut EntityDecoder,
) -> Result<AnalyticProfileLoop, String> {
    let curve = decoder.decode_by_id(id).map_err(|error| format!("curve #{id}: {error}"))?;
    let segments = CurveWalk::default().extract(&curve, decoder)
        .map_err(|error| format!("curve #{id}: {error}"))?
        .ok_or_else(|| format!("curve #{id} is not exact line/arc geometry"))?;
    loop_from_segments(kind, segments).map_err(|reason| format!("curve #{id}: {reason}"))
}

fn loop_from_segments(
    kind: ProfileLoopKind, segments: Vec<AnalyticCurveSegment>,
) -> Result<AnalyticProfileLoop, String> {
    if segments.is_empty() || segments.len() > MAX_LOOPS {
        return Err("profile loop is empty or exceeds work budget".into());
    }
    let frames: Vec<_> = segments.iter().map(|segment| segment.endpoint_frame()
        .ok_or("profile loop has invalid segment geometry")).collect::<Result<_, _>>()?;
    let origin = frames[0].start;
    let mut area = 0.0;
    let mut perimeter = 0.0;
    for (index, segment) in segments.iter().enumerate() {
        let frame = &frames[index];
        let next = &frames[(index + 1) % frames.len()];
        let tolerance = 1e-9_f64.max(relative_extent(frame.start, frame.end) * 1e-9);
        if frame.end.distance_to(next.start).is_none_or(|gap| gap > tolerance) {
            return Err(format!("profile loop has a gap after segment {index}"));
        }
        for point in [frame.start, frame.end] {
            if (point.origin[2] + point.offset[2]).abs() > 1e-9 {
                return Err("profile loop is not in its XY plane".into());
            }
        }
        area += segment_area(segment, origin)?;
        perimeter += segment.length().ok_or("profile segment has invalid length")?;
    }
    if !area.is_finite() || area == 0.0 || !perimeter.is_finite() || perimeter <= 0.0 {
        return Err("profile loop has zero or invalid enclosed area".into());
    }
    Ok(AnalyticProfileLoop { kind, segments, signed_area: area, perimeter })
}

fn relative_extent(a: AnalyticPoint, b: AnalyticPoint) -> f64 {
    a.distance_to(b).unwrap_or(f64::INFINITY)
}

fn segment_area(segment: &AnalyticCurveSegment, origin: AnalyticPoint) -> Result<f64, String> {
    let frame = segment.endpoint_frame().ok_or("invalid segment frame")?;
    let relative = |point: AnalyticPoint| -> [f64; 3] {
        std::array::from_fn(|axis| (point.origin[axis] - origin.origin[axis])
            + (point.offset[axis] - origin.offset[axis]))
    };
    let a = relative(frame.start);
    let b = relative(frame.end);
    match segment {
        AnalyticCurveSegment::Line { .. } => Ok((a[0] * b[1] - b[0] * a[1]) * 0.5),
        AnalyticCurveSegment::Arc { center, normal, x_axis, radius, sweep_angle, .. } => {
            if normal[0].abs() > 1e-9 || normal[1].abs() > 1e-9
                || (normal[2].abs() - 1.0).abs() > 1e-9 || x_axis[2].abs() > 1e-9 {
                return Err("profile arc is not planar in XY".into());
            }
            let c = [center[0] - origin.origin[0] - origin.offset[0],
                center[1] - origin.origin[1] - origin.offset[1]];
            Ok((c[0] * (b[1] - a[1]) - c[1] * (b[0] - a[0])
                + normal[2] * radius * radius * sweep_angle) * 0.5)
        }
    }
}

#[cfg(test)]
#[path = "profile_tests.rs"]
mod tests;
