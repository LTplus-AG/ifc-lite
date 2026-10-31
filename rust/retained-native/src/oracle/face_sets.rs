// SPDX-License-Identifier: MPL-2.0
//! Authored `IfcTessellatedFaceSet` rows read directly from their source records
//! (#8291). Plans, retained requests and published meshes are never inputs.
use ifc_lite_core::{slot, AttributeValue, DecodedEntity, EntityDecoder, IfcType};

/// One authored row: its points, and its polygon area when it is planar.
#[derive(Debug, Clone, PartialEq)]
pub struct Row { pub points: Vec<[f64; 3]>, pub outer: usize, pub area_m2: Option<f64> }
/// Rows in metres, relative to the first authored point; malformed rows are empty.
#[derive(Debug, Clone, PartialEq)]
pub struct AuthoredFaceSet { pub first: [f64; 3], pub rows: Vec<Row> }

fn corners(list: &[AttributeValue], pn: Option<&[AttributeValue]>, points: &[[f64; 3]]) -> Option<Vec<[f64; 3]>> {
    list.iter().map(|value| {
        let corner = value.as_int().and_then(|i| usize::try_from(i).ok())?.checked_sub(1)?;
        let corner = match pn {
            Some(pn) => pn.get(corner)?.as_int().and_then(|i| usize::try_from(i).ok())?.checked_sub(1)?,
            None => corner,
        };
        points.get(corner).copied()
    }).collect()
}
fn newell(ring: &[[f64; 3]]) -> [f64; 3] {
    let mut n = [0.; 3];
    for (i, p) in ring.iter().enumerate() {
        let q = ring[(i + 1) % ring.len()];
        n[0] += (p[1] - q[1]) * (p[2] + q[2]);
        n[1] += (p[2] - q[2]) * (p[0] + q[0]);
        n[2] += (p[0] - q[0]) * (p[1] + q[1]);
    }
    n
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 { a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
/// Polygon area minus its holes, `None` when any point leaves the outer ring's plane.
fn planar_area(outer: &[[f64; 3]], inner: &[Vec<[f64; 3]>]) -> Option<f64> {
    let normal = newell(outer);
    let twice = dot(normal, normal).sqrt();
    if twice == 0. { return None; }
    let unit = normal.map(|v| v / twice);
    let origin = outer[0];
    let off = |p: &[f64; 3]| dot(unit, std::array::from_fn(|i| p[i] - origin[i])).abs();
    if outer.iter().chain(inner.iter().flatten()).any(|p| off(p) > 1e-9) { return None; }
    let holes: f64 = inner.iter().map(|ring| { let n = newell(ring); dot(n, n).sqrt() }).sum();
    Some((twice - holes) / 2.)
}

pub fn authored(item: &DecodedEntity, decoder: &mut EntityDecoder, metres_per_unit: f64) -> Option<AuthoredFaceSet> {
    let polygonal = item.ifc_type == IfcType::IfcPolygonalFaceSet;
    let coordinates = if polygonal { item.ref_at(slot::IfcPolygonalFaceSet::COORDINATES) } else { item.ref_at(slot::IfcTriangulatedFaceSet::COORDINATES) };
    let list = decoder.decode_by_id(coordinates?).ok()?;
    let rows = list.attr(slot::IfcCartesianPointList3D::COORD_LIST)?.as_list()?;
    let mut points: Vec<[f64; 3]> = Vec::with_capacity(rows.len());
    for row in rows {
        let [x, y, z] = row.as_list()? else { return None };
        points.push([x.as_float()?, y.as_float()?, z.as_float()?]);
    }
    let first = *points.first()?;
    let points: Vec<[f64; 3]> = points.iter().map(|p| std::array::from_fn(|i| (p[i] - first[i]) * metres_per_unit)).collect();
    let row = |outer: Option<Vec<[f64; 3]>>, inner: Vec<Vec<[f64; 3]>>| match outer {
        Some(outer) if outer.len() >= 3 => {
            let area_m2 = planar_area(&outer, &inner);
            let outer_count = outer.len();
            let mut all = outer;
            all.extend(inner.into_iter().flatten());
            Row { points: all, outer: outer_count, area_m2 }
        }
        _ => Row { points: Vec::new(), outer: 0, area_m2: None },
    };
    let rows = if polygonal {
        let pn = item.attr(slot::IfcPolygonalFaceSet::PN_INDEX).and_then(AttributeValue::as_list);
        item.attr(slot::IfcPolygonalFaceSet::FACES)?.as_list()?.iter().map(|face| {
            let face = decoder.decode_by_id(face.as_entity_ref()?).ok()?;
            let outer = corners(face.attr(slot::IfcIndexedPolygonalFace::COORD_INDEX)?.as_list()?, pn, &points);
            let inner = (face.ifc_type == IfcType::IfcIndexedPolygonalFaceWithVoids)
                .then(|| face.attr(slot::IfcIndexedPolygonalFaceWithVoids::INNER_COORD_INDICES)?.as_list()).flatten()
                .map_or(Some(Vec::new()), |loops| loops.iter().map(|l| corners(l.as_list()?, pn, &points)).collect())?;
            Some(row(outer, inner))
        }).collect::<Option<Vec<_>>>()?
    } else {
        let pn = item.attr(slot::IfcTriangulatedFaceSet::PN_INDEX).and_then(AttributeValue::as_list).filter(|l| l.iter().all(|v| v.as_list().is_none()));
        item.attr(slot::IfcTriangulatedFaceSet::COORD_INDEX)?.as_list()?.iter()
            .map(|t| Some(row(corners(t.as_list()?, pn, &points), Vec::new()))).collect::<Option<Vec<_>>>()?
    };
    Some(AuthoredFaceSet { first, rows })
}

/// Each row's plane, mapped through `world` from raw file units: a point and the
/// unit Newell normal of its outer ring, in authored winding. Rows without area have none.
pub fn world_planes(set: &AuthoredFaceSet, world: impl Fn([f64; 3]) -> [f64; 3]) -> Vec<([f64; 3], [f64; 3])> {
    set.rows.iter().filter_map(|row| {
        let ring: Vec<[f64; 3]> = row.points[..row.outer].iter()
            .map(|p| world(std::array::from_fn(|i| p[i] + set.first[i]))).collect();
        let origin = *ring.first()?;
        let normal = newell(&ring);
        let length = dot(normal, normal).sqrt();
        (length > 0.).then(|| (origin, normal.map(|v| v / length)))
    }).collect()
}

/// The solid an authored shell bounds, by the divergence theorem over its rows, in the
/// set's own units cubed. `None` where a row is warped and has no single plane.
pub fn authored_volume(set: &AuthoredFaceSet) -> Option<f64> {
    let mut sum = 0.;
    for row in set.rows.iter().filter(|row| !row.points.is_empty()) {
        let normal = newell(&row.points[..row.outer]);
        let length = dot(normal, normal).sqrt();
        // A row with no area bounds nothing; one with area but no single plane has no answer here.
        if length == 0. { continue; }
        let area = row.area_m2?;
        sum += dot(row.points[0], normal.map(|v| v / length)) * area;
    }
    Some(sum.abs() / 3.)
}

/// An authored `IfcIndexedColourMap` / `IfcIndexedTriangleTextureMap`, read by scanning
/// the source for the map whose `MappedTo` is this face set.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AuthoredSurface {
    /// 0-based palette entry per authored row.
    pub palette: Option<Vec<u32>>,
    /// Per authored row, its three corners' source UVs in authored order.
    pub uvs: Option<Vec<[[f64; 2]; 3]>>,
}
pub fn authored_surface(bytes: &[u8], item: &DecodedEntity, decoder: &mut EntityDecoder) -> AuthoredSurface {
    let mut surface = AuthoredSurface::default();
    let mut scanner = ifc_lite_core::EntityScanner::new(bytes);
    while let Some((_, name, start, end)) = scanner.next_entity() {
        let colour = name.eq_ignore_ascii_case("IFCINDEXEDCOLOURMAP");
        if !colour && !name.eq_ignore_ascii_case("IFCINDEXEDTRIANGLETEXTUREMAP") { continue; }
        let Ok(map) = decoder.decode_at(start, end) else { continue };
        if colour && map.ref_at(slot::IfcIndexedColourMap::MAPPED_TO) == Some(item.id) && surface.palette.is_none() {
            surface.palette = map.attr(slot::IfcIndexedColourMap::COLOUR_INDEX).and_then(AttributeValue::as_list).map(|rows| rows.iter()
                .map(|v| v.as_int().unwrap_or(0) as u32 - 1).collect());
        } else if !colour && map.ref_at(slot::IfcIndexedTriangleTextureMap::MAPPED_TO) == Some(item.id) && surface.uvs.is_none() {
            surface.uvs = texture_rows(&map, item, decoder);
        }
    }
    surface
}
fn texture_rows(map: &DecodedEntity, item: &DecodedEntity, decoder: &mut EntityDecoder) -> Option<Vec<[[f64; 2]; 3]>> {
    let list = decoder.decode_by_id(map.ref_at(slot::IfcIndexedTriangleTextureMap::TEX_COORDS)?).ok()?;
    let coordinates: Vec<[f64; 2]> = list.attr(slot::IfcTextureVertexList::TEX_COORDS_LIST)?.as_list()?.iter()
        .map(|row| { let [u, v] = row.as_list()? else { return None }; Some([u.as_float()?, v.as_float()?]) }).collect::<Option<_>>()?;
    // `TexCoordIndex`, else texture vertices pair 1:1 with `CoordIndex`.
    let rows = match map.attr(slot::IfcIndexedTriangleTextureMap::TEX_COORD_INDEX).and_then(AttributeValue::as_list) {
        Some(rows) => rows,
        None => item.attr(slot::IfcTriangulatedFaceSet::COORD_INDEX)?.as_list()?,
    };
    rows.iter().map(|row| {
        let [a, b, c] = row.as_list()? else { return None };
        let uv = |v: &AttributeValue| coordinates.get(usize::try_from(v.as_int()?).ok()?.checked_sub(1)?).copied();
        Some([uv(a)?, uv(b)?, uv(c)?])
    }).collect()
}

/// A published corner's UV deviation from the authored row's affine map (rows are metres
/// relative to the first authored point). `None` where the point has no plane in that row.
pub fn uv_deviation(row: &Row, uvs: &[[f64; 2]; 3], p: [f64; 3], uv: [f64; 2]) -> Option<f64> {
    let [a, b, c] = row.points.as_slice() else { return None };
    let (e, f, q): ([f64; 3], [f64; 3], [f64; 3]) = (std::array::from_fn(|i| b[i] - a[i]),
        std::array::from_fn(|i| c[i] - a[i]), std::array::from_fn(|i| p[i] - a[i]));
    let (ee, ef, ff, qe, qf) = (dot(e, e), dot(e, f), dot(f, f), dot(q, e), dot(q, f));
    let det = ee * ff - ef * ef;
    if det == 0. { return None; }
    let (v, w) = ((ff * qe - ef * qf) / det, (ee * qf - ef * qe) / det);
    let expected: [f64; 2] = std::array::from_fn(|i| (1. - v - w) * uvs[0][i] + v * uvs[1][i] + w * uvs[2][i]);
    Some((expected[0] - uv[0]).hypot(expected[1] - uv[1]))
}

/// Worst per-row disagreement of one uncut part, or `None` when no key is a row.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct RowDeviation { pub corner_m: f64, pub area_relative: f64, pub missing_rows: usize }
pub fn deviation(set: &AuthoredFaceSet, positions: &[f64], indices: &[u32], keys: &[Option<u32>]) -> RowDeviation {
    let mut result = RowDeviation::default();
    let mut areas = vec![0.; set.rows.len()];
    for (triangle, key) in indices.chunks_exact(3).zip(keys) {
        let Some(row) = key.and_then(|k| set.rows.get(k as usize)) else {
            result.corner_m = f64::INFINITY;
            continue;
        };
        let at = |i: u32| -> [f64; 3] { std::array::from_fn(|c| positions[i as usize * 3 + c]) };
        let [a, b, c] = [at(triangle[0]), at(triangle[1]), at(triangle[2])];
        for p in [a, b, c] {
            let nearest = row.points.iter().map(|q| {
                let d: [f64; 3] = std::array::from_fn(|i| p[i] - q[i]);
                dot(d, d).sqrt()
            }).fold(f64::INFINITY, f64::min);
            result.corner_m = result.corner_m.max(nearest);
        }
        let (e, f): ([f64; 3], [f64; 3]) = (std::array::from_fn(|i| b[i] - a[i]), std::array::from_fn(|i| c[i] - a[i]));
        let n = [e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]];
        if let Some(key) = key { areas[*key as usize] += dot(n, n).sqrt() / 2.; }
    }
    for (row, published) in set.rows.iter().zip(areas) {
        let Some(area) = row.area_m2 else {
            // A warped row has no single area, but no surface over its ring can be smaller
            // than the ring's projection: a dropped triangle falls below that. A hole removes
            // surface the outer ring still projects over, so only a hole-free row can say.
            if row.outer >= 3 && row.outer == row.points.len() {
                let n = newell(&row.points[..row.outer]);
                let projected = dot(n, n).sqrt() / 2.;
                if published < projected * (1. - 1e-9) { result.missing_rows += 1; }
            }
            continue;
        };
        if area <= 0. { continue; }
        // Below the facet-orientation ratio the area is round-off, not a measurement:
        // a sliver's authored corners are what the corner check above already pins.
        let longest = row.points.iter().flat_map(|a| row.points.iter().map(move |b| {
            let d: [f64; 3] = std::array::from_fn(|i| a[i] - b[i]);
            dot(d, d)
        })).fold(0., f64::max);
        if area < 1e-6 * longest { continue; }
        if published == 0. { result.missing_rows += 1; continue; }
        result.area_relative = result.area_relative.max((published - area).abs() / area);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sheet() -> AuthoredFaceSet {
        AuthoredFaceSet { first: [0.; 3], rows: vec![
            Row { points: vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]], outer: 3, area_m2: Some(0.5) },
            Row { points: vec![[1., 0., 0.], [1., 1., 0.], [0., 1., 0.]], outer: 3, area_m2: Some(0.5) },
        ] }
    }
    const POSITIONS: [f64; 12] = [0., 0., 0., 1., 0., 0., 0., 1., 0., 1., 1., 0.];
    #[test]
    fn issue_8291_a_dropped_triangle_of_a_warped_row_is_observed() {
        let warped = AuthoredFaceSet { first: [0.; 3], rows: vec![Row {
            points: vec![[0., 0., 0.], [1., 0., 0.], [1., 1., 0.5], [0., 1., 0.]], outer: 4, area_m2: None }] };
        let positions = [0., 0., 0., 1., 0., 0., 1., 1., 0.5, 0., 1., 0.];
        assert_eq!(deviation(&warped, &positions, &[0, 1, 2, 0, 2, 3], &[Some(0), Some(0)]).missing_rows, 0);
        assert_eq!(deviation(&warped, &positions, &[0, 1, 2], &[Some(0)]).missing_rows, 1, "one of two triangles dropped");
        assert_eq!(deviation(&warped, &positions, &[], &[]).missing_rows, 1, "the whole row dropped");
    }

    }

    #[test]
    fn issue_8291_uv_oracle_observes_a_wrong_corner_and_a_mirrored_map() {
        let row = Row { points: vec![[0., 0., 0.], [2., 0., 0.], [0., 4., 0.]], outer: 3, area_m2: Some(4.) };
        let uvs = [[0.25, 0.5], [1.25, 0.5], [0.25, 0.]];
        let cut = [0.5, 2., 0.];
        assert!(uv_deviation(&row, &uvs, cut, [0.5, 0.25]).unwrap() < 1e-15);
        assert!(uv_deviation(&row, &uvs, cut, [0.5, 0.25 + 1e-6]).unwrap() > 9e-7, "moved UV");
        assert!(uv_deviation(&row, &[uvs[0], uvs[2], uvs[1]], cut, [0.5, 0.25]).unwrap() > 0.1, "swapped corners");
    }
    #[test]
    fn issue_8291_faithful_part_has_no_deviation() {
        let d = deviation(&sheet(), &POSITIONS, &[0, 1, 2, 1, 3, 2], &[Some(0), Some(1)]);
        assert_eq!(d, RowDeviation::default());
    }
    #[test]
    fn issue_8291_mutations_are_observed() {
        let moved = { let mut p = POSITIONS; p[3] += 1e-6; p };
        assert!(deviation(&sheet(), &moved, &[0, 1, 2, 1, 3, 2], &[Some(0), Some(1)]).corner_m > 9e-7, "moved corner");
        let swapped = deviation(&sheet(), &POSITIONS, &[0, 1, 2, 1, 3, 2], &[Some(1), Some(0)]);
        assert!(swapped.corner_m > 0.9, "rows swapped between coplanar triangles");
        assert_eq!(deviation(&sheet(), &POSITIONS, &[0, 1, 2], &[Some(0)]).missing_rows, 1, "dropped row");
    }
}
