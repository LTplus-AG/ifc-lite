// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! B-spline / NURBS attribute parsing (control points, weights, knot
//! vectors), split out of `bspline.rs` (the pure math) to stay under the
//! module-size ratchet.

use crate::{Error, Point3, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder};

/// Parse rational weights from IfcRationalBSplineSurfaceWithKnots.
/// Attribute 12: WeightsData (LIST of LIST of REAL).
pub(crate) fn parse_rational_weights(bspline: &DecodedEntity) -> Option<Vec<Vec<f64>>> {
    let weights_attr = bspline.get(12)?;
    let rows = weights_attr.as_list()?;
    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        let cols = row.as_list()?;
        let row_weights: Vec<f64> = cols.iter().filter_map(|v| v.as_float()).collect();
        if row_weights.is_empty() {
            return None;
        }
        result.push(row_weights);
    }
    Some(result)
}

/// Read the `ControlPointsList` grid's `(row_count, max_row_len)` straight
/// from the raw attribute list — no `CartesianPoint` reference is resolved or
/// decoded. Callers use this to size-check a surface BEFORE paying for
/// [`parse_control_points`]'s decode-everything walk (#4901): a hostile file
/// can declare millions of point references, and decoding all of them before
/// any cap is checked is itself the unbounded-work hole a downstream cap
/// closes too late to matter. Returns `(0, 0)` if attribute 2 is missing or
/// not a list — [`parse_control_points`] still runs and reports that
/// specific error; this is a fast pre-check, not a replacement.
pub(super) fn control_point_grid_dims(bspline: &DecodedEntity) -> (usize, usize) {
    let Some(rows) = bspline.get(2).and_then(|a| a.as_list()) else {
        return (0, 0);
    };
    let max_row_len = rows.iter().filter_map(|row| row.as_list()).map(<[_]>::len).max().unwrap_or(0);
    (rows.len(), max_row_len)
}

/// Parse control points from B-spline surface entity
pub(super) fn parse_control_points(
    bspline: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<Vec<Vec<Point3<f64>>>> {
    // Attribute 2: ControlPointsList (LIST of LIST of IfcCartesianPoint)
    let cp_list_attr = bspline
        .get(2)
        .ok_or_else(|| Error::geometry("BSplineSurface missing ControlPointsList".to_string()))?;

    let rows = cp_list_attr
        .as_list()
        .ok_or_else(|| Error::geometry("Expected control point list".to_string()))?;

    let mut result = Vec::with_capacity(rows.len());

    for row in rows {
        let cols = row
            .as_list()
            .ok_or_else(|| Error::geometry("Expected control point row".to_string()))?;

        let mut row_points = Vec::with_capacity(cols.len());
        for col in cols {
            if let Some(point_id) = col.as_entity_ref() {
                let point = decoder.decode_by_id(point_id)?;
                let coords = point.get(0).and_then(|v| v.as_list()).ok_or_else(|| {
                    Error::geometry("CartesianPoint missing coordinates".to_string())
                })?;

                let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
                let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);

                row_points.push(Point3::new(x, y, z));
            }
        }
        result.push(row_points);
    }

    Ok(result)
}

/// Per-knot multiplicity ceiling. Real knot multiplicities are bounded by
/// degree+1 (<= ~12 for any practical NURBS); this leaves ~100x headroom while
/// stopping an attacker-controlled multiplicity (e.g. 500_000_000) from driving
/// a multi-gigabyte allocation.
const MAX_KNOT_MULTIPLICITY: i64 = 1024;
/// Total expanded-knot ceiling. A legitimate knot vector is `n_control_points +
/// degree + 1` entries (dozens); 1<<16 is unreachable for any real model. On a
/// malformed file that exceeds it we return an EMPTY vector, so the caller's
/// `knots.len() <= degree` guard rejects the curve/surface rather than sampling a
/// silently-truncated (wrong) knot vector.
const MAX_EXPANDED_KNOTS: usize = 1 << 16;

