// SPDX-License-Identifier: MPL-2.0
//! Authored `IfcTessellatedFaceSet` rows read directly from their source records
//! (#8291). Plans, retained requests and published meshes are never inputs.
use ifc_lite_core::{slot, AttributeValue, DecodedEntity, EntityDecoder, IfcType};

/// One authored row: its points, and its polygon area when it is planar.
#[derive(Debug, Clone, PartialEq)]
pub struct Row { pub points: Vec<[f64; 3]>, pub area_m2: Option<f64> }
/// Rows in metres, relative to the first authored point; malformed rows are empty.
#[derive(Debug, Clone, PartialEq)]
pub struct AuthoredFaceSet { pub rows: Vec<Row> }

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
            let mut all = outer;
            all.extend(inner.into_iter().flatten());
            Row { points: all, area_m2 }
        }
        _ => Row { points: Vec::new(), area_m2: None },
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
    Some(AuthoredFaceSet { rows })
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
        let Some(area) = row.area_m2 else { continue };
        if area <= 0. { continue; }
        if published == 0. { result.missing_rows += 1; continue; }
        result.area_relative = result.area_relative.max((published - area).abs() / area);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sheet() -> AuthoredFaceSet {
        AuthoredFaceSet { rows: vec![
            Row { points: vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]], area_m2: Some(0.5) },
            Row { points: vec![[1., 0., 0.], [1., 1., 0.], [0., 1., 0.]], area_m2: Some(0.5) },
        ] }
    }
    const POSITIONS: [f64; 12] = [0., 0., 0., 1., 0., 0., 0., 1., 0., 1., 1., 0.];
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
