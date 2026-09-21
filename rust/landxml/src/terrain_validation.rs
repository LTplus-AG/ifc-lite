/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use crate::{LandXmlTerrainDiagnostic, LandXmlTerrainDiagnosticCode as TerrainCode};
use ifc_lite_geometry::TerrainCdtError;

/// A source-elevation conflict is a retained-data diagnostic; a progress
/// failure is an operational result which must retain its cancellation/work
/// meaning for the terrain adapter.
pub(super) enum SplitElevationValidationError {
    Diagnostic(LandXmlTerrainDiagnostic),
    Progress(TerrainCdtError),
}

fn point_on_segment(point: [f64; 2], a: [f64; 2], b: [f64; 2]) -> bool {
    geometry_predicates::orient2d(a, b, point) == 0.0
        && point[0] >= a[0].min(b[0])
        && point[0] <= a[0].max(b[0])
        && point[1] >= a[1].min(b[1])
        && point[1] <= a[1].max(b[1])
}

/// Affine interpolation entails a multiply and an add, so equality is not a
/// sound comparison even when a producer supplied the mathematically exact
/// elevation. Keep this limited to a handful of rounding units rather than a
/// geometry tolerance: topology remains exact and materially different Z
/// values still produce the retained-data diagnostic.
fn elevations_agree(actual: f64, expected: f64, start: f64, end: f64) -> bool {
    const MAX_AFFINE_ROUNDING_UNITS: f64 = 8.0;
    if !(actual.is_finite() && expected.is_finite() && start.is_finite() && end.is_finite()) {
        return false;
    }
    let scale = actual
        .abs()
        .max(expected.abs())
        .max(start.abs())
        .max(end.abs())
        .max(1.0);
    (actual - expected).abs() <= MAX_AFFINE_ROUNDING_UNITS * f64::EPSILON * scale
}

/// Interpolate without first subtracting endpoint elevations: finite endpoint
/// values of opposite sign can make that difference overflow even though the
/// affine result is finite. The factors form a convex combination because the
/// caller has already established that the vertex is on the closed segment.
fn interpolate_elevation(start: f64, end: f64, t: f64) -> Option<f64> {
    if !t.is_finite() {
        return None;
    }
    let fraction = t.clamp(0.0, 1.0);
    let expected = (1.0 - fraction) * start + fraction * end;
    expected.is_finite().then_some(expected)
}

/// Calculate a segment fraction in scaled coordinates so finite coordinate
/// differences and their squared length cannot overflow before interpolation.
fn segment_fraction(point: [f64; 2], start: [f64; 2], end: [f64; 2]) -> Option<f64> {
    let scale = point[0]
        .abs()
        .max(point[1].abs())
        .max(start[0].abs())
        .max(start[1].abs())
        .max(end[0].abs())
        .max(end[1].abs())
        .max(1.0);
    if !scale.is_finite() {
        return None;
    }
    let dx = end[0] / scale - start[0] / scale;
    let dy = end[1] / scale - start[1] / scale;
    let (numerator, denominator) = if dx.abs() >= dy.abs() {
        (point[0] / scale - start[0] / scale, dx)
    } else {
        (point[1] / scale - start[1] / scale, dy)
    };
    if denominator == 0.0 {
        return None;
    }
    let fraction = numerator / denominator;
    fraction.is_finite().then_some(fraction.clamp(0.0, 1.0))
}

/// Verify the Z that a collinear split vertex would inherit before topology
/// normalisation changes a producer's constraint graph.
pub(super) fn validate_split_elevations(
    vertices: &[(f64, f64, f64)],
    segments: &[(usize, usize)],
    progress: &mut dyn FnMut() -> Result<(), TerrainCdtError>,
) -> Result<(), SplitElevationValidationError> {
    for &(a, b) in segments {
        let (start_northing, start_easting, start_elevation) = vertices[a];
        let (end_northing, end_easting, end_elevation) = vertices[b];
        let start_xy = [start_easting, start_northing];
        let end_xy = [end_easting, end_northing];
        for (index, &(northing, easting, elevation)) in vertices.iter().enumerate() {
            progress().map_err(SplitElevationValidationError::Progress)?;
            if index == a || index == b || !point_on_segment([easting, northing], start_xy, end_xy)
            {
                continue;
            }
            let fraction = segment_fraction([easting, northing], start_xy, end_xy);
            let expected = fraction
                .and_then(|value| interpolate_elevation(start_elevation, end_elevation, value));
            if !expected.is_some_and(|value| {
                elevations_agree(elevation, value, start_elevation, end_elevation)
            }) {
                return Err(SplitElevationValidationError::Diagnostic(LandXmlTerrainDiagnostic {
                    code: TerrainCode::ConflictingElevation,
                    message: "a collinear constraint vertex has an elevation inconsistent with its segment".to_owned(),
                }));
            }
        }
    }
    Ok(())
}
