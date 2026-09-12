// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! RGB point-cloud transfer controls (#4381): opposite thin-wall faces observe
//! only their own side under every orientation source, holes stay unknown, the
//! payload is bound into the digest, and the shared budget refuses partial work.
use super::super::page_raster::Raster;
use super::super::transfer::acceptance_tests::{control, mesh, GREEN, THICKNESS, THIN_WALL_IFC, WALL};
use super::super::transfer::tests::{color, identity};
use super::super::transfer::{plan_mesh_transfer, plan_point_transfer};
use super::super::transfer_target::TargetTriangle;
use super::*;
use crate::appearance::tests::apply;
use crate::appearance::{register_scan_correspondences, AppearanceRaster, MeshTransferPlan};

const RED: [u8; 3] = [255, 0, 0];
const BLUE: [u8; 3] = [0, 0, 255];
/// Deterministic jitter in (-1, 1) so the sheets carry realistic noise.
fn jitter(i: usize, salt: u32) -> f64 {
    let mut h = (i as u32).wrapping_mul(2_654_435_761).wrapping_add(salt.wrapping_mul(40_503));
    h ^= h >> 15;
    h = h.wrapping_mul(2_246_822_519);
    h ^= h >> 13;
    f64::from(h % 20_001) / 10_000. - 1.
}
#[derive(Default, Clone)]
struct Cloud {
    positions: Vec<f64>,
    colors: Vec<u8>,
    normals: Vec<f32>,
    stations: Vec<u32>,
}
/// XZ sheet at `y` over `x` × 0..1 at `spacing`, with ±`noise` along Y.
struct Sheet {
    y: f64,
    x: [f64; 2],
    spacing: f64,
    noise: f64,
    color: [u8; 3],
}
impl Cloud {
    /// Add a sheet facing -Y (station 0, 2 m in front) or +Y (station 1, 2 m behind).
    fn sheet(&mut self, sheet: Sheet, facing_negative_y: bool) {
        let Sheet { y, x, spacing, noise, color } = sheet;
        let station = u32::from(!facing_negative_y);
        let (nx, nz) = (((x[1] - x[0]) / spacing).round() as usize, (1. / spacing).round() as usize);
        let sign = if facing_negative_y { -1. } else { 1. };
        for i in 0..=nx {
            for k in 0..=nz {
                let index = self.positions.len() / 3;
                let px = x[0] + i as f64 * spacing + jitter(index, 1) * spacing * 0.2;
                let pz = k as f64 * spacing + jitter(index, 2) * spacing * 0.2;
                self.positions.extend([px.clamp(x[0], x[1]), y + jitter(index, 3) * noise, pz.clamp(0., 1.)]);
                self.colors.extend(color);
                self.normals.extend([0., sign as f32, 0.]);
                self.stations.push(station);
            }
        }
    }
    fn payload(&self, orientation: PointOrientation) -> TransferPointPayload<'_> {
        TransferPointPayload {
            positions: &self.positions,
            colors: &self.colors,
            normals: if orientation == PointOrientation::SourceNormals { &self.normals } else { &[] },
            stations: if orientation == PointOrientation::Viewpoints { &self.stations } else { &[] },
        }
    }
}
fn spec(cloud: &Cloud, orientation: PointOrientation) -> TransferSourcePoints {
    TransferSourcePoints {
        point_count: (cloud.positions.len() / 3) as u32,
        orientation,
        neighborhood_radius_metres: 0.03,
        min_neighbors: 4,
        max_neighbors: 32,
        surface_band_metres: 0.003,
        viewpoints: if orientation == PointOrientation::Viewpoints { vec![[0.5, -2., 0.5], [0.5, 2., 0.5]] } else { vec![] },
    }
}
fn point_request(cloud: &Cloud, orientation: PointOrientation, max_behind: f64) -> (MeshTransferRequest, Vec<u8>) {
    let (mut request, _) = control(mesh(), 0.02, max_behind);
    request.source = TransferSource::Points(spec(cloud, orientation));
    request.source_image = None;
    (request, Vec::new())
}
struct Baked {
    plan: MeshTransferPlan,
    wall: crate::types::mesh::MeshData,
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}
impl Baked {
    fn new(cloud: &Cloud, orientation: PointOrientation, max_behind: f64) -> Self {
        let (request, rgba) = point_request(cloud, orientation, max_behind);
        let plan = plan_point_transfer(THIN_WALL_IFC.as_bytes(), &request, &rgba, &cloud.payload(orientation)).unwrap();
        assert_eq!(plan.transfer.source.kind, "points");
        assert_eq!(plan.transfer.source.orientation, Some(orientation));
        let (wall, width, height, pixels) = {
            let output = plan.output.as_ref().expect("applicable point transfer");
            assert!(output.plan.exclusions.is_empty());
            let reopened = crate::process_geometry(apply(THIN_WALL_IFC, &output.plan).as_bytes());
            let wall = reopened.meshes.iter().find(|m| m.express_id == WALL).unwrap().clone();
            let asset = &output.assets[0];
            let mut reader = png::Decoder::new(std::io::Cursor::new(&asset.png)).read_info().unwrap();
            let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
            reader.next_frame(&mut pixels).unwrap();
            (wall, asset.width, asset.height, pixels)
        };
        Self { plan, wall, width, height, pixels }
    }
    #[track_caller]
    fn expect(&self, point: Point, expected: [f64; 4]) {
        let actual = color(&self.wall, Raster::new(self.width, self.height, &self.pixels).unwrap(), point, [false, false]);
        for (a, e) in actual.iter().zip(expected) {
            assert!((a - e).abs() < 0.03, "{point:?}: {actual:?} != {expected:?}");
        }
    }
}
const ALL: [PointOrientation; 3] = [PointOrientation::SourceNormals, PointOrientation::Viewpoints, PointOrientation::TargetReferenced];
const RED_RGBA: [f64; 4] = [1., 0., 0., 1.];
const BLUE_RGBA: [f64; 4] = [0., 0., 1., 1.];

