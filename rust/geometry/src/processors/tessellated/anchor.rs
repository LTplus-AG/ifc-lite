// SPDX-License-Identifier: MPL-2.0

use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};

use super::{indices, mesh_build, polygonal_plan};

/// Centre of the points named by the face loops, in file units.
pub(crate) fn referenced_point_centre(
    item: &DecodedEntity,
    decoder: &mut EntityDecoder,
    points: &[f64],
) -> Option<[f64; 3]> {
    let count = points.len() / 3;
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    let mut include = |index: usize| {
        for axis in 0..3 {
            let value = points[3 * index + axis];
            min[axis] = min[axis].min(value);
            max[axis] = max[axis].max(value);
        }
    };

    if item.ifc_type == IfcType::IfcPolygonalFaceSet {
        let pn = indices::read_pn_index(item, slot::IfcPolygonalFaceSet::PN_INDEX.index());
        let faces = item.attr(slot::IfcPolygonalFaceSet::FACES)?.as_list()?;
        let valid = |ring: &[u32]| {
            ring.len() >= 3 && ring.iter().all(|&i| i != 0 && i as usize <= count)
        };
        for face in faces {
            let Some(face) = face.as_entity_ref().and_then(|id| decoder.decode_by_id(id).ok()) else {
                continue;
            };
            let Some(loop_values) = face.attr(slot::IfcIndexedPolygonalFace::COORD_INDEX)
                .and_then(|value| value.as_list()) else {
                continue;
            };
            let outer = polygonal_plan::parse_index_loop(loop_values, pn.as_deref());
            let inner = polygonal_plan::parse_face_inner_indices(&face, pn.as_deref());
            if !valid(&outer) || !inner.iter().all(|ring| valid(ring)) {
                continue;
            }
            for index in outer.into_iter().chain(inner.into_iter().flatten()) {
                include(index as usize - 1);
            }
        }
    } else {
        let pn = indices::read_pn_index(item, slot::IfcTriangulatedFaceSet::PN_INDEX.index());
        let corners = indices::read_triangle_coord_index(item, decoder).ok()?;
        for triangle in corners.chunks_exact(3) {
            let corners = std::array::from_fn(|i| {
                indices::through_pn_index(triangle[i], pn.as_deref()) as usize
            });
            if mesh_build::emits_triangle(corners, count) {
                for index in corners {
                    include(index);
                }
            }
        }
    }

    (min[0] <= max[0]).then(|| std::array::from_fn(|axis| min[axis].midpoint(max[axis])))
}
