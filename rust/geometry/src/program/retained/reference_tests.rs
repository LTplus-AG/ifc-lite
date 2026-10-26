// SPDX-License-Identifier: MPL-2.0
//! #7955 S1 P2: selection cannot hide unresolved or non-item authored members.
use super::*;

const AXIS: &str = "#90=IFCSHAPEREPRESENTATION(#2,'Axis','Curve3D',(#53));";
const TOPOLOGY: &str = "
#90=IFCTOPOLOGYREPRESENTATION(#2,'Reference','Edge',(#92));
#92=IFCEDGE(#94,#95);#94=IFCVERTEXPOINT(#51);#95=IFCVERTEXPOINT(#52);";
const MAPPED: &str = "
#90=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#92));
#92=IFCMAPPEDITEM(#61,#93);
#93=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,1.,$);";
const UNKNOWN: &str = "#98=IFCUNRECOGNIZEDREPRESENTATIONITEM();";

fn append_records(bytes: &str, records: &str) -> String {
    bytes.replace(
        "ENDSEC;END-ISO-10303-21;",
        &format!("{records}\nENDSEC;END-ISO-10303-21;"),
    )
}

fn alongside_body(records: &str) -> String {
    append_records(
        &SOURCE.replace("SHAPE($,$,(#12))", "SHAPE($,$,(#12,#90))"),
        &format!("{records}\n{UNKNOWN}"),
    )
}

fn admission(bytes: &str) -> (Vec<RetainedPlanOperation>, Result<RetainedProductPlan>) {
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    let operations = drive(&mut program, &router, &mut decoder);
    (operations, program.finish())
}

fn assert_body_only(bytes: &str) {
    let (operations, result) = admission(bytes);
    assert_eq!(operations.len(), 1, "the supported Body must be reached");
    let plan = result.unwrap();
    assert_eq!(plan.values.len(), 1, "only the selected Body is retained");
    assert!(plan.values[0].is_product_placed());
    for value in [operations[0].value(), &plan.values[0]] {
        assert!(matches!(
            value.definition(),
            LogicalRetainedDefinition::Source { source_id: 13, .. }
        ));
    }
    assert_eq!(plan.remaining.len(), 4, "construction is not completion");
    assert_exact_unchanged(bytes, &exact_parts(SOURCE));
}

fn assert_skipped_dangling_refuses(records: &str, items: &str) {
    let bytes = alongside_body(records);
    assert_body_only(&bytes);
    let malformed = bytes.replace(items, &items.replace(')', ",#999)"));
    assert_ne!(
        bytes, malformed,
        "the later authored member must be present"
    );
    let source = SourceBundle::new(malformed.as_bytes().to_vec());
    assert!(source.decoder().decode_by_id(999).is_err());
    assert!(
        retained_result(&malformed, 10).is_err(),
        "a skipped later dangling Items reference must refuse the whole plan"
    );
    assert_exact_unchanged(&malformed, &exact_parts(SOURCE));
}

fn assert_skipped_categories_refuse(records: &str, items: &str) {
    let bytes = alongside_body(records);
    assert_body_only(&bytes);
    // Existing project, profile and representation-map records are not Items;
    // an unknown keyword must not be mistaken for a supported schema subclass.
    for id in [1, 14, 61, 98] {
        let malformed = bytes.replace(items, &items.replace(')', &format!(",#{id})")));
        assert_ne!(bytes, malformed);
        let source = SourceBundle::new(malformed.as_bytes().to_vec());
        let item = source.decoder().decode_by_id(id).unwrap();
        assert!(!item
            .ifc_type
            .is_subtype_of(ifc_lite_core::IfcType::IfcRepresentationItem));
        assert!(
            retained_result(&malformed, 10).is_err(),
            "a skipped later wrong-category Items reference #{id} must refuse the whole plan"
        );
        assert_exact_unchanged(&malformed, &exact_parts(SOURCE));
    }
}

#[test]
fn skipped_axis_later_dangling_reference_refuses_whole_plan() {
    assert_skipped_dangling_refuses(AXIS, "'Curve3D',(#53)");
}

#[test]
fn skipped_axis_later_wrong_item_category_refuses_whole_plan() {
    assert_skipped_categories_refuse(AXIS, "'Curve3D',(#53)");
}

