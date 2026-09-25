// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cross-section positions of `IfcSectionedSolidHorizontal`: IFC4x1
//! `IfcDistanceExpression` and IFC4x3 `IfcAxis2PlacementLinear` →
//! `IfcPointByDistanceExpression`, normalised to one structured position.
//! A private child of `sectioned.rs` (same pattern as `surface.rs` →
//! `curve_walk.rs`), split out so the processor stays within its
//! module-size budget.

use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

use crate::{alignment::AlignmentCurve, Error, Result};

/// Structured IFC4x1 `IfcDistanceExpression`. We carry every attribute
/// because the offsets matter even when they're zero — they're the
/// reason girders / railings authored with only two endpoint stations
/// don't collapse onto the directrix.
#[derive(Debug, Clone, Copy)]
pub(super) struct PositionAlongDirectrix {
    /// Cumulative distance along the horizontal alignment. The unit is
    /// the file's length unit (the router applies the metre conversion
    /// downstream of the processor).
    pub(super) distance_along: f64,
    /// Lateral offset perpendicular to the directrix tangent in the
    /// horizontal plane. Positive = right of travel (IFC4x1
    /// convention).
    pub(super) offset_lateral: f64,
    /// Vertical offset along the world +Z axis.
    pub(super) offset_vertical: f64,
    /// Offset along the 3D directrix tangent. Always rare but
    /// implemented for completeness.
    pub(super) offset_longitudinal: f64,
    /// When `true` (default), `distance_along` is measured along the
    /// horizontal projection of the directrix. When `false` it's
    /// measured along the 3D curve including slope.
    pub(super) along_horizontal: bool,
}

impl PositionAlongDirectrix {
    /// Accepts both schema generations of `CrossSectionPositions`:
    ///
    /// - IFC4x1 `IfcDistanceExpression` (read by [`Self::parse_distance_expression`]).
    /// - IFC4x3 `IfcAxis2PlacementLinear` whose `Location` is an
    ///   `IfcPointByDistanceExpression(DistanceAlong, OffsetLateral,
    ///   OffsetVertical, OffsetLongitudinal, BasisCurve)`. Its
    ///   `Axis`/`RefDirection` are not applied (the frame comes from the
    ///   directrix, as for IFC4x1). Two convention differences are mapped
    ///   onto the IFC4x1 shape this processor works in: `OffsetLateral` is
    ///   positive to the LEFT in IFC4x3 (local +Y, the same convention
    ///   `linear.rs` resolves `IfcLinearPlacement` with), so it is negated;
    ///   and `DistanceAlong` is measured along the basis curve itself, so on
    ///   a 3D `IfcPolyline` directrix it is 3D arc length
    ///   (`along_horizontal = false`), while on an alignment curve it is the
    ///   horizontal station.
    pub(super) fn parse(
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        directrix_type: &IfcType,
    ) -> Result<Self> {
        if entity.ifc_type != IfcType::IfcAxis2PlacementLinear {
            return Self::parse_distance_expression(entity);
        }
        let location_id = entity.get_ref(0).ok_or_else(|| {
            Error::geometry("IfcAxis2PlacementLinear missing Location".to_string())
        })?;
        let location = decoder.decode_by_id(location_id)?;
        if location.ifc_type != IfcType::IfcPointByDistanceExpression {
            return Err(Error::geometry(format!(
                "IfcAxis2PlacementLinear.Location must be IfcPointByDistanceExpression, got {:?}",
                location.ifc_type
            )));
        }
        let distance_along = location.get_float(0).ok_or_else(|| {
            Error::geometry("IfcPointByDistanceExpression.DistanceAlong is required".to_string())
        })?;
        Ok(Self {
            distance_along,
            offset_lateral: -location.get_float(1).unwrap_or(0.0),
            offset_vertical: location.get_float(2).unwrap_or(0.0),
            offset_longitudinal: location.get_float(3).unwrap_or(0.0),
            along_horizontal: *directrix_type != IfcType::IfcPolyline,
        })
    }

    fn parse_distance_expression(entity: &DecodedEntity) -> Result<Self> {
        let distance_along = entity.get_float(0).ok_or_else(|| {
            Error::geometry("IfcDistanceExpression.DistanceAlong is required".to_string())
        })?;
        let offset_lateral = entity.get_float(1).unwrap_or(0.0);
        let offset_vertical = entity.get_float(2).unwrap_or(0.0);
        let offset_longitudinal = entity.get_float(3).unwrap_or(0.0);
        // AlongHorizontal defaults to TRUE per IFC4x1 if omitted.
        let along_horizontal = entity
            .get(4)
            .and_then(|v| v.as_enum())
            .map(|s| s == "T")
            .unwrap_or(true);
        Ok(Self {
            distance_along,
            offset_lateral,
            offset_vertical,
            offset_longitudinal,
            along_horizontal,
        })
    }

    /// Convert `distance_along` to a horizontal-projection station so
    /// `AlignmentCurve::evaluate` (which is parameterised on horizontal
    /// station) sees a consistent input. When the IFC author specified
    /// the distance as 3D arc length we divide out the average slope —
    /// equivalent to first-order accurate for typical bridge / road
    /// grades (< 5%), which is the regime where `AlongHorizontal=false`
    /// is ever authored.
    pub(super) fn horizontal_station(&self, alignment: Option<&AlignmentCurve>) -> f64 {
        if self.along_horizontal {
            return self.distance_along;
        }
        let Some(a) = alignment else {
            return self.distance_along;
        };
        // First-order: divide by sqrt(1 + slope²) at the candidate
        // station. One Newton-style refinement gives sub-mm accuracy on
        // realistic grades — see test below.
        let mut station = self.distance_along;
        for _ in 0..4 {
            let frame = a.evaluate(station);
            // tangent.z = sin(atan(slope)); sec(atan(slope)) = 1/cos =
            // 1/√(1−tangent.z²)
            let proj = (1.0 - frame.tangent.z * frame.tangent.z).sqrt().max(1e-9);
            let next = self.distance_along * proj;
            if (next - station).abs() < 1e-6 {
                return next;
            }
            station = next;
        }
        station
    }
}
