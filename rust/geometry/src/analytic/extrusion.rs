// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Authored `IfcExtrudedAreaSolid` parameters before occurrence placement.

use super::{extract_analytic_profile, AnalyticProfile, AnalyticStatus};
use crate::transform::parse_axis2_placement_3d;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use serde::Serialize;

/// One source extrusion in IFC file-length units and IFC Z-up. `Position`
/// maps the profile's coordinates into the solid's local frame; a product or
/// mapping transform is separate. No CSG or external void is applied here.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AnalyticExtrusion {
    pub solid_id: u32,
    #[serde(rename = "SweptArea")]
    pub swept_area_id: Option<u32>,
    pub profile: Option<AnalyticProfile>,
    #[serde(rename = "Position")]
    pub position_id: Option<u32>,
    /// Matrix derived from `Position`, in raw IFC file-length units.
    pub position_matrix: Option<[f64; 16]>,
    #[serde(rename = "ExtrudedDirection")]
    pub extruded_direction_id: Option<u32>,
    /// Authored `IfcDirection.DirectionRatios`, before unit-vector normalization.
    #[serde(rename = "DirectionRatios")]
    pub direction_ratios: Option<[f64; 3]>,
    /// Unit vector derived from `DirectionRatios` for geometric interpretation.
    pub axis_unit_vector: Option<[f64; 3]>,
    #[serde(rename = "Depth")]
    pub depth: Option<f64>,
    pub status: AnalyticStatus,
}

/// Return a complete exact source or an explicit unsupported reason. Even a
/// malformed required attribute keeps its solid STEP ID in the result.
pub fn extract_analytic_extrusion(
    solid: &DecodedEntity, decoder: &mut EntityDecoder,
) -> AnalyticExtrusion {
    let mut result = AnalyticExtrusion {
        solid_id: solid.id, swept_area_id: solid.get_ref(0), profile: None,
        position_id: solid.get_ref(1), position_matrix: None,
        extruded_direction_id: solid.get_ref(2), direction_ratios: None,
        axis_unit_vector: None, depth: None, status: AnalyticStatus::Complete,
    };
    let parsed = parse_extrusion(solid, decoder, &mut result);
    if let Err(reason) = parsed {
        result.status = AnalyticStatus::Unsupported(reason);
    }
    result
}

fn parse_extrusion(
    solid: &DecodedEntity, decoder: &mut EntityDecoder, result: &mut AnalyticExtrusion,
) -> Result<(), String> {
    match solid.ifc_type {
        IfcType::IfcExtrudedAreaSolid => {}
        IfcType::IfcExtrudedAreaSolidTapered =>
            return Err("tapered extrusion has distinct start and end profiles".into()),
        _ => return Err(format!("{} is not IfcExtrudedAreaSolid", solid.ifc_type.name())),
    }
    let area_id = result.swept_area_id.ok_or("missing SweptArea")?;
    let area = decoder.decode_by_id(area_id)
        .map_err(|error| format!("SweptArea #{area_id}: {error}"))?;
    if !area.ifc_type.is_subtype_of(IfcType::IfcProfileDef) {
        return Err(format!("SweptArea #{area_id} is not IfcProfileDef"));
    }
    let profile = extract_analytic_profile(&area, decoder);
    if profile.profile_type.as_deref() != Some("AREA") {
        let profile_type = profile.profile_type.clone().unwrap_or_else(|| "missing".into());
        result.profile = Some(profile);
        return Err(format!("SweptArea #{area_id} has ProfileType {profile_type}, expected AREA"));
    }
    if let AnalyticStatus::Unsupported(reason) = &profile.status {
        let reason = format!("SweptArea #{area_id}: {reason}");
        result.profile = Some(profile);
        return Err(reason);
    }
    result.profile = Some(profile);

    if let Some(position_attr) = solid.get(1).filter(|attribute| !attribute.is_null()) {
        let id = position_attr.as_entity_ref().ok_or("invalid Position reference")?;
        result.position_id = Some(id);
        let position = decoder.decode_by_id(id)
            .map_err(|error| format!("Position #{id}: {error}"))?;
        if position.ifc_type != IfcType::IfcAxis2Placement3D {
            return Err(format!("Position #{id} is not IfcAxis2Placement3D"));
        }
        let matrix = parse_axis2_placement_3d(&position, decoder)
            .map_err(|error| format!("Position #{id}: {error}"))?;
        if matrix.iter().any(|value| !value.is_finite()) {
            return Err(format!("Position #{id} has non-finite coordinates"));
        }
        let mut values = [0.0; 16];
        values.copy_from_slice(matrix.as_slice());
        result.position_matrix = Some(values);
    }

    let direction_id = solid.get_ref(2).ok_or("missing ExtrudedDirection")?;
    let direction = decoder.decode_by_id(direction_id)
        .map_err(|error| format!("ExtrudedDirection #{direction_id}: {error}"))?;
    if direction.ifc_type != IfcType::IfcDirection {
        return Err(format!("ExtrudedDirection #{direction_id} is not IfcDirection"));
    }
    let ratios = direction.get_list(0).ok_or("ExtrudedDirection has no DirectionRatios")?;
    if ratios.len() < 2 || ratios.len() > 3 {
        return Err("ExtrudedDirection has invalid coordinate count".into());
    }
    let mut vector = [0.0; 3];
    for (index, ratio) in ratios.iter().enumerate() {
        vector[index] = ratio.as_float().ok_or("ExtrudedDirection has invalid ratio")?;
    }
    result.direction_ratios = Some(vector);
    let norm = vector[0].hypot(vector[1]).hypot(vector[2]);
    if !norm.is_finite() || norm <= 0.0 {
        return Err("ExtrudedDirection is non-finite or zero".into());
    }
    let unit_axis = vector.map(|value| value / norm);
    // IFC ValidExtrusionDirection: the sweep must not be perpendicular to the
    // local Z axis of IfcSweptAreaSolid.Position.
    if unit_axis[2] == 0.0 {
        return Err("ExtrudedDirection is perpendicular to local Z".into());
    }
    result.axis_unit_vector = Some(unit_axis);

    let depth = solid.get_float(3).ok_or("missing Depth")?;
    if !depth.is_finite() || depth <= 0.0 {
        return Err("invalid Depth".into());
    }
    result.depth = Some(depth);
    Ok(())
}

#[cfg(test)]
#[path = "extrusion_tests.rs"]
mod tests;
