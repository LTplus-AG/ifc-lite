// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::super::{transfer_math::*, transfer_surface::Observation};
use super::*;
use crate::appearance::tests::{apply, CONTROLLED_IFC};
fn identity() -> TransferFrame {
    TransferFrame {
        rotation: [[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]],
        source_anchor: [0.; 3],
        target_anchor: [0.; 3],
    }
}
fn fixture() -> (MeshTransferRequest, Vec<u8>) {
    let registration = ScanRegistrationRequest {
        source_frame: RegistrationFrame {
            asset_sha256: "a".repeat(64),
            frame_key: "synthetic-source".into(),
        },
        target_frame: RegistrationFrame {
            asset_sha256: format!("{:x}", Sha256::digest(CONTROLLED_IFC.as_bytes())),
            frame_key: "synthetic-target".into(),
        },
        fit: [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]]
            .into_iter()
            .enumerate()
            .map(|(i, p)| ScanCorrespondence {
                id: format!("fit{i}"),
                source_observation: format!("s{i}"),
                target_feature: format!("t{i}"),
                source: p,
                target: p,
            })
            .collect(),
        held_out: [[1., 1., 1.], [2., 1., 0.], [1., 2., 0.], [0., 1., 2.]]
            .into_iter()
            .enumerate()
            .map(|(i, p)| ScanCorrespondence {
                id: format!("check{i}"),
                source_observation: format!("cs{i}"),
                target_feature: format!("ct{i}"),
                source: p,
                target: p,
            })
            .collect(),
    };
    let registration_sha256 = register_scan_correspondences(&registration)
        .unwrap()
        .request_sha256;
    let mut rgba = vec![255, 0, 0, 255];
    rgba.extend([
        20, 80, 160, 255, 80, 160, 240, 255, 160, 40, 80, 255, 240, 80, 20, 255,
    ]);
    (
        MeshTransferRequest {
            schema: "IFC4".into(),
            source_revision: "synthetic-transfer".into(),
            next_express_id: 100,
            product_ids: vec![30],
            registration,
            registration_sha256,
            target_from_ifc_world: identity(),
            source_mesh: TransferSourceMesh {
                mesh_ordinal: 0,
                positions: vec![[0.2, 0.2, 5.], [0.6, 0.2, 5.], [0.2, 0.6, 5.]],
                triangles: vec![[0, 1, 2]],
                uvs: vec![[0., 0.], [1., 0.], [0., 1.]],
                base_color_factor: [1.; 4],
                repeat_s: false,
                repeat_t: false,
            },
            source_image: AppearanceRaster {
                width: 1,
                height: 1,
                byte_offset: 0,
                byte_length: 4,
            },
            source_images: vec![AppearanceSourceRaster {
                image_uri: "textures/wood.jpg".into(),
                raster: AppearanceRaster {
                    width: 2,
                    height: 2,
                    byte_offset: 4,
                    byte_length: 16,
                },
            }],
            texels_per_metre: 128.,
            max_distance_metres: 0.01,
            min_normal_dot: 0.9,
            ambiguity_distance_metres: 0.001,
        },
        rgba,
    )
}
fn color(
    mesh: &crate::types::mesh::MeshData,
    raster: Raster<'_>,
    point: Point,
    repeat: [bool; 2],
) -> [f64; 4] {
    for indices in mesh.indices.chunks_exact(3) {
        let points = std::array::from_fn(|i| {
            std::array::from_fn(|a| {
                f64::from(mesh.positions[indices[i] as usize * 3 + a]) + mesh.origin[a]
            })
        });
        let (weights, distance) = closest(points, point);
        if distance > 1e-12 {
            continue;
        }
        let uv: [f64; 2] = std::array::from_fn(|a| {
            indices
                .iter()
                .enumerate()
                .map(|(i, index)| {
                    weights[i] * f64::from(mesh.uvs.as_ref().unwrap()[*index as usize * 2 + a])
                })
                .sum()
        });
        let sampled = raster.sample([uv[0], 1. - uv[1]], repeat);
        return std::array::from_fn(|i| sampled[i] * f64::from(mesh.color[i]));
    }
    panic!("Point not on reopened target")
}
#[test]
fn issue_4381_partial_transfer_reopens_ifc_and_preserves_unknown_albedo() {
    let (request, rgba) = fixture();
    let result = plan_mesh_transfer(CONTROLLED_IFC.as_bytes(), &request, &rgba).unwrap();
    assert!(result.transfer.applicable);
    let coverage = &result.transfer.coverage;
    assert!(
        coverage.observed_area_estimate_m2 > 0.075 && coverage.observed_area_estimate_m2 < 0.11,
        "{coverage:?}"
    );
    assert!(
        (coverage.observed_area_estimate_m2 + coverage.unknown_area_estimate_m2 - 0.5).abs()
            < 1e-12
    );
    assert!(coverage.unknown_distance_samples > 0);
    let output = result.output.unwrap();
    assert!(output.plan.exclusions.is_empty());
    let reopened = crate::process_geometry(apply(CONTROLLED_IFC, &output.plan).as_bytes());
    let new = reopened.meshes.iter().find(|m| m.express_id == 30).unwrap();
    let before = crate::process_geometry(CONTROLLED_IFC.as_bytes());
    let old = before.meshes.iter().find(|m| m.express_id == 30).unwrap();
    for (a, b) in old.indices.iter().zip(&new.indices) {
        assert_eq!(
            &old.positions[*a as usize * 3..*a as usize * 3 + 3],
            &new.positions[*b as usize * 3..*b as usize * 3 + 3]
        );
    }
    let asset = &output.assets[0];
    let mut reader = png::Decoder::new(std::io::Cursor::new(&asset.png))
        .read_info()
        .unwrap();
    let mut bytes = vec![0; reader.output_buffer_size().unwrap()];
    reader.next_frame(&mut bytes).unwrap();
    let raster = Raster::new(asset.width, asset.height, &bytes).unwrap();
    let inside = color(new, raster, [0.3, 0.3, 5.], [false, false]);
    assert!(
        inside[0] > 0.98 && inside[1] < 0.02 && inside[2] < 0.02,
        "{inside:?}"
    );
    let outside = color(new, raster, [0.05, 0.1, 5.], [false, false]);
    let expected = color(
        old,
        Raster::supplied(&request.source_images[0].raster, &rgba).unwrap(),
        [0.05, 0.1, 5.],
        [true, false],
    );
    for (a, b) in outside.into_iter().zip(expected) {
        assert!((a - b).abs() < 0.025, "{outside:?} {expected:?}");
    }
}
#[test]
fn issue_4381_geometric_nearest_does_not_look_through_opposite_thinwall_face() {
    let (mut request, _) = fixture();
    request.source_mesh.positions = vec![
        [0., 0., 0.],
        [1., 0., 0.],
        [0., 1., 0.],
        [0., 0., 0.003],
        [1., 0., 0.003],
        [0., 1., 0.003],
    ];
    request.source_mesh.triangles = vec![[0, 2, 1], [3, 4, 5]];
    request.source_mesh.uvs = vec![[0., 0.]; 6];
    let mut budget = TransferBudget::new();
    let mut surface = Surface::new(&request, &identity(), &mut budget).unwrap();
    let observed = surface
        .observe([0.2, 0.2, 0.0001], [0., 0., 1.], &mut budget)
        .unwrap()
        .0;
    assert!(observed == Observation::Normal);
}
#[test]
fn issue_4381_overlap_and_uv_seams_are_unknown_but_continuous_shared_edges_are_valid() {
    let (mut request, _) = fixture();
    request.source_mesh.positions = vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [1., 1., 0.]];
    request.source_mesh.triangles = vec![[0, 1, 2], [1, 3, 2]];
    request.source_mesh.uvs = vec![[0., 0.], [1., 0.], [0., 1.], [1., 1.]];
    let observe = |request: &MeshTransferRequest| {
        let mut budget = TransferBudget::new();
        Surface::new(request, &identity(), &mut budget)
            .unwrap()
            .observe([0.5, 0.5, 0.], [0., 0., 1.], &mut budget)
            .unwrap()
            .0
    };
    assert!(observe(&request) == Observation::Observed);
    request.source_mesh.triangles.push([0, 1, 2]);
    assert!(observe(&request) == Observation::Ambiguous);
    request.source_mesh.triangles.pop();
    request
        .source_mesh
        .positions
        .extend([[1., 0., 0.], [0., 1., 0.]]);
    request.source_mesh.uvs.extend([[0., 0.], [0., 0.]]);
    request.source_mesh.triangles[1] = [4, 3, 5];
    assert!(observe(&request) == Observation::Ambiguous);
}
#[test]
fn issue_4381_stale_inputs_alpha_tint_frames_and_work_refuse_without_partial_plan() {
    let (request, rgba) = fixture();
    let mut stale = request.clone();
    stale.registration_sha256 = "0".repeat(64);
    assert!(plan_mesh_transfer(CONTROLLED_IFC.as_bytes(), &stale, &rgba)
        .unwrap_err()
        .contains("digest"));
    assert!(
        plan_mesh_transfer(format!("{CONTROLLED_IFC}\n").as_bytes(), &request, &rgba)
            .unwrap_err()
            .contains("snapshot")
    );
    let mut bad = request.clone();
    bad.source_mesh.base_color_factor[0] = 0.5;
    assert!(plan_mesh_transfer(CONTROLLED_IFC.as_bytes(), &bad, &rgba)
        .unwrap_err()
        .contains("baseColorFactor"));
    bad = request.clone();
    bad.target_from_ifc_world.rotation[0][0] = -1.;
    assert!(plan_mesh_transfer(CONTROLLED_IFC.as_bytes(), &bad, &rgba)
        .unwrap_err()
        .contains("proper-rigid"));
    let mut transparent = rgba.clone();
    transparent[3] = 0;
    assert!(
        plan_mesh_transfer(CONTROLLED_IFC.as_bytes(), &request, &transparent)
            .unwrap_err()
            .contains("opaque")
    );
    let mut budget = TransferBudget::new();
    let mut surface = Surface::new(&request, &identity(), &mut budget).unwrap();
    budget.work = 1;
    assert!(surface
        .observe([0.3, 0.3, 5.], [0., 0., 1.], &mut budget)
        .unwrap_err()
        .contains("budget"));
}
#[test]
fn issue_4381_explicit_workspace_transform_and_payload_digest_are_not_implicit_identity() {
    let (request, rgba) = fixture();
    let a = plan_mesh_transfer(CONTROLLED_IFC.as_bytes(), &request, &rgba).unwrap();
    let mut moved = request.clone();
    moved.target_from_ifc_world.target_anchor = [10., 0., 0.];
    let b = plan_mesh_transfer(CONTROLLED_IFC.as_bytes(), &moved, &rgba).unwrap();
    assert!(b.output.is_none());
    assert!(!b.transfer.applicable);
    assert_ne!(a.transfer.prepared_sha256, b.transfer.prepared_sha256);
    let mut pixels = rgba.clone();
    pixels[0] = 128;
    let c = plan_mesh_transfer(CONTROLLED_IFC.as_bytes(), &request, &pixels).unwrap();
    assert_ne!(a.transfer.prepared_sha256, c.transfer.prepared_sha256);
}

