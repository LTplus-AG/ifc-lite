// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! "Did this file actually say how high the symbol sits?" (#2256)
//!
//! Every symbolic primitive carries a `world_y`, summed from at most two
//! sources: the Z translation accumulated along the product's placement chain,
//! and the Z ordinate of the primitive's own geometry point. Both are
//! genuinely optional in real files — an `IfcAxis2Placement2D` chain has no Z
//! at all, an `IfcCartesianPoint` may be authored with two ordinates, and a
//! product may carry no `ObjectPlacement` whatsoever.
//!
//! Defaulting a missing source to `0.0` collapsed "at datum" and "this file
//! never said" into the same number. The viewer's storey bucketing then had to
//! guess which one it was holding, and guessed with `world_y !== 0` (#2256):
//! every ground-floor annotation was read as unresolved, so it was re-bucketed
//! onto whatever the storey table claimed, or dropped into the loose bucket
//! when the export carried no spatial hierarchy to look in.
//!
//! So "absent" is `f32::NAN` here, from the placement parse all the way to the
//! emitted primitive. That is the sentinel [`SymbolicPolyline::world_y`] has
//! always documented and that `nan_as_null` already carries across the JSON
//! wire; this module is what makes the producer actually emit it.
//!
//! [`SymbolicPolyline::world_y`]: super::primitives::SymbolicPolyline::world_y

use ifc_lite_core::AttributeValue;

/// Sum two elevation contributions, reading `NaN` as "contributed nothing".
///
/// `NaN` acts as the additive identity when the other side is a real number,
/// and survives only when BOTH sides are absent. A plain `a + b` cannot do
/// this: one missing contribution would poison a total the other side had
/// perfectly well resolved.
///
/// Note this is deliberately NOT associative-with-`0.0`: `add(NaN, 0.0)` is
/// `0.0` (a real datum elevation someone authored), while `add(NaN, NaN)`
/// stays `NaN` (nobody authored anything). Distinguishing those two is the
/// entire point.
pub(super) fn add_elevation(a: f32, b: f32) -> f32 {
    match (a.is_nan(), b.is_nan()) {
        (false, false) => a + b,
        (false, true) => a,
        (true, false) => b,
        (true, true) => f32::NAN,
    }
}

/// The Z ordinate of an `IfcCartesianPoint` coordinate list, scaled to metres.
///
/// `NaN` for a 2D point: an absent third ordinate is not an elevation of zero,
/// it is no elevation at all. A non-numeric third ordinate reads the same way.
pub(super) fn point_elevation(coords: &[AttributeValue], unit_scale: f32) -> f32 {
    coords
        .get(2)
        .and_then(|v| v.as_float())
        .map(|z| z as f32 * unit_scale)
        .unwrap_or(f32::NAN)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_contributions_are_the_additive_identity() {
        assert_eq!(add_elevation(3.0, 2.0), 5.0);
        assert_eq!(add_elevation(3.0, f32::NAN), 3.0);
        assert_eq!(add_elevation(f32::NAN, -3.5), -3.5);
        assert!(add_elevation(f32::NAN, f32::NAN).is_nan());
    }

    /// The boundary the whole module exists for: a real `0.0` from either side
    /// must come back as `0.0`, never as the unresolved sentinel.
    #[test]
    fn a_real_zero_is_not_an_absent_contribution() {
        assert_eq!(add_elevation(0.0, f32::NAN), 0.0);
        assert_eq!(add_elevation(f32::NAN, 0.0), 0.0);
        assert_eq!(add_elevation(0.0, 0.0), 0.0);
        assert!(!add_elevation(0.0, f32::NAN).is_nan());
        // …and a chain that cancels to zero is still resolved.
        assert_eq!(add_elevation(3.0, -3.0), 0.0);
    }

    #[test]
    fn a_two_ordinate_point_has_no_elevation() {
        let two_d = [AttributeValue::Float(1.0), AttributeValue::Float(2.0)];
        assert!(point_elevation(&two_d, 1.0).is_nan());

        let at_datum = [
            AttributeValue::Float(1.0),
            AttributeValue::Float(2.0),
            AttributeValue::Float(0.0),
        ];
        assert_eq!(point_elevation(&at_datum, 1.0), 0.0);

        // Scaled, not passed through: 0.001 is not exact in binary32, so this
        // asserts the product rather than a rounded 3.5.
        let millimetres = [
            AttributeValue::Float(0.0),
            AttributeValue::Float(0.0),
            AttributeValue::Float(3500.0),
        ];
        assert_eq!(point_elevation(&millimetres, 0.001), 3500.0f32 * 0.001f32);
        assert!((point_elevation(&millimetres, 0.001) - 3.5).abs() < 1e-6);
    }
}
