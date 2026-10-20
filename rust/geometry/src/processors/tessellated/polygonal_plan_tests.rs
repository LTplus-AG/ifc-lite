// SPDX-License-Identifier: MPL-2.0
use super::*;

fn decoded(source: String, rtc: Option<(f64, f64, f64)>) -> PolygonalFaceSetPlan {
    let mut decoder = EntityDecoder::new(&source);
    let entity = decoder.decode_by_id(20).unwrap();
    lower(&entity, &mut decoder, rtc).unwrap()
}
fn signed_area(mesh: &Mesh) -> f64 {
    mesh.indices
        .chunks_exact(3)
        .map(|triangle| {
            let p = |corner: u32| {
                let offset = corner as usize * 3;
                [
                    f64::from(mesh.positions[offset]),
                    f64::from(mesh.positions[offset + 1]),
                ]
            };
            let [a, b, c] = [p(triangle[0]), p(triangle[1]), p(triangle[2])];
            ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2.
        })
        .sum()
}

#[test]
fn owned_holed_polygon_replays_pn_mapping_without_filling_the_hole() {
    let plan = decoded("#1=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(4.,0.,0.),(4.,4.,0.),(0.,4.,0.),(1.,1.,0.),(3.,1.,0.),(3.,3.,0.),(1.,3.,0.)));#2=IFCINDEXEDPOLYGONALFACEWITHVOIDS((8,7,6,5),((4,3,2,1)));#20=IFCPOLYGONALFACESET(#1,.F.,(#2),(8,7,6,5,4,3,2,1));".into(), None);
    for mesh in [plan.clone().evaluate(), plan.evaluate()] {
        assert!((signed_area(&mesh) - 12.).abs() < 1e-9);
        assert!(mesh
            .normals
            .chunks_exact(3)
            .all(|normal| normal == [0., 0., 1.]));
        for triangle in mesh.indices.chunks_exact(3) {
            let point = |index: u32| {
                let offset = index as usize * 3;
                [
                    f64::from(mesh.positions[offset]),
                    f64::from(mesh.positions[offset + 1]),
                ]
            };
            let mut clipped = vec![point(triangle[0]), point(triangle[1]), point(triangle[2])];
            for (axis, bound, greater) in
                [(0, 1., true), (0, 3., false), (1, 1., true), (1, 3., false)]
            {
                clipped = clip_halfplane(&clipped, axis, bound, greater);
            }
            assert!(
                polygon_area(&clipped) < 1e-9,
                "triangle must not overlap the authored hole"
            );
        }
    }
}

fn clip_halfplane(points: &[[f64; 2]], axis: usize, bound: f64, greater: bool) -> Vec<[f64; 2]> {
    let inside = |point: [f64; 2]| {
        if greater {
            point[axis] >= bound
        } else {
            point[axis] <= bound
        }
    };
    let mut result = Vec::new();
    for index in 0..points.len() {
        let a = points[index];
        let b = points[(index + 1) % points.len()];
        if inside(a) {
            result.push(a);
        }
        if inside(a) != inside(b) {
            let t = (bound - a[axis]) / (b[axis] - a[axis]);
            result.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
        }
    }
    result
}
fn polygon_area(points: &[[f64; 2]]) -> f64 {
    (0..points.len())
        .map(|index| {
            let a = points[index];
            let b = points[(index + 1) % points.len()];
            a[0] * b[1] - b[0] * a[1]
        })
        .sum::<f64>()
        .abs()
        / 2.
}

#[test]
fn empty_coordinates_short_circuit_before_faces_and_keep_empty_mesh_frame_policy() {
    for rtc in [None, Some((1., 2., 3.))] {
        let mesh = decoded(
            "#1=IFCCARTESIANPOINTLIST3D(());#20=IFCPOLYGONALFACESET(#1);".into(),
            rtc,
        )
        .evaluate();
        assert!(mesh.is_empty());
        assert!(
            !mesh.rtc_applied,
            "the production early return precedes RTC publication"
        );
    }
    let source = "#1=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));#20=IFCPOLYGONALFACESET(#1,.F.,(9),$);";
    let mut decoder = EntityDecoder::new(source);
    let entity = decoder.decode_by_id(20).unwrap();
    assert!(lower(&entity, &mut decoder, None)
        .unwrap_err()
        .to_string()
        .contains("entity reference for face"));
}

#[test]
fn pn_index_hole_refuses_whole_face_and_keeps_diagnostic_at_evaluation() {
    let source = "#1=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));#2=IFCINDEXEDPOLYGONALFACE((1,2,3));#20=IFCPOLYGONALFACESET(#1,.F.,(#2),(1,0,3));";
    let _ = crate::processors::take_face_refused();
    let plan = decoded(source.into(), None);
    assert!(crate::processors::take_face_refused().is_empty());
    assert!(plan.evaluate().is_empty());
    assert_eq!(
        crate::processors::take_face_refused(),
        [IfcType::IfcIndexedPolygonalFace]
    );
}

#[test]
fn owned_polygon_rtc_preserves_survey_detail_before_narrowing() {
    let source = "#1=IFCCARTESIANPOINTLIST3D(((8000000.,5000000.,0.),(8000000.01,5000000.,0.),(8000000.01,5000000.01,0.),(8000000.,5000000.01,0.)));#2=IFCINDEXEDPOLYGONALFACE((1,2,3,4));#20=IFCPOLYGONALFACESET(#1,.F.,(#2),$);";
    let mesh = decoded(source.into(), Some((8_000_000., 5_000_000., 0.))).evaluate();
    assert!(mesh.rtc_applied);
    assert!((signed_area(&mesh) - 0.0001).abs() < 1e-9);
    assert_eq!(mesh.indices.len(), 6);
}

#[test]
fn closed_polygon_shell_replay_respects_the_declared_winding_policy() {
    for closed in [".T.", ".F.", "$"] {
        let source = format!("#1=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));#2=IFCINDEXEDPOLYGONALFACE((1,2,3));#3=IFCINDEXEDPOLYGONALFACE((1,4,2));#4=IFCINDEXEDPOLYGONALFACE((1,3,4));#5=IFCINDEXEDPOLYGONALFACE((2,4,3));#20=IFCPOLYGONALFACESET(#1,{closed},(#2,#3,#4,#5),$);");
        let mesh = decoded(source, None).evaluate();
        let signed_volume = mesh
            .indices
            .chunks_exact(3)
            .map(|triangle| {
                let p = |index: u32| {
                    let offset = index as usize * 3;
                    [
                        f64::from(mesh.positions[offset]),
                        f64::from(mesh.positions[offset + 1]),
                        f64::from(mesh.positions[offset + 2]),
                    ]
                };
                let [a, b, c] = [p(triangle[0]), p(triangle[1]), p(triangle[2])];
                (a[0] * (b[1] * c[2] - b[2] * c[1])
                    + a[1] * (b[2] * c[0] - b[0] * c[2])
                    + a[2] * (b[0] * c[1] - b[1] * c[0]))
                    / 6.
            })
            .sum::<f64>();
        let sign = if closed == ".T." { 1. } else { -1. };
        assert!((signed_volume - sign / 6.).abs() < 1e-9);
    }
}
