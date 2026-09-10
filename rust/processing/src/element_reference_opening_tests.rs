// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! #4440: a retained semantic opening must not strip the host image/UVs.
const IFC:&str=r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Reference texture regression'),'2;1');
FILE_NAME('reference.ifc','2026-09-10T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000001',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCBUILDINGELEMENTPROXY('0000000000000000000002',$,'Host',$,$,#11,#12,$,$);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#14));
#14=IFCTRIANGULATEDFACESET(#15,$,.T.,((1,3,2),(1,4,3),(5,6,7),(5,7,8),(1,2,6),(1,6,5),(2,3,7),(2,7,6),(3,4,8),(3,8,7),(4,1,5),(4,5,8)),$);
#15=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(1.,1.,0.),(0.,1.,0.),(0.,0.,1.),(1.,0.,1.),(1.,1.,1.),(0.,1.,1.)));
#20=IFCIMAGETEXTURE(.T.,.F.,$,$,$,'textures/rock.png');
#21=IFCTEXTUREVERTEXLIST(((0.,0.),(1.,0.),(1.,1.),(0.,1.),(0.,0.),(1.,0.),(1.,1.),(0.,1.)));
#22=IFCINDEXEDTRIANGLETEXTUREMAP((#20),#14,#21,$);
#23=IFCSTYLEDITEM(#14,(#24),$);
#24=IFCSURFACESTYLE('Rock',.BOTH.,(#25,#26));
#25=IFCSURFACESTYLERENDERING(#27,0.,$,$,$,$,$,$,.NOTDEFINED.);
#26=IFCSURFACESTYLEWITHTEXTURES((#20));
#27=IFCCOLOURRGB($,0.5,0.4,0.3);
#80=IFCOPENINGELEMENT('0000000000000000000003',$,$,$,$,#11,#81,$,.OPENING.);
#81=IFCPRODUCTDEFINITIONSHAPE($,$,(#82));
#82=IFCSHAPEREPRESENTATION(#2,'Reference','CSG',(#84));
#83=IFCRELVOIDSELEMENT('0000000000000000000004',$,$,$,#10,#80);
#84=IFCBLOCK(#5,0.2,0.2,0.2);
ENDSEC;
END-ISO-10303-21;
"#;
fn host(source:&str)->crate::MeshData {
    crate::process_geometry(source.as_bytes()).meshes.into_iter().find(|mesh|mesh.express_id==10).unwrap()
}
#[test]
fn issue_4440_reference_only_opening_keeps_exact_host_texture_and_triangle_binding() {
    let control=host(&IFC.replace("#83=IFCRELVOIDSELEMENT('0000000000000000000004',$,$,$,#10,#80);", ""));
    assert!(control.texture.is_some());assert!(control.uvs.is_some());
    let reference=host(IFC);
    assert_eq!(serde_json::to_value(&reference).unwrap(),serde_json::to_value(&control).unwrap());
    let with_box=IFC.replace("(#82));","(#82,#86));").replace("#83=", "#86=IFCSHAPEREPRESENTATION(#2,'Box','BoundingBox',(#87));\n#87=IFCBOUNDINGBOX(#4,1.,1.,1.);\n#83=");
    assert_eq!(serde_json::to_value(host(&with_box)).unwrap(),serde_json::to_value(&control).unwrap());
    let mixed=IFC.replace("(#82));","(#82,#85));").replace("#83=", "#85=IFCSHAPEREPRESENTATION(#2,'Body','CSG',(#84));\n#83=");
    let body=host(&IFC.replace("'Reference'","'Body'"));
    let mixed=host(&mixed);
    assert_eq!(serde_json::to_value(&body).unwrap(),serde_json::to_value(&mixed).unwrap());
    assert_ne!(body.indices.len(),reference.indices.len(),"mixed Body must still cut the host");
    if let Ok(directory)=std::env::var("IFCLITE_REFERENCE_TEXTURE_EVIDENCE_DIR") {
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(std::path::Path::new(&directory).join("textured-reference.ifc"),IFC).unwrap();
    }
}
#[test]
fn issue_4440_unknown_and_over_budget_openings_retain_cutter_routing() {
    let router=ifc_lite_geometry::GeometryRouter::new();
    for source in [IFC.replace("(#82));","());"),IFC.replace("'Reference'","'Unknown'"),IFC.replace("(#82));","(#9999));"),
        IFC.replace("(#82));", &format!("({}));",vec!["#82";65].join(","))),
        IFC.replace("IFCOPENINGELEMENT(","IFCBUILDINGELEMENTPROXY(")] {
        let mut decoder=ifc_lite_core::EntityDecoder::new(source.as_bytes());
        assert!(router.opening_requires_subtraction(80,&mut decoder));
    }
    let mut decoder=ifc_lite_core::EntityDecoder::new(IFC.as_bytes());
    assert!(!router.opening_requires_subtraction(80,&mut decoder));
    assert!(router.opening_requires_subtraction(9999,&mut decoder));
}
