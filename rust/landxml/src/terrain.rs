/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use crate::terrain_validation::{validate_split_elevations, SplitElevationValidationError};
use crate::{
    xml::error, LandXmlCancellation, LandXmlCanonicalVertex, LandXmlDiagnosticCode as Code,
    LandXmlError, LandXmlLimits, LandXmlPoint, LandXmlPolyline, LandXmlSourceId,
    LandXmlSurfaceKind, LandXmlTerrainDiagnostic, LandXmlTerrainDiagnosticCode as TerrainCode,
};
use ifc_lite_geometry::{triangulate_terrain_pslg_with_progress, TerrainCdtError};
use std::collections::{BTreeMap, BTreeSet};
struct Vertex {
    id: String,
    northing: f64,
    easting: f64,
    elevation: f64,
    contributors: Vec<LandXmlSourceId>,
}
struct CandidateVertex {
    northing: f64,
    easting: f64,
    elevation: f64,
    id: String,
    source_id: LandXmlSourceId,
}

fn diagnostic(code: TerrainCode, message: impl Into<String>) -> LandXmlTerrainDiagnostic {
    LandXmlTerrainDiagnostic {
        code,
        message: message.into(),
    }
}

fn bits(value: f64) -> u64 {
    if value == 0.0 {
        0
    } else {
        value.to_bits()
    }
}

fn add_vertex(
    vertices: &mut Vec<Vertex>,
    locations: &mut BTreeMap<(u64, u64), (usize, f64)>,
    surface: &mut super::parser::state::SurfaceBuilder,
    candidate: CandidateVertex,
    retain_point: bool,
) -> Result<usize, LandXmlTerrainDiagnostic> {
    let key = (bits(candidate.northing), bits(candidate.easting));
    if let Some(&(index, known_elevation)) = locations.get(&key) {
        if known_elevation != candidate.elevation {
            return Err(diagnostic(
                TerrainCode::ConflictingElevation,
                "coincident terrain vertices have conflicting elevations",
            ));
        }
        vertices[index]
            .contributors
            .push(candidate.source_id.clone());
        if retain_point {
            surface.points.push(LandXmlPoint {
                source_id: candidate.source_id,
                id: candidate.id,
                northing: candidate.northing,
                easting: candidate.easting,
                elevation: candidate.elevation,
            });
        }
        return Ok(index);
    }
    let index = vertices.len();
    locations.insert(key, (index, candidate.elevation));
    vertices.push(Vertex {
        id: candidate.id.clone(),
        northing: candidate.northing,
        easting: candidate.easting,
        elevation: candidate.elevation,
        contributors: vec![candidate.source_id.clone()],
    });
    surface.ids.insert(candidate.id.clone());
    if retain_point {
        surface.points.push(LandXmlPoint {
            source_id: candidate.source_id,
            id: candidate.id,
            northing: candidate.northing,
            easting: candidate.easting,
            elevation: candidate.elevation,
        });
    }
    Ok(index)
}

fn line_vertices(
    line: &LandXmlPolyline,
    vertices: &mut Vec<Vertex>,
    locations: &mut BTreeMap<(u64, u64), (usize, f64)>,
    surface: &mut super::parser::state::SurfaceBuilder,
) -> Result<Vec<usize>, LandXmlTerrainDiagnostic> {
    if line.coordinate_dimension != 3 {
        return Err(diagnostic(
            TerrainCode::MissingElevation,
            "constrained terrain requires PntList3D boundary and breakline elevations",
        ));
    }
    let mut indexes = Vec::with_capacity(line.points.len());
    for (ordinal, values) in line.points.iter().enumerate() {
        let Some((&northing, rest)) = values.split_first() else {
            unreachable!()
        };
        let Some((&easting, rest)) = rest.split_first() else {
            unreachable!()
        };
        let Some(&elevation) = rest.first() else {
            unreachable!()
        };
        let id = format!("terrain:{}:{}", line.source_id.0, ordinal + 1);
        indexes.push(add_vertex(
            vertices,
            locations,
            surface,
            CandidateVertex {
                northing,
                easting,
                elevation,
                id,
                source_id: line.point_source_ids[ordinal].clone(),
            },
            true,
        )?);
    }
    Ok(indexes)
}

