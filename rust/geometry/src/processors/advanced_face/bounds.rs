// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Canonical face-bound extraction shared by advanced and standalone face surfaces.

use crate::{Error, Point3, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

use super::super::helpers::read_loop_points_by_id;
use super::curves::Refused;
use super::edge_loop::extract_edge_loop_points;
use crate::triangulation::{calculate_polygon_normal, project_to_2d, project_to_2d_with_basis};
use nalgebra::Point2;

pub(super) struct FaceBounds {
    pub(super) outer: Option<Vec<Point3<f64>>>,
    pub(super) holes: Vec<Vec<Point3<f64>>>,
}

// ───────────────────────── face-refusal counter relay ─────────────────────
//
// D3 is "fail closed PLUS a counter". A refused face comes back as an `Err`,
// which the brep and surface-model processors skip per face (#5053) with
// only a debug trace, so without this the refusal was invisible: an element
// could lose faces, or every face, and report nothing. Same shape as
// `bspline_budget::CURVE_CAPPED`: a thread-local flag set where a face is
// refused and drained once per representation item by the router
// (the common item program, `program/item.rs`), which records the REAL face type: an
// `IfcAdvancedFace` / `IfcFaceSurface` for a surface face, an `IfcFace` for a
// faceted brep or surface-model polyloop face, an
// `IfcIndexedPolygonalFaceWithVoids` for a tessellated face. They were all
// counted as `IfcAdvancedFace` (#7787 audit).
thread_local! {
    static FACE_REFUSED: std::cell::RefCell<Vec<IfcType>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Record that a face of type `face_type` was refused (#7687). Once per type
/// per drain, so the count stays one per item and type.
pub(in crate::processors) fn note_face_refused(face_type: &IfcType) {
    FACE_REFUSED.with(|c| {
        let mut types = c.borrow_mut();
        if !types.contains(face_type) {
            types.push(face_type.clone());
        }
    });
}

/// Drain the refused face types since the last drain on this thread (empty
/// when no face was refused). Drained once per top-level item, so it counts
/// items.
pub(crate) fn take_face_refused() -> Vec<IfcType> {
    FACE_REFUSED.with(|c| std::mem::take(&mut *c.borrow_mut()))
}

/// `result`, noting a refusal of `face` when it is an `Err`.
pub(super) fn noting_refusal<T>(face: &DecodedEntity, result: Result<T>) -> Result<T> {
    if result.is_err() {
        note_face_refused(&face.ifc_type);
    }
    result
}

/// Resolve one `Bounds` entry of `face` to `(bound, loop)` entities. A bound
/// that does not resolve refuses the face (#7687, D14).
pub(super) fn resolve_bound_loop(
    face: &DecodedEntity,
    bound: &ifc_lite_core::AttributeValue,
    decoder: &mut EntityDecoder,
) -> Result<(DecodedEntity, DecodedEntity)> {
    noting_refusal(face, resolve_bound_loop_unnoted(face, bound, decoder))
}

fn resolve_bound_loop_unnoted(
    face: &DecodedEntity,
    bound: &ifc_lite_core::AttributeValue,
    decoder: &mut EntityDecoder,
) -> Result<(DecodedEntity, DecodedEntity)> {
    let bound_id = bound.as_entity_ref().ok_or_else(|| {
        Error::geometry(format!("face #{} has a bound that is not a reference (D14)", face.id))
    })?;
    let bound_entity = decoder.decode_by_id(bound_id)?;
    let loop_attr = bound_entity
        .get(0)
        .ok_or_else(|| Error::geometry("FaceBound missing Bound".to_string()))?;
    let loop_entity = decoder
        .resolve_ref(loop_attr)?
        .ok_or_else(|| Error::geometry("Failed to resolve FaceBound loop".to_string()))?;
    Ok((bound_entity, loop_entity))
}

/// Turn a loop that does not read into the face's refusal (#7687, D14,
/// under D3). Dropping an unreadable HOLE rendered the face filled over its
/// opening, and dropping an unreadable outer loop let a hole become the
/// outer boundary; neither is the authored face.
pub(super) fn refuse_unreadable(
    face: &DecodedEntity,
    loop_entity: &DecodedEntity,
    points: std::result::Result<Vec<Point3<f64>>, Refused>,
) -> Result<Vec<Point3<f64>>> {
    points.map_err(|Refused| {
        note_face_refused(&face.ifc_type);
        Error::geometry(format!(
            "face #{} loop #{} does not resolve; refusing the face rather than drop the loop (D14)",
            face.id, loop_entity.id
        ))
    })
}

/// One outer ring and its holes: the last `IfcFaceOuterBound` (earlier ones
/// become holes), else the largest unclassified bound.
fn classify_bounds(bounds: Vec<(bool, Vec<Point3<f64>>)>) -> FaceBounds {
    let mut outer = None;
    let mut holes = Vec::new();
    let mut unclassified = Vec::new();
    for (is_outer, points) in bounds {
        if is_outer {
            if let Some(previous) = outer.take() {
                holes.push(previous);
            }
            outer = Some(points);
        } else {
            unclassified.push(points);
        }
    }
    if outer.is_some() {
        holes.extend(unclassified);
    } else if let Some((outer_index, _)) = unclassified.iter().enumerate().max_by(|a, b| {
        projected_area(a.1)
            .total_cmp(&projected_area(b.1))
            .then_with(|| compare_ring_key(a.1, b.1))
    }) {
        outer = Some(unclassified.swap_remove(outer_index));
        holes.extend(unclassified);
    }
    FaceBounds { outer, holes }
}

/// A face's regions, its bounds read once: when every bound is an
/// `IfcFaceOuterBound` and there are several (AxisVM writes a structural slab
/// as one face of many outer-bound triangles, #9668, #9945), a loop in no other
/// loop is a region and a loop inside another is its opening
/// ([`outer_bound_regions`]); otherwise the one outer ring with its holes.
pub(super) fn face_regions(
    face: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
) -> Result<Vec<FaceBounds>> {
    let bounds = read_bounds(face, decoder, quality)?;
    if bounds.len() > 1 && bounds.iter().all(|(is_outer, _)| *is_outer) {
        let rings: Vec<&Vec<Point3<f64>>> = bounds.iter().map(|(_, points)| points).collect();
        if let Some(regions) = outer_bound_regions(&rings) {
            return Ok(regions);
        }
    }
    Ok(vec![classify_bounds(bounds)])
}

/// Even-odd point-in-polygon in 2D.
fn inside_2d(p: &Point2<f64>, ring: &[Point2<f64>]) -> bool {
    let mut hit = false;
    let mut j = ring.len() - 1;
    for i in 0..ring.len() {
        let (a, b) = (ring[i], ring[j]);
        if (a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
            hit = !hit;
        }
        j = i;
    }
    hit
}

/// Distance from `p` to the nearest edge of `ring`.
fn edge_distance_2d(p: &Point2<f64>, ring: &[Point2<f64>]) -> f64 {
    let mut best = f64::INFINITY;
    let mut j = ring.len() - 1;
    for i in 0..ring.len() {
        let (a, b) = (ring[j], ring[i]);
        let e = b - a;
        let t = (((p.x - a.x) * e.x + (p.y - a.y) * e.y) / (e.norm_squared().max(f64::MIN_POSITIVE))).clamp(0.0, 1.0);
        best = best.min((p - (a + e * t)).norm());
        j = i;
    }
    best
}

/// Whether segments `ab` and `cd` cross at a point interior to both (touching and overlapping do not count).
fn segments_cross(a: &Point2<f64>, b: &Point2<f64>, c: &Point2<f64>, d: &Point2<f64>) -> bool {
    // 0 for a point on the line (`f64::signum` would call 0.0 positive, and a touch is no crossing). The test is
    // the sine of the angle at `p`, so it does not depend on the units: a tiny fixture crosses as surely as a large one.
    let side = |p: &Point2<f64>, q: &Point2<f64>, r: &Point2<f64>| {
        let (e, f) = (q - p, r - p);
        let reach = e.norm() * f.norm();
        let sine = if reach > 0.0 { (e.x * f.y - e.y * f.x) / reach } else { 0.0 };
        if sine > 1e-9 { 1.0 } else if sine < -1e-9 { -1.0 } else { 0.0 }
    };
    let (s1, s2, s3, s4) = (side(a, b, c), side(a, b, d), side(c, d, a), side(c, d, b));
    s1 * s2 < 0.0 && s3 * s4 < 0.0
}

/// Whether every edge of `ring` stays in `outer`: its midpoint is in or on `outer`
/// it crosses no edge of `outer`, and no part of `outer`'s boundary enters `ring` ([`outer_clear_of`]; a chord between
/// two points of a concave loop can leave it, even through two of its vertices exactly).
fn ring_stays_in(ring: &[Point2<f64>], outer: &[Point2<f64>], tolerance: f64) -> bool {
    (0..ring.len()).all(|k| {
        let (p, q) = (ring[k], ring[(k + 1) % ring.len()]);
        let mid = Point2::new((p.x + q.x) / 2.0, (p.y + q.y) / 2.0);
        (inside_2d(&mid, outer) || edge_distance_2d(&mid, outer) <= tolerance)
            && (0..outer.len()).all(|m| !segments_cross(&p, &q, &outer[m], &outer[(m + 1) % outer.len()]))
    }) && outer_clear_of(outer, ring, tolerance)
}

/// Whether no part of `outer`'s boundary enters the interior of `ring`: each outer edge has its endpoint and midpoint
/// outside or on `ring` (a proper crossing is already refused by [`ring_stays_in`], and crossing is symmetric). A ring inside the outer loop cannot contain a piece of it
/// (a vertex, or a thin slit whose ends touch the ring's boundary).
fn outer_clear_of(outer: &[Point2<f64>], ring: &[Point2<f64>], tolerance: f64) -> bool {
    let strictly_inside = |p: &Point2<f64>| inside_2d(p, ring) && edge_distance_2d(p, ring) > tolerance;
    (0..outer.len()).all(|k| {
        let (v, w) = (outer[k], outer[(k + 1) % outer.len()]);
        let mid = Point2::new((v.x + w.x) / 2.0, (v.y + w.y) / 2.0);
        !strictly_inside(&v) && !strictly_inside(&mid)
    })
}

/// A point inside a simple polygon: the midpoint of the first span of a
/// scanline halfway between two vertex heights (even-odd). The first vertex
/// when no span has width, a ring of no area.
fn interior_point_2d(ring: &[Point2<f64>]) -> Point2<f64> {
    let mut heights: Vec<f64> = ring.iter().map(|p| p.y).collect();
    heights.sort_by(f64::total_cmp);
    heights.dedup();
    for pair in heights.windows(2) {
        let y = (pair[0] + pair[1]) / 2.0;
        let mut xs: Vec<f64> = Vec::new();
        let mut j = ring.len() - 1;
        for i in 0..ring.len() {
            let (a, b) = (ring[i], ring[j]);
            if (a.y > y) != (b.y > y) {
                xs.push((b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x);
            }
            j = i;
        }
        xs.sort_by(f64::total_cmp);
        if xs.len() >= 2 && xs[1] - xs[0] > 1e-12 {
            return Point2::new((xs[0] + xs[1]) / 2.0, y);
        }
    }
    ring[0]
}

/// The regions of a face written as `rings`, all outer bounds, in file order.
/// A ring with no area (judged against its own extent) bounds nothing and is dropped. A ring inside another
/// ring is that ring's opening (a writer tagging an opening as an outer bound),
/// a ring inside an opening is a region again; inside means an interior point of
/// the ring lies in the other and none of its vertices lie outside it. `None`
/// when the rings do not share a plane, so the caller keeps the single-ring
/// reading. Mirrors `faceRegionsOfOuterBounds` in `structural-face-regions.ts`.
fn outer_bound_regions(rings: &[&Vec<Point3<f64>>]) -> Option<Vec<FaceBounds>> {
    // A ring with no area (collinear points) bounds nothing; judged against its own extent, so a tiny ring is still a ring.
    let has_area = |ring: &Vec<Point3<f64>>| {
        let Some(first) = ring.first() else { return false };
        let (mut lo, mut hi) = (first.coords, first.coords);
        for p in ring.iter() {
            lo = lo.inf(&p.coords);
            hi = hi.sup(&p.coords);
        }
        projected_area(ring) > 1e-9 * (hi - lo).norm_squared()
    };
    let live: Vec<&Vec<Point3<f64>>> = rings.iter().copied().filter(|ring| has_area(ring)).collect();
    if live.is_empty() {
        return None;
    }
    if live.len() == 1 {
        return Some(vec![FaceBounds { outer: Some(live[0].clone()), holes: Vec::new() }]);
    }
    let reference = live.iter().copied().max_by(|a, b| projected_area(a).total_cmp(&projected_area(b))).unwrap();
    let normal = calculate_polygon_normal(reference);
    let extent = reference.iter().map(|p| (p - reference[0]).norm()).fold(1e-9, f64::max);
    if live.iter().any(|ring| ring.iter().any(|p| (p - reference[0]).dot(&normal).abs() > 1e-6 * extent + 1e-9)) {
        return None;
    }
    let (_, u, v, origin) = project_to_2d(reference, &normal);
    let flat: Vec<Vec<Point2<f64>>> = live.iter().map(|ring| project_to_2d_with_basis(ring, &u, &v, &origin)).collect();
    let areas: Vec<f64> = live.iter().map(|ring| projected_area(ring)).collect();
    let tolerance = 1e-9 * extent.max(1.0);
    let containers: Vec<Vec<usize>> = (0..flat.len())
        .map(|i| {
            let middle = interior_point_2d(&flat[i]);
            (0..flat.len())
                .filter(|&j| {
                    j != i
                        && areas[j] > areas[i]
                        && inside_2d(&middle, &flat[j])
                        && flat[i].iter().all(|p| inside_2d(p, &flat[j]) || edge_distance_2d(p, &flat[j]) <= tolerance)
                        && ring_stays_in(&flat[i], &flat[j], tolerance)
                })
                .collect()
        })
        .collect();
    let mut regions: Vec<(usize, FaceBounds)> = Vec::new();
    for i in 0..live.len() {
        if containers[i].len().is_multiple_of(2) {
            regions.push((i, FaceBounds { outer: Some(live[i].clone()), holes: Vec::new() }));
        }
    }
    for i in 0..live.len() {
        if containers[i].len() % 2 == 1 {
            // An opening belongs to the smallest loop around it.
            let owner = *containers[i].iter().min_by(|&&a, &&b| areas[a].total_cmp(&areas[b])).unwrap();
            if let Some((_, region)) = regions.iter_mut().find(|(index, _)| *index == owner) {
                region.holes.push(live[i].clone());
            }
        }
    }
    Some(regions.into_iter().map(|(_, region)| region).collect())
}

/// Every bound of `face` with at least three points, oriented, in order, with
/// whether it is an `IfcFaceOuterBound`.
fn read_bounds(
    face: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
) -> Result<Vec<(bool, Vec<Point3<f64>>)>> {
    let bounds = face
        .get(0)
        .ok_or_else(|| Error::geometry("FaceSurface missing Bounds".to_string()))?
        .as_list()
        .ok_or_else(|| Error::geometry("Expected bounds list".to_string()))?;
    let mut out = Vec::new();
    for bound in bounds {
        let (bound_entity, loop_entity) = resolve_bound_loop(face, bound, decoder)?;
        let read = match loop_entity.ifc_type {
            IfcType::IfcEdgeLoop => extract_edge_loop_points(&loop_entity, decoder, quality),
            IfcType::IfcPolyLoop => read_loop_points_by_id(loop_entity.id, decoder).ok_or(Refused),
            // Other loop kinds (IfcVertexLoop) carry no area; skipped as before.
            _ => Ok(Vec::new()),
        };
        let mut points = refuse_unreadable(face, &loop_entity, read)?;
        // A readable loop of under three points is degenerate, not unread.
        if points.len() < 3 {
            continue;
        }
        if !bound_entity.get_bool(1).unwrap_or(true) {
            points.reverse();
        }
        out.push((bound_entity.ifc_type == IfcType::IfcFaceOuterBound, points));
    }
    Ok(out)
}

fn projected_area(points: &[Point3<f64>]) -> f64 {
    let normal = calculate_polygon_normal(points);
    let (ring, _, _, _) = project_to_2d(points, &normal);
    ring.iter()
        .zip(ring.iter().cycle().skip(1))
        .take(ring.len())
        .map(|(a, b)| a.x * b.y - b.x * a.y)
        .sum::<f64>()
        .abs()
        * 0.5
}

fn compare_ring_key(a: &[Point3<f64>], b: &[Point3<f64>]) -> std::cmp::Ordering {
    let point_cmp = |left: &&Point3<f64>, right: &&Point3<f64>| {
        left.x
            .total_cmp(&right.x)
            .then_with(|| left.y.total_cmp(&right.y))
            .then_with(|| left.z.total_cmp(&right.z))
    };
    match (a.iter().min_by(point_cmp), b.iter().min_by(point_cmp)) {
        (Some(left), Some(right)) => point_cmp(&left, &right),
        (Some(_), None) => std::cmp::Ordering::Greater,
        (None, Some(_)) => std::cmp::Ordering::Less,
        (None, None) => std::cmp::Ordering::Equal,
    }
}

#[cfg(test)]
#[path = "bounds_tests.rs"]
mod region_tests;
