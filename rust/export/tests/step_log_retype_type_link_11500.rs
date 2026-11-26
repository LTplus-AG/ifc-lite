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
