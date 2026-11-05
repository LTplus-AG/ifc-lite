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

#[test]
fn issue_8875_gross_preserves_material_layer_slicing() {
    let content = IFC.replace("ENDSEC;\nEND-ISO", "#140=IFCMATERIALLAYER($,0.1,$);\n#141=IFCMATERIALLAYER($,0.1,$);\n#142=IFCMATERIALLAYERSET((#140,#141),'layers');\n#143=IFCMATERIALLAYERSETUSAGE(#142,.AXIS2.,.POSITIVE.,0.);\n#144=IFCRELASSOCIATESMATERIAL('mat',$,$,$,(#30),#143);\nENDSEC;\nEND-ISO");
    let gross = process(content.as_bytes(), &ProcessingRequest::full_pass().skip_voids(true).layer_slicing(true), &mut ());
    let hosts: Vec<_> = gross.meshes.iter().filter(|m| m.express_id == 30).collect();
    assert_eq!(hosts.len(), 2, "both authored material layers survive");
    assert!((volume(&gross, 30) - 2.4).abs() < 1e-5);
}

#[test]
fn issue_8875_real_archicad_model_has_gross_hosts() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/models/ara3d/AC20-FZK-Haus.ifc");
    if !path.exists() {
        eprintln!("SKIP #8875 real Archicad geometry: run pnpm fixtures");
        return;
    }
    let bytes = std::fs::read(path).expect("read Archicad fixture");
    let net = process(&bytes, &ProcessingRequest::full_pass(), &mut ());
    let gross = process(&bytes, &ProcessingRequest::full_pass().skip_voids(true), &mut ());
    let changed = gross.meshes.iter().filter(|g| {
        net.meshes.iter().any(|n| n.express_id == g.express_id && n.positions != g.positions)
    }).count();
    assert!(changed > 0, "real authored hosts must recover their opening volumes");
    let net_volume: f64 = net.meshes.iter().map(|m| signed_volume(&m.positions, &m.indices).abs()).sum();
    let gross_volume: f64 = gross.meshes.iter().map(|m| signed_volume(&m.positions, &m.indices).abs()).sum();
    assert!(gross_volume > net_volume + 0.01, "gross model recovers removed volume");
    eprintln!("#8875 Archicad: {changed} changed mesh records; net={net_volume} m³, gross={gross_volume} m³");
}
