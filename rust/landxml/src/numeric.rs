// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The tolerance and circular-arc rules the alignment, parcel and profile
//! numerics share (#7693). Producers round coordinates and lengths to 4-8
//! decimals, often at georeferenced magnitude (~1e6), so a declared value is
//! checked against the computed one relative to its own scale. Absolute
//! epsilons stay only where they guard a division or a degenerate point.

use crate::alignment::LandXmlRotation;

/// Relative agreement required between a declared and a computed length.
pub(crate) const RELATIVE_LENGTH_TOLERANCE: f64 = 1e-6;

/// Relative agreement required between a declared radius and the
/// centre-to-endpoint distances of a circular arc.
const RELATIVE_RADIUS_TOLERANCE: f64 = 1e-7;

/// Allowed difference between a declared horizontal length and the one its
/// endpoints give, in the document's linear unit. The 1e-6 floor keeps very
/// short primitives from requiring bit-exact producer arithmetic.
pub(crate) fn declared_length_tolerance(length: f64) -> f64 {
    (length * RELATIVE_LENGTH_TOLERANCE).max(1e-6)
}

/// Whether a centre-to-endpoint distance agrees with an arc's radius.
pub(crate) fn matches_radius(distance: f64, radius: f64) -> bool {
    (distance - radius).abs() <= radius * RELATIVE_RADIUS_TOLERANCE
}

/// The LandXML `rot` token of a `Curve`.
pub(crate) fn rotation_from_token(token: &str) -> Option<LandXmlRotation> {
    match token {
        "cw" => Some(LandXmlRotation::Clockwise),
        "ccw" => Some(LandXmlRotation::CounterClockwise),
        _ => None,
    }
}

/// Whether `token` is a valid LandXML `rot` value.
pub(crate) fn is_rotation_token(token: &str) -> bool {
    rotation_from_token(token).is_some()
}

/// The signed sweep from `start` to `end` (math angles, radians) turning in
/// `rotation`, in `[0, τ)` counter-clockwise and `(-τ, 0]` clockwise. Equal
/// angles give zero; each caller decides what a coincident pair means.
pub(crate) fn signed_sweep(start: f64, end: f64, rotation: LandXmlRotation) -> f64 {
    let raw = (end - start).rem_euclid(std::f64::consts::TAU);
    match rotation {
        LandXmlRotation::CounterClockwise => raw,
        LandXmlRotation::Clockwise => {
            -(std::f64::consts::TAU - raw).rem_euclid(std::f64::consts::TAU)
        }
    }
}

/// `(northing, easting)` of the point at math `angle` on a circle.
pub(crate) fn point_on_circle(center: (f64, f64), radius: f64, angle: f64) -> (f64, f64) {
    (
        center.0 + radius * angle.sin(),
        center.1 + radius * angle.cos(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signed_sweep_turns_the_requested_way_and_partitions_the_circle() {
        for (start, end) in [(0.3, 2.2), (2.2, 0.3), (-3.0, 3.0), (1.0, 1.0 + 1e-12)] {
            let ccw = signed_sweep(start, end, LandXmlRotation::CounterClockwise);
            let cw = signed_sweep(start, end, LandXmlRotation::Clockwise);
            assert!(ccw >= 0.0 && cw <= 0.0, "{start} {end}");
            assert!(
                (ccw - cw - std::f64::consts::TAU).abs() < 1e-12,
                "{start} {end}"
            );
        }
    }

    #[test]
    fn tolerances_are_relative_to_the_value_scale() {
        assert!(matches_radius(25.0 + 2.4e-6, 25.0));
        assert!(!matches_radius(25.0 + 2.6e-6, 25.0));
        assert!((declared_length_tolerance(1.0e4) - 1.0e-2).abs() < 1e-15);
        assert_eq!(declared_length_tolerance(0.5), 1.0e-6);
    }
}
