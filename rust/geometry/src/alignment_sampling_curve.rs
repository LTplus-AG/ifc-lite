// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Refuse sparse/omitted composite segments before the permissive renderer sampler.
use std::collections::HashSet;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use crate::{Error, Result};

pub(super) fn validate_composite(curve: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<()> {
    let mut stack = vec![curve.id];
    let mut visited = HashSet::new();
    while let Some(id) = stack.pop() {
        // Validation is a pure function of entity ID: globally memoize it.
        if !visited.insert(id) { continue; }
        if visited.len() > 100_000 { return Err(Error::geometry("Alignment validation exceeded curve-node budget")); }
        let item = decoder.decode_by_id(id)?;
        match item.ifc_type {
            IfcType::IfcGradientCurve => {
                stack.push(item.get_ref(2).ok_or_else(|| Error::geometry("GradientCurve missing BaseCurve"))?);
            }
            IfcType::IfcCompositeCurve => {
                let refs = item.get_list(0).ok_or_else(|| Error::geometry("CompositeCurve missing Segments"))?;
                for attr in refs {
                    let segment_id = attr.as_entity_ref().ok_or_else(|| Error::geometry("Composite segment must be a reference"))?;
                    let segment = decoder.decode_by_id(segment_id)?;
                    if segment.ifc_type == IfcType::IfcCurveSegment {
                        if segment.get_float(2).is_none_or(|v| !v.is_finite()) || segment.get_float(3).is_none_or(|v| !v.is_finite()) {
                            return Err(Error::geometry(format!("CurveSegment #{} missing finite start/length", segment_id)));
                        }
                        let points = crate::curve_segment::sample_curve_segment(&segment, decoder)
                            .ok_or_else(|| Error::geometry(format!("CurveSegment #{} is unsupported or incomplete; sparse fallback refused", segment_id)))?;
                        if points.len() < 2 || points.iter().any(|p| !p.iter().all(|v| v.is_finite())) {
                            return Err(Error::geometry(format!("Invalid sampled CurveSegment #{}", segment_id)));
                        }
                    } else if segment.ifc_type == IfcType::IfcCompositeCurveSegment {
                        stack.push(segment.get_ref(2).ok_or_else(|| Error::geometry("CompositeCurveSegment missing ParentCurve"))?);
                    } else { return Err(Error::geometry(format!("Unsupported composite segment {}", segment.ifc_type))); }
                }
            }
            IfcType::IfcTrimmedCurve => stack.push(item.get_ref(0).ok_or_else(|| Error::geometry("TrimmedCurve missing BasisCurve"))?),
            IfcType::IfcPolyline => { crate::AlignmentCurve::parse_for_sampling(&item, decoder)?; }
            _ => {}
        }
    }
    Ok(())
}
