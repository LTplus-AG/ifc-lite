// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IFC interpretation of trimmed lines and circles, shared by analytic source
//! descriptions and sampled mesh directrices. Sampling remains consumer-owned.

use crate::curve_source::{circle_basis, line_basis, trim_angle, trim_point};
use crate::Result;
use ifc_lite_core::{AttributeValue, DecodedEntity, EntityDecoder, IfcType};
use std::f64::consts::TAU;

#[derive(Clone, Copy)]
pub(crate) enum TrimRecovery {
    /// Analytic descriptions require both authored bounds and reject a zero arc.
    RequireBoth,
    /// The mesh path historically recovers absent bounds from the basis domain
    /// and samples a zero arc for cyclically equal authored bounds.
    BasisDefaults,
}

pub(crate) enum TrimmedPrimitive {
    Line {
        start: [f64; 3],
        end: [f64; 3],
    },
    Circle {
        center: [f64; 3],
        normal: [f64; 3],
        x_axis: [f64; 3],
        y_axis: [f64; 3],
        radius: f64,
        start_angle: f64,
        sweep_angle: f64,
    },
}

/// Trim1 is the first point of the resulting curve even when SenseAgreement is
/// false. On a line, false sense is encoded by descending basis parameters;
/// reversing the selected points would contradict IFC4.3 IfcTrimmedCurve.
pub(crate) fn decode_trimmed_primitive(
    trimmed: &DecodedEntity,
    basis: &DecodedEntity,
    decoder: &mut EntityDecoder,
    recovery: TrimRecovery,
) -> Result<Option<TrimmedPrimitive>> {
    let cartesian = trimmed.get(4).and_then(AttributeValue::as_enum) == Some("CARTESIAN");
    let sense = trimmed
        .get(3)
        .and_then(AttributeValue::as_enum)
        .unwrap_or("T")
        == "T";
    let ignore_bad_cartesian = matches!(recovery, TrimRecovery::BasisDefaults);
    match basis.ifc_type {
        IfcType::IfcLine => {
            let (origin, direction) = line_basis(basis, decoder)?;
            let first = trim_point(
                trimmed.get(1),
                origin,
                direction,
                cartesian,
                ignore_bad_cartesian,
                decoder,
            )?;
            let second = trim_point(
                trimmed.get(2),
                origin,
                direction,
                cartesian,
                ignore_bad_cartesian,
                decoder,
            )?;
            let (start, end) = match recovery {
                TrimRecovery::RequireBoth => {
                    let (Some(start), Some(end)) = (first, second) else {
                        return Ok(None);
                    };
                    (start, end)
                }
                TrimRecovery::BasisDefaults => {
                    let basis_end = std::array::from_fn(|i| origin[i] + direction[i]);
                    (first.unwrap_or(origin), second.unwrap_or(basis_end))
                }
            };
            Ok(Some(TrimmedPrimitive::Line { start, end }))
        }
        IfcType::IfcCircle => {
            let (center, normal, x_axis, y_axis, radius) = circle_basis(basis, decoder)?;
            let first = trim_angle(
                trimmed.get(1),
                center,
                x_axis,
                y_axis,
                cartesian,
                ignore_bad_cartesian,
                decoder,
            )?;
            let second = trim_angle(
                trimmed.get(2),
                center,
                x_axis,
                y_axis,
                cartesian,
                ignore_bad_cartesian,
                decoder,
            )?;
            let authored_pair = first.is_some() && second.is_some();
            let (start_angle, end_angle) = match recovery {
                TrimRecovery::RequireBoth => {
                    let (Some(start), Some(end)) = (first, second) else {
                        return Ok(None);
                    };
                    (start, end)
                }
                TrimRecovery::BasisDefaults => (first.unwrap_or(0.0), second.unwrap_or(TAU)),
            };
            let mut sweep_angle = (end_angle - start_angle).rem_euclid(TAU);
            // IFC4.3 informal proposition 4 forbids equal trim parameters,
            // including cyclic equality on closed curves. Preserve the mesh
            // path's historical zero-length recovery for malformed input.
            if authored_pair && sweep_angle.abs() < 1e-12 {
                return Ok(match recovery {
                    TrimRecovery::RequireBoth => None,
                    TrimRecovery::BasisDefaults => Some(TrimmedPrimitive::Circle {
                        center,
                        normal,
                        x_axis,
                        y_axis,
                        radius,
                        start_angle,
                        sweep_angle: 0.0,
                    }),
                });
            }
            if !sense {
                sweep_angle -= TAU;
            }
            if sweep_angle.abs() < 1e-12 {
                sweep_angle = if sense { TAU } else { -TAU };
            }
            Ok(Some(TrimmedPrimitive::Circle {
                center,
                normal,
                x_axis,
                y_axis,
                radius,
                start_angle,
                sweep_angle,
            }))
        }
        _ => Ok(None),
    }
}
