// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Conservative wall-local frame selection for vertically extruded cutters.

use super::geom::{extent_along_axis, wall_frame_from_depth};
use super::{is_axis_aligned_direction, OpeningType, NORMALIZE_EPSILON};
use crate::{Mesh, Vector3};

fn authored_depth(opening: &OpeningType) -> Option<Vector3<f64>> {
    match opening {
        OpeningType::DiagonalRectangular(_, frame) if frame.depth_is_authored => Some(frame.depth),
        OpeningType::DiagonalRectangular(..) => None,
        OpeningType::NonRectangular(_, _, _, depth) => *depth,
        OpeningType::Rectangular(_, _, depth) => *depth,
    }
}

/// Issue #3977: vertically extruded strips do not carry the wall-normal depth
/// used by the original #1167 selector. Derive that normal from an opening's
/// authored oriented frame, then qualify the host as a thin, tall wall.
pub(super) fn vertical_depth_wall_frame(
    host: &Mesh,
    openings: &[OpeningType],
) -> Option<[Vector3<f64>; 3]> {
    if openings.is_empty()
        || !openings.iter().all(|opening| {
            authored_depth(opening)
                .and_then(|depth| depth.try_normalize(NORMALIZE_EPSILON))
                .is_some_and(|depth| depth.z.abs() >= 0.98)
        })
    {
        return None;
    }

    // A vertical rectangular extrusion's two cross axes are its authored
    // horizontal profile frame. The host's smaller extent across those axes is
    // its thickness/normal; this avoids deriving a noisy direction from an
    // arbitrary tessellated edge.
    let frame = openings.iter().find_map(|opening| match opening {
        OpeningType::DiagonalRectangular(_, frame)
            if frame.cross_a.z.abs() <= 0.2 && frame.cross_b.z.abs() <= 0.2 =>
        {
            Some(*frame)
        }
        _ => None,
    })?;
    let extent_a = extent_along_axis(host, &frame.cross_a)?;
    let extent_b = extent_along_axis(host, &frame.cross_b)?;
    let normal = if extent_a <= extent_b {
        frame.cross_a
    } else {
        frame.cross_b
    };
    if is_axis_aligned_direction(&normal) {
        return None;
    }

    let axes = wall_frame_from_depth(normal)?;
    let run = extent_along_axis(host, &axes[0])?;
    let height = extent_along_axis(host, &axes[1])?;
    let thickness = extent_along_axis(host, &axes[2])?;
    const WALL_ASPECT_MIN: f64 = 4.0;
    (thickness > NORMALIZE_EPSILON
        && run >= thickness * WALL_ASPECT_MIN
        && height >= thickness * WALL_ASPECT_MIN)
        .then_some(axes)
}
