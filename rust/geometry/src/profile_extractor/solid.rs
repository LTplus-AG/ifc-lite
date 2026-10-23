// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::{Error, Result, TessellationQuality};
use crate::processors::extrusion_params::ExtrusionParams;
use nalgebra::Matrix4;

// ═══════════════════════════════════════════════════════════════════════════
// PRIVATE: SOLID EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════

pub(super) fn extract_extruded_solid(
    element_id: u32,
    ifc_type: &str,
    solid: &DecodedEntity,
    elem_transform: &Matrix4<f64>,
    unit_scale: f64,
    profile_processor: &ProfileProcessor,
    decoder: &mut EntityDecoder,
    model_index: u32,
) -> Result<ExtractedProfile> {
    // SweptArea (attr 0)
    let profile_attr = solid
        .attr(ifc_lite_core::slot::IfcExtrudedAreaSolid::SWEPT_AREA)
        .ok_or_else(|| Error::geometry("ExtrudedAreaSolid missing SweptArea"))?;
    let profile_entity = decoder
        .resolve_ref(profile_attr)?
        .ok_or_else(|| Error::geometry("Failed to resolve SweptArea"))?;
    // Profile extraction feeds 2D drawing projection, not the tessellation-quality
    // render path; sample at the historical default.
    let profile =
        profile_processor.process(&profile_entity, decoder, TessellationQuality::Medium)?;

    if profile.outer.is_empty() {
        return Err(Error::geometry("empty profile"));
    }

    // Position, ExtrudedDirection and Depth, decoded and refused exactly as
    // `ExtrudedAreaSolidProcessor` does: a solid the 3D path cannot mesh has no
    // drawing profile either (it used to default Depth to 1.0 and a zero or
    // non-IfcDirection direction to +Z; PROC-2, #7690).
    let params = ExtrusionParams::decode(solid, decoder, "ExtrudedAreaSolid")?;
    let solid_transform = params
        .position
        .map(|t| scale_translation(t, unit_scale))
        .unwrap_or_else(Matrix4::identity);
    let local_dir = params.direction.normalize();
    let depth = params.depth * unit_scale;

    // Combined transform: elem_placement * solid_position  (IFC Z-up, metres)
    let combined_ifc = elem_transform * solid_transform;

    // Convert combined transform to WebGL Y-up column-major [f64; 16]
    let transform = convert_ifc_to_webgl(&combined_ifc);

    // Transform local extrusion direction to world IFC space (rotation only, no translation)
    let world_dir_ifc = combined_ifc.transform_vector(&local_dir);

    // Convert world direction to WebGL Y-up
    let extrusion_dir = [
        world_dir_ifc.x as f32,
        world_dir_ifc.z as f32,  // WebGL Y = IFC Z
        -world_dir_ifc.y as f32, // WebGL Z = -IFC Y
    ];

    // Scale profile 2D points from file units to metres
    let outer_points: Vec<f32> = profile
        .outer
        .iter()
        .flat_map(|p| [(p.x * unit_scale) as f32, (p.y * unit_scale) as f32])
        .collect();

    let hole_counts: Vec<u32> = profile.holes.iter().map(|h| h.len() as u32).collect();
    let hole_points: Vec<f32> = profile
        .holes
        .iter()
        .flat_map(|h| {
            h.iter()
                .flat_map(|p| [(p.x * unit_scale) as f32, (p.y * unit_scale) as f32])
        })
        .collect();

    Ok(ExtractedProfile {
        express_id: element_id,
        ifc_type: ifc_type.to_string(),
        outer_points,
        hole_counts,
        hole_points,
        transform,
        extrusion_dir,
        extrusion_depth: depth as f32,
        model_index,
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// PRIVATE: COORDINATE CONVERSION & UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/// Scale only the translation column of a matrix (rows 0-2 of column 3).
fn scale_translation(mut m: Matrix4<f64>, scale: f64) -> Matrix4<f64> {
    if scale != 1.0 {
        m[(0, 3)] *= scale;
        m[(1, 3)] *= scale;
        m[(2, 3)] *= scale;
    }
    m
}

/// Convert an IFC Z-up Matrix4 to WebGL Y-up column-major [f64; 16].
///
/// Conversion: new_y = old_z, new_z = -old_y (swap Y/Z, negate new Z).
/// Applied row-wise: row 0 stays, row 1 ← row 2, row 2 ← −row 1.
fn convert_ifc_to_webgl(m: &Matrix4<f64>) -> [f64; 16] {
    let mut result = [0.0f64; 16];
    for col in 0..4 {
        result[col * 4] = m[(0, col)]; // X row: unchanged
        result[col * 4 + 1] = m[(2, col)]; // Y row: was Z
        result[col * 4 + 2] = -m[(1, col)]; // Z row: was -Y
        result[col * 4 + 3] = m[(3, col)]; // homogeneous
    }
    result
}