#[test]
fn skipped_topology_later_dangling_reference_refuses_whole_plan() {
    assert_skipped_dangling_refuses(TOPOLOGY, "'Edge',(#92)");
}

#[test]
fn skipped_topology_later_wrong_item_category_refuses_whole_plan() {
    assert_skipped_categories_refuse(TOPOLOGY, "'Edge',(#92)");
}

#[test]
fn skipped_duplicate_mapped_later_dangling_reference_refuses_whole_plan() {
    assert_skipped_dangling_refuses(MAPPED, "'MappedRepresentation',(#92)");
}

#[test]
fn skipped_duplicate_mapped_later_wrong_item_category_refuses_whole_plan() {
    assert_skipped_categories_refuse(MAPPED, "'MappedRepresentation',(#92)");
}

#[test]
fn selected_body_later_dangling_reference_refuses_whole_plan() {
    assert_body_only(SOURCE);
    let malformed = SOURCE.replace("'SweptSolid',(#13)", "'SweptSolid',(#13,#999)");
    assert!(retained_result(&malformed, 10).is_err());
}

#[test]
fn selected_body_later_wrong_item_category_refuses_whole_plan() {
    let bytes = append_records(SOURCE, UNKNOWN);
    assert_body_only(&bytes);
    for id in [1, 14, 61, 98] {
        let malformed = bytes.replace("'SweptSolid',(#13)", &format!("'SweptSolid',(#13,#{id})"));
        assert!(
            retained_result(&malformed, 10).is_err(),
            "selected Body must refuse later wrong-category member #{id}"
        );
    }
}

#[test]
fn unselected_mapping_children_are_not_traversed_or_admitted() {
    let bytes = alongside_body(MAPPED);
    assert_body_only(&bytes);
    // Shallow item resolution is not a certificate for the unselected map's
    // nested source: neither a cycle nor a dangling target is followed.
    let cycle = bytes.replace(
        "#61=IFCREPRESENTATIONMAP(#7,#12)",
        "#61=IFCREPRESENTATIONMAP(#7,#90)",
    );
    let dangling = bytes.replace("#92=IFCMAPPEDITEM(#61,#93)", "#92=IFCMAPPEDITEM(#999,#998)");
    for unselected in [&bytes, &cycle, &dangling] {
        assert_body_only(unselected);
        let selected = unselected.replace("SHAPE($,$,(#12,#90))", "SHAPE($,$,(#90))");
        let (operations, result) = admission(&selected);
        assert!(operations.is_empty(), "no mapped constructor is admitted");
        assert!(result.is_err(), "selected mappings remain unsupported");
    }
}

#[test]
fn selected_topology_keeps_selection_but_refuses_unsupported_constructor() {
    let bytes = alongside_body(TOPOLOGY)
        .replace("SHAPE($,$,(#12,#90))", "SHAPE($,$,(#90))")
        .replace(
            "IFCWALL('w',$,'Wall',$,$,#9,#11,$,$)",
            "IFCSTRUCTURALCURVEMEMBER('w',$,'Curve',$,$,#9,#11,.RIGID_JOINED_MEMBER.,$)",
        );
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let entity = decoder.decode_by_id(10).unwrap();
    let shape = crate::representation::product_shape(&entity, &mut decoder)
        .unwrap()
        .unwrap();
    assert_eq!(
        shape
            .select(&entity, crate::representation::Select::Meshed)
            .map(|rep| rep.id)
            .collect::<Vec<_>>(),
        vec![90],
        "the canonical selector must actually reach the structural Edge"
    );
    let (operations, result) = admission(&bytes);
    assert!(operations.is_empty());
    assert!(
        result.is_err(),
        "item membership does not add topology support"
    );
}

#[test]
fn supported_legacy_styled_item_subclass_can_remain_unselected() {
    let bytes = alongside_body(
        "#90=IFCSHAPEREPRESENTATION(#2,'Annotation','Annotation2D',(#92));
#92=IFCANNOTATIONCURVEOCCURRENCE(#53,(#94),$);
#94=IFCPRESENTATIONSTYLEASSIGNMENT((#95));
#95=IFCCURVESTYLE($,$,$,#96);#96=IFCCOLOURRGB($,1.,0.,0.);",
    )
    .replace("FILE_SCHEMA(('IFC4X1'))", "FILE_SCHEMA(('IFC2X3'))");
    assert_body_only(&bytes);
}
