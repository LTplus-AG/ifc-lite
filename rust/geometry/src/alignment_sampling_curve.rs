// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Refuse sparse/omitted composite segments before the permissive renderer sampler.
use crate::{Error, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use std::collections::HashSet;

pub(super) fn validate_composite(curve: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<()> {
    validate_composite_with_budget(curve, decoder, 100_000)
}

pub(super) fn validate_composite_with_budget(
    curve: &DecodedEntity, decoder: &mut EntityDecoder, max_work: usize,
) -> Result<()> {
    let mut stack = vec![(curve.id, false)];
    let mut visited = HashSet::new();
    let mut work = 1usize;
    charge_references(&mut work, 0, max_work)?;
    while let Some((id, segment_required)) = stack.pop() {
        // Validation is pure by ID; geometry accumulation remains canonical.
        let item = decoder.decode_by_id(id)?;
        if segment_required && !matches!(item.ifc_type,
            IfcType::IfcCurveSegment | IfcType::IfcCompositeCurveSegment) {
            return Err(Error::geometry(format!("Unsupported composite segment {}", item.ifc_type)));
        }
        if !visited.insert(id) { continue; }
        match item.ifc_type {
            IfcType::IfcGradientCurve | IfcType::IfcCompositeCurve => {
                let refs = item.get_list(0)
                    .ok_or_else(|| Error::geometry("Composite/gradient curve missing Segments"))?;
                // Charge before enqueue, including repeated references. This
                // bounds both validation work and the pending stack's breadth.
                charge_references(&mut work, refs.len(), max_work)?;
                for attr in refs {
                    stack.push((attr.as_entity_ref()
                        .ok_or_else(|| Error::geometry("Curve segment must be a reference"))?, true));
                }
                if item.ifc_type == IfcType::IfcGradientCurve {
                    charge_references(&mut work, 1, max_work)?;
                    stack.push((item.get_ref(2)
                        .ok_or_else(|| Error::geometry("GradientCurve missing BaseCurve"))?, false));
                }
            }
            IfcType::IfcCurveSegment => {
                validate_segment_placement(&item, decoder)?;
                if item.get_float(2).is_none_or(|v| !v.is_finite())
                    || item.get_float(3).is_none_or(|v| !v.is_finite()) {
                    return Err(Error::geometry(format!("CurveSegment #{} missing finite start/length", id)));
                }
                let points = crate::curve_segment::sample_curve_segment(&item, decoder)
                    .ok_or_else(|| Error::geometry(format!("CurveSegment #{} is unsupported or incomplete; sparse fallback refused", id)))?;
                if points.len() < 2 || points.iter().any(|p| !p.iter().all(|v| v.is_finite())) {
                    return Err(Error::geometry(format!("Invalid sampled CurveSegment #{}", id)));
                }
            }
            IfcType::IfcCompositeCurveSegment | IfcType::IfcTrimmedCurve => {
                charge_references(&mut work, 1, max_work)?;
                let index = if item.ifc_type == IfcType::IfcTrimmedCurve { 0 } else { 2 };
                stack.push((item.get_ref(index)
                    .ok_or_else(|| Error::geometry("Curve segment missing parent/basis curve"))?, false));
            }
            IfcType::IfcPolyline => { crate::AlignmentCurve::parse_for_sampling(&item, decoder)?; }
            _ => {}
        }
    }
    Ok(())
}

fn charge_references(work: &mut usize, additional: usize, max_work: usize) -> Result<()> {
    if additional > max_work.saturating_sub(*work) || *work > max_work {
        return Err(Error::geometry("Alignment validation exceeded curve-reference work budget"));
    }
    *work += additional;
    Ok(())
}

/// Validate references the planar canonical evaluator would otherwise default.
pub(super) fn validate_segment_placement(
    segment: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<()> {
    let placement = decoder.decode_by_id(
        segment
            .get_ref(1)
            .ok_or_else(|| Error::geometry("CurveSegment missing Placement"))?,
    )?;
    let (dimension, direction_index) = match placement.ifc_type {
        IfcType::IfcAxis2Placement2D => (2, 1),
        IfcType::IfcAxis2Placement3D => (3, 2),
        _ => {
            return Err(Error::geometry(
                "CurveSegment Placement must be an axis placement",
            ))
        }
    };
    let location = decoder.decode_by_id(
        placement
            .get_ref(0)
            .ok_or_else(|| Error::geometry("CurveSegment placement missing Location"))?,
    )?;
    validate_primitive(&location, IfcType::IfcCartesianPoint, dimension)?;
    if let Some(attr) = placement.get(direction_index).filter(|a| !a.is_null()) {
        let direction = decoder.decode_by_id(
            attr.as_entity_ref()
                .ok_or_else(|| Error::geometry("Curve direction must be a reference"))?,
        )?;
        let ratios = validate_primitive(&direction, IfcType::IfcDirection, dimension)?;
        if ratios[0].hypot(ratios[1]) <= 1e-12 || (dimension == 3 && ratios[2].abs() > 1e-12) {
            return Err(Error::geometry(
                "Curve segment direction must be a nondegenerate horizontal direction",
            ));
        }
    }
    if dimension == 3 {
        if let Some(attr) = placement.get(1).filter(|a| !a.is_null()) {
            let direction = decoder.decode_by_id(
                attr.as_entity_ref()
                    .ok_or_else(|| Error::geometry("Curve Axis must be a reference"))?,
            )?;
            let ratios = validate_primitive(&direction, IfcType::IfcDirection, 3)?;
            if ratios[0].abs() > 1e-12 || ratios[1].abs() > 1e-12 || ratios[2] <= 0. {
                return Err(Error::geometry(
                    "Tilted curve-segment placement is unsupported by the planar evaluator",
                ));
            }
        }
    }
    Ok(())
}

fn validate_primitive(
    entity: &DecodedEntity,
    expected: IfcType,
    dimension: usize,
) -> Result<Vec<f64>> {
    if entity.ifc_type != expected {
        return Err(Error::geometry(format!(
            "Expected {expected}, got {}",
            entity.ifc_type
        )));
    }
    let values = entity
        .get_list(0)
        .ok_or_else(|| Error::geometry("Missing curve placement coordinates/ratios"))?;
    if values.len() != dimension {
        return Err(Error::geometry("Curve placement dimensionality mismatch"));
    }
    values
        .iter()
        .map(|v| {
            v.as_float()
                .filter(|v| v.is_finite())
                .ok_or_else(|| Error::geometry("Invalid curve placement coordinate/ratio"))
        })
        .collect()
}
