// SPDX-License-Identifier: MPL-2.0
//! Owned ribbon replay, extent and bounded sampling invariants.
use super::AlignmentPlan;
use crate::processors::IfcAlignmentProcessor;
use ifc_lite_core::EntityDecoder;

fn lower(length: f64) -> AlignmentPlan {
    let source = format!("#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCCARTESIANPOINT((0.,{length},0.));
#3=IFCPOLYLINE((#1,#2));
#15=IFCALIGNMENT('id',$,$,$,$,$,#3,$,$);");
    let mut decoder = EntityDecoder::new(&source);
    let entity = decoder.decode_by_id(15).unwrap();
    IfcAlignmentProcessor::new().lower(&entity, &mut decoder).unwrap()
}

fn area(mesh: &crate::Mesh) -> f64 {
    mesh.indices.chunks_exact(3).map(|triangle| {
        let point = |index: u32| {
            let i = index as usize * 3;
            nalgebra::Vector3::new(mesh.positions[i] as f64,
                mesh.positions[i + 1] as f64, mesh.positions[i + 2] as f64)
        };
        let a = point(triangle[0]);
        (point(triangle[1]) - a).cross(&(point(triangle[2]) - a)).norm() * 0.5
    }).sum()
}

#[test]
fn alignment_ribbon_replays_after_decoder_disposal_with_fixed_width() {
    let plan = lower(4.);
    let mesh = plan.evaluate();
    assert_eq!(mesh.positions.len() / 3, 10);
    assert_eq!(mesh.indices.len() / 3, 8);
    assert!((area(&mesh) - 2.).abs() < 1e-12);
    assert!(mesh.positions.chunks_exact(3).all(|p| p[2] == 0.));
    assert_eq!(mesh.positions, plan.clone().evaluate().positions);
}

#[test]
fn long_alignment_sampling_stays_bounded_and_reaches_endpoint() {
    let plan = lower(20000.);
    let mesh = plan.evaluate();
    assert_eq!(mesh.positions.len() / 3, 10002);
    assert_eq!(mesh.indices.len() / 3, 10000);
    assert_eq!(mesh.positions[mesh.positions.len() - 2], 20000.);
    assert!((area(&mesh) - 10000.).abs() < 1e-8);
}

#[test]
fn alignment_without_axis_preserves_explicit_refusal() {
    let mut decoder = EntityDecoder::new("#15=IFCALIGNMENT('id',$,$,$,$,$,$,$,$);");
    let entity = decoder.decode_by_id(15).unwrap();
    let error = IfcAlignmentProcessor::new().lower(&entity, &mut decoder).unwrap_err();
    assert!(error.to_string().contains("missing recognisable Axis curve"));
}
