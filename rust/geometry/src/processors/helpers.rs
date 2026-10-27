// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared helper functions for geometry processors.
//!
//! The face types and the polyloop reader the surface-model processors share.
//! Placements and directions are not read here: they go through
//! `crate::placement::Axis2Placement` and `EntityDecoder::direction3`.

use crate::Point3;
use ifc_lite_core::EntityDecoder;

/// Face data extracted from IFC for parallel triangulation
pub(super) struct FaceData {
    pub(super) outer_points: Vec<Point3<f64>>,
    pub(super) hole_points: Vec<Vec<Point3<f64>>>,
}

/// Triangulated face result
pub(super) struct FaceResult {
    pub(super) positions: Vec<f32>,
    pub(super) indices: Vec<u32>,
    /// The face was refused (empty, never an approximation) and the caller
    /// counts it on its own thread: this runs under rayon (#7686, D3).
    pub(super) refused: bool,
}

/// Append `points` as f32 positions after subtracting `rtc` in f64, so
/// national-grid coordinates narrow near the origin (#5698).
#[inline]
pub(super) fn push_rebased<'a>(
    positions: &mut Vec<f32>,
    points: impl IntoIterator<Item = &'a Point3<f64>>,
    rtc: (f64, f64, f64),
) {
    for p in points {
        positions.push((p.x - rtc.0) as f32);
        positions.push((p.y - rtc.1) as f32);
        positions.push((p.z - rtc.2) as f32);
    }
}

/// Every point of an `IfcPolyLoop`, however few. `None` means the loop or
/// one of its points does not decode, which is not a loop of under three
/// points; a face bound reader refuses the face on the former and skips the
/// latter (#7687, #7686, D14). Shared by the surface-model processors and the
/// advanced-face bound reader.
pub(super) fn read_loop_points_by_id(
    loop_id: u32,
    decoder: &mut EntityDecoder,
) -> Option<Vec<Point3<f64>>> {
    let point_ids = decoder.get_polyloop_point_ids_fast(loop_id)?;

    let mut points = Vec::with_capacity(point_ids.len());
    for point_id in point_ids {
        let [x, y, z] = decoder.point3(point_id).ok()?;
        points.push(Point3::new(x, y, z));
    }
    Some(points)
}
