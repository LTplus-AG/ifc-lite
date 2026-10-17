// SPDX-License-Identifier: MPL-2.0
use super::*;

fn flatten(records: &[&str]) -> StyleFlatten {
    let content = format!("DATA;\n{}\nENDSEC;\n", records.join("\n"));
    StyleFlatten::build(content.as_bytes(), "IFC4", "IFC4X3").expect("holds an assignment")
}

#[test]
fn only_a_2x3_or_4_to_4x3_conversion_flattens() {
    for (from, to, expect) in [
        ("IFC2X3", "IFC4X3", true),
        ("IFC4", "IFC4X3", true),
        ("IFC4X3", "IFC4", false),
        ("IFC4", "IFC2X3", false),
        ("IFC2X3", "IFC4", false),
        ("IFC5", "IFC4X3", false),
    ] {
        assert_eq!(StyleFlatten::applies(from, to), expect, "{from} -> {to}");
    }
    assert!(StyleFlatten::build(b"DATA;\n#1=IFCWALL($);\nENDSEC;", "IFC4", "IFC4X3").is_none());
}

#[test]
fn an_assignment_after_its_styled_item_is_still_flattened() {
    let f = flatten(&["#1=IFCSTYLEDITEM(#9,(#2),$);", "#2=IFCPRESENTATIONSTYLEASSIGNMENT((#3,#4));"]);
    assert!(f.drops(2) && !f.drops(1));
    assert_eq!(f.rewrite("IFC4", "#1=IFCSTYLEDITEM(#9,(#2),$);").as_deref(), Some("#1=IFCSTYLEDITEM(#9,(#3,#4),$);"));
}

#[test]
fn a_non_styled_record_is_left_alone() {
    let f = flatten(&["#2=IFCPRESENTATIONSTYLEASSIGNMENT((#3));"]);
    assert_eq!(f.rewrite("IFC4", "#7=IFCWALL('g',#2,$,$,$,$,$,$,$);"), None);
    assert_eq!(f.rewrite("IFC4", "#7=IFCSTYLEDITEM(#9,(#5),$);"), None);
}
