// SPDX-License-Identifier: MPL-2.0
//! Deliberate flat-corner f64 -> display mesh boundary.
use super::{RetainedCompletion, RetainedRefusal};
use crate::Mesh;
pub(super) fn display_mesh(packet: &RetainedCompletion) -> Result<Mesh, RetainedRefusal> {
    let data = &packet.tessellation;
    let corners = data.indices.len();
    if !data.positions.len().is_multiple_of(3)
        || corners == 0
        || !corners.is_multiple_of(3)
        || corners.checked_mul(3) != Some(data.flat_corner_normals.len())
        || data.revision_local_faces.len() != corners / 3
        || data
            .revision_local_faces
            .iter()
            .any(|&face| face >= data.source_face_count)
        || data.boundary_edges != 0
        || data.spine_edges != 0
        || corners > u32::MAX as usize
    {
        return Err(RetainedRefusal::InvalidSource(
            "invalid retained tessellation",
        ));
    }
    let mut mesh = Mesh::new();
    // Flat-corner shading requires expansion; averaging would fabricate smooth
    // analytic normals and could cross a revision-local surface boundary.
    for (corner, &index) in data.indices.iter().enumerate() {
        let offset = (index as usize)
            .checked_mul(3)
            .ok_or(RetainedRefusal::InvalidSource("index overflow"))?;
        let end = offset
            .checked_add(3)
            .ok_or(RetainedRefusal::InvalidSource("index overflow"))?;
        let point = data
            .positions
            .get(offset..end)
            .ok_or(RetainedRefusal::InvalidSource("position index"))?;
        for (&p, &n) in point
            .iter()
            .zip(&data.flat_corner_normals[corner * 3..corner * 3 + 3])
        {
            if !p.is_finite()
                || !n.is_finite()
                || !(p as f32).is_finite()
                || !(n as f32).is_finite()
            {
                return Err(RetainedRefusal::InvalidSource(
                    "display narrowing overflows",
                ));
            }
            mesh.positions.push(p as f32);
            mesh.normals.push(n as f32);
        }
        mesh.indices.push(corner as u32);
    }
    for triangle in mesh.positions.chunks_exact(9) {
        let p = |i| {
            nalgebra::Vector3::<f64>::new(
                f64::from(triangle[i]),
                f64::from(triangle[i + 1]),
                f64::from(triangle[i + 2]),
            )
        };
        let area = (p(3) - p(0)).cross(&(p(6) - p(0))).norm();
        if !area.is_finite() || area == 0.0 {
            return Err(RetainedRefusal::InvalidSource(
                "display narrowing collapses triangle",
            ));
        }
    }
    Ok(mesh)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analytic::{
        AnalyticCurveSegment, AnalyticExtrusion, AnalyticProfile, AnalyticProfileLoop,
        AnalyticStatus, ProfileLoopKind,
    };
    use crate::document::{
        EvaluationContract, GeometryDocument, RetainedExtrusion, RetainedTessellation,
    };

    fn packet(positions: Vec<f64>) -> RetainedCompletion {
        let source = AnalyticExtrusion {
            solid_id: 1,
            swept_area_id: Some(2),
            position_id: None,
            position_matrix: None,
            extruded_direction_id: Some(3),
            direction_ratios: Some([0., 0., 1.]),
            axis_unit_vector: Some([0., 0., 1.]),
            depth: Some(1.),
            status: AnalyticStatus::Complete,
            profile: Some(AnalyticProfile {
                profile_id: 2,
                ifc_type_name: "IfcRectangleProfileDef".into(),
                profile_type: Some("AREA".into()),
                position_id: None,
                profile_position: None,
                loops: vec![AnalyticProfileLoop {
                    kind: ProfileLoopKind::Outer,
                    signed_area: 1.,
                    perimeter: 4.,
                    source: None,
                    segments: {
                        let points = [[0., 0., 0.], [1., 0., 0.], [1., 1., 0.], [0., 1., 0.]];
                        (0..4)
                            .map(|i| AnalyticCurveSegment::Line {
                                start: points[i],
                                end: points[(i + 1) % 4],
                            })
                            .collect()
                    },
                }],
                status: AnalyticStatus::Complete,
            }),
        };
        let mut doc = GeometryDocument::new();
        let definition = doc
            .add_retained_extrusion(RetainedExtrusion {
                source,
                length_unit_scale: 1.,
                source_epoch: 1,
                source_revision: 1,
            })
            .unwrap();
        let request = doc
            .prepare_retained_extrusion(definition, EvaluationContract::RetainedBrep, 1)
            .unwrap();
        let frame = crate::document::retained_sweep::lower(request.recipe()).unwrap();
        RetainedCompletion::new(
            request,
            RetainedTessellation {
                positions,
                indices: vec![0, 1, 2],
                flat_corner_normals: vec![0., 0., 1., 0., 0., 1., 0., 0., 1.],
                revision_local_faces: vec![0],
                source_face_count: 1,
                boundary_edges: 0,
                spine_edges: 0,
            },
            frame.source_from_evaluation,
            frame.evaluation_from_source,
        )
    }
    #[test]
    fn retained_round1_display_refuses_f64_triangles_collapsing_during_f32_narrowing() {
        let packet = packet(vec![1., 0., 0., 1. + 1e-12, 0., 0., 1., 1., 0.]);
        assert!(matches!(
            display_mesh(&packet),
            Err(RetainedRefusal::InvalidSource(
                "display narrowing collapses triangle"
            ))
        ));
        // The owned f64 evidence remains intact after refusal.
        assert!(packet.tessellation.positions[3] > packet.tessellation.positions[0]);
    }
    #[test]
    fn retained_round1_flat_corners_are_expanded_without_averaging_normals() {
        let mut packet = packet(vec![0., 0., 0., 1., 0., 0., 0., 1., 0., 0., 0., 1.]);
        packet.tessellation.indices = vec![0, 1, 2, 0, 3, 1];
        packet.tessellation.flat_corner_normals = vec![
            0., 0., 1., 0., 0., 1., 0., 0., 1., 0., 1., 0., 0., 1., 0., 0., 1., 0.,
        ];
        packet.tessellation.revision_local_faces = vec![0, 1];
        packet.tessellation.source_face_count = 2;
        let mesh = display_mesh(&packet).unwrap();
        assert_eq!(
            mesh.positions.len(),
            18,
            "shared corners must split at the crease"
        );
        assert_eq!(&mesh.positions[..3], &mesh.positions[9..12]);
        assert_ne!(mesh.indices[0], mesh.indices[3]);
        assert_eq!(&mesh.normals[..3], &[0., 0., 1.]);
        assert_eq!(&mesh.normals[9..12], &[0., 1., 0.]);
    }
}
