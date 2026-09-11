// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Controlled thin-wall, occlusion and missing-region acceptance (#4381).
//! Synthetic fixtures supplement real capture validation; they never replace it.
use super::super::{transfer_budget::TransferBudget, transfer_math::Point, transfer_surface::{Observation, Surface}};
use super::tests::{color, identity};
use super::*;
use crate::appearance::tests::apply;

/// One IfcWall whose only body is a 4 mm partition: two 1 m² faces, front at
/// y=0 facing -Y and back at y=0.004 facing +Y, styled solid green.
const THIN_WALL_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-4381 thin wall transfer control'),'2;1');
FILE_NAME('thinwall.ifc','2026-09-11T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6e',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40=IFCWALL('1ThinWall0000000000000',$,'Partition',$,$,#41,#42,$,$);
#41=IFCLOCALPLACEMENT($,#5);
#42=IFCPRODUCTDEFINITIONSHAPE($,$,(#43));
#43=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#44));
#44=IFCTRIANGULATEDFACESET(#45,$,.F.,((1,2,3),(1,3,4),(5,7,6),(5,8,7)),$);
#45=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(1.,0.,1.),(0.,0.,1.),(0.,0.004,0.),(1.,0.004,0.),(1.,0.004,1.),(0.,0.004,1.)));
#46=IFCSTYLEDITEM(#44,(#47),$);
#47=IFCSURFACESTYLE('Plaster',.BOTH.,(#48));
#48=IFCSURFACESTYLERENDERING(#49,0.,$,$,$,$,$,$,.NOTDEFINED.);
#49=IFCCOLOURRGB($,0.,1.,0.);
ENDSEC;
END-ISO-10303-21;
"#;
const WALL: u32 = 40;
const THICKNESS: f64 = 0.004;
/// Constant UVs at the centre of one pixel of the 3×1 red/blue/yellow image.
const RED: [f64; 2] = [1. / 6., 0.5];
const BLUE: [f64; 2] = [0.5, 0.5];
const YELLOW: [f64; 2] = [5. / 6., 0.5];
const RED_RGBA: [f64; 4] = [1., 0., 0., 1.];
const BLUE_RGBA: [f64; 4] = [0., 0., 1., 1.];
const YELLOW_RGBA: [f64; 4] = [1., 1., 0., 1.];
/// The wall's prior solid appearance, expected wherever a sample is unknown.
const GREEN: [f64; 4] = [0., 1., 0., 1.];

fn control(source_mesh: TransferSourceMesh, max_distance_metres: f64, max_behind_metres: f64) -> (MeshTransferRequest, Vec<u8>) {
    let pair = |kind: &str, i: usize, p: Point| ScanCorrespondence {
        id: format!("{kind}{i}"), source_observation: format!("{kind}-scan{i}"), target_feature: format!("{kind}-ifc{i}"), source: p, target: p,
    };
    let registration = ScanRegistrationRequest {
        source_frame: RegistrationFrame { asset_sha256: "b".repeat(64), frame_key: "controlled-scan".into() },
        target_frame: RegistrationFrame { asset_sha256: format!("{:x}", Sha256::digest(THIN_WALL_IFC.as_bytes())), frame_key: "controlled-wall".into() },
        fit: [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]].into_iter().enumerate().map(|(i, p)| pair("fit", i, p)).collect(),
        held_out: [[1., 1., 1.], [2., 1., 0.], [1., 2., 0.], [0., 1., 2.]].into_iter().enumerate().map(|(i, p)| pair("check", i, p)).collect(),
    };
    let registration_sha256 = register_scan_correspondences(&registration).unwrap().request_sha256;
    let rgba = vec![255, 0, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255];
    (MeshTransferRequest {
        schema: "IFC4".into(), source_revision: "thin-wall-control".into(), next_express_id: 100, product_ids: vec![WALL],
        registration, registration_sha256, target_from_ifc_world: identity(), source_mesh,
        source_image: AppearanceRaster { width: 3, height: 1, byte_offset: 0, byte_length: 12 }, source_images: vec![],
        texels_per_metre: 64., max_distance_metres, min_normal_dot: 0.8, ambiguity_distance_metres: 0.001, max_behind_metres,
    }, rgba)
}
fn mesh() -> TransferSourceMesh {
    TransferSourceMesh { mesh_ordinal: 0, positions: vec![], triangles: vec![], uvs: vec![], base_color_factor: [1.; 4], repeat_s: false, repeat_t: false }
}
/// Scanned XZ quad at height `y` over `x` × `0..1`, wound to face -Y or +Y.
fn quad(mesh: &mut TransferSourceMesh, y: f64, x: [f64; 2], facing_negative_y: bool, uv: [f64; 2]) {
    let base = mesh.positions.len() as u32;
    mesh.positions.extend([[x[0], y, 0.], [x[1], y, 0.], [x[1], y, 1.], [x[0], y, 1.]]);
    mesh.uvs.extend([uv; 4]);
    let [a, b, c, d] = [base, base + 1, base + 2, base + 3];
    if facing_negative_y { mesh.triangles.extend([[a, b, c], [a, c, d]]); } else { mesh.triangles.extend([[a, c, b], [a, d, c]]); }
}
struct Baked { plan: MeshTransferPlan, wall: crate::types::mesh::MeshData, width: u32, height: u32, pixels: Vec<u8> }
impl Baked {
    /// Plan, apply to the actual IFC text, reopen through the production
    /// geometry pipeline and decode the emitted atlas.
    fn new(request: &MeshTransferRequest, rgba: &[u8]) -> Self {
        let plan = plan_mesh_transfer(THIN_WALL_IFC.as_bytes(), request, rgba).unwrap();
        let (wall, width, height, pixels) = {
            let output = plan.output.as_ref().expect("applicable controlled transfer");
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
    fn coverage(&self) -> &TransferCoverage { &self.plan.transfer.coverage }
    fn at(&self, point: Point) -> [f64; 4] {
        color(&self.wall, Raster::new(self.width, self.height, &self.pixels).unwrap(), point, [false, false])
    }
    #[track_caller]
    fn expect(&self, point: Point, expected: [f64; 4]) {
        let actual = self.at(point);
        for (a, e) in actual.iter().zip(expected) {
            assert!((a - e).abs() < 0.03, "{point:?}: {actual:?} != {expected:?}");
        }
    }
}

#[test]
fn issue_4381_thin_wall_faces_observe_only_their_own_side_and_gaps_stay_unknown() {
    // Both faces of a 4 mm partition are scanned 1 mm outside the IFC faces;
    // the back capture stops at x = 0.5. The 20 mm distance bound is five times
    // the wall thickness, so the opposite capture is always within reach.
    let mut source = mesh();
    quad(&mut source, -0.001, [0., 1.], true, RED);
    quad(&mut source, THICKNESS + 0.001, [0., 0.5], false, BLUE);
    let (request, rgba) = control(source, 0.02, 0.005);
    let baked = Baked::new(&request, &rgba);
    let coverage = baked.coverage();
    println!("thin-wall coverage {coverage:?}");
    assert!(baked.plan.transfer.applicable);
    assert!(coverage.observed_raster_interior_texels > 0);
    assert_eq!(coverage.unknown_ambiguous_samples, 0, "{coverage:?}");
    assert_eq!(coverage.unknown_distance_samples, 0, "{coverage:?}");
    assert_eq!(coverage.unknown_behind_samples, 0, "{coverage:?}");
    assert!(coverage.unknown_normal_samples > 0, "{coverage:?}");
    assert_eq!(coverage.samples, coverage.observed_samples + coverage.unknown_normal_samples);
    // Roughly three quarters observed: the whole front, half of the back.
    let total = coverage.observed_area_estimate_m2 + coverage.unknown_area_estimate_m2;
    assert!((total - 2.).abs() < 1e-9, "{coverage:?}");
    assert!(coverage.observed_area_estimate_m2 > 1.4 && coverage.observed_area_estimate_m2 < 1.6, "{coverage:?}");
    baked.expect([0.3, 0., 0.5], RED_RGBA);
    baked.expect([0.8, 0., 0.5], RED_RGBA);
    baked.expect([0.3, THICKNESS, 0.5], BLUE_RGBA);
    // The uncaptured back region faces the red front capture: its normal is
    // opposite, so the prior IFC appearance survives and no red bleeds through.
    baked.expect([0.8, THICKNESS, 0.5], GREEN);
}

#[test]
fn issue_4381_scan_surfaces_beyond_a_thin_wall_or_in_front_of_a_gap_are_not_painted_through() {
    // The front capture has a gap over x in [0.4, 0.6] where a 2 mm yellow slab
    // stood 6 mm in front of the wall; both slab faces were scanned. The back of
    // the wall was not captured at all.
    let mut source = mesh();
    quad(&mut source, -0.001, [0., 0.4], true, RED);
    quad(&mut source, -0.001, [0.6, 1.], true, RED);
    quad(&mut source, -0.006, [0.4, 0.6], false, YELLOW);
    quad(&mut source, -0.008, [0.4, 0.6], true, YELLOW);
    let (request, rgba) = control(source.clone(), 0.02, 0.005);
    let baked = Baked::new(&request, &rgba);
    let coverage = baked.coverage();
    println!("occluder coverage {coverage:?}");
    assert!(coverage.unknown_normal_samples > 0 && coverage.unknown_behind_samples > 0, "{coverage:?}");
    assert_eq!(coverage.unknown_distance_samples, 0, "{coverage:?}");
    // Near-ties exist only in the millimetre seam band where the front capture's
    // edge and the slab are equally near; they never reach the sampled interiors.
    assert!(coverage.unknown_ambiguous_samples > 0 && coverage.unknown_ambiguous_samples < coverage.samples / 100, "{coverage:?}");
    baked.expect([0.2, 0., 0.5], RED_RGBA);
    // Front gap: the nearest scan surface is the slab's wall-facing side, whose
    // normal opposes the wall face. Nothing looks through it to the far slab face.
    baked.expect([0.5, 0., 0.5], GREEN);
    // Back face: the red front capture faces away, and the slab's wall-facing
    // side agrees with the back normal but lies 10 mm beyond the 4 mm wall.
    baked.expect([0.2, THICKNESS, 0.5], GREEN);
    baked.expect([0.5, THICKNESS, 0.5], GREEN);
    // Loosening the behind bound to the full distance bound is exactly the
    // far-side bleed the bound exists to refuse.
    let (loose, rgba) = control(source, 0.02, 0.02);
    let leaked = Baked::new(&loose, &rgba);
    assert_eq!(leaked.coverage().unknown_behind_samples, 0);
    leaked.expect([0.5, THICKNESS, 0.5], YELLOW_RGBA);
    // A one-sided sheet facing the same way as the wall, within the distance
    // bound, is the visible surface there: local nearest-surface matching cannot
    // tell it from the wall without scanner viewpoints. The distance bound is
    // the explicit control; below the sheet's stand-off it stays unknown.
    let mut sheet = mesh();
    quad(&mut sheet, -0.001, [0., 0.4], true, RED);
    quad(&mut sheet, -0.001, [0.6, 1.], true, RED);
    quad(&mut sheet, -0.008, [0.4, 0.6], true, YELLOW);
    let (within, rgba) = control(sheet.clone(), 0.02, 0.005);
    Baked::new(&within, &rgba).expect([0.5, 0., 0.5], YELLOW_RGBA);
    let (tight, rgba) = control(sheet, 0.005, 0.005);
    let unknown = Baked::new(&tight, &rgba);
    assert!(unknown.coverage().unknown_distance_samples > 0);
    unknown.expect([0.5, 0., 0.5], GREEN);
}

#[test]
fn issue_4381_behind_bound_is_explicit_bounded_and_applied_after_normal_agreement() {
    let mut beyond = mesh();
    quad(&mut beyond, -0.006, [0., 1.], false, YELLOW);
    let (request, rgba) = control(beyond, 0.02, 0.005);
    let observe = |request: &MeshTransferRequest, point: Point, normal: Point| {
        let mut budget = TransferBudget::new();
        Surface::new(request, &identity(), &mut budget).unwrap().observe(point, normal, &mut budget).unwrap().0
    };
    // One +Y surface 10 mm beyond the +Y back face; the -Y front face sees it as opposing.
    assert_eq!(observe(&request, [0.5, THICKNESS, 0.5], [0., 1., 0.]), Observation::Behind);
    assert_eq!(observe(&request, [0.5, 0., 0.5], [0., -1., 0.]), Observation::Normal);
    let mut loose = request.clone();
    loose.max_behind_metres = 0.01;
    assert_eq!(observe(&loose, [0.5, THICKNESS, 0.5], [0., 1., 0.]), Observation::Observed);
    // In front is never behind: the same stand-off ahead of a -Y face observes
    // even with a zero behind bound.
    let mut ahead = mesh();
    quad(&mut ahead, -0.006, [0., 1.], true, YELLOW);
    let (ahead, _) = control(ahead, 0.02, 0.);
    assert_eq!(observe(&ahead, [0.5, 0., 0.5], [0., -1., 0.]), Observation::Observed);
    for (behind, distance) in [(-0.001, 0.02), (0.03, 0.02), (f64::NAN, 0.02)] {
        let mut bad = request.clone();
        bad.max_behind_metres = behind;
        bad.max_distance_metres = distance;
        assert!(plan_mesh_transfer(THIN_WALL_IFC.as_bytes(), &bad, &rgba).unwrap_err().contains("behind"));
    }
}
