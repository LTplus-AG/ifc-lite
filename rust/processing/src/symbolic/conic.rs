// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The one reader of an `IfcConic` (`IfcCircle` / `IfcEllipse`) for the 2D
//! symbolic path: placement, semi-axes and parameterisation.

use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

use super::transform::{parse_axis2_placement_2d, Transform2D};

/// Resolve an `IfcConic` `Position` (attribute 0) into the curve's own basis:
/// translation = the centre in metres, linear block = the `RefDirection`
/// rotation, `tz` = the centre's elevation.
///
/// `Position` is MANDATORY on `IfcConic`, so an absent attribute, a dangling
/// reference or a non-placement entity is malformed data and comes back as
/// [`Transform2D::unresolved`]: the plan centre stays at the local origin, as
/// for every unresolved placement in `transform.rs`, and `tz = NaN` marks the
/// result unresolved (#2256's convention) instead of a finite elevation 0.
pub(super) fn conic_basis(
    conic: &DecodedEntity,
    decoder: &mut EntityDecoder,
    unit_scale: f32,
) -> Transform2D {
    let Some(pos_ref) = conic.get_ref(0) else {
        return Transform2D::unresolved(); // mandatory Position absent
    };
    match decoder.decode_by_id(pos_ref) {
        // Wrong type is refused inside `parse_axis2_placement_2d`.
        Ok(position) => parse_axis2_placement_2d(&position, decoder, unit_scale),
        Err(_) => Transform2D::unresolved(), // dangling Position
    }
}

/// An `IfcCircle` or `IfcEllipse`: its own basis and its semi-axes in metres
/// (both equal to the radius for a circle).
pub(super) struct Conic {
    pub(super) basis: Transform2D,
    pub(super) semi_a: f32,
    pub(super) semi_b: f32,
}

impl Conic {
    /// `None` for any other entity type, a semi-axis that is not a positive
    /// finite number, or a centre that is not finite. An unresolved
    /// `Position` is not refused here: its basis keeps a finite centre and
    /// carries `tz = NaN`, so the curve is still drawn and its elevation is
    /// `null`, the same as every other unresolved placement.
    pub(super) fn read(
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
        unit_scale: f32,
    ) -> Option<Self> {
        let length =
            |i: usize| curve.get(i).and_then(|a| a.as_float()).unwrap_or(0.0) as f32 * unit_scale;
        let (semi_a, semi_b) = match curve.ifc_type {
            IfcType::IfcCircle => (length(1), length(1)),
            IfcType::IfcEllipse => (length(1), length(2)),
            _ => return None,
        };
        let valid = |v: f32| v.is_finite() && v > 0.0;
        if !valid(semi_a) || !valid(semi_b) {
            return None;
        }
        let basis = conic_basis(curve, decoder, unit_scale);
        if !basis.tx.is_finite() || !basis.ty.is_finite() {
            return None;
        }
        Some(Self {
            basis,
            semi_a,
            semi_b,
        })
    }

    /// The point at angle `theta` (radians from local +X), in the frame the
    /// conic is placed in. Local +X is `Position.RefDirection` and
    /// `SemiAxis1` runs along it, so the sample goes through the basis
    /// rotation: an ellipse on a rotated placement is drawn rotated.
    pub(super) fn point_at(&self, theta: f32) -> (f32, f32) {
        self.basis
            .transform_point(self.semi_a * theta.cos(), self.semi_b * theta.sin())
    }
}
