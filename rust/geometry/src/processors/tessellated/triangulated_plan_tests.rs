// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::processors::texture::{ImageTextureRef, TextureSource};

const POINTS: &str = "#1=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));";
fn decode_owned(content: String, rtc: Option<(f64, f64, f64)>) -> TriangulatedFaceSetPlan {
    let mut decoder = EntityDecoder::new(&content);
    let entity = decoder.decode_by_id(2).unwrap();
    lower(&entity, &mut decoder, rtc).unwrap()
}
fn close(actual: f32, expected: f32) {
    assert!((actual - expected).abs() < 1e-6, "{actual} != {expected}");
}
fn triangle_points(mesh: &Mesh) -> Vec<[[f32; 3]; 3]> {
    mesh.indices
        .chunks_exact(3)
        .map(|triangle| {
            [triangle[0], triangle[1], triangle[2]].map(|index| {
                let offset = index as usize * 3;
                [
                    mesh.positions[offset],
                    mesh.positions[offset + 1],
                    mesh.positions[offset + 2],
                ]
            })
        })
        .collect()
}
fn signed_volume(mesh: &Mesh) -> f64 {
    triangle_points(mesh)
        .iter()
        .map(|triangle| {
            let [a, b, c] = triangle.map(|point| point.map(f64::from));
            (a[0] * (b[1] * c[2] - b[2] * c[1])
                + a[1] * (b[2] * c[0] - b[0] * c[2])
                + a[2] * (b[0] * c[1] - b[1] * c[0]))
                / 6.
        })
        .sum()
}

#[test]
fn owned_construction_replays_pn_mapping_and_independent_flat_normals_after_decoder_disposal() {
    // Contradictory authored normals must preserve the existing flat-face policy.
    let plan = decode_owned(
        format!(
            "{POINTS}#2=IFCTRIANGULATEDFACESET(#1,((0.,0.,-1.)),.F.,((1,2,3),(4,2,3)),(4,2,3,1));"
        ),
        None,
    );
    let replay = plan.clone().evaluate();
    let mesh = plan.evaluate();
    let expected = vec![
        [[0., 0., 1.], [1., 0., 0.], [0., 1., 0.]],
        [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]],
    ];
    assert_eq!(triangle_points(&mesh), expected);
    assert_eq!(triangle_points(&replay), expected);
    assert_eq!(
        mesh.positions.len(),
        18,
        "corners remain split at the sharp edge"
    );
    let diagonal = 1.0 / 3.0f32.sqrt();
    for normal in mesh.normals[..9].chunks_exact(3) {
        for value in normal {
            close(*value, diagonal);
        }
    }
    for normal in mesh.normals[9..].chunks_exact(3) {
        assert_eq!(normal, [0., 0., 1.]);
    }
    assert!(!mesh.rtc_applied);
}

#[test]
fn malformed_indices_and_pn_holes_keep_the_same_faces_on_raw_and_decoded_paths() {
    for (coord_index, pn_index, expected) in [
        ("((1,2,3),(0,2,3),(1,-2,3),(1,2),(1,2,3,4),(2,3,4))", "$", 2),
        ("((1,2,3),(2,3,4))", "(0,4,2,3)", 1),
        ("((1,2,3),(1,2,4),(1,2,5))", "(4,2,3,9)", 1),
        // Legacy nested NormalIndex is not interpreted as PnIndex.
        ("((1,2,3))", "((1,1,1))", 1),
    ] {
        let content =
            format!("{POINTS}#2=IFCTRIANGULATEDFACESET(#1,$,.F.,{coord_index},{pn_index});");
        let fast = decode_owned(content.clone(), None).evaluate();
        let entity = EntityDecoder::new(&content).decode_by_id(2).unwrap();
        let plan = {
            let mut points_only = EntityDecoder::new(POINTS);
            assert!(points_only.get_raw_bytes(2).is_none());
            lower(&entity, &mut points_only, None).unwrap()
        };
        let decoded = plan.evaluate();
        assert_eq!(
            fast.indices.len() / 3,
            expected,
            "{coord_index}, {pn_index}"
        );
        assert_eq!(triangle_points(&decoded), triangle_points(&fast));
        assert!(fast.positions.iter().all(|value| value.is_finite()));
    }
}

