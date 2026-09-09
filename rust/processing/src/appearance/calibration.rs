// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Measured source-plane calibration, independent of raster DPI and crop.
use super::{Mapping, MappingFrame};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaneCalibrationRequest {
    /// Affine [a,b,c,d,e,f]: raster pixel edges -> stable native source XY.
    /// For PDF pages this is PdfRasterRecipe.pixelToPdf, including page rotation.
    pub raster_to_source: [f64; 6],
    pub raster_size: [u32; 2],
    /// Two measured points in native source coordinates, retained across crops.
    pub source_points: [[f64; 2]; 2],
    pub distance_metres: f64,
    /// IFC world Z-up metres at the first measured source point.
    pub world_anchor: [f64; 3],
    /// First -> second measured point direction, within the chosen world plane.
    pub world_direction: [f64; 3],
    /// Positive native source XY orientation; not the raster's downward Y axis.
    pub plane_normal: [f64; 3],
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibratedPlane {
    /// IFC UV origin is the raster's bottom-left, with V pointing upward.
    pub mapping: Mapping,
    /// Top-left, top-right, bottom-right, bottom-left, in IFC world metres.
    pub raster_corners: [[f64; 3]; 4],
    pub metres_per_source_unit: f64,
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}
fn length(v: [f64; 3]) -> f64 { v[0].hypot(v[1]).hypot(v[2]) }
// Bound each reconstructed vector independently to one part per million.
// Checking only distinct corners misses partial coordinate collapse, while a
// tolerance based on the longest edge hides distortion of narrow rectangles.
fn preserves_vector(start: [f64; 3], end: [f64; 3], intended: [f64; 3]) -> bool {
    let error = length(std::array::from_fn(|i| (end[i] - start[i]) - intended[i]));
    error.is_finite() && error <= length(intended) * 1e-6
}
fn unit(v: [f64; 3]) -> Result<[f64; 3], String> {
    let len = length(v);
    if !v.iter().all(|v| v.is_finite()) || !len.is_finite() || len <= 0. {
        return Err("Calibration needs finite, nonzero plane directions".into());
    }
    Ok(v.map(|value| value / len))
}

/// Establish one measured similarity transform for the whole source, then derive
/// the current raster's world rectangle. A crop/rotation/DPI change only changes
/// raster_to_source and raster_size; it never recalibrates the measured span.
/// This computes placement only, not clipped projection or IFC mutations.
pub fn calibrate_appearance_plane(request: &PlaneCalibrationRequest) -> Result<CalibratedPlane, String> {
    let r = request;
    if !r.raster_to_source.iter().chain(r.source_points.iter().flatten())
        .chain(r.world_anchor.iter()).all(|v| v.is_finite())
        || !r.distance_metres.is_finite() || r.distance_metres <= 0.
        || r.raster_size.iter().any(|&v| v == 0 || v > 8192)
        || u64::from(r.raster_size[0]) * u64::from(r.raster_size[1]) > 16 * 1024 * 1024 {
        return Err("Calibration needs finite coordinates, a positive measured distance and a bounded raster".into());
    }
    let dx = r.source_points[1][0] - r.source_points[0][0];
    let dy = r.source_points[1][1] - r.source_points[0][1];
    let span = dx.hypot(dy);
    if !span.is_finite() || span <= 0. {
        return Err("Choose two distinct source points for calibration".into());
    }
    let scale = r.distance_metres / span;
    if !scale.is_finite() || scale <= 0. {
        return Err("The measured source scale cannot be represented".into());
    }
    let direction = unit(r.world_direction)?;
    let normal = unit(r.plane_normal)?;
    if dot(direction, normal).abs() > 1e-10 {
        return Err("The measured direction must lie in the chosen plane".into());
    }
    let sideways = unit([
        normal[1] * direction[2] - normal[2] * direction[1],
        normal[2] * direction[0] - normal[0] * direction[2],
        normal[0] * direction[1] - normal[1] * direction[0],
    ])?;
    let sx = dx / span;
    let sy = dy / span;
    let vector = |x: f64, y: f64| -> [f64; 3] {
        let along = (x * sx + y * sy) * scale;
        let across = (-x * sy + y * sx) * scale;
        std::array::from_fn(|i| direction[i] * along + sideways[i] * across)
    };
    let [a, b, c, d, e, f] = r.raster_to_source;
    let raster_x = vector(a, b);
    let raster_y = vector(c, d);
    let axis_u = unit(raster_x)?;
    let axis_v = unit(raster_y.map(|v| -v))?;
    if dot(axis_u, axis_v).abs() > 1e-10 {
        return Err("A sheared raster needs rectification before planar projection".into());
    }
    let width = length(raster_x) * f64::from(r.raster_size[0]);
    let height = length(raster_y) * f64::from(r.raster_size[1]);
    let top_offset = vector(e - r.source_points[0][0], f - r.source_points[0][1]);
    let top_left = std::array::from_fn(|i| r.world_anchor[i] + top_offset[i]);
    let top_right = std::array::from_fn(|i| top_left[i] + axis_u[i] * width);
    let bottom_left = std::array::from_fn(|i| top_left[i] - axis_v[i] * height);
    let bottom_right = std::array::from_fn(|i| bottom_left[i] + axis_u[i] * width);
    let corners = [top_left, top_right, bottom_right, bottom_left];
    if !corners.iter().flatten().all(|v| v.is_finite())
        || !width.is_finite() || !height.is_finite() || width <= 0. || height <= 0.
        || !preserves_vector(r.world_anchor, top_left, top_offset)
        || !preserves_vector(top_left, top_right, axis_u.map(|v| v * width))
        || !preserves_vector(bottom_left, bottom_right, axis_u.map(|v| v * width))
        || !preserves_vector(bottom_left, top_left, axis_v.map(|v| v * height))
        || !preserves_vector(bottom_right, top_right, axis_v.map(|v| v * height)) {
        return Err("The calibrated plane exceeds coordinate precision; use a local world frame".into());
    }
    Ok(CalibratedPlane {
        mapping: Mapping::Planar { frame: MappingFrame::World, origin: bottom_left,
            axis_u, axis_v, metres_per_tile: [width, height] },
        raster_corners: corners,
        metres_per_source_unit: scale,
    })
}

#[cfg(test)]
#[path = "calibration_tests.rs"]
mod tests;
