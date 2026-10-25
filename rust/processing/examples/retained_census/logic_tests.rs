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

// #7955: this product has a real visual Body but is excluded by mesh-job
// eligibility. Unsupported extractor families must not erase its source row.
#[test]
fn issue_7955_unsupported_storey_cannot_disappear() {
    let input = model("#20=IFCPOLYLINE((#1,#1));\n#21=IFCSHAPEREPRESENTATION(#6,'Body','Curve3D',(#20));\n#22=IFCPRODUCTDEFINITIONSHAPE($,$,(#21));\n#23=IFCBUILDINGSTOREY('0000000000000000000023',$,$,$,$,#7,#22,$,.ELEMENT.,0.);");
    let fixture = census_bytes(input.as_bytes());
    assert!(fixture.enumeration_complete, "{:?}", fixture.diagnostics);
    assert_eq!(
        fixture.products.keys().copied().collect::<Vec<_>>(),
        [13, 23]
    );
    let storey = &fixture.products[&23];
    assert_eq!(storey.verdict, "refused");
    assert_eq!(storey.representation_roles[&21].as_deref(), Some("Body"));
    assert!(storey
        .reasons
        .contains("product:unsupported_family/IfcPolyline"));
}

fn assert_partition(fixture: &super::Fixture) {
    let counts = &fixture.counts;
    assert_eq!(counts.products, fixture.products.len());
    assert_eq!(
        counts.products,
        counts.source_only_candidates + counts.refused_products + counts.no_representation_products
    );
    assert_eq!(
        counts.products,
        counts.source_admitted_products
            + counts.source_refused_products
            + counts.source_uninspected_products
    );
    for (verdict, count) in [
        ("source_only_candidate", counts.source_only_candidates),
        ("refused", counts.refused_products),
        ("no_representation", counts.no_representation_products),
    ] {
        assert_eq!(
            count,
            fixture
                .products
                .values()
                .filter(|p| p.verdict == verdict)
                .count()
        );
    }
}

#[test]
fn issue_7955_visual_denominator_reconciles_roles_and_absence() {
    let input = model(
        "#20=IFCPOLYLINE((#1,#1));
#21=IFCSHAPEREPRESENTATION(#6,'Annotation','Curve3D',(#20));
#22=IFCPRODUCTDEFINITIONSHAPE($,$,(#21));
#23=IFCANNOTATION('0000000000000000000023',$,$,$,$,#7,#22);
#24=IFCSHAPEREPRESENTATION(#6,'Axis','Curve3D',(#20));
#25=IFCSHAPEREPRESENTATION(#6,'FootPrint','Curve3D',(#20));
#26=IFCPRODUCTDEFINITIONSHAPE($,$,(#24,#25));
#27=IFCSPACE('0000000000000000000027',$,$,$,$,#7,#26,$,.ELEMENT.,.INTERNAL.,$);
#28=IFCWALL('0000000000000000000028',$,$,$,$,#7,$,$,.NOTDEFINED.);
#29=IFCWALLTYPE('0000000000000000000029',$,$,$,$,$,$,$,$,.NOTDEFINED.);
#30=IFCGRIDAXIS('A',#20,.T.);
#31=IFCGRID('0000000000000000000031',$,$,$,$,#7,$,(#30),(#30),$,.RECTANGULAR.);",
    );
    let fixture = census_bytes(input.as_bytes());
    assert!(fixture.enumeration_complete, "{:?}", fixture.diagnostics);
    assert_eq!(
        fixture.products.keys().copied().collect::<Vec<_>>(),
        [13, 23, 27, 28, 31]
    );
    assert_partition(&fixture);
    assert_eq!(fixture.counts.source_only_candidates, 1);
    assert_eq!(fixture.counts.refused_products, 3);
    assert_eq!(fixture.counts.no_representation_products, 1);
    assert_eq!(fixture.counts.non_body_products, 3);
    assert_eq!(fixture.type_definitions[&29], "IfcWallType");
    assert_eq!(fixture.products[&28].verdict, "no_representation");
    assert_eq!(
        fixture.products[&23].representation_roles[&21].as_deref(),
        Some("Annotation")
    );
    assert_eq!(
        fixture.products[&27].representation_roles[&24].as_deref(),
        Some("Axis")
    );
    assert_eq!(
        fixture.products[&27].representation_roles[&25].as_deref(),
        Some("FootPrint")
    );
    assert!(fixture.products[&31]
        .intrinsic_visual_roles
        .contains("Grid"));
    assert_eq!(
        fixture.products[&31].representation_state,
        "intrinsic_visual"
    );
    assert_eq!(
        fixture.products[&13].global_id.as_deref(),
        Some("0000000000000000000001")
    );
}

