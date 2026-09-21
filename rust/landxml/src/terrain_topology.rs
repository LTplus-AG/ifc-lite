/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use crate::{
    LandXmlCanonicalVertex, LandXmlLimits, LandXmlPoint, LandXmlPolyline, LandXmlSourceId,
    LandXmlTerrainDiagnostic, LandXmlTerrainDiagnosticCode as TerrainCode,
};
use std::collections::{BTreeMap, BTreeSet};

pub(super) struct Vertex {
    pub(super) id: String,
    pub(super) northing: f64,
    pub(super) easting: f64,
    pub(super) elevation: f64,
    pub(super) contributors: Vec<LandXmlSourceId>,
}

pub(super) struct CandidateVertex {
    pub(super) northing: f64,
    pub(super) easting: f64,
    pub(super) elevation: f64,
    pub(super) id: String,
    pub(super) source_id: LandXmlSourceId,
}

fn diagnostic(code: TerrainCode, message: impl Into<String>) -> LandXmlTerrainDiagnostic {
    LandXmlTerrainDiagnostic { code, message: message.into() }
}

fn bits(value: f64) -> u64 {
    if value == 0.0 { 0 } else { value.to_bits() }
}

pub(super) fn add_vertex(
    vertices: &mut Vec<Vertex>,
    locations: &mut BTreeMap<(u64, u64), (usize, f64)>,
    surface: &mut crate::parser::state::SurfaceBuilder,
    candidate: CandidateVertex,
    retain_point: bool,
) -> Result<usize, LandXmlTerrainDiagnostic> {
    let key = (bits(candidate.northing), bits(candidate.easting));
    if let Some(&(index, known_elevation)) = locations.get(&key) {
        if known_elevation != candidate.elevation {
            return Err(diagnostic(TerrainCode::ConflictingElevation, "coincident terrain vertices have conflicting elevations"));
        }
        vertices[index].contributors.push(candidate.source_id.clone());
        if retain_point {
            surface.points.push(LandXmlPoint { source_id: candidate.source_id, id: candidate.id, northing: candidate.northing, easting: candidate.easting, elevation: candidate.elevation });
        }
        return Ok(index);
    }
    let index = vertices.len();
    locations.insert(key, (index, candidate.elevation));
    vertices.push(Vertex { id: candidate.id.clone(), northing: candidate.northing, easting: candidate.easting, elevation: candidate.elevation, contributors: vec![candidate.source_id.clone()] });
    surface.ids.insert(candidate.id.clone());
    if retain_point {
        surface.points.push(LandXmlPoint { source_id: candidate.source_id, id: candidate.id, northing: candidate.northing, easting: candidate.easting, elevation: candidate.elevation });
    }
    Ok(index)
}

pub(super) fn line_vertices(
    line: &LandXmlPolyline,
    vertices: &mut Vec<Vertex>,
    locations: &mut BTreeMap<(u64, u64), (usize, f64)>,
    surface: &mut crate::parser::state::SurfaceBuilder,
) -> Result<Vec<usize>, LandXmlTerrainDiagnostic> {
    if line.coordinate_dimension != 3 {
        return Err(diagnostic(TerrainCode::MissingElevation, "constrained terrain requires PntList3D boundary and breakline elevations"));
    }
    let mut indexes = Vec::with_capacity(line.points.len());
    for (ordinal, values) in line.points.iter().enumerate() {
        let Some((&northing, rest)) = values.split_first() else { unreachable!() };
        let Some((&easting, rest)) = rest.split_first() else { unreachable!() };
        let Some(&elevation) = rest.first() else { unreachable!() };
        indexes.push(add_vertex(vertices, locations, surface, CandidateVertex {
            northing, easting, elevation, id: format!("terrain:{}:{}", line.source_id.0, ordinal + 1), source_id: line.point_source_ids[ordinal].clone(),
        }, true)?);
    }
    Ok(indexes)
}

fn orient(a: &Vertex, b: &Vertex, c: &Vertex) -> i32 {
    let value = geometry_predicates::orient2d([a.easting, a.northing], [b.easting, b.northing], [c.easting, c.northing]);
    if value > 0.0 { 1 } else if value < 0.0 { -1 } else { 0 }
}