#[test]
fn issue_4381_insufficient_registration_checks_cannot_produce_applicable_transfer() {
    let (mut request, rgba) = fixture();
    request.registration.held_out.clear();
    request.registration_sha256 = register_scan_correspondences(&request.registration)
        .unwrap()
        .request_sha256;
    let result = plan_mesh_transfer(CONTROLLED_IFC.as_bytes(), &request, &rgba).unwrap();
    assert!(result.transfer.coverage.observed_samples > 0);
    assert!(!result.transfer.applicable);
    assert!(result.output.is_none());
    assert!(result.transfer.registration.held_out.rms_metres.is_none());
    assert!(!result.transfer.diagnostics.iter().any(|d|d.contains("No observed target samples")));
    assert!(result
        .transfer
        .diagnostics
        .iter()
        .any(|d| d.contains("Insufficient operational")));
}
#[test]
fn issue_4381_triangle_permutation_does_not_change_tie_refusal() {
    let (mut request, _) = fixture();
    request.source_mesh.positions = vec![
        [0., 0., 0.],
        [1., 0., 0.],
        [0., 1., 0.],
        [0., 0., 0.0005],
        [1., 0., 0.0005],
        [0., 1., 0.0005],
    ];
    request.source_mesh.triangles = vec![[0, 1, 2], [3, 4, 5]];
    request.source_mesh.uvs = vec![[0., 0.]; 6];
    for triangles in [
        vec![[0, 1, 2], [3, 4, 5]],
        vec![[3, 4, 5], [0, 1, 2]],
        vec![[0, 2, 1], [3, 4, 5]],
        vec![[3, 4, 5], [0, 2, 1]],
    ] {
        request.source_mesh.triangles = triangles;
        let mut budget = TransferBudget::new();
        let mut surface = Surface::new(&request, &identity(), &mut budget).unwrap();
        assert_eq!(
            surface
                .observe([0.2, 0.2, 0.00025], [0., 0., 1.], &mut budget)
                .unwrap()
                .0,
            Observation::Ambiguous
        );
    }
}

#[test]
fn issue_4381_target_exclusions_remain_visible_without_applicable_output() {
    let (mut request, rgba) = fixture();
    request.product_ids = vec![1];
    let result = plan_mesh_transfer(CONTROLLED_IFC.as_bytes(), &request, &rgba).unwrap();
    assert!(result.output.is_none());
    assert!(!result.transfer.applicable);
    assert_eq!(result.transfer.exclusions.len(), 1);
    assert_eq!(result.transfer.exclusions[0].product_id, 1);
    assert!(!result.transfer.exclusions[0].reason.is_empty());
}