#[test]
fn point_admission_refuses_unrepresentable_reals_once_in_both_coordinate_frames() {
    for value in ["1.E39", "1.E400"] {
        for rtc in [None, Some((0., 0., 0.))] {
            let content = format!("#1=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),({value},0.,0.),(0.,1.,0.)));#2=IFCTRIANGULATEDFACESET(#1,$,.F.,((1,2,3)),$);");
            let mut decoder = EntityDecoder::new(&content).with_strict_reals();
            let entity = decoder.decode_by_id(2).unwrap();
            assert!(lower(&entity, &mut decoder, rtc).is_err());
            assert!(lower(&entity, &mut decoder, rtc).is_err());
            assert_eq!(decoder.refused_record_ids(), [1]);
        }
    }
}

#[test]
fn rtc_is_applied_before_narrowing_and_survives_owned_plan_replay() {
    let content = "#1=IFCCARTESIANPOINTLIST3D(((8000000.,5000000.,0.),(8000000.01,5000000.,0.),(8000000.,5000000.01,0.)));#2=IFCTRIANGULATEDFACESET(#1,$,.F.,((1,2,3)),$);";
    let plan = decode_owned(content.to_string(), Some((8_000_000., 5_000_000., 0.)));
    let mesh = plan.evaluate();
    assert!(mesh.rtc_applied);
    assert_eq!(mesh.indices.len(), 3);
    let points = triangle_points(&mesh)[0];
    assert_eq!(points[0], [0., 0., 0.]);
    close(points[1][0], 0.01);
    close(points[2][1], 0.01);
    assert!(mesh
        .normals
        .chunks_exact(3)
        .all(|normal| normal == [0., 0., 1.]));
}

fn texture_map(explicit: bool) -> ResolvedTextureMap {
    ResolvedTextureMap {
        texture_id: 10,
        texture: TextureSource::Image(ImageTextureRef {
            url: "surface.png".into(),
            repeat_s: false,
            repeat_t: false,
        }),
        tex_coords: vec![[0.1, 0.2], [0.3, 0.4], [0.5, 0.6], [0.7, 0.8]],
        tex_coord_index: explicit.then_some(vec![[1, 2, 3], [1, 4, 2], [1, 3, 4], [2, 4, 3]]),
    }
}

#[test]
fn closed_orientation_replay_keeps_authored_uv_corners_in_lockstep() {
    for closed in [".T.", ".F.", "$"] {
        let content = format!("{POINTS}#2=IFCTRIANGULATEDFACESET(#1,$,{closed},((1,2,3),(1,4,2),(1,3,4),(2,4,3)),(1,2,3,4));");
        let plan = decode_owned(content, None);
        for explicit in [false, true] {
            let (mesh, uvs) = plan.clone().evaluate_with_texture(&texture_map(explicit));
            let sign = if closed == ".T." { 1. } else { -1. };
            assert!((signed_volume(&mesh) - sign / 6.).abs() < 1e-9);
            assert_eq!(uvs.len(), mesh.positions.len() / 3 * 2);
            // PnIndex is identity here; authored UV identity must remain paired
            // with each geometric corner even when the shell swaps its winding.
            for (point, uv) in mesh.positions.chunks_exact(3).zip(uvs.chunks_exact(2)) {
                let expected = match point {
                    [0., 0., 0.] => [0.1, 0.8],
                    [1., 0., 0.] => [0.3, 0.6],
                    [0., 1., 0.] => [0.5, 0.4],
                    [0., 0., 1.] => [0.7, 0.2],
                    _ => panic!("unexpected decoded point {point:?}"),
                };
                close(uv[0], expected[0]);
                close(uv[1], expected[1]);
            }
        }
    }
}

#[test]
fn terrain_subtype_reuses_inherited_triangle_construction() {
    let content = format!("{POINTS}#2=IFCTRIANGULATEDIRREGULARNETWORK(#1,$,.F.,((1,2,3)),$,$);");
    let plan = decode_owned(content, None);
    let mesh = plan.evaluate();
    assert_eq!(
        triangle_points(&mesh),
        vec![[[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]]]
    );
    assert!(mesh
        .normals
        .chunks_exact(3)
        .all(|normal| normal == [0., 0., 1.]));
}