fn on_segment(a: &Vertex, b: &Vertex, point: &Vertex) -> bool {
    orient(a, b, point) == 0
        && point.easting >= a.easting.min(b.easting)
        && point.easting <= a.easting.max(b.easting)
        && point.northing >= a.northing.min(b.northing)
        && point.northing <= a.northing.max(b.northing)
}

fn edges_touch(a: &Vertex, b: &Vertex, c: &Vertex, d: &Vertex) -> bool {
    let ab_c = orient(a, b, c);
    let ab_d = orient(a, b, d);
    let cd_a = orient(c, d, a);
    let cd_b = orient(c, d, b);
    (ab_c != ab_d && ab_c != 0 && ab_d != 0 && cd_a != cd_b && cd_a != 0 && cd_b != 0)
        || ab_c == 0 && on_segment(a, b, c)
        || ab_d == 0 && on_segment(a, b, d)
        || cd_a == 0 && on_segment(c, d, a)
        || cd_b == 0 && on_segment(c, d, b)
}

/// Boundary rings are simple polygons, not general PSLGs: unlike breaklines,
/// an edge may not acquire a non-adjacent vertex contact.
fn validate_simple_ring(ring: &[usize], vertices: &[Vertex]) -> Result<(), LandXmlTerrainDiagnostic> {
    for left in 0..ring.len() {
        let next = (left + 1) % ring.len();
        for right in 0..left {
            let right_next = (right + 1) % ring.len();
            if left == right || left == right_next || next == right || next == right_next {
                continue;
            }
            let a = &vertices[ring[left]];
            let b = &vertices[ring[next]];
            let c = &vertices[ring[right]];
            let d = &vertices[ring[right_next]];
            if edges_touch(a, b, c, d) {
                let proper = orient(a, b, c) != orient(a, b, d)
                    && orient(a, b, c) != 0
                    && orient(a, b, d) != 0
                    && orient(c, d, a) != orient(c, d, b)
                    && orient(c, d, a) != 0
                    && orient(c, d, b) != 0;
                return Err(diagnostic(
                    if proper { TerrainCode::IntersectingConstraints } else { TerrainCode::DegenerateConstraints },
                    if proper { "boundary edges intersect" } else { "boundary is not a simple ring" },
                ));
            }
        }
    }
    Ok(())
}

pub(super) fn ring_edges(ring: &[usize], vertices: &[Vertex], segments: &mut Vec<(usize, usize)>) -> Result<(), LandXmlTerrainDiagnostic> {
    let mut ring = ring.to_vec();
    if ring.first() == ring.last() { ring.pop(); }
    if ring.len() < 3 || ring.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(diagnostic(TerrainCode::DegenerateConstraints, "boundary is degenerate"));
    }
    if ring.iter().copied().collect::<BTreeSet<_>>().len() != ring.len() {
        return Err(diagnostic(TerrainCode::DegenerateConstraints, "boundary repeats a nonconsecutive vertex"));
    }
    validate_simple_ring(&ring, vertices)?;
    for index in 0..ring.len() { segments.push((ring[index], ring[(index + 1) % ring.len()])); }
    Ok(())
}

pub(super) fn point_in_ring(point: [f64; 2], ring: &[usize], vertices: &[Vertex]) -> bool {
    let mut inside = false;
    for index in 0..ring.len() {
        let a = &vertices[ring[index]];
        let b = &vertices[ring[(index + 1) % ring.len()]];
        if (a.northing > point[1]) != (b.northing > point[1])
            && point[0] < (b.easting - a.easting) * (point[1] - a.northing) / (b.northing - a.northing) + a.easting {
            inside = !inside;
        }
    }
    inside
}

pub(super) fn terrain_work_fits(limits: &LandXmlLimits, work_seen: usize, work: usize) -> bool {
    work_seen.checked_add(work).and_then(|value| value.checked_add(64)).is_some_and(|value| value < limits.max_work)
}

pub(super) fn canonical_vertices(vertices: Vec<Vertex>) -> Vec<LandXmlCanonicalVertex> {
    vertices.into_iter().map(|vertex| LandXmlCanonicalVertex {
        id: vertex.id, northing: vertex.northing, easting: vertex.easting, elevation: vertex.elevation, contributor_source_ids: vertex.contributors,
    }).collect()
}
