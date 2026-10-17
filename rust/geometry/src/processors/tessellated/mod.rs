// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tessellated geometry processors - pre-tessellated/polygon meshes.
//!
//! Handles IfcTriangulatedFaceSet (explicit triangle meshes) and
//! IfcPolygonalFaceSet (polygon meshes requiring triangulation).
//!
//! Both read indices through `indices` (one CoordIndex/`PnIndex` rule) and
//! orient through [`orients_outward`] (one `Closed` policy), #7689.

mod indices;
mod mesh_build;
mod polygonal;
mod triangulate;
mod triangulated;

#[cfg(test)]
#[path = "indices_tests.rs"]
mod indices_tests;

pub use polygonal::PolygonalFaceSetProcessor;
pub use triangulated::TriangulatedFaceSetProcessor;

use crate::{Error, Result};
use ifc_lite_core::{
    extract_coordinate_list_from_entity, extract_coordinate_list_from_entity_f64, AttributeValue,
    EntityDecoder,
};

/// The one `Closed` policy for both tessellated face sets: orient the shell
/// outward here only when `Closed` is `.T.`.
///
/// `.T.` asserts a closed shell (IFC4.3 informal proposition: every edge used
/// by exactly two faces), so the centroid test below is meaningful. `$` means
/// "no information can be asserted" and `.F.` an open set: both keep the
/// authored winding. A concave OPEN sheet (a road sag, a ditch, a bowl) reads
/// as inward under the centroid test however gentle it is, so orienting `$`
/// here turned such sheets face-down. A genuinely closed shell written with
/// `$` is still oriented outward, by the topology-aware per-element pass
/// (`orient_mesh_outward_verdict`), which leaves open components alone.
/// IfcOpenShell reorients none of the three. Before #7689 the triangulated
/// processor oriented `$` and the polygonal one did not.
fn orients_outward(closed: Option<&AttributeValue>) -> bool {
    closed.and_then(AttributeValue::as_enum) == Some("T")
}

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
        // The f32 fast reader already admits only finite values; the RTC
        // branch narrows after subtracting, so only it needs the check.
        let narrowed = rtc_file_units.is_some();
        let positions = match rtc_file_units {
            None => extract_coordinate_list_from_entity(raw_bytes),
            Some(rtc) => {
                let offset = [rtc.0, rtc.1, rtc.2];
                extract_coordinate_list_from_entity_f64(raw_bytes).map(|values| {
                    values
                        .iter()
                        .enumerate()
                        .map(|(i, value)| (value - offset[i % 3]) as f32)
                        .collect()
                })
            }
        };
        return admit_point_list(decoder, coord_entity_id, positions, narrowed);
    }

    let coords_entity = decoder.decode_by_id(coord_entity_id)?;
    let coord_list = coords_entity
        .get(0)
        .ok_or_else(|| Error::geometry("CartesianPointList3D missing CoordList".to_string()))?
        .as_list()
        .ok_or_else(|| Error::geometry("Expected coordinate list".to_string()))?;
    let positions = match rtc_file_units {
        None => AttributeValue::parse_coordinate_list_3d(coord_list),
        Some(rtc) => AttributeValue::parse_coordinate_list_3d_f64(coord_list)
            .into_iter()
            .flat_map(|(x, y, z)| [(x - rtc.0) as f32, (y - rtc.1) as f32, (z - rtc.2) as f32])
            .collect(),
    };
    admit_point_list(decoder, coord_entity_id, Some(positions), true)
}

/// Input admission for a point list (#7678): one outcome with and without
/// RTC. A list the fast reader refused (`None`), or one with a value that
/// narrowed to an `f32` infinity (`1.E39`, or an f64 value past `f32::MAX`
/// once the RTC offset is subtracted), is refused and counted when an
/// unrepresentable real is the reason. A genuinely corrupt list is still
/// read as empty, as before.
fn admit_point_list(
    decoder: &mut EntityDecoder,
    id: u32,
    positions: Option<Vec<f32>>,
    narrowed: bool,
) -> Result<Vec<f32>> {
    match positions {
        Some(positions) if !narrowed || positions.iter().all(|v| v.is_finite()) => Ok(positions),
        Some(_) => Err(decoder.refuse_record(id).into()),
        None => match decoder.decode_by_id(id) {
            // A strict decoder has already counted this refusal.
            Err(refused @ ifc_lite_core::Error::UnrepresentableReal(_)) => Err(refused.into()),
            Err(_) => Ok(Vec::new()),
            Ok(list) => {
                let rows = list.get(0).and_then(AttributeValue::as_list).unwrap_or_default();
                let narrows_to_inf = AttributeValue::parse_coordinate_list_3d_f64(rows)
                    .iter()
                    .any(|&(x, y, z)| [x, y, z].iter().any(|v| !(*v as f32).is_finite()));
                if narrows_to_inf { Err(decoder.refuse_record(id).into()) } else { Ok(Vec::new()) }
            }
        },
    }
}
