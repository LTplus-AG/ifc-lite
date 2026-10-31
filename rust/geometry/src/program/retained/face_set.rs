// SPDX-License-Identifier: MPL-2.0
//! Capture authored `IfcTessellatedFaceSet` triangles for retained publication
//! (#8291). Topology comes from exact's own plans over the f32 point list, so
//! the triangulation and winding decisions are exact's, made relative to the first
//! point; the published coordinates are the same records read in full f64.
use crate::document::RetainedFaceSet;
use crate::processors::{polygonal_plan, read_point_list_f64, triangulated_plan, SourceTriangles, PolygonalFaces};
use crate::{orient_mesh_outward_verdict, Error, Result};
use ifc_lite_core::{slot, AttributeValue, DecodedEntity, EntityDecoder, IfcType};

pub(super) fn capture(item: &DecodedEntity, decoder: &mut EntityDecoder, scale: f64) -> Result<RetainedFaceSet> {
    let polygonal = item.ifc_type == IfcType::IfcPolygonalFaceSet;
    let coordinates = if polygonal { item.attr(slot::IfcPolygonalFaceSet::COORDINATES) } else { item.attr(slot::IfcTriangulatedFaceSet::COORDINATES) };
    let coordinates = coordinates.and_then(AttributeValue::as_entity_ref)
        .ok_or_else(|| Error::geometry("face set missing Coordinates".to_string()))?;
    let positions = read_point_list_f64(decoder, coordinates)?;
    // Exact's plans narrow to f32. Relative to the first point, as the request itself is, so corners
    // that f32 would merge at survey scale stay distinct for its triangulation and winding decisions.
    let anchor = positions.get(0..3).map(|p| (p[0], p[1], p[2]));
    let triangles = if polygonal {
        let faces = item.attr(slot::IfcPolygonalFaceSet::FACES)
            .and_then(AttributeValue::as_list).map_or(0, <[AttributeValue]>::len) as u32;
        polygonal_plan::lower(item, decoder, anchor)?.source_triangles(faces)
    } else {
        triangulated_plan::lower(item, decoder, anchor)?.source_triangles()
    };
    if positions.len() != triangles.positions.len() {
        return Err(Error::geometry("face set point list reads differently in f64".to_string()));
    }
    let SourceTriangles { indices, rows, row_count, .. } = outward(triangles, scale);
    let (triangles, rows) = without_zero_area(&positions, scale, indices, rows);
    crate::resource::charge(crate::resource::Cost {
        work: (positions.len() / 3 + rows.len()) as u64,
        live_bytes: (positions.len() * 8 + triangles.len() * 4 + rows.len() * 4) as u64,
        ..Default::default()
    })?.retain();
    Ok(RetainedFaceSet { source_id: item.id, positions, triangles, rows, row_count, length_unit_scale: scale })
}

/// Exact's per-element pass faces each closed component outward, including a
/// shell authored `Closed=$`. Open components keep the authored winding.
fn outward(mut triangles: SourceTriangles, scale: f64) -> SourceTriangles {
    // Exact orients metres: its vertex weld is a fixed distance, not a file-unit one.
    let metres: Vec<f32> = triangles.positions.iter().map(|&v| (f64::from(v) * scale) as f32).collect();
    let mut mesh = PolygonalFaces::build_flat_shaded_mesh(&metres, &triangles.indices);
    if orient_mesh_outward_verdict(&mut mesh).flipped {
        for (t, corners) in triangles.indices.chunks_exact_mut(3).enumerate() {
            if mesh.indices[3 * t + 1] != 3 * t as u32 + 1 { corners.swap(1, 2); }
        }
    }
    triangles
}

/// A triangle with no area has no facet: nothing to display and no normal. Judged in
/// the request's own arithmetic (metres from the first point), so an authored sliver
/// that only collapses there cannot reach the sealed mesh without a normal.
fn without_zero_area(positions: &[f64], scale: f64, indices: Vec<u32>, rows: Vec<u32>) -> (Vec<u32>, Vec<u32>) {
    let mut kept = Vec::with_capacity(indices.len());
    let mut kept_rows = Vec::with_capacity(rows.len());
    for (corners, row) in indices.chunks_exact(3).zip(rows) {
        let point = |i: u32| nalgebra::Vector3::from(std::array::from_fn::<f64, 3, _>(|axis| (positions[i as usize * 3 + axis] - positions[axis]) * scale));
        let area = (point(corners[1]) - point(corners[0])).cross(&(point(corners[2]) - point(corners[0])));
        if area.norm() > 0. {
            kept.extend_from_slice(corners);
            kept_rows.push(row);
        }
    }
    (kept, kept_rows)
}

#[cfg(test)]
#[path = "face_set_tests.rs"]
mod tests;
