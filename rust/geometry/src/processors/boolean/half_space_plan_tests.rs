// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::processors::BlockProcessor;

fn source(agreement: &str, kind: &str) -> String {
    format!("#1=IFCCARTESIANPOINT((0.25,0.,0.));#2=IFCDIRECTION((2.,0.,0.));\
        #3=IFCAXIS2PLACEMENT3D(#1,#2,$);#4=IFCPLANE(#3);\
        #5={kind}(#4,{agreement},#999);#20=IFCBLOCK($,1.,1.,1.);")
}
fn volume(mesh: &Mesh) -> f64 {
    mesh.indices.chunks_exact(3).map(|triangle| {
        let point = |index: u32| {
            let i = index as usize * 3;
            Vector3::new(mesh.positions[i] as f64, mesh.positions[i + 1] as f64,
                mesh.positions[i + 2] as f64)
        };
        point(triangle[0]).dot(&point(triangle[1]).cross(&point(triangle[2]))) / 6.
    }).sum::<f64>().abs()
}

#[test]
fn owned_plane_clips_opposite_material_sides_after_source_disposal_and_ignores_enclosure() {
    for (agreement, lower_x, upper_x, expected_volume) in [
        (".T.", 0.25, 1., 0.75), (".F.", 0., 0.25, 0.25),
    ] {
        for kind in ["IFCHALFSPACESOLID", "IFCBOXEDHALFSPACE"] {
            let (plan, host) = {
                let text = source(agreement, kind);
                let mut decoder = EntityDecoder::new(&text);
                let entity = decoder.decode_by_id(5).unwrap();
                let plan = HalfSpacePlan::lower(&entity, &mut decoder).unwrap();
                let entity = decoder.decode_by_id(20).unwrap();
                let host = BlockProcessor::new().lower(&entity, &mut decoder).unwrap().evaluate();
                (plan, host)
            };
            assert_eq!(plan.point, Point3::new(0.25, 0., 0.));
            assert_eq!(plan.normal, Vector3::new(1., 0., 0.));
            let mesh = plan.clip(&host).unwrap();
            assert!((volume(&mesh) - expected_volume).abs() < 1e-6);
            let (min, max) = mesh.bounds();
            assert_eq!(min.x, lower_x);
            assert_eq!(max.x, upper_x);
            assert_eq!((min.y, min.z, max.y, max.z), (0., 0., 1., 1.));
        }
    }
}

#[test]
fn plane_admission_preserves_default_agreement_and_recoverable_wrong_surface_error() {
    let text = source("$", "IFCHALFSPACESOLID");
    let mut decoder = EntityDecoder::new(&text);
    let entity = decoder.decode_by_id(5).unwrap();
    assert!(HalfSpacePlan::lower(&entity, &mut decoder).unwrap().agreement);
    let mut decoder = EntityDecoder::new("#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCHALFSPACESOLID(#1,.T.);");
    let entity = decoder.decode_by_id(2).unwrap();
    let error = HalfSpacePlan::lower(&entity, &mut decoder).unwrap_err();
    assert!(error.to_string().contains("Expected IfcPlane for HalfSpaceSolid"));
}
