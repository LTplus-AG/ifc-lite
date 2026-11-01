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
    // Exact's plans are the authority for triangulation and winding, so they keep exact's frame,
    // except where narrowing to f32 misstates the authored shape: the ring they would clip and the
    // shell they would orient are then not the authored ones. Those plans read relative to a point
    // the faces use, as an unused entry far from them would leave the shape misstated.
    let frame_at = |point: Option<usize>| point.filter(|_| narrowing_misstates(&positions, scale))
        .and_then(|point| positions.get(point * 3..point * 3 + 3)).map(|p| (p[0], p[1], p[2]));
    let triangles = if polygonal {
        let faces = item.attr(slot::IfcPolygonalFaceSet::FACES)
            .and_then(AttributeValue::as_list).map_or(0, <[AttributeValue]>::len) as u32;
        let plan = polygonal_plan::lower(item, decoder, None)?;
        match frame_at(plan.first_used_point()) {
            Some(frame) => plan.in_frame(decoder, coordinates, frame)?,
            None => plan,
        }.source_triangles(faces)
    } else {
        let plan = triangulated_plan::lower(item, decoder, None)?;
        match frame_at(plan.first_used_point()) {
            Some(frame) => plan.in_frame(decoder, coordinates, frame)?,
            None => plan,
        }.source_triangles()
    };
    if positions.len() != triangles.positions.len() {
        return Err(Error::geometry("face set point list reads differently in f64".to_string()));
    }
    let SourceTriangles { indices, rows, row_count, .. } = outward(triangles, scale);
    let (triangles, rows) = without_zero_area(&positions, scale, indices, rows);
    crate::resource::charge(crate::resource::Cost {
        work: (positions.len() / 3 + rows.len()) as u64,
        live_bytes: (positions.len() * 8 + triangles.len() * 4 + rows.len() * 4) as u64
            + u64::from(row_count).saturating_sub(emitted_rows(&rows)) * DROPPED_ROW_BYTES,
        ..Default::default()
    })?.retain();
    Ok(RetainedFaceSet { source_id: item.id, positions, triangles, rows, row_count, length_unit_scale: scale })
}

/// A row with no triangle keeps a slot in the face table downstream though it adds nothing
/// to the request, so a file of dropped rows pays for those slots here, before they exist.
const DROPPED_ROW_BYTES: u64 = 256;

/// One f32 step here is a visible length: distinct levels can round together though every
/// point stays distinct, leaving a real face collinear.
const COARSE_F32_STEP_METRES: f64 = 1e-3;

/// How many authored rows still hold a triangle: one polygon row can hold many.
fn emitted_rows(rows: &[u32]) -> u64 {
    let mut distinct = rows.to_vec();
    distinct.sort_unstable();
    distinct.dedup();
    distinct.len() as u64
}

/// Whether f32 cannot be trusted with these points: its step is coarse at their magnitude, or
/// two distinct authored points become one. Below that, a collapse is a sub-millimetre sliver,
/// which exact drops too.
fn narrowing_misstates(positions: &[f64], scale: f64) -> bool {
    let magnitude = positions.iter().fold(0_f64, |worst, v| worst.max(v.abs()));
    magnitude * scale * f64::from(f32::EPSILON) > COARSE_F32_STEP_METRES || narrowing_merges(positions)
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
