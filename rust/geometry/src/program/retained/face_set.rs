// SPDX-License-Identifier: MPL-2.0
//! Capture authored `IfcTessellatedFaceSet` triangles for retained publication
//! (#8291). Topology comes from exact's own plans over the f32 point list, so
//! the triangulation and winding decisions are exact's; the published
//! coordinates are the same records read in full f64.
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
    let triangles = if polygonal {
        let faces = item.attr(slot::IfcPolygonalFaceSet::FACES)
            .and_then(AttributeValue::as_list).map_or(0, <[AttributeValue]>::len) as u32;
        // Exact's plan is the authority for triangulation, so it keeps exact's frame, except where
        // narrowing to f32 merges distinct authored corners: the ring it would clip is then not
        // the authored ring. Triangle topology needs no such exception: it is authored.
        polygonal_plan::lower(item, decoder, narrowing_merges(&positions).then(|| (positions[0], positions[1], positions[2])))?
            .source_triangles(faces)
    } else {
        triangulated_plan::lower(item, decoder, None)?.source_triangles()
    };
    if positions.len() != triangles.positions.len() {
        return Err(Error::geometry("face set point list reads differently in f64".to_string()));
    }
    let SourceTriangles { indices, rows, row_count, authored, slots, .. } = outward(triangles, scale);
    let keep = positive_area(&positions, scale, &indices);
    let (triangles, rows) = (kept(&indices, &keep, 3), kept(&rows, &keep, 1));
    let (source_corners, source_slots) = (kept(&authored, &keep, 3), kept(&slots, &keep, 3));
    crate::resource::charge(crate::resource::Cost {
        work: (positions.len() / 3 + rows.len()) as u64,
        live_bytes: (positions.len() * 8 + triangles.len() * 4 + rows.len() * 4 + source_corners.len() * 4 + source_slots.len()) as u64,
        ..Default::default()
    })?.retain();
    Ok(RetainedFaceSet { source_id: item.id, positions, triangles, rows, row_count, source_corners, source_slots, length_unit_scale: scale })
}

/// Whether two distinct authored points become one in f32.
fn narrowing_merges(positions: &[f64]) -> bool {
    let mut exact: Vec<[u64; 3]> = positions.chunks_exact(3).map(|p| [(p[0] + 0.).to_bits(), (p[1] + 0.).to_bits(), (p[2] + 0.).to_bits()]).collect();
    exact.sort_unstable();
    exact.dedup();
    let mut narrow: Vec<[u32; 3]> = positions.chunks_exact(3).map(|p| [(p[0] as f32 + 0.).to_bits(), (p[1] as f32 + 0.).to_bits(), (p[2] as f32 + 0.).to_bits()]).collect();
    narrow.sort_unstable();
    narrow.dedup();
    narrow.len() < exact.len()
}

/// Exact's per-element pass faces each closed component outward, including a
/// shell authored `Closed=$`. Open components keep the authored winding.
fn outward(mut triangles: SourceTriangles, scale: f64) -> SourceTriangles {
    // Exact orients metres: its vertex weld is a fixed distance, not a file-unit one.
    let metres: Vec<f32> = triangles.positions.iter().map(|&v| (f64::from(v) * scale) as f32).collect();
    let mut mesh = PolygonalFaces::build_flat_shaded_mesh(&metres, &triangles.indices);
    if orient_mesh_outward_verdict(&mut mesh).flipped {
        for t in 0..triangles.indices.len() / 3 {
            if mesh.indices[3 * t + 1] != 3 * t as u32 + 1 {
                triangles.indices.swap(3 * t + 1, 3 * t + 2);
                if !triangles.slots.is_empty() {
                    triangles.slots.swap(3 * t + 1, 3 * t + 2);
                    triangles.authored.swap(3 * t + 1, 3 * t + 2);
                }
            }
        }
    }
    triangles
}

/// A triangle with no area has no facet: nothing to display and no normal. Judged in
/// the request's own arithmetic (metres from the first point), so an authored sliver
/// that only collapses there cannot reach the sealed mesh without a normal.
fn positive_area(positions: &[f64], scale: f64, indices: &[u32]) -> Vec<bool> {
    indices.chunks_exact(3).map(|corners| {
        let point = |i: u32| nalgebra::Vector3::from(std::array::from_fn::<f64, 3, _>(|axis| (positions[i as usize * 3 + axis] - positions[axis]) * scale));
        (point(corners[1]) - point(corners[0])).cross(&(point(corners[2]) - point(corners[0]))).norm() > 0.
    }).collect()
}
/// `values` holds `width` entries per triangle; an empty channel stays empty.
fn kept<T: Copy>(values: &[T], keep: &[bool], width: usize) -> Vec<T> {
    values.chunks_exact(width).zip(keep).filter(|(_, keep)| **keep).flat_map(|(chunk, _)| chunk.iter().copied()).collect()
}

#[cfg(test)]
#[path = "face_set_tests.rs"]
mod tests;
