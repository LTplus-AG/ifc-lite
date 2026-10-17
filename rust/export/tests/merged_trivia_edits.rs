// SPDX-License-Identifier: MPL-2.0
//! Retained F4/#7891 regression: public merge, then decode the written STEP.
//! Synthetic legal Part 21 trivia, not a real-authoring-tool corpus claim.

use ifc_lite_core::{DecodedEntity, EntityDecoder, EntityScanner, IfcType};
use ifc_lite_export::{export_merged_with_stats, export_step, MergedOptions, StepOptions, UnitReconciliation};

const OWNER: &str = "0000000000000000000001";
const LATER: &str = "0000000000000000000002";
const PSET: &str = "0000000000000000000005";
const WALL: &str = "0000000000000000000020";
const DOOR: &str = "0000000000000000000030";

fn file(schema: &str, lines: &[String]) -> String {
    ifc_lite_testkit::step_file(schema, lines)
}

fn decoded(text: &str) -> Vec<DecodedEntity> {
    let mut decoder = EntityDecoder::new(text);
    let mut scanner = EntityScanner::new(text);
    let mut entities = Vec::new();
    while let Some((id, _, _, _)) = scanner.next_entity() {
        entities.push(decoder.decode_by_id(id).expect("every emitted entity decodes"));
    }
    entities
}

fn rooted<'a>(entities: &'a [DecodedEntity], guid: &str) -> &'a DecodedEntity {
    let matches: Vec<_> = entities.iter().filter(|e| e.get_string(0) == Some(guid)).collect();
    assert_eq!(matches.len(), 1, "exactly one entity with GlobalId {guid}");
    matches[0]
}

fn property_model(later: bool, trivia: &str) -> String {
    let mut lines = vec![
        format!("#1=IFCPROJECT('{}',$,'P',$,$,$,$,$,$);", if later { "0000000000000000000011" } else { "0000000000000000000010" }),
        format!("#2=IFCBUILDINGELEMENTPROXY('{WALL}',$,'Wall',$,$,$,$,$,$);"),
        "#4=IFCPROPERTYSINGLEVALUE('Reference',$,IFCIDENTIFIER('R'),$);".into(),
        format!("#5=IFCPROPERTYSET('{PSET}',$,'Pset_Test',$,(#4));"),
    ];
    if later {
        lines.push(format!("#3=IFCBUILDINGELEMENTPROXY('{DOOR}',$,'Door',$,$,$,$,$,$);"));
        lines.push(format!("#11=IFCRELDEFINESBYPROPERTIES('{LATER}',$,$,$,(#3),#5);"));
    } else {
        // Exact retained recipe, including the '(' between '=' and keyword.
        lines.push(format!("#10={trivia}IFCRELDEFINESBYPROPERTIES('{OWNER}',$,$,$,(#2),#5);"));
    }
    file("IFC2X3", &lines)
}

fn assert_property_assignment(text: &str) {
    let entities = decoded(text);
    let pset = rooted(&entities, PSET).id;
    let expected = vec![rooted(&entities, WALL).id, rooted(&entities, DOOR).id];
    let owner = rooted(&entities, OWNER);
    assert_eq!(owner.get_ref(5), Some(pset));
    assert_eq!(owner.get_refs(4), Some(expected), "both children exactly once under the canonical owner:\n{text}");
    let definers: Vec<_> = entities.iter().filter(|e| e.ifc_type == IfcType::IfcRelDefinesByProperties).collect();
    assert_eq!(definers.len(), 1, "one canonical relationship:\n{text}");
    assert_eq!(definers[0].id, owner.id);
    assert!(!entities.iter().any(|e| e.get_string(0) == Some(LATER)));
}

#[test]
fn ifc2x3_commented_owner_retains_every_assignment_7891() {
    for trivia in ["/* ( */", "", " \t\n", "/* ) , ' */\x0b/* second */\x0c"] {
        for mode in [UnitReconciliation::Auto, UnitReconciliation::Normalize] {
            let first = property_model(false, trivia);
            let later = property_model(true, "");
            let opts = MergedOptions { schema: Some("IFC2X3".into()), unit_reconciliation: mode, ..Default::default() };
            let (out, stats) = export_merged_with_stats(&[first.as_bytes(), later.as_bytes()], &opts);
            assert_property_assignment(&out);
            assert!(stats.warnings.iter().all(|w| !w.contains("lost that relationship") && !w.contains("Could not add")), "{stats_warnings:?}", stats_warnings = stats.warnings);
            assert_eq!(stats.unmerged_model_count, 0);
            assert!(!stats.unit_rescale_required);
            // Re-export the result too: persisted assignment semantics survive.
            let roundtrip = export_step(out.as_bytes(), &StepOptions::default()).unwrap();
            assert_property_assignment(&roundtrip);
        }
    }
}

