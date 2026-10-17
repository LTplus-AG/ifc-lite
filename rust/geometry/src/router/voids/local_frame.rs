// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Conservative wall-local frame selection for plan-rotated walls whose
//! openings do not carry the #1167 horizontal depth: vertically extruded
//! cutters (#3977) and cutters with no authored depth at all (#5410).

use super::geom::{extent_along_axis, wall_frame_from_depth};
use super::opening_frame::{cluster_face_normals, mesh_facets, Merge, FACE_COS};
use super::{is_axis_aligned_direction, CutterKind, NORMALIZE_EPSILON};
use crate::{Mesh, Vector3};

/// A wall's run and height must each be at least this multiple of its
/// thickness before it is cut in its own frame.
const WALL_ASPECT_MIN: f64 = 4.0;

/// Issue #3977: vertically extruded strips do not carry the wall-normal depth
/// used by the original #1167 selector. Derive that normal from an opening's
/// authored oriented frame, then qualify the host as a thin, tall wall.
pub(super) fn vertical_depth_wall_frame(
    host: &Mesh,
    openings: &[CutterKind],
) -> Option<[Vector3<f64>; 3]> {
    if openings.is_empty()
        || !openings.iter().all(|opening| {
            opening.cutter().authored_depth()
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
        CutterKind::DiagonalRectangular(_, frame)
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
    (thickness > NORMALIZE_EPSILON
        && run >= thickness * WALL_ASPECT_MIN
        && height >= thickness * WALL_ASPECT_MIN)
        .then_some(axes)
}

/// Issue #5410: a plan-rotated wall whose openings author NO penetration axis
/// (tessellated / brep cutters) gets its frame from its own thickness axis.
///
/// Neither selector above can see such a wall: both read the axis off the
/// openings. The world path it fell to then guesses each cutter's depth from
/// the cutter's world AABB, which on a diagonal wall is vertical: flush sill
/// and head caps were pushed "through" the host and carved the wall above
/// and below every window, and the #635 box fallback cut a diagonal wall's
/// axis-aligned opening box through the full wall height. In the wall frame
/// every cutter takes the wall normal as its depth, the #1167 contract.
///
/// The normal is the horizontal face orientation carrying the most area,
/// which on a thin wall is its two faces. The same thin, tall, long gate as
/// [`vertical_depth_wall_frame`] rejects anything else, and an axis-aligned
/// wall keeps the world path.
pub(super) fn host_thickness_wall_frame(
    host: &Mesh,
    openings: &[CutterKind],
) -> Option<[Vector3<f64>; 3]> {
    if openings.is_empty() || openings.iter().any(|opening| opening.cutter().authored_depth().is_some()) {
        return None;
    }
    let normal = dominant_horizontal_normal(host)?;
    if is_axis_aligned_direction(&normal) {
        return None;
    }
    let axes = wall_frame_from_depth(normal)?;
    let run = extent_along_axis(host, &axes[0])?;
    let height = extent_along_axis(host, &axes[1])?;
    let thickness = extent_along_axis(host, &axes[2])?;
    (thickness > NORMALIZE_EPSILON
        && run >= thickness * WALL_ASPECT_MIN
        && height >= thickness * WALL_ASPECT_MIN)
        .then_some(axes)
}

/// The horizontal face orientation (sign-free) with the largest total area.
/// Faces within ~11° (|cos| > 0.98, the `infer_opening_frame` merge
/// tolerance) share an orientation; faces tilted more than ~11.5° from
/// vertical (|n.z| > 0.2, `wall_frame_from_depth`'s wall bound) are ignored.
/// Deterministic: triangles are visited in index order.
fn dominant_horizontal_normal(host: &Mesh) -> Option<Vector3<f64>> {
    cluster_face_normals(
        mesh_facets(host, Merge::Weighted).filter(|facet| !(facet.normal.z.abs() > 0.2)),
        FACE_COS,
        Merge::Weighted,
        usize::MAX,
        |_, _, _| {},
    )?
    .into_iter()
    .reduce(|best, next| if next.1 > best.1 { next } else { best })
    .map(|(axis, _)| axis)
}
