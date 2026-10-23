// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The schema's `IfcFirstProjAxis` for a placement's local X, shared by every
//! `IfcAxis2Placement3D` and transformation-operator parser (#7751).

use nalgebra::Vector3;

/// Norm of the projected X below which the projection's direction is numeric
/// noise (`1 - z.x^2` cancels to ~1e-16 absolute), so the axis is X to within
/// rounding. Above it the projection is normalised, as the schema's
/// `IfcFirstProjAxis` does (#7751: this was 1e-6, which sent an Axis within
/// 1e-6 of +X to about +Y where the schema gives about -Y). `packages/data`
/// `firstProjAxis` carries the same constant.
pub(crate) const X_PROJECTION_EPSILON: f64 = 1e-9;

/// The unit X axis of a frame with unit `z_axis`: `x_axis` projected onto the
/// plane normal to `z_axis` (`IfcFirstProjAxis`). When that projection
/// vanishes (X parallel to Z) the deterministic perpendicular
/// `(0,0,1) x Z` (or `(1,0,0) x Z` when Z is near vertical) is used. The one
/// home for every placement and operator parser.
pub(crate) fn perpendicular_x_axis(z_axis: Vector3<f64>, x_axis: Vector3<f64>) -> Vector3<f64> {
    let orthogonal = x_axis - z_axis * x_axis.dot(&z_axis);
    // `norm() > eps`, not `try_normalize`: a NaN norm takes the fallback.
    if orthogonal.norm() > X_PROJECTION_EPSILON {
        orthogonal.normalize()
    } else if z_axis.z.abs() < 0.9 {
        Vector3::new(0.0, 0.0, 1.0).cross(&z_axis).normalize()
    } else {
        Vector3::new(1.0, 0.0, 0.0).cross(&z_axis).normalize()
    }
}

/// The local frame `(x, y, z)` of an `IfcAxis2PlacementLinear` (IFC4X3), given
/// the curve frame `(tangent, left, vertical)` at its `Location` and the
/// authored `Axis` / `RefDirection` (#7791). Both directions are expressed IN
/// that curve frame (X along the tangent, Y left of travel, Z vertical), not in
/// world axes.
///
/// `Axis` is the local Z (default: the curve's vertical). `RefDirection` is
/// projected perpendicular to it to give local X (default: the tangent; a
/// RefDirection parallel to Axis also falls back to the tangent). Local Y is
/// `Axis x X`; it is `None` when that is degenerate (Axis parallel to X, or a
/// zero Axis), which callers refuse. The one home for the router's linear
/// placement and the sectioned-solid cross-section frame.
pub(crate) fn linear_placement_axes(
    curve: [Vector3<f64>; 3],
    axis: Option<Vector3<f64>>,
    ref_direction: Option<Vector3<f64>>,
) -> Option<[Vector3<f64>; 3]> {
    let [tangent, left, vertical] = curve;
    let to_world = |v: Vector3<f64>| tangent * v.x + left * v.y + vertical * v.z;
    let z = axis.map(to_world).unwrap_or(vertical);
    let x = ref_direction.map(to_world).unwrap_or(tangent);
    let x = (x - z * x.dot(&z)).try_normalize(1e-12).unwrap_or(tangent);
    let y = z.cross(&x).try_normalize(1e-12)?;
    Some([x, y, z])
}
