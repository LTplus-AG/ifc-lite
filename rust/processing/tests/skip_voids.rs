// SPDX-License-Identifier: MPL-2.0
//! #8875 / discussion #8586: gross hosts retain authored cuts and filling meshes.
use ifc_lite_processing::{process, ProcessingRequest, ProcessingResult};
use ifc_lite_testkit::mesh::signed_volume;

const IFC: &str = include_str!("fixtures/issue_2019_wall_two_overlapping_openings.ifc");

fn volume(result: &ProcessingResult, id: u32) -> f64 {
    let meshes: Vec<_> = result.meshes.iter().filter(|m| m.express_id == id).collect();
    assert!(!meshes.is_empty(), "missing #{id}");
    meshes.iter().map(|m| signed_volume(&m.positions, &m.indices)).sum::<f64>().abs()
}

#[test]
fn issue_8875_gross_hosts_preserve_fillings_and_restore_net() {
    let content = IFC.replace("ENDSEC;\nEND-ISO", "#120=IFCWINDOW('window',$,'Filling',$,$,#49,#48,$,1.2,1.);\n#121=IFCRELFILLSELEMENT('fill',$,$,$,#50,#120);\nENDSEC;\nEND-ISO");
    let run = |skip| process(content.as_bytes(), &ProcessingRequest::full_pass().skip_voids(skip), &mut ());
    let net = run(false);
    let gross = run(true);
    assert!((volume(&gross, 30) - 2.4).abs() < 1e-5);
    assert!(volume(&net, 30) < 2.2);
    assert_eq!(volume(&net, 120), volume(&gross, 120));
    let again = run(false);
    for (before, after) in net.meshes.iter().zip(&again.meshes) {
        assert_eq!(before.positions, after.positions);
        assert_eq!(before.indices, after.indices);
        assert_eq!(before.color, after.color);
    }
    assert_eq!(net.meshes.len(), again.meshes.len());
}

#[test]
fn issue_8875_gross_keeps_authored_boolean_difference() {
    let content = IFC.replace("'SweptSolid',(#26)", "'CSG',(#130)")
        .replace("ENDSEC;\nEND-ISO", "#130=IFCBOOLEANRESULT(.DIFFERENCE.,#26,#46);\nENDSEC;\nEND-ISO");
    let gross = process(content.as_bytes(), &ProcessingRequest::full_pass().skip_voids(true), &mut ());
    // Authored opening A still removes 1 × 0.2 × 1.2 m³ from the 2.4 m³ wall.
    assert!((volume(&gross, 30) - 2.16).abs() < 1e-5);
}
