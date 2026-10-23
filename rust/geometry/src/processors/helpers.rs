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
        let (x, y, z) = match decoder.get_cartesian_point_fast(point_id) {
            Some(point) => point,
            None => refused_point_as_before(point_id, decoder)?,
        };
        points.push(Point3::new(x, y, z));
    }
    Some(points)
}

/// D14 seam (#7678): a loop point refused by input admission (`1.E400`) is
/// read losslessly, as the signed infinity it decoded to before, instead of
/// failing the whole loop.
///
/// Both callers (`advanced_face::bounds`, `brep::surface_model`) SKIP a loop
/// they cannot read, so a refused hole loop would be dropped and the face
/// drawn filled in, where the infinity made its triangulation fail the face.
/// Until those readers fail the face on an unreadable loop (D14, the B6c and
/// B6b lanes), this keeps main's behaviour for exactly this case; the refusal
/// is still counted. Any other unreadable point stays `None`, as before.
fn refused_point_as_before(point_id: u32, decoder: &mut EntityDecoder) -> Option<(f64, f64, f64)> {
    let point = decoder.decode_by_id_lossless(point_id).ok()?;
    let coords = point.get(0)?.as_list()?;
    let x = coords.first()?.as_float()?;
    let y = coords.get(1)?.as_float()?;
    let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
    // Only an overflowing literal reads as non-finite here; a point the fast
    // path refused for any other reason stays unreadable, as before.
    if [x, y, z].iter().all(|v| v.is_finite()) {
        return None;
    }
    if decoder.strict_reals() {
        let _counted = decoder.refuse_record(point_id);
    }
    Some((x, y, z))
}