#[test]
fn commented_later_decomposition_keeps_first_parent_and_fresh_child_7891() {
    let primary = file("IFC4", &[
        "#1=IFCPROJECT('0000000000000000000010',$,'P',$,$,$,$,$,$);".into(),
        format!("#2=IFCBUILDINGELEMENTPROXY('{WALL}',$,'Wall',$,$,$,$,$,$);"),
        format!("#10=IFCRELAGGREGATES('{OWNER}',$,$,$,#1,(#2));"),
    ]);
    let later = file("IFC4", &[
        "#1=IFCPROJECT('0000000000000000000011',$,'P',$,$,$,$,$,$);".into(),
        format!("#2=IFCBUILDINGELEMENTPROXY('{WALL}',$,'Wall',$,$,$,$,$,$);"),
        format!("#3=IFCBUILDINGELEMENTPROXY('{DOOR}',$,'Door',$,$,$,$,$,$);"),
        format!("#11=/* ( */IFCRELAGGREGATES('{LATER}',$,'keep ''(,)''', $, #1, /* list */ ( /* wall */ #2 /* between */, /* door */ #3 ) /* end */);"),
    ]);
    let (out, stats) = export_merged_with_stats(&[primary.as_bytes(), later.as_bytes()], &MergedOptions::default());
    let entities = decoded(&out);
    let wall = rooted(&entities, WALL).id;
    let door = rooted(&entities, DOOR).id;
    let owner = rooted(&entities, OWNER);
    let later = rooted(&entities, LATER);
    assert_eq!(owner.get_refs(5), Some(vec![wall]));
    assert_eq!(later.get_refs(5), Some(vec![door]));
    assert_eq!(later.get_ref(4), owner.get_ref(4), "canonical project retained");
    assert_eq!(later.get_string(2), Some("keep '(,)'"));
    let rels: Vec<_> = entities.iter().filter(|e| e.ifc_type == IfcType::IfcRelAggregates).collect();
    for child in [wall, door] {
        assert_eq!(rels.iter().filter(|e| e.get_refs(5).unwrap().contains(&child)).count(), 1);
    }
    assert!(stats.warnings.iter().all(|w| !w.contains("lost that relationship")), "{:?}", stats.warnings);
    assert!(out.contains("/* ( */IFCRELAGGREGATES"));
    assert!(out.contains("/* list */ ( /* wall */  /* between */ /* door */"), "{out}");
}

/// Empty-container planning classifies incoming slots before the emit pass
/// prunes a list: both passes must see the same commented frame.
#[test]
fn commented_aggregation_prunes_only_empty_storey_7891() {
    let source = file("IFC4", &[
        "#1=IFCPROJECT('0000000000000000000010',$,'P',$,$,$,$,$,$);".into(),
        "#2=IFCBUILDING('0000000000000000000040',$,'B',$,$,$,$,$,$,$,$,$);".into(),
        "#3=IFCBUILDINGSTOREY('0000000000000000000050',$,'Used',$,$,$,$,$,$,0.);".into(),
        "#4=IFCBUILDINGSTOREY('0000000000000000000060',$,'Empty',$,$,$,$,$,$,3.);".into(),
        format!("#5=IFCBUILDINGELEMENTPROXY('{WALL}',$,'Wall',$,$,$,$,$,$);"),
        "#8=IFCRELAGGREGATES('0000000000000000000070',$,$,$,#1,(#2));".into(),
        format!("#10=/* ( */IFCRELAGGREGATES('{OWNER}',$,$,$,#2, /* before */ (#3, /* empty */ #4) /* after */);"),
        "#11=IFCRELCONTAINEDINSPATIALSTRUCTURE('0000000000000000000080',$,$,$,(#5),#3);".into(),
    ]);
    let opts = MergedOptions { drop_empty_containers: true, ..Default::default() };
    let (out, stats) = export_merged_with_stats(&[source.as_bytes()], &opts);
    assert_eq!(stats.dropped_container_count, 1, "{out}");
    let entities = decoded(&out);
    let used = rooted(&entities, "0000000000000000000050");
    assert!(!entities.iter().any(|e| e.get_string(0) == Some("0000000000000000000060")));
    let owner = rooted(&entities, OWNER);
    assert_eq!(owner.get_refs(5), Some(vec![used.id]));
    assert_eq!(owner.get_ref(4), Some(rooted(&entities, "0000000000000000000040").id));
    assert!(out.contains("/* empty */ "), "list trivia retained: {out}");
    assert!(stats.warnings.iter().all(|w| !w.contains("lost that relationship")), "{:?}", stats.warnings);
}
