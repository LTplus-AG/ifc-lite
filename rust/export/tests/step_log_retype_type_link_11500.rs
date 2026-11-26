// SPDX-License-Identifier: MPL-2.0

use ifc_lite_export::{export_step_with_log, MutationLog, StepOptions};

const SOURCE: &str = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCWALL('3nZ2y9nY9FExK3Wg9nLvXz',$,'Wall A',$,$,$,$,$,.STANDARD.);\n\
#2=IFCWALL('0uK8j9R5T5E8Gf7Ybq5ZpA',$,'Wall B',$,$,$,$,$,.STANDARD.);\n\
#3=IFCWALLTYPE('0YvctVUKr0kugbFTf53O9L',$,'Wall Type',$,$,$,$,$,$,.STANDARD.);\n";

fn export(members: &str, to: &str) -> (String, Vec<String>) {
    let source = format!(
        "{SOURCE}#4=IFCRELDEFINESBYTYPE('2VQ9wAx1j4Bh3OB5NYQuhQ',$,$,$,({members}),#3);\nENDSEC;\nEND-ISO-10303-21;\n"
    );
    let log = MutationLog::from_json(&format!(
        r#"{{"mutations":[{{"type":"UPDATE_ENTITY_TYPE","entityId":1,"entityType":"{to}"}}]}}"#
    )).expect("retype log");
    let (output, stats) = export_step_with_log(source.as_bytes(), &StepOptions::default(), &log).expect("export");
    (output, stats.warnings)
}

#[test]
fn retype_removes_only_the_incompatible_member_11500() {
    let (output, warnings) = export("#1,#2", "IfcSlab");
    assert!(output.contains("#1=IFCSLAB("), "{output}");
    let relationship = output.lines().find(|line| line.starts_with("#4=")).expect("other member remains typed");
    assert!(relationship.ends_with("(#2),#3);"), "{relationship}");
    assert!(warnings.iter().any(|warning| warning.contains("#4")), "{warnings:?}");
}

#[test]
fn retype_withholds_a_relationship_with_no_members_left_11500() {
    let (output, warnings) = export("#1", "IfcSlab");
    assert!(output.contains("#1=IFCSLAB("), "{output}");
    assert!(!output.lines().any(|line| line.starts_with("#4=")), "{output}");
    assert!(warnings.iter().any(|warning| warning.contains("#4")), "{warnings:?}");
}

#[test]
fn retype_keeps_the_assignment_to_a_valid_parent_type_11500() {
    let (output, _) = export("#1", "IfcWallStandardCase");
    assert!(output.contains("#1=IFCWALLSTANDARDCASE("), "{output}");
    let relationship = output.lines().find(|line| line.starts_with("#4=")).expect("valid parent type remains");
    assert!(relationship.ends_with("(#1),#3);"), "{relationship}");
}

