/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use crate::{LandXmlTerrainDiagnostic, LandXmlTerrainDiagnosticCode as TerrainCode};

fn point_on_segment(point: [f64; 2], a: [f64; 2], b: [f64; 2]) -> bool {
    geometry_predicates::orient2d(a, b, point) == 0.0
        && point[0] >= a[0].min(b[0])
        && point[0] <= a[0].max(b[0])
        && point[1] >= a[1].min(b[1])
        && point[1] <= a[1].max(b[1])
}

/// Verify the Z that a collinear split vertex would inherit before topology
/// normalisation changes a producer's constraint graph.
pub(super) fn validate_split_elevations(
    vertices: &[(f64, f64, f64)],
    segments: &[(usize, usize)],
) -> Result<(), LandXmlTerrainDiagnostic> {
    for &(a, b) in segments {
        let (start_northing, start_easting, start_elevation) = vertices[a];
        let (end_northing, end_easting, end_elevation) = vertices[b];
        let start_xy = [start_easting, start_northing];
        let end_xy = [end_easting, end_northing];
        let dx = end_xy[0] - start_xy[0];
        let dy = end_xy[1] - start_xy[1];
        let length_squared = dx * dx + dy * dy;
        for (index, &(northing, easting, elevation)) in vertices.iter().enumerate() {
            if index == a || index == b || !point_on_segment([easting, northing], start_xy, end_xy)
            {
                continue;
            }
            let t = ((easting - start_easting) * dx + (northing - start_northing) * dy)
                / length_squared;
            let expected = start_elevation + (end_elevation - start_elevation) * t;
            if elevation != expected {
                return Err(LandXmlTerrainDiagnostic {
                    code: TerrainCode::ConflictingElevation,
                    message: "a collinear constraint vertex has an elevation inconsistent with its segment".to_owned(),
                });
            }
        }
    }
    Ok(())
}
