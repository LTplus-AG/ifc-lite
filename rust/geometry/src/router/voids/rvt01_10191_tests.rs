// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! rvt01 `#10191` as it reaches `try_cut_wall_local_frame`: a 12 mm plan-
//! rotated panel with two authored through-openings, the second of which is
//! extruded 3.7e-5 rad off the panel normal (Revit placement noise) and sits
//! flush with the panel's bottom edge. 0e8a42175 handed that near-axis depth
//! to the rectangular cut verbatim and the host came back with 15 open edges
//! in the watertightness census; the fixture-free copy pins it on PR CI.

use super::*;

fn mesh(positions: &[f32], indices: &[u32]) -> Mesh {
    let mut mesh = Mesh::new();
    mesh.positions.extend_from_slice(positions);
    mesh.normals.resize(positions.len(), 0.0);
    for normal in mesh.normals.chunks_exact_mut(3) {
        normal[2] = 1.0;
    }
    mesh.indices.extend_from_slice(indices);
    mesh
}
const HOST_POSITIONS: &[f32] = &[
    12.723104, 2.551245, 4.35, 12.723104, 2.551245, 0.4,
    12.694873, 2.5766814, 0.4, 12.491313, 2.7600913, 0.4,
    12.491313, 2.7600913, 0.5, 12.694873, 2.5766814, 2.73,
    12.491313, 2.7600913, 2.73, 12.491313, 2.7600913, 3.015,
    12.499485, 2.7527282, 3.035, 12.491313, 2.7600913, 3.035,
    12.491313, 2.7600913, 3.5, 12.491313, 2.7600913, 4.35,
    12.694873, 2.5766814, 0.5, 12.499485, 2.7527282, 3.015,
    12.715072, 2.54233, 0.4, 12.48328, 2.7511764, 0.5,
    12.48328, 2.7511764, 0.4, 12.68684, 2.5677664, 2.73,
    12.48328, 2.7511764, 3.015, 12.48328, 2.7511764, 2.73,
    12.491452, 2.743813, 3.035, 12.48328, 2.7511764, 4.35,
    12.48328, 2.7511764, 3.035, 12.68684, 2.5677664, 0.5,
    12.491452, 2.743813, 3.015, 12.715072, 2.54233, 4.35,
    12.694873, 2.5766814, 0.4, 12.48328, 2.7511764, 0.4,
    12.491313, 2.7600913, 0.4, 12.723104, 2.551245, 0.4,
    12.715072, 2.54233, 0.4, 12.723104, 2.551245, 4.35,
    12.491313, 2.7600913, 4.35, 12.48328, 2.7511764, 4.35,
    12.715072, 2.54233, 4.35, 12.723104, 2.551245, 0.4,
    12.723104, 2.551245, 4.35, 12.715072, 2.54233, 4.35,
    12.715072, 2.54233, 0.4, 12.694873, 2.5766814, 0.5,
    12.68684, 2.5677664, 0.5, 12.68684, 2.5677664, 2.73,
    12.694873, 2.5766814, 2.73, 12.694873, 2.5766814, 2.73,
    12.68684, 2.5677664, 2.73, 12.48328, 2.7511764, 2.73,
    12.491313, 2.7600913, 2.73, 12.68684, 2.5677664, 0.5,
    12.694873, 2.5766814, 0.5, 12.491313, 2.7600913, 0.5,
    12.48328, 2.7511764, 0.5, 12.491313, 2.7600913, 3.035,
    12.48328, 2.7511764, 3.035, 12.48328, 2.7511764, 4.35,
    12.491313, 2.7600913, 4.35, 12.491313, 2.7600913, 3.5,
    12.491452, 2.743813, 3.035, 12.499485, 2.7527282, 3.035,
    12.499485, 2.7527282, 3.015, 12.491452, 2.743813, 3.015,
    12.491452, 2.743813, 3.015, 12.499485, 2.7527282, 3.015,
    12.491313, 2.7600913, 3.015, 12.48328, 2.7511764, 3.015,
    12.499485, 2.7527282, 3.035, 12.491452, 2.743813, 3.035,
    12.48328, 2.7511764, 3.035, 12.491313, 2.7600913, 3.035,
    12.491313, 2.7600913, 0.4, 12.48328, 2.7511764, 0.4,
    12.48328, 2.7511764, 0.5, 12.491313, 2.7600913, 0.5,
    12.491313, 2.7600913, 2.73, 12.48328, 2.7511764, 2.73,
    12.48328, 2.7511764, 3.015, 12.491313, 2.7600913, 3.015,
];
const HOST_INDICES: &[u32] = &[
    0, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    10, 11, 0, 2, 4, 12, 5, 7, 13, 8, 10, 0,
    0, 2, 12, 5, 13, 8, 0, 12, 5, 5, 8, 0,
    14, 15, 16, 17, 18, 19, 20, 21, 22, 14, 23, 15,
    17, 24, 18, 20, 25, 21, 25, 23, 14, 17, 20, 24,
    25, 17, 23, 17, 25, 20, 26, 27, 28, 27, 29, 30,
    29, 27, 26, 31, 32, 33, 31, 33, 34, 35, 36, 37,
    35, 37, 38, 39, 40, 41, 39, 41, 42, 43, 44, 45,
    43, 45, 46, 47, 48, 49, 47, 49, 50, 51, 52, 53,
    53, 54, 55, 55, 51, 53, 56, 57, 58, 56, 58, 59,
    60, 61, 62, 60, 62, 63, 64, 65, 66, 64, 66, 67,
    68, 69, 70, 68, 70, 71, 72, 73, 74, 72, 74, 75,
];
const CUTTER_0_POSITIONS: &[f32] = &[
    13.390887, 3.3491638, 2.73, 13.187326, 3.5325735, 2.73,
    13.187326, 3.5325735, 0.5, 13.390887, 3.3491638, 0.5,
    13.390887, 3.3491638, 2.73, 12.681345, 2.5616674, 2.73,
    12.477785, 2.7450774, 2.73, 12.477785, 2.7450774, 0.5,
    12.681345, 2.5616674, 0.5, 12.681345, 2.5616674, 2.73,
    13.390887, 3.3491638, 2.73, 13.187326, 3.5325735, 2.73,
    12.477785, 2.7450774, 2.73, 12.681345, 2.5616674, 2.73,
    13.187326, 3.5325735, 2.73, 13.187326, 3.5325735, 0.5,
    12.477785, 2.7450774, 0.5, 12.477785, 2.7450774, 2.73,
    13.187326, 3.5325735, 0.5, 13.390887, 3.3491638, 0.5,
    12.681345, 2.5616674, 0.5, 12.477785, 2.7450774, 0.5,
    13.390887, 3.3491638, 0.5, 13.390887, 3.3491638, 2.73,
    12.681345, 2.5616674, 2.73, 12.681345, 2.5616674, 0.5,
];
const CUTTER_0_INDICES: &[u32] = &[
    2, 0, 3, 0, 2, 1, 7, 8, 5, 5, 6, 7,
    10, 11, 12, 10, 12, 13, 14, 15, 16, 14, 16, 17,
    18, 19, 20, 18, 20, 21, 22, 23, 24, 22, 24, 25,
];
const CUTTER_1_POSITIONS: &[f32] = &[
    16.708542, 7.4242153, 3.035, 16.700369, 7.431578, 3.035,
    16.700369, 7.431578, 3.015, 16.708542, 7.4242153, 3.015,
    16.708542, 7.4242153, 3.035, 12.491452, 2.743813, 3.035,
    12.48328, 2.751176, 3.035, 12.48328, 2.751176, 3.015,
    12.491452, 2.743813, 3.015, 12.491452, 2.743813, 3.035,
    16.708542, 7.4242153, 3.035, 16.700369, 7.431578, 3.035,
    12.48328, 2.751176, 3.035, 12.491452, 2.743813, 3.035,
    16.700369, 7.431578, 3.035, 16.700369, 7.431578, 3.015,
    12.48328, 2.751176, 3.015, 12.48328, 2.751176, 3.035,
    16.700369, 7.431578, 3.015, 16.708542, 7.4242153, 3.015,
    12.491452, 2.743813, 3.015, 12.48328, 2.751176, 3.015,
    16.708542, 7.4242153, 3.015, 16.708542, 7.4242153, 3.035,
    12.491452, 2.743813, 3.035, 12.491452, 2.743813, 3.015,
];
const CUTTER_1_INDICES: &[u32] = &[
    2, 0, 3, 0, 2, 1, 7, 8, 5, 5, 6, 7,
    10, 11, 12, 10, 12, 13, 14, 15, 16, 14, 16, 17,
    18, 19, 20, 18, 20, 21, 22, 23, 24, 22, 24, 25,
];

