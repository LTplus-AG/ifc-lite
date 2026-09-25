// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tessellated geometry processors - pre-tessellated/polygon meshes.
//!
//! Handles IfcTriangulatedFaceSet (explicit triangle meshes) and
//! IfcPolygonalFaceSet (polygon meshes requiring triangulation).

mod mesh_build;
mod polygonal;
mod triangulate;
mod triangulated;

pub use polygonal::PolygonalFaceSetProcessor;
pub use triangulated::TriangulatedFaceSetProcessor;

use crate::{Error, Result};
use ifc_lite_core::{
    extract_coordinate_list_from_entity, extract_coordinate_list_from_entity_f64, AttributeValue,
    EntityDecoder,
};

/// Read an `IfcCartesianPointList3D` as flat `[x, y, z, ...]` f32 positions.
///
/// With `rtc_file_units`, coordinates are read as f64 and the offset is
/// subtracted BEFORE narrowing: at national-grid magnitude one f32 ULP is
/// 0.25 m (metres) or 256 mm (millimetres), so narrowing first merges
/// distinct vertices that no later subtraction can separate again (#5698).
/// Without it, the historical single-rounding f32 parse is kept.
fn read_point_list(
    decoder: &mut EntityDecoder,
    coord_entity_id: u32,
    rtc_file_units: Option<(f64, f64, f64)>,
) -> Result<Vec<f32>> {
    // FAST PATH: parse the raw bytes directly (no Token/AttributeValue).
    if let Some(raw_bytes) = decoder.get_raw_bytes(coord_entity_id) {
        return Ok(match rtc_file_units {
            None => extract_coordinate_list_from_entity(raw_bytes).unwrap_or_default(),
            Some(rtc) => {
                let offset = [rtc.0, rtc.1, rtc.2];
                extract_coordinate_list_from_entity_f64(raw_bytes)
                    .unwrap_or_default()
                    .iter()
                    .enumerate()
                    .map(|(i, value)| (value - offset[i % 3]) as f32)
                    .collect()
            }
        });
    }

    let coords_entity = decoder.decode_by_id(coord_entity_id)?;
    let coord_list = coords_entity
        .get(0)
        .ok_or_else(|| Error::geometry("CartesianPointList3D missing CoordList".to_string()))?
        .as_list()
        .ok_or_else(|| Error::geometry("Expected coordinate list".to_string()))?;
    Ok(match rtc_file_units {
        None => AttributeValue::parse_coordinate_list_3d(coord_list),
        Some(rtc) => AttributeValue::parse_coordinate_list_3d_f64(coord_list)
            .into_iter()
            .flat_map(|(x, y, z)| [(x - rtc.0) as f32, (y - rtc.1) as f32, (z - rtc.2) as f32])
            .collect(),
    })
}
