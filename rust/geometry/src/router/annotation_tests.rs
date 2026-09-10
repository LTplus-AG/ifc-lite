// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::GeometryRouter;
use ifc_lite_core::EntityDecoder;

fn fixture(kind: &str, rep: &str) -> String {
    format!("#1=IFCCARTESIANPOINT((2.,3.));#2=IFCCARTESIANPOINT((6.,3.));#3=IFCCARTESIANPOINT((6.,7.));#4=IFCCARTESIANPOINT((2.,7.));
#5=IFCCARTESIANPOINT((3.,4.));#6=IFCCARTESIANPOINT((4.,4.));#7=IFCCARTESIANPOINT((4.,5.));#8=IFCCARTESIANPOINT((3.,5.));
#10=IFCPOLYLINE((#1,#2,#3,#4,#1));#11=IFCPOLYLINE((#5,#6,#7,#8,#5));#12=IFCANNOTATIONFILLAREA(#10,(#11));
#20=IFCSHAPEREPRESENTATION($,'Annotation','{rep}',(#12));#21=IFCPRODUCTDEFINITIONSHAPE($,$,(#20));
#30=IFCCARTESIANPOINT((10.,20.,30.));#31=IFCDIRECTION((0.,1.,0.));#32=IFCDIRECTION((1.,0.,0.));#33=IFCAXIS2PLACEMENT3D(#30,#31,#32);#34=IFCLOCALPLACEMENT($,#33);
#40={kind}('0000000000000000000000',$,'fill',$,$,#34,#21);")
}
#[test]
fn annotation_fill_4406_hole_vertical_placement_and_units() {
    let source = fixture("IFCANNOTATION", "Annotation2D");
    let mut decoder = EntityDecoder::new(&source);
    let router = GeometryRouter::with_scale(0.001);
    let entity = decoder.decode_by_id(40).unwrap();
    let parts = router
        .process_element_with_submeshes(&entity, &mut decoder)
        .unwrap();
    assert_eq!(parts.sub_meshes.len(), 1);
    let mesh = &parts.sub_meshes[0].mesh;
    assert_eq!(mesh.triangle_count(), 8);
    let mut area = 0.;
    for tri in mesh.indices.chunks_exact(3) {
        let pts: Vec<_> = tri
            .iter()
            .map(|i| {
                nalgebra::Vector3::new(
                    mesh.positions[*i as usize * 3] as f64,
                    mesh.positions[*i as usize * 3 + 1] as f64,
                    mesh.positions[*i as usize * 3 + 2] as f64,
                )
            })
            .collect();
        area += (pts[1] - pts[0]).cross(&(pts[2] - pts[0])).norm() * 0.5;
        let center = (pts[0] + pts[1] + pts[2]) / 3.;
        assert!(!(center.x > 0.013 && center.x < 0.014 && center.z > 0.025 && center.z < 0.026));
    }
    assert!((area - 15e-6).abs() < 1e-10, "{area}");
    assert!(mesh
        .positions
        .chunks_exact(3)
        .all(|p| (p[1] as f64 + mesh.origin[1] - 0.020).abs() < 1e-8));
}
#[test]
fn annotation_fill_4406_non_annotation_auxiliary_is_absent() {
    for rep in ["FootPrint", "Annotation2D", "Surface2D"] {
        let source = fixture("IFCWALL", rep);
        let mut decoder = EntityDecoder::new(&source);
        let entity = decoder.decode_by_id(40).unwrap();
        assert!(GeometryRouter::new()
            .process_element_with_submeshes(&entity, &mut decoder)
            .unwrap()
            .is_empty());
    }
}
#[test]
fn annotation_fill_4406_malformed_ring_refuses_and_reports() {
    let original = fixture("IFCANNOTATION", "Annotation2D");
    for source in [
        original.replace("#1,#2,#3,#4,#1", "#1,#3,#2,#4,#1"),
        original.replace("#1,#2,#3,#4,#1", "#1,#2,#3,#4"),
        original.replace(
            "IFCPOLYLINE((#1,#2,#3,#4,#1))",
            "IFCPOLYLINE((#10,#2,#3,#4,#10))",
        ),
    ] {
        let mut decoder = EntityDecoder::new(&source);
        let entity = decoder.decode_by_id(40).unwrap();
        let router = GeometryRouter::new();
        assert!(router
            .process_element_with_submeshes(&entity, &mut decoder)
            .is_err());
        assert_eq!(
            router.take_unsupported_items().get("IfcAnnotationFillArea"),
            Some(&1)
        );
    }
}

#[test]
fn annotation_fill_4406_outside_nested_nonplanar_and_budget_refusals() {
    let original = fixture("IFCANNOTATION", "Annotation2D");
    let cases = [
        original.replace("((3.,4.))", "((9.,4.))"),
        original.replace("((3.,4.))", "((3.,4.,1.))"),
        original.replace("(#11));", "(#11,#11));"),
        original.replace("#1,#2,#3,#4,#1", &vec!["#1"; 2049].join(",")),
    ];
    for source in cases {
        let mut decoder = EntityDecoder::new(&source);
        let entity = decoder.decode_by_id(40).unwrap();
        let router = GeometryRouter::new();
        assert!(router
            .process_element_with_submeshes(&entity, &mut decoder)
            .is_err());
        assert_eq!(
            router.take_unsupported_items().get("IfcAnnotationFillArea"),
            Some(&1)
        );
    }
}

#[test]
fn annotation_fill_4406_unsupported_paint_refuses_with_diagnostic() {
    let base = fixture("IFCANNOTATION", "Annotation2D");
    let style = "#60=IFCCOLOURRGB($,0.2,0.6,0.8);#61=IFCFILLAREASTYLE('paint',(#60),.F.);#62=IFCSTYLEDITEM(#12,(#61),$);";
    for suffix in [
        style.replace("0.2,0.6", "1.2,0.6"),
        style.replace("0.2,0.6", "1.E300,0.6"),
        style.replace("0.2,0.6", "1.E999,0.6"),
        style.replace("(#60),.F.", "(#60,#63),.F.") + "#63=IFCFILLAREASTYLEHATCHING($,$,$,$,$);",
        style.replace("(#60),.F.", "(#60,#60),.F."),
        style.replace(
            "#60=IFCCOLOURRGB($,0.2,0.6,0.8)",
            "#60=IFCFILLAREASTYLEHATCHING($,$,$,$,$)",
        ),
        style.replace("(#61),$", &format!("({}),$", vec!["#61"; 65].join(","))),
        style.replace("(#61),$", "(#63),$") + "#63=IFCPRESENTATIONSTYLEASSIGNMENT((#63));",
    ] {
        let source = base.clone() + &suffix;
        let mut decoder = EntityDecoder::new(&source);
        let entity = decoder.decode_by_id(40).unwrap();
        let router = GeometryRouter::new();
        assert!(router
            .process_element_with_submeshes(&entity, &mut decoder)
            .is_err());
        assert_eq!(
            router.take_unsupported_items().get("IfcAnnotationFillArea"),
            Some(&1)
        );
    }
}

#[test]
fn annotation_fill_4406_reversed_rings_keep_area_and_normal_winding() {
    let original = fixture("IFCANNOTATION", "Annotation2D");
    for source in [
        original.clone(),
        original.replace("#1,#2,#3,#4,#1", "#1,#4,#3,#2,#1"),
        original.replace("#5,#6,#7,#8,#5", "#5,#8,#7,#6,#5"),
    ] {
        let mut decoder = EntityDecoder::new(&source);
        let entity = decoder.decode_by_id(40).unwrap();
        let parts = GeometryRouter::new()
            .process_element_with_submeshes(&entity, &mut decoder)
            .unwrap();
        let mesh = &parts.sub_meshes[0].mesh;
        let mut area = 0.;
        for tri in mesh.indices.chunks_exact(3) {
            let p: Vec<_> = tri
                .iter()
                .map(|i| {
                    nalgebra::Vector3::from_column_slice(
                        &mesh.positions[*i as usize * 3..*i as usize * 3 + 3],
                    )
                })
                .collect();
            let cross = (p[1] - p[0]).cross(&(p[2] - p[0]));
            area += cross.norm() * 0.5;
            let n = nalgebra::Vector3::from_column_slice(
                &mesh.normals[tri[0] as usize * 3..tri[0] as usize * 3 + 3],
            );
            assert!(cross.dot(&n) > 0., "triangle and normal must agree");
        }
        assert!((area - 15.).abs() < 1e-5);
    }
}
