// SPDX-License-Identifier: MPL-2.0
use super::*;
use super::super::BooleanClippingProcessor;
use crate::{GeometryProcessor, TessellationQuality};
use ifc_lite_core::{EntityDecoder, IfcSchema};

const POSITION: &str = "#1=IFCCARTESIANPOINT((10.,20.,30.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);";

fn source(position: &str, boundary: &str) -> String {
    format!("{POSITION}\n{boundary}\n#20=IFCPOLYGONALBOUNDEDHALFSPACE($,.T.,{position},#10);")
}

fn lower_owned() -> BoundedPrismPlan {
    let bytes = source("#2", "#3=IFCCARTESIANPOINT((0.,0.));#4=IFCCARTESIANPOINT((2.,0.));\n\
        #5=IFCCARTESIANPOINT((2.,3.));#6=IFCCARTESIANPOINT((0.,3.));\n\
        #10=IFCPOLYLINE((#3,#4,#5,#6,#3));");
    let mut decoder = EntityDecoder::new(&bytes);
    let entity = decoder.decode_by_id(20).unwrap();
    BooleanClippingProcessor::new().lower_bounded_prism(&entity, &mut decoder,
        TessellationQuality::Medium).unwrap().unwrap()
}

fn host(height: f64) -> Mesh {
    let bytes = format!("#1=IFCBLOCK($,2.,2.,{height});");
    let mut decoder = EntityDecoder::new(&bytes);
    let entity = decoder.decode_by_id(1).unwrap();
    crate::processors::BlockProcessor::new().process(&entity, &mut decoder,
        &IfcSchema::new(), TessellationQuality::Medium).unwrap()
}

fn signed_volume(mesh: &Mesh) -> f64 {
    mesh.indices.chunks_exact(3).map(|triangle| {
        let p = |id: u32| Vector3::new(mesh.positions[id as usize * 3] as f64,
            mesh.positions[id as usize * 3 + 1] as f64, mesh.positions[id as usize * 3 + 2] as f64);
        p(triangle[0]).dot(&p(triangle[1]).cross(&p(triangle[2]))) / 6.0
    }).sum()
}

#[test]
fn owned_bounded_prism_keeps_position_material_side_and_host_derived_depth() {
    let plan = lower_owned(); // All source bytes and the decoder are now gone.
    let plane = (Point3::new(0.0, 0.0, 1.0), Vector3::new(0.0, 0.0, 1.0));
    for height in [2.0, 20.0] {
        let host = host(height);
        let depth = 2.0_f64.hypot(2.0).hypot(height) + 1.0;
        for agreement in [false, true] {
            let mesh = plan.clone().evaluate(&host, (plane.0, plane.1, agreement)).unwrap();
            let (minimum, maximum) = mesh.bounds();
            assert_eq!((minimum.x, maximum.x), (10.0, 12.0));
            assert_eq!((minimum.y, maximum.y), (20.0, 23.0));
            let (expected_min, expected_max) = if agreement { (1.0 - depth, 1.0) }
                else { (1.0, 1.0 + depth) };
            assert!((f64::from(minimum.z) - expected_min).abs() < 1e-5);
            assert!((f64::from(maximum.z) - expected_max).abs() < 1e-5);
            assert!((signed_volume(&mesh) - 6.0 * depth).abs() < 1e-4,
                "prism must have outward caps and six-square-unit section");
        }
    }
}

#[test]
fn owned_bounded_prism_projects_onto_tilted_plane_along_position_z() {
    let plan = lower_owned();
    let normal = Vector3::new(0.0, 1.0, 1.0).normalize();
    let mesh = plan.evaluate(&host(2.0), (Point3::new(0.0, 0.0, 1.0), normal, false)).unwrap();
    let mut on_base = 0;
    for point in mesh.positions.chunks_exact(3) {
        assert!(point[0] == 10.0 || point[0] == 12.0);
        assert!(point[1] == 20.0 || point[1] == 23.0,
            "prism must follow Position.Z rather than drift along the slope normal");
        if (point[1] + point[2] - 1.0).abs() < 1e-5 { on_base += 1; }
    }
    assert!(on_base >= 3, "base cap must lie on the supplied slope plane");
    assert!(signed_volume(&mesh) > 0.0);
}

fn oversized_boundary() -> String {
    let mut bytes = String::new();
    let mut ids = Vec::new();
    for index in 0..257 {
        let angle = index as f64 * 2.0 * std::f64::consts::PI / 257.0;
        let id = 1000 + index;
        bytes.push_str(&format!("#{id}=IFCCARTESIANPOINT(({:e},{:e}));\n", angle.cos(), angle.sin()));
        ids.push(format!("#{id}"));
    }
    ids.push("#1000".into());
    bytes.push_str(&format!("#10=IFCPOLYLINE(({}));", ids.join(",")));
    bytes
}

#[test]
fn owned_bounded_prism_keeps_boundary_cap_none_and_position_error_precedence() {
    let boundary = oversized_boundary();
    let processor = BooleanClippingProcessor::new();
    let bytes = source("#2", &boundary);
    let mut decoder = EntityDecoder::new(&bytes);
    let entity = decoder.decode_by_id(20).unwrap();
    assert!(processor.lower_bounded_prism(&entity, &mut decoder, TessellationQuality::Medium).unwrap().is_none());
    let failures = processor.take_failures();
    assert_eq!(failures.len(), 1);
    assert!(matches!(&failures[0].reason, crate::BoolFailureReason::KernelError(message)
        if message.contains("257 vertices")));

    let bytes = source("#99", &boundary);
    let mut decoder = EntityDecoder::new(&bytes);
    let entity = decoder.decode_by_id(20).unwrap();
    assert!(processor.lower_bounded_prism(&entity, &mut decoder, TessellationQuality::Medium).is_err());
    assert!(processor.take_failures().is_empty(), "Position failure must happen before contour capping");
}