fn ring_edges(
    ring: &[usize],
    segments: &mut Vec<(usize, usize)>,
) -> Result<(), LandXmlTerrainDiagnostic> {
    let mut ring = ring.to_vec();
    if ring.first() == ring.last() {
        ring.pop();
    }
    if ring.len() < 3 || ring.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(diagnostic(
            TerrainCode::DegenerateConstraints,
            "boundary is degenerate",
        ));
    }
    if ring.iter().copied().collect::<BTreeSet<_>>().len() != ring.len() {
        return Err(diagnostic(TerrainCode::DegenerateConstraints, "boundary repeats a nonconsecutive vertex"));
    }
    for index in 0..ring.len() {
        segments.push((ring[index], ring[(index + 1) % ring.len()]));
    }
    Ok(())
}

fn point_in_ring(point: [f64; 2], ring: &[usize], vertices: &[Vertex]) -> bool {
    let mut inside = false;
    for index in 0..ring.len() {
        let a = &vertices[ring[index]];
        let b = &vertices[ring[(index + 1) % ring.len()]];
        let crosses = (a.northing > point[1]) != (b.northing > point[1]);
        if crosses
            && point[0]
                < (b.easting - a.easting) * (point[1] - a.northing) / (b.northing - a.northing)
                    + a.easting
        {
            inside = !inside;
        }
    }
    inside
}

/// Refuse a known-unaffordable quadratic scan before entering it. The scan
/// itself still charges/polls every comparison: this only avoids spending a
/// whole cancellation quantum proving a limit we can calculate up front.
fn terrain_work_fits(limits: &LandXmlLimits, work_seen: usize, work: usize) -> bool {
    work_seen
        .checked_add(work)
        .and_then(|value| value.checked_add(64))
        .is_some_and(|value| value < limits.max_work)
}

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
    let mut locations = BTreeMap::new();
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
    let mut segments = Vec::new();
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
        if let Err(value) = ring_edges(&ring, &mut segments) {
            return Ok(Some(value));
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
        if line.windows(2).any(|pair| pair[0] == pair[1]) {
            return Ok(Some(diagnostic(
                TerrainCode::DegenerateConstraints,
                "breakline is degenerate",
            )));
        }
        segments.extend(line.windows(2).map(|pair| (pair[0], pair[1])));
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
    let terrain_preprocessing_work = segments
        .len()
        .checked_mul(vertices.len())
        .and_then(|work| vertices.len().checked_mul(2).and_then(|linear| work.checked_add(linear)));
    if terrain_preprocessing_work
        .is_none_or(|work| !terrain_work_fits(limits, *work_seen, work))
    {
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
        Err(TerrainCdtError::WorkLimitExceeded) => return Ok(Some(diagnostic(
            TerrainCode::WorkLimitExceeded,
            "terrain constraint work limit exceeded",
        ))),
        Err(TerrainCdtError::Cancelled) => return Err(error(
            Code::Cancelled,
            "LandXML terrain triangulation cancelled",
        )),
    };
    let mut generated_faces = Vec::new();
    for triangle in mesh.indices.chunks_exact(3) {
        match charge_work() {
            Ok(()) => {}
            Err(TerrainCdtError::WorkLimitExceeded) => return Ok(Some(diagnostic(TerrainCode::WorkLimitExceeded, "terrain constraint work limit exceeded"))),
            Err(TerrainCdtError::Cancelled) => return Err(error(Code::Cancelled, "LandXML terrain triangulation cancelled")),
            Err(_) => unreachable!("terrain work callback only charges or stops"),
        }
        let [a, b, c] = [triangle[0], triangle[1], triangle[2]];
        let centroid = [
            (points[a][0] + points[b][0] + points[c][0]) / 3.0,
            (points[a][1] + points[b][1] + points[c][1]) / 3.0,
        ];
        if !outer
            .iter()
            .any(|ring| point_in_ring(centroid, ring, &vertices))
            || holes
                .iter()
                .any(|ring| point_in_ring(centroid, ring, &vertices))
        {
            continue;
        }
        let next_faces = generated_faces.len() + 1;
        if faces_seen.checked_add(next_faces).is_none_or(|faces| faces > limits.max_faces)
            || references_seen.checked_add(next_faces.saturating_mul(3)).is_none_or(|references| references > limits.max_references) {
            return Err(error(Code::LimitExceeded, "generated face or reference limit exceeded"));
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
    surface.canonical_vertices = vertices
        .into_iter()
        .map(|vertex| LandXmlCanonicalVertex {
            id: vertex.id,
            northing: vertex.northing,
            easting: vertex.easting,
            elevation: vertex.elevation,
            contributor_source_ids: vertex.contributors,
        })
        .collect();
    Ok(None)
}