#[test]
fn rvt01_panel_10191_stays_closed_with_a_near_normal_authored_cutter_3977() {
    let host = mesh(HOST_POSITIONS, HOST_INDICES);
    let openings = vec![
        OpeningType::DiagonalRectangular(
            mesh(CUTTER_0_POSITIONS, CUTTER_0_INDICES),
            OpeningFrame {
                depth: Vector3::new(-0.6693789782214576, -0.7429211152707919, 0.0),
                cross_a: Vector3::new(0.0, 0.0, 1.0),
                cross_b: Vector3::new(-0.742921115270792, 0.6693789782214578, 0.0),
                depth_is_authored: true,
            },
        ),
        OpeningType::DiagonalRectangular(
            mesh(CUTTER_1_POSITIONS, CUTTER_1_INDICES),
            OpeningFrame {
                depth: Vector3::new(-0.669351422548015, -0.7429459422683111, 0.0),
                cross_a: Vector3::new(0.0, 0.0, 1.0),
                cross_b: Vector3::new(-0.7429459422683111, 0.669351422548015, 0.0),
                depth_is_authored: true,
            },
        ),
    ];
    let cut = |openings: Vec<OpeningType>| {
        let context = VoidContext {
            merged_openings: openings.clone(),
            openings,
            param: None,
            bool2d: None,
        };
        let bounds = world_host_bounds(&host);
        GeometryRouter::new().apply_void_context_inner(host.clone(), &context, 10191, bounds, true)
    };
    let host_volume = mesh_signed_volume(&host).abs();
    let wide_only = mesh_signed_volume(&cut(vec![openings[0].clone()])).abs();
    let output = cut(openings);
    let both = mesh_signed_volume(&output).abs();
    assert!(
        mesh_is_closed_exact(&output),
        "the panel must stay watertight after both through-cuts ({} tris)",
        output.triangle_count()
    );
    assert!(wide_only < host_volume - 1.0e-6, "the wide opening must cut the panel");
    assert!(both <= wide_only + 1.0e-9, "adding the pin must never give the panel volume back");
    // The pin's own volume is deliberately NOT pinned: it sits flush with the
    // panel's bottom edge and 0.2 um inside the +normal face, so what it
    // removes is placement-dependent (alone it shifts the volume by ~6e-6 m^3
    // through the frame round-trip; after the wide cut, by ~0). This replay
    // exists for the watertightness gate above, not for the pin's volume.
}