/// Expand knot vector based on multiplicities
pub(super) fn expand_knots(knot_values: &[f64], multiplicities: &[i64]) -> Vec<f64> {
    let mut expanded = Vec::new();
    for (knot, &mult) in knot_values.iter().zip(multiplicities.iter()) {
        // Negative multiplicities are already inert (`0..mult` is an empty
        // range); clamp the upper end so one entry cannot request a huge push.
        let mult = mult.clamp(0, MAX_KNOT_MULTIPLICITY);
        for _ in 0..mult {
            expanded.push(*knot);
            if expanded.len() > MAX_EXPANDED_KNOTS {
                return Vec::new();
            }
        }
    }
    expanded
}

/// Parse knot vectors from B-spline surface entity
pub(super) fn parse_knot_vectors(bspline: &DecodedEntity) -> Result<(Vec<f64>, Vec<f64>)> {
    // IFCBSPLINESURFACEWITHKNOTS attributes:
    // 0: UDegree
    // 1: VDegree
    // 2: ControlPointsList (already parsed)
    // 3: SurfaceForm
    // 4: UClosed
    // 5: VClosed
    // 6: SelfIntersect
    // 7: UMultiplicities (LIST of INTEGER)
    // 8: VMultiplicities (LIST of INTEGER)
    // 9: UKnots (LIST of REAL)
    // 10: VKnots (LIST of REAL)
    // 11: KnotSpec

    // Get U multiplicities
    let u_mult_attr = bspline
        .get(7)
        .ok_or_else(|| Error::geometry("BSplineSurface missing UMultiplicities".to_string()))?;
    let u_mults: Vec<i64> = u_mult_attr
        .as_list()
        .ok_or_else(|| Error::geometry("Expected U multiplicities list".to_string()))?
        .iter()
        .filter_map(|v| v.as_int())
        .collect();

    // Get V multiplicities
    let v_mult_attr = bspline
        .get(8)
        .ok_or_else(|| Error::geometry("BSplineSurface missing VMultiplicities".to_string()))?;
    let v_mults: Vec<i64> = v_mult_attr
        .as_list()
        .ok_or_else(|| Error::geometry("Expected V multiplicities list".to_string()))?
        .iter()
        .filter_map(|v| v.as_int())
        .collect();

    // Get U knots
    let u_knots_attr = bspline
        .get(9)
        .ok_or_else(|| Error::geometry("BSplineSurface missing UKnots".to_string()))?;
    let u_knot_values: Vec<f64> = u_knots_attr
        .as_list()
        .ok_or_else(|| Error::geometry("Expected U knots list".to_string()))?
        .iter()
        .filter_map(|v| v.as_float())
        .collect();

    // Get V knots
    let v_knots_attr = bspline
        .get(10)
        .ok_or_else(|| Error::geometry("BSplineSurface missing VKnots".to_string()))?;
    let v_knot_values: Vec<f64> = v_knots_attr
        .as_list()
        .ok_or_else(|| Error::geometry("Expected V knots list".to_string()))?
        .iter()
        .filter_map(|v| v.as_float())
        .collect();

    // Expand knot vectors with multiplicities
    let u_knots = expand_knots(&u_knot_values, &u_mults);
    let v_knots = expand_knots(&v_knot_values, &v_mults);

    Ok((u_knots, v_knots))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_knots_caps_hostile_multiplicity() {
        // A single attacker-controlled multiplicity is clamped, so it can never
        // drive a multi-gigabyte allocation (pre-fix: 1_000_000 pushed entries).
        let knots = expand_knots(&[0.0, 1.0], &[1_000_000, 1]);
        assert!(
            knots.len() <= MAX_KNOT_MULTIPLICITY as usize + 1,
            "multiplicity not clamped: got {}",
            knots.len()
        );

        // A knot vector whose total expansion exceeds the ceiling bails to EMPTY,
        // so the caller's `len <= degree` guard rejects it rather than sampling a
        // silently-truncated (wrong) knot vector.
        let many: Vec<f64> = (0..100).map(|i| i as f64).collect();
        let mults = vec![MAX_KNOT_MULTIPLICITY; 100]; // 100 * 1024 > MAX_EXPANDED_KNOTS
        assert!(expand_knots(&many, &mults).is_empty());
    }

    #[test]
    fn expand_knots_keeps_valid_vectors() {
        assert_eq!(
            expand_knots(&[0.0, 0.5, 1.0], &[2, 1, 2]),
            vec![0.0, 0.0, 0.5, 1.0, 1.0]
        );
    }
}