#[test]
fn an_existing_mismatch_is_preserved_11500() {
    let (output, warnings) = export("#1,#2", "IfcSlab");
    let retyped_source = SOURCE.replace("#1=IFCWALL(", "#1=IFCSLAB(");
    let source = format!("{retyped_source}#4=IFCRELDEFINESBYTYPE('2VQ9wAx1j4Bh3OB5NYQuhQ',$,$,$,(#1,#2),#3);\nENDSEC;\nEND-ISO-10303-21;\n");
    let log = MutationLog::from_json(r#"{"mutations":[{"type":"UPDATE_ENTITY_TYPE","entityId":1,"entityType":"IfcColumn"}]}"#).unwrap();
    let (existing, stats) = export_step_with_log(source.as_bytes(), &StepOptions::default(), &log).unwrap();
    assert!(existing.contains("#1=IFCCOLUMN("), "{existing}");
    assert!(existing.contains("(#1,#2),#3);"), "{existing}");
    assert!(stats.warnings.iter().all(|warning| !warning.contains("lost its type assignment")), "{:?}", stats.warnings);
    assert!(output.contains("(#2),#3);") && warnings.iter().any(|warning| warning.contains("lost its type assignment")));
}

#[test]
fn a_retyped_ifc2x3_door_leaves_its_door_style_11500() {
    let source = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n\
#1=IFCDOOR('3nZ2y9nY9FExK3Wg9nLvXz',$,'Door',$,$,$,$,$,$,$);\n\
#2=IFCDOORSTYLE('0YvctVUKr0kugbFTf53O9L',$,'Door Style',$,$,$,$,.NOTDEFINED.,.NOTDEFINED.,.F.,.F.);\n\
#4=IFCRELDEFINESBYTYPE('2VQ9wAx1j4Bh3OB5NYQuhQ',$,$,$,(#1),#2);\nENDSEC;\nEND-ISO-10303-21;\n";
    let log = MutationLog::from_json(r#"{"mutations":[{"type":"UPDATE_ENTITY_TYPE","entityId":1,"entityType":"IfcWindow"}]}"#).unwrap();
    let (output, stats) = export_step_with_log(source.as_bytes(), &StepOptions::default(), &log).unwrap();
    assert!(output.contains("#1=IFCWINDOW("), "{output}");
    assert!(output.contains("#2=IFCDOORSTYLE("), "{output}");
    assert!(!output.contains("#4=IFCRELDEFINESBYTYPE("), "{output}");
    assert_eq!(stats.warnings.iter().filter(|warning| warning.contains("#4")).count(), 1, "{:?}", stats.warnings);
}

#[test]
fn an_edited_relationship_is_withheld_and_reports_its_actual_reason_11500() {
    let source = format!("{SOURCE}#4=IFCRELDEFINESBYTYPE('2VQ9wAx1j4Bh3OB5NYQuhQ',$,$,$,(#1,#2),#3);\nENDSEC;\nEND-ISO-10303-21;\n");
    let log = MutationLog::from_json(r##"{"mutations":[
        {"type":"UPDATE_ENTITY_TYPE","entityId":1,"entityType":"IfcSlab"},
        {"type":"UPDATE_POSITIONAL_ATTRIBUTE","entityId":4,"attributeName":"@4","newValue":["#1"]}
    ]}"##).unwrap();
    let (output, stats) = export_step_with_log(source.as_bytes(), &StepOptions::default(), &log).unwrap();
    assert!(!output.contains("#4=IFCRELDEFINESBYTYPE("), "{output}");
    assert_eq!(stats.warnings.len(), 1, "{:?}", stats.warnings);
    assert!(stats.warnings[0].contains("lost its type assignment to #3 for #1"), "{:?}", stats.warnings);
    assert_eq!(stats.modified_entities, 1);
}

#[test]
fn a_created_relationship_keeps_only_compatible_members_11500() {
    let source = format!("{SOURCE}ENDSEC;\nEND-ISO-10303-21;\n");
    let log = MutationLog::from_json(r##"{
        "mutations":[
            {"type":"UPDATE_ENTITY_TYPE","entityId":1,"entityType":"IfcSlab"},
            {"type":"CREATE_ENTITY","entityId":4,"attributeName":"IfcRelDefinesByType"}
        ],
        "newEntities":[{"expressId":4,"type":"IfcRelDefinesByType",
            "attributes":["2VQ9wAx1j4Bh3OB5NYQuhQ",null,null,null,["#1","#2"],"#3"]}]
    }"##).unwrap();
    let (output, stats) = export_step_with_log(source.as_bytes(), &StepOptions::default(), &log).unwrap();
    assert!(output.contains("#4=IFCRELDEFINESBYTYPE(") && output.contains("(#2),#3);"), "{output}");
    assert_eq!(stats.warnings.iter().filter(|warning| warning.contains("#4")).count(), 1, "{:?}", stats.warnings);
    assert_eq!(stats.new_entities, 1);
}

#[test]
fn a_retyped_relating_type_removes_the_previously_valid_assignment_11500() {
    let source = format!("{SOURCE}#4=IFCRELDEFINESBYTYPE('2VQ9wAx1j4Bh3OB5NYQuhQ',$,$,$,(#1,#2),#3);\nENDSEC;\nEND-ISO-10303-21;\n");
    let log = MutationLog::from_json(r#"{"mutations":[{"type":"UPDATE_ENTITY_TYPE","entityId":3,"entityType":"IfcSlabType"}]}"#).unwrap();
    let (output, stats) = export_step_with_log(source.as_bytes(), &StepOptions::default(), &log).unwrap();
    assert!(output.contains("#3=IFCSLABTYPE("), "{output}");
    assert!(!output.contains("#4=IFCRELDEFINESBYTYPE("), "{output}");
    assert!(stats.warnings.iter().any(|warning| warning.contains("#1, #2")), "{:?}", stats.warnings);
}

#[test]
fn wall_and_door_retypes_detach_old_types_in_the_authored_fixture_11500() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/models/various/issue-604-door.ifc");
    let source = match std::fs::read(path) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("skipped: run pnpm fixtures to fetch various/issue-604-door.ifc");
            return;
        }
        Err(error) => panic!("could not read authored fixture: {error}"),
    };
    let log = MutationLog::from_json(r#"{"mutations":[
        {"type":"UPDATE_ENTITY_TYPE","entityId":55,"entityType":"IfcSlab"},
        {"type":"UPDATE_ENTITY_TYPE","entityId":2390,"entityType":"IfcWindow"}
    ]}"#).unwrap();
    let (output, stats) = export_step_with_log(&source, &StepOptions::default(), &log).unwrap();
    assert!(output.contains("#55=IFCSLAB("));
    assert!(output.contains("#2390=IFCWINDOW("));
    assert!(!output.contains("#2424=IFCRELDEFINESBYTYPE("));
    assert!(!output.contains("#2425=IFCRELDEFINESBYTYPE("));
    assert!(output.contains("#73=IFCWALLTYPE("));
    assert!(output.contains("#2333=IFCDOORTYPE("));
    for id in [2424, 2425] {
        let relationship = format!("Relationship #{id} (IFCRELDEFINESBYTYPE)");
        assert!(stats.warnings.iter().any(|warning| warning.contains(&relationship)), "{:?}", stats.warnings);
    }
}