#[test]
fn issue_4381_point_cloud_thin_wall_faces_observe_only_their_own_side_under_every_orientation() {
    // Both faces of the 4 mm partition scanned 1 mm outside at 5 mm spacing
    // with ±1 mm noise; the back capture stops at x = 0.5. The 20 mm distance
    // bound and the default 10 mm behind bound both exceed the wall thickness,
    // so nothing but orientation or self-occlusion can keep the sides apart.
    let mut cloud = Cloud::default();
    cloud.sheet(Sheet { y: -0.001, x: [0., 1.], spacing: 0.005, noise: 0.001, color: RED }, true);
    cloud.sheet(Sheet { y: THICKNESS + 0.001, x: [0., 0.5], spacing: 0.005, noise: 0.001, color: BLUE }, false);
    for orientation in ALL {
        let baked = Baked::new(&cloud, orientation, 0.01);
        let coverage = &baked.plan.transfer.coverage;
        println!("{orientation:?} coverage {coverage:?}");
        assert!(baked.plan.transfer.applicable);
        assert!(coverage.observed_raster_interior_texels > 0);
        let total = coverage.observed_area_estimate_m2 + coverage.unknown_area_estimate_m2;
        assert!((total - 2.).abs() < 1e-9, "{coverage:?}");
        assert!(coverage.observed_area_estimate_m2 > 1.4 && coverage.observed_area_estimate_m2 < 1.6, "{orientation:?} {coverage:?}");
        assert_eq!(coverage.unknown_distance_samples, 0, "{coverage:?}");
        // The uncaptured back half refuses the red front capture: by its normal
        // when the points carry an orientation, by self-occlusion otherwise.
        match orientation {
            PointOrientation::TargetReferenced => assert!(coverage.unknown_behind_samples > 0 && coverage.unknown_normal_samples == 0, "{coverage:?}"),
            _ => assert!(coverage.unknown_normal_samples > 0, "{coverage:?}"),
        }
        baked.expect([0.3, 0., 0.5], RED_RGBA);
        baked.expect([0.8, 0., 0.5], RED_RGBA);
        baked.expect([0.3, THICKNESS, 0.5], BLUE_RGBA);
        baked.expect([0.8, THICKNESS, 0.5], GREEN);
    }
}
#[test]
fn issue_4381_point_cloud_holes_and_clutter_stay_unknown_and_colour_is_a_surface_estimate() {
    // Front capture with a hole over x in [0.4, 0.6] and no back capture: the
    // hole and the whole back face keep the prior IFC appearance.
    let mut cloud = Cloud::default();
    cloud.sheet(Sheet { y: -0.001, x: [0., 0.4], spacing: 0.005, noise: 0.001, color: RED }, true);
    cloud.sheet(Sheet { y: -0.001, x: [0.6, 1.], spacing: 0.005, noise: 0.001, color: RED }, true);
    let baked = Baked::new(&cloud, PointOrientation::TargetReferenced, 0.01);
    let coverage = &baked.plan.transfer.coverage;
    assert!(coverage.unknown_distance_samples > 0, "{coverage:?}");
    baked.expect([0.2, 0., 0.5], RED_RGBA);
    baked.expect([0.5, 0., 0.5], GREEN);
    baked.expect([0.5, THICKNESS, 0.5], GREEN);
    // Two sheets 8 mm apart inside one support exceed the 3 mm surface band:
    // ambiguous, never averaged into a colour neither sheet has.
    let mut layered = cloud.clone();
    layered.sheet(Sheet { y: -0.009, x: [0., 0.4], spacing: 0.005, noise: 0., color: BLUE }, true);
    let (request, rgba) = point_request(&layered, PointOrientation::TargetReferenced, 0.01);
    let plan = plan_point_transfer(THIN_WALL_IFC.as_bytes(), &request, &rgba, &layered.payload(PointOrientation::TargetReferenced)).unwrap();
    assert!(plan.transfer.coverage.unknown_ambiguous_samples > 0, "{:?}", plan.transfer.coverage);
    // A capture too thin for a plane fit is sparse, not the nearest colour.
    let mut sparse = Cloud::default();
    sparse.sheet(Sheet { y: -0.001, x: [0., 1.], spacing: 0.05, noise: 0., color: RED }, true);
    let (request, rgba) = point_request(&sparse, PointOrientation::TargetReferenced, 0.01);
    let plan = plan_point_transfer(THIN_WALL_IFC.as_bytes(), &request, &rgba, &sparse.payload(PointOrientation::TargetReferenced)).unwrap();
    let coverage = &plan.transfer.coverage;
    assert!(coverage.unknown_sparse_samples > 0 && coverage.observed_samples == 0, "{coverage:?}");
    assert!(!plan.transfer.applicable && plan.output.is_none());
}
#[test]
fn issue_4381_point_payload_is_validated_digested_and_budget_bounded() {
    let mut cloud = Cloud::default();
    cloud.sheet(Sheet { y: -0.001, x: [0., 1.], spacing: 0.01, noise: 0.001, color: RED }, true);
    let (request, rgba) = point_request(&cloud, PointOrientation::TargetReferenced, 0.01);
    let payload = cloud.payload(PointOrientation::TargetReferenced);
    let bytes = THIN_WALL_IFC;
    let a = plan_point_transfer(bytes.as_bytes(), &request, &rgba, &payload).unwrap();
    let mut recoloured = cloud.clone();
    recoloured.colors[0] = 7;
    let b = plan_point_transfer(bytes.as_bytes(), &request, &rgba, &recoloured.payload(PointOrientation::TargetReferenced)).unwrap();
    assert_ne!(a.transfer.prepared_sha256, b.transfer.prepared_sha256, "point bytes are bound into the digest");
    // Orientation must match the payload: nothing is silently ignored.
    for (orientation, payload) in [
        (PointOrientation::SourceNormals, cloud.payload(PointOrientation::TargetReferenced)),
        (PointOrientation::Viewpoints, cloud.payload(PointOrientation::TargetReferenced)),
        (PointOrientation::TargetReferenced, cloud.payload(PointOrientation::SourceNormals)),
        (PointOrientation::TargetReferenced, cloud.payload(PointOrientation::Viewpoints)),
    ] {
        let (mismatched, rgba) = point_request(&cloud, orientation, 0.01);
        assert!(plan_point_transfer(bytes.as_bytes(), &mismatched, &rgba, &payload).unwrap_err().contains("orientation"), "{orientation:?}");
    }
    let mut short = request.clone();
    if let TransferSource::Points(spec) = &mut short.source { spec.point_count -= 1; }
    assert!(plan_point_transfer(bytes.as_bytes(), &short, &rgba, &payload).unwrap_err().contains("point payload"));
    let mut wide = request.clone();
    if let TransferSource::Points(spec) = &mut wide.source { spec.surface_band_metres = 1.; }
    assert!(plan_point_transfer(bytes.as_bytes(), &wide, &rgba, &payload).unwrap_err().contains("surface band"));
    let mut imaged = request.clone();
    imaged.source_image = Some(AppearanceRaster { width: 1, height: 1, byte_offset: 0, byte_length: 4 });
    assert!(plan_point_transfer(bytes.as_bytes(), &imaged, &[255; 4], &payload).unwrap_err().contains("per point"));
    assert!(plan_mesh_transfer(bytes.as_bytes(), &request, &rgba).unwrap_err().contains("binary point payload"));
    // Stale registration and target snapshots refuse exactly as for meshes.
    let mut stale = request.clone();
    stale.registration_sha256 = "0".repeat(64);
    assert!(plan_point_transfer(bytes.as_bytes(), &stale, &rgba, &payload).unwrap_err().contains("digest"));
    let unchanged = register_scan_correspondences(&request.registration).unwrap().request_sha256;
    assert_eq!(unchanged, request.registration_sha256);
    // Budget exhaustion is an error, never a partial plan.
    let (spec, frame) = (match &request.source { TransferSource::Points(spec) => spec.clone(), _ => unreachable!() }, identity());
    let mut budget = TransferBudget::new();
    let mut surface = PointSurface::new(&request, &spec, &payload, &frame, &mut budget).unwrap();
    let targets = [TargetTriangle { points: [[0., 0., 0.], [1., 0., 0.], [1., 0., 1.]], normal: [0., -1., 0.], area: 0.5 }];
    let mut occluder = Occluder::new(&targets, &mut budget).unwrap();
    assert_eq!(surface.observe([0.5, 0., 0.5], [0., -1., 0.], &mut occluder, &mut budget).unwrap().0, Observation::Observed);
    budget.work = 2;
    assert!(surface.observe([0.5, 0., 0.5], [0., -1., 0.], &mut occluder, &mut budget).unwrap_err().contains("budget"));
}
#[test]
fn issue_4381_request_source_is_a_tagged_union_with_denied_unknown_fields() {
    let mut cloud = Cloud::default();
    cloud.sheet(Sheet { y: -0.001, x: [0., 1.], spacing: 0.05, noise: 0., color: RED }, true);
    let (request, _) = point_request(&cloud, PointOrientation::Viewpoints, 0.01);
    let json = serde_json::to_value(&request).unwrap();
    assert_eq!(json["source"]["kind"], "points");
    assert_eq!(json["source"]["orientation"], "viewpoints");
    assert!(json["source"]["pointCount"].is_number() && json.get("sourceImage").is_none_or(|v| v.is_null()));
    let (mesh_request, _) = control(mesh(), 0.02, 0.01);
    let mesh_json = serde_json::to_value(&mesh_request).unwrap();
    assert_eq!(mesh_json["source"]["kind"], "mesh");
    assert!(mesh_json["source"]["positions"].is_array() && mesh_json["sourceImage"]["width"] == 3);
    let back: MeshTransferRequest = serde_json::from_value(json.clone()).unwrap();
    assert!(matches!(back.source, TransferSource::Points(_)));
    let mut unknown = json.clone();
    unknown["source"]["gaussianRadius"] = serde_json::json!(0.1);
    assert!(serde_json::from_value::<MeshTransferRequest>(unknown).is_err(), "unknown point fields are refused");
    let mut untagged = json;
    untagged["source"].as_object_mut().unwrap().remove("kind");
    assert!(serde_json::from_value::<MeshTransferRequest>(untagged).is_err());
}
