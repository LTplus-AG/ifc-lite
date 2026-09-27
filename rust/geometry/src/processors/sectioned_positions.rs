// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cross-section positions of `IfcSectionedSolidHorizontal`: IFC4x1
//! `IfcDistanceExpression` and IFC4x3 `IfcAxis2PlacementLinear` →
//! `IfcPointByDistanceExpression`, normalised to one structured position.
//! A private child of `sectioned.rs` (same pattern as `surface.rs` →
//! `curve_walk.rs`), split out so the processor stays within its
//! module-size budget.

use ifc_lite_core::{AttributeValue, DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Vector3;

use crate::{alignment_arc_length::ArcLengthMap, Error, Result};

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
    pub(super) axis: Option<Vector3<f64>>,
    pub(super) ref_direction: Option<Vector3<f64>>,
    pub(super) linear: bool,
}

impl PositionAlongDirectrix {
    /// Accepts both schema generations of `CrossSectionPositions`:
    ///
    /// - IFC4x1 `IfcDistanceExpression` (read by [`Self::parse_distance_expression`]).
    /// - IFC4x3 `IfcAxis2PlacementLinear` whose `Location` is an
    ///   `IfcPointByDistanceExpression(DistanceAlong, OffsetLateral,
    ///   OffsetVertical, OffsetLongitudinal, BasisCurve)`. Its
    ///   `Axis` and `RefDirection` are retained for the section frame.
    ///   IFC4x3 `OffsetLateral` is positive to the left, so it is negated
    ///   for this processor's right-positive convention. `DistanceAlong`
    ///   measures cumulative 3D length along its `BasisCurve` and is
    ///   converted to horizontal station through one shared arc-length map.
    pub(super) fn parse(
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        directrix: &DecodedEntity,
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
        let basis = decoder.decode_by_id(location.get_ref(4).ok_or_else(|| {
            Error::geometry("IfcPointByDistanceExpression.BasisCurve is required".to_string())
        })?)?;
        if basis.id != directrix.id {
            return Err(Error::geometry("CrossSectionPosition BasisCurve differs from Directrix".to_string()));
        }
        let is_parameter = matches!(location.get(0), Some(AttributeValue::List(items))
            if matches!(items.first(), Some(AttributeValue::String(name)) if name.eq_ignore_ascii_case("IFCPARAMETERVALUE")));
        let distance_along = if is_parameter {
            match basis.ifc_type {
                IfcType::IfcCircle => distance_along * basis.get_float(1).ok_or_else(|| {
                    Error::geometry("IfcCircle missing Radius".to_string())
                })?,
                IfcType::IfcLine => {
                    let vector = decoder.decode_by_id(basis.get_ref(1).ok_or_else(|| {
                        Error::geometry("IfcLine missing Dir".to_string())
                    })?)?;
                    distance_along * vector.get_float(1).ok_or_else(|| {
                        Error::geometry("IfcVector missing Magnitude".to_string())
                    })?
                }
                _ => return Err(Error::geometry(format!(
                    "IfcParameterValue station on {:?} is unsupported", basis.ifc_type
                ))),
            }
        } else { distance_along };
        let axis = read_direction(entity, 1, decoder)?;
        let ref_direction = read_direction(entity, 2, decoder)?;
        Ok(Self {
            distance_along,
            offset_lateral: -location.get_float(1).unwrap_or(0.0),
            offset_vertical: location.get_float(2).unwrap_or(0.0),
            offset_longitudinal: location.get_float(3).unwrap_or(0.0),
            along_horizontal: false,
            axis,
            ref_direction,
            linear: true,
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
            axis: None,
            ref_direction: None,
            linear: false,
        })
    }

    /// Convert `distance_along` to a horizontal-projection station so
    /// `AlignmentCurve::evaluate` (which is parameterised on horizontal
    /// station) sees a consistent input. When the IFC author specified
    /// the distance as 3D arc length, invert its cumulative mapping.
    pub(super) fn horizontal_station(&self, map: Option<&ArcLengthMap>) -> f64 {
        if self.along_horizontal {
            return self.distance_along;
        }
        let Some(map) = map else {
            return self.distance_along;
        };
        map.horizontal_station(self.distance_along)
    }
}

fn read_direction(entity: &DecodedEntity, index: usize, decoder: &mut EntityDecoder) -> Result<Option<Vector3<f64>>> {
    let Some(id) = entity.get_ref(index) else { return Ok(None) };
    let direction = decoder.decode_by_id(id)?;
    let ratios = direction.get_list(0).ok_or_else(|| Error::geometry("IfcDirection missing DirectionRatios".to_string()))?;
    let v = Vector3::new(
        ratios.first().and_then(AttributeValue::as_float).unwrap_or(0.0),
        ratios.get(1).and_then(AttributeValue::as_float).unwrap_or(0.0),
        ratios.get(2).and_then(AttributeValue::as_float).unwrap_or(0.0),
    );
    v.try_normalize(1e-12).map(Some).ok_or_else(|| {
        Error::geometry("IfcAxis2PlacementLinear direction has zero length".to_string())
    })
}
