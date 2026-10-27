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

fn admission(bytes: &str) -> (Vec<RetainedPlanOperation>, std::result::Result<RetainedProductPlan, RetainedFailure>) {
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
    }
}

// #7955 S2 intentionally adds selected mapping construction. The S1 shallow
// preflight still leaves skipped children untouched; selection now reaches the
// map's source and requires its children to be valid, bounded construction input.
#[test]
fn selected_mapping_constructs_its_source_without_discharging_obligations() {
    let selected = alongside_body(MAPPED)
        .replace("SHAPE($,$,(#12,#90))", "SHAPE($,$,(#90))");
    let (operations, result) = admission(&selected);
    assert_eq!(operations.len(), 1);
    assert!(matches!(operations[0].value().definition(),
        LogicalRetainedDefinition::Source { source_id: 13, .. }));
    let plan = result.unwrap();
    assert_eq!(plan.values.len(), 1);
    let value = &plan.values[0];
    assert_eq!(value.definition(), operations[0].value().definition());
    assert_eq!(value.placements().len(), 2);
    assert_eq!(value.placements()[0].stage,
        RetainedPlacementStage::Mapping { source_id: 61 });
    assert_eq!(value.placements()[1].stage,
        RetainedPlacementStage::Product { product_id: 10 });
    assert!(value.is_product_placed());
    // Canonical MappingTarget * MappingOrigin adds [10,20,30], then product
    // placement adds [10,20,30] again to the source anchor [-1,-2,0].
    assert_eq!([value.object_frame()[12], value.object_frame()[13], value.object_frame()[14]],
        [19., 38., 60.]);
    assert_eq!(plan.remaining, vec![RetainedRequirement::OpeningClosure,
        RetainedRequirement::MaterialLayers, RetainedRequirement::IfcAppearance,
        RetainedRequirement::PersistentFaces]);
}

#[test]
fn selected_mapping_dangling_children_refuse_instead_of_publishing_a_plan() {
    let selected = alongside_body(MAPPED)
        .replace("SHAPE($,$,(#12,#90))", "SHAPE($,$,(#90))");
    for item in ["#92=IFCMAPPEDITEM(#999,#93)", "#92=IFCMAPPEDITEM(#61,#998)"] {
        let malformed = selected.replace("#92=IFCMAPPEDITEM(#61,#93)", item);
        assert_ne!(malformed, selected);
        let (operations, result) = admission(&malformed);
        assert!(operations.is_empty());
        assert!(result.is_err(), "selected mapping children are required");
    }
}

#[test]
fn selected_mapping_cycle_stops_before_construction_and_stays_terminal() {
    let selected = alongside_body(MAPPED)
        .replace("SHAPE($,$,(#12,#90))", "SHAPE($,$,(#90))")
        .replace("#61=IFCREPRESENTATIONMAP(#7,#12)", "#61=IFCREPRESENTATIONMAP(#7,#90)");
    let source = SourceBundle::new(selected.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&selected, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    let stop = loop {
        let ticket = match program.request() {
            Err(error) => break error,
            Ok(Some(ticket)) => ticket,
            Ok(None) => panic!("cycle must stop the traversal"),
        };
        match program.admit(ticket, &router, &mut decoder) {
            Err(error) => break error,
            Ok((reply, operations)) => {
                assert!(operations.is_empty());
                if let Err(rejected) = program.accept(reply, &router) {
                    break rejected.error;
                }
            }
        }
    };
    assert!(matches!(stop, RetainedProgramError::Stopped(
        crate::resource::ProgramStop::ResourceRefused(failure))
        if failure.dimension == crate::resource::Dimension::Representation));
    assert_eq!(program.request().err(), Some(stop));
    assert!(program.finish().is_err());
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