#[test]
fn issue_7955_body_does_not_hide_non_body_or_malformed_representations() {
    let input = model("#20=IFCSHAPEREPRESENTATION(#6,'Axis','Curve3D',(#10));");
    let mixed = input.replace("($,$,(#11))", "($,$,(#11,#20))");
    let fixture = census_bytes(mixed.as_bytes());
    assert!(fixture.enumeration_complete);
    assert_eq!(fixture.products[&13].source_admission, "admitted");
    assert_eq!(fixture.products[&13].verdict, "refused");
    assert!(fixture.products[&13]
        .reasons
        .contains("product:unsupported_visual_role/Axis"));
    for bad in ["(#11,#999)", "(#11,42)", "()"] {
        let changed = input.replace("($,$,(#11))", &format!("($,$,{bad})"));
        let fixture = census_bytes(changed.as_bytes());
        assert!(!fixture.enumeration_complete, "{bad}");
        assert_eq!(fixture.status, "source_enumeration_failed");
        assert_eq!(fixture.products[&13].verdict, "refused");
        assert_partition(&fixture);
    }
}

#[test]
fn issue_7955_decode_unknown_and_bound_failures_never_claim_coverage() {
    // Scanner can frame this record, but the real STEP decoder rejects @.
    for extra in ["#20=IFCWALL(@);", "#20=IFCWALL();"] {
        let fixture = census_bytes(model(extra).as_bytes());
        assert!(fixture.products.contains_key(&20));
        assert!(!fixture.products[&20].enumeration_complete);
        assert_eq!(fixture.products[&20].verdict, "refused");
        assert!(!fixture.enumeration_complete);
        assert_eq!(fixture.counts.source_only_candidates, 0);
        assert_partition(&fixture);
    }
    let decoded = census_bytes(model("#20=IFCWALL(@);").as_bytes());
    assert!(decoded.products[&20]
        .reasons
        .contains("product:decode_failed"));
    let unknown = census_bytes(model("#20=IFCUNKNOWNVISUAL();").as_bytes());
    assert!(!unknown.enumeration_complete);
    assert_eq!(unknown.unclassified_entities[&20], "IFCUNKNOWNVISUAL");
    let bounded = super::census_bytes_bounded(model("").as_bytes(), 1);
    assert!(!bounded.enumeration_complete);
    assert!(bounded
        .diagnostics
        .iter()
        .any(|d| d == "enumeration:record_bound"));
    assert_partition(&bounded);
    for input in [
        model("#20=IFCWALL($)"), // scanner drop
        model("#4294967296=IFCWALL($);"),
        model("#13=IFCWALL($);"), // duplicate source identity
        model("").replace("END-ISO-10303-21;", ""),
        model("").replace("'IFC4'", "'IFC_UNKNOWN'"),
    ] {
        let fixture = census_bytes(input.as_bytes());
        assert!(!fixture.enumeration_complete);
        assert_eq!(fixture.status, "source_enumeration_failed");
        assert_eq!(fixture.counts.source_only_candidates, 0);
        assert_partition(&fixture);
    }
}

#[test]
fn issue_7955_cyclic_representation_is_not_complete() {
    let input = model("#20=IFCBOOLEANRESULT(.UNION.,#20,#10);")
        .replace("'SweptSolid',(#10)", "'CSG',(#20)");
    let fixture = census_bytes(input.as_bytes());
    assert!(!fixture.enumeration_complete);
    assert!(fixture.products[&13]
        .reasons
        .contains("product:representation_walk_bound_or_cycle"));
    assert_eq!(fixture.products[&13].verdict, "refused");
    assert_partition(&fixture);
}

#[test]
fn issue_7955_type_map_occurrence_is_not_proved_absent() {
    let input = model(
        "#20=IFCREPRESENTATIONMAP(#4,#11);
#21=IFCWALLTYPE('0000000000000000000021',$,$,$,$,$,(#20),$,$,.NOTDEFINED.);
#22=IFCRELDEFINESBYTYPE('0000000000000000000022',$,$,$,(#13),#21);",
    )
    .replace("$,#7,#12,$)", "$,#7,$,$)");
    let fixture = census_bytes(input.as_bytes());
    assert_eq!(fixture.type_definitions[&21], "IfcWallType");
    assert_eq!(
        fixture.products[&13].representation_state,
        "type_representation_unresolved"
    );
    assert_eq!(fixture.products[&13].verdict, "refused");
    assert!(!fixture.enumeration_complete);
    assert_eq!(fixture.counts.no_representation_products, 0);
    assert_partition(&fixture);
}

#[test]
fn issue_7955_malformed_representation_envelope_is_incomplete() {
    for changed in [
        model("").replace("(#6,'Body'", "(#999,'Body'"),
        model("").replace("'Body','SweptSolid'", "'Body',42"),
        model("").replace("'SweptSolid',(#10)", "'SweptSolid',(#13)"),
        model("").replace("'0000000000000000000001'", "42"),
    ] {
        let fixture = census_bytes(changed.as_bytes());
        assert!(!fixture.enumeration_complete);
        assert_eq!(fixture.products[&13].verdict, "refused");
        assert_partition(&fixture);
    }
}
