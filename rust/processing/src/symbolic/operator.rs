// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcCartesianTransformationOperator` parsing for `IfcMappedItem` targets.
//!
//! Split out of `transform.rs` (which owns [`Transform2D`] itself, placement
//! chain resolution and composition) to keep both modules under the house
//! size limit. The move itself changed nothing; the only edit since is the
//! `LocalOrigin` Z read below (#2256 review follow-up).

use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

use super::elevation::point_elevation;
use super::transform::Transform2D;

/// Parse `IfcCartesianTransformationOperator2D` / `…3D` for `IfcMappedItem`
/// targets: translation, the full 2x2 linear block (rotation, optional
/// reflection, and the uniform `Scale`, attr 3).
///
/// Axis1 (attr 0) gives the local X direction. Axis2 (attr 1) is normally
/// just the right-handed perpendicular of Axis1 and is IGNORED in that case,
/// keeping bit-identical output for the (overwhelmingly common) non-mirroring
/// case. A supplied Axis2 that DISAGREES with the perpendicular — a mirroring
/// MappingTarget, the frame `#1994` is about — is honoured instead, exactly
/// mirroring how `router/transforms/operator.rs`'s 3D path derives handedness
/// from Axis2 vs. `Axis3 × Axis1`. Per-axis (`…nonUniform`) scales are still
/// not read here (only the uniform `Scale`); that gap is unchanged from
/// before and is a separate concern from the mirroring this fixes.
///
/// Axis3 (attr 4 on `IfcCartesianTransformationOperator3D`) is deliberately
/// NOT consulted, and cannot matter here. A 3D operator's matrix has Axis1,
/// Axis2 and Axis3 as its columns, so the plan projection — rows x,y of the
/// first two columns — is a function of Axis1 and Axis2 alone; Axis3 lives
/// entirely in the discarded third column. Concretely, a reflection through
/// the XY plane (Axis3 = −Z, default Axis1/Axis2) has 3D `det = −1` while its
/// plan submatrix is the identity with `det = +1`: mirroring an object
/// vertically does not mirror its footprint, and leaving the plan symbol
/// unmirrored is the correct answer, not an oversight. A tilted, non-axis
/// aligned Axis3 is outside what a plan projection represents at all.
pub(super) fn parse_cartesian_transformation_operator(
    operator: &DecodedEntity,
    decoder: &mut EntityDecoder,
    unit_scale: f32,
) -> Transform2D {
    // attr 2 = LocalOrigin (IfcCartesianPoint). Its THIRD ordinate is an
    // elevation the file authored just as much as the first two are a plan
    // translation, so it is read the same way — `point_elevation` yields `NaN`
    // for a two-ordinate point (an `…Operator2D`, or a 3D one written flat),
    // which is what makes "this operator contributed no Z" a separate answer
    // from "it contributed 0" without a type test here. Dropping it discarded
    // an authored translation: a MappingTarget at Z = 5 over a MappingOrigin at
    // Z = 0 came out at 0, and over a product placed at Z = 7 came out at 7.
    let (tx, ty, tz) = match operator.get_ref(2) {
        Some(loc_ref) => match decoder.decode_by_id(loc_ref) {
            Ok(loc) if loc.ifc_type == IfcType::IfcCartesianPoint => {
                let coords = loc
                    .get(0)
                    .and_then(|a| a.as_list())
                    .map(|l| l.to_vec())
                    .unwrap_or_default();
                let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0) as f32;
                let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32;
                // NOT scaled by `Scale` (attr 3), matching tx/ty and the IFC
                // definition `P' = LocalOrigin + Scale * M * P`: the operator's
                // own origin is not itself scaled.
                let tz = point_elevation(&coords, unit_scale);
                (x * unit_scale, y * unit_scale, tz)
            }
            // An unresolvable LocalOrigin states no elevation — `NaN`, not a
            // fictitious datum 0.0, exactly as `parse_axis2_placement_2d` and
            // `Transform2D::identity()` treat their own failure branches.
            _ => (0.0, 0.0, f32::NAN),
        },
        None => (0.0, 0.0, f32::NAN),
    };

    // Scale (attr 3), defaulting to 1.0 when absent/null or non-finite (the same
    // NaN guard the 3D operator parser applies, so a malformed Scale can never
    // poison a coordinate). The MAGNITUDE is taken: a negative Scale is a
    // uniform-reflection convention some exporters use, distinct from the
    // Axis2 mirroring this function now derives; folding its sign in here too
    // is out of scope for #1994 (unchanged from before this fix).
    let raw_scale = operator.get(3).and_then(|v| v.as_float()).unwrap_or(1.0) as f32;
    let scale = if raw_scale.is_finite() { raw_scale.abs() } else { 1.0 };

    // Axis1 (attr 0) gives the X direction for 2D / 3D operators.
    let x_axis = match operator.get_ref(0) {
        Some(ax_ref) => match decoder.decode_by_id(ax_ref) {
            Ok(ax) if ax.ifc_type == IfcType::IfcDirection => {
                let ratios = ax
                    .get(0)
                    .and_then(|a| a.as_list())
                    .map(|l| l.to_vec())
                    .unwrap_or_default();
                let dx = ratios.first().and_then(|v| v.as_float()).unwrap_or(1.0) as f32;
                let dy = ratios.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32;
                let len = (dx * dx + dy * dy).sqrt();
                if len > 0.0001 {
                    (dx / len, dy / len)
                } else {
                    (1.0, 0.0)
                }
            }
            _ => (1.0, 0.0),
        },
        None => (1.0, 0.0),
    };

    // Right-handed perpendicular of Axis1 (the default Y when Axis2 is
    // absent or agrees with it): rotating (dx, dy) by +90°.
    let default_y = (-x_axis.1, x_axis.0);

    // Axis2 (attr 1): only consulted when it DISAGREES with `default_y`.
    let y_axis = match operator.get_ref(1) {
        Some(ax_ref) => match decoder.decode_by_id(ax_ref) {
            Ok(ax) if ax.ifc_type == IfcType::IfcDirection => {
                let ratios = ax
                    .get(0)
                    .and_then(|a| a.as_list())
                    .map(|l| l.to_vec())
                    .unwrap_or_default();
                let ex = ratios.first().and_then(|v| v.as_float()).unwrap_or(0.0) as f32;
                let ey = ratios.get(1).and_then(|v| v.as_float()).unwrap_or(1.0) as f32;
                // Project onto the perpendicular of x_axis (Gram-Schmidt),
                // matching the 3D path's orthogonalization.
                let dot = ex * x_axis.0 + ey * x_axis.1;
                let px = ex - dot * x_axis.0;
                let py = ey - dot * x_axis.1;
                let len = (px * px + py * py).sqrt();
                if len > 0.0001 {
                    let proj = (px / len, py / len);
                    let agreement = proj.0 * default_y.0 + proj.1 * default_y.1;
                    if agreement < 1.0 - 1e-6 {
                        proj
                    } else {
                        default_y
                    }
                } else {
                    default_y
                }
            }
            _ => default_y,
        },
        None => default_y,
    };

    Transform2D {
        tx,
        ty,
        tz,
        m00: x_axis.0 * scale,
        m10: x_axis.1 * scale,
        m01: y_axis.0 * scale,
        m11: y_axis.1 * scale,
    }
}
