// SPDX-License-Identifier: MPL-2.0

use super::census_bytes;

fn model(extra: &str) -> String {
    format!("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('synthetic.ifc','2026-01-01T00:00:00',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCCARTESIANPOINT((0.,0.,0.));\n#2=IFCDIRECTION((0.,0.,1.));\n#3=IFCDIRECTION((1.,0.,0.));\n#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);\n\
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#4,$);\n#6=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#5,$,.MODEL_VIEW.,$);\n\
#7=IFCLOCALPLACEMENT($,#4);\n#17=IFCCARTESIANPOINT((0.,0.));\n#8=IFCAXIS2PLACEMENT2D(#17,$);\n#9=IFCRECTANGLEPROFILEDEF(.AREA.,$,#8,2.,1.);\n\
#10=IFCEXTRUDEDAREASOLID(#9,#4,#2,3.);\n#11=IFCSHAPEREPRESENTATION(#6,'Body','SweptSolid',(#10));\n\
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#11));\n#13=IFCWALL('0000000000000000000001',$,'Wall',$,$,#7,#12,$);\n\
#14=IFCPROJECT('0000000000000000000002',$,'Project',$,$,$,$,(#5),#15);\n#15=IFCUNITASSIGNMENT((#16));\n#16=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n{extra}\nENDSEC;\nEND-ISO-10303-21;\n")
}

#[test]
fn issue_7955_plain_extrusion_is_source_only_candidate() {
    let fixture = census_bytes(model("").as_bytes());
    let wall = &fixture.products[&13];
    assert_eq!(wall.source_admission, "admitted");
    assert_eq!(wall.verdict, "source_only_candidate");
    assert!(wall.reasons.is_empty());
}

#[test]
fn issue_7955_source_admission_and_opening_refusal_are_separate() {
    let model = model("#20=IFCRELVOIDSELEMENT('0000000000000000000003',$,$,$,#13,#21);\n#21=IFCOPENINGELEMENT('0000000000000000000004',$,$,$,$,$,$,$);");
    let fixture = census_bytes(model.as_bytes());
    let wall = &fixture.products[&13];
    assert_eq!(wall.source_admission, "admitted");
    assert_eq!(wall.counts.openings, 1);
    assert!(wall.reasons.contains("product:openings_not_applied"));
    assert_eq!(wall.representation_families["IfcExtrudedAreaSolid"], 1);
}

#[test]
fn issue_7955_mutating_void_relationship_changes_host_census() {
    let model = model("#20=IFCRELVOIDSELEMENT('0000000000000000000003',$,$,$,#13,#21);\n#21=IFCOPENINGELEMENT('0000000000000000000004',$,$,$,$,$,$,$);");
    let changed = model.replace("$,$,$,#13,#21", "$,$,$,#21,#13");
    let before = census_bytes(model.as_bytes());
    let after = census_bytes(changed.as_bytes());
    assert_eq!(before.products[&13].counts.openings, 1);
    assert_eq!(after.products[&13].counts.openings, 0);
    assert!(!after.products[&13]
        .reasons
        .contains("product:openings_not_applied"));
}

#[test]
fn issue_7955_counts_styling_and_palette_on_authored_item() {
    let model = model("#30=IFCCOLOURRGB($,1.,0.,0.);\n#31=IFCSURFACESTYLESHADING(#30,$);\n#32=IFCSURFACESTYLE('red',.BOTH.,(#31));\n#33=IFCSTYLEDITEM(#10,(#32),$);\n#34=IFCINDEXEDCOLOURMAP(#10,$,#35,(1));\n#35=IFCCOLOURRGBLIST(((1.,0.,0.)));");
    let fixture = census_bytes(model.as_bytes());
    let wall = &fixture.products[&13];
    assert_eq!(wall.counts.styled_items, 1);
    assert_eq!(wall.counts.palette_items, 1);
    assert!(wall.reasons.contains("product:appearance_not_applied"));
}

#[test]
fn issue_7955_negative_mapped_occurrence_is_counted() {
    let direct = model("");
    let mapped = direct.replace("'SweptSolid',(#10)", "'MappedRepresentation',(#40)")
        .replace("ENDSEC;\nEND-ISO", "#40=IFCMAPPEDITEM(#41,#43);\n#41=IFCREPRESENTATIONMAP(#4,#42);\n#42=IFCSHAPEREPRESENTATION(#6,'Body','SweptSolid',(#10));\n#43=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,-1.,$);\nENDSEC;\nEND-ISO");
    let fixture = census_bytes(mapped.as_bytes());
    let wall = &fixture.products[&13];
    assert_eq!(wall.counts.mapped_items, 1);
    assert_eq!(wall.counts.negative_scale, 1);
    assert_eq!(wall.counts.mapped_mirrored, 1);
    assert_eq!(wall.representation_families["IfcExtrudedAreaSolid"], 1);
}

#[test]
fn issue_7955_counts_material_layer_usage_on_product() {
    let model = model("#50=IFCMATERIAL('A');\n#51=IFCMATERIALLAYER(#50,0.2,$,$,$,$,$);\n#52=IFCMATERIALLAYERSET((#51),$,$);\n#53=IFCMATERIALLAYERSETUSAGE(#52,.AXIS2.,.POSITIVE.,0.);\n#54=IFCRELASSOCIATESMATERIAL('0000000000000000000005',$,$,$,(#13),#53);");
    let fixture = census_bytes(model.as_bytes());
    let wall = &fixture.products[&13];
    assert_eq!(wall.counts.layered_products, 1);
    assert_eq!(wall.counts.material_layer_usages, 1);
    assert!(wall.reasons.contains("product:material_layers_not_applied"));
}
