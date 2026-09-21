/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

#[path = "terrain_topology.rs"]
mod terrain_topology;
#[path = "terrain_filter.rs"]
mod terrain_filter;

use self::terrain_filter::point_is_in_permitted_region;
use self::terrain_topology::{
    add_vertex, canonical_vertices, line_vertices, ring_edges, terrain_work_fits,
    CandidateVertex, TopologyValidationError,
};
use crate::terrain_validation::{validate_split_elevations, SplitElevationValidationError};
use crate::{
    xml::error, LandXmlCancellation, LandXmlDiagnosticCode as Code, LandXmlError, LandXmlLimits,
    LandXmlSurfaceKind, LandXmlTerrainDiagnostic, LandXmlTerrainDiagnosticCode as TerrainCode,
};
use ifc_lite_geometry::{triangulate_terrain_pslg_with_progress, TerrainCdtError};

fn diagnostic(code: TerrainCode, message: impl Into<String>) -> LandXmlTerrainDiagnostic { LandXmlTerrainDiagnostic { code, message: message.into() } }

/// Add generated faces only when every source rule can be proven as a PSLG.
pub(super) fn adapt_faceless_tin(
    surface: &mut super::parser::state::SurfaceBuilder,
    limits: &LandXmlLimits,
    cancelled: Option<&dyn LandXmlCancellation>,
    faces_seen: &mut usize,
    references_seen: &mut usize,
    work_seen: &mut usize,
) -> Result<Option<LandXmlTerrainDiagnostic>, LandXmlError> {
    if surface.kind != LandXmlSurfaceKind::Tin || !surface.faces.is_empty() {
        return Ok(None);
    }
    let mut vertices = Vec::new();
    let mut locations = std::collections::BTreeMap::new();
    for point in surface.points.clone() {
        if let Err(value) = add_vertex(
            &mut vertices,
            &mut locations,
            surface,
            CandidateVertex {
                northing: point.northing,
                easting: point.easting,
                elevation: point.elevation,
                id: point.id,
                source_id: point.source_id,
            },
            false,
        ) {
            return Ok(Some(value));
        }
    }
    for point in surface.source_data_points.clone() {
        if point.coordinate_dimension == 3 {
            if let Err(value) = add_vertex(
                &mut vertices,
                &mut locations,
                surface,
                CandidateVertex {
                    northing: point.coordinates[0],
                    easting: point.coordinates[1],
                    elevation: point.coordinates[2],
                    id: format!("terrain:{}", point.source_id.0),
                    source_id: point.source_id,
                },
                true,
            ) {
                return Ok(Some(value));
            }
        }
    }
    let mut outer = Vec::new();
    let mut holes = Vec::new();
    let mut breaklines = Vec::new();
    for line in surface.boundaries.clone() {
        if cancelled.is_some_and(LandXmlCancellation::is_cancelled) {
            return Err(error(
                Code::Cancelled,
                "LandXML terrain triangulation cancelled",
            ));
        }
        let ring = match line_vertices(&line, &mut vertices, &mut locations, surface) {
            Ok(ring) => ring,
            Err(value) => return Ok(Some(value)),
        };
        match line.kind.as_deref().map(str::to_ascii_lowercase).as_deref() {
            Some("outer") => outer.push(ring.clone()),
            Some("hole") | Some("inner") => holes.push(ring.clone()),
            _ => {
                return Ok(Some(diagnostic(
                    TerrainCode::UnsupportedBoundarySemantics,
                    "boundary bndType must explicitly be outer, hole, or inner",
                )))
            }
        }
    }
    if outer.is_empty() {
        return Ok(Some(diagnostic(
            TerrainCode::MissingOuterBoundary,
            "faceless TIN has no explicit outer boundary",
        )));
    }
    for line in surface.breaklines.clone() {
        if cancelled.is_some_and(LandXmlCancellation::is_cancelled) {
            return Err(error(
                Code::Cancelled,
                "LandXML terrain triangulation cancelled",
            ));
        }
        if !matches!(
            line.kind.as_deref().map(str::to_ascii_lowercase).as_deref(),
            None | Some("standard")
        ) {
            return Ok(Some(diagnostic(
                TerrainCode::UnsupportedBreaklineSemantics,
                "only standard breaklines have supported constrained semantics",
            )));
        }
        let line = match line_vertices(&line, &mut vertices, &mut locations, surface) {
            Ok(line) => line,
            Err(value) => return Ok(Some(value)),
        };
        breaklines.push(line);
    }
    // This is segment × vertex, before the CDT's own progress callback can
    // run. Include the two linear coordinate buffers too, then reject an
    // impossible budget now; otherwise validate with the same callback so
    // each comparison remains cancellable and charged.
    if cancelled.is_some_and(LandXmlCancellation::is_cancelled) {
        return Err(error(
            Code::Cancelled,
            "LandXML terrain triangulation cancelled",
        ));
    }
    // Ring simplicity is quadratic too.  Preflight it before entering the
    // pairwise exact-predicate walk, then charge each actual comparison below.
    // This keeps a large self-touching boundary cancellable and bounded just
    // like the segment × vertex elevation validation that follows it.
    let mut boundary_segments = 0usize;
    let mut ring_validation_work = 0usize;
    for ring in outer.iter().chain(&holes) {
        let ring_len = if ring.len() > 1 && ring.first() == ring.last() {
            ring.len() - 1
        } else {
            ring.len()
        };
        let pair_checks = ring_len
            .checked_mul(ring_len.saturating_sub(1))
            .map(|value| value / 2);
        boundary_segments = boundary_segments.saturating_add(ring_len);
        ring_validation_work = pair_checks
            .and_then(|pairs| {
                ring_len
                    .checked_mul(2)
                    .and_then(|linear| pairs.checked_add(linear))
            })
            .and_then(|work| ring_validation_work.checked_add(work))
            .unwrap_or(usize::MAX);
    }
    let breakline_segments = breaklines.iter().try_fold(0usize, |count, line| {
        count.checked_add(line.len().saturating_sub(1))
    });
    let segment_count = breakline_segments.and_then(|count| count.checked_add(boundary_segments));
    let terrain_preprocessing_work = segment_count
        .and_then(|count| count.checked_mul(vertices.len()))
        .and_then(|work| {
            vertices
                .len()
                .checked_mul(2)
                .and_then(|linear| work.checked_add(linear))
        })
        .and_then(|work| work.checked_add(ring_validation_work));
    if terrain_preprocessing_work.is_none_or(|work| !terrain_work_fits(limits, *work_seen, work)) {
        return Ok(Some(diagnostic(
            TerrainCode::WorkLimitExceeded,
            "terrain constraint work limit exceeded",
        )));
    }
    let mut charge_work = || -> Result<(), TerrainCdtError> {
        if cancelled.is_some_and(LandXmlCancellation::is_cancelled) {
            return Err(TerrainCdtError::Cancelled);
        }
        // Preserve close-tag capacity after an optional terrain refusal.
        if work_seen.saturating_add(64) >= limits.max_work {
            return Err(TerrainCdtError::WorkLimitExceeded);
        }
        *work_seen += 1;
        Ok(())
    };
    let mut segments = Vec::with_capacity(segment_count.unwrap_or(0));
    for ring in outer.iter().chain(&holes) {
        match ring_edges(ring, &vertices, &mut segments, &mut charge_work) {
            Ok(()) => {}
            Err(TopologyValidationError::Diagnostic(value)) => return Ok(Some(value)),
            Err(TopologyValidationError::Progress(TerrainCdtError::WorkLimitExceeded)) => {
                return Ok(Some(diagnostic(
                    TerrainCode::WorkLimitExceeded,
                    "terrain constraint work limit exceeded",
                )))
            }
            Err(TopologyValidationError::Progress(TerrainCdtError::Cancelled)) => {
                return Err(error(
                    Code::Cancelled,
                    "LandXML terrain triangulation cancelled",
                ))
            }
            Err(TopologyValidationError::Progress(_)) => {
                unreachable!("terrain work callback only charges or stops")
            }
        }
    }
    for line in &breaklines {
        for pair in line.windows(2) {
            match charge_work() {
                Ok(()) => {}
                Err(TerrainCdtError::WorkLimitExceeded) => {
                    return Ok(Some(diagnostic(
                        TerrainCode::WorkLimitExceeded,
                        "terrain constraint work limit exceeded",
                    )))
                }
                Err(TerrainCdtError::Cancelled) => {
                    return Err(error(
                        Code::Cancelled,
                        "LandXML terrain triangulation cancelled",
                    ))
                }
                Err(_) => unreachable!("terrain work callback only charges or stops"),
            }
            if pair[0] == pair[1] {
                return Ok(Some(diagnostic(
                    TerrainCode::DegenerateConstraints,
                    "breakline is degenerate",
                )));
            }
            segments.push((pair[0], pair[1]));
        }
    }
    let mut vertex_elevations = Vec::with_capacity(vertices.len());
    for vertex in &vertices {
        match charge_work() {
            Ok(()) => vertex_elevations.push((vertex.northing, vertex.easting, vertex.elevation)),
            Err(TerrainCdtError::WorkLimitExceeded) => {
                return Ok(Some(diagnostic(
                    TerrainCode::WorkLimitExceeded,
                    "terrain constraint work limit exceeded",
                )))
            }
            Err(TerrainCdtError::Cancelled) => {
                return Err(error(
                    Code::Cancelled,
                    "LandXML terrain triangulation cancelled",
                ))
            }
            Err(_) => unreachable!("terrain work callback only charges or stops"),
        }
    }
    if let Err(value) = validate_split_elevations(&vertex_elevations, &segments, &mut charge_work) {
        match value {
            SplitElevationValidationError::Diagnostic(value) => return Ok(Some(value)),
            SplitElevationValidationError::Progress(TerrainCdtError::WorkLimitExceeded) => {
                return Ok(Some(diagnostic(
                    TerrainCode::WorkLimitExceeded,
                    "terrain constraint work limit exceeded",
                )))
            }
            SplitElevationValidationError::Progress(TerrainCdtError::Cancelled) => {
                return Err(error(
                    Code::Cancelled,
                    "LandXML terrain triangulation cancelled",
                ))
            }
            SplitElevationValidationError::Progress(_) => {
                unreachable!("terrain work callback only charges or stops")
            }
        }
    }
    let mut points = Vec::with_capacity(vertices.len());
    for point in &vertices {
        match charge_work() {
            Ok(()) => points.push([point.easting, point.northing]),
            Err(TerrainCdtError::WorkLimitExceeded) => {
                return Ok(Some(diagnostic(
                    TerrainCode::WorkLimitExceeded,
                    "terrain constraint work limit exceeded",
                )))
            }
            Err(TerrainCdtError::Cancelled) => {
                return Err(error(
                    Code::Cancelled,
                    "LandXML terrain triangulation cancelled",
                ))
            }
            Err(_) => unreachable!("terrain work callback only charges or stops"),
        }
    }
    let mesh = match triangulate_terrain_pslg_with_progress(&points, &segments, &mut charge_work) {
        Ok(mesh) => mesh,
        Err(TerrainCdtError::IntersectingConstraints) => {
            return Ok(Some(diagnostic(
                TerrainCode::IntersectingConstraints,
                "terrain constraints intersect or overlap",
            )))
        }
        Err(TerrainCdtError::InvalidInput | TerrainCdtError::ConstraintsUnrecoverable) => {
            return Ok(Some(diagnostic(
                TerrainCode::DegenerateConstraints,
                "terrain constraints cannot form a valid constrained triangulation",
            )))
        }
        Err(TerrainCdtError::WorkLimitExceeded) => {
            return Ok(Some(diagnostic(
                TerrainCode::WorkLimitExceeded,
                "terrain constraint work limit exceeded",
            )))
        }
        Err(TerrainCdtError::Cancelled) => {
            return Err(error(
                Code::Cancelled,
                "LandXML terrain triangulation cancelled",
            ))
        }
    };
    let mut generated_faces = Vec::new();
    for triangle in mesh.indices.chunks_exact(3) {
        match charge_work() {
            Ok(()) => {}
            Err(TerrainCdtError::WorkLimitExceeded) => {
                return Ok(Some(diagnostic(
                    TerrainCode::WorkLimitExceeded,
                    "terrain constraint work limit exceeded",
                )))
            }
            Err(TerrainCdtError::Cancelled) => {
                return Err(error(
                    Code::Cancelled,
                    "LandXML terrain triangulation cancelled",
                ))
            }
            Err(_) => unreachable!("terrain work callback only charges or stops"),
        }
        let [a, b, c] = [triangle[0], triangle[1], triangle[2]];
        let centroid = [
            (points[a][0] + points[b][0] + points[c][0]) / 3.0,
            (points[a][1] + points[b][1] + points[c][1]) / 3.0,
        ];
        match point_is_in_permitted_region(centroid, &outer, &holes, &vertices, &mut charge_work) {
            Ok(true) => {}
            Ok(false) => continue,
            Err(TerrainCdtError::WorkLimitExceeded) => {
                return Ok(Some(diagnostic(
                    TerrainCode::WorkLimitExceeded,
                    "terrain constraint work limit exceeded",
                )))
            }
            Err(TerrainCdtError::Cancelled) => {
                return Err(error(
                    Code::Cancelled,
                    "LandXML terrain triangulation cancelled",
                ))
            }
            Err(_) => unreachable!("terrain work callback only charges or stops"),
        }
        let next_faces = generated_faces.len() + 1;
        if faces_seen
            .checked_add(next_faces)
            .is_none_or(|faces| faces > limits.max_faces)
            || references_seen
                .checked_add(next_faces.saturating_mul(3))
                .is_none_or(|references| references > limits.max_references)
        {
            return Ok(Some(diagnostic(
                TerrainCode::WorkLimitExceeded,
                "generated face or reference limit exceeded",
            )));
        }
        generated_faces.push([
            vertices[a].id.clone(),
            vertices[b].id.clone(),
            vertices[c].id.clone(),
        ]);
    }
    if generated_faces.is_empty() {
        return Ok(Some(diagnostic(
            TerrainCode::DegenerateConstraints,
            "constraints enclose no terrain area",
        )));
    }
    let generated_references = generated_faces.len().saturating_mul(3);
    *faces_seen += generated_faces.len();
    *references_seen += generated_references;
    surface
        .face_visibility
        .extend(std::iter::repeat_n(true, generated_faces.len()));
    surface.faces.extend(generated_faces);
    surface.canonical_vertices = canonical_vertices(vertices);
    Ok(None)
}
